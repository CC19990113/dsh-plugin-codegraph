import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, { CodegraphNodeId } from 'dsh-plugin-codegraph-service'
import type { CodegraphError } from 'dsh-plugin-codegraph-service'
import * as CodegraphSqlite from '../src/index.ts'
import { DATABASE_RELATIVE_PATH, GraphPool, databasePath, openGraph } from '../src/database.ts'
import { toEdge, toFile, toNode } from '../src/rows.ts'
import { ftsPhrase, likeAnywhere } from '../src/sql.ts'
import { walkImpact, walkTrace } from '../src/traverse.ts'
import { files, impact, node, relations, search, status, trace } from '../src/queries.ts'
import { seedProject } from './fixture.ts'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function project(seed: Parameters<typeof seedProject>[0]): Promise<string> {
  const root = await seedProject(seed)
  roots.push(root)
  return root
}

/** A two-file graph: `main` calls `helper` twice, `orphan` is unreferenced. */
const SEED = {
  nodes: [
    { id: 'file:app', kind: 'file', name: 'app.ts', qualifiedName: 'src/app.ts', filePath: 'src/app.ts' },
    { id: 'fn:main', kind: 'function', name: 'main', filePath: 'src/app.ts', startLine: 1, endLine: 4, isExported: true },
    { id: 'fn:helper', kind: 'function', name: 'helper', filePath: 'src/util.ts', startLine: 2, endLine: 4, isExported: true, docstring: 'Does the work.', signature: '(): void' },
    { id: 'import:helper', kind: 'import', name: 'helper', filePath: 'src/app.ts', startLine: 1, endLine: 1 },
    { id: 'fn:orphan', kind: 'function', name: 'orphan', filePath: 'src/util.ts', startLine: 8, endLine: 9 },
    { id: 'py:helper', kind: 'function', name: 'helper', qualifiedName: 'py::helper', filePath: 'tool.py', language: 'python', startLine: 1, endLine: 2 },
  ],
  edges: [
    { source: 'file:app', target: 'fn:main', kind: 'contains' },
    { source: 'fn:main', target: 'fn:helper', kind: 'calls', line: 2 },
    { source: 'fn:main', target: 'fn:helper', kind: 'calls', line: 3 },
    { source: 'fn:helper', target: 'fn:orphan', kind: 'references', line: 3 },
  ],
  files: [
    { path: 'src/app.ts', nodeCount: 3 },
    { path: 'src/util.ts', nodeCount: 2 },
    { path: 'tool.py', language: 'python', nodeCount: 1 },
  ],
}

const AT = (root: string) => ({ projectRoot: root })

describe('graph database', () => {
  it('reports the database path a project root resolves to', () => {
    expect(databasePath('/repo')).toBe(join('/repo', DATABASE_RELATIVE_PATH))
  })

  it('fails as unavailable when the project has no graph', async () => {
    const root = await project({})
    await rm(databasePath(root))
    expect(() => openGraph(root)).toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_UNAVAILABLE' }),
    )
  })

  it('refuses a graph written in another format version', async () => {
    const root = await project({ formatVersion: 3 })
    expect(() => openGraph(root)).toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_UNSUPPORTED_FORMAT' }),
    )
  })

  it('refuses a graph that records no version at all', async () => {
    const root = await project({})
    const db = new DatabaseSync(databasePath(root))
    db.exec('DELETE FROM schema_versions')
    db.close()
    expect(() => openGraph(root)).toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_MALFORMED_INDEX' }),
    )
  })

  it('reuses a pooled connection and evicts the least recently used one', async () => {
    const first = await project(SEED)
    const second = await project(SEED)
    const pool = new GraphPool(1)
    const a = pool.acquire(first)
    // A cache hit returns the same live connection rather than reopening the file.
    expect(pool.acquire(first) === a).toBe(true)
    const b = pool.acquire(second)
    // Eviction CLOSES the connection it drops; a leaked-but-forgotten handle would still work.
    expect(() => a.prepare('SELECT 1')).toThrow(/not open/)
    expect(pool.acquire(first) === a).toBe(false)
    pool.close()
    expect(() => b.prepare('SELECT 1')).toThrow(/not open/)
    expect(() => pool.acquire(first)).toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_DISPOSED' }),
    )
  })
})

