import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat as fsStat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import Codegraph, { CodegraphError, INDEX_FAILURE_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { IndexFailureFile } from 'dsh-plugin-codegraph-service'
import * as CodegraphTreeSitter from '../src/index.ts'
import {
  DATABASE_RELATIVE_PATH,
  DEFAULT_INDEXER_ID,
  EXTRACTION_CACHE_RELATIVE_PATH,
  EXTRACTION_CACHE_VERSION,
} from '../src/index.ts'
import type { WatchDirEntry, WatchTarget } from '../src/watcher.ts'
import { writeProject } from './fixture.ts'

/** One live watch the fake backend holds, with the callback the watcher registered on it. */
interface FakeWatchRecord {
  readonly targetKey: string
  readonly changed: (error?: Error) => void
  closed: boolean
}

/**
 * The filesystem seam the plugin consumes, backed by the real disk for `resolve`/`stat`/`readText`/
 * `writeText`/`listDir` and by test-driven, recorded watches for `watch`.
 *
 * Listing real files is what makes the end-to-end watcher test meaningful: the change the test writes
 * to disk is what a re-listing sees, so the rebuild it drives is the production path. Driving `watch`
 * from the test is what makes it deterministic — no kernel-side event latency and no polling. The
 * parse cache reaches its document through the same seam, so its read and write are disk-backed here
 * too: a test that counts reused files is evidence about the real round trip, not about a double.
 */
class FakeFs extends Service {
  readonly watches: FakeWatchRecord[] = []
  /** Targets whose `listDir` has returned — the signal that a watcher's baseline snapshot is taken. */
  readonly listings: string[] = []
  /** When set, every `watch` call rejects with this error instead of observing anything. */
  watchFailure: unknown

  constructor(ctx: Context) {
    super(ctx, 'fs')
  }

  /**
   * Resolve a path to itself: this fake's target key is the absolute path the disk calls accept.
   * @param path - the path to resolve.
   * @returns the target.
   */
  async resolve(path: string): Promise<WatchTarget> {
    return { targetKey: path }
  }

  /**
   * Report a target's metadata the way the seam does: presence, plus what kind of entry is there.
   * @param target - the target to probe.
   * @returns the metadata, or undefined when nothing is there.
   */
  async stat(target: WatchTarget): Promise<{ readonly type: 'file' | 'directory' | 'other' } | undefined> {
    try {
      const stats = await fsStat(target.targetKey)
      return { type: stats.isFile() ? 'file' : stats.isDirectory() ? 'directory' : 'other' }
    } catch {
      return undefined
    }
  }

  /**
   * Read one file's text.
   * @param target - the file to read.
   * @returns its content.
   */
  async readText(target: WatchTarget): Promise<string> {
    return readFile(target.targetKey, 'utf8')
  }

  /**
   * Replace one file's text. Creating a missing parent directory mirrors the local backend, which is
   * what lets the cache's first write land without a `mkdir` the seam does not offer.
   * @param target - the file to write.
   * @param content - the full new content.
   */
  async writeText(target: WatchTarget, content: string): Promise<void> {
    await mkdir(dirname(target.targetKey), { recursive: true })
    await writeFile(target.targetKey, content)
  }

  /**
   * List one real directory, with a freshness token derived from the entry's own stat.
   * @param target - the directory to list.
   * @returns its direct children.
   */
  async listDir(target: WatchTarget): Promise<readonly WatchDirEntry[]> {
    const entries = await readdir(target.targetKey, { withFileTypes: true })
    const listed: WatchDirEntry[] = []
    for (const entry of entries) {
      const absolute = join(target.targetKey, entry.name)
      const isDirectory = entry.isDirectory()
      const isFile = entry.isFile()
      const stats = await fsStat(absolute)
      listed.push({
        name: entry.name,
        type: isDirectory ? 'directory' : isFile ? 'file' : 'other',
        target: { targetKey: absolute },
        version: `${stats.mtimeMs}:${stats.ctimeMs}:${stats.size}`,
        ...isFile ? { size: stats.size } : {},
      })
    }
    // Recorded only once the listing is complete: this is the point after which the watcher holds a
    // snapshot of the directory, so a test can safely change files and expect them to be attributed.
    this.listings.push(target.targetKey)
    return listed
  }

  /**
   * Record a watch the test can drive through {@link emit}.
   * @param target - the directory being observed.
   * @param changed - the invalidation callback to keep.
   * @returns the disposer.
   */
  async watch(target: WatchTarget, changed: (error?: Error) => void): Promise<() => Promise<void>> {
    if (this.watchFailure !== undefined) throw this.watchFailure
    const record: FakeWatchRecord = { targetKey: target.targetKey, changed, closed: false }
    this.watches.push(record)
    return () => {
      record.closed = true
      return Promise.resolve()
    }
  }

  /**
   * Notify every open watch (or only those on one target) that something changed.
   * @param targetKey - restrict delivery to this directory's watches.
   */
  emit(targetKey?: string): void {
    for (const watch of this.watches) {
      if (watch.closed) continue
      if (targetKey !== undefined && watch.targetKey !== targetKey) continue
      watch.changed()
    }
  }

  /**
   * How many watches are currently open.
   * @returns the open count.
   */
  openWatches(): number {
    return this.watches.filter(watch => !watch.closed).length
  }
}

/**
 * The fake fs a test's context registered; the plugin reads it through `ctx.fs` when it applies.
 * @param ctx - a context created by {@link seam}.
 * @returns the fake, so a test can emit changes and inspect its watches.
 */
function fsOf(ctx: Context): FakeFs {
  return (ctx as Context & { readonly fs: FakeFs }).fs
}

async function seam(config?: Record<string, unknown>): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Codegraph)
  // The plugin requires an `fs` service and watches through it. Every test mounts this double so the
  // composition matches production, where an fs backend is always present, and so a watch test can
  // drive notifications without a real kernel watch.
  new FakeFs(ctx)
  // Tests that don't care about watching stay on the old no-watch behavior; the watch-specific tests
  // below override this back to `true` via their own explicit config.
  await ctx.plugin(CodegraphTreeSitter, { watch: false, ...config })
  return ctx
}

