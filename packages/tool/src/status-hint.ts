/**
 * The one line of index state this plugin contributes to the system prompt on every request.
 *
 * A model that has to call `status` before every query spends a tool round-trip learning something
 * the host already knows at assembly time. `ctx.systemPrompt.section` takes a function for exactly
 * this case (`packages/tool/src/index.ts` passes one), and it is called synchronously, so this module
 * reads the sidecar an indexing run wrote beside the graph rather than querying the store.
 *
 * Nothing here is authoritative: the file is a cache of one run's summary, the graph is the truth. A
 * missing file therefore means "describing it would take a query" — never "there is no index".
 * @module dsh-plugin-codegraph-tool/status-hint
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { INDEX_FAILURE_RELATIVE_PATH, INDEX_STATUS_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { IndexFailureFile, IndexStatusFile } from 'dsh-plugin-codegraph-service'

/** Path of the graph itself, relative to a project root — used only to tell "never indexed" apart. */
const GRAPH_RELATIVE_PATH = '.codegraph/codegraph.db'

/**
 * Read an indexing run's persisted summary.
 * @param projectRoot - absolute workspace root.
 * @returns the summary, or `undefined` when the file is absent, unreadable, or not shaped like one.
 */
export function readIndexStatus(projectRoot: string): IndexStatusFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(projectRoot, INDEX_STATUS_RELATIVE_PATH), 'utf8'))
  } catch {
    // Absent, unreadable, or not JSON: all three mean "no summary to trust", which the caller renders
    // as the weaker statement rather than as an error. A prompt line must never fail an assembly.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const indexedAt = numberField(record, 'indexedAt')
  const filesIndexed = numberField(record, 'filesIndexed')
  const filesMinified = numberField(record, 'filesMinified')
  const nodeCount = numberField(record, 'nodeCount')
  const edgeCount = numberField(record, 'edgeCount')
  const unresolvedCount = numberField(record, 'unresolvedCount')
  const unresolvedLikelyInternalCount = numberField(record, 'unresolvedLikelyInternalCount')
  if (
    indexedAt === undefined || filesIndexed === undefined || filesMinified === undefined
    || nodeCount === undefined || edgeCount === undefined || unresolvedCount === undefined
    || unresolvedLikelyInternalCount === undefined
  ) return undefined
  return {
    indexedAt, filesIndexed, filesMinified, nodeCount, edgeCount, unresolvedCount, unresolvedLikelyInternalCount,
  }
}

/**
 * The last indexing failure recorded beside a workspace's graph, when there is one to trust.
 *
 * A synchronous small read, unlike every other `status` input: the reason an index is missing is most
 * valuable exactly when no store can answer, and that is the one answer which must never fail.
 * Shared by the model-facing `status` operation and `/codegraph status`, which both owe the same
 * explanation for an absent — or newly stale — index.
 * @param projectRoot - absolute project root.
 * @returns the record as written, or undefined when there is none to report.
 */
export function readIndexFailureFile(projectRoot: string): IndexFailureFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(projectRoot, INDEX_FAILURE_RELATIVE_PATH), 'utf8'))
  } catch {
    // Absent, unreadable, or not JSON: all three mean "no recorded reason", which the callers render
    // as the weaker statement rather than as an error. A status answer must never fail on this.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as { failedAt?: unknown; message?: unknown; source?: unknown }
  const failedAt = numberField(record, 'failedAt')
  if (failedAt === undefined || typeof record.message !== 'string') return undefined
  if (!isFailureSource(record.source)) return undefined
  return { failedAt, message: record.message, source: record.source }
}

/**
 * Whether a recorded `source` is one of the paths this project writes.
 * @param value - the field as it was read off disk.
 * @returns true when the record names a known path.
 */
function isFailureSource(value: unknown): value is IndexFailureFile['source'] {
  return value === 'auto' || value === 'tool' || value === 'watch'
}

/**
 * One numeric field of a parsed object, or `undefined` when it is absent or not a finite number.
 * @param record - the parsed object.
 * @param field - the field name to read.
 * @returns the number, or `undefined`.
 */
function numberField(record: Record<string, unknown>, field: string): number | undefined {
  const value = record[field]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/** Render an epoch-millisecond timestamp the way a model reads it: UTC, minute precision. */
export function formatIndexedAt(indexedAt: number): string {
  return `${new Date(indexedAt).toISOString().slice(0, 16)}Z`
}

/**
 * The state of one workspace's index, phrased for a system prompt.
 *
 * Three outcomes, deliberately distinguished: a full summary, an index that exists without a summary
 * (built by an older run or another indexer), and no index at all. Collapsing the middle case into
 * "no index" would invite a rebuild of a graph that is already there.
 * @param projectRoot - the session's workspace root, when it has one.
 * @returns one sentence naming the state, or the reason no state can be named.
 */
export function indexStatusHint(projectRoot: string | undefined): string {
  if (projectRoot === undefined) {
    return 'This session has no workspace bound, so codegraph needs an explicit project_path on every call.'
  }
  const status = readIndexStatus(projectRoot)
  if (status !== undefined) {
    const skipped = status.filesMinified === 0 ? '' : ` ${status.filesMinified} generated files were left out.`
    return `The code graph for ${projectRoot} was built ${formatIndexedAt(status.indexedAt)} from ${status.filesIndexed} files: `
      + `${status.nodeCount} declarations, ${status.edgeCount} relationships.${skipped}`
  }
  if (existsSync(join(projectRoot, GRAPH_RELATIVE_PATH))) {
    return `A code graph exists for ${projectRoot} but predates this plugin's status summary — call codegraph status for its size and freshness.`
  }
  return `No code graph exists for ${projectRoot} yet. Call codegraph_index once to build one; queries fail until then.`
}

/**
 * The session workspace a prompt assembly is running for.
 * @param context - the assembly context the host passes to a section's `text` function (`{ agent, scope, signal }`).
 * @returns the agent's session workspace root, or `undefined` when the session has none.
 */
export function agentIdOf(context: unknown): string | undefined {
  const agent = (context as { agent?: { id?: unknown } } | undefined)?.agent
  const id = agent?.id
  return typeof id === 'string' && id !== '' ? id : undefined
}

export function workspaceOf(context: unknown): string | undefined {
  const agent = (context as { agent?: { session?: { header?: { cwd?: unknown } } } } | undefined)?.agent
  const cwd = agent?.session?.header?.cwd
  return typeof cwd === 'string' && cwd.trim() !== '' ? cwd : undefined
}
