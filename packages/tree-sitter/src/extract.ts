/**
 * One-file extraction: walk a parsed tree exactly once, collecting the definitions, call sites, and
 * import bindings the two-pass resolver in `resolve.ts` needs.
 *
 * The caller of a call node is the nearest enclosing definition, or the file itself when the call sits
 * at module top level — the on-disk format records it that way, and a third of the call edges in a
 * real workspace are of exactly this shape.
 * @module dsh-plugin-codegraph-tree-sitter/extract
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'
import { DECLARATOR_NAME_FIELD, FIRST_CHILD_NAME_FIELD, PHP_ELEMENT_NAME_FIELD, SELF_NAME_FIELD } from './languages.ts'
import type { DefinitionRule, LanguageSpec } from './languages.ts'

/** The scope a definition sits in, tracked so a `scopeRestricted` rule (see `DefinitionRule`) can be
 * skipped once the walk has descended into a function or method body. */
type ScopeKind = 'module' | 'class' | 'other'

/** One declaration this file introduces, before cross-file resolution. */
export interface RawDefinition {
  /** Stable position-derived key, unique within the file. */
  readonly key: string
  /** The immediately enclosing definition's {@link key}, or `null` for a module-top-level definition. */
  readonly parentKey: string | null
  readonly kind: string
  readonly name: string
  /** Enclosing definition names, outermost first; used to build `qualifiedName`. */
  readonly container: readonly string[]
  readonly startLine: number
  readonly endLine: number
  readonly startColumn: number
  readonly endColumn: number
  readonly isExported: boolean
  readonly isAsync: boolean
  readonly isStatic: boolean
  /**
   * Decorator names applied to this declaration — recorded as descriptive metadata only, never
   * resolved to an edge (a decorator can be an arbitrary call, e.g. `@app.route('/x')`, with no
   * reliable single "target" the way an import or a base class has one). Empty for every language but
   * Python today.
   */
  readonly decorators: readonly string[]
}

/** One call site this file contains, before callee resolution. */
export interface RawCall {
  /** The calling definition's {@link RawDefinition.key}, or `null` for a module-top-level call. */
  readonly callerKey: string | null
  /** The callee's simple name, e.g. `parse` from `parse(x)` or `obj.parse(x)`. */
  readonly calleeName: string
  readonly line: number
  readonly column: number
  /**
   * Whether the callee expression is a member access (`obj.parse()`) rather than a bare identifier
   * (`parse()`). With no type information, a member call's receiver could be anything, so a name
   * match against it is far less trustworthy than a bare identifier's — `resolve.ts` uses this to
   * separate that noise from a genuine gap in the graph when a call goes unresolved.
   */
  readonly isMemberCall: boolean
}

/** One import binding this file introduces. */
export interface RawImport {
  /** The name this file's scope binds, after any `as` rename. */
  readonly localName: string
  /** The name as declared in the source module, `'default'` for a default import, or `'*'` for a
   * namespace or whole-package import — the latter two never drive resolution but are recorded for
   * completeness. */
  readonly importedName: string
  /** The raw module specifier text, e.g. `./bar` or `fmt`. */
  readonly specifier: string
}

/** One `extends`/`implements` reference a captured class or interface declares, before resolution. */
export interface RawHeritageRef {
  /** The declaring class or interface's own {@link RawDefinition.key}. */
  readonly sourceKey: string
  /** The base/interface's simple name — a member expression or call (a mixin, `class X extends f(Y)`)
   * is not a name this package attempts to resolve, matching its existing "don't guess" precedent. */
  readonly targetName: string
  readonly relation: 'extends' | 'implements'
}

/** Everything one file's walk produced. */
export interface FileExtraction {
  readonly definitions: RawDefinition[]
  readonly calls: RawCall[]
  readonly imports: RawImport[]
  readonly heritage: RawHeritageRef[]
}

/** A node's named children, with the `null` slots `web-tree-sitter` reserves for missing nodes dropped. */
function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter(child => child !== null)
}

/** Every descendant of `node` matching `types`, with `null` slots dropped. */
function descendantsOfType(node: SyntaxNode, types: readonly string[]): SyntaxNode[] {
  return node.descendantsOfType([...types]).filter(child => child !== null)
}

/**
 * A field's text, or `fallback` when the field is absent. `childForFieldName` is typed to return
 * `Node | null` for any field name on any node, but a specific field is absent only when the caller
 * asks for one the matched node type does not carry.
 * @param node - the node to read a field from.
 * @param field - the field name.
 * @param fallback - the text to use when the field is absent.
 * @returns the field's text, or `fallback`.
 */
function fieldText(node: SyntaxNode, field: string, fallback: string): string {
  return node.childForFieldName(field)?.text ?? fallback
}

/** Whether a node carries a modifier keyword as one of its own (non-named) children. */
function hasKeywordChild(node: SyntaxNode, keyword: string): boolean {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child !== null && !child.isNamed && child.text === keyword) return true
  }
  return false
}

/**
 * Java's `modifiers` node for a declaration, wherever it sits. Unlike every other grammar this
 * package extracts from, Java never places a modifier keyword (`public`, `static`, `final`, …) as a
 * direct child of the declaration node itself — it wraps them all in one named `modifiers` child. A
 * captured `variable_declarator` (the `field`/`variable` rules in `languages.ts`) carries no
 * `modifiers` of its own at all; its modifiers sit one level up, on the enclosing
 * `field_declaration`/`local_variable_declaration` this function falls back to. Verified against a
 * real parse, not guessed.
 */
function javaModifiersNode(node: SyntaxNode): SyntaxNode | undefined {
  const own = namedChildren(node).find(child => child.type === 'modifiers')
  if (own !== undefined) return own
  // Every node this is called on is a definition the walk captured below the tree's root, so it
  // always has a parent; the null case only satisfies `.parent`'s general `SyntaxNode | null` type.
  /* v8 ignore next */
  if (node.parent === null) return undefined
  return namedChildren(node.parent).find(child => child.type === 'modifiers')
}

/** Whether a Java declaration carries `keyword` among its modifiers — see {@link javaModifiersNode}. */
function javaHasModifier(node: SyntaxNode, keyword: string): boolean {
  const modifiers = javaModifiersNode(node)
  return modifiers !== undefined && hasKeywordChild(modifiers, keyword)
}

/**
 * Whether a C/C++ declaration carries `keyword` (`static`, `virtual`, …) among its own named children.
 * Unlike every other grammar this package extracts from, C/C++ wraps a storage-class keyword like
 * `static` in its own named `storage_class_specifier` node rather than leaving it as a bare anonymous
 * token on the declaration itself — `hasKeywordChild` alone would never see it. `virtual`, by contrast,
 * is already its own bare named node with no wrapper, so checking each named child's own text (not just
 * `storage_class_specifier`'s) covers both in one pass. Verified against a real parse, not guessed.
 */
function cHasStorageClassKeyword(node: SyntaxNode, keyword: string): boolean {
  return namedChildren(node).some(child => child.text === keyword)
}

/**
 * Whether a C# declaration carries `keyword` (`public`, `static`, …) among its own named children. C#
 * wraps each modifier keyword in its own flat, individually-named `modifier` node directly on the
 * declaration — unlike Java's single wrapping `modifiers` collection (see {@link javaModifiersNode}) or
 * C/C++'s `storage_class_specifier`, there is no group to look inside; each keyword is its own sibling.
 * Verified against a real parse, not guessed.
 */
function csharpHasModifier(node: SyntaxNode, keyword: string): boolean {
  return namedChildren(node).some(child => child.type === 'modifier' && child.text === keyword)
}

/** C/C++ node types wrapping another `declarator` field one level further down — see {@link declaratorName}. */
const DECLARATOR_WRAPPER_TYPES: ReadonlySet<string> = new Set([
  'pointer_declarator',
  'init_declarator',
  'array_declarator',
  'reference_declarator',
])

/**
 * `parenthesized_declarator`'s inner declarator — unlike every wrapper in {@link DECLARATOR_WRAPPER_TYPES}
 * plus `function_declarator`, its sole child is purely positional, bound to no field at all
 * (`int (*fp)(void);`'s `parenthesized_declarator` wraps a `pointer_declarator` with no `declarator`
 * field to find it through). Verified against a real parse, not guessed.
 */
function parenthesizedDeclaratorInner(node: SyntaxNode): SyntaxNode | null {
  // The grammar never produces an empty `parenthesized_declarator` (`()` alone does not parse as one);
  // the fallback only satisfies `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  return namedChildren(node)[0] ?? null
}

