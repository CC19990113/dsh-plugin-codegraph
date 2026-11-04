/**
 * Self-built code-graph indexer for `ctx.codegraph`. Parses a workspace with `web-tree-sitter` and
 * `tree-sitter-wasms` and writes schema version 4 to `<projectRoot>/.codegraph/codegraph.db` — the
 * same path and format `dsh-plugin-codegraph-sqlite` reads and the external `codegraph` CLI
 * writes, so a workspace this package indexes becomes queryable through the existing store with no
 * second graph format to disagree with the first.
 *
 * Registers **only an indexer**, never a store: `ctx.codegraph.index()` runs this package, and
 * `ctx.codegraph.query()` is answered by whichever store claims the root afterward. Indexing never
 * runs implicitly from a query — it is a caller-initiated, potentially multi-minute operation, kept
 * out of the seam's read-only query path on purpose.
 *
 * Watching a root runs through `ctx.fs` (see `./watcher.ts`): the package observes each in-scope
 * directory through the host's filesystem seam rather than opening paths itself, so a workspace a
 * backend serves from another execution world is watched where it actually lives, and a backend that
 * cannot watch at all degrades to explicit indexing instead of failing the plugin.
 *
 * A workspace with no index yet is also indexed automatically the first time a session is created in
 * it (`agent/created`), through the host's background-job registry when the composition has one. The
 * graph is most useful on the first `codegraph` query, and a session that starts in an unindexed
 * workspace is exactly the moment a caller would otherwise have to ask for a build by hand. This
 * never runs synchronously inside the event dispatch: creating an agent must not wait on a
 * multi-minute parse, and an index is an optimization, never a precondition for starting work.
 *
 * Namespace plugin (named exports, no default export). Grammars load lazily, one per language, on
 * first sight of a matching file, and stay cached for the process — never eagerly for every grammar
 * this package ships with.
 * @module dsh-plugin-codegraph-tree-sitter
 */

