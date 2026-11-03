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

import { existsSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodegraphIndexerId, INDEX_STATUS_RELATIVE_PATH } from 'dsh-plugin-codegraph-service'
import type { CodegraphIndexer, CodegraphIndexReport } from 'dsh-plugin-codegraph-service'
import { LANGUAGE_TABLE } from './languages.ts'
import { walkAndExtract } from './walk.ts'
import { writeParseCache } from './cache.ts'
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
export type { CachedFile } from './cache.ts'
export { isExcluded, walkAndExtract } from './walk.ts'
export type { WalkConfig, WalkResult } from './walk.ts'
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
export { detectWorktree, execGit } from './worktree.ts'
export type { GitExec, WorktreeInfo } from './worktree.ts'
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

/** Default number of files parsed concurrently. */
export const DEFAULT_CONCURRENCY = 4

/** Default quiet period after the last change before a watch-triggered refresh runs. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 2_000

/** Default cap on directories watched individually, one watch each, by the fs seam. */
export const DEFAULT_MAX_WATCHED_DIRECTORIES = 4_000

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
  autoIndexOnSession?: boolean
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
  watch: z.boolean().default(true),
  watchDebounceMs: z.number().default(DEFAULT_WATCH_DEBOUNCE_MS),
  maxWatchedDirectories: z.number().default(DEFAULT_MAX_WATCHED_DIRECTORIES),
  autoIndexOnSession: z.boolean().default(true),
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

  // Watching goes through the host's filesystem seam rather than `node:fs`, so it follows the same
  // execution world the rest of the harness reads: a remote or confined backend watches its own paths.
  // The `fs` service is a declared dependency (see `inject`), so it is present whenever `apply` runs.
  // It is read structurally instead of importing `@deepseek-ai/dsh-fs`: that package is not a
  // dependency here, and its `watch` method only exists from host 0.2 onward, while this package
  // supports older peers that have no such member to import.
  const fileSystem = (ctx as Context & { readonly fs: WatchFileSystem }).fs

  // Keyed by project root, private to this plugin instance: never registered on `ctx`, so there is no
  // cross-plugin relation here for an invariant to describe — just process-local bookkeeping this
  // effect's cleanup below tears down on unload.
  const watchers = new Map<string, Watcher>()

  // Roots this plugin instance has already started an automatic index for. The set is only a guard
  // against a burst of agents opened on one workspace each scheduling the same rebuild; what a
  // previous *process* indexed is recorded by the status sidecar `autoIndexOnSession` reads instead.
  const autoIndexed = new Set<string>()

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
      sync: () => runSync(projectRoot, resolved),
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
      const report = await runIndex(projectRoot, resolved, signal)
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
      yield agentEvents.on('agent/created', payload => autoIndexOnSession(ctx, autoIndexed, payload))
    }
    yield ctx.codegraph.registerIndexer(indexer)
  }, 'codegraph-tree-sitter')
}

/** Stable job kind of an automatic session-start index, used for retention and diagnostics. */
const AUTO_INDEX_JOB_KIND = 'codegraph-index'

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
 * The slice of the host's background-job registry this plugin calls, declared structurally because
 * `@deepseek-ai/dsh-jobs` is deliberately not a dependency: the service may be absent, which is what
 * the optional lookup in {@link autoIndexOnSession} tolerates.
 */
interface AutoIndexJobRegistry {
  /**
   * Register a job and return its id immediately.
   * @param spec - the job's owner, kind, label, and producer body.
   * @returns the new job's id.
   */
  start(spec: AutoIndexJobSpec): string
}

/** One automatic indexing job's registration. */
interface AutoIndexJobSpec {
  /** Session id of the agent that owns the job; its disposal cancels the work. */
  readonly owner: string
  /** Stable kind, used for retention and diagnostics (`codegraph-index`). */
  readonly kind: string
  /** Human-readable label shown in job listings and completion notices. */
  readonly label: string
  /** The producer body, invoked once while the registration is being built. */
  readonly run: (handle: AutoIndexJobHandle) => AutoIndexJobHooks
}

/** What an automatic indexing producer may write while its job runs. */
interface AutoIndexJobHandle {
  /**
   * Append one chunk of output to the job's log.
   * @param text - the text to append, verbatim.
   */
  append(text: string): void
}

/** What an automatic indexing producer hands back so the registry can stop and await it. */
interface AutoIndexJobHooks {
  /**
   * Stop the work.
   * @param reason - why the job was stopped, when the caller has a reason.
   */
  cancel(reason?: string): void
  /** Settles once the producer is done, carrying the job's terminal outcome. */
  readonly done: Promise<AutoIndexJobOutcome>
}

