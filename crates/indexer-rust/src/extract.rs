//! One-file extraction: walk a parsed tree exactly once, collecting the definitions,
//! call sites, import bindings, and heritage references the resolver needs.
//!
//! A line-for-line port of `extractFile` in `packages/tree-sitter/src/extract.ts`. The
//! JSON field names and order below are the wire contract: they are what the JS side
//! `toStrictEqual`s against, so `RawDefinition`/`RawCall`/`RawImport`/`RawHeritageRef`
//! keep the exact declaration order of their TypeScript counterparts.

use std::collections::HashSet;

use serde::Serialize;
use tree_sitter::{Node, Tree};

use crate::languages::{is_supported, LanguageSpec};
use crate::rules::{self, SourceText};

/// One declaration this file introduces, before cross-file resolution.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawDefinition {
    /// Stable position-derived key, unique within the file.
    pub key: String,
    /// The immediately enclosing definition's `key`, or `null` at module top level.
    pub parent_key: Option<String>,
    pub kind: String,
    pub name: String,
    /// Enclosing definition names, outermost first.
    pub container: Vec<String>,
    pub start_line: usize,
    pub end_line: usize,
    pub start_column: usize,
    pub end_column: usize,
    pub is_exported: bool,
    pub is_async: bool,
    pub is_static: bool,
    pub decorators: Vec<String>,
}

/// One call site this file contains, before callee resolution.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawCall {
    pub caller_key: Option<String>,
    pub callee_name: String,
    pub line: usize,
    pub column: usize,
    pub is_member_call: bool,
}

/// One import binding this file introduces.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawImport {
    pub local_name: String,
    pub imported_name: String,
    pub specifier: String,
}

/// One `extends`/`implements` reference a captured class or interface declares.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct RawHeritageRef {
    pub source_key: String,
    pub target_name: String,
    pub relation: String,
}

/// Everything one file's walk produced.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct FileExtraction {
    pub definitions: Vec<RawDefinition>,
    pub calls: Vec<RawCall>,
    pub imports: Vec<RawImport>,
    pub heritage: Vec<RawHeritageRef>,
}

impl FileExtraction {
    pub fn empty() -> Self {
        Self {
            definitions: Vec::new(),
            calls: Vec::new(),
            imports: Vec::new(),
            heritage: Vec::new(),
        }
    }
}

/// The scope a definition sits in, tracked so a `scopeRestricted` rule can be skipped
/// once the walk has descended into a function or method body.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ScopeKind {
    Module,
    Class,
    Other,
}

struct Walker<'a> {
    source: &'a SourceText<'a>,
    definitions: Vec<RawDefinition>,
    calls: Vec<RawCall>,
    imports: Vec<RawImport>,
    heritage: Vec<RawHeritageRef>,
    container_names: Vec<String>,
    container_keys: Vec<Option<String>>,
    scope_kinds: Vec<ScopeKind>,
    common_js_exports: HashSet<String>,
}

impl<'a> Walker<'a> {
    fn new(source: &'a SourceText<'a>, common_js_exports: HashSet<String>) -> Self {
        Self {
            source,
            definitions: Vec::new(),
            calls: Vec::new(),
            imports: Vec::new(),
            heritage: Vec::new(),
            container_names: Vec::new(),
            container_keys: vec![None],
            scope_kinds: vec![ScopeKind::Module],
            common_js_exports,
        }
    }

    fn finish(self) -> FileExtraction {
        FileExtraction {
            definitions: self.definitions,
            calls: self.calls,
            imports: self.imports,
            heritage: self.heritage,
        }
    }

    fn visit(&mut self, node: &Node, spec: &LanguageSpec) {
        let matched = rules::match_definition(node, &spec.definitions);
        // A `scopeRestricted` rule matched inside a function/method body is treated as
        // no match at all — the node still gets visited below, just without becoming a
        // definition or a container.
        let captured = matched.filter(|index| {
            let rule = &spec.definitions[*index];
            rule.scope_restricted != Some(true)
                || self.scope_kinds.last() != Some(&ScopeKind::Other)
        });
        if let Some(index) = captured {
            let rule = &spec.definitions[index];
            if let Some(name_node) = rules::visit_name_node(node, rule) {
                self.capture(node, spec, rule, &name_node);
                return;
            }
        }

        if spec.call_types.iter().any(|kind| kind == node.kind()) {
            let field = spec
                .call_function_field_by_type
                .as_ref()
                .and_then(|by_type| by_type.get(node.kind()))
                .map(String::as_str)
                .unwrap_or(&spec.call_function_field);
            if let Some(callee) = node.child_by_field_name(field) {
                if let Some(name) = rules::callee_name(self.source, &callee) {
                    let callee_kind = callee.kind();
                    let is_bare_callee = callee_kind == "identifier" || callee_kind == "name";
                    // The `object`/`scope`/`receiver` checks cover call node shapes whose
                    // receiver sits in a sibling field rather than wrapping the callee.
                    let is_member_call = !is_bare_callee
                        || node.child_by_field_name("object").is_some()
                        || node.child_by_field_name("scope").is_some()
                        || node.child_by_field_name("receiver").is_some();
                    let start = node.start_position();
                    self.calls.push(RawCall {
                        caller_key: self.container_keys.last().cloned().flatten(),
                        callee_name: name,
                        line: start.row + 1,
                        column: self.source.utf16_column(start.row, start.column),
                        is_member_call,
                    });
                }
            }
        }

        if spec.import_types.iter().any(|kind| kind == node.kind()) {
            let imports = rules::ecmascript_imports(self.source, node);
            self.imports.extend(imports);
        }

        if node.kind() == "call_expression" && is_supported(&spec.language) {
            if let Some(require_import) = rules::common_js_require_import(self.source, node) {
                self.imports.push(require_import);
            }
        }

        // A callback or IIFE's function value is never itself captured as a definition,
        // but a `const`/`var` in its body is still function-local, so its scope must flip
        // to `Other` here regardless.
        let enters_bare_function_scope =
            spec.bare_function_scope_types.iter().any(|kind| kind == node.kind());
        if enters_bare_function_scope {
            self.scope_kinds.push(ScopeKind::Other);
        }
        for child in rules::named_children(node) {
            self.visit(&child, spec);
        }
        if enters_bare_function_scope {
            self.scope_kinds.pop();
        }
    }