import { existsSync, readFileSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { stat } from 'node:fs/promises'
import { join, posix } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodegraphIndexerId, INDEX_STATUS_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { CodegraphIndexer, CodegraphIndexReport } from 'dsh-plugin-codegraph-service'
import { LANGUAGE_TABLE, languageFor } from './languages.ts'
import { isExcluded, walkAndExtract } from './walk.ts'
import type { EngineMode } from './walk.ts'
import { writeParseCache } from './cache.ts'
import type { ParseCacheFileSystem } from './cache.ts'
import { resolveWorkspace } from './resolve.ts'
import { writeGraph } from './schema.ts'
import { createWatcher } from './watcher.ts'
import type { WatchFileSystem, Watcher } from './watcher.ts'
import { decideWatch, readProcVersion } from './watch-policy.ts'

export { LANGUAGE_TABLE, languageFor } from './languages.ts'
export type { DefinitionRule, ImportRule, LanguageSpec } from './languages.ts'
export { extractFile } from './extract.ts'
export type { FileExtraction, RawCall, RawDefinition, RawImport } from './extract.ts'
export { loadGitignore, matchesGitignore, parseGitignore } from './gitignore.ts'
export type { GitignoreRule } from './gitignore.ts'
export { resolveWorkspace } from './resolve.ts'
export type { ExtractedFile, GraphEdge, GraphNode, ResolvedGraph, UnresolvedRef } from './resolve.ts'
export { isMinifiedName, looksMinified, measureText, MINIFIED_AVERAGE_LINE_LENGTH } from './minified.ts'
export type { TextShape } from './minified.ts'
export { SCHEMA_VERSION, writeGraph } from './schema.ts'
export { EXTRACTION_CACHE_RELATIVE_PATH, EXTRACTION_CACHE_VERSION, readParseCache, writeParseCache } from './cache.ts'
export type { CachedFile, CacheTarget, CacheTargetInfo, ParseCacheFileSystem } from './cache.ts'
export { isExcluded, walkAndExtract } from './walk.ts'
export type { EngineMode, WalkConfig, WalkResult } from './walk.ts'
// The native engine is part of this package's story even though it is optional at runtime: a
// deployment that wants to know *why* the faster path is not running can call `loadRustEngine()`
// itself and read the answer, instead of inferring it from timings.
export { extractWithRust, loadRustEngine, RUST_BATCH_SIZE, RUST_LANGUAGES } from './rust-engine.ts'
export type { LoadRustEngineOptions, RustEngine, RustExtractInput } from './rust-engine.ts'
export { createWatcher } from './watcher.ts'
export type {
  DegradeReason,
  WatchConfig,
  WatchDirEntry,
  WatchFileSystem,
  WatchTarget,
  Watcher,
} from './watcher.ts'
export { decideWatch, readProcVersion } from './watch-policy.ts'
export type { WatchDecision, WatchPolicyInput } from './watch-policy.ts'
// Git diagnostics stay library functions rather than plugin wiring: nothing in `apply` runs git, so
// `inject` deliberately omits `subprocess` — requiring it would hide this whole indexer from a
// composition that provides none. A caller that wants worktree diagnostics passes `ctx.subprocess`
// to `execGit` itself; installing the git hooks touches no subprocess at all.
export { detectWorktree, execGit } from './worktree.ts'
export type {
  GitExec,
  GitSpawnHandle,
  GitSpawnOutcome,
  GitSpawnPort,
  GitSpawnReader,
  GitSpawnSpec,
  WorktreeInfo,
} from './worktree.ts'
export { HOOK_MARKER_BEGIN, HOOK_MARKER_END, installGitHooks, uninstallGitHooks } from './git-hooks.ts'
export type { GitHooksOptions } from './git-hooks.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'codegraph-tree-sitter'

/** Services required by this plugin. */
export const inject = ['codegraph', 'fs']

/** Path of the on-disk graph this package writes, relative to a project root. */
export const DATABASE_RELATIVE_PATH = '.codegraph/codegraph.db'

/** Default branded identity this indexer reserves on the seam. */
export const DEFAULT_INDEXER_ID = 'codegraph-tree-sitter'

/**
 * Directory segments never descended into by default. Includes this package's own `.codegraph`
 * output — without it, a watcher would treat its own `writeGraph()` as an in-scope change and
 * rebuild forever.
 */
export const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'build', 'coverage', '.git', '.codegraph']

/** Default ceiling on a single file's size before it is skipped. */
export const DEFAULT_MAX_FILE_BYTES = 2_000_000

/** Default ceiling on how many files one run indexes. */
export const DEFAULT_MAX_FILES = 50_000

/**
 * How many candidate source files a workspace may contain before a **session-start** index declines
 * to run (default 8,000).
 *
 * `maxFiles` above is the bound for a run someone asked for; this one guards the run nobody asked
 * for. A session opened with `cwd` pointing at a home directory or a tool's own data directory can
 * cover tens of thousands of files — a real case reached 21,752 under `~/.dsh`, under the 50,000
 * ceiling, and the Tree-sitter WASM heap died mid-parse while the desktop froze. Declining early
 * costs one `readdir` pass; declining late costs the whole machine.
 */
export const DEFAULT_AUTO_INDEX_MAX_FILES = 8_000

/** Default number of files parsed concurrently. */
export const DEFAULT_CONCURRENCY = 4

/** Default quiet period after the last change before a watch-triggered refresh runs. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 2_000

/** Default cap on directories watched individually, one watch each, by the fs seam. */
export const DEFAULT_MAX_WATCHED_DIRECTORIES = 4_000

/** Default age past which a session-open refreshes an existing index (ten minutes). */
export const DEFAULT_AUTO_REFRESH_AFTER_MS = 10 * 60 * 1000

