import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, { CodegraphError } from 'dsh-plugin-codegraph-service'
import * as CodegraphTreeSitter from '../src/index.ts'
import { DATABASE_RELATIVE_PATH, DEFAULT_INDEXER_ID } from '../src/index.ts'
import { writeProject } from './fixture.ts'

async function seam(config?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Codegraph)
  await ctx.plugin(CodegraphTreeSitter, config)
  return ctx
}

describe('codegraph-tree-sitter plugin', () => {
  it('registers under the default indexer id', async () => {
    const ctx = await seam()
    const report = await ctx.codegraph.index(await writeProject({ 'a.ts': 'export function foo() {}\n' }))
    expect(report.filesIndexed).toBe(1)
  })

  it('rejects a duplicate indexer id when mounted twice with the same id', async () => {
    const ctx = await seam()
    await expect(ctx.plugin(CodegraphTreeSitter)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
  })

  it('reports it cannot index a path that does not exist', async () => {
    const ctx = await seam()
    await expect(ctx.codegraph.index('/does/not/exist')).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_NO_INDEXER' }),
    )
  })

  it('reports it cannot index a path that is a file, not a directory', async () => {
    const root = await writeProject({ 'a.ts': 'export function foo() {}\n' })
    const ctx = await seam()
    await expect(ctx.codegraph.index(`${root}/a.ts`)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_NO_INDEXER' }),
    )
  })

  it('writes a graph that ctx.codegraph.available() reports once a store is registered over it', async () => {
    const root = await writeProject({
      'src/a.ts': "import { b } from './b'\nexport function a() { return b() }\n",
      'src/b.ts': 'export function b() { return 1 }\n',
    })
    const ctx = await seam()
    await expect(ctx.codegraph.available(root)).resolves.toBe(false)
    const report = await ctx.codegraph.index(root)
    expect(report).toMatchObject({
      projectRoot: root,
      filesIndexed: 2,
      filesSkipped: 0,
      unresolvedCount: 0,
      unresolvedLikelyInternalCount: 0,
      languages: [{ language: 'typescript', fileCount: 2 }],
    })
    expect(report.nodeCount).toBeGreaterThan(0)
    expect(report.edgeCount).toBeGreaterThan(0)

    const CodegraphSqlite = await import('dsh-plugin-codegraph-sqlite')
    await ctx.plugin(CodegraphSqlite)
    await expect(ctx.codegraph.available(root)).resolves.toBe(true)
    const status = await ctx.codegraph.query({ operation: 'status', projectRoot: root })
    expect(status).toMatchObject({ fileCount: 2, formatVersion: 4 })
    const search = await ctx.codegraph.query({ operation: 'search', projectRoot: root, query: 'a', limit: 10 })
    expect(search.nodes.some(node => node.name === 'a')).toBe(true)
  })

  it('separates likely-external noise from genuine gaps in the unresolved count', async () => {
    const root = await writeProject({
      'a.ts': "import { expect } from 'vitest'\nexport function a() {\n  expect(1).toBe(1)\n  return nowhere()\n}\n",
    })
    const ctx = await seam()
    const report = await ctx.codegraph.index(root)
    // `expect` (imported, unresolved) and `toBe` (member call) are noise; `nowhere` is the one call
    // shaped like a genuine workspace-internal gap.
    expect(report.unresolvedCount).toBe(3)
    expect(report.unresolvedLikelyInternalCount).toBe(1)
  })

  it('reflects a second, in-session index() in a store connection opened before it ran', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam()
    await ctx.codegraph.index(root)
    const CodegraphSqlite = await import('dsh-plugin-codegraph-sqlite')
    await ctx.plugin(CodegraphSqlite)
    // Open (and cache) a store connection against the first graph before anything changes on disk.
    const before = await ctx.codegraph.query({ operation: 'search', projectRoot: root, query: 'first', limit: 10 })
    expect(before.nodes.some(node => node.name === 'first')).toBe(true)

    await import('node:fs/promises').then(fs => fs.writeFile(`${root}/a.ts`, 'export function second() {}\n'))
    await ctx.codegraph.index(root)

    // The same session, same store instance, no reconnect on the caller's part: this must not read
    // back the graph the pooled connection was opened against before the rebuild.
    const after = await ctx.codegraph.query({ operation: 'search', projectRoot: root, query: 'first', limit: 10 })
    expect(after.nodes.some(node => node.name === 'first')).toBe(false)
    const updated = await ctx.codegraph.query({ operation: 'search', projectRoot: root, query: 'second', limit: 10 })
    expect(updated.nodes.some(node => node.name === 'second')).toBe(true)
  })

  it('exposes the on-disk path this package writes, matching the store\'s own constant', async () => {
    const { DATABASE_RELATIVE_PATH: storePath } = await import('dsh-plugin-codegraph-sqlite')
    expect(DATABASE_RELATIVE_PATH).toBe(storePath)
  })

  it('rejects a non-positive-integer bound at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    await expect(ctx.plugin(CodegraphTreeSitter, { maxFiles: 0 })).rejects.toThrow(/maxFiles/)
  })

  it('replaces a previous run\'s graph rather than merging with it', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam()
    await ctx.codegraph.index(root)
    await import('node:fs/promises').then(fs => fs.writeFile(`${root}/a.ts`, 'export function second() {}\n'))
    await ctx.codegraph.index(root)
    const db = new DatabaseSync(`${root}/.codegraph/codegraph.db`, { readOnly: true })
    const names = db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[]
    expect(names.map(row => row.name)).toEqual(['second'])
    db.close()
  })

  it('orders equal-count languages alphabetically in the report', async () => {
    const root = await writeProject({ 'a.py': 'def a():\n    pass\n', 'b.go': 'package main\nfunc b() {}\n' })
    const ctx = await seam()
    const report = await ctx.codegraph.index(root)
    expect(report.languages).toEqual([{ language: 'go', fileCount: 1 }, { language: 'python', fileCount: 1 }])
  })

  it('excludes what the project .gitignore names by default, unioned with the built-in exclude list', async () => {
    const root = await writeProject({
      '.gitignore': 'lib/\n',
      'src/a.ts': 'export function a() {}\n',
      'lib/a.ts': 'export function compiled() {}\n',
    })
    const ctx = await seam()
    const report = await ctx.codegraph.index(root)
    expect(report.filesIndexed).toBe(1)
  })

  it('indexes gitignored paths too when respectGitignore is false', async () => {
    const root = await writeProject({
      '.gitignore': 'lib/\n',
      'src/a.ts': 'export function a() {}\n',
      'lib/a.ts': 'export function compiled() {}\n',
    })
    const ctx = await seam({ respectGitignore: false })
    const report = await ctx.codegraph.index(root)
    expect(report.filesIndexed).toBe(2)
  })

  it('uses the configured indexer id', async () => {
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    await ctx.plugin(CodegraphTreeSitter, { indexerId: 'custom-id' })
    expect(DEFAULT_INDEXER_ID).toBe('codegraph-tree-sitter')
    const root = await writeProject({ 'a.ts': 'export function foo() {}\n' })
    await expect(ctx.codegraph.index(root)).resolves.toMatchObject({ filesIndexed: 1 })
  })
})
