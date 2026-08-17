/**
 * The eight seam operations against one open graph database. Every function here is synchronous:
 * `node:sqlite` is a synchronous binding, so a query either completes within one turn or throws,
 * and the store's async surface exists for the seam's contract rather than for I/O interleaving.
 * @module dsh-plugin-codegraph-sqlite/queries
 */

import type { DatabaseSync } from 'node:sqlite'
import { CodegraphError } from 'dsh-plugin-codegraph-service'
import type {
  CodegraphCalleesRequest,
  CodegraphCallersRequest,
  CodegraphFilesRequest,
  CodegraphFilesResult,
  CodegraphImpactEntry,
  CodegraphImpactRequest,
  CodegraphImpactResult,
  CodegraphNode,
  CodegraphNodeId,
  CodegraphNodeRequest,
  CodegraphNodeResult,
  CodegraphRelation,
  CodegraphRelationsResult,
  CodegraphSearchRequest,
  CodegraphSearchResult,
  CodegraphStatusResult,
  CodegraphTraceHop,
  CodegraphTraceRequest,
  CodegraphTraceResult,
} from 'dsh-plugin-codegraph-service'
import { SUPPORTED_FORMAT_VERSION } from './database.ts'
import type { ImpactWalk, TraceWalk } from './traverse.ts'
import { toEdge, toFile, toNode } from './rows.ts'
import type { NodeRow } from './rows.ts'
import {
  NODE_COLUMNS,
  SEARCH_ORDER,
  SYMBOL_ORDER,
  ftsPhrase,
  likeAnywhere,
} from './sql.ts'

/** Run a statement and return its rows already typed as raw records. */
function rows(db: DatabaseSync, sql: string, ...params: unknown[]): NodeRow[] {
  return db.prepare(sql).all(...params as never[])
}

/**
 * Read a single-column aggregate as a number. Every caller passes an aggregate, which always yields
 * exactly one row and one column; `MAX` over an empty table yields SQL NULL, which reads as 0.
 */
function scalar(db: DatabaseSync, sql: string, ...params: unknown[]): number {
  const [value] = Object.values(db.prepare(sql).get(...params as never[]) as Record<string, unknown>)
  return typeof value === 'number' ? value : 0
}

/**
 * Candidate declarations for a symbol name, most relevant first.
 * @param db - the open graph connection.
 * @param symbol - the simple or qualified name to resolve.
 * @param limit - largest number of candidates to read.
 * @returns the matching nodes in relevance order; empty when the name matches nothing.
 */
function resolveSymbol(db: DatabaseSync, symbol: string, limit: number): CodegraphNode[] {
  return rows(
    db,
    `SELECT ${NODE_COLUMNS} FROM nodes n
      WHERE n.qualified_name = ? OR n.name = ? OR lower(n.name) = lower(?)
      ORDER BY ${SYMBOL_ORDER}
      LIMIT ?`,
    symbol, symbol, symbol,
    symbol, symbol, symbol,
    limit,
  ).map(toNode)
}

/**
 * Find declarations matching a free-text query.
 * @param db - the open graph connection.
 * @param request - the search query with its resolved bounds.
 * @returns the matching declarations, most relevant first, with the pre-limit total.
 */
export function search(db: DatabaseSync, request: CodegraphSearchRequest): CodegraphSearchResult {
  const like = likeAnywhere(request.query)
  const kind = request.kind ?? null
  const language = request.language ?? null
  const candidates = `
    FROM nodes n
    JOIN (
      SELECT rowid AS rid FROM nodes WHERE lower(name) LIKE ? ESCAPE '\\' OR lower(qualified_name) LIKE ? ESCAPE '\\'
      UNION
      SELECT rowid FROM nodes_fts WHERE nodes_fts MATCH ?
    ) m ON m.rid = n.rowid
    WHERE (? IS NULL OR n.kind = ?) AND (? IS NULL OR n.language = ?)`
  const filters = [like, like, ftsPhrase(request.query), kind, kind, language, language]
  const total = scalar(db, `SELECT count(*) AS total ${candidates}`, ...filters)
  const matches = rows(
    db,
    `SELECT ${NODE_COLUMNS} ${candidates} ORDER BY ${SEARCH_ORDER} LIMIT ?`,
    ...filters,
    request.query, request.query, request.query, request.query,
    request.limit,
  ).map(toNode)
  return { kind: 'search', nodes: matches, total, truncated: total > matches.length }
}

