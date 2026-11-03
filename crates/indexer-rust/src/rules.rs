//! Node-level rules: definition matching, name resolution, callee naming, imports,
//! CommonJS export detection, and heritage extraction.
//!
//! Every function here is a line-for-line port of the same-named function in
//! `packages/tree-sitter/src/extract.ts`; the doc comments name the JS counterpart so a
//! later behaviour change has one obvious place to be mirrored in.

use std::collections::HashSet;

use tree_sitter::Node;

use crate::extract::{RawHeritageRef, RawImport};
use crate::languages::DefinitionRule;

/// Sentinel `DefinitionRule.nameField` values — see `languages.ts`.
pub const SELF_NAME_FIELD: &str = "@self";
pub const DECLARATOR_NAME_FIELD: &str = "@declarator";
pub const FIRST_CHILD_NAME_FIELD: &str = "@first-child";

/// C/C++ node types wrapping another `declarator` field one level further down.
const DECLARATOR_WRAPPER_TYPES: [&str; 4] = [
    "pointer_declarator",
    "init_declarator",
    "array_declarator",
    "reference_declarator",
];

/// The source text a tree was parsed from, plus the line index needed to turn
/// tree-sitter's byte columns into the UTF-16 code-unit columns the JS side reports.
///
/// This conversion is load-bearing, not cosmetic: a definition's `key` is
/// `row:column`, and downstream resolution joins on it, so a byte column and a
/// UTF-16 column disagree for every line holding a non-ASCII character (verified
/// against the JS side: `const 变量 = foo(1)` reports the call at column 11, the
/// UTF-16 offset, not byte 15).
pub struct SourceText<'a> {
    text: &'a str,
    bytes: &'a [u8],
    line_starts: Vec<usize>,
}

impl<'a> SourceText<'a> {
    pub fn new(text: &'a str) -> Self {
        let mut line_starts = vec![0usize];
        for (index, byte) in text.bytes().enumerate() {
            if byte == b'\n' {
                line_starts.push(index + 1);
            }
        }
        Self {
            text,
            bytes: text.as_bytes(),
            line_starts,
        }
    }

    /// A node's text, exactly as `node.text` reports it (the raw source slice).
    pub fn node_text(&self, node: &Node) -> &'a str {
        node.utf8_text(self.bytes).unwrap_or("")
    }

    /// One line's text, without its trailing newline.
    fn line(&self, row: usize) -> &'a str {
        let Some(&start) = self.line_starts.get(row) else {
            return "";
        };
        let end = self
            .line_starts
            .get(row + 1)
            .copied()
            .map(|next| next.saturating_sub(1))
            .unwrap_or(self.text.len());
        self.text.get(start..end).unwrap_or("")
    }

    /// The UTF-16 code-unit column of a tree-sitter byte column on `row` — the
    /// coordinate space web-tree-sitter's `Point.column` uses.
    pub fn utf16_column(&self, row: usize, byte_column: usize) -> usize {
        let line = self.line(row);
        let slice = match line.get(..byte_column.min(line.len())) {
            Some(slice) => slice,
            // Not on a character boundary: cannot happen for a node boundary, but a
            // byte column is still a truthful fallback rather than a panic.
            None => return byte_column,
        };
        if slice.is_ascii() {
            return byte_column;
        }
        slice.chars().map(char::len_utf16).sum()
    }
}

/// `namedChildren` in `extract.ts`: the node's named children, in order.
pub fn named_children<'t>(node: &Node<'t>) -> Vec<Node<'t>> {
    let mut children = Vec::with_capacity(node.named_child_count());
    for index in 0..node.named_child_count() {
        if let Some(child) = node.named_child(index as u32) {
            children.push(child);
        }
    }
    children
}

