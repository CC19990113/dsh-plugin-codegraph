/**
 * Connection ownership for the on-disk knowledge graph: where a project root's database lives, the
 * format-version gate every connection passes before serving a query, and the bounded pool that
 * keeps recently queried projects open.
 *
 * Databases open READ-ONLY. The external indexer may be writing through its own daemon while the
 * harness reads, so this store never takes a write lock, never recovers a journal, and never repairs
 * an index it does not own.
 * @module @huanlin/dsh-plugin-codegraph-sqlite/database
 */

import { DatabaseSync } from 'node:sqlite'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { CodegraphError } from '@huanlin/dsh-plugin-codegraph-service'

/**
 * Where the external indexer keeps a project's graph, relative to the project root. Fixed by that
 * tool's on-disk layout rather than configurable: pointing this store at another path would not make
 * a different file readable, it would only fail later and less clearly.
 */
export const DATABASE_RELATIVE_PATH = '.codegraph/codegraph.db'

/**
 * The on-disk format versions this store reads. The format is an external specification, so support
 * is a fixed fact rather than a deployment choice; a database at any other version fails loud
 * instead of being read through assumptions that no longer hold.
 *
 * Two writers share this file, one per version: `@huanlin/dsh-plugin-codegraph-tree-sitter` builds schema v4,
 * and the `@colbymchenry/codegraph` CLI (≥1.5, whose daemon may own the same index) stamps schema
 * v8 — its `nodes`/`edges`/`files`/`nodes_fts` tables keep every column the store reads and only add
 * ones the store never touches (`unresolved_refs` is reshaped, `project_metadata` and
 * `name_segment_vocab` are new, and no store query reads any of the three).
 */
export const SUPPORTED_FORMAT_VERSIONS: readonly number[] = [4, 8]

/**
 * The absolute path of a project root's graph database.
 * @param projectRoot - absolute path of the indexed project root.
 * @returns the database path, whether or not it exists.
 */
export function databasePath(projectRoot: string): string {
  return join(projectRoot, DATABASE_RELATIVE_PATH)
}

/**
 * The format version recorded in an open database.
 * @param db - an open connection.
 * @returns the highest applied schema version.
 */
function readFormatVersion(db: DatabaseSync): number {
  const row = db.prepare('SELECT MAX(version) AS version FROM schema_versions').get() as
    | { version: number | bigint | null }
    | undefined
  const version = row?.version
  if (version === null || version === undefined) {
    throw new CodegraphError('the code graph records no schema version', 'CODEGRAPH_MALFORMED_INDEX')
  }
  return Number(version)
}

/**
 * The device and inode a path currently resolves to — cheap, filesystem-level proof that two opens
 * of the same path did or didn't land on the same underlying file. `ino` alone is only unique within
 * one device, so both are required.
 */
interface FileIdentity {
  readonly dev: number
  readonly ino: number
}

/**
 * A path's current on-disk identity, or `undefined` when it cannot be stat'd (most commonly: an
 * indexing run's atomic replace is between removing the old file and renaming the new one into place).
 * That absence is treated as "unknown, not gone" by every caller — a transient rebuild window must
 * never look like a missing graph.
 * @param path - the file to identify.
 */
function identify(path: string): FileIdentity | undefined {
  try {
    const stats = statSync(path)
    return { dev: stats.dev, ino: stats.ino }
  } catch {
    return undefined
  }
}

/** Whether two identities name the same underlying file. */
function sameIdentity(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino
}

/**
 * Open one project's graph read-only and verify its format version.
 * @param projectRoot - absolute path of the indexed project root.
 * @returns the open, version-checked connection.
 */
export function openGraph(projectRoot: string): DatabaseSync {
  const path = databasePath(projectRoot)
  let db: DatabaseSync
  try {
    db = new DatabaseSync(path, { readOnly: true })
  } catch (cause) {
    throw new CodegraphError(
      `cannot open the code graph at "${path}"`,
      'CODEGRAPH_UNAVAILABLE',
      { cause },
    )
  }
  let version: number
  try {
    version = readFormatVersion(db)
  } catch (error) {
    db.close()
    throw error
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(version)) {
    db.close()
    throw new CodegraphError(
      `the code graph at "${path}" is format version ${version}; this store reads version ${SUPPORTED_FORMAT_VERSIONS.join(' or ')}`,
      'CODEGRAPH_UNSUPPORTED_FORMAT',
    )
  }
  return db
}

