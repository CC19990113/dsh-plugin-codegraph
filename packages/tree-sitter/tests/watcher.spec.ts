import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createWatcher } from '../src/watcher.ts'
import type { WatchHandle, WatchPrimitive } from '../src/watcher.ts'
import { writeProject } from './fixture.ts'

/** One watch a fake primitive established, with a way to drive its callbacks from a test. */
interface FakeWatch {
  readonly path: string
  readonly recursive: boolean
  readonly handle: WatchHandle
  closed: boolean
  emit(eventType: 'rename' | 'change', filename: string | null): void
  emitError(error: unknown): void
}

/** A `WatchPrimitive` double: records every call, lets tests drive events/errors, never touches the OS. */
function fakePrimitive(options?: { throwFor?: (path: string, recursive: boolean) => unknown }): {
  primitive: WatchPrimitive
  watches: FakeWatch[]
} {
  const watches: FakeWatch[] = []
  const primitive: WatchPrimitive = (path, opts, onEvent, onError) => {
    const thrown = options?.throwFor?.(path, opts.recursive)
    if (thrown !== undefined) throw thrown
    const handle: WatchHandle = { close: () => { entry.closed = true } }
    const entry: FakeWatch = {
      path,
      recursive: opts.recursive,
      handle,
      closed: false,
      emit: (eventType, filename) => onEvent(eventType, filename),
      emitError: (error) => onError(error),
    }
    watches.push(entry)
    return handle
  }
  return { primitive, watches }
}

/**
 * Run a platform-specific block with `process.platform` overridden, restoring it afterward — only
 * once `fn` (sync or async) has fully settled, so an async block's later steps still see the override.
 */
async function withPlatform<T>(platform: NodeJS.Platform, fn: () => T | Promise<T>): Promise<T> {
  const original = process.platform
  Object.defineProperty(process, 'platform', { value: platform, configurable: true })
  try {
    return await fn()
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true })
  }
}

/**
 * Let queued microtasks (a mocked `sync`'s promise chain: `.then().catch().finally()`, each a separate
 * tick) settle before asserting. Only meaningful under fake timers — nothing here touches real I/O.
 */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

/** Wait on the real clock for real filesystem I/O (readdir/stat inside the watcher) to complete. */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const noopSync = () => Promise.resolve({ filesChanged: 0, durationMs: 0 })

