/**
 * Workspace directory walk: find every file this package can extract from, parse it, and hand back
 * one {@link ExtractedFile} per file that was actually indexed.
 *
 * The walk is deliberately simple: `exclude` entries name directory segments to never descend into
 * (not wildcard globs — the default set needs none), and every bound (`maxFileBytes`, `maxFiles`) is
 * a config field the deployment can retune rather than a constant, per the same-name entries this
 * package's `Config` exposes.
 * @module dsh-plugin-codegraph-tree-sitter/walk
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { readParseCache } from './cache.ts'
import type { CachedFile, ParseCacheFileSystem } from './cache.ts'
import { createParser } from './grammar.ts'
import { extractFile } from './extract.ts'
import { loadGitignore, matchesGitignore } from './gitignore.ts'
import type { GitignoreRule } from './gitignore.ts'
import { languageFor } from './languages.ts'
import { isMinifiedName, looksMinified, measureText } from './minified.ts'
import type { ExtractedFile } from './resolve.ts'

/**
 * Whether one directory entry is excluded from both the index and (for `watcher.ts`) the watch tree —
 * the single definition both consult, so "what the index covers" and "what gets watched" can never
 * drift apart.
 * @param name - the entry's own name (not a path), matched against `excluded` verbatim.
 * @param relativePath - the entry's project-relative path, matched against the `.gitignore` rules.
 * @param isDirectory - whether the entry is a directory, for `.gitignore`'s directory-only rules.
 * @param excluded - directory/file segment names never descended into.
 * @param gitignoreRules - the project's parsed `.gitignore`, or empty when not respected.
 */
export function isExcluded(
  name: string,
  relativePath: string,
  isDirectory: boolean,
  excluded: ReadonlySet<string>,
  gitignoreRules: readonly GitignoreRule[],
): boolean {
  return excluded.has(name) || matchesGitignore(gitignoreRules, relativePath, isDirectory)
}

/** The walk's tunable bounds, mirroring this package's `Config`. */
export interface WalkConfig {
  /** Directory segment names never descended into. */
  readonly exclude: readonly string[]
  /** Files larger than this are skipped and counted, never parsed. */
  readonly maxFileBytes: number
  /** The walk stops discovering new files once this many have been found. */
  readonly maxFiles: number
  /** Files parsed concurrently. */
  readonly concurrency: number
  /** Restrict extraction to these seam language labels when set; every loaded grammar otherwise. */
  readonly languages?: readonly string[]
  /**
   * Leave generated (bundled or minified) artifacts out of the index instead of parsing them. See
   * `./minified.ts` for the two signals; a workspace that commits its build output is the case this
   * exists for, since such output is neither gitignored nor declared in `exclude`.
   */
  readonly skipMinified: boolean
  /**
   * Also exclude whatever the project root's `.gitignore` names, unioned with `exclude`. A project
   * that compiles to a gitignored directory (`lib`, `dist`, ...) would otherwise hand the same symbol
   * to the resolver twice — once from source, once from the build output — and "the one unique
   * workspace-wide name wins" call resolution would pick between them arbitrarily.
   */
  readonly respectGitignore: boolean
  /**
   * Reuse the extraction a previous run cached for every file whose content is unchanged, instead of
   * reading and parsing it again. The cache lives under `<projectRoot>/.codegraph/cache`, is read
   * through the host's filesystem seam (the `fs` argument to {@link walkAndExtract}), and is written
   * by the indexer after a run succeeds; a missing or unusable cache simply means every file is
   * parsed.
   */
  readonly reuseParsedCache: boolean
  /**
   * How a cached file is confirmed unchanged before its extraction is reused. `'stat'` compares the
   * modification time and size the cache recorded — no read at all, and enough for a watcher rebuild,
   * whose changes always move mtime. `'hash'` reads the file and compares a SHA-256, which also
   * catches a rewrite that preserved both mtime and size (a checkout restoring an old file) at the
   * cost of the read it would otherwise save.
   */
  readonly cacheVerify: 'stat' | 'hash'
}