    /// Record one captured definition, its heritage, and then recurse into its children
    /// with the definition pushed onto the container/scope stacks.
    fn capture(
        &mut self,
        node: &Node,
        spec: &LanguageSpec,
        rule: &crate::languages::DefinitionRule,
        name_node: &Node,
    ) {
        let start = node.start_position();
        let end = node.end_position();
        let key = format!(
            "{}:{}",
            start.row,
            self.source.utf16_column(start.row, start.column)
        );
        let parent_key = self.container_keys.last().cloned().flatten();
        let name = self.source.node_text(name_node).to_string();
        let kind = rule.kind.clone();

        self.definitions.push(RawDefinition {
            key: key.clone(),
            parent_key,
            kind: kind.clone(),
            name: name.clone(),
            container: self.container_names.clone(),
            start_line: start.row + 1,
            end_line: end.row + 1,
            start_column: self.source.utf16_column(start.row, start.column),
            end_column: self.source.utf16_column(end.row, end.column),
            is_exported: rules::is_exported(
                self.source,
                node,
                &spec.language,
                &name,
                &self.common_js_exports,
            ),
            is_async: rules::has_keyword_child(self.source, node, "async"),
            is_static: rules::has_keyword_child(self.source, node, "static"),
            decorators: Vec::new(),
        });

        // Only `class`/`interface` are produced by the four supported specs' class-shaped
        // rules; every other kind (enum/struct/trait/…) reports no heritage for them.
        let heritage = match kind.as_str() {
            "class" => rules::ecmascript_class_heritage(self.source, node, &key),
            "interface" => rules::ts_interface_heritage(self.source, node, &key),
            _ => Vec::new(),
        };
        self.heritage.extend(heritage);

        self.container_names.push(name);
        self.container_keys.push(Some(key));
        self.scope_kinds.push(match kind.as_str() {
            "class" | "struct" => ScopeKind::Class,
            "namespace" => ScopeKind::Module,
            _ => ScopeKind::Other,
        });
        for child in rules::named_children(node) {
            self.visit(&child, spec);
        }
        self.scope_kinds.pop();
        self.container_keys.pop();
        self.container_names.pop();
    }
}

/// Extract every definition, call, import, and heritage ref from one parsed file.
pub fn extract_file(tree: &Tree, text: &str, spec: &LanguageSpec) -> FileExtraction {
    let source = SourceText::new(text);
    let root = tree.root_node();
    let common_js_exports = if is_supported(&spec.language) {
        rules::common_js_exported_names(&source, &root)
    } else {
        HashSet::new()
    };
    let mut walker = Walker::new(&source, common_js_exports);
    walker.visit(&root, spec);
    walker.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn utf16_columns_match_web_tree_sitter() {
        let source = SourceText::new("const 变量 = foo(1)\nconst 😀 = bar(2)\n");
        // `foo(` sits at byte 15 and `bar(` at byte 13; the JS side reports the UTF-16
        // offsets instead, 11 for both.
        assert_eq!(source.utf16_column(0, 15), 11);
        assert_eq!(source.utf16_column(1, 13), 11);
        // Pure ASCII stays byte-identical.
        let ascii = SourceText::new("const a = foo(1)\n");
        assert_eq!(ascii.utf16_column(0, 12), 12);
    }

    #[test]
    fn descendants_of_type_is_depth_first_preorder() {
        let mut parser = tree_sitter::Parser::new();
        let language: tree_sitter::Language = tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into();
        parser.set_language(&language).expect("typescript grammar");
        let tree = parser
            .parse("const a = { b: 1 }\n", None)
            .expect("tree for source");
        let found = rules::descendants_of_type(&tree.root_node(), &["object", "pair"]);
        let kinds: Vec<&str> = found.iter().map(|node| node.kind()).collect();
        assert_eq!(kinds, vec!["object", "pair"]);
    }
}
