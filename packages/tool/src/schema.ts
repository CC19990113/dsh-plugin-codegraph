/**
 * The `codegraph` tool's model-facing schemas: the parameter spec the model fills in and the
 * canonical output union each operation returns.
 *
 * The output is a closed `oneOf` keyed on `operation`, not one loose object with every field
 * optional, so a Code Mode program that switches on `operation` gets exactly the fields that
 * operation produces and nothing it must test for. Members are built from shared field groups
 * because ten hand-written copies of a symbol projection would drift apart.
 * @module dsh-plugin-codegraph-tool/schema
 */

import type { InferArgs, InferValue } from '@deepseek-ai/dsh-tools'

/**
 * Operations the primary `codegraph` tool accepts. The first eight map to a seam query; the last two
 * compose. `index` is deliberately absent: it runs through the dedicated `codegraph_index` tool, which
 * carries its own (much larger) timeout budget instead of this tool's query-sized one.
 */
const QUERY_OPERATIONS = [
  'search',
  'node',
  'callers',
  'callees',
  'impact',
  'trace',
  'files',
  'status',
  'explore',
  'context',
] as const

/** Every operation the tool family exposes, across both the query tool and the dedicated index tool. */
export const CODEGRAPH_OPERATIONS = [...QUERY_OPERATIONS, 'index'] as const

/** One operation name. */
export type CodegraphToolOperation = (typeof CODEGRAPH_OPERATIONS)[number]

/** The model-facing projection of one declaration. */
const SYMBOL = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string', required: true },
    qualified_name: { type: 'string', required: true },
    kind: { type: 'string', required: true },
    path: { type: 'string', required: true },
    line: { type: 'integer', required: true },
    end_line: { type: 'integer', required: true },
    language: { type: 'string', required: true },
    exported: { type: 'boolean', required: true },
    signature: { type: 'string' },
    docstring: { type: 'string' },
  },
} as const

/** A symbol reached through an edge, carrying how it was reached. */
const RELATION = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SYMBOL.properties,
    via: { type: 'string', required: true },
    site_line: { type: 'integer' },
    site_count: { type: 'integer', required: true },
  },
} as const

/** A symbol reached by a transitive walk. */
const AFFECTED = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SYMBOL.properties,
    via: { type: 'string', required: true },
    distance: { type: 'integer', required: true },
  },
} as const

/** One hop of a traced path; the first hop of a path carries no `via`. */
const HOP = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ...SYMBOL.properties,
    via: { type: 'string' },
    site_line: { type: 'integer' },
  },
} as const

/** One indexed file. */
const FILE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    language: { type: 'string', required: true },
    size: { type: 'integer', required: true },
    symbol_count: { type: 'integer', required: true },
  },
} as const

/** One file's declarations plus the source text backing them. */
const EXPLORED_FILE = {
  type: 'object',
  additionalProperties: false,
  properties: {
    path: { type: 'string', required: true },
    symbols: { type: 'array', required: true, items: SYMBOL },
    code: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
    code_start_line: { type: 'integer' },
    truncated: { type: 'boolean', required: true },
  },
} as const

/** A nullable symbol: the honest answer when a requested name matches no declaration. */
const MAYBE_SYMBOL = { required: true, oneOf: [{ type: 'null' }, SYMBOL] } as const

/** One language's share of an indexed or newly-indexed workspace. Shared by `status` and `index`. */
const LANGUAGE_COUNT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    language: { type: 'string', required: true },
    file_count: { type: 'integer', required: true },
  },
} as const

/** Bounds every truncatable member reports, so a capped answer is never read as a complete one. */
const COUNTS = {
  total: { type: 'integer', required: true },
  truncated: { type: 'boolean', required: true },
} as const

/**
 * Build one `oneOf` member for a fixed operation name.
 *
 * Both type parameters are `const` so the member keeps its literal types: without them the helper
 * would widen `operation` to the whole union and erase each member's own fields, and `InferValue`
 * would produce one shapeless object instead of a discriminated union.
 * @param operation - the literal `operation` value discriminating this member.
 * @param properties - the fields this operation returns beyond the shared two.
 * @returns the member's value schema.
 */
function member<const O extends CodegraphToolOperation, const P extends Record<string, unknown>>(
  operation: O,
  properties: P,
) {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      operation: { type: 'string', required: true, const: operation },
      project_path: { type: 'string', required: true },
      ...properties,
    },
  } as const
}