/** Poll until `check` reports success, on the real clock. */
async function waitFor(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await check()) return
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('timed out waiting for a condition the test expects to become true')
}


/** Distinguishes the session ids of agents registered within one test file. */
let agentSequence = 0

/**
 * Register one live agent through the host's own `AgentRegistry`, which is what emits the
 * `agent/created` dispatch the plugin listens on — the test drives the real event source instead of
 * a hand-rolled callback.
 * @param ctx - a context with the `agents` service mounted.
 * @param cwd - the session workspace; omit to model an agent created without one.
 * @returns the registered agent's session id, which owns any background job it starts.
 */
function registerAgent(ctx: Context, cwd?: string): string {
  const id = SessionId(`codegraph-auto-index-${agentSequence++}`)
  const session = Session.create(id, [], {
    version: SESSION_FORMAT_VERSION,
    id,
    createdAt: 0,
    ...cwd === undefined ? {} : { cwd },
  })
  const scope = ctx.plugin(() => {})
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return id
}

/**
 * Emit `agent/created` with a payload the registry would never produce itself, for the defensive
 * shapes the handler has to tolerate.
 * @param ctx - the context that dispatch reaches.
 * @param payload - the malformed payload to dispatch.
 */
function emitAgentCreated(ctx: Context, payload: unknown): void {
  ;(ctx as unknown as { emit(name: string, payload: unknown): void }).emit('agent/created', payload)
}

/**
 * Let one `agent/created` dispatch reach the asynchronous fs walk that precedes `ctx.codegraph.index`.
 *
 * A listener that is gone can only be observed as a negative, so there is no event to await: this is
 * the same bounded window a live listener uses to get from the synchronous dispatch to the size-guard
 * walk (`exceedsAutoIndexLimit` does one `readdir` of a one-file workspace). Each caller pairs it with
 * a positive control — the same dispatch on a mounted composition — so a broken setup fails there
 * instead of passing here.
 */
async function settleDispatch(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 50))
}

/**
 * Read a workspace's failure sidecar, or `undefined` while no run has written one yet.
 * @param root - the workspace root.
 * @returns the parsed record, when there is one to read.
 */
async function readFailure(root: string): Promise<IndexFailureFile | undefined> {
  try {
    return JSON.parse(await readFile(join(root, INDEX_FAILURE_RELATIVE_PATH), 'utf8')) as IndexFailureFile
  } catch {
    return undefined
  }
}

/**
 * A composition matching production for the auto-index paths: the same plugin mount as {@link seam},
 * plus the host's agent registry (which emits `agent/created`) and, when asked for, a `jobs` service.
 * @param options - `config` is forwarded to the plugin; `jobs` is provided as the `jobs` service.
 * @returns the context.
 */
