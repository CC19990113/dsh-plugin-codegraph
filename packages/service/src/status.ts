/**
 * The small sidecar file an indexing run leaves beside its graph, so a prompt-time reader can describe
 * the index without opening SQLite.
 *
 * A prompt section is assembled synchronously on every model request, which rules out a `ctx.codegraph`
 * query (async) and makes opening the database on each step wasteful. One JSON file next to the graph
 * answers the only questions a prompt line needs — how large, how old, was anything skipped — in a
 * single small read.
 *
 * The graph itself stays the only source of truth: this file is a cache of one run's summary, and a
 * reader that finds it missing or stale falls back to "an index exists, ask `status` for details".
 * @module dsh-plugin-codegraph-service/status
 */

/** Path of the status sidecar, relative to a project root. Written beside the graph, never inside it. */
export const INDEX_STATUS_RELATIVE_PATH = '.codegraph/status.json'

/**
 * One indexing run's summary, as persisted for prompt-time readers.
 *
 * Every field is derived from the same run that wrote the graph, so this file can only ever describe a
 * graph that exists — it is written after the graph rename, never before.
 */
export interface IndexStatusFile {
  /** Epoch milliseconds the run finished. */
  readonly indexedAt: number
  /** Files parsed and written to the graph. */
  readonly filesIndexed: number
  /** Generated artifacts the run left out. */
  readonly filesMinified: number
  /** Declaration nodes written. */
  readonly nodeCount: number
  /** Relationship edges written. */
  readonly edgeCount: number
  /** Call sites left unresolved, including the member calls and imported names a type-free resolver never settles. */
  readonly unresolvedCount: number
  /** Of {@link unresolvedCount}, the sites that look like genuine workspace-internal gaps. */
  readonly unresolvedLikelyInternalCount: number
}

/**
 * Path of the failure sidecar, relative to a project root. Written beside the graph by a run that
 * threw, deleted by the next run that successfully wrote one.
 *
 * The status sidecar only ever describes a graph that exists, so a failed run has no graph to
 * describe and leaves no trace there — which made a broken workspace indistinguishable from one
 * nobody had indexed yet. This file is that missing half: the reason the last attempt failed, kept
 * out of {@link INDEX_STATUS_RELATIVE_PATH} so a stale summary and a failure record can never be
 * mistaken for one another.
 */
export const INDEX_FAILURE_RELATIVE_PATH = '.codegraph/last-error.json'

/**
 * The most recent indexing failure, as persisted for a reader that did not see the run.
 *
 * Deliberately tiny and unversioned: it exists to answer "why is there no index" in one small read,
 * not to be a log. A successful run deletes it, so its presence always means "the newest attempt
 * failed", never "an old attempt once failed".
 */
export interface IndexFailureFile {
  /** Epoch milliseconds the failed run was reported. */
  readonly failedAt: number
  /** The failure as text, already stringified by the run that recorded it. */
  readonly message: string
  /** Which path started the run, so a reader can tell a background refresh from an explicit build. */
  readonly source: 'auto' | 'tool' | 'watch'
}
