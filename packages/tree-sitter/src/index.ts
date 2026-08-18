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
 * Namespace plugin (named exports, no default export). Grammars load lazily, one per language, on
 * first sight of a matching file, and stay cached for the process — never eagerly for every grammar
 * this package ships with.
 * @module dsh-plugin-codegraph-tree-sitter
 */

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodegraphIndexerId } from 'dsh-plugin-codegraph-service'
import type { CodegraphIndexer, CodegraphIndexReport } from 'dsh-plugin-codegraph-service'
import { LANGUAGE_TABLE } from './languages.ts'
import { walkAndExtract } from './walk.ts'
import { resolveWorkspace } from './resolve.ts'
import { writeGraph } from './schema.ts'
import { createWatcher } from './watcher.ts'
import type { Watcher } from './watcher.ts'
import { decideWatch, readProcVersion } from './watch-policy.ts'

export { LANGUAGE_TABLE, languageFor } from './languages.ts'
export type { DefinitionRule, ImportRule, LanguageSpec } from './languages.ts'
export { extractFile } from './extract.ts'
export type { FileExtraction, RawCall, RawDefinition, RawImport } from './extract.ts'
export { loadGitignore, matchesGitignore, parseGitignore } from './gitignore.ts'
export type { GitignoreRule } from './gitignore.ts'
export { resolveWorkspace } from './resolve.ts'
export type { ExtractedFile, GraphEdge, GraphNode, ResolvedGraph, UnresolvedRef } from './resolve.ts'
export { SCHEMA_VERSION, writeGraph } from './schema.ts'
export { isExcluded, walkAndExtract } from './walk.ts'
export type { WalkConfig, WalkResult } from './walk.ts'
export { createWatcher, nodeWatch } from './watcher.ts'
export type { DegradeReason, WatchConfig, WatchHandle, WatchPrimitive, Watcher } from './watcher.ts'
export { decideWatch, readProcVersion } from './watch-policy.ts'
export type { WatchDecision, WatchPolicyInput } from './watch-policy.ts'
export { detectWorktree, execGit } from './worktree.ts'
export type { GitExec, WorktreeInfo } from './worktree.ts'
export { HOOK_MARKER_BEGIN, HOOK_MARKER_END, installGitHooks, uninstallGitHooks } from './git-hooks.ts'
export type { GitHooksOptions } from './git-hooks.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'codegraph-tree-sitter'

/** Services required by this plugin. */
export const inject = ['codegraph']

/** Path of the on-disk graph this package writes, relative to a project root. */
export const DATABASE_RELATIVE_PATH = '.codegraph/codegraph.db'

/** Default branded identity this indexer reserves on the seam. */
export const DEFAULT_INDEXER_ID = 'codegraph-tree-sitter'

/** Directory segments never descended into by default. */
export const DEFAULT_EXCLUDE = ['node_modules', 'dist', 'build', 'coverage', '.git']

/** Default ceiling on a single file's size before it is skipped. */
export const DEFAULT_MAX_FILE_BYTES = 2_000_000

/** Default ceiling on how many files one run indexes. */
export const DEFAULT_MAX_FILES = 50_000

/** Default number of files parsed concurrently. */
export const DEFAULT_CONCURRENCY = 4

/** Default quiet period after the last change before a watch-triggered refresh runs. */
export const DEFAULT_WATCH_DEBOUNCE_MS = 2_000

/** Default cap on directories watched individually, on platforms without a recursive `fs.watch`. */
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
  /** Files larger than this are skipped and counted in the report, never parsed (default 2000000). */
  maxFileBytes?: number
  /** The walk stops discovering new files once this many have been found (default 50000). */
  maxFiles?: number
  /** Files parsed concurrently (default 4). */
  concurrency?: number
  /**
   * Watch the workspace for file changes and refresh the index automatically after a successful
   * `index()` call establishes a baseline (default false). A caller that never sets this sees no
   * change from before this option existed — indexing stays purely explicit.
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
   * Hard cap on directories watched individually (default 4000). Only relevant on platforms without a
   * recursive `fs.watch` (Linux); exceeding it degrades that root's watcher rather than covering only
   * part of the tree.
   */
  maxWatchedDirectories?: number
}

export const Config: z<Config> = z.object({
  indexerId: z.string().default(DEFAULT_INDEXER_ID),
  languages: z.array(z.string()).default([...new Set(LANGUAGE_TABLE.map(spec => spec.language))]),
  exclude: z.array(z.string()).default(DEFAULT_EXCLUDE),
  respectGitignore: z.boolean().default(true),
  maxFileBytes: z.number().default(DEFAULT_MAX_FILE_BYTES),
  maxFiles: z.number().default(DEFAULT_MAX_FILES),
  concurrency: z.number().default(DEFAULT_CONCURRENCY),
  watch: z.boolean().default(false),
  watchDebounceMs: z.number().default(DEFAULT_WATCH_DEBOUNCE_MS),
  maxWatchedDirectories: z.number().default(DEFAULT_MAX_WATCHED_DIRECTORIES),
})

type ResolvedConfig = Required<Config>

/**
 * Register the tree-sitter indexer.
 * @param ctx - the plugin context (must inject `codegraph`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxFileBytes', resolved.maxFileBytes)
  assertPositiveInteger('maxFiles', resolved.maxFiles)
  assertPositiveInteger('concurrency', resolved.concurrency)
  assertPositiveInteger('watchDebounceMs', resolved.watchDebounceMs)
  assertPositiveInteger('maxWatchedDirectories', resolved.maxWatchedDirectories)

  // Keyed by project root, private to this plugin instance: never registered on `ctx`, so there is no
  // cross-plugin relation here for an invariant to describe — just process-local bookkeeping this
  // effect's cleanup below tears down on unload.
  const watchers = new Map<string, Watcher>()

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
    })
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
    yield ctx.codegraph.registerIndexer(indexer)
  }, 'codegraph-tree-sitter')
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
  const { files, filesSkipped } = await walkAndExtract(projectRoot, {
    exclude: config.exclude,
    respectGitignore: config.respectGitignore,
    maxFileBytes: config.maxFileBytes,
    maxFiles: config.maxFiles,
    concurrency: config.concurrency,
    languages: config.languages,
  }, signal)
  signal?.throwIfAborted()

  const indexedAt = Date.now()
  const graph = resolveWorkspace(files, indexedAt)
  signal?.throwIfAborted()

  const databasePath = join(projectRoot, DATABASE_RELATIVE_PATH)
  await writeGraph(databasePath, { files, nodes: graph.nodes, edges: graph.edges, unresolved: graph.unresolved, indexedAt })

  const languageCounts = new Map<string, number>()
  for (const file of files) languageCounts.set(file.language, (languageCounts.get(file.language) ?? 0) + 1)
  const languages = [...languageCounts.entries()]
    .map(([language, fileCount]) => ({ language, fileCount }))
    .sort((left, right) => right.fileCount - left.fileCount || left.language.localeCompare(right.language))

  return {
    projectRoot,
    filesIndexed: files.length,
    filesSkipped,
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
