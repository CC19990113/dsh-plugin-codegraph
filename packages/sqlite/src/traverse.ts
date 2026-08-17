/**
 * Graph walks over the `edges` table: the reverse reachability that answers `impact` and the
 * shortest-path enumeration that answers `trace`.
 *
 * Both walks are breadth-first and bounded by a visit budget, because a request's `depth`, `limit`,
 * and `maxPaths` bound the ANSWER while the graph decides the WORK — an unbounded walk on a large
 * monorepo would run long before it had anything to truncate.
 * @module dsh-plugin-codegraph-sqlite/traverse
 */

import type { DatabaseSync } from 'node:sqlite'
import type { CodegraphNodeId } from 'dsh-plugin-codegraph-service'

/**
 * The relationships that carry dependency for `impact`. `contains` is deliberately absent: a
 * declaration's container is its file, so following it in reverse would mark every sibling in the
 * file as affected by any change, which reports a whole directory as impacted by a one-line edit.
 */
const IMPACT_EDGE_KINDS = [
  'calls',
  'references',
  'instantiates',
  'imports',
  'extends',
  'implements',
  'overrides',
  'type_of',
  'returns',
  'decorates',
] as const

/**
 * The relationships a `trace` path may follow. `contains` IS present here, unlike in impact: a call
 * made at a module's top level is recorded with the file node as its source, so descending from a
 * file into its declarations is how a path crosses a module boundary at all.
 */
const TRACE_EDGE_KINDS = [
  'calls',
  'contains',
  'references',
  'instantiates',
] as const

/** One traversal step: the node reached and the edge that reached it. */
export interface Step {
  /** The node this step reaches. */
  readonly node: CodegraphNodeId
  /** The edge traversed, as its endpoint ids, kind, and site. */
  readonly edge: {
    readonly source: CodegraphNodeId
    readonly target: CodegraphNodeId
    readonly kind: string
    readonly line?: number
    readonly column?: number
  }
}

/** One node reached by {@link walkImpact}, with how far and by what relationship. */
export interface ImpactHit {
  /** The affected node. */
  readonly node: CodegraphNodeId
  /** Hops from the origin; `1` is a direct dependent. */
  readonly distance: number
  /** The relationship kind on the shortest walk that reached it. */
  readonly via: string
}

/**
 * The reverse-reachability walk as `impact` receives it. Injected rather than called directly so the
 * traversal budget stays with the plugin that configures it.
 */
export type ImpactWalk = (origin: CodegraphNodeId, depth: number) => {
  hits: ImpactHit[]
  exhausted: boolean
}

/** The shortest-path sweep as `trace` receives it, injected for the same reason. */
export type TraceWalk = (
  from: CodegraphNodeId,
  to: CodegraphNodeId,
  maxDepth: number,
  maxPaths: number,
) => Step[][]

/**
 * The recorded arrivals at one node, creating the empty list on first sight.
 *
 * Reading and writing through one accessor keeps the sweep and the backtrack from disagreeing about
 * whether a node absent from the map means "not reached yet" or "reached with no incoming edge".
 * @param arrivals - the per-node arrival lists.
 * @param node - the node whose arrivals are wanted.
 * @returns the node's arrival list, owned by the map.
 */
function arrivalsAt(arrivals: Map<string, Step[]>, node: CodegraphNodeId): Step[] {
  const existing = arrivals.get(node)
  if (existing !== undefined) return existing
  const created: Step[] = []
  arrivals.set(node, created)
  return created
}

/** A `?`-placeholder list for binding an array of values. */
function placeholders(count: number): string {
  return new Array(count).fill('?').join(', ')
}

/**
 * Read one hop of neighbours.
 * @param db - the open graph connection.
 * @param ids - the frontier's node ids.
 * @param kinds - the edge kinds to follow.
 * @param reverse - true to follow edges backwards (find dependents), false to follow them forwards.
 * @returns each neighbour reached, with the edge that reached it.
 */
function neighbours(
  db: DatabaseSync,
  ids: readonly CodegraphNodeId[],
  kinds: readonly string[],
  reverse: boolean,
): Step[] {
  const from = reverse ? 'target' : 'source'
  const to = reverse ? 'source' : 'target'
  const rows = db.prepare(
    `SELECT e.source, e.target, e.kind, e.line, e.col FROM edges e
      WHERE e.${from} IN (${placeholders(ids.length)})
        AND e.kind IN (${placeholders(kinds.length)})`,
  ).all(...ids, ...kinds) as Record<string, unknown>[]
  return rows.map(row => ({
    node: row[to] as CodegraphNodeId,
    edge: {
      source: row['source'] as CodegraphNodeId,
      target: row['target'] as CodegraphNodeId,
      kind: row['kind'] as string,
      ...typeof row['line'] === 'number' ? { line: row['line'] } : {},
      ...typeof row['col'] === 'number' ? { column: row['col'] } : {},
    },
  }))
}

