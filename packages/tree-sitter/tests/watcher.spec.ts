import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcher } from '../src/watcher.ts'
import type { WatchConfig, WatchDirEntry, WatchFileSystem } from '../src/watcher.ts'
import { writeProject } from './fixture.ts'

type EntryType = WatchDirEntry['type']

/** One entry a fake listing presents to the watcher. */
interface EntrySpec {
  readonly type: EntryType
  readonly version?: string
  readonly size?: number
}

/** Directories keyed by target key, each holding its direct children by name. */
type Listing = Record<string, Record<string, EntrySpec>>

/** A file entry carrying the freshness token the listing diff compares. */
function file(version: string, size = 1): EntrySpec {
  return { type: 'file', version, size }
}

/** A directory entry; the version (or absence of one) is what its own listing diff compares. */
function directory(version?: string): EntrySpec {
  return version === undefined ? { type: 'directory' } : { type: 'directory', version }
}

/** One watch the fake backend established, with a way to drive its callback from a test. */
interface FakeWatch {
  readonly targetKey: string
  closed: number
  emit(): void
  emitError(error: unknown): void
}

interface FakeFsOptions {
  /** Directories and children the fake backend reports; tests mutate this between events. */
  readonly listing: Listing
  /** Rejection for every `resolve`, simulating a workspace that cannot be resolved. */
  readonly resolveError?: unknown
  /** Per-target `listDir` rejection, simulating a directory that vanished or is unreadable. */
  readonly listError?: (targetKey: string) => unknown
  /** Per-target `watch` rejection, simulating an unsupported or exhausted backend. */
  readonly watchError?: (targetKey: string) => unknown
  /** Thrown synchronously from a disposer, as a backend with a breaking close would. */
  readonly closeThrows?: Error
  /** Rejected by a disposer's returned promise. */
  readonly closeRejects?: Error
}

interface FakeFs {
  readonly fs: WatchFileSystem
  readonly watches: FakeWatch[]
  readonly listCalls: string[]
  readonly resolveCalls: string[]
}

/**
 * A `WatchFileSystem` double: resolves every path to itself, lists from an in-memory tree, and records
 * each watch it installs so a test can emit changes, errors, and inspect closing.
 * @param options - the tree and any failures to inject.
 * @returns the port, plus the recorded calls and watches.
 */
function makeFakeFs(options: FakeFsOptions): FakeFs {
  const watches: FakeWatch[] = []
  const listCalls: string[] = []
  const resolveCalls: string[] = []
  const fs: WatchFileSystem = {
    async resolve(path) {
      resolveCalls.push(path)
      if (options.resolveError !== undefined) throw options.resolveError
      return { targetKey: path }
    },
    async listDir(target) {
      listCalls.push(target.targetKey)
      const failure = options.listError?.(target.targetKey)
      if (failure !== undefined) throw failure
      const entries = options.listing[target.targetKey]
      if (entries === undefined) throw new Error(`no listing for ${target.targetKey}`)
      return Object.entries(entries).map(([name, spec]) => ({
        name,
        type: spec.type,
        target: { targetKey: `${target.targetKey}/${name}` },
        ...spec.version === undefined ? {} : { version: spec.version },
        ...spec.size === undefined ? {} : { size: spec.size },
      }))
    },
    async watch(target, changed) {
      const failure = options.watchError?.(target.targetKey)
      if (failure !== undefined) throw failure
      const record: FakeWatch = {
        targetKey: target.targetKey,
        closed: 0,
        emit: () => changed(),
        emitError: (error: unknown) => changed(error as Error),
      }
      watches.push(record)
      return (): Promise<void> => {
        record.closed += 1
        // A synchronous throw here is a deliberate stand-in for a backend whose close fails before it
        // can hand back a promise.
        if (options.closeThrows !== undefined) throw options.closeThrows
        if (options.closeRejects !== undefined) return Promise.reject(options.closeRejects)
        return Promise.resolve()
      }
    },
  }
  return { fs, watches, listCalls, resolveCalls }
}