/** The terminal report an automatic indexing producer settles with. */
interface AutoIndexJobOutcome {
  /** Terminal status the registry records. */
  readonly status: 'completed' | 'failed'
  /** Failure detail, when the job failed. */
  readonly detail?: string
}

/**
 * Index a new session's workspace in the background, when nothing has indexed it yet.
 *
 * Runs synchronously inside `agent/created` dispatch, so it must never block or throw: it only decides
 * whether a build is warranted and hands one to the host's job registry. A synchronous build here
 * would stall agent creation for the length of a parse, which is why a composition without background
 * jobs does nothing instead.
 * @param ctx - the plugin context, consulted for the optional job registry.
 * @param autoIndexed - roots this process has already started an automatic index for.
 * @param payload - the `agent/created` dispatch payload.
 */
function autoIndexOnSession(ctx: Context, autoIndexed: Set<string>, payload: AgentCreatedPayload): void {
  try {
    const agent = payload.agent
    const root = agent?.session?.header?.cwd
    // No workspace means no root to claim: an agent created without a `cwd` has nothing to index.
    if (agent === undefined || !root) return
    // Once per root per process. A second agent opened on the same workspace must not queue a second
    // full rebuild of a graph the first one is already building.
    if (autoIndexed.has(root)) return
    // An existing status sidecar means a previous run already indexed this workspace. Checked before
    // the job lookup so a composition without background jobs never pays for a filesystem probe.
    if (existsSync(join(root, INDEX_STATUS_RELATIVE_PATH))) return
    // `ctx.get` rather than an `inject` entry: `jobs` is a host composition choice, and requiring it in
    // `inject` would hide this whole indexer from a profile that runs no background jobs.
    const jobs = ctx.get('jobs') as AutoIndexJobRegistry | undefined
    if (jobs === undefined) return
    jobs.start({
      // The registry keys a job by its owning session id, not the agent object.
      owner: agent.id,
      kind: AUTO_INDEX_JOB_KIND,
      label: `codegraph auto index ${root}`,
      run: handle => runAutoIndexJob(ctx, root, handle),
    })
    // Marked only after the registry accepted the job, so a transient refusal leaves the workspace
    // eligible for the next session that opens in it.
    autoIndexed.add(root)
  } catch (error) {
    // The host treats a throwing listener as vetoing publication. Losing an index is a degradation,
    // never a reason to stop a session from starting.
    console.error(`codegraph-tree-sitter: automatic indexing for a new session failed: ${String(error)}`)
  }
}

/**
 * The producer body of one automatic indexing job.
 *
 * Both halves of the host's job contract are mandatory: `cancel` aborts the run, and `done` settles
 * even on failure — a rejected `done` breaks the registry's bookkeeping and leaves the job looking
 * stuck forever.
 * @param ctx - the plugin context.
 * @param root - the workspace to index.
 * @param handle - the job's producer face, for the job's live log.
 * @returns the job's cancellation hook and settlement promise.
 */
function runAutoIndexJob(ctx: Context, root: string, handle: AutoIndexJobHandle): AutoIndexJobHooks {
  const controller = new AbortController()
  const done = (async (): Promise<AutoIndexJobOutcome> => {
    try {
      const report = await ctx.codegraph.index(root, controller.signal)
      handle.append(
        `Indexed ${root}: ${report.filesIndexed} files, ${report.nodeCount} symbols, ` +
        `${report.edgeCount} relationships.\n`,
      )
      return { status: 'completed' }
    } catch (error) {
      const message = String(error)
      handle.append(`codegraph auto index failed for ${root}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
}

/**
 * Run one watch-triggered reindex. Always a full rebuild in this version — `runIndex` has no notion of
 * a file subset — so the watcher's own collected paths are not consulted here.
 * @param projectRoot - absolute path of the workspace to refresh.
 * @param config - the resolved plugin configuration.
 * @returns how many files the rebuild indexed, and how long it took.
 */
async function runSync(projectRoot: string, config: ResolvedConfig): Promise<{ filesChanged: number; durationMs: number }> {
  const startedAt = Date.now()
  const report = await runIndex(projectRoot, config)
  return { filesChanged: report.filesIndexed, durationMs: Date.now() - startedAt }
}

/**
 * One indexing run: walk, parse, resolve, and write.
 * @param projectRoot - absolute path of the workspace to index.
 * @param config - the resolved plugin configuration.
 * @param signal - aborts the run.
 * @returns the run's report.
 */
async function runIndex(projectRoot: string, config: ResolvedConfig, signal?: AbortSignal): Promise<CodegraphIndexReport> {
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
  }, signal)
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
  await writeParseCache(projectRoot, files)

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