/** Plugin configuration: the indexer's identity and every deployment-varying bound on a run. */
export interface Config {
  /**
   * Branded identity to reserve on `ctx.codegraph`. Give each instance its own id when mounting more
   * than one, so a duplicate registration fails at load instead of shadowing the first indexer.
   */
  indexerId?: string
  /** Restrict indexing to these seam language labels when set (default: every grammar this package ships). */
  languages?: string[]
  /** Directory segment names never descended into (default: node_modules, dist, build, coverage, .git). */
  exclude?: string[]
  /**
   * Also exclude whatever the project root's `.gitignore` names, unioned with `exclude` (default
   * true). Build tooling routinely writes compiled output to a gitignored directory outside the
   * default exclude list (`lib`, `out`, ...); indexing that output alongside its own source hands the
   * resolver two same-named declarations of one symbol and makes "the one unique workspace-wide name
   * wins" pick between them arbitrarily. Only a practical subset of gitignore syntax is understood —
   * see `./gitignore.ts`. A project with no root `.gitignore` is unaffected either way.
   */
  respectGitignore?: boolean
  /**
   * Leave generated (bundled or minified) artifacts out of the index instead of parsing them
   * (default true). A workspace that commits its build output — `dist/` in version control so a
   * server can serve it — hands the walk megabytes of bundler output declaring thousands of short
   * mangled names; indexing it both dominates the run's time and collides with real source symbols,
   * making "one unique workspace-wide name wins" refuse calls the duplicates made ambiguous.
   *
   * Two signals, one structural: a `.min.` path segment, or an average line length past
   * {@link MINIFIED_AVERAGE_LINE_LENGTH}. Set false to index such files anyway, or name their
   * directory in `exclude`.
   */
  skipMinified?: boolean
  /** Files larger than this are skipped and counted in the report, never parsed (default 2000000). */
  maxFileBytes?: number
  /** The walk stops discovering new files once this many have been found (default 50000). */
  maxFiles?: number
  /** Files parsed concurrently (default 4). */
  concurrency?: number
  /**
   * Reuse the extraction a previous run cached for every file whose content is unchanged (default
   * true), so a repeat index — or a watch rebuild after one edit — parses only what actually changed
   * instead of the whole workspace. The cache lives at
   * {@link EXTRACTION_CACHE_RELATIVE_PATH} and is rewritten after each successful run. Set false to
   * parse every file every time, at the cost of the full parse each run.
   */
  reuseParsedCache?: boolean
  /**
   * How a cached file's unchanged content is confirmed before its extraction is reused (default
   * `'stat'`): `stat` compares the modification time and size the cache recorded and reads nothing;
   * `hash` re-reads the file and compares a SHA-256, which also catches a rewrite that preserved both
   * mtime and size (a checkout restoring an older file over a newer one). Hash mode still skips the
   * parse and the tree walk, which dominate the per-file cost.
   */
  cacheVerify?: 'stat' | 'hash'
  /**
   * Which extractor parses a file (default `'auto'`): this package's own `extractFile` (`'js'`), the
   * native Rust addon from `crates/indexer-rust` (`'rust'`), or whichever is available (`'auto'`).
   *
   * `'rust'` and `'auto'` hand every TypeScript/JavaScript/JSX/TSX file to the addon in batches and
   * fall back to `extractFile` for anything it does not answer for — a language it does not handle, a
   * file it declines, or a deployment with no built artifact at all. Both paths produce the same
   * extraction, pinned by `rust-parity.spec.ts`, so this setting only trades speed against how the
   * work is scheduled. `'js'` is exactly the behaviour this package had before the addon existed.
   */
  engine?: EngineMode
  /**
   * Watch the workspace for file changes and refresh the index automatically after a successful
   * `index()` call establishes a baseline (default true). Set `watch: false` to keep indexing purely
   * explicit instead.
   *
   * Overridden off by default on a WSL2 kernel watching a path mounted in from the Windows host
   * (`/mnt/<drive>/...`), since inotify does not reliably deliver events over that 9P mount — see
   * `watch-policy.ts`. Set `CODEGRAPH_FORCE_WATCH=1` to watch there anyway, or `CODEGRAPH_NO_WATCH=1`
   * to force watching off everywhere regardless of this option.
   */
  watch?: boolean
  /** Quiet period after the last change before a watch-triggered refresh runs, in ms (default 2000). */
  watchDebounceMs?: number
  /**
   * Hard cap on directories watched individually (default 4000). Watching goes through the host's
   * filesystem seam, whose `watch` covers one directory's direct entries, so a workspace costs one
   * watch per in-scope directory; exceeding this cap degrades that root's watcher rather than
   * covering only part of the tree.
   */
  maxWatchedDirectories?: number
  /**
   * Build a first index automatically, in the background, when a session is created in a workspace
   * that has none (default true). A workspace is only ever auto-indexed once per process and never
   * when its status sidecar already exists, so this cannot rebuild a graph that is already there.
   * Set false to keep every build explicitly requested.
   *
   * Requires the host's `jobs` service: the build is never run synchronously inside session creation,
   * so a composition without background jobs simply schedules nothing.
   */
  /** Cap on candidate source files a session-start scan may find before it declines to index. */
  autoIndexMaxFiles?: number
  autoIndexOnSession?: boolean
  /**
   * How stale an existing index may be before a new session refreshes it in the background (default
   * 600000, ten minutes). An index older than this is rebuilt on session start using the parse cache,
   * which is milliseconds — and rebuilding is also what restarts the file watcher, since watching
   * only ever begins after a successful index.
   */
  autoRefreshAfterMs?: number
}

