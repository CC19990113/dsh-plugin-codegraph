/**
 * Per-language extraction tables: which tree-sitter node types are definitions, which are call
 * sites, and which anchor an import, for every grammar this package loads today.
 *
 * The table is deliberately small. It covers the definition/call/import core the seam's operations
 * depend on — not every declaration shape a language can produce — because the alternative is porting
 * the reference indexer's language-specific resolution, which the proposal this package implements
 * defers until the core proves itself against real workspaces.
 * @module dsh-plugin-codegraph-tree-sitter/languages
 */

/** One tree-sitter node type that introduces a declaration, mapped to the seam's `NODE_KINDS`. */
export interface DefinitionRule {
  /** The tree-sitter node type this rule matches, e.g. `function_declaration`. */
  readonly nodeType: string
  /** The seam node kind to record, e.g. `function`. See `NODE_KINDS` in `dsh-plugin-codegraph-service`. */
  readonly kind: string
  /** The field holding the declared name; `childForFieldName(nameField)` must be an identifier. */
  readonly nameField: string
  /**
   * Present only when this rule is conditional on the shape of a value it binds — a
   * `variable_declarator` is a function definition when its `value` is a function expression, and is
   * otherwise not extracted at all. Field and matching types travel together so a rule can never
   * declare one without the other.
   */
  readonly value?: {
    /** Field naming the value assigned to the binding. */
    readonly field: string
    /** Node types the field must resolve to for this rule to match. */
    readonly types: readonly string[]
  }
  /**
   * Present only when this rule must reject a name shape it cannot represent as a single declared
   * name — a destructuring `variable_declarator` (`const {a, b} = x`) or a Python tuple/attribute
   * assignment (`a, b = 1, 2`, `self.x = 1`) binds through {@link nameField} too, but to a pattern
   * node this package does not attempt to name. Absent, any node type in {@link nameField} matches.
   */
  readonly nameNodeTypes?: readonly string[]
  /**
   * Present only when this rule must not match the same node type wherever it appears — a bare
   * `property_identifier` names an enum member only directly inside an `enum_body`; the same node
   * type also names a method, a class field, and a member-expression property everywhere else. Absent,
   * any parent matches.
   */
  readonly parentType?: string
  /**
   * True only for a rule this package extracts solely directly inside a module's top level or a class
   * body — never inside a function or method body. Unlike a function or class declaration (captured at
   * any depth, however deeply nested), a function-local variable is not a workspace "symbol" anyone
   * would search for by name, and capturing it would flood the cross-file name index `resolve.ts` uses
   * to settle calls — more names means more collisions, which means more calls silently dropped to
   * `unresolved`. See `resolve.ts`'s "an ambiguous edge is worse than a missing one" rule.
   *
   * This is a property of the *rule*, not of {@link kind} in general: JS/TS's `field_definition` rule
   * (kind `field`) sets this because a class field could in principle sit at any depth a class does —
   * but Go's struct-field rule, also kind `field`, must not, because its enclosing `type_spec` is itself
   * never scope-restricted (a Go type declaration is captured at any depth, like a function), so a
   * scope-restricted struct-field rule could never fire at all. Absent (the common case), always
   * extracted regardless of depth.
   */
  readonly scopeRestricted?: boolean
  /**
   * Present only when a rule must distinguish two node types that share both their own type and their
   * immediate parent's type — C#'s field vs. local variable both parse as a `variable_declarator`
   * directly inside a `variable_declaration`, and only the *grandparent* differs
   * (`field_declaration` vs. `local_declaration_statement`). Absent, any grandparent matches, the same
   * as an absent {@link parentType}.
   */
  readonly grandparentType?: string
}

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose matched node has no separate
 * name-bearing child — a bare enum member (`enum_body`'s `Red` in `enum Color { Red }`) parses as a
 * lone `property_identifier` token with no fields of its own; the node itself, unlike every other
 * `nameField` target, *is* the name.
 */
export const SELF_NAME_FIELD = '@self'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name sits behind an arbitrarily deep
 * chain of C/C++ `declarator` wrappers — `int *make(int a)`'s name is three `declarator` fields down
 * (`pointer_declarator` → `function_declarator` → `identifier`), and a plain `int g` binds its
 * `identifier` directly with no wrapper at all. See `declaratorName` in `extract.ts`, which this
 * sentinel dispatches to instead of a flat `childForFieldName` lookup.
 */
export const DECLARATOR_NAME_FIELD = '@declarator'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name is its matched node's first
 * named child with no field name of its own — C#'s `variable_declarator` binds neither its name nor its
 * optional initializer to a field at all (`int Field = 5;`'s `variable_declarator` has two purely
 * positional named children, `identifier` then `equals_value_clause`), unlike every other grammar this
 * package extracts a name from. Distinct from {@link SELF_NAME_FIELD}: the matched node's own text
 * would include that initializer (`"Field = 5"`), not just the name. See `firstChildName` in
 * `extract.ts`.
 */
export const FIRST_CHILD_NAME_FIELD = '@first-child'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name is PHP-specific: a bare `name`
 * node directly (`const_element`'s `VERSION` in `const VERSION = "1"`), or one nested a level deeper
 * inside a `variable_name` child (`property_element`'s `$name` in `public string $name;`, and an
 * `assignment_expression`'s `$fn` in `$fn = function () {}` — both bind their bare `name` behind the
 * same `$`-prefixed wrapper). See `phpElementName` in `extract.ts`, which this sentinel dispatches to
 * instead of a flat `childForFieldName` lookup — none of these three shapes bind their name to a field
 * of its own.
 */
export const PHP_ELEMENT_NAME_FIELD = '@php-element'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name is Kotlin-specific: the bundled
 * `tree-sitter-kotlin` grammar this package loads binds *no* grammar fields at all (verified against a
 * real parse — `Language.fieldCount`/`fieldNameForId` enumerate zero for it), unlike every other grammar
 * this package extracts from, so a plain `childForFieldName` lookup can never work here regardless of
 * which field name is named. A `class_declaration`'s/`function_declaration`'s/`enum_entry`'s declared
 * name is instead the first direct named child typed `type_identifier` (a class/interface/enum name) or
 * `simple_identifier` (a function/enum-entry name) — found by type rather than by position, since an
 * optional leading `modifiers` node (wrapping `private`/`internal`/…) would otherwise sit at index 0
 * ahead of it. See `kotlinDeclaredName` in `extract.ts`, which this sentinel dispatches to.
 */
export const KOTLIN_NAME_FIELD = '@kotlin-name'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name is Swift-specific: a
 * `property_declaration`'s own `name` field points to a `pattern` node (`var x: Int`'s `x` sits behind
 * this wrapper, not bound to a field of `property_declaration` directly), and the actual declared
 * identifier is one level deeper still, bound to that `pattern` node's own `bound_identifier` field.
 * See `swiftPropertyName` in `extract.ts`, which this sentinel dispatches to instead of a flat
 * `childForFieldName` lookup. Verified against a real parse, not guessed.
 */
export const SWIFT_PROPERTY_NAME_FIELD = '@swift-property'

/**
 * Sentinel {@link DefinitionRule.nameField} value for a rule whose name is Swift-specific in a
 * different way: a `function_declaration`/`protocol_function_declaration` with an explicit return type
 * (`func add() -> Int`) binds *two* nodes to its own `name` field in this grammar build — the declared
 * identifier itself, and (a verified, unguessed quirk of this specific compiled grammar) its
 * `return_type` node as well — so `childrenForFieldName('name')` returns both, failing
 * `soleNamedField`'s "exactly one bound child" uniqueness check the same way Go's genuinely ambiguous
 * `const a, b = 1, 2` does, and silently dropping every such function from this package's graph. Unlike
 * that Go case, this is not a real multi-name ambiguity — the identifier always comes first in document
 * order — so `swiftFunctionName` in `extract.ts` uses `childForFieldName('name')` (first match) instead
 * of `soleNamedField`'s all-matches check.
 */
export const SWIFT_FUNCTION_NAME_FIELD = '@swift-function'

/** One tree-sitter node type recording a relative-import binding, per language family. */
export interface ImportRule {
  /** The tree-sitter node type anchoring one import statement, e.g. `import_statement`. */
  readonly statementType: string
}

/** One language grammar this package can load and extract from. */
export interface LanguageSpec {
  /** The seam's language label. See `LANGUAGES` in `dsh-plugin-codegraph-service`. */
  readonly language: string
  /** File extensions routed to this grammar, each including the leading dot. */
  readonly extensions: readonly string[]
  /** The `tree-sitter-wasms` package-relative wasm file this grammar loads from. */
  readonly wasmFile: string
  /** Definition rules tried in order for every named node the walk visits. */
  readonly definitions: readonly DefinitionRule[]
  /** Node types whose {@link callFunctionField} names the callee. */
  readonly callTypes: readonly string[]
  /** Field on a call node holding the callee expression, used for any {@link callTypes} member absent
   * from {@link callFunctionFieldByType}. */
  readonly callFunctionField: string
  /**
   * Present only when different {@link callTypes} members name their callee through different fields —
   * PHP's `member_call_expression` ($obj->method()) and `scoped_call_expression` (Class::method()) both
   * use `name`, while `function_call_expression` uses `function`; every other language's call types
   * (today, always exactly one) share a single field, so this is absent for all of them. Overrides
   * {@link callFunctionField} for the node types it lists.
   */
  readonly callFunctionFieldByType?: Readonly<Record<string, string>>
  /** Node types anchoring one import statement. */
  readonly importTypes: readonly string[]
  /**
   * Node types that bound a new function scope even when the walk never captures them as a named
   * definition — a callback (`arr.forEach(function(item) { ... })`) or an IIFE's `function_expression`
   * never matches a {@link DefinitionRule} (only a *named* declaration, or one assigned through a
   * captured `variable_declarator`, does), but a `const`/`var` inside its body is exactly the
   * function-local binding a `scopeRestricted` {@link DefinitionRule} exists to exclude. Empty for a language with
   * no anonymous-function shape that can contain a statement (Python's `lambda` body is a single
   * expression, never a block).
   */
  readonly bareFunctionScopeTypes: readonly string[]
}

/** Definitions common to every ECMAScript-family grammar (JavaScript, JSX, TypeScript, TSX). */
const ECMASCRIPT_DEFINITIONS: readonly DefinitionRule[] = [
  { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
  { nodeType: 'generator_function_declaration', kind: 'function', nameField: 'name' },
  { nodeType: 'method_definition', kind: 'method', nameField: 'name' },
  { nodeType: 'class_declaration', kind: 'class', nameField: 'name' },
  {
    nodeType: 'variable_declarator',
    kind: 'function',
    nameField: 'name',
    value: { field: 'value', types: ['arrow_function', 'function_expression', 'generator_function'] },
  },
  // Falls through from the function-valued rule above: any other simply-named `const`/`let`/`var`
  // binding (`lexical_declaration` and `variable_declaration` both wrap this same node type).
  // `nameNodeTypes` rejects a destructuring pattern (`const {a, b} = x`) rather than name it after its
  // pattern text — the same "don't guess a name" precedent `pythonBinding`/`ecmascriptImports` already
  // follow for shapes this package does not resolve.
  { nodeType: 'variable_declarator', kind: 'variable', nameField: 'name', nameNodeTypes: ['identifier'], scopeRestricted: true },
]

/** Definitions TypeScript and TSX add on top of {@link ECMASCRIPT_DEFINITIONS}. */
const TYPESCRIPT_DEFINITIONS: readonly DefinitionRule[] = [
  ...ECMASCRIPT_DEFINITIONS,
  { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name' },
  { nodeType: 'type_alias_declaration', kind: 'type_alias', nameField: 'name' },
  { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name' },
  // `enum Color { Red, Green = 5 }` — a bare member (`Red`) parses as a lone `property_identifier`
  // naming itself, tagged with `enum_body`'s own repeated `name` field; a valued member (`Green = 5`)
  // wraps its own `property_identifier` in a distinct `enum_assignment` node instead. Both verified
  // against a real parse, not guessed.
  { nodeType: 'property_identifier', kind: 'enum_member', nameField: SELF_NAME_FIELD, parentType: 'enum_body' },
  { nodeType: 'enum_assignment', kind: 'enum_member', nameField: 'name' },
  // The TypeScript/TSX grammars name a class field node differently from plain JavaScript's
  // `field_definition` (see JAVASCRIPT_DEFINITIONS) — verified against a real parse, not guessed.
  { nodeType: 'public_field_definition', kind: 'field', nameField: 'name', scopeRestricted: true },
]

/** Definitions JavaScript and JSX add on top of {@link ECMASCRIPT_DEFINITIONS}. */
const JAVASCRIPT_DEFINITIONS: readonly DefinitionRule[] = [
  ...ECMASCRIPT_DEFINITIONS,
  // The plain JavaScript grammar's class field node names its field-name field `property`, not `name`
  // as TypeScript's `public_field_definition` does (see TYPESCRIPT_DEFINITIONS) — verified against a
  // real parse, not guessed.
  { nodeType: 'field_definition', kind: 'field', nameField: 'property', scopeRestricted: true },
]

const ECMASCRIPT_CALL_TYPES = ['call_expression'] as const
const ECMASCRIPT_IMPORT_TYPES = ['import_statement'] as const
/** The ECMAScript function-value node types, matched against a real parse — see
 * {@link LanguageSpec.bareFunctionScopeTypes}. */
const ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES = ['function_expression', 'arrow_function', 'generator_function'] as const

/** Every grammar this package loads, keyed by the seam language label it produces. */
export const LANGUAGE_TABLE: readonly LanguageSpec[] = [
  {
    language: 'typescript',
    extensions: ['.ts', '.mts', '.cts'],
    wasmFile: 'tree-sitter-typescript.wasm',
    definitions: TYPESCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
    bareFunctionScopeTypes: ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES,
  },
  {
    language: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    definitions: TYPESCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
    bareFunctionScopeTypes: ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES,
  },
  {
    language: 'javascript',
    extensions: ['.js', '.mjs', '.cjs'],
    wasmFile: 'tree-sitter-javascript.wasm',
    definitions: JAVASCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
    bareFunctionScopeTypes: ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES,
  },
  {
    language: 'jsx',
    extensions: ['.jsx'],
    // The plain JavaScript grammar already parses JSX syntax; tree-sitter-wasms ships no separate
    // "jsx" binary, only distinct typescript/tsx binaries.
    wasmFile: 'tree-sitter-javascript.wasm',
    definitions: JAVASCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
    bareFunctionScopeTypes: ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES,
  },
  {
    language: 'python',
    extensions: ['.py', '.pyi'],
    wasmFile: 'tree-sitter-python.wasm',
    definitions: [
      { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
      { nodeType: 'class_definition', kind: 'class', nameField: 'name' },
      // Module- and class-level `x = ...`; `nameNodeTypes` rejects a tuple assignment (`a, b = 1, 2`,
      // `left` is a `pattern_list`) and an attribute target (`self.x = 1`, `left` is an `attribute`) —
      // verified against a real parse, not guessed.
      { nodeType: 'assignment', kind: 'variable', nameField: 'left', nameNodeTypes: ['identifier'], scopeRestricted: true },
    ],
    callTypes: ['call'],
    callFunctionField: 'function',
    importTypes: ['import_statement', 'import_from_statement'],
    bareFunctionScopeTypes: [],
  },
  {
    language: 'go',
    extensions: ['.go'],
    wasmFile: 'tree-sitter-go.wasm',
    definitions: [
      { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
      { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
      { nodeType: 'type_spec', kind: 'type_alias', nameField: 'name' },
      // Go allows `const a, b = 1, 2` — multiple names sharing one `const_spec`/`var_spec` node, each
      // tagged with the same `name` field. `matchDefinition`'s single-name-field requirement rejects
      // the multi-name form entirely rather than capture only the first — a partial, silently
      // misleading result would be worse than none, per this file's existing "don't guess" precedent.
      { nodeType: 'const_spec', kind: 'constant', nameField: 'name', scopeRestricted: true },
      { nodeType: 'var_spec', kind: 'variable', nameField: 'name', scopeRestricted: true },
      // A struct field (`field_declaration`) and an interface method signature (`method_spec`) both sit
      // inside a `type_spec`'s `struct_type`/`interface_type` body — `type_spec` itself (kind
      // `type_alias`) is not scope-restricted (a Go type can be declared inside a function, like `type
      // Local struct {...}` in `func f() {...}`), so these must not be either: a scope-restricted rule
      // here could never fire, since the enclosing `type_spec` always pushes `'other'` for its children
      // regardless of where it itself sits. An embedded (anonymous) field — `Nested` with no separate
      // name — has no child bound to the `name` field at all, so `matchDefinition`'s name-arity check
      // already excludes it without a dedicated rule; verified against a real parse, not guessed.
      { nodeType: 'field_declaration', kind: 'field', nameField: 'name' },
      { nodeType: 'method_spec', kind: 'method', nameField: 'name' },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['import_declaration'],
    // A closure literal (`f := func() { ... }`) is never itself named, so it never matches a
    // `DefinitionRule` — but a `var`/`const` inside its body is still function-local.
    bareFunctionScopeTypes: ['func_literal'],
  },
  {
    language: 'java',
    extensions: ['.java'],
    wasmFile: 'tree-sitter-java.wasm',
    definitions: [
      { nodeType: 'class_declaration', kind: 'class', nameField: 'name' },
      // A record has no dedicated seam kind — `class` is the closest existing fit for a concrete type
      // declaration with a body, and (like a class) it can `implements` an interface; see
      // `javaHeritage` in extract.ts.
      { nodeType: 'record_declaration', kind: 'class', nameField: 'name' },
      { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name' },
      { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name' },
      // Unlike TypeScript's bare `property_identifier` enum member (see TYPESCRIPT_DEFINITIONS),
      // Java's `enum_constant` already carries its own `name` field — verified against a real parse.
      { nodeType: 'enum_constant', kind: 'enum_member', nameField: 'name' },
      { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
      // No dedicated `constructor` seam kind exists; a constructor is a method in every way this
      // package's graph cares about.
      { nodeType: 'constructor_declaration', kind: 'method', nameField: 'name' },
      // A field (`field_declaration`) and a local variable (`local_variable_declaration`) both wrap one
      // or more `variable_declarator` children directly, each carrying its own `name` field — unlike
      // Go's `const_spec`/`var_spec`, a multi-name Java declaration (`int x = 1, y = 2;`) is not one
      // ambiguous shared name field but several independent `variable_declarator` nodes, each visited
      // (and named) on its own, so no `nameNodeTypes`-style rejection is needed here.
      { nodeType: 'variable_declarator', kind: 'field', nameField: 'name', parentType: 'field_declaration', scopeRestricted: true },
      { nodeType: 'variable_declarator', kind: 'variable', nameField: 'name', parentType: 'local_variable_declaration', scopeRestricted: true },
    ],
    callTypes: ['method_invocation'],
    // Unlike the ECMAScript/Go/Python call node's `function` field (an expression this package's
    // `calleeName` unwraps down to a simple name), Java's `method_invocation` already exposes the
    // callee's simple name directly through its own `name` field — the receiver, if any, is a sibling
    // `object` field extract.ts checks separately to tell a member call from a bare one. Verified
    // against a real parse, not guessed.
    callFunctionField: 'name',
    importTypes: ['import_declaration'],
    // A lambda body (`() -> { int x = 1; }`) is never itself named, so it never matches a
    // `DefinitionRule` — but a local variable inside its block body is still function-local, the same
    // reasoning `ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES` applies to an arrow function.
    bareFunctionScopeTypes: ['lambda_expression'],
  },
  {
    language: 'c',
    extensions: ['.c', '.h'],
    wasmFile: 'tree-sitter-c.wasm',
    definitions: [
      // No dedicated `union` seam kind exists; `struct` is the closest existing fit for a
      // concrete-layout aggregate type, matching Java's record→`class` precedent.
      { nodeType: 'struct_specifier', kind: 'struct', nameField: 'name' },
      { nodeType: 'union_specifier', kind: 'struct', nameField: 'name' },
      { nodeType: 'enum_specifier', kind: 'enum', nameField: 'name' },
      // `enumerator` carries its own `name` field directly, unlike TypeScript's bare enum member —
      // verified against a real parse, not guessed.
      { nodeType: 'enumerator', kind: 'enum_member', nameField: 'name' },
      // A typedef's `declarator` names the alias directly (`typedef struct Point PointT;`'s
      // `declarator` is the plain `type_identifier` "PointT", no wrapper) — unlike a function or
      // variable declarator, verified against a real parse, not guessed.
      { nodeType: 'type_definition', kind: 'type_alias', nameField: 'declarator' },
      // `function_definition`'s name sits behind a `pointer_declarator`/`function_declarator` chain of
      // arbitrary depth — see `DECLARATOR_NAME_FIELD`.
      { nodeType: 'function_definition', kind: 'function', nameField: DECLARATOR_NAME_FIELD },
      // A struct/union member (`field_declaration`) — same declarator-nesting rule as a top-level
      // variable, minus the multi-declarator ambiguity Go's `field_declaration` has none of either.
      { nodeType: 'field_declaration', kind: 'field', nameField: DECLARATOR_NAME_FIELD },
      // A top-level or function-local `int g = 1;`/`int x;` — both parse as `declaration`, distinguished
      // only by where the walk currently sits, the same convention JS/Python/Go's local-variable rules
      // already follow.
      { nodeType: 'declaration', kind: 'variable', nameField: DECLARATOR_NAME_FIELD, scopeRestricted: true },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['preproc_include'],
    bareFunctionScopeTypes: [],
  },
  {
    language: 'cpp',
    extensions: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'],
    wasmFile: 'tree-sitter-cpp.wasm',
    definitions: [
      { nodeType: 'class_specifier', kind: 'class', nameField: 'name' },
      { nodeType: 'struct_specifier', kind: 'struct', nameField: 'name' },
      { nodeType: 'union_specifier', kind: 'struct', nameField: 'name' },
      { nodeType: 'enum_specifier', kind: 'enum', nameField: 'name' },
      { nodeType: 'enumerator', kind: 'enum_member', nameField: 'name' },
      { nodeType: 'type_definition', kind: 'type_alias', nameField: 'declarator' },
      // A method (including a constructor/destructor) is a `function_definition` directly inside a
      // class/struct's `field_declaration_list` — the same node type a free function uses, so this rule
      // (tried first) must claim that shape before the unrestricted `function` rule below falls through
      // to everything else. Verified against a real parse, not guessed.
      { nodeType: 'function_definition', kind: 'method', nameField: DECLARATOR_NAME_FIELD, parentType: 'field_declaration_list' },
      { nodeType: 'function_definition', kind: 'function', nameField: DECLARATOR_NAME_FIELD },
      // `field_declaration` doubles as a pure-virtual method signature (`virtual void v() = 0;` is still
      // a `field_declaration`, just with a `function_declarator` for its `declarator`) — the same
      // function-valued guard `ECMASCRIPT_DEFINITIONS`'s `variable_declarator` rule uses, tried first.
      { nodeType: 'field_declaration', kind: 'method', nameField: DECLARATOR_NAME_FIELD, value: { field: 'declarator', types: ['function_declarator'] } },
      { nodeType: 'field_declaration', kind: 'field', nameField: DECLARATOR_NAME_FIELD },
      { nodeType: 'declaration', kind: 'variable', nameField: DECLARATOR_NAME_FIELD, scopeRestricted: true },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['preproc_include'],
    // A lambda body (`[](){ int x = 1; }`) is never itself named, so it never matches a `DefinitionRule`
    // — but a local variable inside its block body is still function-local.
    bareFunctionScopeTypes: ['lambda_expression'],
  },
  {
    language: 'csharp',
    extensions: ['.cs'],
    wasmFile: 'tree-sitter-c_sharp.wasm',
    definitions: [
      { nodeType: 'class_declaration', kind: 'class', nameField: 'name' },
      { nodeType: 'struct_declaration', kind: 'struct', nameField: 'name' },
      // No dedicated seam kind exists for a record; `class` is the closest existing fit, matching Java's
      // record→`class` precedent.
      { nodeType: 'record_declaration', kind: 'class', nameField: 'name' },
      { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name' },
      { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name' },
      { nodeType: 'enum_member_declaration', kind: 'enum_member', nameField: 'name' },
      { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
      // No dedicated `constructor` seam kind exists; both are a method in every way this package's graph
      // cares about, matching Java's constructor_declaration→`method` precedent.
      { nodeType: 'constructor_declaration', kind: 'method', nameField: 'name' },
      { nodeType: 'destructor_declaration', kind: 'method', nameField: 'name' },
      { nodeType: 'property_declaration', kind: 'property', nameField: 'name' },
      // A field (`variable_declarator` two levels under a `field_declaration`) and a local variable
      // (`variable_declarator` two levels under a `local_declaration_statement`) parse identically one
      // level up (`variable_declaration`) — only the grandparent tells them apart. See
      // `DefinitionRule.grandparentType`. Verified against a real parse, not guessed.
      { nodeType: 'variable_declarator', kind: 'field', nameField: FIRST_CHILD_NAME_FIELD, grandparentType: 'field_declaration', scopeRestricted: true },
      { nodeType: 'variable_declarator', kind: 'variable', nameField: FIRST_CHILD_NAME_FIELD, grandparentType: 'local_declaration_statement', scopeRestricted: true },
    ],
    callTypes: ['invocation_expression'],
    callFunctionField: 'function',
    importTypes: ['using_directive'],
    // A lambda body (`() => { int x = 1; }`) is never itself named, so it never matches a
    // `DefinitionRule` — but a local variable inside its block body is still function-local.
    bareFunctionScopeTypes: ['lambda_expression', 'anonymous_method_expression'],
  },
  {
    language: 'php',
    extensions: ['.php'],
    wasmFile: 'tree-sitter-php.wasm',
    definitions: [
      { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
      { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
      { nodeType: 'class_declaration', kind: 'class', nameField: 'name' },
      { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name' },
      { nodeType: 'trait_declaration', kind: 'trait', nameField: 'name' },
      { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name' },
      // `enum_case` carries its own `name` field directly, unlike TypeScript's bare enum member —
      // verified against a real parse, not guessed.
      { nodeType: 'enum_case', kind: 'enum_member', nameField: 'name' },
      // `const_element` (`const VERSION = "1"`) and `property_element` (`public string $name;`) neither
      // bind their name to a field of their own — see `PHP_ELEMENT_NAME_FIELD`. Unlike a JS/Go/Python
      // local binding, neither is `scopeRestricted`: a PHP `const`/property only legitimately appears at
      // namespace scope or directly inside a class/interface/trait/enum body, and every non-class body
      // here (`interface`/`trait`/`enum`) pushes `'other'` scope, not `'class'` — the same "must not be
      // scopeRestricted" reasoning Go's struct-field rule documents, since a restricted rule could never
      // fire inside one. The one shape this misses is already invalid PHP the grammar merely tolerates
      // (a `const`/property statement directly inside a function body), so capturing it there costs
      // nothing in practice.
      { nodeType: 'const_element', kind: 'constant', nameField: PHP_ELEMENT_NAME_FIELD },
      { nodeType: 'property_element', kind: 'field', nameField: PHP_ELEMENT_NAME_FIELD },
      // `$fn = function () {}` / `$fn = fn($a) => $a` — the same function-valued-binding rule
      // ECMASCRIPT_DEFINITIONS's `variable_declarator` follows, captured at any depth like a named
      // function declaration (not `scopeRestricted`) since a named closure is as much a workspace symbol
      // as one. Unlike ECMASCRIPT_DEFINITIONS, no bare-variable fallback rule follows it: PHP draws no
      // `const`/`let`-style distinction for `$x = 5;` — it is an unremarkable, ubiquitous assignment, and
      // capturing every one would flood `resolve.ts`'s cross-file name index with noise no caller wants.
      {
        nodeType: 'assignment_expression',
        kind: 'function',
        nameField: PHP_ELEMENT_NAME_FIELD,
        value: { field: 'right', types: ['anonymous_function_creation_expression', 'arrow_function'] },
      },
    ],
    callTypes: ['function_call_expression', 'member_call_expression', 'scoped_call_expression'],
    callFunctionField: 'function',
    // `member_call_expression` ($obj->method()) and `scoped_call_expression` (Class::method()) both name
    // their callee through a `name` field, not `function` — verified against a real parse, not guessed.
    callFunctionFieldByType: { member_call_expression: 'name', scoped_call_expression: 'name' },
    importTypes: ['namespace_use_declaration'],
    // A closure's block body (`function () { ... }`) can contain a statement, so it must flip scope like
    // JS's `function_expression`; an arrow function's body is always a single expression (like Python's
    // `lambda`, never a block), so it is omitted, matching that same precedent.
    bareFunctionScopeTypes: ['anonymous_function_creation_expression'],
  },
  {
    language: 'rust',
    extensions: ['.rs'],
    wasmFile: 'tree-sitter-rust.wasm',
    definitions: [
      { nodeType: 'struct_item', kind: 'struct', nameField: 'name' },
      // No dedicated `union` seam kind exists; `struct` is the closest existing fit, matching C/C++'s
      // same union→`struct` precedent — a Rust `union_item` shares `struct_item`'s exact body shape
      // (`field_declaration_list`), verified against a real parse.
      { nodeType: 'union_item', kind: 'struct', nameField: 'name' },
      { nodeType: 'enum_item', kind: 'enum', nameField: 'name' },
      // `enum_variant` carries its own `name` field directly, unlike TypeScript's bare enum member —
      // verified against a real parse, not guessed.
      { nodeType: 'enum_variant', kind: 'enum_member', nameField: 'name' },
      { nodeType: 'trait_item', kind: 'trait', nameField: 'name' },
      { nodeType: 'mod_item', kind: 'namespace', nameField: 'name' },
      { nodeType: 'type_item', kind: 'type_alias', nameField: 'name' },
      // A method — including a trait's default-body method — is a `function_item` directly inside an
      // `impl_item`'s or `trait_item`'s `declaration_list`, the same node type a free function uses;
      // mod's `declaration_list` shares that exact node type too, so only the grandparent (not the
      // immediate parent) tells a method apart from a module-level function. Tried first, before the
      // unrestricted `function` rule below falls through to everything else — the same precedent C++'s
      // method rule follows for its own shared `function_definition` node type. Verified against a real
      // parse, not guessed.
      { nodeType: 'function_item', kind: 'method', nameField: 'name', grandparentType: 'impl_item' },
      { nodeType: 'function_item', kind: 'method', nameField: 'name', grandparentType: 'trait_item' },
      { nodeType: 'function_item', kind: 'function', nameField: 'name' },
      // A trait method declared with no body (`fn area(&self) -> f64;`) parses as a distinct node type
      // from one with a body, and only ever appears directly inside a trait's `declaration_list` — an
      // `impl_item` must supply a body for every method it defines. Verified against a real parse.
      { nodeType: 'function_signature_item', kind: 'method', nameField: 'name', grandparentType: 'trait_item' },
      // A struct/union member — verified against a real parse, not guessed; unlike Go's/C++'s field
      // rule this needs no declarator-unwrapping helper, since `field_declaration` binds its name
      // directly to a `name` field.
      { nodeType: 'field_declaration', kind: 'field', nameField: 'name' },
      // A top-level, associated (inside `impl`/`trait`), or function-local `const`/`static` all parse
      // identically — `scopeRestricted` excludes only the function-local case, the same convention
      // Go's `const_spec`/`var_spec` already follow. No dedicated seam kind distinguishes a `static`
      // from a `const`; `static` maps to `variable` (it names a single mutable-or-shared storage
      // location, unlike a `const`'s compile-time-inlined value).
      { nodeType: 'const_item', kind: 'constant', nameField: 'name', scopeRestricted: true },
      { nodeType: 'static_item', kind: 'variable', nameField: 'name', scopeRestricted: true },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['use_declaration'],
    // A closure's body can be a block containing a statement (`|x| { let y = x; y }`) — unlike an
    // ECMAScript arrow function, a bare-expression closure body (`|x| x`) is indistinguishable by node
    // type alone (both are plain `closure_expression`), so this is not split into two cases; a
    // function-local binding inside a bare-expression body is impossible syntactically anyway (no
    // statement can appear there), so flipping scope unconditionally costs nothing. Verified against a
    // real parse, not guessed.
    bareFunctionScopeTypes: ['closure_expression'],
  },
  {
    language: 'ruby',
    extensions: ['.rb'],
    wasmFile: 'tree-sitter-ruby.wasm',
    definitions: [
      // Every `def` — top-level, module-level, or inside a class body — defines a method (a top-level
      // `def` becomes a private instance method of `Object`), so this package uses kind `method`
      // uniformly rather than split a `function`/`method` distinction the language itself does not
      // draw; `singleton_method` (`def self.foo`/`def Klass.foo`) is a class/singleton method, same
      // kind. Verified against a real parse, not guessed.
      { nodeType: 'method', kind: 'method', nameField: 'name' },
      { nodeType: 'singleton_method', kind: 'method', nameField: 'name' },
      { nodeType: 'class', kind: 'class', nameField: 'name' },
      // No dedicated `namespace` handling exists elsewhere but Rust's `mod_item`; a Ruby `module` is the
      // closest existing fit — both are a purely lexical/organizational container with no instance
      // semantics of their own, matching that same precedent.
      { nodeType: 'module', kind: 'namespace', nameField: 'name' },
      // `my_lambda = ->(x) { x + 1 }` — the only anonymous-function *literal* shape this grammar has;
      // `proc { ... }`/`Proc.new { ... }` parse as an ordinary `call` with a block argument, structurally
      // indistinguishable from any other block-taking method call, so they are not treated as a
      // function-valued binding — the same "don't guess" precedent this file already follows elsewhere.
      // Tried first, before the unrestricted `variable` rule below falls through to everything else —
      // the same precedent ECMASCRIPT_DEFINITIONS's `variable_declarator` rule follows.
      { nodeType: 'assignment', kind: 'function', nameField: 'left', nameNodeTypes: ['identifier'], value: { field: 'right', types: ['lambda'] } },
      // `CONST = 1` — a bare uppercase-leading `constant` node is Ruby's own real distinction (the
      // grammar itself lexes an uppercase-leading bare word as a distinct `constant` token, not merely an
      // `identifier`), so no `scopeRestricted` is needed: a dynamic constant assignment inside a method
      // body is a Ruby `SyntaxError`, the parser never produces this shape nested in one. Verified
      // against a real parse, not guessed.
      { nodeType: 'assignment', kind: 'constant', nameField: 'left', nameNodeTypes: ['constant'] },
      // A bare lowercase local variable assignment — `nameNodeTypes` rejects Ruby's other `assignment`
      // left-hand shapes (`left_assignment_list` for `a, b = 1, 2`, a `call` for `self.x = 1`, an
      // `element_reference` for `arr[0] = 1`), none of which name a single declared identifier, verified
      // against a real parse, not guessed. An instance variable (`@name = ...`) is deliberately not
      // captured at all — unlike every other language this package extracts a `field` kind from, Ruby has
      // no declarative field syntax; an instance variable is conventionally *assigned* inside `initialize`
      // (method-body scope), and this file's scope model has no way to mark that assignment a class-level
      // symbol without also flooding `resolve.ts`'s name index with every ordinary method-local variable —
      // the same "don't guess" precedent this file already follows for a shape it cannot cleanly resolve.
      { nodeType: 'assignment', kind: 'variable', nameField: 'left', nameNodeTypes: ['identifier'], scopeRestricted: true },
    ],
    // A bare, receiver-less, paren-less, arg-less method call (`other_call`) parses as a plain
    // `identifier` — syntactically identical to a local-variable read — so it is not (and cannot safely
    // be) captured as a call site; only a `call` node (a receiver, an argument list, or a block present)
    // is. Verified against a real parse, not guessed.
    callTypes: ['call'],
    callFunctionField: 'method',
    // Ruby's grammar has no dedicated import-statement node type at all — `require '...'` and
    // `require_relative '...'` are ordinary method calls (see `rubyRequireImport` in extract.ts, wired
    // through a dedicated dispatch branch the same way `commonJsRequireImport` is for CommonJS, rather
    // than through this table, which has no node type to name here).
    importTypes: [],
    // A `{ ... }`/`do ... end` block attached to a call, and a `->() { ... }` lambda's own block body
    // (itself a `block` node), can all contain a statement — a `var`/`local` inside one is still
    // block-local, not a workspace symbol, the same reasoning `ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES`
    // applies to a callback. Verified against a real parse, not guessed.
    bareFunctionScopeTypes: ['block', 'do_block', 'lambda'],
  },
  {
    language: 'zig',
    extensions: ['.zig'],
    wasmFile: 'tree-sitter-zig.wasm',
    definitions: [
      // A method is a `function_declaration` directly inside a struct/enum/union's own body — the same
      // node type a free function uses (Zig draws no separate node type the way most languages with a
      // dedicated method/function split do), so each container kind gets its own `parentType`-guarded
      // rule, tried before the unrestricted `function` rule below falls through to everything else — the
      // same precedent C++'s method rule follows for its own shared `function_definition` node type.
      // Verified against a real parse, not guessed.
      { nodeType: 'function_declaration', kind: 'method', nameField: 'name', parentType: 'struct_declaration' },
      { nodeType: 'function_declaration', kind: 'method', nameField: 'name', parentType: 'enum_declaration' },
      { nodeType: 'function_declaration', kind: 'method', nameField: 'name', parentType: 'union_declaration' },
      { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
      // An enum member and a struct/union member share the very same `container_field` node type —
      // unlike every other language's dedicated bare-enum-member shape, Zig draws no grammar-level
      // distinction at all, so this is the one `parentType` this file needs to split them back apart;
      // tried first, before the unrestricted `field` rule below falls through to a struct/union member.
      // Verified against a real parse, not guessed.
      { nodeType: 'container_field', kind: 'enum_member', nameField: 'name', parentType: 'enum_declaration' },
      { nodeType: 'container_field', kind: 'field', nameField: 'name' },
      // Zig has no dedicated struct/enum/union *statement* the way C/C++/Rust/Java do — a named
      // container type is always a plain `const`/`var` declaration whose value happens to be a
      // `struct_declaration`/`enum_declaration`/`union_declaration` literal (`const Point = struct {
      // ... };`), and this same node type is also how Zig spells an ordinary top-level constant, a
      // mutable global, *and* a std-library import (`const std = @import("std");`) — verified against a
      // real parse. `variable_declaration` binds neither its name nor its value to a field at all (both
      // are purely positional children, unlike every other grammar this package extracts a name from),
      // so this uses `FIRST_CHILD_NAME_FIELD` for the name; the reported `kind` (`struct`/`enum`/
      // `constant`/`variable`) is not fixed by this one static rule at all — `DefinitionRule.kind` has no
      // way to vary by a value's shape the way this needs, so `extractFile` computes it per node via
      // `zigDeclarationKind` instead (see there), and an `@import(...)` value is additionally recorded as
      // an import binding via `zigImportBinding`, the same "also captured as an ordinary variable"
      // precedent CommonJS's `require()` already sets. `scopeRestricted` applies uniformly to every kind
      // this rule can produce, including a locally-declared struct/enum/union — unlike a Rust `fn` nested
      // in another `fn` (still captured at any depth, since Rust's grammar gives a nested function its
      // own distinct, unambiguous node type), Zig's local type declaration shares its node type with an
      // ordinary local variable with no structural way to split the two without inspecting the value
      // first, and this file's `scopeRestricted` gate runs before that inspection — a local type
      // declaration inside a function is rare enough in idiomatic Zig that this file accepts missing it,
      // the same "prefer a clean uniform rule over a fiddly special case" precedent already guiding this
      // package's simpler choices elsewhere.
      { nodeType: 'variable_declaration', kind: 'variable', nameField: FIRST_CHILD_NAME_FIELD, scopeRestricted: true },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    // No dedicated import-statement node type exists — `@import(...)` is an ordinary builtin-function
    // call bound through the same `variable_declaration` shape the type/constant/variable rule above
    // already matches (see `zigImportBinding` in extract.ts), not a distinct node type this table could
    // name here.
    importTypes: [],
    // `test "name" { ... }` and `comptime { ... }` are Zig's own top-level block constructs — neither is
    // itself captured as a definition (matching this file's existing "block, not a symbol" treatment of
    // an anonymous callback), but a `const`/`var` directly inside either is still block-local, not a
    // workspace symbol, so both push `'other'` scope for their body the same way a callback's function
    // value does elsewhere in this file. Verified against a real parse, not guessed.
    bareFunctionScopeTypes: ['test_declaration', 'comptime_declaration'],
  },
  {
    language: 'kotlin',
    extensions: ['.kt', '.kts'],
    wasmFile: 'tree-sitter-kotlin.wasm',
    definitions: [
      // Kotlin's grammar gives `class`/`interface`/`enum class` the very same `class_declaration` node
      // type, distinguished only by a bare `interface`/`enum` keyword among its own children (`interface
      // Shape {}` carries a bare `interface` token, `enum class Color {}` carries both a bare `enum` and
      // a bare `class` token, a plain `class Foo {}` carries only `class`) — no rule here can vary `kind`
      // by a keyword the way this needs, so `extractFile` computes it via `kotlinClassKind` instead (see
      // there), the same "kind computed per node, not fixed per rule" precedent Zig's `variable_declaration`
      // entry already establishes above. Verified against a real parse, not guessed.
      { nodeType: 'class_declaration', kind: 'class', nameField: KOTLIN_NAME_FIELD },
      // A method is a `function_declaration` directly inside a `class_body` — the same node type a
      // top-level function uses (including one inside a `companion_object`'s own nested `class_body`,
      // still reported as a method of the enclosing type) — tried first, before the unrestricted
      // `function` rule below falls through to everything else. Verified against a real parse.
      { nodeType: 'function_declaration', kind: 'method', nameField: KOTLIN_NAME_FIELD, parentType: 'class_body' },
      { nodeType: 'function_declaration', kind: 'function', nameField: KOTLIN_NAME_FIELD },
      // An enum constant — verified against a real parse, not guessed; can only ever appear directly
      // inside an `enum_class_body`, so — like Go's/Rust's/Zig's own field rules — no
      // `scopeRestricted`/`parentType` guard is needed: the node type itself is unambiguous.
      { nodeType: 'enum_entry', kind: 'enum_member', nameField: KOTLIN_NAME_FIELD },
      // Deliberately no `field`/`property`/`variable`/`constant` kind at all: a `property_declaration`
      // (`val`/`var`, at class-member, top-level, or local scope) binds its declared name two levels
      // down, inside its own nested `variable_declaration` child, itself positioned after an optional
      // leading `modifiers` node the same way a captured declaration is — extracting it cleanly would
      // need its own multi-level, fully positional (there being no fields at all) navigation on top of
      // everything `KOTLIN_NAME_FIELD` already handles, and this file's "don't guess/don't overreach"
      // precedent (already applied to Lua's/Ruby's own locally-bound values) draws the line here instead.
    ],
    // `call_expression`'s callee is never bound to a field either — see `kotlinCallee` in extract.ts,
    // consulted directly by a dedicated dispatch branch in `extractFile` rather than through
    // `callFunctionField`, which (like every other field name) can never resolve anything for this
    // grammar. `function` is kept only as a placeholder so this table entry still type-checks as a
    // normal `LanguageSpec`; it is never actually read for Kotlin.
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['import_header'],
    // No anonymous-function-literal shape needs special-casing: a lambda's body is a `{ ... }` block
    // that can contain a statement, exactly like every captured `function_declaration`'s own body, but
    // this file already declines to capture any local `val`/`var` at all for Kotlin (see above), so
    // there is currently no scope-restricted rule this could matter to.
    bareFunctionScopeTypes: [],
  },
  {
    language: 'swift',
    extensions: ['.swift'],
    wasmFile: 'tree-sitter-swift.wasm',
    definitions: [
      // `struct`/`class`/`enum` all share this one node type, distinguished by a `declaration_kind`
      // field whose value node's own type is directly `struct`/`class`/`enum` (an unusual but verified
      // shape — no other grammar this package extracts from promotes a bare keyword to its own field
      // value this way) — no rule can vary `kind` by that field's value, so `extractFile` computes it
      // via `swiftDeclarationKind` instead, the same "kind computed per node" precedent Zig's
      // `variable_declaration`/Kotlin's `class_declaration` entries already establish above. A
      // `protocol` is Swift's own separate `protocol_declaration` node type instead — verified against a
      // real parse, not guessed.
      { nodeType: 'class_declaration', kind: 'class', nameField: 'name' },
      { nodeType: 'protocol_declaration', kind: 'interface', nameField: 'name' },
      // A method is a `function_declaration` directly inside a `class_body` — the same node type a
      // top-level function uses — tried first, before the unrestricted `function` rule below falls
      // through to everything else. A protocol's own method *signature* (`func area() -> Double`, no
      // body) is a distinct node type, `protocol_function_declaration`, always directly inside a
      // `protocol_body` — unambiguous, so no `parentType` guard is needed for it. Both use
      // `SWIFT_FUNCTION_NAME_FIELD`, not a plain `'name'` field, because either one with an explicit
      // return type binds two nodes to that field (see `SWIFT_FUNCTION_NAME_FIELD`'s own doc comment) —
      // verified against a real parse, not guessed.
      { nodeType: 'function_declaration', kind: 'method', nameField: SWIFT_FUNCTION_NAME_FIELD, parentType: 'class_body' },
      { nodeType: 'function_declaration', kind: 'function', nameField: SWIFT_FUNCTION_NAME_FIELD },
      { nodeType: 'protocol_function_declaration', kind: 'method', nameField: SWIFT_FUNCTION_NAME_FIELD },
      // An enum case — verified against a real parse, not guessed; can only ever appear directly inside
      // an `enum_class_body`, so — like every other language's own unambiguous member node type — no
      // `scopeRestricted`/`parentType` guard is needed.
      { nodeType: 'enum_entry', kind: 'enum_member', nameField: 'name' },
      // A struct/class stored property (`var x: Int`/`let x: Int` directly inside a `class_body`) —
      // `property_declaration` is also how Swift spells a top-level or function-local `var`/`let`
      // binding (the very same node type, see the fallback rule below), so this is tried first, guarded
      // to only the class-member shape; a property can never legitimately sit anywhere a
      // `scopeRestricted` gate would exclude it (a class/struct body is never treated as `'other'`
      // scope), so this rule itself needs no such gate either.
      { nodeType: 'property_declaration', kind: 'field', nameField: SWIFT_PROPERTY_NAME_FIELD, parentType: 'class_body' },
      // A top-level or function-local `var`/`let` binding — `DefinitionRule.kind` cannot vary by the
      // `value_binding_pattern` child's own keyword the way this needs, so `extractFile` computes
      // `constant`/`variable` via `swiftDeclarationKind` (the same function also reports `field` for the
      // rule above's match, since it inspects the node's actual parent rather than trusting which rule
      // fired — see there). `scopeRestricted` excludes a function-local binding, matching every other
      // language's own local-variable precedent.
      { nodeType: 'property_declaration', kind: 'variable', nameField: SWIFT_PROPERTY_NAME_FIELD, scopeRestricted: true },
    ],
    // `call_expression` binds no field for its callee at all (verified against a real parse) — see
    // `swiftCallee` in extract.ts, consulted directly by a dedicated dispatch branch in `extractFile`
    // rather than through `callFunctionField`, which can never resolve anything for this node type.
    // `target` is kept only as a placeholder so this table entry still type-checks as a normal
    // `LanguageSpec`; it is never actually read for Swift.
    callTypes: ['call_expression'],
    callFunctionField: 'target',
    importTypes: ['import_declaration'],
    // A closure literal (`{ (x: Int) -> Int in ... }`, e.g. a callback argument) is never itself
    // captured as a definition — but a `let`/`var` inside its body is still closure-local, not a
    // workspace symbol, the same reasoning `ECMASCRIPT_BARE_FUNCTION_SCOPE_TYPES` applies to a callback.
    // Verified against a real parse, not guessed.
    bareFunctionScopeTypes: ['lambda_literal'],
  },
]

/**
 * The grammar for a file extension, or `undefined` when this package indexes nothing for it.
 * @param extension - the file extension, including the leading dot, e.g. `.ts`.
 * @returns the matching language's extraction table entry, or `undefined`.
 */
export function languageFor(extension: string): LanguageSpec | undefined {
  return LANGUAGE_TABLE.find(spec => spec.extensions.includes(extension))
}