/** Read every edge on one side of a node, with the node at the far end. */
function relationsOf(
  db: DatabaseSync,
  id: CodegraphNodeId,
  direction: 'incoming' | 'outgoing',
  edgeKind: string | null,
  limit: number,
): { relations: CodegraphRelation[]; total: number } {
  const anchor = direction === 'incoming' ? 'target' : 'source'
  const far = direction === 'incoming' ? 'source' : 'target'
  const where = `WHERE e.${anchor} = ? AND (? IS NULL OR e.kind = ?)`
  // Grouping by the far node AND the edge kind is what makes a relation distinct: five calls from
  // one function collapse to one relation, while a node that both calls and contains another stays
  // two, because those are different facts about the pair.
  const grouping = `GROUP BY e.${far}, e.kind`
  const total = scalar(
    db,
    `SELECT count(*) AS total FROM (SELECT 1 FROM edges e ${where} ${grouping})`,
    id, edgeKind, edgeKind,
  )
  const relations = rows(
    db,
    // MIN(e.line) both picks the earliest site and, per SQLite's bare-column rule for a query with a
    // single MIN aggregate, makes every other `e.` column come from that same earliest row.
    `SELECT ${NODE_COLUMNS}, e.source AS edge_source, e.target AS edge_target, e.kind AS edge_kind,
            MIN(e.line) AS edge_line, e.col AS edge_col, e.provenance AS edge_provenance,
            count(*) AS site_count
       FROM edges e
       JOIN nodes n ON n.id = e.${far}
       ${where}
       ${grouping}
       ORDER BY n.file_path, MIN(e.line), n.start_line
       LIMIT ?`,
    id, edgeKind, edgeKind, limit,
  ).map(row => ({
    node: toNode(row),
    edge: toEdge(row),
    siteCount: Number(row['site_count']),
  }))
  return { relations, total }
}

/**
 * Resolve one symbol and read its immediate neighbourhood.
 * @param db - the open graph connection.
 * @param request - the node query with its resolved bounds.
 * @returns the resolved declaration with its one-hop relations, or a null subject when the name
 * matches nothing.
 */
export function node(db: DatabaseSync, request: CodegraphNodeRequest): CodegraphNodeResult {
  // One extra candidate beyond the reported alternatives distinguishes "exactly this many" from
  // "at least this many" without a second count query.
  const candidates = resolveSymbol(db, request.symbol, request.limit + 1)
  const best = candidates[0]
  if (best === undefined) {
    return { kind: 'node', node: null, incoming: [], outgoing: [], alternatives: [] }
  }
  return {
    kind: 'node',
    node: best,
    incoming: relationsOf(db, best.id, 'incoming', null, request.limit).relations,
    outgoing: relationsOf(db, best.id, 'outgoing', null, request.limit).relations,
    alternatives: candidates.slice(1),
  }
}

/**
 * Find the declarations that call, or are called by, one symbol.
 * @param db - the open graph connection.
 * @param request - the callers or callees query; its operation picks the direction walked.
 * @returns the distinct related declarations with their earliest call sites and repeat counts.
 */
export function relations(
  db: DatabaseSync,
  request: CodegraphCallersRequest | CodegraphCalleesRequest,
): CodegraphRelationsResult {
  const kind = request.operation === 'callers' ? 'callers' as const : 'callees' as const
  const subject = resolveSymbol(db, request.symbol, 1)[0]
  if (subject === undefined) {
    return { kind, subject: null, relations: [], total: 0, truncated: false }
  }
  const direction = request.operation === 'callers' ? 'incoming' as const : 'outgoing' as const
  const found = relationsOf(db, subject.id, direction, 'calls', request.limit)
  return {
    kind,
    subject,
    relations: found.relations,
    total: found.total,
    truncated: found.total > found.relations.length,
  }
}

/** Read many nodes by id, preserving the caller's order. */
function nodesByIds(db: DatabaseSync, ids: readonly CodegraphNodeId[]): Map<string, CodegraphNode> {
  if (ids.length === 0) return new Map()
  const found = rows(
    db,
    `SELECT ${NODE_COLUMNS} FROM nodes n WHERE n.id IN (${new Array(ids.length).fill('?').join(', ')})`,
    ...ids,
  ).map(toNode)
  return new Map(found.map(entry => [entry.id, entry]))
}

/**
 * Walk dependents transitively.
 * @param db - the open graph connection.
 * @param request - the impact query.
 * @param walk - the reverse-reachability walk, injected so the traversal budget stays with the
 * plugin that configures it.
 * @returns the affected declarations, nearest first.
 */