describe('durable row mapping', () => {
  const base = {
    id: 'n', kind: 'function', name: 'n', qualified_name: 'n', file_path: 'a.ts', language: 'typescript',
    start_line: 1, end_line: 2, start_column: 0, end_column: 0, docstring: null, signature: null,
    visibility: null, is_exported: 1, is_async: 0, is_static: 0, is_abstract: 0,
    decorators: null, type_parameters: null, updated_at: 1,
  }

  it('normalizes absent optional values instead of surfacing null', () => {
    const mapped = toNode(base)
    expect(mapped.docstring).toBeUndefined()
    expect(mapped.decorators).toEqual([])
    expect(mapped.isExported).toBe(true)
    expect(mapped.isAsync).toBe(false)
  })

  it('parses JSON array columns', () => {
    const mapped = toNode({ ...base, decorators: '["@Inject"]', is_async: 1 })
    expect(mapped.decorators).toEqual(['@Inject'])
    expect(mapped.isAsync).toBe(true)
  })

  it.each([
    ['a non-text column', { ...base, name: 7 }, /non-text "name"/],
    ['a non-integer column', { ...base, start_line: 'one' }, /non-integer "start_line"/],
    ['a non-text optional column', { ...base, docstring: 7 }, /non-text "docstring"/],
    ['unparseable JSON', { ...base, decorators: '[' }, /unparseable "decorators"/],
    ['a non-array JSON value', { ...base, decorators: '{}' }, /non-string-array "decorators"/],
    ['a JSON array of non-strings', { ...base, decorators: '[1]' }, /non-string-array "decorators"/],
  ])('fails loud on %s', (_label, row, pattern) => {
    expect(() => toNode(row)).toThrow(pattern)
  })

  it('maps edges and files, treating a NULL site as absent', () => {
    const edge = toEdge({
      edge_source: 'a', edge_target: 'b', edge_kind: 'calls',
      edge_line: null, edge_col: 3, edge_provenance: 'tree-sitter',
    })
    expect(edge).toEqual({ source: 'a', target: 'b', kind: 'calls', column: 3, provenance: 'tree-sitter' })
    expect(toFile({
      path: 'a.ts', language: 'typescript', size: 1, node_count: 2, modified_at: 3, indexed_at: 4,
    })).toEqual({ path: 'a.ts', language: 'typescript', size: 1, nodeCount: 2, modifiedAt: 3, indexedAt: 4 })
  })
})

describe('query text escaping', () => {
  it('makes an arbitrary string one literal FTS phrase', () => {
    expect(ftsPhrase('a AND "b"')).toBe('"a AND ""b"""*')
  })

  it('escapes LIKE wildcards so they match literally', () => {
    expect(likeAnywhere('a_b%c\\d')).toBe('%a\\_b\\%c\\\\d%')
  })
})

