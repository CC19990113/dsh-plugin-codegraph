/**
 * File-watch-driven reindexing: debounce a workspace's file-change events into a bounded number of
 * `sync` calls, using a per-platform strategy chosen to keep the open-descriptor / kernel-watch cost
 * BOUNDED rather than growing with the number of files:
 *
 *  - macOS / Windows: a SINGLE recursive `fs.watch(root, {recursive:true})`. This is the fix for the
 *    macOS file-table exhaustion a reference implementation hit watching one file descriptor per
 *    watched file (tens of thousands of REG fds), which exhausted `kern.maxfiles` and crashed
 *    unrelated processes system-wide (see NOTES.local.md). One recursive stream costs O(1)
 *    descriptors no matter how large the tree.
 *  - Linux: recursive `fs.watch` is unsupported, so one inotify watch is installed per (non-excluded)
 *    directory — O(directories), NOT O(files). New directories are picked up dynamically as events
 *    reveal them, and {@link WatchConfig.maxWatchedDirectories} bounds inotify usage on pathological
 *    monorepos.
 *
 * `sync` is always a full rebuild in this version: the `paths` a debounce window collected are passed
 * through but never consulted by the caller supplied here (`runIndex` reruns `walkAndExtract` over the
 * whole tree regardless). That keeps this file's only new correctness surface confined to "when do we
 * call sync", not "what does sync do with a subset of files" — the latter is deliberately deferred
 * until a real incremental reindex is built (see NOTES.local.md). Because sync is always full, a
 * directory delete or a `mkdir` immediately followed by writes inside it never needs special-casing:
 * the parent directory's own create event is enough to schedule a rebuild that discovers (or removes)
 * everything under the path from scratch, watched or not.
 * @module dsh-plugin-codegraph-tree-sitter/watcher
 */

import { readdir, stat } from 'node:fs/promises'
import { join, sep } from 'node:path'
import * as fs from 'node:fs'
import { loadGitignore } from './gitignore.ts'
import type { GitignoreRule } from './gitignore.ts'
import { isExcluded } from './walk.ts'

/** One raw watch event, in the shape `node:fs`'s `fs.watch` listener callback receives. */
export type WatchEventListener = (eventType: 'rename' | 'change', filename: string | null) => void

/** A watch error, in the shape `fs.watch`'s `'error'` event delivers. */
export type WatchErrorListener = (error: unknown) => void

/** A live OS-level watch, closeable independent of anything else this module tracks. */
export interface WatchHandle {
  close(): void
}

/**
 * Indirection over `fs.watch` so tests can inject a fake that emits events/errors deterministically —
 * `fs.watch` is a non-configurable module property that can't be spied, and provoking real EMFILE/
 * ENOSPC exhaustion in a test run isn't reliable. Production always uses {@link nodeWatch}.
 */
export type WatchPrimitive = (
  path: string,
  options: { readonly recursive: boolean },
  onEvent: WatchEventListener,
  onError: WatchErrorListener,
) => WatchHandle

/** The real `fs.watch`-backed primitive. */
export const nodeWatch: WatchPrimitive = (path, options, onEvent, onError) => {
  const watcher = fs.watch(path, { recursive: options.recursive, persistent: true }, onEvent)
  watcher.on('error', onError)
  return { close: () => watcher.close() }
}

/** Why live watching was permanently disabled for this watcher instance. */
export type DegradeReason =
  | { readonly code: 'RESOURCE_EXHAUSTED'; readonly cause: NodeJS.ErrnoException }
  | { readonly code: 'WATCH_LIMIT_EXCEEDED' }
  | { readonly code: 'SYNC_FAILURE_LIMIT'; readonly cause: unknown }

/** Error codes that mean "the OS ran out of watch resources", across the platforms that report them. */
const RESOURCE_EXHAUSTION_CODES = new Set(['EMFILE', 'ENFILE', 'ENOSPC'])

/** Consecutive sync failures tolerated before a watcher gives up and degrades. */
const SYNC_FAILURE_LIMIT = 3

/** Configuration a watcher needs to run: scope, timing, and the sync it drives. */
export interface WatchConfig {
  /** Absolute path of the workspace root to watch. */
  readonly root: string
  /** Directory/file segment names never watched, mirroring the indexer's own exclusion. */
  readonly exclude: readonly string[]
  /** Also exclude whatever the project root's `.gitignore` names, matching the indexer's own scope. */
  readonly respectGitignore: boolean
  /** Milliseconds of quiet after the last change before `sync` runs. */
  readonly debounceMs: number
  /** Hard cap on directories watched individually (Linux only); exceeding it degrades the watcher. */
  readonly maxWatchedDirectories: number
  /**
   * Run one reindex. `paths` are the project-relative paths a debounce window collected, offered for
   * a future incremental sync to consult; this version's caller always ignores them and rebuilds the
   * whole graph.
   */
  readonly sync: (paths?: readonly string[]) => Promise<{ filesChanged: number; durationMs: number }>
  /** Fired once, the first time live watching degrades permanently. */
  readonly onDegraded?: (reason: DegradeReason) => void
}