/**
 * The terminal name behind a C/C++ declaration's `declarator` field, however many wrapper layers deep —
 * `int *make(int a)`'s `function_definition.declarator` is a `pointer_declarator` wrapping a
 * `function_declarator` wrapping the `identifier` "make"; a plain `int g = 1;` global's `declaration.declarator`
 * is an `init_declarator` wrapping the `identifier` "g" directly; `int (*fp)(void);`'s is a
 * `function_declarator` wrapping a `parenthesized_declarator` wrapping a `pointer_declarator` wrapping
 * the `identifier` "fp". Every wrapper in {@link DECLARATOR_WRAPPER_TYPES}, plus `function_declarator`,
 * exposes the same `declarator` field down to the next layer; `parenthesized_declarator` alone is
 * unwrapped through {@link parenthesizedDeclaratorInner} instead — see there. Stops at an
 * `identifier`/`field_identifier` (the common case), or at a C++ `destructor_name` (`~C`) kept whole
 * rather than unwrapped to its inner `identifier` — unwrapping would make a destructor's name collide
 * with its constructor's plain class name. A shape this doesn't recognize (a C++ operator-overload
 * declarator's `operator_name`, or a function-pointer typedef) returns `undefined` rather than guess a
 * name from it, the same "don't guess" precedent this file already follows for shapes it does not fully
 * resolve.
 * @param node - the declaration node (`function_definition`, `declaration`, `field_declaration`, …).
 * @returns the terminal name node, or `undefined`.
 */
function declaratorName(node: SyntaxNode): SyntaxNode | undefined {
  // `declaration`/`field_declaration` allow a comma-separated multi-declarator list (`int a, b;`) that
  // shares the same repeated `declarator` field on one node — the same ambiguity Go's `const a, b = 1, 2`
  // has on one `const_spec`; `childForFieldName` below would otherwise silently return only the first.
  // `function_definition`'s `declarator` is never repeated, so this is a no-op there.
  if (soleNamedField(node, 'declarator') === undefined) return undefined
  let current = node.childForFieldName('declarator')
  while (current !== null) {
    if (current.type === 'identifier' || current.type === 'field_identifier' || current.type === 'destructor_name') return current
    if (current.type === 'parenthesized_declarator') {
      current = parenthesizedDeclaratorInner(current)
      continue
    }
    if (current.type !== 'function_declarator' && !DECLARATOR_WRAPPER_TYPES.has(current.type)) return undefined
    current = current.childForFieldName('declarator')
  }
  // Every wrapper type reaching this point (`function_declarator` or a `DECLARATOR_WRAPPER_TYPES`
  // member) is required by the grammar to carry its own nested `declarator`; the loop always returns
  // from inside before `current` could become null.
  /* v8 ignore next */
  return undefined
}

/**
 * The matched node's first named child, when it is an `identifier` — see {@link FIRST_CHILD_NAME_FIELD}.
 * Rejects anything else (e.g. a tuple-deconstructing pattern) rather than name a declaration after a
 * shape this package does not attempt to resolve, the same "don't guess" precedent every other
 * unresolved shape in this file already follows.
 */
function firstChildName(node: SyntaxNode): SyntaxNode | undefined {
  const first = namedChildren(node)[0]
  return first?.type === 'identifier' ? first : undefined
}

/**
 * PHP's bare `name` node — either directly (`const_element`'s first named child) or one level deeper
 * inside a `variable_name` wrapper (`property_element`'s and a closure-binding `assignment_expression`'s
 * first named child) — see {@link PHP_ELEMENT_NAME_FIELD}. Rejects anything else (a destructuring
 * `list_literal` target, a member/subscript assignment target) rather than name a declaration after a
 * shape this package does not attempt to resolve, the same "don't guess" precedent every other
 * unresolved shape in this file already follows. Verified against a real parse, not guessed.
 */
function phpElementName(node: SyntaxNode): SyntaxNode | undefined {
  const first = namedChildren(node)[0]
  // Every node this is called on (`const_element`, `property_element`, a value-guarded
  // `assignment_expression`) is required by the grammar to carry at least one named child; the
  // undefined case only satisfies `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  if (first === undefined) return undefined
  if (first.type === 'name') return first
  if (first.type !== 'variable_name') return undefined
  const inner = namedChildren(first)[0]
  // The grammar's `variable_name` rule always wraps exactly one bare `name`; the fallback only satisfies
  // `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  return inner?.type === 'name' ? inner : undefined
}

/**
 * PHP's own modifier host for `keyword`: a class/method/interface/trait/enum declaration carries its
 * `visibility_modifier`/`static_modifier` directly, but a captured `const_element`/`property_element`
 * carries neither — like Java's `variable_declarator` (see {@link javaModifiersNode}), its modifiers sit
 * one level up, on the enclosing `const_declaration`/`property_declaration` this falls back to.
 */
function phpModifierHost(node: SyntaxNode): SyntaxNode {
  // Every `const_element`/`property_element` the walk visits sits inside a `const_declaration`/
  // `property_declaration`, never at the tree's root; the `?? node` fallback only satisfies `.parent`'s
  // general `SyntaxNode | null` type.
  /* v8 ignore next */
  if (node.type === 'const_element' || node.type === 'property_element') return node.parent ?? node
  return node
}

/** Whether a PHP declaration carries an explicit `public` (or other) `visibility_modifier` — see
 * {@link phpModifierHost}. Verified against a real parse, not guessed. */
function phpHasVisibility(node: SyntaxNode, keyword: string): boolean {
  return namedChildren(phpModifierHost(node)).some(child => child.type === 'visibility_modifier' && child.text === keyword)
}

/** Whether a PHP declaration carries a `static_modifier` — see {@link phpModifierHost}. Verified against
 * a real parse, not guessed. */
function phpHasStaticModifier(node: SyntaxNode): boolean {
  return namedChildren(phpModifierHost(node)).some(child => child.type === 'static_modifier')
}

/**
 * Whether a Rust declaration carries a bare `pub` `visibility_modifier` among its own named children.
 * Every Rust item this package captures places its visibility keyword there directly, unlike Java's
 * wrapping `modifiers` node or C's `storage_class_specifier` — but `pub(crate)`/`pub(super)`/`pub(self)`
 * restrict visibility to inside the crate rather than truly exporting it, so only the bare, unrestricted
 * keyword counts, mirroring Java's/C#'s explicit-`public`-only convention. Verified against a real parse,
 * not guessed.
 */
function rustIsPublic(node: SyntaxNode): boolean {
  return namedChildren(node).some(child => child.type === 'visibility_modifier' && child.text === 'pub')
}

/**
 * The lone named child bound to `field`, or `undefined` when zero or more than one is bound. A field
 * ordinarily binds exactly one child (a declaration's name); Go's `const a, b = 1, 2` is the exception
 * — both identifiers share the `name` field on one `const_spec` node — and this package extracts a
 * single declared name per definition, never a silently partial pick from an ambiguous group.
 */
function soleNamedField(node: SyntaxNode, field: string): SyntaxNode | undefined {
  const named = node.childrenForFieldName(field).filter((child): child is SyntaxNode => child !== null && child.isNamed)
  return named.length === 1 ? named[0] : undefined
}

/** The definition rule matching `node`, or `undefined` when it introduces no declaration. */
function matchDefinition(node: SyntaxNode, definitions: readonly DefinitionRule[]): DefinitionRule | undefined {
  for (const rule of definitions) {
    if (node.type !== rule.nodeType) continue
    if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) continue
    if (rule.grandparentType !== undefined && node.parent?.parent?.type !== rule.grandparentType) continue
    if (rule.value !== undefined) {
      const value = node.childForFieldName(rule.value.field)
      if (value === null || !rule.value.types.includes(value.type)) continue
    }
    const nameNode = rule.nameField === SELF_NAME_FIELD ? node
      : rule.nameField === DECLARATOR_NAME_FIELD ? declaratorName(node)
      : rule.nameField === FIRST_CHILD_NAME_FIELD ? firstChildName(node)
      : rule.nameField === PHP_ELEMENT_NAME_FIELD ? phpElementName(node)
      : soleNamedField(node, rule.nameField)
    if (nameNode === undefined) continue
    if (rule.nameNodeTypes !== undefined && !rule.nameNodeTypes.includes(nameNode.type)) continue
    return rule
  }
  return undefined
}

/**
 * The callee's simple name from a call node's function-field expression: the identifier itself, or
 * the rightmost property/field/selector name for a member access — `obj.parse()` resolves against
 * `parse`, the same ambiguity a workspace-wide name search already accepts and reports through
 * `unresolvedCount` when it cannot be settled.
 * @param callee - the call node's function-field expression.
 * @returns the simple name, or `undefined` when the expression names nothing identifier-shaped (a
 * computed or parenthesized callee, for instance).
 */