describe('graph queries', () => {
  it('ranks a declaration above a same-named import and reports alternatives', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const result = node(db, { operation: 'node', ...AT(root), symbol: 'helper', limit: 5 })
    expect(result.node?.filePath).toBe('src/util.ts')
    expect(result.node?.kind).toBe('function')
    expect(result.alternatives.map(entry => entry.kind)).toContain('import')
    expect(result.incoming.map(relation => relation.node.name)).toContain('main')
    expect(result.outgoing.map(relation => relation.node.name)).toContain('orphan')
    db.close()
  })

  it('answers a name that matches nothing with a null subject', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    expect(node(db, { operation: 'node', ...AT(root), symbol: 'absent', limit: 5 }).node).toBeNull()
    expect(relations(db, { operation: 'callers', ...AT(root), symbol: 'absent', limit: 5 }).subject).toBeNull()
    expect(impact(db, { operation: 'impact', ...AT(root), symbol: 'absent', depth: 2, limit: 5 },
      (origin, depth) => walkImpact(db, origin, depth, 100)).subject).toBeNull()
    expect(trace(db, { operation: 'trace', ...AT(root), from: 'absent', to: 'main', maxDepth: 3, maxPaths: 2 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100)).paths).toEqual([])
    db.close()
  })

  it('collapses repeated call sites into one counted relation', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const callers = relations(db, { operation: 'callers', ...AT(root), symbol: 'helper', limit: 5 })
    expect(callers.relations).toHaveLength(1)
    expect(callers.relations[0]?.siteCount).toBe(2)
    expect(callers.relations[0]?.edge.line).toBe(2)
    expect(callers.total).toBe(1)
    expect(callers.truncated).toBe(false)
    const callees = relations(db, { operation: 'callees', ...AT(root), symbol: 'main', limit: 5 })
    expect(callees.relations.map(relation => relation.node.name)).toEqual(['helper'])
    db.close()
  })

  it('reports truncation when the limit cuts the answer', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const result = search(db, { operation: 'search', ...AT(root), query: 'helper', limit: 1 })
    expect(result.nodes).toHaveLength(1)
    expect(result.total).toBeGreaterThan(1)
    expect(result.truncated).toBe(true)
    db.close()
  })

  it('filters search by kind and language', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const byKind = search(db, { operation: 'search', ...AT(root), query: 'helper', kind: 'import', limit: 10 })
    expect(byKind.nodes.map(entry => entry.kind)).toEqual(['import'])
    const byLanguage = search(db, { operation: 'search', ...AT(root), query: 'helper', language: 'python', limit: 10 })
    expect(byLanguage.nodes.map(entry => entry.filePath)).toEqual(['tool.py'])
    db.close()
  })

  it('walks dependents outward and stops at the requested depth', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const deep = impact(db, { operation: 'impact', ...AT(root), symbol: 'orphan', depth: 2, limit: 10 },
      (origin, depth) => walkImpact(db, origin, depth, 100))
    expect(deep.entries.map(entry => [entry.node.name, entry.distance]))
      .toEqual([['helper', 1], ['main', 2]])
    const shallow = impact(db, { operation: 'impact', ...AT(root), symbol: 'orphan', depth: 1, limit: 10 },
      (origin, depth) => walkImpact(db, origin, depth, 100))
    expect(shallow.entries.map(entry => entry.node.name)).toEqual(['helper'])
    db.close()
  })

  it('marks an impact answer truncated when the traversal budget runs out', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const result = impact(db, { operation: 'impact', ...AT(root), symbol: 'orphan', depth: 5, limit: 10 },
      (origin, depth) => walkImpact(db, origin, depth, 1))
    expect(result.truncated).toBe(true)
    db.close()
  })

  it('traces a path, and reports an empty path list for the reverse direction', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const forward = trace(db, { operation: 'trace', ...AT(root), from: 'main', to: 'orphan', maxDepth: 4, maxPaths: 3 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100))
    expect(forward.paths).toHaveLength(1)
    expect(forward.paths[0]?.map(hop => hop.node.name)).toEqual(['main', 'helper', 'orphan'])
    const backward = trace(db, { operation: 'trace', ...AT(root), from: 'orphan', to: 'main', maxDepth: 4, maxPaths: 3 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100))
    expect(backward.paths).toEqual([])
    db.close()
  })

  it('treats a symbol traced to itself as a zero-hop path', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const result = trace(db, { operation: 'trace', ...AT(root), from: 'main', to: 'main', maxDepth: 3, maxPaths: 2 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100))
    expect(result.paths).toEqual([[{ node: result.from }]])
    db.close()
  })

  it('stops a trace sweep at its visit budget', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const paths = walkTrace(db, CodegraphNodeId('fn:main'), CodegraphNodeId('fn:orphan'), 5, 3, 1)
    expect(paths).toEqual([])
    db.close()
  })

  it('lists files by subtree and by glob', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    expect(files(db, { operation: 'files', ...AT(root), path: 'src/', limit: 10 }).files.map(f => f.path))
      .toEqual(['src/app.ts', 'src/util.ts'])
    expect(files(db, { operation: 'files', ...AT(root), pattern: '*.py', limit: 10 }).files.map(f => f.path))
      .toEqual(['tool.py'])
    const capped = files(db, { operation: 'files', ...AT(root), limit: 1 })
    expect(capped.truncated).toBe(true)
    expect(capped.total).toBe(3)
    db.close()
  })

  it('summarizes index size and freshness, and reports an empty index honestly', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const summary = status(db, root)
    expect(summary.fileCount).toBe(3)
    expect(summary.nodeCount).toBe(6)
    expect(summary.edgeCount).toBe(4)
    expect(summary.formatVersion).toBe(4)
    expect(summary.indexedAt).toBe(20)
    expect(summary.languages[0]).toEqual({ language: 'typescript', fileCount: 2 })
    db.close()

    const empty = await project({})
    const emptyDb = openGraph(empty)
    expect(status(emptyDb, empty).indexedAt).toBeNull()
    emptyDb.close()
  })
})