export const Config: z<Config> = z.object({
  indexerId: z.string().default(DEFAULT_INDEXER_ID),
  languages: z.array(z.string()).default([...new Set(LANGUAGE_TABLE.map(spec => spec.language))]),
  exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
  respectGitignore: z.boolean().default(true),
  skipMinified: z.boolean().default(true),
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  maxFiles: z.number().default(DEFAULT_MAX_FILES),
  concurrency: z.number().default(DEFAULT_CONCURRENCY),
  reuseParsedCache: z.boolean().default(true),
  cacheVerify: z.union([z.const('stat'), z.const('hash')]).default('stat'),
  engine: z.union([z.const('auto'), z.const('js'), z.const('rust')]).default('auto'),
  watch: z.boolean().default(true),
  watchDebounceMs: z.number().default(DEFAULT_WATCH_DEBOUNCE_MS),
  maxWatchedDirectories: z.number().default(DEFAULT_MAX_WATCHED_DIRECTORIES),
  /** Cap on candidate source files a session-start scan may find before it declines to index. */
  autoIndexMaxFiles: z.number().default(DEFAULT_AUTO_INDEX_MAX_FILES),
  autoIndexOnSession: z.boolean().default(true),
  autoRefreshAfterMs: z.number().default(DEFAULT_AUTO_REFRESH_AFTER_MS),
})

type ResolvedConfig = Required<Config>

