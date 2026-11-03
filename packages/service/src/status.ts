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
