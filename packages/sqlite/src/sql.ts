/**
 * SQL fragments shared by the store's queries: the column projections the row mappers expect, the
 * ranking expressions that decide which declaration a bare symbol name means, and the escaping that
 * makes an arbitrary model-supplied string a safe FTS5 query.
 *
 * Ranking is expressed in SQL rather than in TypeScript so ordering and truncation happen in the
 * same statement: a `LIMIT` must keep the most relevant matches, which it can only do if the
 * database already knows the order.
 * @module dsh-plugin-codegraph-sqlite/sql
 */

/** Every `nodes` column {@link toNode} reads, aliased `n`. */
export const NODE_COLUMNS = [
  'n.id',
  'n.kind',
  'n.name',
  'n.qualified_name',
  'n.file_path',
  'n.language',
  'n.start_line',
  'n.end_line',
  'n.start_column',
  'n.end_column',
  'n.docstring',
  'n.signature',
  'n.visibility',
  'n.is_exported',
  'n.is_async',
  'n.is_static',
  'n.is_abstract',
  'n.decorators',
  'n.type_parameters',
  'n.updated_at',
].join(', ')

/**
 * Relevance among declarations that share a name. A bare name in a query means the thing that
 * declares behaviour, so callable and type declarations outrank the values and re-exports that
 * merely mention the same identifier: an `import { parse }` node must never win over the `parse`
 * function it imports, and a `file` node never wins at all.
 */
const KIND_RANK_CASE = `CASE n.kind
  WHEN 'function' THEN 0
  WHEN 'method' THEN 0
  WHEN 'class' THEN 1
  WHEN 'component' THEN 1
  WHEN 'struct' THEN 1
  WHEN 'interface' THEN 2
  WHEN 'trait' THEN 2
  WHEN 'protocol' THEN 2
  WHEN 'type_alias' THEN 3
  WHEN 'enum' THEN 3
  WHEN 'route' THEN 3
  WHEN 'constant' THEN 4
  WHEN 'variable' THEN 4
  WHEN 'property' THEN 5
  WHEN 'field' THEN 5
  WHEN 'enum_member' THEN 5
  WHEN 'parameter' THEN 6
  WHEN 'namespace' THEN 6
  WHEN 'module' THEN 6
  WHEN 'import' THEN 7
  WHEN 'export' THEN 7
  WHEN 'file' THEN 8
  ELSE 6
END`

/**
 * How exactly a candidate matched the requested symbol: a fully qualified name beats a
 * case-sensitive simple name, which beats a case-insensitive one. Binds the symbol three times.
 */
const SYMBOL_TIER_CASE = `CASE
  WHEN n.qualified_name = ? THEN 0
  WHEN n.name = ? THEN 1
  WHEN lower(n.name) = lower(?) THEN 2
  ELSE 3
END`

/**
 * How a candidate matched a free-text search: an exact name beats a case-insensitive one, which
 * beats a prefix, which beats any other match (a substring, or a documentation or signature hit).
 * Binds the query four times.
 */
const SEARCH_TIER_CASE = `CASE
  WHEN n.name = ? THEN 0
  WHEN lower(n.name) = lower(?) THEN 1
  WHEN lower(n.name) LIKE lower(?) || '%' THEN 2
  WHEN lower(n.qualified_name) LIKE '%' || lower(?) || '%' THEN 3
  ELSE 4
END`

/**
 * Order candidates for a symbol lookup: match exactness first, then declaration relevance, then
 * exported over internal, then file and line so equally ranked results never reorder between runs.
 * Binds the symbol three times, ahead of any other parameter in the statement.
 */
export const SYMBOL_ORDER = `${SYMBOL_TIER_CASE}, ${KIND_RANK_CASE}, n.is_exported DESC, n.file_path, n.start_line`

/** Order candidates for a free-text search. Binds the query four times. */
export const SEARCH_ORDER = `${SEARCH_TIER_CASE}, ${KIND_RANK_CASE}, n.is_exported DESC, n.file_path, n.start_line`

/**
 * Turn a model-supplied string into an FTS5 prefix query that cannot be misread as FTS syntax.
 * Doubling the quote characters and wrapping the whole value in quotes makes it one literal phrase,
 * so `AND`, `*`, `:` and parentheses in a symbol name search for themselves instead of changing the
 * query's meaning.
 * @param query - the raw search text.
 * @returns an FTS5 MATCH expression matching the text as a prefix phrase.
 */
export function ftsPhrase(query: string): string {
  return `"${query.replaceAll('"', '""')}"*`
}

/**
 * Wrap a raw string as a SQL `LIKE` pattern matching it anywhere, escaping the wildcard characters
 * so a symbol containing `%` or `_` matches literally.
 * @param query - the raw search text.
 * @returns the escaped pattern, for use with `LIKE ? ESCAPE '\\'`.
 */
export function likeAnywhere(query: string): string {
  const escaped = query.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')
  return `%${escaped.toLowerCase()}%`
}