/** What the walk produced. */
export interface WalkResult {
  readonly files: ExtractedFile[]
  /** Candidates skipped for a reason other than being generated output: over `maxFileBytes`, or cut
   * off by `maxFiles`. */
  readonly filesSkipped: number
  /** Candidates skipped because they are generated output — see {@link WalkConfig.skipMinified}. */
  readonly filesMinified: number
  /**
   * Files whose extraction came from the parse cache instead of a fresh parse. These are still
   * present in {@link files} and still indexed — the count says how much work the cache saved, not
   * how much of the workspace was left out.
   */
  readonly filesReused: number
}

/** One candidate file the directory scan found, not yet parsed. */
interface Candidate {
  readonly path: string
  readonly absolute: string
  readonly language: string
}

/**
 * Recursively list every candidate file under `projectRoot`, honoring `exclude` and `maxFiles`.
 * @param projectRoot - absolute path of the root to scan.
 * @param config - the walk's bounds.
 * @param signal - aborts the scan.
 * @returns the candidates found, and how many further candidates `maxFiles` cut off.
 */
async function discover(
  projectRoot: string,
  config: WalkConfig,
  signal?: AbortSignal,
): Promise<{ candidates: Candidate[]; overflow: number }> {
  const excluded = new Set(config.exclude)
  const gitignoreRules = config.respectGitignore ? await loadGitignore(projectRoot) : []
  const candidates: Candidate[] = []
  let overflow = 0

  async function scan(relativeDir: string): Promise<void> {
    signal?.throwIfAborted()
    const entries = await readdir(posix.join(projectRoot, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (isExcluded(entry.name, relativePath, entry.isDirectory(), excluded, gitignoreRules)) continue
      if (entry.isDirectory()) {
        await scan(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = posix.extname(entry.name)
      const spec = languageFor(extension)
      if (spec === undefined) continue
      if (config.languages !== undefined && !config.languages.includes(spec.language)) continue
      if (candidates.length >= config.maxFiles) {
        overflow++
        continue
      }
      candidates.push({ path: relativePath, absolute: posix.join(projectRoot, relativePath), language: spec.language })
    }
  }

  await scan('')
  return { candidates, overflow }
}

/** What the walk decided to do with one candidate. */
type CandidateOutcome =
  | { readonly outcome: 'extracted'; readonly file: ExtractedFile; readonly reused: boolean }
  | { readonly outcome: 'minified' }
  | { readonly outcome: 'skipped' }

/**
 * The walk's view of a file whose extraction came from the cache: the same record a fresh parse
 * would have produced, with the extraction the cache matched.
 *
 * The modification time and size come from the stat taken just now, not from the cache entry, because
 * the graph records them and `status` measures staleness as `file mtime > recorded mtime`. Under
 * stat verification the two are equal by construction; under hash verification a file whose content
 * matched but whose mtime was touched would otherwise be recorded with the old mtime and reported
 * stale on every later status call, even though the graph describes its exact content.
 * @param path - the candidate's project-relative path, which the cache entry does not store itself.
 * @param cached - the entry this file's content matched.
 * @param stats - the file's stat from this run.
 * @returns the file as the resolver and graph writer expect it.
 */
function reusedFile(path: string, cached: CachedFile, stats: { readonly mtimeMs: number; readonly size: number }): ExtractedFile {
  return {
    path,
    language: cached.language,
    size: stats.size,
    modifiedAt: stats.mtimeMs,
    contentHash: cached.contentHash,
    lineCount: cached.lineCount,
    extraction: cached.extraction,
  }
}

/**
 * Parse one candidate, or reuse the extraction a previous run cached for it.
 * @param candidate - the file to parse.
 * @param config - the walk's bounds.
 * @param cache - the previous run's extractions, keyed by project-relative path.
 * @param signal - aborts the parse.
 * @returns the extracted file (and whether it came from the cache), `'minified'` when it was skipped
 *   as generated output, or `'skipped'` when it is over {@link WalkConfig.maxFileBytes}.
 */
async function parseCandidate(
  candidate: Candidate,
  config: WalkConfig,
  cache: ReadonlyMap<string, CachedFile>,
  signal?: AbortSignal,
): Promise<CandidateOutcome> {
  // Checked before the stat and read: a `.min.` name settles it with no I/O at all.
  if (config.skipMinified && isMinifiedName(candidate.path)) return { outcome: 'minified' }
  const stats = await stat(candidate.absolute)
  if (stats.size > config.maxFileBytes) return { outcome: 'skipped' }
  const spec = languageFor(posix.extname(candidate.path))
  /* v8 ignore next 2 -- discover() only ever produces a candidate whose extension resolved to a spec. */
  if (spec === undefined) return { outcome: 'skipped' }

  // Verified before the parser is even created: this is the whole point of the cache — an unchanged
  // file costs one stat when stat verification is configured, and nothing beyond that.
  const cached = cache.get(candidate.path)
  let text: string | undefined
  if (cached !== undefined) {
    if (config.cacheVerify === 'stat') {
      if (cached.modifiedAt === stats.mtimeMs && cached.size === stats.size) {
        return { outcome: 'extracted', file: reusedFile(candidate.path, cached, stats), reused: true }
      }
    } else {
      // Content is the only thing this mode trusts, so the read it needs to verify is also the read
      // the parse below would need — a miss here costs nothing extra.
      text = await readFile(candidate.absolute, 'utf8')
      if (createHash('sha256').update(text).digest('hex') === cached.contentHash) {
        return { outcome: 'extracted', file: reusedFile(candidate.path, cached, stats), reused: true }
      }
    }
  }

  text ??= await readFile(candidate.absolute, 'utf8')
  const shape = measureText(text)
  if (config.skipMinified && looksMinified(candidate.path, shape)) return { outcome: 'minified' }
  const parser = await createParser(spec)
  try {
    signal?.throwIfAborted()
    const tree = parser.parse(text)
    /* v8 ignore next 2 -- createParser() always assigns a language before returning; parse() returns
     * null only when the parser has none. */
    if (tree === null) return { outcome: 'skipped' }
    const extraction = extractFile(tree, spec)
    return {
      outcome: 'extracted',
      reused: false,
      file: {
        path: candidate.path,
        language: spec.language,
        size: stats.size,
        modifiedAt: stats.mtimeMs,
        contentHash: createHash('sha256').update(text).digest('hex'),
        lineCount: shape.lineCount,
        extraction,
      },
    }
  } finally {
    parser.delete()
  }
}

/** Run `tasks` with at most `concurrency` in flight at once, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      // `index < items.length` above guarantees a defined element; `noUncheckedIndexedAccess` just
      // cannot express that.
      const item = items[index]
      /* v8 ignore next */
      if (item === undefined) continue
      results[index] = await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/**
 * Walk `projectRoot` and parse every candidate file it finds — or reuse the extraction a previous
 * run cached for it.
 *
 * `fs` is a parameter rather than a `WalkConfig` field on purpose: the walk's own directory scan and
 * file reads still go straight to `node:fs` — they compare the mtime and size it stats itself, which
 * is the identity every cache entry is recorded under — and the only seam-mediated work here is the
 * parse cache's read. A capability is not a bound, so it does not belong in the config that mirrors
 * this package's `Config`.
 * @param projectRoot - absolute path of the workspace to index.
 * @param config - the walk's bounds.
 * @param fs - the filesystem seam the parse cache is read through.
 * @param signal - aborts the walk.
 * @returns the parsed files, how many candidates were skipped (over size, or past `maxFiles`), and
 *   how many files reused a cached extraction.
 */
export async function walkAndExtract(
  projectRoot: string,
  config: WalkConfig,
  fs: ParseCacheFileSystem,
  signal?: AbortSignal,
): Promise<WalkResult> {
  const { candidates, overflow } = await discover(projectRoot, config, signal)
  const cache = config.reuseParsedCache ? await readParseCache(fs, projectRoot) : new Map<string, CachedFile>()
  const parsed = await mapWithConcurrency(candidates, config.concurrency, candidate => parseCandidate(candidate, config, cache, signal))
  const files: ExtractedFile[] = []
  let filesSkipped = overflow
  let filesMinified = 0
  let filesReused = 0
  for (const result of parsed) {
    if (result.outcome === 'skipped') filesSkipped++
    else if (result.outcome === 'minified') filesMinified++
    else {
      files.push(result.file)
      if (result.reused) filesReused++
    }
  }
  return { files, filesSkipped, filesMinified, filesReused }
}