function calleeName(callee: SyntaxNode): string | undefined {
  // Rust's turbofish call (`collect::<Vec<_>>()`) wraps the real callee expression in its own
  // `generic_function` node, pairing a `function` field with a sibling `type_arguments` field for the
  // explicit generics — unwrap to the inner expression and resolve it the same way as any other call.
  // Verified against a real parse, not guessed.
  if (callee.type === 'generic_function') {
    const inner = callee.childForFieldName('function')
    return inner === null ? undefined : calleeName(inner)
  }
  if (callee.type === 'identifier') return callee.text
  // PHP's bare-name node type — the resolved `callFunctionFieldByType` field value for all three of its
  // call shapes (`function_call_expression`'s simple case, `member_call_expression`'s and
  // `scoped_call_expression`'s method name) is this node type directly, never wrapped in a further
  // field. Verified against a real parse, not guessed.
  if (callee.type === 'name') return callee.text
  // PHP's namespaced free-function call (`Foo\bar()`) — `qualified_name` binds neither its namespace
  // prefix nor its final segment to a field of its own (unlike C++'s `qualified_identifier`, below); the
  // final segment is always its last named child. Verified against a real parse, not guessed.
  if (callee.type === 'qualified_name') {
    const last = namedChildren(callee).at(-1)
    // The grammar's `qualified_name` rule always wraps at least one final segment of this type; the
    // fallback only satisfies `Array.prototype.at`'s general return type.
    /* v8 ignore next */
    return last?.type === 'name' ? last.text : undefined
  }
  // `name` covers C++'s `qualified_identifier` (`ns::func`), C#'s `member_access_expression`
  // (`obj.Method()`), and Rust's `scoped_identifier` (`Type::method()`, `std::mem::swap()`) — no other
  // call-callee shape in this file's language tables binds a field called `name` for anything else,
  // and Rust's `field_expression` (`obj.method()`) binds `field` instead, already covered below.
  // Verified against a real parse, not guessed.
  const property = callee.childForFieldName('property')
    ?? callee.childForFieldName('field')
    ?? callee.childForFieldName('attribute')
    ?? callee.childForFieldName('name')
  if (property !== null && property.type !== 'computed_property_name') return property.text
  return undefined
}

/** Seam language labels using the ECMAScript-family grammars, for CommonJS `require`/export detection. */
const ECMASCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx'])

/** Shared empty set for a non-ECMAScript file, which never has CommonJS export assignments to find. */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set()

/**
 * A CommonJS `require('./foo')` call recognized as an import binding: `const foo = require('./foo')`
 * binds `foo`; a bare `require('./foo')` statement imports for its side effect only. Any other
 * position (a sub-expression, immediate member access on the call result) is not a binding this
 * package attempts to name — the same "don't guess a name" precedent `ecmascriptImports`/
 * `pythonBinding` already follow for shapes they do not fully resolve. Without this, CommonJS code
 * (still common outside pure-ESM projects) parses `require` as an ordinary, always-unresolved call
 * and the workspace gets no `imports` edge for it at all.
 * @param node - a `call_expression` node.
 * @returns the import binding, or `undefined` when `node` is not a bare top-level `require(...)` call.
 */
function commonJsRequireImport(node: SyntaxNode): RawImport | undefined {
  const callee = node.childForFieldName('function')
  // A call node's `function` field is required by the grammar; the null case only satisfies
  // `childForFieldName`'s general return type.
  /* v8 ignore next */
  if (callee === null) return undefined
  if (callee.type !== 'identifier' || callee.text !== 'require') return undefined
  const argsNode = node.childForFieldName('arguments')
  // Likewise required by the grammar, present (empty) even for a zero-argument call.
  /* v8 ignore next */
  if (argsNode === null) return undefined
  const args = namedChildren(argsNode)
  const specifierNode = args.length === 1 ? args[0] : undefined
  if (specifierNode?.type !== 'string') return undefined
  const specifier = namedChildren(specifierNode)[0]?.text ?? specifierNode.text.slice(1, -1)
  const parent = node.parent
  if (parent?.type === 'variable_declarator') {
    const name = parent.childForFieldName('name')
    if (name?.type !== 'identifier') return undefined
    return { localName: name.text, importedName: '*', specifier }
  }
  if (parent?.type === 'expression_statement') return { localName: '', importedName: '*', specifier }
  return undefined
}

/**
 * A Ruby `require '...'`/`require_relative '...'` call recognized as an import binding — Ruby's
 * grammar has no dedicated import-statement node type at all (see `LANGUAGE_TABLE`'s `ruby` entry),
 * so this dispatches off an ordinary `call` node the same way `commonJsRequireImport` does for
 * CommonJS. Binds no local name — like a C `#include` or a Go whole-package import, `require` pulls
 * in a file for its side effects, not a single symbol this package tracks by name. Verified against a
 * real parse, not guessed.
 * @param node - a `call` node.
 * @returns the import binding, or `undefined` when `node` is not a bare top-level `require`/
 * `require_relative` call.
 */
function rubyRequireImport(node: SyntaxNode): RawImport | undefined {
  const method = node.childForFieldName('method')
  if (method === null || method.type !== 'identifier') return undefined
  if (method.text !== 'require' && method.text !== 'require_relative') return undefined
  const argsNode = node.childForFieldName('arguments')
  if (argsNode === null) return undefined
  const args = namedChildren(argsNode)
  const specifierNode = args.length === 1 ? args[0] : undefined
  if (specifierNode?.type !== 'string') return undefined
  const specifier = namedChildren(specifierNode)[0]?.text ?? specifierNode.text.slice(1, -1)
  return { localName: '', importedName: '*', specifier }
}

/** ECMAScript-family import extraction: `import_statement` with a `import_clause` and a `source`. */
function ecmascriptImports(node: SyntaxNode): RawImport[] {
  // `source` is required by the grammar; the null case only satisfies `childForFieldName`'s general
  // `Node | null` return type.
  const source = node.childForFieldName('source')
  /* v8 ignore next */
  if (source === null) return []
  // An empty string literal (`import ''`) parses with no `string_fragment` child.
  const specifier = namedChildren(source)[0]?.text ?? source.text.slice(1, -1)
  // A side-effect-only import (`import './side'`) carries no `import_clause`.
  const clause = namedChildren(node).find(child => child.type === 'import_clause')
  if (clause === undefined) return []
  const imports: RawImport[] = []
  for (const child of namedChildren(clause)) {
    if (child.type === 'identifier') {
      imports.push({ localName: child.text, importedName: 'default', specifier })
    }
    if (child.type === 'namespace_import') {
      // The grammar requires `* as <identifier>` together; a `namespace_import` node is never
      // produced with no named child.
      const local = namedChildren(child)[0]
      /* v8 ignore next */
      if (local === undefined) continue
      imports.push({ localName: local.text, importedName: '*', specifier })
    }
    if (child.type !== 'named_imports') continue
    // The grammar allows only `import_specifier` as a `named_imports` child; `{}` produces zero
    // named children, never one of a different type.
    for (const specifierNode of namedChildren(child)) {
      /* v8 ignore next */
      if (specifierNode.type !== 'import_specifier') continue
      // `name` is required by the grammar; only `alias` is conditional on an `as` clause.
      const name = specifierNode.childForFieldName('name')
      const alias = specifierNode.childForFieldName('alias')
      /* v8 ignore next */
      if (name === null) continue
      imports.push({ localName: alias?.text ?? name.text, importedName: name.text, specifier })
    }
  }
  return imports
}

/**
 * One Python `decorator` node's name — a bare `@staticmethod` names its own `identifier`; `@app.route`
 * names its dotted `attribute` verbatim (not just the rightmost segment, unlike `calleeName`'s call-site
 * ambiguity — a decorator name is metadata, not something this package resolves, so there is no reason
 * to throw away the qualifying prefix); `@app.route('/x')` first unwraps the `call` to its `function`
 * field, then applies the same rule. Any other shape (e.g. a subscript, `@decorators[0]`) is not named —
 * the "don't guess" precedent this file already follows elsewhere.
 * @param decorator - the `decorator` node.
 * @returns the decorator's name, or `undefined` when its expression is not identifier/attribute-shaped.
 */
function pythonDecoratorName(decorator: SyntaxNode): string | undefined {
  let expr = namedChildren(decorator)[0]
  // A decorator's expression is required by the grammar (`@` alone does not parse); the undefined case
  // only satisfies `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  if (expr === undefined) return undefined
  if (expr.type === 'call') {
    // A call node's `function` field is required by the grammar; the null case only satisfies
    // `childForFieldName`'s general return type.
    const callee = expr.childForFieldName('function')
    /* v8 ignore next */
    if (callee === null) return undefined
    expr = callee
  }
  if (expr.type === 'identifier' || expr.type === 'attribute') return expr.text
  return undefined
}

/**
 * Every decorator name applied to a Python `function_definition`/`class_definition`, from its enclosing
 * `decorated_definition`'s `decorator` children (a decorated declaration is wrapped one level up by the
 * grammar, not marked on the declaration node itself — verified against a real parse, not guessed).
 * Empty when the language is not Python or the declaration is undecorated.
 * @param node - the `function_definition`/`class_definition` node.
 * @param language - the seam language label the file was parsed as.
 * @returns every decorator name applied, outermost first.
 */