/**
 * Register the tree-sitter indexer.
 * @param ctx - the plugin context (must inject `codegraph` and `fs`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxFileBytes', resolved.maxFileBytes)
  assertPositiveInteger('maxFiles', resolved.maxFiles)
  assertPositiveInteger('concurrency', resolved.concurrency)
  assertPositiveInteger('watchDebounceMs', resolved.watchDebounceMs)
  assertPositiveInteger('maxWatchedDirectories', resolved.maxWatchedDirectories)

  // Watching and the parse cache both go through the host's filesystem seam rather than `node:fs`, so
  // they follow the same execution world the rest of the harness reads: a remote or confined backend
  // watches and caches on its own side, and the cache's read/write pass through the same policy the
  // graph's readers do. The `fs` service is a declared dependency (see `inject`), so it is present
  // whenever `apply` runs. Both ports are read structurally instead of importing
  // `@deepseek-ai/dsh-fs`: that package is not a dependency here, and its `watch` method only exists
  // from host 0.2 onward, while this package supports older peers that have no such member to import.
  const fileSystem = (ctx as Context & { readonly fs: WatchFileSystem & ParseCacheFileSystem }).fs

  // Keyed by project root, private to this plugin instance: never registered on `ctx`, so there is no
  // cross-plugin relation here for an invariant to describe — just process-local bookkeeping this
  // effect's cleanup below tears down on unload.
  const watchers = new Map<string, Watcher>()

  // When this instance last started an automatic index, keyed by root. This is not a "already done"
  // set: an index goes stale while the process runs, so a later session in the same workspace may
  // legitimately trigger another refresh. The map only keeps a burst of sessions opened at once from
  // queueing the same rebuild repeatedly; the freshness decision itself reads the status sidecar.
  const lastAutoRun = new Map<string, number>()

  // Roots whose background run is still executing. Kept apart from `lastAutoRun`, which is a time
  // window: a first build can outlive the window, and two builds on one root would only race the same
  // index files.
  const autoIndexInFlight = new Set<string>()

  // `agent/created` is typed by `@deepseek-ai/dsh-agent`'s module augmentation. Reading the event
  // through a local structural face keeps this package's host dependencies unchanged: it needs one
  // event name and one payload shape, not the whole agent package.
  const agentEvents = ctx as unknown as AgentLifecycleContext

  /** Start (or leave running) file watching for `projectRoot`, once it has a baseline to refresh. */
  function ensureWatching(projectRoot: string): void {
    if (watchers.has(projectRoot)) return
    const decision = decideWatch({
      configuredWatch: resolved.watch,
      root: projectRoot,
      env: process.env,
      platform: process.platform,
      procVersion: readProcVersion,
    })
    if (!decision.enabled) return
    const watcher = createWatcher({
      root: projectRoot,
      exclude: resolved.exclude,
      respectGitignore: resolved.respectGitignore,
      debounceMs: resolved.watchDebounceMs,
      maxWatchedDirectories: resolved.maxWatchedDirectories,
      sync: () => runSync(projectRoot, resolved, fileSystem),
      // No diagnostics service is wired into this package's dependencies; this is the floor for
      // "degradation must be visible" until one is, per NOTES.local.md.
      onDegraded: (reason) => {
        console.error(
          `codegraph-tree-sitter: file watching for "${projectRoot}" stopped permanently (${reason.code}); ` +
          'the index will no longer refresh on its own — run codegraph_index manually to update it.',
        )
      },
    }, fileSystem)
    watchers.set(projectRoot, watcher)
    watcher.start()
  }

  const indexer: CodegraphIndexer = {
    id: CodegraphIndexerId(resolved.indexerId),
    async canIndex(projectRoot) {
      try {
        return (await stat(projectRoot)).isDirectory()
      } catch {
        // Only the existence probe runs in the try. Any rejection — missing path, or no permission
        // to look — means this indexer cannot build a graph here, which is the answer the seam asked
        // for rather than a failure to report.
        return false
      }
    },
    async index(projectRoot, signal) {
      const report = await runIndex(projectRoot, resolved, fileSystem, signal)
      // Watching starts only after a successful index establishes the baseline it refreshes — never
      // from a canIndex() probe or a failed run.
      ensureWatching(projectRoot)
      return report
    },
  }

  ctx.effect(function* () {
    yield () => {
      for (const watcher of watchers.values()) watcher.stop()
      watchers.clear()
    }
    if (resolved.autoIndexOnSession) {
      // Registered inside this effect so the listener follows the plugin's lifetime: unloading the
      // plugin must stop new sessions from scheduling work this instance can no longer run.
      yield agentEvents.on('agent/created', payload => autoIndexOnSession(ctx, resolved, lastAutoRun, autoIndexInFlight, payload, ensureWatching))
    }
    yield ctx.codegraph.registerIndexer(indexer)
  }, 'codegraph-tree-sitter')
}

/**
 * The agent side of an `agent/created` payload, declared structurally rather than imported from
 * `@deepseek-ai/dsh-agent`: this package supports a wider host range than one `dsh-agent` release, so
 * it names only the fields it reads. `session.header.cwd` is the workspace a session was opened in —
 * the root this indexer is asked to index by hand otherwise.
 */
