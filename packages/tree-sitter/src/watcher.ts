/**
 * File-watch-driven reindexing over the harness filesystem seam (`ctx.fs`): turn a workspace's
 * file-change notifications into a bounded number of `sync` calls, using ONE WATCH PER DIRECTORY.
 *
 * Two facts about the seam decide this module's shape. `watch()` reports a directory's DIRECT
 * entries only (`depth: 0`, so a nested change never arrives on an ancestor's watch), and it never
 * names the path that changed:
 *
 *  - Coverage, therefore, comes from watching every in-scope directory: O(directories) watches, never
 *    O(files). A directory created after startup is picked up by the same re-listing that a parent's
 *    event triggers, so the watch tree grows with the workspace instead of freezing at `start()`.
 *  - A notification is a directory-level invalidation with no filename, so attributing it to paths
 *    means re-listing that directory and diffing it against the previous listing, using the
 *    `version`/`size` the listing itself carries. That diff is what keeps a rebuild from being
 *    scheduled by a change this indexer excludes — notably a change to `.codegraph`, which is what
 *    stops the watcher from rebuilding forever off its own graph write.
 *
 * `sync` is still always a full rebuild: the paths a debounce window collected are passed through but
 * never consulted by the caller supplied here (see `runSync` in `./index.ts`). That keeps this file's
 * correctness surface confined to "when do we call sync", not "what does sync do with a subset of
 * files".
 *
 * A change landing between the baseline index that starts the watcher and the listing that arms its
 * root is in no snapshot and so produces no notification. That window is one directory listing wide,
 * and the next attributable change — or the next explicit index — covers whatever it missed.
 *
 * Resource discipline is explicit. Every watch's disposer is retained and invoked on `stop()` or
 * permanent degradation, and a watch whose initialization finishes after its watcher was stopped is
 * closed immediately instead of being adopted — a late init can never leak a live watch. A
 * generation counter invalidates every in-flight async step of a previous start(), so a restart
 * cannot inherit state from the session it replaced. {@link WatchConfig.maxWatchedDirectories}
 * bounds the number of open watches, and reaching it degrades the whole watcher rather than silently
 * covering only part of the tree.
 * @module dsh-plugin-codegraph-tree-sitter/watcher
 */

import { loadGitignore } from './gitignore.ts'
import type { GitignoreRule } from './gitignore.ts'
import { isExcluded } from './walk.ts'

/**
 * One resolved filesystem target — the opaque identity `ctx.fs` hands back and every other fs call
 * takes. Only `targetKey` is read here: the module never parses it, and a remote backend's key is
 * as valid as a local path.
 */
export interface WatchTarget {
  /** Opaque backend identity of the target. */
  readonly targetKey: string
}

/** One direct child of a listed directory, as `ctx.fs.listDir` reports it. */
export interface WatchDirEntry {
  /** Basename of the child inside the listed directory. */
  readonly name: string
  /** Whether the child is a regular file, a directory, or something else. */
  readonly type: 'file' | 'directory' | 'other'
  /** Resolved child target, usable for a follow-up `watch`/`listDir`. */
  readonly target: WatchTarget
  /**
   * Opaque freshness token, when the backend can report one cheaply. Opting into it is what makes a
   * same-size content change visible to the change diff below, so a backend that omits it can still
   * attribute creations, removals, and size-changing rewrites — but not a rewrite that preserved the
   * size, which is then covered by the next attributable change or by the next explicit index.
   */
  readonly version?: string
  /** Byte size of a regular file, when the backend can report one. */
  readonly size?: number
}

/**
 * The narrow slice of `ctx.fs` this module consumes.
 *
 * Deliberately structural rather than an import of the host's `FileSystem`: the tree-sitter package
 * declares no dependency on `@deepseek-ai/dsh-fs`, and `watch` only exists from host 0.2 onward,
 * while the package's supported peer range starts earlier. Naming the three calls it uses — resolve a
 * directory, list it, observe it — keeps this module compilable and loadable across that range, and
 * keeps the port small enough that a test double is a few lines.
 */
