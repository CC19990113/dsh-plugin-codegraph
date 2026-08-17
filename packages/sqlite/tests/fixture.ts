// A schema-v4 knowledge graph built in a temp directory, so every test runs against the real
// on-disk format rather than a stand-in: the store's SQL, its FTS5 search, and its format-version
// gate are all exercised exactly as they are against an index the external indexer wrote.
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { DATABASE_RELATIVE_PATH } from '../src/database.ts'

/** The subset of schema v4 the store reads, verbatim in structure from the format it targets. */
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
`

/** One node to seed, with the columns a test cares about. */
interface SeedNode {
  id: string
  kind: string
  name: string
  qualifiedName?: string
  filePath: string
  language?: string
  startLine?: number
  endLine?: number
  signature?: string
  docstring?: string
  isExported?: boolean
}

/** One edge to seed. */
interface SeedEdge {
  source: string
  target: string
  kind: string
  line?: number
}

/** One indexed file to seed. */
interface SeedFile {
  path: string
  language?: string
  size?: number
  nodeCount?: number
  /** Source text written to disk alongside the graph, for the operations that read code. */
  text?: string
  /**
   * Epoch milliseconds to record as the index's `modified_at` for this file. Defaults to the real
   * on-disk mtime when `text` is given (so a freshly written seed file reads as fresh, not stale),
   * or to `10` when `text` is omitted, since a file with no `text` is never written to disk and is
   * therefore always "missing" from a staleness check's point of view regardless of this value.
   */
  modifiedAt?: number
}

/** What a seeded project contains. */
export interface Seed {
  nodes?: SeedNode[]
  edges?: SeedEdge[]
  files?: SeedFile[]
  /** Schema version to record; defaults to the supported one. */
  formatVersion?: number
}

/**
 * Create a project directory holding a schema-v4 graph and its source files.
 * @param seed - the graph and files to write.
 * @returns the absolute project root.
 */
export async function seedProject(seed: Seed): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-'))
  await mkdir(join(root, '.codegraph'), { recursive: true })
  const db = new DatabaseSync(join(root, DATABASE_RELATIVE_PATH))
  db.exec(SCHEMA)
  db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)')
    .run(seed.formatVersion ?? 4, 1, 'test fixture')

  const insertNode = db.prepare(`INSERT INTO nodes
    (id, kind, name, qualified_name, file_path, language, start_line, end_line, start_column,
     end_column, docstring, signature, visibility, is_exported, is_async, is_static, is_abstract,
     decorators, type_parameters, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, 0, ?, ?, NULL, ?, 0, 0, 0, NULL, NULL, 1)`)
  for (const node of seed.nodes ?? []) {
    insertNode.run(
      node.id, node.kind, node.name, node.qualifiedName ?? node.name, node.filePath,
      node.language ?? 'typescript', node.startLine ?? 1, node.endLine ?? (node.startLine ?? 1) + 2,
      node.docstring ?? null, node.signature ?? null, node.isExported === true ? 1 : 0,
    )
  }

  const insertEdge = db.prepare('INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)')
  for (const edge of seed.edges ?? []) {
    // A relationship the indexer could not place carries neither coordinate.
    insertEdge.run(edge.source, edge.target, edge.kind, edge.line ?? null, edge.line === undefined ? null : 0)
  }

  const insertFile = db.prepare(`INSERT INTO files
    (path, content_hash, language, size, modified_at, indexed_at, node_count)
    VALUES (?, 'hash', ?, ?, ?, 20, ?)`)
  for (const file of seed.files ?? []) {
    let modifiedAt = file.modifiedAt ?? 10
    if (file.text !== undefined) {
      const absolute = join(root, file.path)
      await mkdir(join(absolute, '..'), { recursive: true })
      await writeFile(absolute, file.text)
      // Ceiling rather than rounding: the index's own `modified_at` must be at or after the real
      // mtime it captured, or a fractional-millisecond mtime rounded down would read back as newer
      // than what the index recorded and register as a false-positive stale file.
      if (file.modifiedAt === undefined) modifiedAt = Math.ceil((await stat(absolute)).mtimeMs)
    }
    insertFile.run(file.path, file.language ?? 'typescript', file.size ?? 100, modifiedAt, file.nodeCount ?? 0)
  }
  db.close()
  return root
}