/** The watcher configuration tests share; every field can be overridden per test. */
function watchConfig(overrides: Partial<WatchConfig> = {}): WatchConfig {
  return {
    root: '/repo',
    exclude: [],
    respectGitignore: false,
    debounceMs: 100,
    maxWatchedDirectories: 10,
    sync: () => Promise.resolve({ filesChanged: 0, durationMs: 0 }),
    ...overrides,
  }
}

/** A small workspace tree: root → src → nested, plus a file at each level. */
function repoListing(): Listing {
  return {
    '/repo': { src: directory(), 'a.ts': file('a1') },
    '/repo/src': { nested: directory(), 'b.ts': file('b1') },
    '/repo/src/nested': { 'c.ts': file('c1') },
  }
}

/** A promise a test resolves by hand, used to hold one backend call open. */
interface Deferred {
  readonly promise: Promise<void>
  resolve(): void
}

/**
 * Create a promise the test settles explicitly.
 * @returns the promise and its resolver.
 */
function defer(): Deferred {
  let resolve: () => void = () => {}
  const promise = new Promise<void>((settle) => {
    resolve = settle
  })
  return { promise, resolve: () => resolve() }
}

/** Let queued microtasks settle; every backend call here is an already-resolved promise. */
async function settle(times = 100): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Wait on the real clock, for the tests that let real filesystem I/O (a `.gitignore` read) finish. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** The directories a fake backend was asked to watch, sorted for a stable comparison. */
function watchedPaths(fake: FakeFs): string[] {
  return fake.watches.map(watch => watch.targetKey).sort()
}