describe('the store plugin', () => {
  async function mount(config?: Record<string, unknown>): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(Codegraph)
    await ctx.plugin(CodegraphSqlite, config)
    return ctx
  }

  it('serves every operation for a project it indexes', async () => {
    const root = await project(SEED)
    const ctx = await mount()
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: root })).resolves
      .toMatchObject({ fileCount: 3 })
    await expect(ctx.codegraph.query({ operation: 'search', projectRoot: root, query: 'main', limit: 5 })).resolves
      .toMatchObject({ kind: 'search' })
    await expect(ctx.codegraph.query({ operation: 'node', projectRoot: root, symbol: 'main', limit: 5 })).resolves
      .toMatchObject({ kind: 'node' })
    await expect(ctx.codegraph.query({ operation: 'callers', projectRoot: root, symbol: 'helper', limit: 5 })).resolves
      .toMatchObject({ kind: 'callers' })
    await expect(ctx.codegraph.query({ operation: 'callees', projectRoot: root, symbol: 'main', limit: 5 })).resolves
      .toMatchObject({ kind: 'callees' })
    await expect(ctx.codegraph.query({ operation: 'impact', projectRoot: root, symbol: 'orphan', depth: 2, limit: 5 }))
      .resolves.toMatchObject({ kind: 'impact' })
    await expect(ctx.codegraph.query({ operation: 'trace', projectRoot: root, from: 'main', to: 'helper', maxDepth: 3, maxPaths: 2 }))
      .resolves.toMatchObject({ kind: 'trace' })
    await expect(ctx.codegraph.query({ operation: 'files', projectRoot: root, limit: 5 })).resolves
      .toMatchObject({ kind: 'files' })
  })

  it('claims only roots that carry a graph', async () => {
    const root = await project(SEED)
    const ctx = await mount()
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: root })).resolves.toBeDefined()
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: join(root, 'nowhere') }))
      .rejects.toThrow(/no code-graph store indexes/)
  })

  it('takes its store id from configuration', async () => {
    const root = await project(SEED)
    const ctx = await mount({ storeId: 'first' })
    await ctx.plugin(CodegraphSqlite, { storeId: 'second' })
    // Two stores now claim the same root, which the seam refuses to arbitrate.
    await expect(ctx.codegraph.query({ operation: 'status', projectRoot: root }))
      .rejects.toThrow(/first, second/)
  })

  it.each([
    ['maxOpenDatabases', { maxOpenDatabases: 0 }],
    ['maxTraversalNodes', { maxTraversalNodes: 1.5 }],
  ])('fails loading when %s is not a positive integer', async (field, config) => {
    await expect(mount(config)).rejects.toThrow(new RegExp(`${field} must be a positive integer`))
  })

  it('closes its connections when the plugin unloads', async () => {
    const root = await project(SEED)
    const ctx = await mount()
    await ctx.codegraph.query({ operation: 'status', projectRoot: root })
    await ctx.fiber.dispose()
    context = undefined
    // The graph file is no longer held open, so the project directory can be removed on Windows too.
    await expect(writeFile(join(root, '.codegraph', 'probe'), 'ok')).resolves.toBeUndefined()
  })
})