interface AgentCreatedPayload {
  /** The agent just registered; absent only on a malformed dispatch. */
  readonly agent?: {
    /** The agent's session id, which owns any background job it starts. */
    readonly id: string
    /** The agent's live session, whose header carries the workspace. */
    readonly session?: {
      /** Durable session metadata, always present on a real session. */
      readonly header?: {
        /** Absolute workspace path, absent when the session was created without one. */
        readonly cwd?: string
      }
    }
  }
}

/**
 * The slice of `ctx`'s event surface this plugin listens on, declared structurally for the same
 * reason as {@link AgentCreatedPayload}: importing `@deepseek-ai/dsh-agent` for its event typing would
 * add a host dependency this indexer does not otherwise need.
 */
interface AgentLifecycleContext {
  /**
   * Subscribe to one agent-created notification.
   * @param name - the event name, `agent/created`.
   * @param listener - receives the dispatch payload.
   * @returns the disposer that unsubscribes.
   */
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/**
 * Whether a directory is the harness's own home rather than a project checkout.
 *
 * `sessions/` and `profiles/` together are what makes it one: either alone is a plausible folder
 * name inside an ordinary repository, and requiring both keeps a real workspace eligible. The check
 * exists because a DSH home is by construction tens of thousands of files — indexing it can only
 * ever hit the session-start size guard, so queueing the job produces a failure and nothing else.
 * @param root - the absolute workspace path.
 * @returns true when the directory holds the harness's own state.
 */
function isHarnessHome(root: string): boolean {
  return existsSync(join(root, 'sessions')) && existsSync(join(root, 'profiles'))
}

/**
 * Index a new session's workspace in the background — when nothing has indexed it yet, or when what
 * is there has gone stale.
 *
 * Runs synchronously inside `agent/created` dispatch, so it must never block or throw: it only decides
 * whether a build is warranted and starts one in the background. A synchronous build here would stall
 * agent creation for the length of a parse.
 *
 * The run deliberately does **not** go through the host's job registry. A registered job reports its
 * settlement back to the owning agent: the host injects a completion notice into the next step and,
 * under its default `wakeup` delivery, opens a turn on an idle one. An automatic index nobody asked
 * for must not appear in the transcript or start a reply of its own, so this runs as a plain
 * background promise. The explicit `codegraph_index` tool still registers a job — there a caller is
 * waiting for the id.
 *
 * Refreshing a stale index is what restarts the file watcher after a host restart: watching only
 * begins once a successful index has established a baseline, so a workspace whose index is minutes
 * old would otherwise stay frozen at whatever the last process left behind.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration, for the staleness threshold.
 * @param lastAutoRun - when this instance last started an automatic index for each root.
 * @param autoIndexInFlight - roots whose background run is still executing, so a slow build cannot be
 * started twice by sessions that open past the freshness window.
 * @param payload - the `agent/created` dispatch payload.
 * @param ensureWatching - starts file watching for a workspace that is already current.
 */
function autoIndexOnSession(
  ctx: Context,
  config: ResolvedConfig,
  lastAutoRun: Map<string, number>,
  autoIndexInFlight: Set<string>,
  payload: AgentCreatedPayload,
  ensureWatching: (root: string) => void,
): void {
  try {
    const agent = payload.agent
    const root = agent?.session?.header?.cwd
    // No workspace means no root to claim: an agent created without a `cwd` has nothing to index.
    if (agent === undefined || !root) return
    // DSH's own home directory is not a code repository — `sessions/`, `attachments/`, the index
    // databases and the installed plugins below it are a program's state. It is also tens of
    // thousands of files, so every session opened there queued a job whose only possible outcome was
    // the size guard failing. Skipping here keeps the job list honest: what is not a candidate never
    // becomes a failure the user cannot act on.
    if (isHarnessHome(root)) return
    const now = Date.now()
    // A burst of sessions opened on one workspace must not queue the same rebuild repeatedly.
    const previous = lastAutoRun.get(root)
    if (previous !== undefined && now - previous < config.autoRefreshAfterMs) return
    // A build already running for this root is the one the window would have deduplicated had it been
    // slow enough to straddle it; starting a second would only race the same index files.
    if (autoIndexInFlight.has(root)) return
    // A fresh sidecar means a recent run is already describing this workspace; an absent, unreadable
    // or old one means the graph is missing or behind.
    const indexedAt = readStatusIndexedAt(root)
    if (indexedAt !== undefined && now - indexedAt < config.autoRefreshAfterMs) {
      // The graph is current, so no build is warranted — but watching is process-local state and
      // this is the first time this process has seen this workspace. Without this call, a restart
      // followed by a session in an up-to-date workspace would leave it unwatched until the sidecar
      // aged out, and every edit until then would silently not reach the graph.
      ensureWatching(root)
      return
    }
    lastAutoRun.set(root, now)
    autoIndexInFlight.add(root)
    // Never rejects: a lost index is a degradation, not an error the session can act on.
    void runAutomaticIndex(ctx, root, config).finally(() => autoIndexInFlight.delete(root))
  } catch (error) {
    // The host treats a throwing listener as vetoing publication. Losing an index is a degradation,
    // never a reason to stop a session from starting.
    console.error(`codegraph-tree-sitter: automatic indexing for a new session failed: ${String(error)}`)
  }
}

/**
 * Run one automatic index to completion, reporting a failure instead of propagating it.
 *
 * The size guard stays: parsing a workspace past `autoIndexMaxFiles` would exhaust the WASM heap and
 * take the desktop down with it, and an automatic index is a convenience. Skipping it is a decision,
 * not a failure, so it is logged once and the session continues untouched.
 * @param ctx - the plugin context.
 * @param root - absolute workspace path.
 * @param config - the resolved plugin configuration.
 */
async function runAutomaticIndex(ctx: Context, root: string, config: ResolvedConfig): Promise<void> {
  const controller = new AbortController()
  try {
    const oversized = await exceedsAutoIndexLimit(root, config, controller.signal)
    if (oversized !== undefined) {
      console.error(
        `codegraph-tree-sitter: skipped automatic indexing of ${root}: it holds at least ${String(oversized)} ` +
          `candidate source files, past the ${String(config.autoIndexMaxFiles)}-file session-start limit. ` +
          'Run codegraph_index yourself if you want a graph for it.',
      )
      return
    }
    // A successful index is what starts file watching, inside `indexer.index`.
    await ctx.codegraph.index(root, controller.signal)
  } catch (error) {
    console.error(`codegraph-tree-sitter: automatic index for ${root} failed: ${String(error)}`)
  }
}

/**
 * How many candidate source files `root` holds, when that is past the session-start limit.
 *
 * Deliberately a **bounded directory walk that never reads a file**: it counts what `discover` would
 * hand the parser and stops one past the limit. The alternative — starting the real run and bailing
 * when memory runs out — is what froze the machine this guard exists to prevent.
 * @param root - absolute workspace path.
 * @param config - the resolved plugin configuration (for the limit and the exclude list).
 * @param signal - aborts the walk.
 * @returns the count once it exceeds the limit, or `undefined` when the workspace is small enough.
 */
async function exceedsAutoIndexLimit(
  root: string,
  config: ResolvedConfig,
  signal: AbortSignal,
): Promise<number | undefined> {
  const excluded = new Set(config.exclude)
  const limit = config.autoIndexMaxFiles
  let count = 0

  async function scan(relativeDir: string): Promise<boolean> {
    signal.throwIfAborted()
    let entries
    try {
      entries = await readdir(posix.join(root, relativeDir), { withFileTypes: true })
    } catch {
      // An unreadable directory contributes nothing to a count that exists to protect against size.
      return false
    }
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (isExcluded(entry.name, relativePath, entry.isDirectory(), excluded, [])) continue
      if (entry.isDirectory()) {
        if (await scan(relativePath)) return true
        continue
      }
      if (!entry.isFile()) continue
      const spec = languageFor(posix.extname(entry.name))
      if (spec === undefined) continue
      count += 1
      if (count > limit) return true
    }
    return false
  }