export function impact(
  db: DatabaseSync,
  request: CodegraphImpactRequest,
  walk: ImpactWalk,
): CodegraphImpactResult {
  const subject = resolveSymbol(db, request.symbol, 1)[0]
  if (subject === undefined) {
    return { kind: 'impact', subject: null, entries: [], total: 0, truncated: false }
  }
  const { hits, exhausted } = walk(subject.id, request.depth)
  const kept = hits.slice(0, request.limit)
  const byId = nodesByIds(db, kept.map(hit => hit.node))
  const entries: CodegraphImpactEntry[] = []
  for (const hit of kept) {
    const affected = byId.get(hit.node)
    // An edge whose endpoint row is gone is a dangling reference in someone else's index, not a
    // reason to fail the whole query; the counts below still report what the walk reached.
    if (affected === undefined) continue
    entries.push({ node: affected, distance: hit.distance, via: hit.via })
  }
  return {
    kind: 'impact',
    subject,
    entries,
    total: hits.length,
    truncated: exhausted || hits.length > entries.length,
  }
}

/**
 * Find shortest directed paths between two symbols.
 * @param db - the open graph connection.
 * @param request - the trace query.
 * @param walk - the shortest-path sweep, injected so the traversal budget stays with the plugin that
 * configures it.
 * @returns the paths, each as ordered hops from origin to destination.
 */
export function trace(
  db: DatabaseSync,
  request: CodegraphTraceRequest,
  walk: TraceWalk,
): CodegraphTraceResult {
  const from = resolveSymbol(db, request.from, 1)[0]
  const to = resolveSymbol(db, request.to, 1)[0]
  if (from === undefined || to === undefined) {
    return { kind: 'trace', from: from ?? null, to: to ?? null, paths: [] }
  }
  const walked = walk(from.id, to.id, request.maxDepth, request.maxPaths)
  const reached = [...new Set(walked.flatMap(path => path.map(step => step.node)))] as CodegraphNodeId[]
  const byId = nodesByIds(db, reached)
  const paths: (readonly CodegraphTraceHop[])[] = []
  for (const path of walked) {
    const hops: CodegraphTraceHop[] = [{ node: from }]
    let complete = true
    for (const step of path) {
      const reachedNode = byId.get(step.node)
      if (reachedNode === undefined) {
        complete = false
        break
      }
      hops.push({ node: reachedNode, edge: { ...step.edge } })
    }
    // A path through a dangling endpoint cannot be rendered honestly, so it is dropped rather than
    // reported with a hole in it; other paths in the same answer remain valid.
    if (complete) paths.push(hops)
  }
  return { kind: 'trace', from, to, paths }
}

/**
 * List indexed files under an optional subtree and glob.
 * @param db - the open graph connection.
 * @param request - the files query with its resolved bounds.
 * @returns the matching files ordered by path, with the pre-limit total.
 */
export function files(db: DatabaseSync, request: CodegraphFilesRequest): CodegraphFilesResult {
  const prefix = request.path === undefined ? null : `${request.path.replace(/\/+$/, '')}/%`
  const pattern = request.pattern ?? null
  const where = 'WHERE (? IS NULL OR path LIKE ?) AND (? IS NULL OR path GLOB ?)'
  const filters = [prefix, prefix, pattern, pattern]
  const total = scalar(db, `SELECT count(*) AS total FROM files ${where}`, ...filters)
  const found = rows(
    db,
    `SELECT path, language, size, node_count, modified_at, indexed_at FROM files ${where} ORDER BY path LIMIT ?`,
    ...filters,
    request.limit,
  ).map(toFile)
  return { kind: 'files', files: found, total, truncated: total > found.length }
}

/**
 * Report index size, language coverage, and freshness.
 * @param db - the open graph connection.
 * @param projectRoot - the project root the result echoes back, since the graph does not record it.
 * @returns the index summary.
 */
export function status(db: DatabaseSync, projectRoot: string): CodegraphStatusResult {
  const languages = rows(
    db,
    'SELECT language, count(*) AS file_count FROM files GROUP BY language ORDER BY file_count DESC, language',
  ).map((row) => {
    // Only `language` is durable data worth checking; the count beside it is computed by SQLite
    // in this very statement, so it is numeric by construction.
    const language = row['language']
    if (typeof language !== 'string') {
      throw new CodegraphError('the code graph has a malformed language summary', 'CODEGRAPH_MALFORMED_INDEX')
    }
    return { language, fileCount: Number(row['file_count']) }
  })
  const indexedAt = scalar(db, 'SELECT MAX(indexed_at) AS indexed_at FROM files')
  return {
    kind: 'status',
    projectRoot,
    fileCount: scalar(db, 'SELECT count(*) AS c FROM files'),
    nodeCount: scalar(db, 'SELECT count(*) AS c FROM nodes'),
    edgeCount: scalar(db, 'SELECT count(*) AS c FROM edges'),
    languages,
    formatVersion: SUPPORTED_FORMAT_VERSION,
    indexedAt: indexedAt === 0 ? null : indexedAt,
  }
}
