import { mkdtemp, readdir, rename } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { SCHEMA_VERSION, writeGraph } from '../src/schema.ts'
import type { ExtractedFile, GraphEdge, GraphNode, UnresolvedRef } from '../src/resolve.ts'

// Only `rename` is replaced: the replace-retry behavior under test reacts to the refusals Windows
// reports while some handle holds the target open, and provoking one of those for real needs a
// held handle the test cannot arrange portably. Everything else stays the real fs.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return { ...actual, rename: vi.fn(actual.rename) }
})

const realRename = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).rename

beforeEach(() => {
  vi.mocked(rename).mockClear()
  vi.mocked(rename).mockImplementation(realRename)
})

const NOW = 1700000000000

const FILE: ExtractedFile = {
  path: 'a.ts',
  language: 'typescript',
  size: 42,
  modifiedAt: NOW,
  contentHash: 'deadbeef',
  lineCount: 3,
  extraction: { definitions: [], calls: [], imports: [], heritage: [] },
}

const NODES: GraphNode[] = [
  {
    id: 'file:a.ts', kind: 'file', name: 'a.ts', qualifiedName: 'a.ts', filePath: 'a.ts', language: 'typescript',
    startLine: 1, endLine: 3, startColumn: 0, endColumn: 0, isExported: false, isAsync: false, isStatic: false,
    decorators: [], updatedAt: NOW,
  },
  {
    id: 'a.ts:1:0', kind: 'function', name: 'foo', qualifiedName: 'a.ts::foo', filePath: 'a.ts', language: 'typescript',
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, isExported: true, isAsync: true, isStatic: true,
    decorators: ['staticmethod'], updatedAt: NOW,
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
    const decorators = db.prepare('SELECT decorators FROM nodes WHERE id = ?').get('a.ts:1:0') as { decorators: string }
    expect(JSON.parse(decorators.decorators)).toEqual(['staticmethod'])
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

  it('replaces the graph even when the rename is refused once, as Windows does while a reader holds the old file', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    // One refused attempt — a reader that raced this rebuild still holding the old file — then the
    // retry lands: one busy reader must not fail an index run.
    vi.mocked(rename).mockImplementationOnce(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })
    await expect(writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW + 1 }))
      .resolves.toBeUndefined()
    const db = new DatabaseSync(path, { readOnly: true })
    expect(db.prepare('SELECT MAX(applied_at) AS a FROM schema_versions').get()).toEqual({ a: NOW + 1 })
    db.close()
    // And the refused attempt left no temp file behind.
    expect(await readdir(dirname(path))).toEqual(['codegraph.db'])
  })

  it('fails loud when the rename keeps being refused, still leaving no temp file behind', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, { files: [FILE], nodes: NODES, edges: EDGES, unresolved: UNRESOLVED, indexedAt: NOW })
    // A holder that never lets go — the external codegraph CLI's daemon, or an antivirus scan that
    // outlasts every backoff step — surfaces as a failed run, never as a silently lost rebuild.
    vi.mocked(rename).mockImplementation(async () => {
      throw Object.assign(new Error('EPERM: operation not permitted, rename'), { code: 'EPERM' })
    })
    await expect(writeGraph(path, { files: [], nodes: [], edges: [], unresolved: [], indexedAt: NOW + 1 }))
      .rejects.toThrow(/EPERM/)
    const db = new DatabaseSync(path, { readOnly: true })
    // The previously written graph is untouched.
    expect(db.prepare('SELECT count(*) AS c FROM nodes').get()).toEqual({ c: 2 })
    db.close()
    expect(await readdir(dirname(path))).toEqual(['codegraph.db'])
  })
})