function pythonDecorators(node: SyntaxNode, language: string): readonly string[] {
  if (language !== 'python') return []
  if (node.parent?.type !== 'decorated_definition') return []
  const names: string[] = []
  for (const child of namedChildren(node.parent)) {
    if (child.type !== 'decorator') continue
    const name = pythonDecoratorName(child)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * One `dotted_name` or `aliased_import` child of a Python import statement, resolved to a binding.
 * @param child - the `dotted_name` or `aliased_import` node.
 * @param bindsSymbol - whether this statement binds one module-level name (`from x import y`) rather
 * than the whole module (`import x`), which decides whether the binding's `importedName` is the
 * declared name or the seam's namespace marker `'*'`.
 * @param specifier - the module specifier this binding resolves against.
 * @returns the resolved import binding.
 */
function pythonBinding(child: SyntaxNode, bindsSymbol: boolean, specifier: string): RawImport {
  const name = child.type === 'aliased_import' ? fieldText(child, 'name', child.text) : child.text
  const local = child.type === 'aliased_import' ? fieldText(child, 'alias', name) : name
  return { localName: local, importedName: bindsSymbol ? name : '*', specifier }
}

/** Python import extraction: `import_statement` (bare) and `import_from_statement` (relative-capable). */
function pythonImports(node: SyntaxNode): RawImport[] {
  if (node.type === 'import_statement') {
    return namedChildren(node)
      .filter(child => child.type === 'dotted_name' || child.type === 'aliased_import')
      .map((child) => {
        const name = child.type === 'aliased_import' ? fieldText(child, 'name', child.text) : child.text
        return pythonBinding(child, false, name)
      })
  }
  // `module_name` is required by the grammar's `import_from_statement` rule, including the dots-only
  // form (`from . import x`); the null case only satisfies `childForFieldName`'s general return type.
  const moduleNode = node.childForFieldName('module_name')
  /* v8 ignore next */
  const specifier = moduleNode?.text ?? ''
  return namedChildren(node)
    // The module node itself is a named child alongside the imported names — excluded by identity,
    // not by node type, because an absolute module specifier is a `dotted_name` too, indistinguishable
    // by type from an imported symbol written the same way (`from x import y`).
    .filter(child => !(moduleNode !== null && child.equals(moduleNode)))
    .filter(child => child.type === 'dotted_name' || child.type === 'aliased_import' || child.type === 'wildcard_import')
    .map((child) => {
      // `from x import *` binds no individual symbol this package tracks by name, but the module
      // itself is still imported — recording it (with no `localName`, `importedName: '*'`, matching
      // the namespace-import convention `pythonBinding` already uses) keeps the `imports` edge to
      // `specifier` instead of silently dropping the statement.
      if (child.type === 'wildcard_import') return { localName: '', importedName: '*', specifier }
      return pythonBinding(child, true, specifier)
    })
}

/** Go import extraction: `import_declaration` wraps one or more `import_spec` nodes, each requiring a `path`. */
function goImports(node: SyntaxNode): RawImport[] {
  return descendantsOfType(node, ['import_spec']).map((spec) => {
    // `path` is required by the grammar's `import_spec` rule; the null case only satisfies
    // `childForFieldName`'s general `Node | null` return type.
    const path = spec.childForFieldName('path')
    /* v8 ignore next */
    const raw = path === null ? '' : (namedChildren(path)[0]?.text ?? path.text.slice(1, -1))
    // `String.prototype.split` always returns at least one element, so `.pop()` is never `undefined`;
    // the fallback only satisfies the general array-access return type.
    /* v8 ignore next */
    const local = fieldText(spec, 'name', raw.split('/').pop() ?? raw)
    // A package import binds no individual symbol; resolution never matches on `importedName: '*'`,
    // but recording the binding still lets `status`-adjacent tooling see what a file imports.
    return { localName: local, importedName: '*', specifier: raw }
  })
}

/**
 * Java import extraction: `import_declaration` wraps a `scoped_identifier` (a dotted path,
 * `java.util.List`) or, for a single-segment specifier, a bare `identifier`, plus an optional
 * trailing `asterisk` child for a wildcard import (`import java.util.*;`). The `static` keyword
 * (`import static java.lang.Math.max;`) is an unnamed token the grammar tacks onto the same shape, so
 * no separate handling is needed — the specifier and local name below are extracted identically
 * either way. Verified against a real parse, not guessed.
 * @param node - the `import_declaration` node.
 * @returns the single import binding this statement introduces.
 */
function javaImports(node: SyntaxNode): RawImport[] {
  const children = namedChildren(node)
  const path = children.find(child => child.type === 'scoped_identifier' || child.type === 'identifier')
  // `import_declaration` always wraps one of these two node types per the grammar; the undefined case
  // only satisfies `Array.prototype.find`'s general return type.
  /* v8 ignore next */
  if (path === undefined) return []
  const specifier = path.text
  // A package import binds no individual symbol; resolution never matches on `importedName: '*'`,
  // matching `goImports`'s same precedent for a whole-package/wildcard binding.
  if (children.some(child => child.type === 'asterisk')) return [{ localName: '', importedName: '*', specifier }]
  const localName = path.type === 'scoped_identifier' ? fieldText(path, 'name', specifier) : specifier
  return [{ localName, importedName: '*', specifier }]
}

/**
 * C/C++ `#include` extraction. A system include (`#include <stdio.h>`) parses as a `system_lib_string`
 * token holding the whole `<...>` text; a local include (`#include "local.h"`) wraps a `string_literal`
 * around a `string_content` child holding the bare path. Neither binds an individual symbol this
 * package tracks by name — like a Go whole-package import, it is recorded for completeness with no
 * `localName`, matching that same side-effect-only convention. Verified against a real parse, not guessed.
 * @param node - the `preproc_include` node.
 * @returns the single import binding this directive introduces.
 */
function cIncludeImports(node: SyntaxNode): RawImport[] {
  const path = namedChildren(node)[0]
  // `preproc_include` always wraps exactly one of `system_lib_string`/`string_literal`/an
  // expanded-macro path per the grammar; the undefined case only satisfies `namedChildren`'s general
  // array-access return type.
  /* v8 ignore next */
  if (path === undefined) return []
  const specifier = path.type === 'system_lib_string' ? path.text.slice(1, -1) : (namedChildren(path)[0]?.text ?? path.text.slice(1, -1))
  return [{ localName: '', importedName: '*', specifier }]
}

/**
 * C# `using_directive` extraction. A plain directive (`using System;`) wraps its dotted path
 * (`identifier`/`qualified_name`) directly; an aliased one (`using Alias = System.Text;`) wraps a
 * `name_equals` (the alias) alongside the same dotted-path shape for the target. Neither form binds an
 * individual symbol the way an ECMAScript named import does — a C# `using` imports a whole namespace —
 * so the aliased form's `localName` is the alias itself, matching the namespace-import convention
 * `pythonBinding`/`goImports` already use elsewhere in this file. Verified against a real parse, not
 * guessed.
 * @param node - the `using_directive` node.
 * @returns the single import binding this directive introduces.
 */
function csharpUsingImports(node: SyntaxNode): RawImport[] {
  const children = namedChildren(node)
  const alias = children.find(child => child.type === 'name_equals')
  const path = children.find(child => child.type === 'identifier' || child.type === 'qualified_name')
  // `using_directive` always wraps a dotted path per the grammar (a bare `using;` does not parse); the
  // undefined case only satisfies `Array.prototype.find`'s general return type.
  /* v8 ignore next */
  if (path === undefined) return []
  const specifier = path.text
  // The grammar's `name_equals` rule always wraps exactly one `identifier`; the fallback only satisfies
  // `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  const localName = alias === undefined ? '' : (namedChildren(alias)[0]?.text ?? '')
  return [{ localName, importedName: '*', specifier }]
}

/**
 * One `namespace_use_clause`'s bound name and optional alias — `use App\Contracts\Cacheable;` binds a
 * `qualified_name` (its final segment is always the last named child, with no field of its own, matching
 * `calleeName`'s same `qualified_name` handling); a single-segment `use Foo;` binds a bare `name`
 * directly instead. An `as` rename wraps a `namespace_aliasing_clause` sibling. Verified against a real
 * parse, not guessed.
 * @param clause - the `namespace_use_clause` node.
 * @returns the imported name and its local binding, or `undefined` when the clause's target is a shape
 * this package does not name (never observed in practice, but `qualified_name`'s grammar rule allows no
 * other target).
 */
function phpUseClauseBinding(clause: SyntaxNode): { readonly importedName: string, readonly localName: string, readonly specifier: string } {
  // `namespace_use_clause` always wraps exactly one of these two node types per the grammar; the
  // fallback (`clause` itself) only satisfies `Array.prototype.find`'s general return type.
  /* v8 ignore next */
  const target = namedChildren(clause).find(child => child.type === 'qualified_name' || child.type === 'name') ?? clause
  const specifier = target.text
  // The grammar's `qualified_name` rule always wraps at least one final segment; the fallback only
  // satisfies `Array.prototype.at`'s general return type.
  /* v8 ignore next */
  const importedName = target.type === 'qualified_name' ? (namedChildren(target).at(-1)?.text ?? specifier) : specifier
  const alias = namedChildren(clause).find(child => child.type === 'namespace_aliasing_clause')
  // The grammar's `namespace_aliasing_clause` rule always wraps exactly one `name`; the fallback only
  // satisfies `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  const localName = alias === undefined ? importedName : (namedChildren(alias)[0]?.text ?? importedName)
  return { importedName, localName, specifier }
}

/**
 * PHP `namespace_use_declaration` extraction, covering both its shapes: a comma-separated list of
 * `namespace_use_clause` siblings (`use A\B, C\D as E;`), and a group `use App\{Foo, Bar as Baz};` — the
 * group form's shared prefix sits in a bare `namespace_name` sibling of the `namespace_use_group`, and
 * each `namespace_use_group_clause` inside it repeats the same name-plus-optional-alias shape as a plain
 * clause. The `function`/`const` keyword a `use function …`/`use const …` statement adds is an anonymous
 * token the grammar tacks onto the same shape either way, so no separate handling is needed. Verified
 * against a real parse, not guessed.
 * @param node - the `namespace_use_declaration` node.
 * @returns every import binding this statement introduces.
 */
function phpImports(node: SyntaxNode): RawImport[] {
  const group = namedChildren(node).find(child => child.type === 'namespace_use_group')
  if (group !== undefined) {
    // The grammar always pairs a `namespace_use_group` with a preceding `namespace_name` prefix; the
    // undefined case only satisfies `Array.prototype.find`'s general return type.
    const prefix = namedChildren(node).find(child => child.type === 'namespace_name')
    /* v8 ignore next */
    const prefixText = prefix?.text ?? ''
    return namedChildren(group)
      .filter(child => child.type === 'namespace_use_group_clause')
      .map((clause) => {
        // A group clause's own name is always a bare `namespace_name` (itself wrapping a single `name`
        // token, even for a single-segment clause) — never a `qualified_name`, since the shared prefix
        // already carries every segment before it. Verified against a real parse, not guessed.
        const nameNode = namedChildren(clause).find(child => child.type === 'namespace_name')
        // The grammar always binds one per `namespace_use_group_clause`; the undefined case only
        // satisfies `Array.prototype.find`'s general return type.
        /* v8 ignore next */
        const segment = nameNode?.text ?? ''
        const alias = namedChildren(clause).find(child => child.type === 'namespace_aliasing_clause')
        // The grammar's `namespace_aliasing_clause` rule always wraps exactly one `name`; the fallback
        // only satisfies `namedChildren`'s general array-access return type.
        /* v8 ignore next */
        const localName = alias === undefined ? segment : (namedChildren(alias)[0]?.text ?? segment)
        return { localName, importedName: segment, specifier: `${prefixText}\\${segment}` }
      })
  }
  return namedChildren(node)
    .filter(child => child.type === 'namespace_use_clause')
    .map(clause => phpUseClauseBinding(clause))
}

/** A path's final `::`-separated segment, or the whole text when it has none. */
function rustLastSegment(path: string): string {
  const index = path.lastIndexOf('::')
  return index === -1 ? path : path.slice(index + 2)
}

/** `prefix::segment`, or just `segment` when there is no enclosing prefix yet. */
function combineRustPrefix(prefix: string, segment: string): string {
  return prefix === '' ? segment : `${prefix}::${segment}`
}

/**
 * One Rust `use` clause target, resolved to zero or more import bindings — recursive because a
 * `scoped_use_list`/`use_list` can nest arbitrarily (`use std::{fmt::{self, Display}, io};`).
 * @param node - a `_use_clause` node: `identifier`, `self`, `scoped_identifier`, `use_wildcard`,
 * `use_as_clause`, `scoped_use_list`, or `use_list`. `crate`/`super` never reach this function on their
 * own — the grammar only ever produces them as a `scoped_identifier`'s `path` field, never as a
 * standalone use target.
 * @param prefix - the module path text accumulated from enclosing `scoped_use_list` wrappers, or `''`
 * at the top of a `use_declaration`.
 * @returns every import binding this clause (and any it nests) introduces.
 */
function rustUseTarget(node: SyntaxNode, prefix: string): RawImport[] {
  if (node.type === 'identifier') {
    return [{ localName: node.text, importedName: node.text, specifier: combineRustPrefix(prefix, node.text) }]
  }
  if (node.type === 'self') {
    // `self` inside a `use_list` (`use std::fmt::{self, Display};`) imports the enclosing module path
    // itself, bound to its own last segment rather than a member of it. Verified against a real parse.
    const name = rustLastSegment(prefix)
    return [{ localName: name, importedName: name, specifier: prefix }]
  }
  if (node.type === 'scoped_identifier') {
    // `name` is required by the grammar; the fallback only satisfies `childForFieldName`'s general
    // return type.
    const name = node.childForFieldName('name')
    /* v8 ignore next */
    const localName = name?.text ?? node.text
    return [{ localName, importedName: localName, specifier: combineRustPrefix(prefix, node.text) }]
  }
  if (node.type === 'use_wildcard') {
    // The grammar's `use_wildcard` rule always wraps exactly one path node before the `*`; the
    // undefined case only satisfies `namedChildren`'s general array-access return type.
    const path = namedChildren(node)[0]
    /* v8 ignore next */
    const specifier = path === undefined ? prefix : combineRustPrefix(prefix, path.text)
    // A glob import binds no individual symbol this package tracks by name, matching Go's
    // whole-package-import convention.
    return [{ localName: '', importedName: '*', specifier }]
  }
  if (node.type === 'use_as_clause') {
    const path = node.childForFieldName('path')
    const alias = node.childForFieldName('alias')
    // Both fields are required by the grammar's `use_as_clause` rule; the empty-array case only
    // satisfies `childForFieldName`'s general return type.
    /* v8 ignore next */
    if (path === null || alias === null) return []
    const [binding] = rustUseTarget(path, prefix)
    // `rustUseTarget` always returns exactly one binding for the node types `path` can hold here
    // (`identifier`, `self`, `scoped_identifier`); the undefined case only satisfies the general
    // array-destructuring return type.
    /* v8 ignore next */
    return binding === undefined ? [] : [{ ...binding, localName: alias.text }]
  }
  if (node.type === 'scoped_use_list') {
    const path = node.childForFieldName('path')
    const list = node.childForFieldName('list')
    // `list` is required by the grammar's `scoped_use_list` rule; the empty-array case only satisfies
    // `childForFieldName`'s general return type.
    /* v8 ignore next */
    if (list === null) return []
    const newPrefix = path === null ? prefix : combineRustPrefix(prefix, path.text)
    return namedChildren(list).flatMap(child => rustUseTarget(child, newPrefix))
  }
  if (node.type === 'use_list') {
    return namedChildren(node).flatMap(child => rustUseTarget(child, prefix))
  }
  // No other node type is a valid `_use_clause` alternative per the grammar.
  /* v8 ignore next */
  return []
}

/** Rust `use_declaration` extraction, dispatching to {@link rustUseTarget} on its `argument` field. */
function rustImports(node: SyntaxNode): RawImport[] {
  const argument = node.childForFieldName('argument')
  // `argument` is required by the grammar's `use_declaration` rule; the empty-array case only satisfies
  // `childForFieldName`'s general return type.
  /* v8 ignore next */
  if (argument === null) return []
  return rustUseTarget(argument, '')
}

/** Whether `node` is a bare name this package resolves heritage references against — a member
 * expression (`ns.Base`) or a call (a mixin, `f(Base)`) is not, matching the "don't guess" precedent
 * `calleeName`/`ecmascriptImports` already follow for shapes they do not fully resolve. `constant` is
 * Ruby's own bare-name node type (see `rubyClassHeritage`), verified against a real parse. */
function isHeritageName(node: SyntaxNode): boolean {
  return node.type === 'identifier' || node.type === 'type_identifier' || node.type === 'name' || node.type === 'constant'
}

/**
 * ECMAScript-family `extends`/`implements` extraction from a `class_declaration`'s `class_heritage`
 * child. Plain JavaScript's `class_heritage` wraps the extended expression directly (`extends Base` has
 * no further wrapper — JavaScript has no `implements`); TypeScript's wraps an `extends_clause` and an
 * optional `implements_clause` instead, verified against a real parse, not guessed.
 * @param node - the `class_declaration` node.
 * @param sourceKey - the declaring class's own {@link RawDefinition.key}.
 * @returns every heritage reference the class declares.
 */
function ecmascriptClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const heritage = namedChildren(node).find(child => child.type === 'class_heritage')
  if (heritage === undefined) return []
  const refs: RawHeritageRef[] = []
  for (const child of namedChildren(heritage)) {
    if (child.type === 'extends_clause') {
      const target = namedChildren(child)[0]
      if (target !== undefined && isHeritageName(target)) refs.push({ sourceKey, targetName: target.text, relation: 'extends' })
      continue
    }
    if (child.type === 'implements_clause') {
      for (const impl of namedChildren(child)) {
        if (isHeritageName(impl)) refs.push({ sourceKey, targetName: impl.text, relation: 'implements' })
      }
      continue
    }
    // Plain JavaScript: `child` is the extended expression itself.
    if (isHeritageName(child)) refs.push({ sourceKey, targetName: child.text, relation: 'extends' })
  }
  return refs
}

/**
 * TypeScript `interface_declaration` `extends` extraction from its `extends_type_clause` child — an
 * interface can extend more than one other interface (`interface C extends A, B {}`).
 * @param node - the `interface_declaration` node.
 * @param sourceKey - the declaring interface's own {@link RawDefinition.key}.
 * @returns every heritage reference the interface declares.
 */
function tsInterfaceHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const clause = namedChildren(node).find(child => child.type === 'extends_type_clause')
  if (clause === undefined) return []
  return namedChildren(clause)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * Python `class_definition` base-class extraction from its `argument_list` child — shared with call
 * argument syntax, so a `keyword_argument` (`metaclass=Meta`) is filtered out rather than treated as a
 * base; Python draws no distinction between a base class and an interface, so every entry is `extends`.
 * @param node - the `class_definition` node.
 * @param sourceKey - the declaring class's own {@link RawDefinition.key}.
 * @returns every heritage reference the class declares.
 */
function pythonClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const args = namedChildren(node).find(child => child.type === 'argument_list')
  if (args === undefined) return []
  return namedChildren(args)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * Java `class_declaration`/`record_declaration` heritage extraction from their `superclass` (a record
 * has none — a record can never extend another class, so the field is simply absent) and `interfaces`
 * fields — both hold the clause node (`superclass`/`super_interfaces`) directly, one level above the
 * `type_identifier`(s) themselves, verified against a real parse, not guessed.
 * @param node - the `class_declaration`/`record_declaration` node.
 * @param sourceKey - the declaring type's own {@link RawDefinition.key}.
 * @returns every heritage reference the type declares.
 */
function javaClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const refs: RawHeritageRef[] = []
  const superclass = node.childForFieldName('superclass')
  const target = superclass === null ? undefined : namedChildren(superclass)[0]
  if (target !== undefined && isHeritageName(target)) refs.push({ sourceKey, targetName: target.text, relation: 'extends' })
  const interfaces = node.childForFieldName('interfaces')
  const typeList = interfaces === null ? undefined : namedChildren(interfaces)[0]
  if (typeList !== undefined) {
    for (const impl of namedChildren(typeList)) {
      if (isHeritageName(impl)) refs.push({ sourceKey, targetName: impl.text, relation: 'implements' })
    }
  }
  return refs
}

