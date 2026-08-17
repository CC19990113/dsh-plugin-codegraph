import { mkdtemp, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { SCHEMA_VERSION, writeGraph } from '../src/schema.ts'
import type { ExtractedFile, GraphEdge, GraphNode, UnresolvedRef } from '../src/resolve.ts'

const NOW = 1700000000000

const FILE: ExtractedFile = {
  path: 'a.ts',
  language: 'typescript',
  size: 42,
  modifiedAt: NOW,
  contentHash: 'deadbeef',
  lineCount: 3,
  extraction: { definitions: [], calls: [], imports: [] },
}

const NODES: GraphNode[] = [
  {
    id: 'file:a.ts', kind: 'file', name: 'a.ts', qualifiedName: 'a.ts', filePath: 'a.ts', language: 'typescript',
    startLine: 1, endLine: 3, startColumn: 0, endColumn: 0, isExported: false, isAsync: false, isStatic: false, updatedAt: NOW,
  },
  {
    id: 'a.ts:1:0', kind: 'function', name: 'foo', qualifiedName: 'a.ts::foo', filePath: 'a.ts', language: 'typescript',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, isExported: true, isAsync: true, isStatic: true, updatedAt: NOW,
  },
]

const EDGES: GraphEdge[] = [
  { source: 'file:a.ts', target: 'a.ts:1:0', kind: 'contains', provenance: 'tree-sitter' },
]

const UNRESOLVED: UnresolvedRef[] = [
  { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'mystery', line: 5, col: 1 },
]

async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-tree-sitter-schema-'))
  return join(root, '.codegraph', 'codegraph.db')
}

describe('writeGraph', () => {
  it('creates the parent directory and writes a readable schema-v4 database', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    const db = new DatabaseSync(path, { readOnly: true })
    const version = db.prepare('SELECT MAX(version) AS v FROM schema_versions').get() as { v: number }
    expect(version.v).toBe(SCHEMA_VERSION)
    db.close()
  })

  it('writes every node, edge, file, and unresolved-ref row', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('SELECT count(*) AS c FROM nodes').get()).toEqual({ c: 2 })
    expect(db.prepare('SELECT count(*) AS c FROM edges').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT count(*) AS c FROM files').get()).toEqual({ c: 1 })
    expect(db.prepare('SELECT count(*) AS c FROM unresolved_refs').get()).toEqual({ c: 1 })
    const file = db.prepare('SELECT content_hash, node_count FROM files WHERE path = ?').get('a.ts') as
      { content_hash: string; node_count: number }
    // The file node itself is not counted; only the one declaration node is.
    expect(file).toEqual({ content_hash: 'deadbeef', node_count: 1 })
    db.close()
  })

  it('is queryable through FTS5 by name', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: [], indexedAt: NOW })
    const db = new DatabaseSync(path, { readOnly: true })
    const match = db.prepare("SELECT id FROM nodes_fts WHERE nodes_fts MATCH 'foo'").get() as { id: string }
    expect(match.id).toBe('a.ts:1:0')
    db.close()
  })

  it('replaces whatever was at the path on a second run', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    await writeGraph(path, { files: [], nodes: [], edges: [], unresolved: [], indexedAt: NOW + 1 })
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('SELECT count(*) AS c FROM nodes').get()).toEqual({ c: 0 })
    expect(db.prepare('SELECT MAX(applied_at) AS a FROM schema_versions').get()).toEqual({ a: NOW + 1 })
    db.close()
  })

  it('records node_count 0 for a file with no declaration nodes', async () => {
    const path = await tempDatabasePath()
    const emptyFile = { ...FILE, path: 'empty.ts' }
    await writeGraph(path, { files: [emptyFile], nodes: [], edges: [], unresolved: [], indexedAt: NOW })
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('SELECT node_count FROM files WHERE path = ?').get('empty.ts')).toEqual({ node_count: 0 })
    db.close()
  })

  it('rethrows when a write violates the schema, leaving no file behind on a first write', async () => {
    const path = await tempDatabasePath()
    const duplicateNodes = [NODES[0]!, NODES[0]!]
    await expect(writeGraph(path, { files: [FILE], nodes: duplicateNodes, edges: [], unresolved: [], indexedAt: NOW }))
      .rejects.toThrow()
    // The build happens on a temp file that is only renamed into place on success; a failed first
    // write never creates `path` at all, rather than leaving a schema-only, zero-row database there.
    await expect(readdir(dirname(path))).resolves.toEqual([])
  })

  it('leaves a previously written graph untouched when a later write fails', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    const duplicateNodes = [NODES[0]!, NODES[0]!]
    await expect(writeGraph(path, { files: [FILE], nodes: duplicateNodes, edges: [], unresolved: [], indexedAt: NOW + 1 }))
      .rejects.toThrow()
    const db = new DatabaseSync(path, { readOnly: true })
    // The failed write built and discarded its own temp file; it never touched the live database.
    expect(db.prepare('SELECT count(*) AS c FROM nodes').get()).toEqual({ c: 2 })
    expect(db.prepare('SELECT MAX(applied_at) AS a FROM schema_versions').get()).toEqual({ a: NOW })
    db.close()
  })

  it('leaves no temp file behind after a successful write or a failed one', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    const duplicateNodes = [NODES[0]!, NODES[0]!]
    await expect(writeGraph(path, { files: [FILE], nodes: duplicateNodes, edges: [], unresolved: [], indexedAt: NOW + 1 }))
      .rejects.toThrow()
    const entries = await readdir(dirname(path))
    expect(entries).toEqual(['codegraph.db'])
  })
})