/// Every descendant of `node` matching `types`, depth-first pre-order.
///
/// Ported for parity with `descendantsOfType` in `extract.ts`; none of the four
/// supported specs reaches it (`goImports`/`scalaImports` are its only callers), so it
/// is exercised by a unit test instead of by extraction.
#[allow(dead_code)]
pub fn descendants_of_type<'t>(node: &Node<'t>, types: &[&str]) -> Vec<Node<'t>> {
    fn walk<'t>(node: &Node<'t>, types: &[&str], out: &mut Vec<Node<'t>>) {
        for index in 0..node.named_child_count() {
            if let Some(child) = node.named_child(index as u32) {
                if types.contains(&child.kind()) {
                    out.push(child);
                }
                walk(&child, types, out);
            }
        }
    }
    let mut out = Vec::new();
    walk(node, types, &mut out);
    out
}

/// `fieldText`: a field's text, or `fallback` when the field is absent.
///
/// Kept for parity: its only JS callers are `pythonBinding`/`goImports`/`javaImports`,
/// so none of the four supported specs reaches it.
#[allow(dead_code)]
pub fn field_text(source: &SourceText, node: &Node, field: &str, fallback: &str) -> String {
    node.child_by_field_name(field)
        .map(|value| source.node_text(&value).to_string())
        .unwrap_or_else(|| fallback.to_string())
}

/// `hasKeywordChild`: whether a node carries `keyword` as one of its own non-named children.
pub fn has_keyword_child(source: &SourceText, node: &Node, keyword: &str) -> bool {
    for index in 0..node.child_count() {
        if let Some(child) = node.child(index) {
            if !child.is_named() && source.node_text(&child) == keyword {
                return true;
            }
        }
    }
    false
}

/// `soleNamedField`: the lone named child bound to `field`.
pub fn sole_named_field<'t>(node: &Node<'t>, field: &str) -> Option<Node<'t>> {
    let mut found: Option<Node<'t>> = None;
    let mut count = 0usize;
    for index in 0..node.child_count() {
        if node.field_name_for_child(index) != Some(field) {
            continue;
        }
        if let Some(child) = node.child(index) {
            if child.is_named() {
                count += 1;
                if count > 1 {
                    return None;
                }
                found = Some(child);
            }
        }
    }
    found
}

/// `parenthesizedDeclaratorInner` — a `parenthesized_declarator`'s sole positional child.
fn parenthesized_declarator_inner<'t>(node: &Node<'t>) -> Option<Node<'t>> {
    named_children(node).into_iter().next()
}

/// `declaratorName` — the terminal name behind a C/C++ `declarator` chain.
pub fn declarator_name<'t>(node: &Node<'t>) -> Option<Node<'t>> {
    sole_named_field(node, "declarator")?;
    let mut current = node.child_by_field_name("declarator");
    while let Some(inner) = current {
        let kind = inner.kind();
        if kind == "identifier" || kind == "field_identifier" || kind == "destructor_name" {
            return Some(inner);
        }
        if kind == "parenthesized_declarator" {
            current = parenthesized_declarator_inner(&inner);
            continue;
        }
        if kind != "function_declarator" && !DECLARATOR_WRAPPER_TYPES.contains(&kind) {
            return None;
        }
        current = inner.child_by_field_name("declarator");
    }
    None
}

/// `firstChildName` — a matched node's first named child, when it is an `identifier`.
pub fn first_child_name<'t>(node: &Node<'t>) -> Option<Node<'t>> {
    let first = named_children(node).into_iter().next()?;
    (first.kind() == "identifier").then_some(first)
}