/** A running (or stopped) file watcher for one workspace root. */
export interface Watcher {
  /** Begin watching. Idempotent while already running; clears a prior degradation and retries. */
  start(): void
  /** Stop watching and release every OS-level watch. Does not itself count as degradation. */
  stop(): void
  /** Whether live watching has permanently degraded (until the next {@link start}). */
  isDegraded(): boolean
  /** Project-relative paths seen since the last debounce window fired a sync. */
  getPendingFiles(): readonly string[]
}

/**
 * Build a watcher over one workspace root. Nothing runs until {@link Watcher.start} is called.
 * @param config - scope, timing, and the sync callback to drive.
 * @param primitive - the watch primitive to use; defaults to the real `fs.watch`.
 */
export function createWatcher(config: WatchConfig, primitive: WatchPrimitive = nodeWatch): Watcher {
  const excluded = new Set(config.exclude)
  let gitignoreRules: readonly GitignoreRule[] = []
  const watchedDirs = new Set<string>()
  const handles: WatchHandle[] = []
  const pendingPaths = new Set<string>()

  let running = false
  let degraded = false
  let debounceTimer: NodeJS.Timeout | undefined
  let syncing = false
  let rerunNeeded = false
  let syncFailureCount = 0

  /** One-way: once degraded, only a fresh `start()` clears it. */
  function degrade(reason: DegradeReason): void {
    if (degraded) return
    degraded = true
    teardown()
    config.onDegraded?.(reason)
  }

  /** Close every live watch and clear the debounce timer, without touching `degraded`. */
  function teardown(): void {
    running = false
    for (const handle of handles.splice(0)) handle.close()
    watchedDirs.clear()
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }

  function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as NodeJS.ErrnoException).code)
      : undefined
  }

  function handleWatchError(error: unknown): void {
    if (!running || degraded) return
    const code = errorCode(error)
    if (code !== undefined && RESOURCE_EXHAUSTION_CODES.has(code)) {
      degrade({ code: 'RESOURCE_EXHAUSTED', cause: error as NodeJS.ErrnoException })
    }
    // An error this watcher doesn't recognize as resource exhaustion is left to the OS-level watch's
    // own reporting; it doesn't by itself prove live watching can no longer make progress.
  }

  function scheduleSync(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSync, config.debounceMs)
  }

  function runSync(): void {
    // Also called directly (not just as the timer callback) when a queued rerun fires immediately;
    // clear any timer a later event armed in the meantime so it can't fire a redundant, empty sync.
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
    if (syncing) {
      // A sync already in flight will miss whatever just fired this timer; ask for one more round
      // once it settles rather than starting a second sync concurrently.
      rerunNeeded = true
      return
    }
    const batch = [...pendingPaths]
    pendingPaths.clear()
    syncing = true
    // `batch` is never actually empty here: the only two ways into this function are the debounce
    // timer (armed exclusively by handleChange(), right after it adds to pendingPaths) and a queued
    // rerun (only set when handleChange() re-armed the timer while a sync was already in flight,
    // which itself added to pendingPaths). The `undefined` branch is API contract, not reachable code.
    /* v8 ignore next */
    config.sync(batch.length === 0 ? undefined : batch)
      .then(() => {
        syncFailureCount = 0
      })
      .catch((cause: unknown) => {
        // The sync never committed anything for this batch — put it back so the next run retries it,
        // exactly like a fresh set of events for the same paths would.
        for (const path of batch) pendingPaths.add(path)
        syncFailureCount++
        if (syncFailureCount >= SYNC_FAILURE_LIMIT) degrade({ code: 'SYNC_FAILURE_LIMIT', cause })
      })
      .finally(() => {
        syncing = false
        if (rerunNeeded) {
          rerunNeeded = false
          // Immediate, not another scheduleSync(): the paths behind this round already sat through a
          // full debounce window once (that's what set rerunNeeded), so making them wait out a second
          // one would only delay a sync that's already due.
          runSync()
        }
      })
  }

  /**
   * Whether one path segment, already known to sit inside in-scope ancestors, is itself in scope.
   * Used while recursing the initial watch tree, where every ancestor was already checked on the way
   * down — checking only the leaf segment here is enough, and cheaper than re-testing the whole path.
   */
  function segmentInScope(name: string, relativePath: string, isDirectory: boolean): boolean {
    return !isExcluded(name, relativePath, isDirectory, excluded, gitignoreRules)
  }

  /**
   * Whether a path an `fs.watch` event named — possibly several segments deep, with no guarantee any
   * ancestor was checked first (the recursive macOS/Windows watch reports the whole subtree in one
   * stream) — is in scope. Walks every prefix from the root down, exactly like the initial directory
   * walk would if it descended this far, so `node_modules/dep/index.js` is excluded by its
   * `node_modules` ancestor even though the leaf name itself is unremarkable.
   */
  function pathInScope(relativePath: string, leafIsDirectory: boolean): boolean {
    const segments = relativePath.split('/')
    let prefix = ''
    for (const [index, name] of segments.entries()) {
      prefix = index === 0 ? name : `${prefix}/${name}`
      const isDirectory = index < segments.length - 1 || leafIsDirectory
      if (!segmentInScope(name, prefix, isDirectory)) return false
    }
    return true
  }

  /**
   * Record one in-scope change and arm the debounce. Also picks up a directory created after startup
   * so Linux's per-directory watch tree grows with the workspace instead of only covering what existed
   * at `start()`.
   */
  function handleChange(relativePath: string): void {
    if (!running || degraded) return
    if (relativePath === '') return
    if (!pathInScope(relativePath, false)) return
    pendingPaths.add(relativePath)
    scheduleSync()
    if (process.platform !== 'darwin' && process.platform !== 'win32' && !watchedDirs.has(relativePath)) {
      // Fire-and-forget: a directory that turns out not to exist (a file event, or something already
      // removed again) simply fails the stat and watchDirectory() is never called.
      void maybeWatchNewDirectory(relativePath)
    }
  }

  async function maybeWatchNewDirectory(relativePath: string): Promise<void> {
    let isDirectory: boolean
    try {
      isDirectory = (await stat(join(config.root, relativePath))).isDirectory()
    } catch {
      return
    }
    // `running`/`degraded` are re-checked inside watchDirectory() itself; no need to duplicate that
    // check here too.
    if (!isDirectory || watchedDirs.has(relativePath) || !pathInScope(relativePath, true)) return
    await watchDirectory(relativePath)
  }

  /** Normalize an `fs.watch` filename (native separators, possibly nested under `recursive`) to posix. */
  function toRelativePosix(filename: string): string {
    return filename.split(sep).join('/')
  }

  function startRecursive(): void {
    try {
      const handle = primitive(config.root, { recursive: true }, (_eventType, filename) => {
        if (filename === null) return
        handleChange(toRelativePosix(filename))
      }, handleWatchError)
      handles.push(handle)
    } catch (error) {
      handleWatchError(error)
      // A platform that claims to support recursive watch but rejects this call outright (not just an
      // ENOSYS at the fs.watch layer, which never reaches here) has nothing more this watcher can try.
    }
  }

  /**
   * Install one inotify watch on `relativePath` (project-relative; `''` is the root) and recurse into
   * its non-excluded subdirectories. Degrades the whole watcher, rather than silently covering only
   * part of the tree, once {@link WatchConfig.maxWatchedDirectories} is reached.
   */
  async function watchDirectory(relativePath: string): Promise<void> {
    if (!running || degraded || watchedDirs.has(relativePath)) return
    if (watchedDirs.size >= config.maxWatchedDirectories) {
      degrade({ code: 'WATCH_LIMIT_EXCEEDED' })
      return
    }
    const absolute = join(config.root, relativePath)
    let handle: WatchHandle
    try {
      handle = primitive(absolute, { recursive: false }, (_eventType, filename) => {
        if (filename === null) return
        const childPosix = toRelativePosix(filename)
        handleChange(relativePath === '' ? childPosix : `${relativePath}/${childPosix}`)
      }, handleWatchError)
    } catch (error) {
      handleWatchError(error)
      return
    }
    handles.push(handle)
    watchedDirs.add(relativePath)

    let entries: import('node:fs').Dirent[]
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      // The directory disappeared between being discovered and being listed; its own watch (or the
      // parent's) already reported enough to trigger a sync that reconciles this.
      return
    }
    for (const entry of entries) {
      // Not re-checking `running`/`degraded` here: a stop/degrade mid-loop just means the recursive
      // watchDirectory() call below no-ops immediately (same check, at the top of that call).
      if (!entry.isDirectory()) continue
      const childPath = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      if (!segmentInScope(entry.name, childPath, true)) continue
      await watchDirectory(childPath)
    }
  }

  return {
    start() {
      if (running) return
      running = true
      degraded = false
      syncFailureCount = 0
      pendingPaths.clear()
      if (process.platform === 'darwin' || process.platform === 'win32') {
        startRecursive()
        return
      }
      void (async () => {
        gitignoreRules = config.respectGitignore ? await loadGitignore(config.root) : []
        if (!running) return
        await watchDirectory('')
      })()
    },
    stop() {
      teardown()
    },
    isDegraded() {
      return degraded
    },
    getPendingFiles() {
      return [...pendingPaths]
    },
  }
}
