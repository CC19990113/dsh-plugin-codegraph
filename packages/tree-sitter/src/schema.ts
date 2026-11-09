/**
 * Schema-v4 database writer: create the on-disk tables `dsh-plugin-codegraph-sqlite` reads —
 * verbatim in structure, so the store and the external `codegraph` CLI stay able to open what this
 * package writes — and insert one indexing run's resolved graph.
 *
 * Writing replaces whatever was at the path: an indexing run is a full rebuild, not an incremental
 * update. The new graph is built on a same-directory temporary file and `rename`d into place, so a
 * reader opening `databasePath` at any point either sees the complete previous graph or the complete
 * new one — never a window where the file exists with a fresh, empty schema and no rows yet, which a
 * naive "delete then recreate" leaves open between `CREATE TABLE` and the first `COMMIT`.
 * @module dsh-plugin-codegraph-tree-sitter/schema
 */

import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import { INDEX_STATUS_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { IndexStatusFile } from 'dsh-plugin-codegraph-service'
import type { ExtractedFile, GraphEdge, GraphNode, UnresolvedRef } from './resolve.ts'

/** The schema version this package writes, matching the format `dsh-codegraph-sqlite` reads. */
export const SCHEMA_VERSION = 4

/**
 * DDL for every table this package writes. Structurally identical to the subset
 * `dsh-codegraph-sqlite` reads, plus `unresolved_refs`, which no store reads today — it exists so an
 * indexing run's conservative gaps are inspectable on disk, not only summarized in the run's report.
 */
const SCHEMA = `
CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
CREATE TABLE nodes (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
  file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
  start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT,
  visibility TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0,
  is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, updated_at INTEGER NOT NULL);
CREATE TABLE edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL, kind TEXT NOT NULL,
  metadata TEXT, line INTEGER, col INTEGER, provenance TEXT DEFAULT NULL);
CREATE TABLE files (
  path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL, size INTEGER NOT NULL,
  modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL, node_count INTEGER DEFAULT 0, errors TEXT);
CREATE VIRTUAL TABLE nodes_fts USING fts5(
  id, name, qualified_name, docstring, signature, content='nodes', content_rowid='rowid');
CREATE TRIGGER nodes_ai AFTER INSERT ON nodes BEGIN
  INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
  VALUES (NEW.rowid, NEW.id, NEW.name, NEW.qualified_name, NEW.docstring, NEW.signature);
END;
CREATE TABLE unresolved_refs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, file_path TEXT NOT NULL,
  callee_name TEXT NOT NULL, line INTEGER, col INTEGER);
`

/** One indexing run's complete output, ready to write. */
export interface WriteInput {
  readonly files: readonly ExtractedFile[]
  readonly nodes: readonly GraphNode[]
  readonly edges: readonly GraphEdge[]
  readonly unresolved: readonly UnresolvedRef[]
  /** Generated artifacts this run left out of the graph, carried into the status sidecar. */
  readonly filesMinified: number
  readonly indexedAt: number
}

/** Remove a database file and its WAL/SHM sidecars, tolerating any of the three being absent. */
async function removeGraphFiles(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(`${path}-wal`, { force: true })
  await rm(`${path}-shm`, { force: true })
}

/**
 * Report whether the process that claimed a lock file is still running.
 *
 * A timestamp is the wrong staleness test here: an index over a large tree legitimately runs
 * for minutes, so any fixed window either steals a lock that is still held or waits forever on
 * one whose holder crashed. The holder writes its pid after the exclusive create, and a pid the
 * OS no longer knows is garbage. `process.kill(pid, 0)` sends no signal — it only asks whether
 * the process exists; `EPERM` means it does and is simply not ours to signal.
 * @param lockPath - absolute path of the `.graph.lock` file to inspect.
 * @returns true when the recorded holder still exists.
 */
async function lockHolderIsAlive(lockPath: string): Promise<boolean> {
  let raw: string
  try {
    raw = await readFile(lockPath, 'utf8')
  } catch {
    // Vanished between the failed `wx` and this read: let the caller retry the create.
    return false
  }
  const pid = Number.parseInt(raw, 10)
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // ESRCH: no such process. EPERM: alive, but owned by another user.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Serialize graph writes on one workspace, across processes.
 *
 * Two runs used to be allowed to overlap (see writeStatusFile): each built its own
 * temporary file and the last rename won. That is safe for the file, but the loser's
 * status.json can then describe a graph the winner already replaced.
 * @param dir - the `.codegraph` directory, which must already exist.
 * @param work - the write to run while the lock is held.
 */
async function withGraphLock(dir: string, work: () => Promise<void>): Promise<void> {
  const lockPath = join(dir, '.graph.lock')
  const ACQUIRE_MS = 10_000
  const RETRY_MS = 25
  const started = Date.now()
  let handle: Awaited<ReturnType<typeof open>> | null = null
  while (handle === null) {
    try {
      handle = await open(lockPath, 'wx')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
      // A holder that died leaves the file behind; only a dead pid may be stolen, so a
      // live run slower than ACQUIRE_MS is waited out rather than overrun.
      if (!(await lockHolderIsAlive(lockPath))) {
        try {
          await rm(lockPath, { force: true })
        } catch {
          // another contender reclaimed it first
        }
        continue
      }
      if (Date.now() - started > ACQUIRE_MS) {
        throw new Error(`codegraph: another index run holds ${lockPath}`)
      }
      await new Promise((resolve) => setTimeout(resolve, RETRY_MS))
    }
  }
  try {
    // Record the holder so the next contender can tell a live run from a crashed one. An
    // absent or unparseable pid reads as dead, which is also the right answer for a lock
    // left by a process that died between the create and this write.
    await handle.writeFile(String(process.pid))
    return await work()
  } finally {
    try {
      await handle.close()
    } catch {
      // already closed
    }
    try {
      await rm(lockPath, { force: true })
    } catch {
      // best effort
    }
  }
}
/**
 * `rename` on Windows fails with EPERM/EBUSY/EACCES while ANY handle holds the target.
 * Those are transient by nature -- an antivirus read, a reader closing its connection --
 * and a single attempt turns one of them into a failed index.
 */
async function renameWithRetry(from: string, to: string): Promise<void> {
  let last: unknown = null
  for (let attempt = 0; attempt <= 3; attempt += 1) {
    try {
      await rename(from, to)
      return
    } catch (error) {
      last = error
      const retryable: readonly string[] = ['EPERM', 'EBUSY', 'EACCES']
      if (!retryable.includes((error as NodeJS.ErrnoException).code ?? '') || attempt === 3) break
      await new Promise((resolve) => setTimeout(resolve, 25 * (attempt + 1)))
    }
  }
  throw last
}
/**
 * Replace the graph at `databasePath` with one indexing run's output.
 *
 * The full build happens on a temporary file beside `databasePath`; only a successful build is
 * `rename`d over the real path, atomically on the same filesystem. A reader with a connection already
 * open on the old file keeps reading it (POSIX unlink semantics) until it reopens — that half of
 * freshness is the sqlite store's responsibility, not this writer's.
 * @param databasePath - absolute path of the `.codegraph/codegraph.db` file to (re)create.
 * @param input - the run's resolved graph and per-file metadata.
 */
export async function writeGraph(databasePath: string, input: WriteInput): Promise<void> {
  // The lock file lives beside the database, so its directory must exist before the lock can
  // be created — the first index of a workspace has no `.codegraph/` yet.
  await mkdir(dirname(databasePath), { recursive: true })
  return withGraphLock(dirname(databasePath), () => writeGraphUnlocked(databasePath, input))
}
async function writeGraphUnlocked(databasePath: string, input: WriteInput): Promise<void> {
  await mkdir(dirname(databasePath), { recursive: true })
  const tempPath = `${databasePath}.tmp-${process.pid}-${randomUUID()}`
  // Defensive: a previous run that crashed mid-write may have left this exact temp name behind.
  await removeGraphFiles(tempPath)

  try {
    const db = new DatabaseSync(tempPath)
    try {
      db.exec('BEGIN')
      db.exec(SCHEMA)
      db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
        .run(SCHEMA_VERSION, input.indexedAt, 'dsh-codegraph-tree-sitter')

      const insertNode = db.prepare(`INSERT INTO nodes
        (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column,
         end_column, is_exported, is_async, is_static, decorators, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      for (const node of input.nodes) {
        insertNode.run(
          node.id, node.kind, node.name, node.qualifiedName, node.filePath, node.language,
          node.startLine, node.endLine, node.startColumn, node.endColumn,
          node.isExported ? 1 : 0, node.isAsync ? 1 : 0, node.isStatic ? 1 : 0,
          JSON.stringify(node.decorators), node.updatedAt,
        )
      }

      const insertEdge = db.prepare('INSERT INTO edges (source, target, kind, line, col, provenance) VALUES (?, ?, ?, ?, ?, ?)')
      for (const edge of input.edges) {
        insertEdge.run(edge.source, edge.target, edge.kind, edge.line ?? null, edge.col ?? null, edge.provenance)
      }

      const insertFile = db.prepare(`INSERT INTO files
        (path, content_hash, language, size, modified_at, indexed_at, node_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
      const nodeCountByFile = new Map<string, number>()
      for (const node of input.nodes) {
        if (node.kind === 'file') continue
        nodeCountByFile.set(node.filePath, (nodeCountByFile.get(node.filePath) ?? 0) + 1)
      }
      for (const file of input.files) {
        insertFile.run(
          file.path, file.contentHash, file.language, file.size, file.modifiedAt, input.indexedAt,
          nodeCountByFile.get(file.path) ?? 0,
        )
      }

      const insertUnresolved = db.prepare('INSERT INTO unresolved_refs (source, file_path, callee_name, line, col) VALUES (?, ?, ?, ?, ?)')
      for (const ref of input.unresolved) {
        insertUnresolved.run(ref.source, ref.filePath, ref.calleeName, ref.line, ref.col)
      }

      db.exec('COMMIT')
    } catch (cause) {
      db.exec('ROLLBACK')
      throw cause
    } finally {
      db.close()
    }
  } catch (cause) {
    await removeGraphFiles(tempPath)
    throw cause
  }

  // The old file's sidecars, if any, describe the graph being replaced, not the new one; clear them
  // before the rename so the new file never inherits a stale WAL/SHM pair.
  await rm(`${databasePath}-wal`, { force: true })
  await rm(`${databasePath}-shm`, { force: true })
  try {
    await renameWithRetry(tempPath, databasePath)
  } catch (error) {
    // The rename sat outside the build's cleanup, so a failed replace left a finished
    // multi-megabyte temp behind. Reproduced before this change.
    await removeGraphFiles(tempPath)
    throw error
  }
  // rename() only moves the main file; the temp name's own sidecars (should the driver have left any)
  // never travel with it and would otherwise linger under the temp name forever.
  await removeGraphFiles(tempPath)

  await writeStatusFile(dirname(databasePath), {
    indexedAt: input.indexedAt,
    filesIndexed: input.files.length,
    filesMinified: input.filesMinified,
    nodeCount: input.nodes.length,
    edgeCount: input.edges.length,
    unresolvedCount: input.unresolved.length,
    unresolvedLikelyInternalCount: input.unresolved.filter(ref => !ref.likelyExternal).length,
  })
}

/**
 * Replace one JSON document atomically: serialize to a unique staging file beside `target`, then
 * `rename` it over `target`.
 *
 * The staging name is unique (`pid` plus a random UUID) and lives in the target's own directory, for
 * two reasons. Two runs on one workspace are allowed to overlap — a session-start build and an
 * explicit `codegraph_index`, or a watcher rebuild — and a shared fixed-name `.tmp` makes the loser's
 * `rename` fail with ENOENT after the winner moved it, turning a harmless duplicate run into a failed
 * call. Same-directory is what makes the `rename` atomic: it is a metadata operation on one
 * filesystem, so a reader sees either the previous document or the new one, never a half-written one.
 * @param target - absolute path of the file to replace.
 * @param value - the value to serialize as JSON.
 */
export async function writeJsonAtomically(target: string, value: unknown): Promise<void> {
  const temp = `${target}.tmp-${process.pid}-${randomUUID()}`
  await writeFile(temp, JSON.stringify(value))
  await renameWithRetry(temp, target)
}

/**
 * Write the prompt-time status sidecar beside the graph, replacing it atomically.
 *
 * Deliberately after the graph's own rename: a reader that sees this file can trust that the graph it
 * summarizes is already in place, which is what lets a prompt line report "336 files, built 12s ago"
 * without opening SQLite on every model request.
 * @param directory - the graph's directory (`.codegraph`).
 * @param status - this run's summary.
 */
async function writeStatusFile(directory: string, status: IndexStatusFile): Promise<void> {
  await writeJsonAtomically(join(directory, basename(INDEX_STATUS_RELATIVE_PATH)), status)
}