export interface WatchFileSystem {
  /**
   * Resolve a path into a stable backend target.
   * @param path - the path to resolve; absolute paths are what this module passes.
   * @param opts - optional resolution base and cancellation signal.
   * @returns the resolved target.
   */
  resolve(path: string, opts?: { readonly cwd?: string; readonly signal?: AbortSignal }): Promise<WatchTarget>
  /**
   * List one directory's direct children.
   * @param target - the resolved directory target.
   * @param signal - aborts the listing.
   * @returns one entry per direct child.
   */
  listDir(target: WatchTarget, signal?: AbortSignal): Promise<readonly WatchDirEntry[]>
  /**
   * Observe one directory's direct entries.
   * @param target - the resolved directory target.
   * @param changed - invalidation callback, called with no argument for a change and with an error
   *   when the backend loses the watch; initialization failures are reported by rejecting instead.
   * @param signal - cancels initialization only; an initialized watch is released through the
   *   returned disposer.
   * @returns the disposer that releases the watch.
   */
  watch(target: WatchTarget, changed: (error?: Error) => void, signal: AbortSignal): Promise<() => Promise<void>>
}

/** Why live watching was permanently disabled for this watcher instance. */
export type DegradeReason =
  | { readonly code: 'RESOURCE_EXHAUSTED'; readonly cause: NodeJS.ErrnoException }
  | { readonly code: 'WATCH_LIMIT_EXCEEDED' }
  | { readonly code: 'WATCH_UNAVAILABLE'; readonly cause: unknown }
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
  /** Hard cap on directories watched individually; exceeding it degrades the watcher. */
  readonly maxWatchedDirectories: number
  /**
   * Run one reindex. `paths` are the project-relative paths of the direct entries whose change the
   * per-directory watch could attribute; this version's caller always ignores them and rebuilds the
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
  /**
   * Project-relative paths of the entries whose change is queued for the next sync, collected since
   * the last debounce window fired one. A path names a direct entry of a watched directory — file or
   * directory — because that is the finest grain the seam can attribute a change to.
   */
  getPendingFiles(): readonly string[]
}

/** What the previous listing of one directory recorded about each entry, for the change diff. */
interface EntryStamp {
  readonly type: WatchDirEntry['type']
  readonly version: string | undefined
  readonly size: number | undefined
}

/**
 * Build a watcher over one workspace root. Nothing runs until {@link Watcher.start} is called.
 * @param config - scope, timing, and the sync callback to drive.
 * @param fs - the filesystem seam to resolve, enumerate, and watch through.
 * @returns the watcher; every resource it acquires is released by {@link Watcher.stop}.
 */
