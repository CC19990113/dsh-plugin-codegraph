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
import {
  INDEX_FAILURE_RELATIVE_PATH,
  INDEX_STATUS_RELATIVE_PATH,
  INDEX_WATCH_STATE_RELATIVE_PATH,
} from 'dsh-plugin-codegraph-service'
import type { IndexFailureFile, IndexStatusFile, IndexWatchStateFile } from 'dsh-plugin-codegraph-service'

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
 * Whether live watching is running for a workspace, as the watcher last reported it.
 *
 * The degradation this reads used to exist only as a `console.error`, so a workspace whose automatic
 * rebuild had never once succeeded was indistinguishable from one where it worked — the user believed
 * watching was on. A synchronous read for the same reason as the status sidecar: a prompt section is
 * assembled on every request, and a degradation notice is worth a few hundred bytes of JSON, not a
 * tool round-trip. An absent file means "nothing recorded", which is not the same as "degraded".
 * @param projectRoot - absolute workspace root.
 * @returns the recorded state, or `undefined` when the file is absent, unreadable, or not shaped like
 *   one — every one of which renders as the weaker "no degradation recorded".
 */
export function readWatchState(projectRoot: string): IndexWatchStateFile | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(join(projectRoot, INDEX_WATCH_STATE_RELATIVE_PATH), 'utf8'))
  } catch {
    // Absent, unreadable, or not JSON. A prompt line must never fail an assembly over a hint.
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined
  const record = parsed as Record<string, unknown>
  const at = numberField(record, 'at')
  if (typeof record['watching'] !== 'boolean' || at === undefined) return undefined
  // A `code` that is present but not text is a record this reader cannot trust; it still knows the
  // boolean half, so the degradation is still reported, just without a reason to quote.
  return typeof record['code'] === 'string'
    ? { watching: record['watching'], code: record['code'], at }
    : { watching: record['watching'], at }
}

/**
 * One sentence saying automatic rebuilding is off, or `''` when it is running (or never recorded).
 *
 * A prompt line, not an error: the model reads it before deciding whether a `codegraph_index` call is
 * needed, which is exactly the decision a silently degraded watcher used to hide.
 * @param projectRoot - absolute workspace root.
 * @returns the degradation sentence, or an empty string when there is nothing to warn about.
 */
export function watchStateHint(projectRoot: string): string {
  const state = readWatchState(projectRoot)
  if (state === undefined || state.watching) return ''
  // The two caps report different codes, so the reason is quoted rather than paraphrased — a caller
  // raising one budget does not want to learn it raised the wrong one from a sentence this file made
  // up. A record without a code still says the half that matters.
  const reason = state.code === undefined ? '' : ` Reasons code: ${state.code}.`
  return `Live rebuilding is NOT running for ${projectRoot}: watching stopped, so edits will not refresh the `
    + `graph on their own — run codegraph_index after changes.${reason}`
}

/**
 * The state of one workspace's index, phrased for a system prompt.
 *
 * Three outcomes, deliberately distinguished: a full summary, an index that exists without a summary
 * (built by an older run or another indexer), and no index at all. Collapsing the middle case into
 * "no index" would invite a rebuild of a graph that is already there. A recorded watcher degradation
 * is appended to whichever of the three it is: "the graph exists but nothing refreshes it" is a fact
 * about this workspace, not a replacement for what the graph contains.
 * @param projectRoot - the session's workspace root, when it has one.
 * @returns one sentence naming the state, or the reason no state can be named.
 */
export function indexStatusHint(projectRoot: string | undefined): string {
  if (projectRoot === undefined) {
    return 'This session has no workspace bound, so codegraph needs an explicit project_path on every call.'
  }
  const warning = watchStateHint(projectRoot)
  const summary = indexStatusSummary(projectRoot)
  return warning === '' ? summary : `${summary}\n\n${warning}`
}

/**
 * The index half of {@link indexStatusHint}: what the sidecar says about the graph itself.
 * @param projectRoot - absolute workspace root.
 * @returns the sentence naming the graph's state.
 */
function indexStatusSummary(projectRoot: string): string {
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