describe('createWatcher on macOS/Windows (single recursive watch)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('installs exactly one recursive watch on start()', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      expect(watches).toHaveLength(1)
      expect(watches[0]).toMatchObject({ path: '/repo', recursive: true })
    })
  })

  it('is idempotent: a second start() while already running installs nothing more', async () => {
    await withPlatform('win32', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      watcher.start()
      expect(watches).toHaveLength(1)
    })
  })

  it('debounces multiple events into one sync call, batching every path seen', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      const watch = watches[0]!
      watch.emit('change', 'a.ts')
      vi.advanceTimersByTime(50)
      watch.emit('change', 'b.ts')
      vi.advanceTimersByTime(50)
      // Only 100ms since the *second* event has elapsed; a real debounce would not have fired yet.
      expect(sync).not.toHaveBeenCalled()
      vi.advanceTimersByTime(50)
      expect(sync).toHaveBeenCalledTimes(1)
      expect(sync).toHaveBeenCalledWith(expect.arrayContaining(['a.ts', 'b.ts']))
    })
  })

  it('drops an event under an excluded directory before it ever arms the debounce', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root: '/repo', exclude: ['node_modules'], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      watches[0]!.emit('change', 'node_modules/dep/index.js')
      vi.advanceTimersByTime(1_000)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('ignores an event with no filename', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      watches[0]!.emit('change', null)
      vi.advanceTimersByTime(1_000)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('clears pendingFiles once a sync starts, and reports what is pending mid-debounce', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      watches[0]!.emit('change', 'a.ts')
      expect(watcher.getPendingFiles()).toEqual(['a.ts'])
      vi.advanceTimersByTime(100)
      expect(watcher.getPendingFiles()).toEqual([])
    })
  })

  it('degrades once and stops watching on EMFILE, and does not restart on its own', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync, onDegraded,
      }, primitive)
      watcher.start()
      const emfile: NodeJS.ErrnoException = Object.assign(new Error('too many open files'), { code: 'EMFILE' })
      watches[0]!.emitError(emfile)
      expect(watcher.isDegraded()).toBe(true)
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith({ code: 'RESOURCE_EXHAUSTED', cause: emfile })
      expect(watches[0]!.closed).toBe(true)

      // A second error after degrading does not re-fire onDegraded (one-way latch).
      watches[0]!.emitError(Object.assign(new Error('again'), { code: 'ENFILE' }))
      expect(onDegraded).toHaveBeenCalledTimes(1)
    })
  })

  it('degrades on ENOSPC (the Linux inotify-limit code) too', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync, onDegraded,
      }, primitive)
      watcher.start()
      watches[0]!.emitError(Object.assign(new Error('no space'), { code: 'ENOSPC' }))
      expect(watcher.isDegraded()).toBe(true)
    })
  })

  it('does not degrade on a watch error it does not recognize as resource exhaustion', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync, onDegraded,
      }, primitive)
      watcher.start()
      watches[0]!.emitError(new Error('something else'))
      watches[0]!.emitError('a plain string, not even an Error')
      watches[0]!.emitError(null)
      expect(watcher.isDegraded()).toBe(false)
      expect(onDegraded).not.toHaveBeenCalled()
    })
  })

  it('only reports the first of two degradations racing against each other', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      let resolveSync: (() => void) | undefined
      const sync = vi.fn(() => new Promise<{ filesChanged: number; durationMs: number }>((_resolve, reject) => {
        resolveSync ??= () => reject(new Error('lost the race'))
      }))
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync, onDegraded,
      }, primitive)
      watcher.start()
      const watch = watches[0]!
      // Two failures short of the sync-failure limit, then leave the third in flight.
      watch.emit('change', 'a.ts')
      vi.advanceTimersByTime(100)
      resolveSync?.()
      resolveSync = undefined
      await flushMicrotasks()
      watch.emit('change', 'b.ts')
      vi.advanceTimersByTime(100)
      resolveSync?.()
      resolveSync = undefined
      await flushMicrotasks()
      watch.emit('change', 'c.ts')
      vi.advanceTimersByTime(100)
      // The third sync is still pending when a watch error degrades the watcher first.
      watch.emitError(Object.assign(new Error('x'), { code: 'EMFILE' }))
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith({ code: 'RESOURCE_EXHAUSTED', cause: expect.any(Error) })
      // The pending sync now settles as the third consecutive failure — degrade() is called again,
      // but the one-way latch means onDegraded never fires a second time.
      resolveSync?.()
      await flushMicrotasks()
      expect(onDegraded).toHaveBeenCalledTimes(1)
    })
  })

  it('ignores an event whose path is empty, and one delivered after the watcher stopped', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      const watch = watches[0]!
      watch.emit('rename', '')
      vi.advanceTimersByTime(1_000)
      expect(sync).not.toHaveBeenCalled()

      watcher.stop()
      watch.emit('change', 'late.ts')
      vi.advanceTimersByTime(1_000)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('degrades after three consecutive sync failures, and a success in between resets the count', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      let call = 0
      const sync = vi.fn(() => {
        call++
        // Fails, fails, succeeds, fails, fails, fails — the reset means the third real failure run
        // (the 6th call) is only the third *consecutive* one.
        if (call === 3) return Promise.resolve({ filesChanged: 0, durationMs: 0 })
        return Promise.reject(new Error(`sync failure ${call}`))
      })
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync, onDegraded,
      }, primitive)
      watcher.start()
      const watch = watches[0]!
      for (let i = 0; i < 6; i++) {
        watch.emit('change', `file-${i}.ts`)
        vi.advanceTimersByTime(100)
        // Let the rejected/resolved sync promise settle before the next debounce window.
        await flushMicrotasks()
      }
      expect(sync).toHaveBeenCalledTimes(6)
      expect(onDegraded).toHaveBeenCalledTimes(1)
      expect(onDegraded).toHaveBeenCalledWith({ code: 'SYNC_FAILURE_LIMIT', cause: new Error('sync failure 6') })
    })
  })

  it('re-arms pending paths from a failed sync so the next run retries them', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(() => Promise.reject(new Error('nope')))
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      watches[0]!.emit('change', 'a.ts')
      vi.advanceTimersByTime(100)
      await flushMicrotasks()
      expect(watcher.getPendingFiles()).toEqual(['a.ts'])
    })
  })

  it('queues one more sync round when a debounce fires while a sync is already in flight', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      let resolveFirst: (() => void) | undefined
      const sync = vi.fn(() => new Promise<{ filesChanged: number; durationMs: number }>((resolve) => {
        resolveFirst ??= () => resolve({ filesChanged: 0, durationMs: 0 })
      }))
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      const watch = watches[0]!
      watch.emit('change', 'a.ts')
      vi.advanceTimersByTime(100)
      expect(sync).toHaveBeenCalledTimes(1)
      // A second change arrives, and its debounce window fully elapses, while the first sync is
      // still pending.
      watch.emit('change', 'b.ts')
      vi.advanceTimersByTime(100)
      expect(sync).toHaveBeenCalledTimes(1)
      resolveFirst?.()
      await flushMicrotasks()
      // The queued round runs immediately once the in-flight sync settles, without waiting out
      // another debounce window.
      expect(sync).toHaveBeenCalledTimes(2)
      expect(sync).toHaveBeenLastCalledWith(['b.ts'])
    })
  })

  it('stops watching and cancels a pending debounce on stop()', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      watches[0]!.emit('change', 'a.ts')
      watcher.stop()
      expect(watches[0]!.closed).toBe(true)
      vi.advanceTimersByTime(1_000)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('clears a prior degradation and retries when start() is called again', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      watches[0]!.emitError(Object.assign(new Error('x'), { code: 'EMFILE' }))
      expect(watcher.isDegraded()).toBe(true)
      watcher.start()
      expect(watcher.isDegraded()).toBe(false)
      expect(watches).toHaveLength(2)
    })
  })

  it('falls back silently when the primitive itself throws on the initial recursive call', async () => {
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive({ throwFor: () => new Error('not supported here') })
      const onDegraded = vi.fn()
      const watcher = createWatcher({
        root: '/repo', exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync, onDegraded,
      }, primitive)
      expect(() => watcher.start()).not.toThrow()
      expect(watches).toHaveLength(0)
    })
  })

  it('eventually respects .gitignore on the recursive watch too, once the initial read resolves', async () => {
    // The recursive install itself must stay synchronous (every test above depends on that), so the
    // gitignore read here is fire-and-forget — real fs I/O, which needs the real clock to settle.
    vi.useRealTimers()
    const root = await writeProject({ '.gitignore': 'lib/\n', 'src/a.ts': 'export const a = 1\n', 'lib/a.ts': '' })
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: true, debounceMs: 50,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      await sleep(100)
      const rootWatch = watches.find(w => w.path === root)!
      rootWatch.emit('change', 'lib/a.ts')
      await sleep(150)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('does not apply a gitignore read that resolves after stop() already ran', async () => {
    vi.useRealTimers()
    const root = await writeProject({ '.gitignore': 'lib/\n', 'src/a.ts': 'export const a = 1\n' })
    await withPlatform('darwin', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: true, debounceMs: 50,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      watcher.stop()
      // The fire-and-forget gitignore read is still in flight; let it resolve and confirm it does not
      // throw or resurrect state on a watcher that already tore down.
      await sleep(100)
      expect(watches[0]!.closed).toBe(true)
    })
  })
})