/**
 * Java `interface_declaration` `extends` extraction — an interface can extend more than one other
 * interface (`interface C extends A, B {}`), from its `extends_interfaces` child; unlike
 * `class_declaration`'s `superclass`/`interfaces` fields, `interface_declaration` binds no field name
 * of its own to this clause, so it is found by node type instead, matching `ecmascriptClassHeritage`'s
 * same fallback for plain JavaScript. Verified against a real parse, not guessed.
 * @param node - the `interface_declaration` node.
 * @param sourceKey - the declaring interface's own {@link RawDefinition.key}.
 * @returns every heritage reference the interface declares.
 */
function javaInterfaceHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const clause = namedChildren(node).find(child => child.type === 'extends_interfaces')
  if (clause === undefined) return []
  const typeList = namedChildren(clause)[0]
  // `extends_interfaces` always wraps exactly one `type_list` per the grammar (an interface can never
  // write a bare `extends` with nothing after it); the undefined case only satisfies the general
  // array-access return type.
  /* v8 ignore next */
  if (typeList === undefined) return []
  return namedChildren(typeList)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * C++/C# base-list heritage extraction, shared by both: neither C++'s `class_specifier`/`struct_specifier`
 * nor C#'s `class_declaration`/`struct_declaration`/`record_declaration`/`interface_declaration` bind
 * their base list to a dedicated field name — both are found by node type instead, matching
 * `ecmascriptClassHeritage`'s same fallback for plain JavaScript. Neither grammar syntactically
 * distinguishes an extended base class from an implemented interface in this list — the same ambiguity
 * `pythonClassHeritage` already documents for Python's `argument_list` bases — so every entry reports
 * `extends`, including when the declaring node is itself an interface extending another interface (C#'s
 * `interface IBar : IFoo`), matching `javaInterfaceHeritage`/`tsInterfaceHeritage`'s existing convention
 * for that shape. Verified against a real parse, not guessed.
 * @param node - the declaring class/struct/interface/record node.
 * @param sourceKey - the declaring definition's own {@link RawDefinition.key}.
 * @param clauseType - the base-list node's own type (`base_class_clause` for C++, `base_list` for C#).
 * @returns every heritage reference the definition declares.
 */
