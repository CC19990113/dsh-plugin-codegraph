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
}

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
]

/** Definitions TypeScript and TSX add on top of {@link ECMASCRIPT_DEFINITIONS}. */
const TYPESCRIPT_DEFINITIONS: readonly DefinitionRule[] = [
  ...ECMASCRIPT_DEFINITIONS,
  { nodeType: 'interface_declaration', kind: 'interface', nameField: 'name' },
  { nodeType: 'type_alias_declaration', kind: 'type_alias', nameField: 'name' },
  { nodeType: 'enum_declaration', kind: 'enum', nameField: 'name' },
]

const ECMASCRIPT_CALL_TYPES = ['call_expression'] as const
const ECMASCRIPT_IMPORT_TYPES = ['import_statement'] as const

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
  },
  {
    language: 'tsx',
    extensions: ['.tsx'],
    wasmFile: 'tree-sitter-tsx.wasm',
    definitions: TYPESCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
  },
  {
    language: 'javascript',
    extensions: ['.js', '.mjs', '.cjs'],
    wasmFile: 'tree-sitter-javascript.wasm',
    definitions: ECMASCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
  },
  {
    language: 'jsx',
    extensions: ['.jsx'],
    // The plain JavaScript grammar already parses JSX syntax; tree-sitter-wasms ships no separate
    // "jsx" binary, only distinct typescript/tsx binaries.
    wasmFile: 'tree-sitter-javascript.wasm',
    definitions: ECMASCRIPT_DEFINITIONS,
    callTypes: ECMASCRIPT_CALL_TYPES,
    callFunctionField: 'function',
    importTypes: ECMASCRIPT_IMPORT_TYPES,
  },
  {
    language: 'python',
    extensions: ['.py', '.pyi'],
    wasmFile: 'tree-sitter-python.wasm',
    definitions: [
      { nodeType: 'function_definition', kind: 'function', nameField: 'name' },
      { nodeType: 'class_definition', kind: 'class', nameField: 'name' },
    ],
    callTypes: ['call'],
    callFunctionField: 'function',
    importTypes: ['import_statement', 'import_from_statement'],
  },
  {
    language: 'go',
    extensions: ['.go'],
    wasmFile: 'tree-sitter-go.wasm',
    definitions: [
      { nodeType: 'function_declaration', kind: 'function', nameField: 'name' },
      { nodeType: 'method_declaration', kind: 'method', nameField: 'name' },
      { nodeType: 'type_spec', kind: 'type_alias', nameField: 'name' },
    ],
    callTypes: ['call_expression'],
    callFunctionField: 'function',
    importTypes: ['import_declaration'],
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
