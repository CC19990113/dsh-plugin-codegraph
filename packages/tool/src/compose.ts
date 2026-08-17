/**
 * The two operations that are not seam queries. `explore` and `context` compose the graph primitives
 * with `ctx.fs` reads, which is why they live in the consumer: a graph store returns positions and
 * cannot reach a remote workspace's bytes, so aggregation belongs to the role that holds both.
 * @module dsh-plugin-codegraph-tool/compose
 */

import type { CodegraphNode, CodegraphRelation } from 'dsh-plugin-codegraph-service'

/** Words a task description contributes no search signal through. */
const STOPWORDS = new Set([
  'a', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can', 'do', 'does', 'for', 'from',
  'how', 'in', 'into', 'is', 'it', 'its', 'not', 'of', 'on', 'or', 'that', 'the', 'their', 'then',
  'there', 'this', 'to', 'was', 'what', 'when', 'where', 'which', 'why', 'will', 'with', 'work',
  'works', 'add', 'fix', 'bug', 'code', 'file', 'files', 'need', 'make', 'use', 'used', 'using',
])

/**
 * Split a task description into the terms worth searching for.
 *
 * A task is prose, but a graph is indexed by identifiers, so the terms that carry signal are the
 * identifier-shaped words: `camelCase` and `snake_case` names survive whole because splitting them
 * would search for their fragments instead of the symbol the author meant.
 * @param task - the free-text task description.
 * @param maxTerms - largest number of terms to return.
 * @returns the search terms, longest first so the most specific one is searched before the budget
 * runs out.
 */
export function taskTerms(task: string, maxTerms: number): string[] {
  const words = task.split(/[^\p{L}\p{N}_$]+/u).filter(word => word.length > 0)
  const kept = new Map<string, string>()
  for (const word of words) {
    if (word.length < 3) continue
    if (STOPWORDS.has(word.toLowerCase())) continue
    const key = word.toLowerCase()
    if (!kept.has(key)) kept.set(key, word)
  }
  return [...kept.values()]
    .sort((left, right) => right.length - left.length)
    .slice(0, maxTerms)
}

/**
 * Node kinds that name code without declaring any. An `import` node exists once per importing file,
 * so a widely used symbol contributes a dozen of them under its own name; a `file` node repeats the
 * path its results are already grouped by. `search` still returns both, because a model that asked
 * for a name asked for every occurrence of it — but the operations that answer "what is this task
 * about" must spend their budget on declarations.
 */
const STRUCTURAL_KINDS = new Set(['import', 'export', 'file', 'module'])

/**
 * Keep only the declarations among matched nodes.
 * @param nodes - the matched nodes.
 * @returns the nodes that declare something.
 */
export function declarationsOnly(nodes: readonly CodegraphNode[]): CodegraphNode[] {
  return nodes.filter(node => !STRUCTURAL_KINDS.has(node.kind))
}

/** A node with the evidence that it matched. */
export interface ScoredNode {
  /** The matched declaration. */
  readonly node: CodegraphNode
  /** How many distinct terms found it. */
  readonly hits: number
}

/** A stable identity for one declaration across separate searches. */
function nodeKey(node: CodegraphNode): string {
  return `${node.filePath}:${node.startLine}:${node.qualifiedName}`
}

/**
 * Merge per-term search results into one ranked list.
 *
 * A declaration found by several of a task's terms is more likely to be what the task is about than
 * one found by a single term, so hit count leads the ranking; within an equal count the earliest
 * position any single search gave it wins, preserving the store's own relevance order.
 * @param batches - each term's search results, in the order the store ranked them.
 * @param limit - largest number of declarations to return.
 * @returns the merged declarations, most relevant first.
 */
export function mergeByHits(batches: readonly (readonly CodegraphNode[])[], limit: number): ScoredNode[] {
  const merged = new Map<string, { node: CodegraphNode; hits: number; best: number }>()
  for (const batch of batches) {
    batch.forEach((node, position) => {
      const key = nodeKey(node)
      const existing = merged.get(key)
      if (existing === undefined) merged.set(key, { node, hits: 1, best: position })
      else {
        existing.hits += 1
        existing.best = Math.min(existing.best, position)
      }
    })
  }
  return [...merged.values()]
    .sort((left, right) => right.hits - left.hits || left.best - right.best)
    .slice(0, limit)
    .map(entry => ({ node: entry.node, hits: entry.hits }))
}

/** Declarations that share one file, in the order the search ranked them. */
export interface FileGroup {
  /** The file, relative to the project root. */
  readonly path: string
  /** The matched declarations in that file. */
  readonly nodes: CodegraphNode[]
  /** One-based first line spanned by {@link nodes}. */
  readonly startLine: number
  /** One-based last line spanned by {@link nodes}. */
  readonly endLine: number
}

/**
 * Group ranked declarations by file, preserving rank.
 *
 * Grouping is what makes `explore` cheaper than reading each symbol separately: several matches in
 * one file share a single read and a single contiguous slice, and the file that held the top-ranked
 * match is presented first.
 * @param nodes - the ranked declarations.
 * @param maxFiles - largest number of files to return.
 * @returns the groups, best-ranked file first.
 */
export function groupByFile(nodes: readonly CodegraphNode[], maxFiles: number): FileGroup[] {
  const groups = new Map<string, { path: string; nodes: CodegraphNode[]; startLine: number; endLine: number }>()
  for (const node of nodes) {
    const existing = groups.get(node.filePath)
    if (existing === undefined) {
      groups.set(node.filePath, {
        path: node.filePath,
        nodes: [node],
        startLine: node.startLine,
        endLine: node.endLine,
      })
      continue
    }
    existing.nodes.push(node)
    existing.startLine = Math.min(existing.startLine, node.startLine)
    existing.endLine = Math.max(existing.endLine, node.endLine)
  }
  return [...groups.values()].slice(0, maxFiles)
}

/**
 * Merge relations from several symbols, keeping each related declaration once.
 * @param batches - relation lists to merge.
 * @param limit - largest number of relations to return.
 * @returns the merged relations, in first-seen order.
 */
export function mergeRelations(
  batches: readonly (readonly CodegraphRelation[])[],
  limit: number,
): CodegraphRelation[] {
  const merged = new Map<string, CodegraphRelation>()
  for (const batch of batches) {
    for (const relation of batch) {
      const key = `${nodeKey(relation.node)}:${relation.edge.kind}`
      if (!merged.has(key)) merged.set(key, relation)
      if (merged.size >= limit) return [...merged.values()]
    }
  }
  return [...merged.values()]
}