export function createWatcher(config: WatchConfig, fs: WatchFileSystem): Watcher {
  const excluded = new Set(config.exclude)
  let gitignoreRules: readonly GitignoreRule[] = []
  /** Project-relative paths of the directories currently watched. */
  const watchedDirs = new Set<string>()
  /** One disposer per live watch, invoked exactly once on teardown. */
  const disposers: (() => Promise<void>)[] = []
  /** The last listing of each watched directory, keyed by project-relative path. */
  const snapshots = new Map<string, Map<string, EntryStamp>>()
  const pendingPaths = new Set<string>()
  /** Directories whose change-triggered re-listing is currently in flight. */
  const refreshing = new Set<string>()
  /** Directories that reported another change while their re-listing was in flight. */
  const dirtyDirs = new Set<string>()

  let running = false
  let degraded = false
  /** Bumped by every teardown, so async work from a previous start() can recognize itself as stale. */
  let generation = 0
  let controller: AbortController | undefined
  let debounceTimer: NodeJS.Timeout | undefined
  let syncing = false
  let rerunNeeded = false
  let syncFailureCount = 0

  /**
   * Whether async work started under `gen` still belongs to a live watching session. Everything
   * that resumes after an `await` checks this before touching shared state: a stop, a degrade, or a
   * restart all invalidate the generation the work captured.
   * @param gen - the generation the caller started under.
   * @returns whether that generation is still the live, non-degraded one.
   */
  function live(gen: number): boolean {
    return running && !degraded && gen === generation
  }

  /**
   * Release one watch, swallowing both ways a backend's close can fail. A watcher is being torn down
   * whenever this runs; there is no caller to report to and nothing to recover, and an unhandled
   * rejection here would crash a process that was only shutting a watcher down.
   * @param dispose - the disposer the backend returned.
   */
  function closeQuietly(dispose: () => Promise<void>): void {
    try {
      void dispose().catch(() => {})
    } catch {
      // A backend whose close throws synchronously instead of rejecting is released all the same.
    }
  }

  /** One-way: once degraded, only a fresh `start()` clears it. */
  function degrade(reason: DegradeReason): void {
    if (degraded) return
    degraded = true
    teardown()
    config.onDegraded?.(reason)
  }

  /** Close every live watch and clear in-flight bookkeeping, without touching `degraded`. */
  function teardown(): void {
    running = false
    generation += 1
    controller?.abort()
    controller = undefined
    for (const dispose of disposers.splice(0)) closeQuietly(dispose)
    watchedDirs.clear()
    snapshots.clear()
    dirtyDirs.clear()
    // Cleared even though the re-listing that owns this marker still holds it: that work belongs to
    // a dead generation and will drop out at its next `live()` check, and leaving the marker behind
    // would make a restarted watcher treat the directory as perpetually mid-refresh.
    refreshing.clear()
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer)
      debounceTimer = undefined
    }
  }

  /**
   * Read the `code` a watch failure carries, if it carries one.
   * @param error - the rejection reason to inspect.
   * @returns the code as a string, or undefined when there is none.
   */
  function errorCode(error: unknown): string | undefined {
    return typeof error === 'object' && error !== null && 'code' in error
      ? String((error as { readonly code: unknown }).code)
      : undefined
  }

  /**
   * Whether a failure means the OS ran out of watch resources.
   * @param error - the rejection reason to inspect.
   * @returns whether its code is one of the resource-exhaustion codes.
   */
  function resourceExhausted(error: unknown): boolean {
    const code = errorCode(error)
    return code !== undefined && RESOURCE_EXHAUSTION_CODES.has(code)
  }

  /**
   * Degrade for a watch that never initialized. Unlike an error reported later by a live watch, a
   * failed initialization leaves that directory — and everything under it — uncovered, and silent
   * partial coverage is precisely what the caller cannot recover from on its own.
   * @param error - the rejection reason from `fs.watch`.
   */
  function handleInstallFailure(error: unknown): void {
    if (resourceExhausted(error)) {
      degrade({ code: 'RESOURCE_EXHAUSTED', cause: error as NodeJS.ErrnoException })
      return
    }
    degrade({ code: 'WATCH_UNAVAILABLE', cause: error })
  }

  /**
   * Degrade for an error an already-running watch reported. Only resource exhaustion and the seam's
   * own "this provider cannot watch" code prove that live watching can no longer make progress; any
   * other error is the backend's own report about one watch and leaves the rest working.
   * @param error - the error the backend passed to the change callback.
   * @param gen - the generation of the watch that reported it.
   */
  function handleWatchError(error: unknown, gen: number): void {
    if (!live(gen)) return
    if (resourceExhausted(error)) {
      degrade({ code: 'RESOURCE_EXHAUSTED', cause: error as NodeJS.ErrnoException })
    } else if (errorCode(error) === 'FS_IO_ERROR') {
      degrade({ code: 'WATCH_UNAVAILABLE', cause: error })
    }
  }

  function scheduleSync(): void {
    if (debounceTimer !== undefined) clearTimeout(debounceTimer)
    debounceTimer = setTimeout(runSync, config.debounceMs)
  }

  function runSync(): void {
    // Also called directly (not just as the timer callback) when a queued rerun fires immediately;
    // clear any timer a later change armed in the meantime so it can't fire a redundant, empty sync.
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
    // `batch` is empty when the change that armed this timer could not be attributed to any entry —
    // either the re-listing failed, or it found nothing in scope while the backend cannot report a
    // version for an in-place modification. The rebuild is still what the caller asked for; only the
    // path list is missing.
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
   * Whether a listed entry is unchanged relative to the previous listing.
   *
   * `version` is preferred when both listings have one: it is the backend's own freshness token, so a
   * content change that preserved size and mtime still shows up. A backend that omits it falls back
   * to size, which catches truncation and growth but not a same-size rewrite — that case is left to
   * the next change the backend can describe.
   * @param previous - the stamp recorded for this entry name on the previous listing, if any.
   * @param entry - the entry from the listing taken now.
   * @returns whether the entry looks identical to the one recorded before.
   */
  function sameEntry(previous: EntryStamp | undefined, entry: WatchDirEntry): boolean {
    if (previous === undefined) return false
    if (previous.type !== entry.type) return false
    if (previous.version !== undefined && entry.version !== undefined) return previous.version === entry.version
    return previous.size === entry.size
  }

  /**
   * Re-list one directory: watch any new in-scope subdirectory, and report which direct entries
   * changed since the previous listing of it.
   *
   * The first listing of a directory records a snapshot and reports no changes: everything it shows
   * was already there when the baseline index ran, so reporting it would only schedule a redundant
   * rebuild.
   * @param relativePath - the directory's project-relative path (`''` is the root).
   * @param target - the directory's resolved target.
   * @param gen - the generation this re-listing belongs to.
   * @param signal - cancels the listing and any watch it initializes.
   * @returns the project-relative paths that changed, or undefined when the listing itself failed and
   *   the change therefore cannot be attributed at all.
   */
  async function listAndWatchChildren(
    relativePath: string,
    target: WatchTarget,
    gen: number,
    signal: AbortSignal,
  ): Promise<string[] | undefined> {
    let entries: readonly WatchDirEntry[]
    try {
      entries = await fs.listDir(target, signal)
    } catch {
      // The directory vanished, or the backend refused the listing. Its own watch still reports its
      // direct entries, so the caller rebuilds rather than assuming nothing changed.
      return undefined
    }
    const previous = snapshots.get(relativePath)
    const next = new Map<string, EntryStamp>()
    const changed: string[] = []
    for (const entry of entries) {
      const childPath = relativePath === '' ? entry.name : `${relativePath}/${entry.name}`
      const isDirectory = entry.type === 'directory'
      // Same predicate, same arguments, that the walk applies to the same entry: `exclude` plus the
      // project's `.gitignore`, so what is watched and what is indexed cannot drift apart.
      if (isExcluded(entry.name, childPath, isDirectory, excluded, gitignoreRules)) continue
      next.set(entry.name, { type: entry.type, version: entry.version, size: entry.size })
      if (previous !== undefined && !sameEntry(previous.get(entry.name), entry)) changed.push(childPath)
      if (isDirectory) await watchDirectory(childPath, entry.target, gen, signal)
    }
    if (previous !== undefined) {
      for (const name of previous.keys()) {
        if (next.has(name)) continue
        changed.push(relativePath === '' ? name : `${relativePath}/${name}`)
      }
    }
    // A teardown mid-listing means this snapshot describes a session that no longer exists; keeping
    // it would let the next session diff against stale state.
    if (!live(gen)) return undefined
    snapshots.set(relativePath, next)
    return changed
  }

  /**
   * React to one directory reporting a change: re-list it, record what changed, and arm the debounce.
   *
   * The parent directory's reported change and its own listing are both async, and a burst of writes
   * produces many notifications for one directory; re-listing for each of them would read the same
   * entries repeatedly. A per-directory "in flight" marker coalesces the burst into one listing plus
   * at most one follow-up listing for whatever arrived while the first was reading.
   * @param relativePath - the directory's project-relative path (`''` is the root).
   * @param target - the directory's resolved target.
   * @param gen - the generation this re-listing belongs to.
   * @param signal - cancels the work.
   */
  async function refreshDirectory(relativePath: string, target: WatchTarget, gen: number, signal: AbortSignal): Promise<void> {
    try {
      for (;;) {
        dirtyDirs.delete(relativePath)
        const changed = await listAndWatchChildren(relativePath, target, gen, signal)
        if (!live(gen)) return
        if (changed === undefined) {
          // Nothing could be attributed, so the change itself is the only fact available: rebuild.
          scheduleSync()
        } else if (changed.length > 0) {
          for (const path of changed) pendingPaths.add(path)
          scheduleSync()
        }
        // An empty diff schedules nothing on purpose: that is how a change to an excluded entry —
        // `.codegraph`'s own writes included — stops here instead of retriggering the rebuild that
        // wrote it.
        if (!dirtyDirs.has(relativePath)) return
      }
    } finally {
      refreshing.delete(relativePath)
    }
  }

  /**
   * Handle one notification from a directory's watch.
   * @param relativePath - the watched directory's project-relative path.
   * @param target - the watched directory's resolved target.
   * @param gen - the generation of the watch that reported it.
   * @param signal - cancels the work this notification starts.
   * @param error - the backend's error report, when the notification is not a change.
   */
  function onDirectoryEvent(
    relativePath: string,
    target: WatchTarget,
    gen: number,
    signal: AbortSignal,
    error?: Error,
  ): void {
    if (error !== undefined) {
      handleWatchError(error, gen)
      return
    }
    if (!live(gen)) return
    if (refreshing.has(relativePath)) {
      dirtyDirs.add(relativePath)
      return
    }
    refreshing.add(relativePath)
    void refreshDirectory(relativePath, target, gen, signal)
  }

  /**
   * Install one watch on `relativePath` and recurse into its in-scope subdirectories.
   *
   * Degrades the whole watcher, rather than silently covering only part of the tree, once
   * {@link WatchConfig.maxWatchedDirectories} is reached.
   * @param relativePath - the directory's project-relative path (`''` is the root).
   * @param target - the directory's resolved target.
   * @param gen - the generation this watch belongs to.
   * @param signal - cancels initialization.
   */
  async function watchDirectory(relativePath: string, target: WatchTarget, gen: number, signal: AbortSignal): Promise<void> {
    if (!live(gen) || watchedDirs.has(relativePath)) return
    if (watchedDirs.size >= config.maxWatchedDirectories) {
      degrade({ code: 'WATCH_LIMIT_EXCEEDED' })
      return
    }
    // Reserved before the await below, so two notifications for the same new directory cannot
    // initialize two watches on it.
    watchedDirs.add(relativePath)
    let dispose: () => Promise<void>
    try {
      dispose = await fs.watch(target, (error?: Error) => onDirectoryEvent(relativePath, target, gen, signal, error), signal)
    } catch (error) {
      // A failure that lands after teardown is a canceled initialization, not evidence about the
      // backend — teardown already cleared the reservation, so there is nothing to undo here.
      if (!live(gen)) return
      watchedDirs.delete(relativePath)
      handleInstallFailure(error)
      return
    }
    if (!live(gen)) {
      // Initialization finished after the watcher moved on. Adopting the watch would leak it into a
      // session that never asked for it, so release it here instead.
      closeQuietly(dispose)
      return
    }
    disposers.push(dispose)
    await listAndWatchChildren(relativePath, target, gen, signal)
  }

  /**
   * Resolve the workspace root, or report that there is nothing to watch.
   * @param gen - the generation this resolution belongs to.
   * @param signal - cancels the resolution.
   * @returns the resolved root target, or undefined when it cannot be resolved (or the session ended
   *   while resolving it).
   */
  async function resolveRoot(gen: number, signal: AbortSignal): Promise<WatchTarget | undefined> {
    try {
      const target = await fs.resolve(config.root, { signal })
      return live(gen) ? target : undefined
    } catch {
      // A root that cannot be resolved is not a watch failure to report: the index that started this
      // watcher already proved the root exists, so this is a race (the workspace moved) that the next
      // successful index() call will retry.
      return undefined
    }
  }

  /**
   * Arm the whole watch tree for this session: read the exclusion list, resolve the root, then recurse.
   * @param gen - the generation this session runs under.
   * @param signal - cancels the work.
   */
  async function startWatching(gen: number, signal: AbortSignal): Promise<void> {
    gitignoreRules = config.respectGitignore ? await loadGitignore(config.root) : []
    if (!live(gen)) return
    const root = await resolveRoot(gen, signal)
    if (root === undefined) return
    await watchDirectory('', root, gen, signal)
  }

  return {
    start() {
      if (running) return
      running = true
      degraded = false
      syncFailureCount = 0
      pendingPaths.clear()
      const abort = new AbortController()
      controller = abort
      const gen = generation
      void startWatching(gen, abort.signal)
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