/// `matchDefinition`: the first rule matching `node`, in table order.
pub fn match_definition<'t>(
    node: &Node<'t>,
    definitions: &[DefinitionRule],
) -> Option<usize> {
    for (index, rule) in definitions.iter().enumerate() {
        if node.kind() != rule.node_type {
            continue;
        }
        if let Some(parent_type) = &rule.parent_type {
            if node.parent().map(|parent| parent.kind()) != Some(parent_type.as_str()) {
                continue;
            }
        }
        if let Some(grandparent_type) = &rule.grandparent_type {
            let actual = node.parent().and_then(|parent| parent.parent());
            if actual.map(|actual| actual.kind()) != Some(grandparent_type.as_str()) {
                continue;
            }
        }
        if let Some(value) = &rule.value {
            match node.child_by_field_name(&value.field) {
                Some(field_value) if value.types.iter().any(|kind| kind == field_value.kind()) => {}
                _ => continue,
            }
        }
        let Some(name_node) = name_node_for_rule(node, rule) else {
            continue;
        };
        if let Some(types) = &rule.name_node_types {
            if !types.iter().any(|kind| kind == name_node.kind()) {
                continue;
            }
        }
        return Some(index);
    }
    None
}

/// The name node a rule resolves to, using `matchDefinition`'s own semantics.
fn name_node_for_rule<'t>(node: &Node<'t>, rule: &DefinitionRule) -> Option<Node<'t>> {
    match rule.name_field.as_str() {
        SELF_NAME_FIELD => Some(*node),
        DECLARATOR_NAME_FIELD => declarator_name(node),
        FIRST_CHILD_NAME_FIELD => first_child_name(node),
        // No other sentinel can appear in the four supported specs; an unknown one is
        // an explicit no-match rather than a silent guess.
        field if field.starts_with('@') => None,
        field => sole_named_field(node, field),
    }
}

/// The name node the walk records for an already-matched rule.
///
/// `extractFile` re-resolves the name with `childForFieldName` rather than reusing
/// `matchDefinition`'s result; that is observationally identical for `soleNamedField`
/// rules (the field binds exactly one named child, so both find it).
pub fn visit_name_node<'t>(node: &Node<'t>, rule: &DefinitionRule) -> Option<Node<'t>> {
    match rule.name_field.as_str() {
        SELF_NAME_FIELD => Some(*node),
        DECLARATOR_NAME_FIELD => declarator_name(node),
        FIRST_CHILD_NAME_FIELD => first_child_name(node),
        field if field.starts_with('@') => None,
        field => node.child_by_field_name(field),
    }
}

/// `calleeName`: the simple name a call's callee expression resolves to.
pub fn callee_name(source: &SourceText, callee: &Node) -> Option<String> {
    let kind = callee.kind();
    if kind == "generic_function" {
        let inner = callee.child_by_field_name("function")?;
        return callee_name(source, &inner);
    }
    if kind == "identifier" || kind == "simple_identifier" || kind == "name" {
        return Some(source.node_text(callee).to_string());
    }
    if kind == "qualified_name" {
        let last = named_children(callee).into_iter().last()?;
        return (last.kind() == "name").then(|| source.node_text(&last).to_string());
    }
    let property = callee
        .child_by_field_name("property")
        .or_else(|| callee.child_by_field_name("field"))
        .or_else(|| callee.child_by_field_name("member"))
        .or_else(|| callee.child_by_field_name("attribute"))
        .or_else(|| callee.child_by_field_name("name"))?;
    if property.kind() == "computed_property_name" {
        return None;
    }
    Some(source.node_text(&property).to_string())
}

/// `isHeritageName`: whether a node is a bare name heritage can resolve against.
pub fn is_heritage_name(node: &Node) -> bool {
    matches!(
        node.kind(),
        "identifier" | "type_identifier" | "name" | "constant"
    )
}

