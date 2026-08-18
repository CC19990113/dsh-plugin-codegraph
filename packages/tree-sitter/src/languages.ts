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
  /** Field on a call node holding the callee expression. */
  readonly callFunctionField: string
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
]

/**
 * The grammar for a file extension, or `undefined` when this package indexes nothing for it.
 * @param extension - the file extension, including the leading dot, e.g. `.ts`.
 * @returns the matching language's extraction table entry, or `undefined`.
 */
export function languageFor(extension: string): LanguageSpec | undefined {
  return LANGUAGE_TABLE.find(spec => spec.extensions.includes(extension))
}
