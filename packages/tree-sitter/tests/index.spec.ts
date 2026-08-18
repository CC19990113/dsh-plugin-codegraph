import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, { CodegraphError } from 'dsh-plugin-codegraph-service'
import * as CodegraphTreeSitter from '../src/index.ts'
import { DATABASE_RELATIVE_PATH, DEFAULT_INDEXER_ID } from '../src/index.ts'
import { writeProject } from './fixture.ts'

async function seam(config?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Codegraph)
  // Tests that don't care about watching stay on the old no-watch behavior; the watch-specific tests
  // below override this back to `true` via their own explicit config.
  await ctx.plugin(CodegraphTreeSitter, { watch: false, ...config })
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
    const ctx = await seam({ indexerId: 'custom-id' })
    expect(DEFAULT_INDEXER_ID).toBe('codegraph-tree-sitter')
    const root = await writeProject({ 'a.ts': 'export function foo() {}\n' })
    await expect(ctx.codegraph.index(root)).resolves.toMatchObject({ filesIndexed: 1 })
  })

  it('watches a real workspace end to end: a file edit is reflected without a manual codegraph_index', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam({ watch: true, watchDebounceMs: 200 })
    // The baseline index() this establishes is also what starts the watcher — see ensureWatching().
    await ctx.codegraph.index(root)

    const { writeFile } = await import('node:fs/promises')

    try {
      const deadline = Date.now() + 10_000
      // macOS's FSEvents stream has a brief kernel-side startup lag after fs.watch() returns; a write
      // landing in that window is silently dropped, not delayed (see NOTES.local.md's watch section).
      // Production never notices — real edits arrive well after the watcher's already warm — but this
      // test writes immediately, so it re-issues the edit every second until the rebuild is observed
      // instead of trusting the very first write reached a fully-armed watch.
      let lastWriteAt = 0
      let names: string[] = []
      do {
        if (Date.now() - lastWriteAt >= 1_000) {
          await writeFile(`${root}/a.ts`, 'export function second() {}\n')
          lastWriteAt = Date.now()
        }
        await new Promise(resolve => setTimeout(resolve, 100))
        try {
          // A fresh connection each poll, not one held open across the rebuild: this test is checking
          // that the watcher's rebuild happened at all, not re-exercising GraphPool's own reopen
          // logic (covered in the sqlite package's own tests).
          const db = new DatabaseSync(`${root}/${DATABASE_RELATIVE_PATH}`, { readOnly: true })
          try {
            names = (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
              .map(row => row.name)
          } finally {
            db.close()
          }
        } catch {
          // A vanishingly unlikely poll landing exactly mid-rename; just try again next tick.
        }
      } while (!names.includes('second') && Date.now() < deadline)
      expect(names).toEqual(['second'])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)

  it('settles after one edit instead of rebuilding forever from its own .codegraph write', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam({ watch: true, watchDebounceMs: 100 })
    await ctx.codegraph.index(root)

    const { writeFile, stat } = await import('node:fs/promises')
    const dbPath = `${root}/${DATABASE_RELATIVE_PATH}`

    try {
      // Same FSEvents startup-lag workaround as the test above: re-issue the edit every second until
      // the rebuild it causes is observed.
      const observeDeadline = Date.now() + 10_000
      let lastWriteAt = 0
      let names: string[] = []
      do {
        if (Date.now() - lastWriteAt >= 1_000) {
          await writeFile(`${root}/a.ts`, 'export function second() {}\n')
          lastWriteAt = Date.now()
        }
        await new Promise(resolve => setTimeout(resolve, 100))
        try {
          const db = new DatabaseSync(dbPath, { readOnly: true })
          try {
            names = (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
              .map(row => row.name)
          } finally {
            db.close()
          }
        } catch {
          // A vanishingly unlikely poll landing exactly mid-rename; just try again next tick.
        }
      } while (!names.includes('second') && Date.now() < observeDeadline)
      expect(names).toEqual(['second'])

      // No further edits from here on. If the watcher treated its own `writeGraph()` write to
      // `.codegraph/` as an in-scope change, it would keep re-triggering itself roughly every
      // `watchDebounceMs` forever — so watch for that instead of trusting a single sample.
      const mtimeAfterEdit = (await stat(dbPath)).mtimeMs
      await new Promise(resolve => setTimeout(resolve, 800))
      const mtimeAfterIdle = (await stat(dbPath)).mtimeMs
      expect(mtimeAfterIdle).toBe(mtimeAfterEdit)
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)

  it('watches by default when `watch` is left unset', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    // Bypasses seam()'s `watch: false` override on purpose — this is the one test asserting the
    // plugin's actual shipped default, not the opt-out most other tests here use to stay isolated.
    await ctx.plugin(CodegraphTreeSitter, { watchDebounceMs: 200 })
    await ctx.codegraph.index(root)

    const { writeFile } = await import('node:fs/promises')

    try {
      const deadline = Date.now() + 10_000
      // Same FSEvents startup-lag workaround as the test above: re-issue the write every second until
      // the rebuild is observed, instead of trusting the very first write reached a fully-armed watch.
      let lastWriteAt = 0
      let names: string[] = []
      do {
        if (Date.now() - lastWriteAt >= 1_000) {
          await writeFile(`${root}/a.ts`, 'export function second() {}\n')
          lastWriteAt = Date.now()
        }
        await new Promise(resolve => setTimeout(resolve, 100))
        try {
          const db = new DatabaseSync(`${root}/${DATABASE_RELATIVE_PATH}`, { readOnly: true })
          try {
            names = (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
              .map(row => row.name)
          } finally {
            db.close()
          }
        } catch {
          // A vanishingly unlikely poll landing exactly mid-rename; just try again next tick.
        }
      } while (!names.includes('second') && Date.now() < deadline)
      expect(names).toEqual(['second'])
    } finally {
      await ctx.fiber.dispose()
    }
  }, 15_000)

  it('starts watching only once per root, even across repeated index() calls', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam({ watch: true, watchDebounceMs: 200 })
    await ctx.codegraph.index(root)
    // ensureWatching()'s own watchers.has() guard is what this exercises: a second index() on the
    // same root must not construct (and start()) a second watcher over it.
    await expect(ctx.codegraph.index(root)).resolves.toMatchObject({ filesIndexed: 1 })
    await ctx.fiber.dispose()
  })

  it('CODEGRAPH_NO_WATCH=1 keeps watching off even when the config asks for it', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const originalEnv = process.env.CODEGRAPH_NO_WATCH
    process.env.CODEGRAPH_NO_WATCH = '1'
    const ctx = await seam({ watch: true, watchDebounceMs: 200 })
    try {
      await ctx.codegraph.index(root)
      const { writeFile } = await import('node:fs/promises')
      await writeFile(`${root}/a.ts`, 'export function second() {}\n')
      // No watcher was ever armed, so waiting out a debounce window plus slack must not reflect the
      // edit — the graph should still show only what the baseline index() saw.
      await new Promise(resolve => setTimeout(resolve, 500))
      const db = new DatabaseSync(`${root}/${DATABASE_RELATIVE_PATH}`, { readOnly: true })
      let names: string[]
      try {
        names = (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
          .map(row => row.name)
      } finally {
        db.close()
      }
      expect(names).toEqual(['first'])
    } finally {
      if (originalEnv === undefined) delete process.env.CODEGRAPH_NO_WATCH
      else process.env.CODEGRAPH_NO_WATCH = originalEnv
      await ctx.fiber.dispose()
    }
  })

  it('logs a visible, actionable warning once the watcher degrades permanently', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() {}\n' })
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // Forces the per-directory (Linux) watch strategy to hit its cap on the very first subdirectory,
      // without needing to actually exhaust an OS watch resource.
      const ctx = await seam({ watch: true, maxWatchedDirectories: 1 })
      await ctx.codegraph.index(root)
      const deadline = Date.now() + 5_000
      while (errorSpy.mock.calls.length === 0 && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 50))
      }
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stopped permanently'))
      await ctx.fiber.dispose()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
      errorSpy.mockRestore()
    }
  }, 10_000)
})