/// `ecmascriptClassHeritage`: `extends`/`implements` refs from a class declaration.
pub fn ecmascript_class_heritage(
    source: &SourceText,
    node: &Node,
    source_key: &str,
) -> Vec<RawHeritageRef> {
    let Some(heritage) = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "class_heritage")
    else {
        return Vec::new();
    };
    let mut refs = Vec::new();
    for child in named_children(&heritage) {
        match child.kind() {
            "extends_clause" => {
                if let Some(target) = named_children(&child).into_iter().next() {
                    if is_heritage_name(&target) {
                        refs.push(RawHeritageRef {
                            source_key: source_key.to_string(),
                            target_name: source.node_text(&target).to_string(),
                            relation: "extends".to_string(),
                        });
                    }
                }
            }
            "implements_clause" => {
                for implemented in named_children(&child) {
                    if is_heritage_name(&implemented) {
                        refs.push(RawHeritageRef {
                            source_key: source_key.to_string(),
                            target_name: source.node_text(&implemented).to_string(),
                            relation: "implements".to_string(),
                        });
                    }
                }
            }
            // Plain JavaScript: the child is the extended expression itself.
            _ => {
                if is_heritage_name(&child) {
                    refs.push(RawHeritageRef {
                        source_key: source_key.to_string(),
                        target_name: source.node_text(&child).to_string(),
                        relation: "extends".to_string(),
                    });
                }
            }
        }
    }
    refs
}

/// `tsInterfaceHeritage`: an interface's `extends` targets.
pub fn ts_interface_heritage(
    source: &SourceText,
    node: &Node,
    source_key: &str,
) -> Vec<RawHeritageRef> {
    let Some(clause) = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "extends_type_clause")
    else {
        return Vec::new();
    };
    named_children(&clause)
        .into_iter()
        .filter(is_heritage_name)
        .map(|target| RawHeritageRef {
            source_key: source_key.to_string(),
            target_name: source.node_text(&target).to_string(),
            relation: "extends".to_string(),
        })
        .collect()
}

/// `ecmascriptImports`: one `import_statement`'s bindings.
pub fn ecmascript_imports(source: &SourceText, node: &Node) -> Vec<RawImport> {
    let Some(import_source) = node.child_by_field_name("source") else {
        return Vec::new();
    };
    let specifier = match named_children(&import_source).into_iter().next() {
        Some(fragment) => source.node_text(&fragment).to_string(),
        None => {
            let text = source.node_text(&import_source);
            text.get(1..text.len().saturating_sub(1)).unwrap_or("").to_string()
        }
    };
    let Some(clause) = named_children(node)
        .into_iter()
        .find(|child| child.kind() == "import_clause")
    else {
        return Vec::new();
    };
    let mut imports = Vec::new();
    for child in named_children(&clause) {
        match child.kind() {
            "identifier" => imports.push(RawImport {
                local_name: source.node_text(&child).to_string(),
                imported_name: "default".to_string(),
                specifier: specifier.clone(),
            }),
            "namespace_import" => {
                let Some(local) = named_children(&child).into_iter().next() else {
                    continue;
                };
                imports.push(RawImport {
                    local_name: source.node_text(&local).to_string(),
                    imported_name: "*".to_string(),
                    specifier: specifier.clone(),
                });
            }
            "named_imports" => {
                for specifier_node in named_children(&child) {
                    if specifier_node.kind() != "import_specifier" {
                        continue;
                    }
                    let Some(name) = specifier_node.child_by_field_name("name") else {
                        continue;
                    };
                    let alias = specifier_node.child_by_field_name("alias");
                    imports.push(RawImport {
                        local_name: alias
                            .as_ref()
                            .map(|alias| source.node_text(alias).to_string())
                            .unwrap_or_else(|| source.node_text(&name).to_string()),
                        imported_name: source.node_text(&name).to_string(),
                        specifier: specifier.clone(),
                    });
                }
            }
            _ => {}
        }
    }
    imports
}