async function autoIndexSeam(options: { config?: Record<string, unknown>; jobs?: unknown } = {}): Promise<Context> {
  const ctx = await seam(options.config)
  if (options.jobs !== undefined) ctx.provide('jobs', options.jobs)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** The names of the function nodes in a written graph, or an empty list while it is being replaced. */
function functionNames(databasePath: string): string[] {
  try {
    const db = new DatabaseSync(databasePath, { readOnly: true })
    try {
      return (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
        .map(row => row.name)
    } finally {
      db.close()
    }
  } catch {
    // A poll landing exactly mid-replace; the next tick sees the committed graph.
    return []
  }
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
      filesMinified: 0,
      filesReused: 0,
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
    new FakeFs(ctx)
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
    const ctx = await seam({ watch: true, watchDebounceMs: 50 })
    const fs = fsOf(ctx)
    // The baseline index() this establishes is also what starts the watcher — see ensureWatching().
    await ctx.codegraph.index(root)
    await waitFor(() => fs.listings.includes(root))

    const databasePath = join(root, DATABASE_RELATIVE_PATH)
    // A different name and a different length, so the re-listing's stat token differs even if the
    // write lands in the same millisecond as the indexing run's own read.
    await writeFile(join(root, 'a.ts'), 'export function second() { return 2 }\n')
    // The seam reports "something in this directory changed" and names no file; the watcher turns
    // that into paths by re-listing the directory against the listing it took when it armed.
    fs.emit(root)
    await waitFor(() => functionNames(databasePath).includes('second'))
    expect(functionNames(databasePath)).toEqual(['second'])
    await ctx.fiber.dispose()
  }, 15_000)

  it('settles after one edit instead of rebuilding forever from its own .codegraph write', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam({ watch: true, watchDebounceMs: 50 })
    const fs = fsOf(ctx)
    const databasePath = join(root, DATABASE_RELATIVE_PATH)
    await ctx.codegraph.index(root)
    await waitFor(() => fs.listings.includes(root))

    await writeFile(join(root, 'a.ts'), 'export function second() { return 2 }\n')
    fs.emit(root)
    await waitFor(() => functionNames(databasePath).includes('second'))
    const mtimeAfterEdit = (await fsStat(databasePath)).mtimeMs

    // Every rebuild writes `.codegraph`, and the root's watch does report a change to a direct child
    // of the root, so the notification below is exactly what the watcher's own write provokes. It
    // must not rebuild: `.codegraph` is excluded, so the re-listing attributes no in-scope change.
    fs.emit(root)
    await new Promise(resolve => setTimeout(resolve, 400))
    expect((await fsStat(databasePath)).mtimeMs).toBe(mtimeAfterEdit)
    await ctx.fiber.dispose()
  }, 15_000)

  it('watches by default when `watch` is left unset', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    new FakeFs(ctx)
    // Bypasses seam()'s `watch: false` override on purpose — this is the one test asserting the
    // plugin's actual shipped default, not the opt-out most other tests here use to stay isolated.
    await ctx.plugin(CodegraphTreeSitter, { watchDebounceMs: 50 })
    const fs = fsOf(ctx)
    await ctx.codegraph.index(root)
    await waitFor(() => fs.openWatches() > 0)
    expect(fs.watches.map(watch => watch.targetKey)).toEqual([root])
    await ctx.fiber.dispose()
  }, 15_000)

  it('starts watching only once per root, even across repeated index() calls', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const ctx = await seam({ watch: true, watchDebounceMs: 200 })
    const fs = fsOf(ctx)
    await ctx.codegraph.index(root)
    await waitFor(() => fs.openWatches() > 0)
    // ensureWatching()'s own watchers.has() guard is what this exercises: a second index() on the
    // same root must not construct (and start()) a second watcher over it.
    await expect(ctx.codegraph.index(root)).resolves.toMatchObject({ filesIndexed: 1 })
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(fs.watches.filter(watch => watch.targetKey === root)).toHaveLength(1)
    expect(fs.openWatches()).toBe(1)
    await ctx.fiber.dispose()
  })

  it('CODEGRAPH_NO_WATCH=1 keeps watching off even when the config asks for it', async () => {
    const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
    const originalEnv = process.env.CODEGRAPH_NO_WATCH
    process.env.CODEGRAPH_NO_WATCH = '1'
    const ctx = await seam({ watch: true, watchDebounceMs: 50 })
    const fs = fsOf(ctx)
    try {
      await ctx.codegraph.index(root)
      // Nothing was ever asked of the seam, so no watch exists — no waiting on a debounce window is
      // needed to conclude that no rebuild can happen.
      await new Promise(resolve => setTimeout(resolve, 100))
      expect(fs.watches).toHaveLength(0)
      await writeFile(join(root, 'a.ts'), 'export function second() { return 2 }\n')
      expect(functionNames(join(root, DATABASE_RELATIVE_PATH))).toEqual(['first'])
    } finally {
      if (originalEnv === undefined) delete process.env.CODEGRAPH_NO_WATCH
      else process.env.CODEGRAPH_NO_WATCH = originalEnv
      await ctx.fiber.dispose()
    }
  })

  it('logs a visible, actionable warning once the watcher degrades permanently', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() {}\n' })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const ctx = await seam({ watch: true })
      // The backend cannot watch at all: the seam's own "unsupported provider" rejection.
      fsOf(ctx).watchFailure = Object.assign(new Error('unsupported'), { code: 'FS_IO_ERROR' })
      await ctx.codegraph.index(root)
      await waitFor(() => errorSpy.mock.calls.length > 0, 5_000)
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stopped permanently'))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('WATCH_UNAVAILABLE'))
      await ctx.fiber.dispose()
    } finally {
      errorSpy.mockRestore()
    }
  }, 10_000)

  it('requires an fs service: the indexer does not register until one is mounted', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    await ctx.plugin(CodegraphTreeSitter, { watch: false })
    // `fs` is a declared dependency, so nothing registers until a backend provides it.
    await expect(ctx.codegraph.index(root)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_NO_INDEXER' }),
    )

    new FakeFs(ctx)
    // A pending plugin fiber applies once its dependencies resolve.
    await new Promise(resolve => setImmediate(resolve))
    await expect(ctx.codegraph.index(root)).resolves.toMatchObject({ filesIndexed: 1 })
    await ctx.fiber.dispose()
  })

  it('reports no reuse on a first run and reuses every unchanged file on the next', async () => {
    const root = await writeProject({
      'src/a.ts': 'export function a() { return 1 }\n',
      'src/b.ts': "import { a } from './a'\nexport function b() { return a() }\n",
    })
    const ctx = await seam()
    const first = await ctx.codegraph.index(root)
    expect(first.filesReused).toBe(0)
    expect(first.filesIndexed).toBe(2)

    const second = await ctx.codegraph.index(root)
    expect(second.filesIndexed).toBe(2)
    expect(second.filesReused).toBe(2)
    // The index is rebuilt from the same extractions, so the graph must not change shape.
    expect(second.nodeCount).toBe(first.nodeCount)
    expect(second.edgeCount).toBe(first.edgeCount)
  })

  it('writes the parse cache beside the graph after a successful run', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const ctx = await seam()
    await ctx.codegraph.index(root)
    const raw = await readFile(join(root, EXTRACTION_CACHE_RELATIVE_PATH), 'utf8')
    expect(JSON.parse(raw)).toMatchObject({
      cacheVersion: EXTRACTION_CACHE_VERSION,
      files: { 'a.ts': { language: 'typescript', lineCount: 2 } },
    })
  })

  it('re-parses only the file that changed since the cached run', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' })
    const ctx = await seam()
    await ctx.codegraph.index(root)
    await writeFile(join(root, 'a.ts'), 'export function renamed() {}\n')

    const second = await ctx.codegraph.index(root)
    expect(second.filesIndexed).toBe(2)
    expect(second.filesReused).toBe(1)

    const db = new DatabaseSync(`${root}/${DATABASE_RELATIVE_PATH}`, { readOnly: true })
    try {
      const names = (db.prepare("SELECT name FROM nodes WHERE kind = 'function'").all() as { name: string }[])
        .map(row => row.name)
      expect(names.sort()).toEqual(['b', 'renamed'])
    } finally {
      db.close()
    }
  })

  it('verifies cached files by content hash when configured', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const ctx = await seam({ cacheVerify: 'hash' })
    const first = await ctx.codegraph.index(root)
    expect(first.filesReused).toBe(0)
    const second = await ctx.codegraph.index(root)
    expect(second.filesReused).toBe(1)
  })

  it('parses every file on every run when reuseParsedCache is false', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const ctx = await seam({ reuseParsedCache: false })
    await ctx.codegraph.index(root)
    const second = await ctx.codegraph.index(root)
    expect(second.filesReused).toBe(0)
  })

  it('rejects an unknown cacheVerify mode at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    new FakeFs(ctx)
    await expect(ctx.plugin(CodegraphTreeSitter, { cacheVerify: 'sha' })).rejects.toThrow()
  })

  it('rejects an unknown engine mode at load', async () => {
    const ctx = new Context()
    await ctx.plugin(Codegraph)
    new FakeFs(ctx)
    await expect(ctx.plugin(CodegraphTreeSitter, { engine: 'wasm' })).rejects.toThrow()
  })

  it('defaults the engine to auto, which indexes the same workspace as js', async () => {
    expect(CodegraphTreeSitter.Config({}).engine).toBe('auto')
    const root = await writeProject({
      'src/a.ts': "import { b } from './b'\nexport function a() { return b() }\n",
      'src/b.ts': 'export function b() { return 1 }\n',
      'src/c.py': 'def c():\n    return 1\n',
    })
    // No cache on either run: with reuse off, every file goes through an extractor both times, so any
    // difference in the written graph has to come from the extractor the engine setting selected.
    const jsReport = await (await seam({ engine: 'js', reuseParsedCache: false })).codegraph.index(root)
    const autoReport = await (await seam({ engine: 'auto', reuseParsedCache: false })).codegraph.index(root)
    expect(autoReport).toMatchObject({
      projectRoot: root,
      filesIndexed: jsReport.filesIndexed,
      filesSkipped: jsReport.filesSkipped,
      filesMinified: jsReport.filesMinified,
      filesReused: jsReport.filesReused,
      nodeCount: jsReport.nodeCount,
      edgeCount: jsReport.edgeCount,
      unresolvedCount: jsReport.unresolvedCount,
      unresolvedLikelyInternalCount: jsReport.unresolvedLikelyInternalCount,
      languages: jsReport.languages,
    })
    expect(jsReport.nodeCount).toBeGreaterThan(0)
  })

  describe('failure records', () => {
    it('records why a build failed and clears the record once a graph is written again', async () => {
      // A directory where the graph file belongs: the run gets as far as writing its temp file, then
      // fails at the rename that would commit it — so the recorded message is the real one.
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/codegraph.db/blocker.txt': 'not a graph\n',
      })
      const ctx = await seam()
      const failure = await ctx.codegraph.index(root).then(() => undefined, (error: unknown) => error as Error)
      expect(failure).toBeInstanceOf(Error)

      const recorded = await readFailure(root)
      expect(recorded).toMatchObject({ source: 'tool', message: failure?.message })
      expect(recorded?.failedAt).toBeGreaterThan(0)

      await rm(join(root, DATABASE_RELATIVE_PATH), { recursive: true, force: true })
      await ctx.codegraph.index(root)
      // The graph exists again, so "there is no index because …" is no longer true about it.
      expect(existsSync(join(root, INDEX_FAILURE_RELATIVE_PATH))).toBe(false)
    })

    it('records an automatic failure under the automatic path', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/codegraph.db/blocker.txt': 'not a graph\n',
      })
      const ctx = await autoIndexSeam()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        registerAgent(ctx, root)
        // `indexer.index` records the failure as the explicit path first — the seam has no way to tell
        // which caller asked. The automatic run then overwrites it, so waiting for 'auto' is waiting
        // for the final record rather than for a race.
        await waitFor(async () => (await readFailure(root))?.source === 'auto')
        expect((await readFailure(root))?.message).toContain('codegraph.db')
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('abandons an automatic run that outlives its deadline and releases the workspace', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      // A one-millisecond freshness window lets the second session below be a real second attempt.
      // The deadline is generous on purpose: the second session has to arrive while the first run is
      // still in flight, and a 20ms deadline let a loaded machine fire the timer first, which made the
      // "turned away by the in-flight set" assertion below a race rather than a fact.
      const ctx = await autoIndexSeam({ config: { autoIndexTimeoutMs: 500, autoRefreshAfterMs: 1 } })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      // A run that ignores its signal entirely: the worst case the deadline exists for.
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation(() => new Promise(() => {}))
      try {
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 1)
        // Past the one-millisecond freshness window but well inside the deadline: a second session
        // must be turned away by the in-flight set, not race a second build over the same files.
        await new Promise(resolve => setTimeout(resolve, 50))
        registerAgent(ctx, root)
        expect(indexSpy.mock.calls.length).toBe(1)

        await waitFor(async () => (await readFailure(root))?.message.includes('timed out') === true)
        expect(indexSpy.mock.calls[0]?.[1]?.aborted).toBe(true)

        // The run above will never settle, so only the deadline itself can have released the root.
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 2)
        expect((await readFailure(root))?.source).toBe('auto')
      } finally {
        errorSpy.mockRestore()
        indexSpy.mockRestore()
      }
    })

    it('records a timed-out run that does settle as timed out, not as a bare abort', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam({ config: { autoIndexTimeoutMs: 20 } })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation((_projectRoot, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('This operation was aborted')) })
        }))
      try {
        registerAgent(ctx, root)
        // The record is written before the catch logs, so waiting for both would be waiting on the
        // slower of the two; the record is what the user reads back later.
        await waitFor(async () => (await readFailure(root))?.message.includes('timed out') === true)
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('timed out'))).toBe(true)
      } finally {
        errorSpy.mockRestore()
        indexSpy.mockRestore()
      }
    })

    it('aborts an automatic run when the plugin unloads', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam()
      let seen: AbortSignal | undefined
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation((_projectRoot, signal) => {
        seen = signal
        return new Promise(() => {})
      })
      try {
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 1)
        // Unloading the plugin must stop the parse it no longer serves, not leave it writing into a
        // graph this instance is no longer responsible for.
        await ctx.fiber.dispose()
        expect(seen?.aborted).toBe(true)
      } finally {
        indexSpy.mockRestore()
      }
    })

    it('records a failed watch rebuild too, so a silently stale index has a reason', async () => {
      const root = await writeProject({ 'a.ts': 'export function first() {}\n' })
      const ctx = await seam({ watch: true, watchDebounceMs: 20 })
      const fs = fsOf(ctx)
      await ctx.codegraph.index(root)
      await waitFor(() => fs.listings.includes(root))

      // Put a directory where the graph file belongs: the next rebuild reaches its rename and fails,
      // which is the watch path that used to leave nothing but a console line behind.
      await rm(join(root, DATABASE_RELATIVE_PATH), { force: true })
      await mkdir(join(root, DATABASE_RELATIVE_PATH), { recursive: true })
      await writeFile(join(root, 'a.ts'), 'export function second() { return 2 }\n')
      fs.emit(root)

      await waitFor(async () => (await readFailure(root))?.source === 'watch')
      await ctx.fiber.dispose()
    }, 15_000)

    it('swallows an unwritable failure record instead of turning it into a second failure', async () => {
      // `.codegraph` is a file here, so the graph write and the record of its failure both fail. The
      // caller must still see the original error; the diagnostic is best-effort by contract.
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph': 'not a directory\n',
      })
      const ctx = await seam()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        await expect(ctx.codegraph.index(root)).rejects.toThrow(/EEXIST|ENOTDIR/)
        // The failed record is reported once rather than replacing the caller's error.
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('could not record'))).toBe(true)
        expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('does not record an aborted build as a workspace failure', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await seam()
      // The tool's own cancel and the plugin's unload both abort this signal; neither is a diagnosis
      // of the workspace, so no record may outlive the process that cancelled the run.
      await expect(ctx.codegraph.index(root, AbortSignal.abort())).rejects.toThrow()
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(existsSync(join(root, INDEX_FAILURE_RELATIVE_PATH))).toBe(false)
    })

    it('records nothing when the unload aborts an automatic run', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation((_projectRoot, signal) =>
        new Promise((_resolve, reject) => {
          signal?.addEventListener('abort', () => { reject(new Error('This operation was aborted')) })
        }))
      try {
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 1)
        await ctx.fiber.dispose()
        // The run's catch settles after disposal; a deliberate abort is not a failure to report.
        await new Promise(resolve => setTimeout(resolve, 50))
        expect(existsSync(join(root, INDEX_FAILURE_RELATIVE_PATH))).toBe(false)
      } finally {
        errorSpy.mockRestore()
        indexSpy.mockRestore()
      }
    })

    it('does not release a newer run\'s workspace when a timed-out run settles late', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      // A one-millisecond freshness window makes each session below a real attempt, and a deadline
      // wide enough that the second run cannot reach its own before the first one settles: the only
      // thing that could release the second run's room is the first run's `finally`.
      const ctx = await autoIndexSeam({ config: { autoIndexTimeoutMs: 100, autoRefreshAfterMs: 1 } })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      let settleFirst: (() => void) | undefined
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation(() => {
        if (settleFirst === undefined) {
          return new Promise<never>(resolve => { settleFirst = () => { resolve(undefined as never) } })
        }
        return new Promise<never>(() => {})
      })
      try {
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 1)
        await waitFor(async () => (await readFailure(root))?.message.includes('timed out') === true, 5_000)
        // The deadline released the room, so a second session may claim it — and this run never
        // settles, which leaves only the first run's `finally` able to touch the in-flight set.
        await new Promise(resolve => setTimeout(resolve, 5))
        registerAgent(ctx, root)
        await waitFor(() => indexSpy.mock.calls.length === 2)
        // The first run finally settles while the second one still owns the workspace.
        await new Promise(resolve => setTimeout(resolve, 5))
        settleFirst?.()
        await new Promise(resolve => setTimeout(resolve, 10))
        registerAgent(ctx, root)
        await new Promise(resolve => setTimeout(resolve, 10))
        // The second run is in flight, so this session is turned away rather than racing a third build.
        expect(indexSpy.mock.calls.length).toBe(2)
      } finally {
        errorSpy.mockRestore()
        indexSpy.mockRestore()
      }
    })
  })

  describe('automatic indexing on session start', () => {
    it('indexes a new session\'s workspace in the background', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      // Session creation returns before the parse finishes; the graph lands on its own.
      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
      expect(functionNames(join(root, DATABASE_RELATIVE_PATH))).toEqual(['a'])
    })

    it('never registers a host job, so no completion notice can reach the transcript', async () => {
      // 本次改动的核心契约：注册成 job 后宿主会在结算时注入完成通知，并默认唤醒空闲 agent 开一轮。
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const start = vi.fn(() => {
        throw new Error('automatic index must not register a host job')
      })
      const ctx = await autoIndexSeam({ jobs: { start } })

      registerAgent(ctx, root)

      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
      expect(start).not.toHaveBeenCalled()
    })

    it('never touches the harness home directory', async () => {
      // `sessions/` plus `profiles/` is what makes a directory DSH's own state rather than a
      // checkout. Indexing it can only hit the size guard, so no run may start at all — a workspace
      // that was never a candidate should never appear as a failure.
      const root = await writeProject({
        'sessions/--tmp--/session/x.jsonl': '\n',
        'profiles/desktop/package.json': '{}',
        'a.ts': 'export const a = 1\n',
      })
      const ctx = await autoIndexSeam()
      const indexSpy = vi.spyOn(ctx.codegraph, 'index')
      try {
        registerAgent(ctx, root)
        // An automatic run's first await is the size scan, so "not called yet" on its own would also
        // be true with the guard removed. A control workspace registered in the same context proves
        // the automatic path does reach this call; the guarded root must never appear in the log.
        const control = await writeProject({ 'a.ts': 'export function control() {}\n' })
        registerAgent(ctx, control)
        await waitFor(() => indexSpy.mock.calls.some(([projectRoot]) => projectRoot === control))
        expect(indexSpy.mock.calls.some(([projectRoot]) => projectRoot === root)).toBe(false)
        expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
      } finally {
        indexSpy.mockRestore()
      }
    })

    it('declines a workspace past the session-start file limit instead of killing the heap', async () => {
      // The real case this guards: a session opened in a home or tool-data directory. `maxFiles`
      // (50,000) does not stop it — 21,752 files under ~/.dsh stayed below that ceiling and the
      // Tree-sitter WASM heap died mid-parse while the desktop froze. The session-start limit is
      // intentionally far lower than the manual one, so the guard fires in a test-sized project.
      const files = Object.fromEntries(
        Array.from({ length: 6 }, (_, index) => [`f${String(index)}.ts`, `export const v${String(index)} = ${String(index)}\n`]),
      )
      const root = await writeProject(files)
      const ctx = await autoIndexSeam({ config: { autoIndexMaxFiles: 3 } })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        registerAgent(ctx, root)

        await waitFor(() => errorSpy.mock.calls.some(args => String(args[0]).includes('session-start limit')))
        // Declining is a decision, not a crash: nothing is written, and the run says why.
        expect(errorSpy.mock.calls.some(args => String(args[0]).includes('past the 3-file session-start limit'))).toBe(true)
        expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('keeps walking after a subdirectory that stays under the limit', async () => {
      // The count recurses, so a workspace whose sources all sit one level down has to be measured
      // the same way a flat one is. This directory is small enough to be walked past, which is the
      // out-of-directory branch the flat tests never reach.
      const root = await writeProject({
        'src/a.ts': 'export const a = 1\n',
        'src/b.ts': 'export const b = 2\n',
      })
      const ctx = await autoIndexSeam({ config: { autoIndexMaxFiles: 10 } })

      registerAgent(ctx, root)

      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
    })

    it('does not count a directory entry that is neither a file nor a directory toward the limit', async () => {
      // A symlink is the shape a real tree carries (a linked file, a vendored alias) and it is not a
      // candidate the walk would ever parse. Counting it would decline an otherwise small workspace:
      // two real files under a two-file limit, and a third entry the guard must ignore.
      const root = await writeProject({
        'a.ts': 'export const a = 1\n',
        'b.ts': 'export const b = 2\n',
      })
      await symlink(join(root, 'a.ts'), join(root, 'linked.ts'))
      const ctx = await autoIndexSeam({ config: { autoIndexMaxFiles: 2 } })

      registerAgent(ctx, root)

      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
    })

    it('counts files that live only in subdirectories', async () => {
      // Same nesting shape, but past the limit: the recursive call is what has to report the
      // overflow, and declining still means no graph rather than a partial one.
      const root = await writeProject({
        'src/deep/b0.ts': 'export const b0 = 0\n',
        'src/deep/b1.ts': 'export const b1 = 1\n',
        'src/deep/b2.ts': 'export const b2 = 2\n',
        'src/deep/b3.ts': 'export const b3 = 3\n',
      })
      const ctx = await autoIndexSeam({ config: { autoIndexMaxFiles: 3 } })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        registerAgent(ctx, root)

        await waitFor(() => errorSpy.mock.calls.some(args => String(args[0]).includes('session-start limit')))
        expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('leaves a workspace whose index is fresh alone', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        // The sidecar's timestamp is the cross-process record of how recently a run finished, which is
        // what "already current" means here — not merely "a graph exists".
        '.codegraph/status.json': JSON.stringify({ indexedAt: Date.now() }),
      })
      const ctx = await autoIndexSeam()
      const indexSpy = vi.spyOn(ctx.codegraph, 'index')
      try {
        registerAgent(ctx, root)
        // Same reasoning as the harness-home case: a stale control workspace registered here proves
        // the automatic path reaches the index call, so the fresh root's absence is about freshness.
        const stale = await writeProject({
          'a.ts': 'export function staleWorkspace() {}\n',
          '.codegraph/status.json': JSON.stringify({ indexedAt: 0 }),
        })
        registerAgent(ctx, stale)
        await waitFor(() => indexSpy.mock.calls.some(([projectRoot]) => projectRoot === stale))
        expect(indexSpy.mock.calls.some(([projectRoot]) => projectRoot === root)).toBe(false)
        expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
      } finally {
        indexSpy.mockRestore()
      }
    })

    it('refreshes an index that has gone stale, which is also what restarts watching', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/status.json': JSON.stringify({ indexedAt: 0 }),
      })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      // A rebuild on session start is what re-establishes the watcher's baseline: watching only
      // begins after a successful index, so a stale workspace would otherwise stay frozen at whatever
      // the previous host process left behind.
      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
      expect(functionNames(join(root, DATABASE_RELATIVE_PATH))).toEqual(['a'])
    })

    it('treats an unreadable sidecar as stale, so a damaged record is rebuilt rather than trusted', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/status.json': '{not json',
      })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
    })

    it('treats a sidecar that parses to a non-object as stale', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/status.json': 'null',
      })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      // `null` parses fine but describes nothing; a reader that only guards `typeof === 'object'`
      // would dereference it next.
      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
    })

    it('treats a sidecar without a numeric timestamp as stale', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        '.codegraph/status.json': JSON.stringify({ indexedAt: 'yesterday' }),
      })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
    })

    it('starts at most one automatic index per workspace', async () => {
      // Two sessions opened on one workspace must not race the same index files: the second one is
      // deduplicated by the freshness window while the first run is still in flight.
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        registerAgent(ctx, root)
        registerAgent(ctx, root)

        await waitFor(() => existsSync(join(root, DATABASE_RELATIVE_PATH)))
        await new Promise(resolve => setTimeout(resolve, 100))
        expect(errorSpy).not.toHaveBeenCalled()
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('skips a session with no workspace, and payloads with no usable agent', async () => {
      const ctx = await autoIndexSeam()

      // A real agent whose session was created without a `cwd`, then the payload shapes a malformed
      // dispatch could carry: no agent at all, and an agent whose session is missing.
      expect(() => {
        registerAgent(ctx)
        emitAgentCreated(ctx, {})
        emitAgentCreated(ctx, { agent: { id: 'agent-without-session' } })
      }).not.toThrow()
    })

    it('starts no automatic run when autoIndexOnSession is false', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const off = await autoIndexSeam({ config: { autoIndexOnSession: false } })
      const on = await autoIndexSeam()
      const offSpy = vi.spyOn(off.codegraph, 'index')
      const onSpy = vi.spyOn(on.codegraph, 'index')
      try {
        // The mounted composition is the positive control: the same dispatch, the same workspace and
        // the same test body reach `index` there, so its absence below is about the config rather
        // than about an event this test failed to deliver.
        registerAgent(on, root)
        await waitFor(() => onSpy.mock.calls.length === 1)

        registerAgent(off, root)
        await settleDispatch()
        expect(offSpy).not.toHaveBeenCalled()
      } finally {
        offSpy.mockRestore()
        onSpy.mockRestore()
        await off.fiber.dispose()
        await on.fiber.dispose()
      }
    })

    it('stops answering agent/created once the plugin unloads', async () => {
      const first = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const second = await writeProject({ 'a.ts': 'export function a() {}\n' })
      // Disposing `ctx.fiber` would take the agent registry with it, and this assertion needs the
      // registry to keep emitting — so the composition is mounted here with the indexer's own fiber
      // kept, and only that fiber is disposed.
      const ctx = new Context()
      await ctx.plugin(Codegraph)
      new FakeFs(ctx)
      const indexer = ctx.plugin(CodegraphTreeSitter, { watch: false })
      await indexer
      await ctx.plugin(AgentRegistry)
      const indexSpy = vi.spyOn(ctx.codegraph, 'index').mockImplementation(() => new Promise(() => {}))
      try {
        registerAgent(ctx, first)
        await waitFor(() => indexSpy.mock.calls.length === 1)

        await indexer.dispose()
        // A workspace this instance never saw, so neither the freshness window nor the in-flight set
        // can be what turns the second session away: only a listener that is gone can.
        registerAgent(ctx, second)
        await settleDispatch()
        expect(indexSpy.mock.calls.length).toBe(1)
      } finally {
        indexSpy.mockRestore()
        await ctx.fiber.dispose()
      }
    })

    it('logs a failed run instead of throwing it into the event bus', async () => {
      // An absolute path that no indexer claims: a valid session workspace location, but nothing can
      // build there. The name is per-run so a leftover directory from an earlier run cannot turn the
      // path into an indexable workspace and swallow the failure this test needs.
      const missingRoot = join(tmpdir(), `codegraph-auto-index-missing-${String(process.pid)}-${String(Date.now())}`)
      const ctx = await autoIndexSeam()
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // A throwing creation listener vetoes publication in the host, so a failed background run has
        // to be logged and swallowed, never rethrown into the dispatch.
        expect(() => registerAgent(ctx, missingRoot)).not.toThrow()
        await waitFor(() => errorSpy.mock.calls.some(args => String(args[0]).includes('automatic index for')))
        // A workspace that does not exist is not a failure record's home: creating the directory to
        // hold one would make the next attempt succeed against an empty tree.
        expect(existsSync(missingRoot)).toBe(false)
      } finally {
        errorSpy.mockRestore()
      }
    })
  })
})