/** A pooled connection alongside the on-disk identity it was opened against. */
interface PooledConnection {
  readonly db: DatabaseSync
  readonly identity: FileIdentity
}

/**
 * A bounded set of open graph connections keyed by project root, evicting the least recently used
 * one when full. Every connection the pool hands out stays valid until it is closed: eviction,
 * {@link release}, and disposal all close connections, so a caller holds a connection only for the
 * duration of one synchronous query.
 *
 * A connection is opened against one specific on-disk file. An indexing run replaces that file
 * wholesale (rename over the old path), and POSIX unlink semantics mean an already-open read-only
 * connection keeps serving the REPLACED file's bytes indefinitely — reopening is the only way to see
 * the new graph. `acquire` detects that swap by comparing the device/inode recorded at open time
 * against the path's current identity, so a cache hit never silently serves a graph an indexing run
 * has already superseded.
 */
export class GraphPool {
  private readonly open = new Map<string, PooledConnection>()
  private disposed = false

  /**
   * @param capacity - largest number of simultaneously open databases; at least 1.
   */
  constructor(private readonly capacity: number) {}

  /**
   * The connection for a project root, opening and caching it on first use. Reopens automatically
   * when the file on disk is no longer the one the cached connection was opened against.
   * @param projectRoot - absolute path of the indexed project root.
   * @returns the open, version-checked connection, current as of this call.
   */
  acquire(projectRoot: string): DatabaseSync {
    if (this.disposed) {
      throw new CodegraphError('the code-graph store is disposed', 'CODEGRAPH_DISPOSED')
    }
    const cached = this.open.get(projectRoot)
    if (cached !== undefined) {
      const current = identify(databasePath(projectRoot))
      // `undefined` means the path is transiently unstatable — most likely an indexing run's replace
      // is mid-flight between removing the old file and renaming the new one into place. Keep serving
      // the connection we have rather than treating a rebuild-in-progress as a missing graph.
      if (current === undefined || sameIdentity(current, cached.identity)) {
        // Re-insert to mark most recently used; Map iteration order is insertion order.
        this.open.delete(projectRoot)
        this.open.set(projectRoot, cached)
        return cached.db
      }
      cached.db.close()
      this.open.delete(projectRoot)
    }
    const db = openGraph(projectRoot)
    const identity = identify(databasePath(projectRoot))
    // Only `undefined` when the file vanishes in the instant between opening it and this stat — an
    // unprovokable race in tests. The sentinel never matches a real identity, so the next acquire()
    // is forced to re-verify rather than trusting an unconfirmed connection indefinitely.
    /* v8 ignore next */
    this.open.set(projectRoot, { db, identity: identity ?? { dev: -1, ino: -1 } })
    this.evictOverflow()
    return db
  }

  /**
   * Close and forget the connection cached for `projectRoot`, when one is held. The store calls
   * this before an indexing run replaces the graph file: Windows refuses that replace while the
   * pooled read-only connection keeps the old file open — SQLite opens its files without
   * `FILE_SHARE_DELETE` — and without this step every later rebuild would fail EPERM on a rename
   * the pool's own connection alone caused. The next {@link acquire} simply opens fresh, which is
   * also how it picks up the rebuilt graph.
   * @param projectRoot - absolute path of the project root whose connection to close.
   */
  release(projectRoot: string): void {
    const cached = this.open.get(projectRoot)
    if (cached === undefined) return
    cached.db.close()
    this.open.delete(projectRoot)
  }

  /** Close every open connection; further {@link acquire} calls fail as `CODEGRAPH_DISPOSED`. */
  close(): void {
    this.disposed = true
    for (const { db } of this.open.values()) db.close()
    this.open.clear()
  }

  /** Close least-recently-used connections until the pool fits its capacity. */
  private evictOverflow(): void {
    while (this.open.size > this.capacity) {
      // Map iteration starts at the least recently used entry, and `acquire` re-inserts on a hit,
      // so the first entry is always the eviction candidate.
      for (const [root, entry] of this.open) {
        entry.db.close()
        this.open.delete(root)
        break
      }
    }
  }
}