describe('createWatcher on Linux (per-directory watches)', () => {
  // Real fs.readdir/stat calls happen inside the watcher on this platform, so these tests run on the
  // real clock and wait on it — fake timers can't advance past genuine filesystem I/O.

  it('watches the root and every non-excluded subdirectory, but not files or excluded dirs', async () => {
    const root = await writeProject({
      'src/a.ts': 'export const a = 1\n',
      'src/nested/b.ts': 'export const b = 1\n',
      'node_modules/dep/index.js': '',
      '.git/config': '',
    })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: ['node_modules', '.git'], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      await sleep(100)
      const watchedPaths = watches.map(w => w.path).sort()
      expect(watchedPaths).toEqual([root, `${root}/src`, `${root}/src/nested`].sort())
    })
  })

  it('respects .gitignore when walking the initial watch tree', async () => {
    const root = await writeProject({
      '.gitignore': 'lib/\n',
      'src/a.ts': 'export const a = 1\n',
      'lib/a.ts': 'export const a = 1\n',
    })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: true, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      await sleep(100)
      expect(watches.map(w => w.path).sort()).toEqual([root, `${root}/src`].sort())
    })
  })

  it('does not watch a directory excluded by a nested prefix, even reached via an event path', async () => {
    const root = await writeProject({ 'node_modules/dep/index.js': '', 'src/a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root, exclude: ['node_modules'], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      await sleep(100)
      // node_modules was never descended into, so its own directory watch never got installed — the
      // only way an event under it could arrive is the root's watch on some other platform. Simulate
      // that here to prove the path-level exclusion, not just the directory-walk one, holds.
      const rootWatch = watches.find(w => w.path === root)!
      rootWatch.emit('change', 'node_modules/dep/index.js')
      await sleep(150)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('does not walk the tree at all once stop() runs before the initial gitignore read settles', async () => {
    const root = await writeProject({ 'src/a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: true, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      watcher.stop()
      await sleep(100)
      expect(watches).toHaveLength(0)
    })
  })

  it('picks up a directory created after start(), watching it and forwarding its own events', async () => {
    const root = await writeProject({ 'src/a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      // A long debounce, so discovering the new directory (which itself schedules a sync) has a wide
      // safety margin against firing before the second event below ever arrives.
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 500,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      await sleep(100)
      const rootWatch = watches.find(w => w.path === root)!
      const fs = await import('node:fs/promises')
      await fs.mkdir(`${root}/newdir`)
      await fs.writeFile(`${root}/newdir/c.ts`, 'export const c = 1\n')
      rootWatch.emit('rename', 'newdir')
      await sleep(50)
      expect(watches.some(w => w.path === `${root}/newdir`)).toBe(true)
      expect(sync).not.toHaveBeenCalled()

      const newDirWatch = watches.find(w => w.path === `${root}/newdir`)!
      newDirWatch.emit('change', 'c.ts')
      await sleep(600)
      expect(sync).toHaveBeenCalledWith(['newdir', 'newdir/c.ts'])
    })
  })

  it('never mistakes a plain file event for a new directory', async () => {
    const root = await writeProject({ 'a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      await sleep(100)
      watches[0]!.emit('change', 'a.ts')
      await sleep(100)
      expect(watches).toHaveLength(1)
    })
  })

  it('ignores a per-directory watch event with no filename', async () => {
    const root = await writeProject({ 'a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const sync = vi.fn(noopSync)
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync,
      }, primitive)
      watcher.start()
      await sleep(100)
      watches[0]!.emit('change', null)
      await sleep(150)
      expect(sync).not.toHaveBeenCalled()
    })
  })

  it('ignores a rename for a path that no longer exists (already deleted again)', async () => {
    const root = await writeProject({ 'a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      await sleep(100)
      watches[0]!.emit('rename', 'gone')
      await sleep(100)
      expect(watches).toHaveLength(1)
    })
  })

  it('does not re-watch a directory it already watches', async () => {
    const root = await writeProject({ 'src/a.ts': 'export const a = 1\n' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      watcher.start()
      await sleep(100)
      const count = watches.length
      watches.find(w => w.path === root)!.emit('rename', 'src')
      await sleep(100)
      expect(watches).toHaveLength(count)
    })
  })

  it('degrades once the per-directory watch cap is reached, instead of covering only part of the tree', async () => {
    const root = await writeProject({
      'a/x.ts': '', 'b/x.ts': '', 'c/x.ts': '',
    })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive()
      const onDegraded = vi.fn()
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 2, sync: noopSync, onDegraded,
      }, primitive)
      watcher.start()
      await sleep(100)
      expect(onDegraded).toHaveBeenCalledWith({ code: 'WATCH_LIMIT_EXCEEDED' })
      expect(watcher.isDegraded()).toBe(true)
      expect(watches.length).toBeLessThanOrEqual(2)
    })
  })

  it('stops descending into a directory once the primitive itself fails to watch it', async () => {
    const root = await writeProject({ 'a/x.ts': '' })
    await withPlatform('linux', async () => {
      const { primitive, watches } = fakePrimitive({
        throwFor: path => (path === root ? new Error('cannot watch root') : undefined),
      })
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, primitive)
      expect(() => watcher.start()).not.toThrow()
      await sleep(100)
      expect(watches).toHaveLength(0)
    })
  })

  it('does not descend further into a directory removed the instant its own watch is installed', async () => {
    const root = await writeProject({ 'a/x.ts': '' })
    await withPlatform('linux', async () => {
      const { rmSync } = await import('node:fs')
      const { primitive, watches } = fakePrimitive()
      // Remove the subdirectory synchronously, the instant its watch is installed and strictly before
      // readdir() lists it — a real race would only sometimes land this way, so force the ordering.
      const racy: WatchPrimitive = (path, opts, onEvent, onError) => {
        const handle = primitive(path, opts, onEvent, onError)
        if (path === `${root}/a`) rmSync(`${root}/a`, { recursive: true, force: true })
        return handle
      }
      const watcher = createWatcher({
        root, exclude: [], respectGitignore: false, debounceMs: 100,
        maxWatchedDirectories: 10, sync: noopSync,
      }, racy)
      expect(() => watcher.start()).not.toThrow()
      await sleep(100)
      // The watch on `a` itself was installed (its own directory still exists as a watch target even
      // once removed); what must NOT happen is a crash or a watch on some now-nonexistent child of it.
      expect(watches.map(w => w.path).sort()).toEqual([root, `${root}/a`].sort())
    })
  })
})