/** The canonical value every `codegraph` call returns, discriminated by `operation`. */
export const CODEGRAPH_OUTPUT_SCHEMA = {
  oneOf: [
    member('search', {
      symbols: { type: 'array', required: true, items: SYMBOL },
      ...COUNTS,
    }),
    member('node', {
      symbol: MAYBE_SYMBOL,
      incoming: { type: 'array', required: true, items: RELATION },
      outgoing: { type: 'array', required: true, items: RELATION },
      alternatives: { type: 'array', required: true, items: SYMBOL },
      code: { required: true, oneOf: [{ type: 'null' }, { type: 'string' }] },
    }),
    member('callers', {
      symbol: MAYBE_SYMBOL,
      relations: { type: 'array', required: true, items: RELATION },
      ...COUNTS,
    }),
    member('callees', {
      symbol: MAYBE_SYMBOL,
      relations: { type: 'array', required: true, items: RELATION },
      ...COUNTS,
    }),
    member('impact', {
      symbol: MAYBE_SYMBOL,
      affected: { type: 'array', required: true, items: AFFECTED },
      ...COUNTS,
    }),
    member('trace', {
      from: MAYBE_SYMBOL,
      to: MAYBE_SYMBOL,
      paths: { type: 'array', required: true, items: { type: 'array', items: HOP } },
    }),
    member('files', {
      files: { type: 'array', required: true, items: FILE },
      ...COUNTS,
    }),
    member('status', {
      // Only `indexed` is required: when no store claims the root, none of the other fields have an
      // honest value to report, and the tool answers `{ indexed: false }` rather than failing.
      indexed: { type: 'boolean', required: true },
      file_count: { type: 'integer' },
      symbol_count: { type: 'integer' },
      edge_count: { type: 'integer' },
      format_version: { type: 'integer' },
      indexed_at: { oneOf: [{ type: 'null' }, { type: 'integer' }] },
      languages: { type: 'array', items: LANGUAGE_COUNT },
      stale_file_count: { type: 'integer' },
      stale_file_count_truncated: { type: 'boolean' },
    }),
    member('explore', {
      files: { type: 'array', required: true, items: EXPLORED_FILE },
      ...COUNTS,
    }),
    member('context', {
      task: { type: 'string', required: true },
      entry_points: { type: 'array', required: true, items: SYMBOL },
      related: { type: 'array', required: true, items: RELATION },
      files: { type: 'array', required: true, items: EXPLORED_FILE },
    }),
    member('index', {
      files_indexed: { type: 'integer', required: true },
      files_skipped: { type: 'integer', required: true },
      symbol_count: { type: 'integer', required: true },
      edge_count: { type: 'integer', required: true },
      unresolved_count: { type: 'integer', required: true },
      unresolved_likely_internal_count: { type: 'integer', required: true },
      languages: { type: 'array', required: true, items: LANGUAGE_COUNT },
    }),
  ],
} as const

/** The parameters the model fills in. Which ones apply depends on `operation`. */
export const CODEGRAPH_PARAMETERS = {
  operation: {
    type: 'string',
    required: true,
    enum: [...QUERY_OPERATIONS],
    description:
      'search (find declarations by name), node (one symbol with its callers and callees), callers, callees, impact (what a change reaches), trace (call path from one symbol to another), files (indexed file list), status (index size and freshness), explore (several related symbols with their source), context (everything relevant to a task). To build or refresh the index itself, call the codegraph_index tool instead.',
  },
  symbol: {
    type: 'string',
    description: 'The symbol name for node, callers, callees, and impact. Simple or qualified.',
  },
  query: {
    type: 'string',
    description: 'The search text for search and explore. Matches names, qualified names, signatures, and documentation.',
  },
  task: {
    type: 'string',
    description: 'The task, bug, or feature to gather context for. Required by context.',
  },
  from: { type: 'string', description: 'The symbol a traced flow starts at. Required by trace.' },
  to: { type: 'string', description: 'The symbol a traced flow should reach. Required by trace.' },
  path: { type: 'string', description: 'Restrict files to this directory, relative to the project root.' },
  pattern: { type: 'string', description: 'Restrict files to paths matching this glob, e.g. src/pages/*.tsx.' },
  kind: { type: 'string', description: 'Restrict search to one declaration kind, e.g. function, class, interface.' },
  language: { type: 'string', description: 'Restrict search to one language, e.g. typescript, python, go.' },
  limit: { type: 'number', description: 'Largest number of results to return.' },
  depth: { type: 'number', description: 'Hops to traverse for impact and trace.' },
  include_code: { type: 'boolean', description: 'Include source text for node. explore and context always include it.' },
  project_path: {
    type: 'string',
    description: 'Absolute path of another indexed project to query. Defaults to this session\'s workspace.',
  },
} as const

/**
 * The parameters the dedicated `codegraph_index` tool takes: only the project to (re)index. It
 * needs no `operation` — building the index is the only thing this tool does — and none of the
 * query-side fields (`symbol`, `query`, `limit`, …), which an index run has no use for.
 */
export const CODEGRAPH_INDEX_PARAMETERS = {
  project_path: {
    type: 'string',
    description: 'Absolute path of the project to index. Defaults to this session\'s workspace.',
  },
} as const

/** The canonical value, inferred from {@link CODEGRAPH_OUTPUT_SCHEMA} so the two cannot drift. */
export type CodegraphToolValue = InferValue<typeof CODEGRAPH_OUTPUT_SCHEMA>

/** The validated arguments, inferred from {@link CODEGRAPH_PARAMETERS}. */
export type CodegraphToolArgs = InferArgs<typeof CODEGRAPH_PARAMETERS>

/** The validated arguments, inferred from {@link CODEGRAPH_INDEX_PARAMETERS}. */
export type CodegraphIndexToolArgs = InferArgs<typeof CODEGRAPH_INDEX_PARAMETERS>

/** The canonical value for one operation. */
export type CodegraphValueFor<O extends CodegraphToolOperation> =
  Extract<CodegraphToolValue, { operation: O }>