  return (await scan('')) ? count : undefined
}

/**
 * When the workspace's sidecar says its index was built.
 * @param root - the workspace root.
 * @returns the epoch-millisecond timestamp, or `undefined` when the sidecar is absent or unreadable —
 *   either way the graph cannot be trusted to be current.
 */
function readStatusIndexedAt(root: string): number | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(root, INDEX_STATUS_RELATIVE_PATH), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return undefined
    const indexedAt = (parsed as { indexedAt?: unknown }).indexedAt
    return typeof indexedAt === 'number' && Number.isFinite(indexedAt) ? indexedAt : undefined
  } catch {
    return undefined
  }
}

/**
 * Run one watch-triggered reindex. Always a full rebuild in this version — `runIndex` has no notion of
 * a file subset — so the watcher's own collected paths are not consulted here.
 * @param projectRoot - absolute path of the workspace to refresh.
 * @param config - the resolved plugin configuration.
 * @param fs - the filesystem seam the parse cache is read and written through.
 * @returns how many files the rebuild indexed, and how long it took.
 */
async function runSync(
  projectRoot: string,
  config: ResolvedConfig,
  fs: ParseCacheFileSystem,
): Promise<{ filesChanged: number; durationMs: number }> {
  const startedAt = Date.now()
  const report = await runIndex(projectRoot, config, fs)
  return { filesChanged: report.filesIndexed, durationMs: Date.now() - startedAt }
}