describe('createWatcher over the filesystem seam', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('watches the root and every in-scope subdirectory, but not files or excluded directories', async () => {
    const listing = repoListing()
    listing['/repo']!.node_modules = directory()
    listing['/repo/node_modules'] = { 'dep.js': file('d1') }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ exclude: ['node_modules'] }), fake.fs)
    watcher.start()
    await settle()
    expect(watchedPaths(fake)).toEqual(['/repo', '/repo/src', '/repo/src/nested'])
  })

  it('is idempotent: a second start() while already running installs nothing more', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()
    watcher.start()
    await settle()
    expect(fake.watches).toHaveLength(3)
  })

  it('does nothing on stop() before start(), and closes every watch on stop()', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const watcher = createWatcher(watchConfig(), fake.fs)
    expect(() => watcher.stop()).not.toThrow()
    watcher.start()
    await settle()
    watcher.stop()
    expect(fake.watches.map(watch => watch.closed)).toEqual([1, 1, 1])
  })

  it('swallows a disposer that throws synchronously and one whose promise rejects', async () => {
    const syncFake = makeFakeFs({ listing: repoListing(), closeThrows: new Error('close broke') })
    const syncWatcher = createWatcher(watchConfig(), syncFake.fs)
    syncWatcher.start()
    await settle()
    expect(() => syncWatcher.stop()).not.toThrow()
    expect(syncFake.watches.map(watch => watch.closed)).toEqual([1, 1, 1])

    const asyncFake = makeFakeFs({ listing: repoListing(), closeRejects: new Error('close rejected') })
    const asyncWatcher = createWatcher(watchConfig(), asyncFake.fs)
    asyncWatcher.start()
    await settle()
    asyncWatcher.stop()
    await settle()
    expect(asyncFake.watches.map(watch => watch.closed)).toEqual([1, 1, 1])
  })

  it('closes a watch that finishes initializing after stop() instead of adopting it', async () => {
    const base = makeFakeFs({ listing: repoListing() })
    const gate = defer()
    const gated: WatchFileSystem = {
      ...base.fs,
      watch: async (target, changed, signal) => {
        await gate.promise
        return base.fs.watch(target, changed, signal)
      },
    }
    const watcher = createWatcher(watchConfig(), gated)
    watcher.start()
    await settle()
    watcher.stop()
    gate.resolve()
    await settle()
    expect(base.watches.map(watch => watch.closed)).toEqual([1])
    // Nothing was adopted, so nothing is left to close on a later teardown.
    watcher.stop()
    expect(base.watches.map(watch => watch.closed)).toEqual([1])
  })

  it('does not throw and watches nothing when the root cannot be resolved', async () => {
    const fake = makeFakeFs({ listing: repoListing(), resolveError: new Error('workspace moved') })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    expect(() => watcher.start()).not.toThrow()
    await settle()
    expect(fake.resolveCalls).toEqual(['/repo'])
    expect(fake.watches).toHaveLength(0)
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('attributes a change by re-listing the directory and diffing it against the last listing', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    expect(sync).not.toHaveBeenCalled()

    // `a.ts` modified in place, `docs` created, `src` itself untouched.
    listing['/repo'] = { src: directory(), 'a.ts': file('a2'), 'docs': directory() }
    listing['/repo/docs'] = {}
    // `c.ts` removed from a nested directory, reported by that directory's own watch.
    listing['/repo/src/nested'] = {}
    fake.watches.find(watch => watch.targetKey === '/repo')!.emit()
    await settle()
    expect(watcher.getPendingFiles().sort()).toEqual(['a.ts', 'docs'])

    fake.watches.find(watch => watch.targetKey === '/repo/src/nested')!.emit()
    await settle()
    expect(watcher.getPendingFiles().sort()).toEqual(['a.ts', 'docs', 'src/nested/c.ts'])
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]![0]).toEqual(expect.arrayContaining(['a.ts', 'docs', 'src/nested/c.ts']))
  })

  it('detects an in-place change by size when the backend reports no version', async () => {
    const listing: Listing = {
      '/repo': { 'a.ts': { type: 'file', size: 4 }, 'b.ts': { type: 'file', size: 4 } },
    }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()

    listing['/repo'] = { 'a.ts': { type: 'file', size: 9 }, 'b.ts': { type: 'file', size: 4 } }
    fake.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual(['a.ts'])
  })

  it('detects a change of entry type, which no version or size comparison would catch', async () => {
    const listing: Listing = { '/repo': { thing: file('v1', 4) } }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()

    listing['/repo'] = { thing: directory('v1') }
    listing['/repo/thing'] = {}
    fake.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual(['thing'])
    expect(watchedPaths(fake)).toContain('/repo/thing')
  })

  it('treats an unchanged listing as no change, so no rebuild is armed', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()

    fake.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('reports a root-level entry that disappeared as a changed path', async () => {
    const listing: Listing = { '/repo': { 'a.ts': file('a1'), 'b.ts': file('b1') } }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()

    listing['/repo'] = { 'b.ts': file('b1') }
    fake.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual(['a.ts'])
  })

  it('starts watching a directory created after start(), and forwards its own changes', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    expect(fake.watches.some(watch => watch.targetKey === '/repo/newdir')).toBe(false)

    listing['/repo'].newdir = directory()
    listing['/repo/newdir'] = { 'd.ts': file('d1') }
    fake.watches.find(watch => watch.targetKey === '/repo')!.emit()
    await settle()
    expect(watchedPaths(fake)).toContain('/repo/newdir')
    expect(watcher.getPendingFiles()).toEqual(['newdir'])

    listing['/repo/newdir'] = { 'd.ts': file('d2') }
    fake.watches.find(watch => watch.targetKey === '/repo/newdir')!.emit()
    await settle()
    expect(watcher.getPendingFiles().sort()).toEqual(['newdir', 'newdir/d.ts'])
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('never watches a directory an exclusion rule covers, even when it appears later', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ exclude: ['node_modules'] }), fake.fs)
    watcher.start()
    await settle()

    listing['/repo'].node_modules = directory()
    listing['/repo/node_modules'] = { 'x.js': file('x1') }
    fake.watches.find(watch => watch.targetKey === '/repo')!.emit()
    await settle()
    expect(watchedPaths(fake)).toEqual(['/repo', '/repo/src', '/repo/src/nested'])
    expect(watcher.getPendingFiles()).toEqual([])
  })

  it('coalesces a burst for one directory into one listing plus one follow-up listing', async () => {
    const listing: Listing = { '/repo': { 'a.ts': file('a1') } }
    const base = makeFakeFs({ listing })
    const gate = defer()
    let gateNext = false
    const gated: WatchFileSystem = {
      ...base.fs,
      listDir: async (target, signal) => {
        if (gateNext) {
          gateNext = false
          await gate.promise
        }
        return base.fs.listDir(target, signal)
      },
    }
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), gated)
    watcher.start()
    await settle()
    expect(base.listCalls).toEqual(['/repo'])

    gateNext = true
    listing['/repo'] = { 'a.ts': file('a2') }
    base.watches[0]!.emit()
    base.watches[0]!.emit()
    await settle()
    gate.resolve()
    await settle()
    // One listing was already in flight; the second notification is folded into exactly one more.
    expect(base.listCalls).toEqual(['/repo', '/repo', '/repo'])
    expect(watcher.getPendingFiles()).toEqual(['a.ts'])
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
  })

  it('rebuilds without a path list when the re-listing itself fails', async () => {
    const base = makeFakeFs({ listing: repoListing() })
    let failing = false
    const flaky: WatchFileSystem = {
      ...base.fs,
      listDir: async (target, signal) => {
        if (failing && target.targetKey === '/repo') throw new Error('listing refused')
        return base.fs.listDir(target, signal)
      },
    }
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), flaky)
    watcher.start()
    await settle()

    failing = true
    base.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual([])
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]).toEqual([undefined])
  })

  it('keeps a watch whose initial listing fails, and rebuilds when it reports a change', async () => {
    const listing = repoListing()
    delete listing['/repo/src']
    const fake = makeFakeFs({ listing })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    // `src` is watched (it was listed as a directory), but its own children could not be enumerated.
    expect(watchedPaths(fake)).toEqual(['/repo', '/repo/src'])
    expect(sync).not.toHaveBeenCalled()

    fake.watches.find(watch => watch.targetKey === '/repo/src')!.emit()
    await settle()
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
    expect(sync.mock.calls[0]).toEqual([undefined])
  })

  it('degrades once the per-directory watch cap is reached, instead of covering part of the tree', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ maxWatchedDirectories: 2, onDegraded }), fake.fs)
    watcher.start()
    await settle()
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ code: 'WATCH_LIMIT_EXCEEDED' })
    expect(watcher.isDegraded()).toBe(true)
    expect(fake.watches.length).toBeLessThanOrEqual(2)
    expect(fake.watches.every(watch => watch.closed === 1)).toBe(true)
  })

  it('degrades when the backend reports it cannot watch, closing what was already installed', async () => {
    const fake = makeFakeFs({
      listing: repoListing(),
      watchError: targetKey => (targetKey === '/repo/src' ? Object.assign(new Error('unsupported'), { code: 'FS_IO_ERROR' }) : undefined),
    })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    watcher.start()
    await settle()
    expect(watcher.isDegraded()).toBe(true)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded.mock.calls[0]![0]).toMatchObject({ code: 'WATCH_UNAVAILABLE' })
    expect(fake.watches.map(watch => watch.closed)).toEqual([1])
  })

  it('degrades as RESOURCE_EXHAUSTED when watch initialization runs out of descriptors', async () => {
    const emfile: NodeJS.ErrnoException = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    const fake = makeFakeFs({ listing: repoListing(), watchError: () => emfile })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    watcher.start()
    await settle()
    expect(onDegraded).toHaveBeenCalledWith({ code: 'RESOURCE_EXHAUSTED', cause: emfile })
  })

  it('only reports the first degradation of several racing against each other', async () => {
    const emfile: NodeJS.ErrnoException = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
    const fake = makeFakeFs({ listing: repoListing() })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    watcher.start()
    await settle()
    fake.watches.find(watch => watch.targetKey === '/repo')!.emitError(emfile)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(watcher.isDegraded()).toBe(true)
    // A second failure after degrading is a no-op: the latch is one-way until the next start().
    fake.watches.find(watch => watch.targetKey === '/repo')!.emitError(emfile)
    expect(onDegraded).toHaveBeenCalledTimes(1)
  })

  it('degrades when a running watch reports FS_IO_ERROR', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    watcher.start()
    await settle()
    fake.watches[0]!.emitError(Object.assign(new Error('watch lost'), { code: 'FS_IO_ERROR' }))
    expect(onDegraded).toHaveBeenCalledWith({ code: 'WATCH_UNAVAILABLE', cause: expect.any(Error) })
    expect(watcher.isDegraded()).toBe(true)
  })

  it('only reports the first of two degradations racing against each other', async () => {
    const listing: Listing = { '/repo': { 'a.ts': file('a1') } }
    const fake = makeFakeFs({ listing })
    const onDegraded = vi.fn()
    let rejectSync: ((cause: unknown) => void) | undefined
    const sync = vi.fn(() => new Promise<{ filesChanged: number; durationMs: number }>((_resolve, reject) => {
      rejectSync ??= reject
    }))
    const watcher = createWatcher(watchConfig({ sync, onDegraded }), fake.fs)
    watcher.start()
    await settle()

    // Two failures short of the sync-failure limit.
    for (let index = 0; index < 2; index++) {
      listing['/repo'] = { 'a.ts': file(`a${index + 2}`) }
      fake.watches[0]!.emit()
      await settle()
      vi.advanceTimersByTime(100)
      rejectSync?.(new Error(`sync failure ${index + 1}`))
      rejectSync = undefined
      await settle()
    }

    // The third sync is still in flight when a watch error degrades the watcher first.
    listing['/repo'] = { 'a.ts': file('a9') }
    fake.watches[0]!.emit()
    await settle()
    vi.advanceTimersByTime(100)
    fake.watches[0]!.emitError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ code: 'RESOURCE_EXHAUSTED', cause: expect.any(Error) })

    // The in-flight sync now settles as the third consecutive failure — degrade() runs again, but the
    // one-way latch means onDegraded never fires a second time.
    rejectSync?.(new Error('sync failure 3'))
    await settle()
    expect(onDegraded).toHaveBeenCalledTimes(1)
  })

  it('ignores an error it does not recognize as a loss of watching, and any error after stop()', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), fake.fs)
    watcher.start()
    await settle()
    const rootWatch = fake.watches.find(watch => watch.targetKey === '/repo')!
    rootWatch.emitError(new Error('something else'))
    rootWatch.emitError('a plain string, not even an Error')
    rootWatch.emitError(null)
    expect(watcher.isDegraded()).toBe(false)
    expect(onDegraded).not.toHaveBeenCalled()

    watcher.stop()
    rootWatch.emitError(Object.assign(new Error('too many open files'), { code: 'EMFILE' }))
    expect(watcher.isDegraded()).toBe(false)
    expect(onDegraded).not.toHaveBeenCalled()
  })

  it('clears a prior degradation and retries when start() is called again', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()
    fake.watches[0]!.emitError(Object.assign(new Error('x'), { code: 'EMFILE' }))
    expect(watcher.isDegraded()).toBe(true)

    watcher.start()
    await settle()
    expect(watcher.isDegraded()).toBe(false)
    expect(fake.watches).toHaveLength(6)
    expect(fake.watches.slice(3).map(watch => watch.targetKey)).toEqual(['/repo', '/repo/src', '/repo/src/nested'])
  })

  it('stops installing new watches when the tree changes under a watcher that was already stopped', async () => {
    const listing = repoListing()
    const base = makeFakeFs({ listing })
    let watcher: ReturnType<typeof createWatcher> | undefined
    const stopping: WatchFileSystem = {
      ...base.fs,
      listDir: async (target, signal) => {
        // `stop()` lands between listing the root and descending into the children it returned.
        if (target.targetKey === '/repo') watcher?.stop()
        return base.fs.listDir(target, signal)
      },
    }
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    watcher = createWatcher(watchConfig({ sync }), stopping)
    watcher.start()
    await settle()
    expect(base.watches.map(watch => watch.targetKey)).toEqual(['/repo'])
    expect(watcher.getPendingFiles()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('drops a re-listing that was in flight when the watcher stopped', async () => {
    const listing: Listing = { '/repo': { 'a.ts': file('a1') } }
    const base = makeFakeFs({ listing })
    const gate = defer()
    let release = false
    const gated: WatchFileSystem = {
      ...base.fs,
      listDir: async (target, signal) => {
        if (release) await gate.promise
        return base.fs.listDir(target, signal)
      },
    }
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), gated)
    watcher.start()
    await settle()

    release = true
    listing['/repo'] = { 'a.ts': file('a2') }
    base.watches[0]!.emit()
    await settle()
    watcher.stop()
    gate.resolve()
    await settle()
    expect(watcher.getPendingFiles()).toEqual([])
    vi.advanceTimersByTime(1_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('treats a watch failure that lands after stop() as a canceled initialization', async () => {
    const gate = defer()
    const base = makeFakeFs({ listing: repoListing() })
    const gated: WatchFileSystem = {
      ...base.fs,
      watch: async () => {
        await gate.promise
        throw Object.assign(new Error('late watch failure'), { code: 'EMFILE' })
      },
    }
    const onDegraded = vi.fn()
    const watcher = createWatcher(watchConfig({ onDegraded }), gated)
    watcher.start()
    await settle()
    watcher.stop()
    gate.resolve()
    await settle()
    expect(watcher.isDegraded()).toBe(false)
    expect(onDegraded).not.toHaveBeenCalled()
    expect(base.watches).toHaveLength(0)
  })

  it('does not arm anything when the session ends while the root is being resolved', async () => {
    const gate = defer()
    const base = makeFakeFs({ listing: repoListing() })
    const gated: WatchFileSystem = {
      ...base.fs,
      resolve: async (path, opts) => {
        await gate.promise
        return base.fs.resolve(path, opts)
      },
    }
    const watcher = createWatcher(watchConfig(), gated)
    watcher.start()
    await settle()
    watcher.stop()
    gate.resolve()
    await settle()
    expect(base.watches).toHaveLength(0)
  })

  it('ignores a change reported after the watcher stopped', async () => {
    const fake = makeFakeFs({ listing: repoListing() })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    const rootWatch = fake.watches.find(watch => watch.targetKey === '/repo')!
    watcher.stop()
    rootWatch.emit()
    await settle()
    vi.advanceTimersByTime(1_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('debounces changes from several directories into one sync call', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()

    listing['/repo'] = { src: directory(), 'a.ts': file('a2') }
    listing['/repo/src'] = { 'b.ts': file('b2') }
    fake.watches.find(watch => watch.targetKey === '/repo')!.emit()
    await settle()
    fake.watches.find(watch => watch.targetKey === '/repo/src')!.emit()
    await settle()
    vi.advanceTimersByTime(50)
    expect(sync).not.toHaveBeenCalled()
    vi.advanceTimersByTime(50)
    expect(sync).toHaveBeenCalledTimes(1)
    // Both directories' changes land in one batch; dropping `nested` from `src`'s listing is itself
    // a change the diff reports.
    expect(sync.mock.calls[0]![0]).toEqual(expect.arrayContaining(['a.ts', 'src/b.ts', 'src/nested']))
  })

  it('reports what is pending mid-debounce and clears it once a sync starts', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig(), fake.fs)
    watcher.start()
    await settle()
    listing['/repo'] = { src: directory(), 'a.ts': file('a2') }
    fake.watches[0]!.emit()
    await settle()
    expect(watcher.getPendingFiles()).toEqual(['a.ts'])
    vi.advanceTimersByTime(100)
    expect(watcher.getPendingFiles()).toEqual([])
  })

  it('cancels a pending debounce on stop()', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const sync = vi.fn(() => Promise.resolve({ filesChanged: 0, durationMs: 0 }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    listing['/repo'] = { src: directory(), 'a.ts': file('a2') }
    fake.watches[0]!.emit()
    await settle()
    watcher.stop()
    vi.advanceTimersByTime(1_000)
    expect(sync).not.toHaveBeenCalled()
  })

  it('degrades after three consecutive sync failures, and a success in between resets the count', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const onDegraded = vi.fn()
    let call = 0
    const sync = vi.fn(() => {
      call += 1
      // Fails, fails, succeeds, fails, fails, fails — the reset means the third real failure run
      // (the 6th call) is only the third *consecutive* one.
      if (call === 3) return Promise.resolve({ filesChanged: 0, durationMs: 0 })
      return Promise.reject(new Error(`sync failure ${call}`))
    })
    const watcher = createWatcher(watchConfig({ sync, onDegraded }), fake.fs)
    watcher.start()
    await settle()
    for (let index = 0; index < 6; index++) {
      listing['/repo'] = { src: directory(), 'a.ts': file(`a${index + 2}`) }
      fake.watches.find(watch => watch.targetKey === '/repo')!.emit()
      await settle()
      vi.advanceTimersByTime(100)
      await settle()
    }
    expect(sync).toHaveBeenCalledTimes(6)
    expect(onDegraded).toHaveBeenCalledTimes(1)
    expect(onDegraded).toHaveBeenCalledWith({ code: 'SYNC_FAILURE_LIMIT', cause: new Error('sync failure 6') })
  })

  it('re-arms pending paths from a failed sync so the next run retries them', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ sync: () => Promise.reject(new Error('nope')) }), fake.fs)
    watcher.start()
    await settle()
    listing['/repo'] = { src: directory(), 'a.ts': file('a2') }
    fake.watches[0]!.emit()
    await settle()
    vi.advanceTimersByTime(100)
    await settle()
    expect(watcher.getPendingFiles()).toEqual(['a.ts'])
  })

  it('queues one more sync round when a debounce fires while a sync is already in flight', async () => {
    const listing = repoListing()
    const fake = makeFakeFs({ listing })
    let resolveFirst: (() => void) | undefined
    const sync = vi.fn(() => new Promise<{ filesChanged: number; durationMs: number }>((resolve) => {
      resolveFirst ??= () => resolve({ filesChanged: 0, durationMs: 0 })
    }))
    const watcher = createWatcher(watchConfig({ sync }), fake.fs)
    watcher.start()
    await settle()
    listing['/repo'] = { src: directory(), 'a.ts': file('a2') }
    fake.watches[0]!.emit()
    await settle()
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)

    // A second change arrives, and its debounce window fully elapses, while the first sync is pending.
    listing['/repo'] = { src: directory(), 'a.ts': file('a3') }
    fake.watches[0]!.emit()
    await settle()
    vi.advanceTimersByTime(100)
    expect(sync).toHaveBeenCalledTimes(1)
    resolveFirst?.()
    await settle()
    expect(sync).toHaveBeenCalledTimes(2)
    expect(sync.mock.calls[1]![0]).toEqual(['a.ts'])
  })
})

