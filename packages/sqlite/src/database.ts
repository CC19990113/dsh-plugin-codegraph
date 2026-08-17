/**
 * Connection ownership for the on-disk knowledge graph: where a project root's database lives, the
 * format-version gate every connection passes before serving a query, and the bounded pool that
 * keeps recently queried projects open.
 *
 * Databases open READ-ONLY. The external indexer may be writing through its own daemon while the
 * harness reads, so this store never takes a write lock, never recovers a journal, and never repairs
 * an index it does not own.
 * @module dsh-plugin-codegraph-sqlite/database
 */

import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { CodegraphError } from 'dsh-plugin-codegraph-service'

/**
 * Where the external indexer keeps a project's graph, relative to the project root. Fixed by that
 * tool's on-disk layout rather than configurable: pointing this store at another path would not make
 * a different file readable, it would only fail later and less clearly.
 */
export const DATABASE_RELATIVE_PATH = '.codegraph/codegraph.db'

/**
 * The single on-disk format version this store reads. The format is an external specification, so
 * support is a fixed fact rather than a deployment choice; a database at any other version fails
 * loud instead of being read through assumptions that no longer hold.
 */
export const SUPPORTED_FORMAT_VERSION = 4

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
  if (version !== SUPPORTED_FORMAT_VERSION) {
    db.close()
    throw new CodegraphError(
      `the code graph at "${path}" is format version ${version}; this store reads version ${SUPPORTED_FORMAT_VERSION}`,
      'CODEGRAPH_UNSUPPORTED_FORMAT',
    )
  }
  return db
}

/**
 * A bounded set of open graph connections keyed by project root, evicting the least recently used
 * one when full. Every connection the pool hands out stays valid until {@link close}: eviction and
 * disposal both close connections, so a caller holds a connection only for the duration of one
 * synchronous query.
 */
export class GraphPool {
  private readonly open = new Map<string, DatabaseSync>()
  private disposed = false

  /**
   * @param capacity - largest number of simultaneously open databases; at least 1.
   */
  constructor(private readonly capacity: number) {}

  /**
   * The connection for a project root, opening and caching it on first use.
   * @param projectRoot - absolute path of the indexed project root.
   * @returns the open, version-checked connection.
   */
  acquire(projectRoot: string): DatabaseSync {
    if (this.disposed) {
      throw new CodegraphError('the code-graph store is disposed', 'CODEGRAPH_DISPOSED')
    }
    const cached = this.open.get(projectRoot)
    if (cached !== undefined) {
      // Re-insert to mark most recently used; Map iteration order is insertion order.
      this.open.delete(projectRoot)
      this.open.set(projectRoot, cached)
      return cached
    }
    const db = openGraph(projectRoot)
    this.open.set(projectRoot, db)
    this.evictOverflow()
    return db
  }

  /** Close every open connection; further {@link acquire} calls fail as `CODEGRAPH_DISPOSED`. */
  close(): void {
    this.disposed = true
    for (const db of this.open.values()) db.close()
    this.open.clear()
  }

  /** Close least-recently-used connections until the pool fits its capacity. */
  private evictOverflow(): void {
    while (this.open.size > this.capacity) {
      // Map iteration starts at the least recently used entry, and `acquire` re-inserts on a hit,
      // so the first entry is always the eviction candidate.
      for (const [root, db] of this.open) {
        db.close()
        this.open.delete(root)
        break
      }
    }
  }
}
