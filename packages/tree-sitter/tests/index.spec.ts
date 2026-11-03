import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat as fsStat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { describe, expect, it, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import Codegraph, { CodegraphError } from 'dsh-plugin-codegraph-service'
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

/** One job the fake registry was asked to start, with the log its producer body writes. */
interface RecordedJob {
  readonly spec: {
    readonly owner: string
    readonly kind: string
    readonly label: string
    readonly run: (handle: { append(text: string): void }) => {
      cancel(reason?: string): void
      done: Promise<{ status: string; detail?: string }>
    }
  }
  readonly output: string[]
}

/**
 * A stand-in for `@deepseek-ai/dsh-jobs`'s registry. It records a registration but never runs the
 * producer itself — a test drives the recorded `run` through {@link driveJob}, so both halves of the
 * contract can be asserted: what the plugin registered, and what its job body then wrote and settled
 * with.
 * @param options - `refuse` makes `start` throw, standing in for the host's "no job controller for
 *   this agent" and "owner already at its cap" refusals.
 * @returns the recorded jobs, and the registry stand-in to provide as the `jobs` service.
 */
function fakeJobs(options: { refuse?: true } = {}): {
  started: RecordedJob[]
  jobs: { start(spec: RecordedJob['spec']): string }
} {
  const started: RecordedJob[] = []
  const jobs = {
    start(spec: RecordedJob['spec']): string {
      if (options.refuse === true) throw new Error('background jobs unavailable: no job controller serves this agent')
      started.push({ spec, output: [] })
      return `job-${started.length}`
    },
  }
  return { started, jobs }
}

/**
 * Invoke one recorded job's producer face, the way the registry does while building the job record.
 * @param job - the recorded job to drive.
 * @returns the producer's hooks; the caller awaits `done` for the terminal outcome.
 */
function driveJob(job: RecordedJob): ReturnType<RecordedJob['spec']['run']> {
  return job.spec.run({ append: (text) => { job.output.push(text) } })
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

  describe('automatic indexing on session start', () => {
    it('starts one background index for a new session in an unindexed workspace', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })

      const id = registerAgent(ctx, root)

      // The registration itself is the contract: the owning session id, the stable kind, and the
      // label a job listing shows. A wrong owner never cancels with its agent, hence the exact match.
      expect(registry.started).toHaveLength(1)
      const job = registry.started[0]!
      expect(job.spec.owner).toBe(id)
      expect(job.spec.kind).toBe('codegraph-index')
      expect(job.spec.label).toBe(`codegraph auto index ${root}`)

      // Driving the recorded producer is what proves the body indexes for real and reports through
      // the job rather than the event dispatch.
      const hooks = driveJob(job)
      await expect(hooks.done).resolves.toEqual({ status: 'completed' })
      expect(job.output.join('')).toContain(`Indexed ${root}: 1 files,`)
      expect(functionNames(join(root, DATABASE_RELATIVE_PATH))).toEqual(['a'])
    })

    it('leaves a workspace that already has an index alone', async () => {
      const root = await writeProject({
        'a.ts': 'export function a() {}\n',
        // Only the sidecar's existence is consulted: it is the cross-process record that a previous
        // run wrote a graph here, which is all this decision needs.
        '.codegraph/status.json': '{"indexedAt":0}',
      })
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })

      registerAgent(ctx, root)

      expect(registry.started).toHaveLength(0)
    })

    it('schedules nothing when the composition has no jobs service', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const ctx = await autoIndexSeam()

      registerAgent(ctx, root)

      // No registry means no background build *and* no synchronous fallback: indexing inside agent
      // creation would stall the session for the length of the parse.
      expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
    })

    it('starts at most one automatic index per workspace', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })

      registerAgent(ctx, root)
      // A second agent opened on the same workspace must not queue a second full rebuild of the
      // graph the first job is already building.
      registerAgent(ctx, root)

      expect(registry.started).toHaveLength(1)
    })

    it('skips a session with no workspace, and payloads with no usable agent', async () => {
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })

      // A real agent whose session was created without a `cwd`, then the payload shapes a malformed
      // dispatch could carry: no agent at all, and an agent whose session is missing.
      registerAgent(ctx)
      emitAgentCreated(ctx, {})
      emitAgentCreated(ctx, { agent: { id: 'agent-without-session' } })

      expect(registry.started).toHaveLength(0)
    })

    it('registers no listener when autoIndexOnSession is false', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ config: { autoIndexOnSession: false }, jobs: registry.jobs })

      registerAgent(ctx, root)

      expect(registry.started).toHaveLength(0)
      expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
    })

    it('does not let a job-registry refusal escape the event bus', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const registry = fakeJobs({ refuse: true })
      const ctx = await autoIndexSeam({ jobs: registry.jobs })
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        // A throwing creation listener vetoes publication in the host, so the refusal has to be
        // logged and swallowed here, never rethrown into the dispatch.
        expect(() => registerAgent(ctx, root)).not.toThrow()
        expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('automatic indexing'))
        expect(registry.started).toHaveLength(0)
      } finally {
        errorSpy.mockRestore()
      }
    })

    it('reports a failed run through the job without rejecting its promise', async () => {
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })
      // An absolute path that does not exist: a valid session workspace, but no indexer claims it.
      const missingRoot = join(tmpdir(), 'codegraph-auto-index-missing')

      registerAgent(ctx, missingRoot)
      const job = registry.started[0]!
      const hooks = driveJob(job)
      const outcome = await hooks.done

      // `done` resolves with a failed outcome instead of rejecting: a rejected producer promise
      // breaks the host's bookkeeping and leaves the job looking permanently stuck.
      expect(outcome.status).toBe('failed')
      expect(job.output.join('')).toContain(`codegraph auto index failed for ${missingRoot}`)
    })

    it('aborts a running build when its job is cancelled', async () => {
      const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
      const registry = fakeJobs()
      const ctx = await autoIndexSeam({ jobs: registry.jobs })

      registerAgent(ctx, root)
      const job = registry.started[0]!
      const hooks = driveJob(job)
      // Cancelled before the walk's first await can complete, so the run is aborted at its next
      // check and settles as failed rather than writing a graph nobody asked for.
      hooks.cancel()
      const outcome = await hooks.done

      expect(outcome.status).toBe('failed')
      expect(job.output.join('')).toContain('codegraph auto index failed for')
      expect(existsSync(join(root, DATABASE_RELATIVE_PATH))).toBe(false)
    })
  })
})