/**
 * One indexing run: walk, parse, resolve, and write.
 * @param projectRoot - absolute path of the workspace to index.
 * @param config - the resolved plugin configuration.
 * @param fs - the filesystem seam the parse cache is read and written through.
 * @param signal - aborts the run.
 * @returns the run's report.
 */
async function runIndex(
  projectRoot: string,
  config: ResolvedConfig,
  fs: ParseCacheFileSystem,
  signal?: AbortSignal,
): Promise<CodegraphIndexReport> {
  const { files, filesSkipped, filesMinified, filesReused } = await walkAndExtract(projectRoot, {
    exclude: config.exclude,
    respectGitignore: config.respectGitignore,
    skipMinified: config.skipMinified,
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    concurrency: config.concurrency,
    languages: config.languages,
    reuseParsedCache: config.reuseParsedCache,
    cacheVerify: config.cacheVerify,
    engine: config.engine,
  }, fs, signal)
  signal?.throwIfAborted()

  const indexedAt = Date.now()
  const graph = resolveWorkspace(files, indexedAt)
  signal?.throwIfAborted()

  const databasePath = join(projectRoot, DATABASE_RELATIVE_PATH)
  await writeGraph(databasePath, {
    files, nodes: graph.nodes, edges: graph.edges, unresolved: graph.unresolved, filesMinified, indexedAt,
  })

  // Only after the graph is in place: the cache records the extractions this run actually committed,
  // so a run that failed before writing its graph leaves the previous cache — and the mtimes it was
  // built from — alone instead of vouching for a graph that was never written.
  await writeParseCache(fs, projectRoot, files)

  const languageCounts = new Map<string, number>()
  for (const file of files) languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1)
  const languages = [...languageCounts.entries()]
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language))

  return {
    projectRoot,
    filesIndexed: files.length,
    filesSkipped,
    filesMinified,
    filesReused,
    nodeCount: graph.nodes.length,
    edgeCount: graph.edges.length,
    unresolvedCount: graph.unresolved.length,
    unresolvedLikelyInternalCount: graph.unresolved.filter(ref => !ref.likelyExternal).length,
    languages,
  }
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`codegraph-tree-sitter: ${field} must be a positive integer`)
  }
}
