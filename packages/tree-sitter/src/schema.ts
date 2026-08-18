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

import { mkdir, rename, rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
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
  readonly indexedAt: number
}

/** Remove a database file and its WAL/SHM sidecars, tolerating any of the three being absent. */
async function removeGraphFiles(path: string): Promise<void> {
  await rm(path, { force: true })
  await rm(`${path}-wal`, { force: true })
  await rm(`${path}-shm`, { force: true })
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
  await rename(tempPath, databasePath)
  // rename() only moves the main file; the temp name's own sidecars (should the driver have left any)
  // never travel with it and would otherwise linger under the temp name forever.
  await removeGraphFiles(tempPath)
}