/**
 * Everything that transitively depends on one node, nearest first.
 * @param db - the open graph connection.
 * @param origin - the node being changed.
 * @param depth - largest number of hops to walk.
 * @param budget - largest number of distinct nodes to visit before stopping the walk.
 * @returns the affected nodes in nondecreasing distance order, and whether the budget stopped the
 * walk before it ran out of graph.
 */
export function walkImpact(
  db: DatabaseSync,
  origin: CodegraphNodeId,
  depth: number,
  budget: number,
): { hits: ImpactHit[]; exhausted: boolean } {
  const seen = new Set<string>([origin])
  const hits: ImpactHit[] = []
  let frontier: CodegraphNodeId[] = [origin]
  for (let distance = 1; distance <= depth && frontier.length > 0; distance += 1) {
    const next: CodegraphNodeId[] = []
    for (const step of neighbours(db, frontier, IMPACT_EDGE_KINDS, true)) {
      if (seen.has(step.node)) continue
      seen.add(step.node)
      hits.push({ node: step.node, distance, via: step.edge.kind })
      next.push(step.node)
      if (seen.size > budget) return { hits, exhausted: true }
    }
    frontier = next
  }
  return { hits, exhausted: false }
}

/**
 * Shortest directed paths between two nodes.
 *
 * Only shortest paths are returned: the breadth-first sweep records, for each node, the edges that
 * first reached it, so backtracking from the destination enumerates every route of that minimum
 * length and no longer detour. A longer path that avoids a shared intermediate hop is not reported.
 * @param db - the open graph connection.
 * @param from - the origin node.
 * @param to - the destination node.
 * @param maxDepth - largest number of hops a returned path may contain.
 * @param maxPaths - largest number of paths to enumerate.
 * @param budget - largest number of distinct nodes to visit before stopping the sweep.
 * @returns each path as its ordered steps, shortest first; empty when no path exists within the
 * depth and budget.
 */
export function walkTrace(
  db: DatabaseSync,
  from: CodegraphNodeId,
  to: CodegraphNodeId,
  maxDepth: number,
  maxPaths: number,
  budget: number,
): Step[][] {
  if (from === to) return [[]]
  /** For every discovered node, the steps that reached it at its own shortest depth. */
  const arrivals = new Map<string, Step[]>()
  const depthOf = new Map<string, number>([[from, 0]])
  let frontier: CodegraphNodeId[] = [from]
  let found = false
  for (let distance = 1; distance <= maxDepth && frontier.length > 0 && !found; distance += 1) {
    const next: CodegraphNodeId[] = []
    for (const step of neighbours(db, frontier, TRACE_EDGE_KINDS, false)) {
      const known = depthOf.get(step.node)
      if (known !== undefined && known < distance) continue
      if (known === undefined) {
        depthOf.set(step.node, distance)
        next.push(step.node)
      }
      arrivalsAt(arrivals, step.node).push(step)
      if (step.node === to) found = true
      if (depthOf.size > budget) return found ? enumeratePaths(arrivals, from, to, maxPaths) : []
    }
    frontier = next
  }
  return found ? enumeratePaths(arrivals, from, to, maxPaths) : []
}

/**
 * Rebuild concrete paths by backtracking through the recorded arrivals.
 * @param arrivals - for each node, the steps that reached it at its shortest depth.
 * @param from - the origin the paths must start at.
 * @param to - the destination to backtrack from.
 * @param maxPaths - largest number of paths to return.
 * @returns the enumerated paths, each ordered from origin to destination.
 */
function enumeratePaths(
  arrivals: Map<string, Step[]>,
  from: CodegraphNodeId,
  to: CodegraphNodeId,
  maxPaths: number,
): Step[][] {
  const paths: Step[][] = []
  // Two declarations can be joined by several edges of the same kind — one per call site — which
  // would otherwise enumerate as several paths that render identically. A path is identified by the
  // nodes it visits, so the first edge found for each route is the one reported.
  const routes = new Set<string>()
  const expand = (node: CodegraphNodeId, tail: Step[]): void => {
    if (paths.length >= maxPaths) return
    if (node === from) {
      const route = tail.map(step => step.node).join(' ')
      if (routes.has(route)) return
      routes.add(route)
      paths.push([...tail])
      return
    }
    for (const step of arrivalsAt(arrivals, node)) {
      // A step's source is the node one hop closer to the origin.
      expand(step.edge.source, [step, ...tail])
      if (paths.length >= maxPaths) return
    }
  }
  expand(to, [])
  return paths
}