function baseListHeritage(node: SyntaxNode, sourceKey: string, clauseType: string): RawHeritageRef[] {
  const clause = namedChildren(node).find(child => child.type === clauseType)
  if (clause === undefined) return []
  return namedChildren(clause)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * PHP `class_declaration`/`interface_declaration`/`enum_declaration` heritage extraction. A class's
 * single `extends` base sits in its own `base_clause` (PHP classes have no multiple inheritance); an
 * interface's possibly-multiple `extends` bases reuse that same `base_clause` node type; a class's or
 * enum's `implements` list sits in a `class_interface_clause` — neither clause binds to a field of its
 * own, found by node type instead, matching `ecmascriptClassHeritage`'s same fallback for plain
 * JavaScript. One function covers all three kinds since neither clause is exclusive to one of them (an
 * interface never has a `class_interface_clause`, an enum never has a `base_clause`), so there is no
 * ambiguity in reporting the relation `base_clause` → `extends` and `class_interface_clause` →
 * `implements` regardless of which kind is declaring. A trait's `use` of another trait is not
 * `extends`/`implements` shaped and is not reported here — see `extractHeritage`'s call site. Verified
 * against a real parse, not guessed.
 * @param node - the declaring class/interface/enum node.
 * @param sourceKey - the declaring definition's own {@link RawDefinition.key}.
 * @returns every heritage reference the definition declares.
 */
function phpHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const refs: RawHeritageRef[] = []
  const base = namedChildren(node).find(child => child.type === 'base_clause')
  if (base !== undefined) {
    for (const target of namedChildren(base)) {
      if (isHeritageName(target)) refs.push({ sourceKey, targetName: target.text, relation: 'extends' })
    }
  }
  const iface = namedChildren(node).find(child => child.type === 'class_interface_clause')
  if (iface !== undefined) {
    for (const target of namedChildren(iface)) {
      if (isHeritageName(target)) refs.push({ sourceKey, targetName: target.text, relation: 'implements' })
    }
  }
  return refs
}

/**
 * Ruby `class` superclass extraction from its `superclass` field (`class Dog < Animal`) — the field
 * wraps the extended name directly, one level above the bare `constant`, the same shape C's
 * `type_definition`'s `declarator` field wraps its target one level down. Ruby draws no
 * `implements`-shaped distinction of its own (a mixin `include Module` is an ordinary method call,
 * structurally indistinguishable from any other, so it is not extracted — the "don't guess" precedent
 * `pythonClassHeritage` already documents for a comparable ambiguity), so every entry reports `extends`.
 * Verified against a real parse, not guessed.
 * @param node - the `class` node.
 * @param sourceKey - the declaring class's own {@link RawDefinition.key}.
 * @returns every heritage reference the class declares.
 */
function rubyClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const superclass = node.childForFieldName('superclass')
  const target = superclass === null ? undefined : namedChildren(superclass)[0]
  if (target !== undefined && isHeritageName(target)) return [{ sourceKey, targetName: target.text, relation: 'extends' }]
  return []
}

/**
 * Rust `trait_item` supertrait extraction from its `bounds` field (`trait Shape: Debug + Display {}`).
 * Every supertrait requirement is reported as `extends`, matching `tsInterfaceHeritage`'s and
 * `javaInterfaceHeritage`'s convention for a multi-base interface declaration; a `impl Trait for Type`
 * block's own trait relationship is not extracted here or anywhere else in this package — unlike a
 * class/struct/trait declaration, an `impl` block is never itself captured as a `RawDefinition` (it
 * introduces no name of its own the seam's `container`/qualified-name scheme could attach to), so it has
 * no {@link RawDefinition.key} to source a heritage reference from. Verified against a real parse, not
 * guessed.
 * @param node - the `trait_item` node.
 * @param sourceKey - the declaring trait's own {@link RawDefinition.key}.
 * @returns every heritage reference the trait declares.
 */
function rustTraitHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const bounds = node.childForFieldName('bounds')
  if (bounds === null) return []
  return namedChildren(bounds)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * Dispatch heritage extraction to the language family that owns a captured class, struct, or interface
 * node's syntax. Go is absent: its interfaces are satisfied structurally, never declared at the
 * implementing type, so there is no static reference here to extract.
 * @param node - the captured `class`-, `struct`-, `interface`-, or `trait`-kind definition node.
 * @param kind - the captured definition's seam kind (`'class'`, `'struct'`, `'interface'`, or `'trait'`).
 * @param sourceKey - the declaring definition's own {@link RawDefinition.key}.
 * @param language - the seam language label the file was parsed as.
 * @returns every heritage reference the definition declares.
 */
function extractHeritage(node: SyntaxNode, kind: string, sourceKey: string, language: string): RawHeritageRef[] {
  // `kind === 'trait'` only ever comes from Rust's `trait_item` rule — no other language in
  // LANGUAGE_TABLE produces it.
  if (kind === 'trait') return rustTraitHeritage(node, sourceKey)
  // `kind === 'interface'` only ever comes from TYPESCRIPT_DEFINITIONS's, Java's, or C#'s
  // `interface_declaration` rule — no other language in LANGUAGE_TABLE produces it.
  if (kind === 'interface') {
    if (language === 'java') return javaInterfaceHeritage(node, sourceKey)
    if (language === 'csharp') return baseListHeritage(node, sourceKey, 'base_list')
    if (language === 'php') return phpHeritage(node, sourceKey)
    return tsInterfaceHeritage(node, sourceKey)
  }
  // `kind === 'struct'` only ever comes from C/C++'s `struct_specifier`/`union_specifier` or C#'s
  // `struct_declaration` rule — a plain C struct/union has no base-list syntax at all, so
  // `baseListHeritage` simply finds nothing to report for it.
  if (kind === 'struct') return baseListHeritage(node, sourceKey, language === 'csharp' ? 'base_list' : 'base_class_clause')
  // `kind === 'enum'` only ever comes from PHP's `enum_declaration` rule today — no other language's
  // enum rule reaches this dispatch (TypeScript's/Java's/C#'s enum kinds carry no heritage syntax of
  // their own this package extracts elsewhere), so every other language reports nothing here.
  if (kind === 'enum') return language === 'php' ? phpHeritage(node, sourceKey) : []
  if (kind !== 'class') return []
  if (language === 'python') return pythonClassHeritage(node, sourceKey)
  // `kind === 'class'` from Java's `class_declaration`/`record_declaration` rules — see `javaClassHeritage`.
  if (language === 'java') return javaClassHeritage(node, sourceKey)
  if (language === 'cpp') return baseListHeritage(node, sourceKey, 'base_class_clause')
  if (language === 'csharp') return baseListHeritage(node, sourceKey, 'base_list')
  if (language === 'php') return phpHeritage(node, sourceKey)
  if (language === 'ruby') return rubyClassHeritage(node, sourceKey)
  // Otherwise only comes from ECMASCRIPT_DEFINITIONS's `class_declaration` rule — Go has no class
  // concept, so this is never reached with `language === 'go'`.
  return ecmascriptClassHeritage(node, sourceKey)
}

/**
 * Extract every definition, call, and import from one parsed file.
 * @param tree - the file's parsed syntax tree.
 * @param spec - the language's extraction table entry.
 * @returns the raw, not-yet-resolved extraction.
 */
export function extractFile(tree: Tree, spec: LanguageSpec): FileExtraction {
  const definitions: RawDefinition[] = []
  const calls: RawCall[] = []
  const imports: RawImport[] = []
  const heritage: RawHeritageRef[] = []
  const containerNames: string[] = []
  const containerKeys: (string | null)[] = [null]
  const commonJsExports = ECMASCRIPT_LANGUAGES.has(spec.language) ? commonJsExportedNames(tree.rootNode) : EMPTY_NAME_SET
  // Tracks whether the node currently being visited sits at module top level, directly inside a class
  // body, or inside a function/method body — see `DefinitionRule.scopeRestricted` and
  // `LanguageSpec.bareFunctionScopeTypes`.
  const scopeKinds: ScopeKind[] = ['module']

  function visit(node: SyntaxNode): void {
    const rule = matchDefinition(node, spec.definitions)
    // A `scopeRestricted` rule matched inside a function/method body is treated as no match at all —
    // the node still gets visited below, just without becoming a definition or a container.
    const captured = rule !== undefined
      && (rule.scopeRestricted !== true || scopeKinds[scopeKinds.length - 1] !== 'other')
    if (captured) {
      // `matchDefinition` already confirmed `declaratorName`/`firstChildName` return non-`undefined` for
      // this same node when `rule` matched; the assertions below only satisfy the ternary's
      // `SyntaxNode | null` type, mirroring `node.childForFieldName`'s own return type — not a runtime
      // branch, so nothing here needs a test of its own.
      const nameNode = rule.nameField === SELF_NAME_FIELD ? node
        : rule.nameField === DECLARATOR_NAME_FIELD ? declaratorName(node) as SyntaxNode
        : rule.nameField === FIRST_CHILD_NAME_FIELD ? firstChildName(node) as SyntaxNode
        : rule.nameField === PHP_ELEMENT_NAME_FIELD ? phpElementName(node) as SyntaxNode
        : node.childForFieldName(rule.nameField)
      // A matched rule's node type is always the NAMED-declaration form the grammar mandates a name
      // for; the anonymous form (`function_expression`, `class` as an expression, both produced by an
      // anonymous default export) parses as a different node type this rule never matches.
      /* v8 ignore next */
      if (nameNode !== null) {
        const key = `${node.startPosition.row}:${node.startPosition.column}`
        const parentKey = containerKeys[containerKeys.length - 1] ?? null
        definitions.push({
          key,
          parentKey,
          kind: rule.kind,
          name: nameNode.text,
          container: [...containerNames],
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          isExported: isExported(node, spec.language, nameNode.text, commonJsExports),
          isAsync: hasKeywordChild(node, 'async'),
          // Java nests every modifier keyword one level down inside a `modifiers` node rather than as
          // a direct child of the declaration itself — see `javaHasModifier`. C/C++ wrap `static` in a
          // `storage_class_specifier` — see `cHasStorageClassKeyword`. C# gives each modifier its own
          // flat `modifier` node — see `csharpHasModifier`.
          isStatic: spec.language === 'java' ? javaHasModifier(node, 'static')
            : spec.language === 'c' || spec.language === 'cpp' ? cHasStorageClassKeyword(node, 'static')
            : spec.language === 'csharp' ? csharpHasModifier(node, 'static')
            : spec.language === 'php' ? phpHasStaticModifier(node)
            : hasKeywordChild(node, 'static'),
          decorators: pythonDecorators(node, spec.language),
        })
        heritage.push(...extractHeritage(node, rule.kind, key, spec.language))
        containerNames.push(nameNode.text)
        containerKeys.push(key)
        // A C/C++/C# `struct` is scoped exactly like a `class` for this purpose — a `scopeRestricted`
        // field rule must fire directly inside either body, not just a `class` one. Rust's `mod`
        // (`namespace`) is scoped like the module top level it nests, not like a function body — a
        // `scopeRestricted` `const`/`static` rule must still fire directly inside one.
        scopeKinds.push(rule.kind === 'class' || rule.kind === 'struct' ? 'class' : rule.kind === 'namespace' ? 'module' : 'other')
        for (const child of namedChildren(node)) visit(child)
        scopeKinds.pop()
        containerKeys.pop()
        containerNames.pop()
        return
      }
    }

    if (spec.callTypes.includes(node.type)) {
      // Every call-shaped node type in every language table entry requires its callee field; the null
      // case only satisfies `childForFieldName`'s general return type.
      const calleeField = spec.callFunctionFieldByType?.[node.type] ?? spec.callFunctionField
      const callee = node.childForFieldName(calleeField)
      /* v8 ignore next */
      const name = callee === null ? undefined : calleeName(callee)
      if (name !== undefined) {
        // `callee` is non-null whenever `name` is: the optional chaining only satisfies the type
        // system's view of the field lookup above, not a real possibility here.
        /* v8 ignore next */
        const isBareCallee = callee?.type === 'identifier' || callee?.type === 'name'
        calls.push({
          callerKey: containerKeys[containerKeys.length - 1] ?? null,
          calleeName: name,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          // The `object` check covers Java's `method_invocation` and PHP's `member_call_expression`,
          // whose `name` field is always a bare identifier — the receiver, if any, sits in a separate
          // sibling field instead of wrapping the callee the way every other grammar's member expression
          // does. The `scope` check covers PHP's `scoped_call_expression` (`Class::method()`), whose
          // receiver sits in a sibling `scope` field instead of `object`; no other call-type node in
          // LANGUAGE_TABLE binds either field, so both are a no-op for every other language. Without
          // `isBareCallee` also accepting PHP's `'name'` type alongside `'identifier'`, every PHP call —
          // including an ordinary global `function_call_expression` — would be misclassified as
          // member-like, since PHP's bare-name node type is `name`, never `identifier`. The `receiver`
          // check covers Ruby's `call` node (`obj.method_name(x)`), whose callee is always a bare
          // `identifier` in its own `method` field regardless of receiver — unlike every other grammar's
          // member expression, the receiver sits in a distinct sibling field instead of wrapping the
          // callee; no other call-type node in LANGUAGE_TABLE binds a field named `receiver`. Verified
          // against a real parse, not guessed.
          isMemberCall: !isBareCallee || node.childForFieldName('object') !== null || node.childForFieldName('scope') !== null || node.childForFieldName('receiver') !== null,
        })
      }
    }

    if (spec.importTypes.includes(node.type)) {
      imports.push(...extractImports(node, spec.language))
    }

    if (node.type === 'call_expression' && ECMASCRIPT_LANGUAGES.has(spec.language)) {
      const requireImport = commonJsRequireImport(node)
      if (requireImport !== undefined) imports.push(requireImport)
    }

    if (node.type === 'call' && spec.language === 'ruby') {
      const requireImport = rubyRequireImport(node)
      if (requireImport !== undefined) imports.push(requireImport)
    }

    // A callback or IIFE's function value is never itself captured as a definition (only a *named*
    // declaration, or one assigned through a captured `variable_declarator`, is) — but a `const`/`var`
    // in its body is still function-local, so its scope must flip to `'other'` here regardless.
    const entersBareFunctionScope = spec.bareFunctionScopeTypes.includes(node.type)
    if (entersBareFunctionScope) scopeKinds.push('other')
    for (const child of namedChildren(node)) visit(child)
    if (entersBareFunctionScope) scopeKinds.pop()
  }

  visit(tree.rootNode)
  return { definitions, calls, imports, heritage }
}