describe('createWatcher exclusion parity with the walk (real .gitignore)', () => {
  it('does not watch a directory the project .gitignore excludes', async () => {
    const root = await writeProject({ '.gitignore': 'lib/\n', 'src/a.ts': 'export const a = 1\n' })
    const listing: Listing = {
      [root]: { src: directory(), lib: directory() },
      [`${root}/src`]: { 'a.ts': file('a1') },
      [`${root}/lib`]: { 'a.ts': file('a1') },
    }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ root, respectGitignore: true }), fake.fs)
    watcher.start()
    // The `.gitignore` read is real filesystem I/O, so this waits on the real clock.
    await sleep(100)
    expect(watchedPaths(fake)).toEqual([root, `${root}/src`].sort())
  })

  it('watches a gitignored directory when respectGitignore is false', async () => {
    const root = await writeProject({ '.gitignore': 'lib/\n', 'src/a.ts': 'export const a = 1\n' })
    const listing: Listing = {
      [root]: { src: directory(), lib: directory() },
      [`${root}/src`]: { 'a.ts': file('a1') },
      [`${root}/lib`]: { 'a.ts': file('a1') },
    }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ root }), fake.fs)
    watcher.start()
    await sleep(100)
    expect(watchedPaths(fake)).toEqual([root, `${root}/src`, `${root}/lib`].sort())
  })

  it('installs nothing when stop() runs before the .gitignore read settles', async () => {
    const root = await writeProject({ '.gitignore': 'lib/\n', 'src/a.ts': 'export const a = 1\n' })
    const listing: Listing = { [root]: { src: directory() } }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ root, respectGitignore: true }), fake.fs)
    watcher.start()
    watcher.stop()
    await sleep(100)
    expect(fake.resolveCalls).toEqual([])
    expect(fake.watches).toHaveLength(0)
  })

  it('waits for the .gitignore read before arming the first watch', async () => {
    const root = await writeProject({ '.gitignore': 'lib/\n' })
    const listing: Listing = { [root]: { src: directory() } }
    const fake = makeFakeFs({ listing })
    const watcher = createWatcher(watchConfig({ root, respectGitignore: true, debounceMs: 50 }), fake.fs)
    watcher.start()
    await sleep(100)
    expect(fake.resolveCalls).toEqual([root])
    expect(fake.watches.map(watch => watch.targetKey).sort()).toEqual([root, `${root}/src`].sort())
  })
})