/// `commonJsRequireImport`: a bare `require('./foo')` recognized as an import binding.
pub fn common_js_require_import(source: &SourceText, node: &Node) -> Option<RawImport> {
    let callee = node.child_by_field_name("function")?;
    if callee.kind() != "identifier" || source.node_text(&callee) != "require" {
        return None;
    }
    let arguments = node.child_by_field_name("arguments")?;
    let args = named_children(&arguments);
    let specifier_node = (args.len() == 1).then(|| args[0])?;
    if specifier_node.kind() != "string" {
        return None;
    }
    let specifier = match named_children(&specifier_node).into_iter().next() {
        Some(fragment) => source.node_text(&fragment).to_string(),
        None => {
            let text = source.node_text(&specifier_node);
            text.get(1..text.len().saturating_sub(1)).unwrap_or("").to_string()
        }
    };
    match node.parent().map(|parent| parent.kind()) {
        Some("variable_declarator") => {
            let parent = node.parent()?;
            let name = parent.child_by_field_name("name")?;
            if name.kind() != "identifier" {
                return None;
            }
            Some(RawImport {
                local_name: source.node_text(&name).to_string(),
                imported_name: "*".to_string(),
                specifier,
            })
        }
        Some("expression_statement") => Some(RawImport {
            local_name: String::new(),
            imported_name: "*".to_string(),
            specifier,
        }),
        _ => None,
    }
}

/// `isModuleExportsExpression`: the two-level `module.exports` member expression itself.
fn is_module_exports_expression(source: &SourceText, node: &Node) -> bool {
    if node.kind() != "member_expression" {
        return false;
    }
    let object = node.child_by_field_name("object");
    let property = node.child_by_field_name("property");
    let object_is_module = object
        .as_ref()
        .map(|object| object.kind() == "identifier" && source.node_text(object) == "module")
        .unwrap_or(false);
    object_is_module && property.map(|property| source.node_text(&property) == "exports").unwrap_or(false)
}

/// `commonJsExportedNames`: every name a top-level CommonJS export assignment marks exported.
pub fn common_js_exported_names(source: &SourceText, root: &Node) -> HashSet<String> {
    let mut names = HashSet::new();
    for statement in named_children(root) {
        if statement.kind() != "expression_statement" {
            continue;
        }
        let Some(expression) = named_children(&statement).into_iter().next() else {
            continue;
        };
        if expression.kind() != "assignment_expression" {
            continue;
        }
        let Some(left) = expression.child_by_field_name("left") else {
            continue;
        };
        if left.kind() != "member_expression" {
            continue;
        }
        let object = left.child_by_field_name("object");
        let property = left.child_by_field_name("property");
        let object_is_exports = object
            .map(|object| {
                object.kind() == "identifier" && source.node_text(&object) == "exports"
            })
            .unwrap_or(false);
        let object_is_module_exports = object
            .map(|object| is_module_exports_expression(source, &object))
            .unwrap_or(false);
        if object_is_module_exports || object_is_exports {
            if let Some(property) = property {
                names.insert(source.node_text(&property).to_string());
            }
            continue;
        }
        if is_module_exports_expression(source, &left) {
            if let Some(right) = expression.child_by_field_name("right") {
                if right.kind() == "identifier" {
                    names.insert(source.node_text(&right).to_string());
                }
            }
        }
    }
    names
}

/// `isExported` for the ECMAScript-family grammars.
///
/// The JS version's language-specific branches above this fallback all check for
/// languages this crate never handles (`go`/`java`/`csharp`/`c`/`cpp`/`python`/…), so
/// the fallback is the whole rule here: a CommonJS export assignment, or an enclosing
/// `export_statement` before the search is cut off by a statement or class body.
pub fn is_exported(
    source: &SourceText,
    node: &Node,
    language: &str,
    name: &str,
    common_js_exports: &HashSet<String>,
) -> bool {
    if !crate::languages::is_supported(language) {
        return false;
    }
    let _ = source;
    if common_js_exports.contains(name) {
        return true;
    }
    let mut current = node.parent();
    while let Some(parent) = current {
        match parent.kind() {
            "export_statement" => return true,
            "statement_block" | "class_body" => return false,
            _ => {}
        }
        current = parent.parent();
    }
    false
}