/** Dispatch import extraction to the language family that owns `node`'s syntax. */
function extractImports(node: SyntaxNode, language: string): RawImport[] {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return ecmascriptImports(node)
    case 'python':
      return pythonImports(node)
    case 'go':
      return goImports(node)
    case 'java':
      return javaImports(node)
    case 'c':
    case 'cpp':
      return cIncludeImports(node)
    case 'csharp':
      return csharpUsingImports(node)
    case 'php':
      return phpImports(node)
    case 'rust':
      return rustImports(node)
    /* v8 ignore next 2 -- exhaustive over LANGUAGE_TABLE's current language labels; unreachable. */
    default:
      return []
  }
}

/** Whether `node` is the two-level `module.exports` member expression itself (not `module.exports.x`). */
function isModuleExportsExpression(node: SyntaxNode | null): boolean {
  return node?.type === 'member_expression'
    && node.childForFieldName('object')?.type === 'identifier'
    && node.childForFieldName('object')?.text === 'module'
    && node.childForFieldName('property')?.text === 'exports'
}

/**
 * Every name a top-level CommonJS export assignment marks exported: `module.exports.NAME = ...` /
 * `exports.NAME = ...` (named export), and `module.exports = NAME` (whole-module reassignment to a
 * single local declaration). `module.exports = { a, b }` (object-literal reassignment) is not handled
 * — distinguishing a shorthand property from a computed or renamed one adds a second layer of "don't
 * guess" cases this pass does not need yet; only the two unambiguous forms above are recognized.
 * Restricted to true top-level statements, matching this file's existing module/class-only scope
 * restriction for a `scopeRestricted` `DefinitionRule` — a conditional or function-body export
 * assignment is not a module's public surface in the same unconditional sense.
 * @param root - the file's parsed root (`program`) node.
 * @returns every name a CommonJS export assignment binds.
 */
function commonJsExportedNames(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of namedChildren(root)) {
    if (statement.type !== 'expression_statement') continue
    const expr = namedChildren(statement)[0]
    if (expr?.type !== 'assignment_expression') continue
    const left = expr.childForFieldName('left')
    if (left?.type !== 'member_expression') continue
    const object = left.childForFieldName('object')
    const property = left.childForFieldName('property')
    if (isModuleExportsExpression(object) || (object?.type === 'identifier' && object.text === 'exports')) {
      // `property` is required by the grammar's `member_expression` rule; the null case only
      // satisfies `childForFieldName`'s general return type.
      /* v8 ignore next */
      if (property !== null) names.add(property.text)
      continue
    }
    if (isModuleExportsExpression(left)) {
      const right = expr.childForFieldName('right')
      if (right?.type === 'identifier') names.add(right.text)
    }
  }
  return names
}

/**
 * Whether a declaration is exported from its module, by the export construct its own language
 * defines: ECMAScript wraps an exported statement in `export_statement`, or — for CommonJS code, still
 * common outside pure-ESM projects — is named by a top-level `module.exports`/`exports` assignment (see
 * {@link commonJsExportedNames}); Go's spec defines an exported identifier as one starting with an
 * uppercase letter, with no separate keyword; Java marks a declaration exported by an explicit
 * `public` modifier (see {@link javaHasModifier}) — an interface member's implicit `public` with no
 * keyword at all is not detected, matching this function's existing refusal to infer visibility from
 * anything but an explicit language construct; C's is external vs. internal *linkage* — a top-level
 * function or variable without `static` has external linkage (visible to other translation units), the
 * same real-rule precedent Go's capitalization check follows rather than a guess; C++ inherits that same
 * rule for its own free (non-member) functions and variables, but reports `false` for a class/struct
 * member — a method or field has no comparable linkage concept of its own, and neither does any other
 * kind (`struct`, `enum`, `type_alias`); C# marks a declaration exported by an explicit `public` modifier
 * (see {@link csharpHasModifier}), mirroring Java; Python defines no export construct at all, so every
 * Python declaration reports `false` rather than guess one from a naming convention or an `__all__` list
 * the extractor does not read; Rust marks a declaration exported by an explicit bare `pub`
 * `visibility_modifier` (see {@link rustIsPublic}) — a restricted `pub(crate)`/`pub(super)`/`pub(self)`
 * does not count, mirroring Java's/C#'s explicit-`public`-only convention.
 * @param node - the definition node.
 * @param language - the seam language label the file was parsed as.
 * @param name - the declaration's simple name.
 * @param commonJsExports - every name a CommonJS export assignment in this file binds.
 * @returns whether the language's own export rule marks this declaration exported.
 */
function isExported(node: SyntaxNode, language: string, name: string, commonJsExports: ReadonlySet<string>): boolean {
  if (language === 'go') return /^\p{Lu}/u.test(name)
  if (language === 'java') return javaHasModifier(node, 'public')
  if (language === 'csharp') return csharpHasModifier(node, 'public')
  if (language === 'c' || language === 'cpp') {
    // A C++ method is a `function_definition` directly inside a class/struct's `field_declaration_list`
    // — the same node type a free function uses, but with no linkage concept of its own to report.
    if (node.type === 'function_definition') return node.parent?.type !== 'field_declaration_list' && !cHasStorageClassKeyword(node, 'static')
    // A top-level `declaration` (kind `variable`) is always module-scope — `scopeRestricted` already
    // excludes the function-local case, so no further scope check is needed here.
    if (node.type === 'declaration') return !cHasStorageClassKeyword(node, 'static')
    return false
  }
  if (language === 'python') return false
  // Ruby's `private`/`protected`/`public` are ordinary method calls that toggle visibility for
  // subsequently defined methods, not a keyword on the declaration itself, and there is no separate
  // module-level export construct at all — matching Python's precedent, every Ruby declaration reports
  // `false` rather than guess one from tracking those calls' effect through the file.
  if (language === 'ruby') return false
  // A PHP top-level function/class/interface/trait/enum carries no visibility keyword of its own — the
  // language has no export construct for them, matching Python's precedent, and this reports `false`
  // for all of them since `phpHasVisibility` finds no `visibility_modifier` to check. A class/enum
  // member (`const`/property/method) does carry one, mirroring Java's/C#'s explicit-`public`-only
  // convention: an interface member's implicit `public` with no keyword at all is not detected either,
  // the same refusal to infer visibility from anything but an explicit language construct.
  if (language === 'php') return phpHasVisibility(node, 'public')
  if (language === 'rust') return rustIsPublic(node)
  if (commonJsExports.has(name)) return true
  let current: SyntaxNode | null = node.parent
  while (current !== null) {
    if (current.type === 'export_statement') return true
    // A statement block or class body ends the search: an export wraps a top-level statement, never
    // reaches inside a function or class body to a nested declaration.
    if (current.type === 'statement_block' || current.type === 'class_body') return false
    current = current.parent
  }
  return false
}