describe('graphs that are not internally consistent', () => {
  /** A graph whose edges reach node ids the `nodes` table never defined. */
  const DANGLING = {
    nodes: [
      { id: 'fn:live', kind: 'function', name: 'live', filePath: 'a.ts', startLine: 1, endLine: 2 },
      { id: 'fn:seen', kind: 'function', name: 'seen', filePath: 'a.ts', startLine: 4, endLine: 5 },
    ],
    edges: [
      { source: 'fn:ghost', target: 'fn:live', kind: 'calls', line: 1 },
      { source: 'fn:live', target: 'fn:ghost', kind: 'calls', line: 2 },
      { source: 'fn:ghost', target: 'fn:seen', kind: 'calls', line: 3 },
    ],
    files: [{ path: 'a.ts', nodeCount: 2 }],
  }

  it('skips an affected node whose row is missing rather than failing the walk', async () => {
    const root = await project(DANGLING)
    const db = openGraph(root)
    const result = impact(db, { operation: 'impact', ...AT(root), symbol: 'live', depth: 2, limit: 10 },
      (origin, depth) => walkImpact(db, origin, depth, 100))
    // The walk reached the dangling source, so the count exceeds what could be rendered.
    expect(result.entries).toEqual([])
    expect(result.total).toBe(1)
    expect(result.truncated).toBe(true)
    db.close()
  })

  it('drops a traced path that runs through a missing node', async () => {
    const root = await project(DANGLING)
    const db = openGraph(root)
    const result = trace(db, { operation: 'trace', ...AT(root), from: 'live', to: 'seen', maxDepth: 3, maxPaths: 3 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100))
    expect(result.from?.name).toBe('live')
    expect(result.paths).toEqual([])
    db.close()
  })

  it('fails loud on a malformed language summary', async () => {
    const root = await project(DANGLING)
    const write = new DatabaseSync(databasePath(root))
    // A BLOB is the one value TEXT affinity does not convert, so it survives the NOT NULL
    // constraint and reaches the mapper as the wrong type — exactly the durable corruption the
    // check exists for.
    write.exec("UPDATE files SET language = x'07' WHERE path = 'a.ts'")
    write.close()
    const db = openGraph(root)
    expect(() => status(db, root)).toThrow(/malformed language summary/)
    db.close()
  })
})

describe('trace sweeps over branching graphs', () => {
  /** Two equally short routes from `start` to `end`, plus a longer detour. */
  const BRANCHES = {
    nodes: [
      { id: 'fn:start', kind: 'function', name: 'start', filePath: 'a.ts', startLine: 1, endLine: 2 },
      { id: 'fn:left', kind: 'function', name: 'left', filePath: 'a.ts', startLine: 4, endLine: 5 },
      { id: 'fn:right', kind: 'function', name: 'right', filePath: 'a.ts', startLine: 7, endLine: 8 },
      { id: 'fn:end', kind: 'function', name: 'end', filePath: 'a.ts', startLine: 10, endLine: 11 },
    ],
    edges: [
      { source: 'fn:start', target: 'fn:left', kind: 'calls', line: 1 },
      { source: 'fn:start', target: 'fn:right', kind: 'calls', line: 2 },
      { source: 'fn:left', target: 'fn:end', kind: 'calls', line: 4 },
      { source: 'fn:right', target: 'fn:end', kind: 'calls', line: 7 },
      // A second arrival at `end` from an already-known node at the same depth.
      { source: 'fn:right', target: 'fn:end', kind: 'references', line: 8 },
      // A back edge to an earlier depth, which the sweep must not follow again.
      { source: 'fn:end', target: 'fn:left', kind: 'calls', line: 10 },
    ],
    files: [{ path: 'a.ts', nodeCount: 4 }],
  }

  it('enumerates every shortest route and stops at maxPaths', async () => {
    const root = await project(BRANCHES)
    const db = openGraph(root)
    const both = walkTrace(db, CodegraphNodeId('fn:start'), CodegraphNodeId('fn:end'), 4, 5, 100)
    expect(both.map(path => path.map(step => step.node)))
      .toEqual([['fn:left', 'fn:end'], ['fn:right', 'fn:end']])
    const capped = walkTrace(db, CodegraphNodeId('fn:start'), CodegraphNodeId('fn:end'), 4, 1, 100)
    expect(capped).toHaveLength(1)
    db.close()
  })

  it('returns the routes it already found when the budget runs out mid-sweep', async () => {
    const root = await project(BRANCHES)
    const db = openGraph(root)
    const paths = walkTrace(db, CodegraphNodeId('fn:start'), CodegraphNodeId('fn:left'), 4, 5, 2)
    expect(paths.map(path => path.map(step => step.node))).toEqual([['fn:left']])
    db.close()
  })
})

describe('values at the edges of the durable format', () => {
  it('carries a declared visibility through', () => {
    expect(toNode({
      id: 'n', kind: 'method', name: 'n', qualified_name: 'C.n', file_path: 'a.ts', language: 'typescript',
      start_line: 1, end_line: 2, start_column: 0, end_column: 0, docstring: null, signature: null,
      visibility: 'private', is_exported: 0, is_async: 0, is_static: 0, is_abstract: 0,
      decorators: null, type_parameters: null, updated_at: 1,
    }).visibility).toBe('private')
  })

  it('refuses to read an index timestamp outside the safe-integer range', async () => {
    const root = await project(SEED)
    const write = new DatabaseSync(databasePath(root))
    write.exec('UPDATE files SET indexed_at = 9007199254740993')
    write.close()
    const db = openGraph(root)
    // node:sqlite raises rather than silently losing precision, because this store reads plain
    // numbers; the store does not dress that up as a graph-format error it cannot distinguish.
    expect(() => status(db, root)).toThrow(RangeError)
    db.close()
  })

  it('resolves an origin but reports a destination that matches nothing', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    const result = trace(db, { operation: 'trace', ...AT(root), from: 'main', to: 'absent', maxDepth: 3, maxPaths: 2 },
      (from, to, d, p) => walkTrace(db, from, to, d, p, 100))
    expect(result.from?.name).toBe('main')
    expect(result.to).toBeNull()
    db.close()
  })

  it('traverses an edge whose site the indexer never recorded', async () => {
    const root = await project({
      nodes: [
        { id: 'file:a', kind: 'file', name: 'a.ts', qualifiedName: 'a.ts', filePath: 'a.ts' },
        { id: 'fn:inner', kind: 'function', name: 'inner', filePath: 'a.ts', startLine: 2, endLine: 3 },
      ],
      // A `contains` edge carries no call site, so both optional site columns are NULL.
      edges: [{ source: 'file:a', target: 'fn:inner', kind: 'contains' }],
      files: [{ path: 'a.ts', nodeCount: 2 }],
    })
    const db = openGraph(root)
    const paths = walkTrace(db, CodegraphNodeId('file:a'), CodegraphNodeId('fn:inner'), 2, 2, 100)
    expect(paths[0]?.[0]?.edge.line).toBeUndefined()
    expect(paths[0]?.[0]?.edge.column).toBeUndefined()
    db.close()
  })
})

describe('trace path budgets at their boundary', () => {
  it('enumerates nothing when asked for zero paths', async () => {
    const root = await project(SEED)
    const db = openGraph(root)
    expect(walkTrace(db, CodegraphNodeId('fn:main'), CodegraphNodeId('fn:helper'), 3, 0, 100)).toEqual([])
    db.close()
  })
})
