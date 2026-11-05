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
import type { FileExtraction } from './extract.ts'
import { loadGitignore, matchesGitignore } from './gitignore.ts'
import type { GitignoreRule } from './gitignore.ts'
import { languageFor } from './languages.ts'
import type { LanguageSpec } from './languages.ts'
import { isMinifiedName, looksMinified, measureText } from './minified.ts'
import type { ExtractedFile } from './resolve.ts'
import { extractWithRust, loadRustEngine } from './rust-engine.ts'
import type { RustExtractInput } from './rust-engine.ts'

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

/**
 * Which extractor parses a candidate file.
 *
 * `'js'` is this package's own `extractFile` for everything — the pre-engine behaviour, kept as an
 * exact escape hatch. `'rust'` prefers the native addon. `'auto'` is `'rust'` when the artifact loads
 * and `'js'` otherwise, which is what a deployment wants: the faster path when it exists, never a
 * failure when it does not. In both non-`'js'` modes a language the addon does not handle — and any
 * single file it declines — is still parsed by `extractFile`.
 */
export type EngineMode = 'auto' | 'js' | 'rust'

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
   * Which extractor parses a candidate — see {@link EngineMode}. Absent means `'auto'`. The choice
   * never changes the files that are indexed or the answer's shape: both extractors produce the same
   * {@link FileExtraction}, which `rust-parity.spec.ts` pins, so this only trades speed against
   * leaving the process's own parser out of the run.
   */
  readonly engine?: EngineMode
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

/**
 * One candidate that survived every per-file decision (size, minified shape, cache) and whose text is
 * therefore in memory, waiting for an extractor. Holding the text here is what lets the walk hand a
 * whole batch of files to the native engine in one call instead of parsing each one in turn.
 */
interface PendingFile {
  readonly path: string
  readonly language: string
  /** The `LANGUAGE_TABLE` entry the extraction rules come from. */
  readonly spec: LanguageSpec
  readonly text: string
  readonly size: number
  readonly modifiedAt: number
  readonly lineCount: number
}

/** What the walk decided to do with one candidate. */
type CandidateOutcome =
  // The only way a candidate arrives already extracted is the parse cache, which is why this variant
  // carries no "was it reused" flag: it always was, and everything else waits as `pending`.
  | { readonly outcome: 'cached'; readonly file: ExtractedFile }
  | { readonly outcome: 'minified' }
  | { readonly outcome: 'skipped' }
  | { readonly outcome: 'pending'; readonly file: PendingFile }

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
 * Read one candidate's text and apply every decision that does not need an extractor, or reuse the
 * extraction a previous run cached for it.
 *
 * No parsing happens here on purpose: a fresh file is reported as {@link PendingFile} so that
 * `walkAndExtract` can batch all of them into the native engine at once. That split is why the cache
 * checks, the size bound, and the minified decision must stay in this function — they are the per-file
 * policy the batch above them knows nothing about.
 * @param candidate - the file to read.
 * @param config - the walk's bounds.
 * @param cache - the previous run's extractions, keyed by project-relative path.
 * @param signal - aborts the read.
 * @returns the record a previous run cached for this file, `'minified'` when it was skipped as
 *   generated output, `'skipped'` when it is over {@link WalkConfig.maxFileBytes}, or the pending file
 *   an extractor still has to handle.
 */
async function prepareCandidate(
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
        return { outcome: 'cached', file: reusedFile(candidate.path, cached, stats) }
      }
    } else {
      // Content is the only thing this mode trusts, so the read it needs to verify is also the read
      // the parse below would need — a miss here costs nothing extra.
      text = await readFile(candidate.absolute, 'utf8')
      if (createHash('sha256').update(text).digest('hex') === cached.contentHash) {
        return { outcome: 'cached', file: reusedFile(candidate.path, cached, stats) }
      }
    }
  }

  text ??= await readFile(candidate.absolute, 'utf8')
  signal?.throwIfAborted()
  const shape = measureText(text)
  if (config.skipMinified && looksMinified(candidate.path, shape)) return { outcome: 'minified' }
  // Everything above is filesystem policy; everything below is extraction, and extraction is the one
  // step that can run on the native engine — so this is exactly where the candidate waits for one.
  return {
    outcome: 'pending',
    file: {
      path: candidate.path,
      language: spec.language,
      spec,
      text,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      lineCount: shape.lineCount,
    },
  }
}

/**
 * Parse one pending file with this package's own extractor.
 * @param file - the file, whose text is already in memory.
 * @param signal - aborts the parse.
 * @returns what the parser found.
 */
async function extractWithJs(file: PendingFile, signal?: AbortSignal): Promise<FileExtraction> {
  const parser = await createParser(file.spec)
  // Declared outside the `try` so the `finally` can free it: a `const` inside the `try` is not
  // in scope there, and the tree is where a parse keeps its memory.
  let tree: ReturnType<typeof parser.parse> = null
  try {
    signal?.throwIfAborted()
    tree = parser.parse(file.text)
    /* v8 ignore next 2 -- createParser() always assigns a language before returning; parse() returns
     * null only when the parser has none. */
    if (tree === null) return { definitions: [], calls: [], imports: [], heritage: [] }
    return extractFile(tree, file.spec)
  } finally {
    // The memory a parse holds lives in the tree, not the parser: a 362 KB source keeps tens of
    // megabytes of AST. Deleting only the parser leaked it for the life of the process -- measured
    // on a 477-file workspace: RSS +103 MB per index run, +1.1 GB across 11 runs before the host ran
    // out of memory. With this line the same loop is flat at 95 MB.
    tree?.delete()
    parser.delete()
  }
}

/**
 * The file record an extraction belongs to: the metadata `prepareCandidate` measured, plus a content
 * hash of the text it read.
 * @param file - the pending file this extraction came from.
 * @param extraction - what an extractor found in it.
 * @returns the file as the resolver, the parse cache, and the graph writer all expect it.
 */
function extractedFile(file: PendingFile, extraction: FileExtraction): ExtractedFile {
  return {
    path: file.path,
    language: file.language,
    size: file.size,
    modifiedAt: file.modifiedAt,
    contentHash: createHash('sha256').update(file.text).digest('hex'),
    lineCount: file.lineCount,
    extraction,
  }
}

/**
 * Extract every pending file, native engine first and `extractFile` for whatever it did not answer
 * for, returning the results in the order they were given.
 *
 * The native call is one batch per {@link RUST_BATCH_SIZE} files (see `rust-engine.ts`); a file it
 * did not answer for is parsed here instead. That fallback is per path, not per batch: one broken file
 * costs one `extractFile` call, not the whole workspace's fast path.
 * @param pending - the files waiting for an extractor, in discovery order.
 * @param config - the walk's bounds, for the engine choice and the concurrency of the JS fallback.
 * @param signal - aborts the extraction.
 * @returns one record per pending file, in the same order.
 */
async function extractPending(
  pending: readonly PendingFile[],
  config: WalkConfig,
  signal?: AbortSignal,
): Promise<ExtractedFile[]> {
  if (pending.length === 0) return []
  // `'js'` never even loads the addon: the mode exists to run exactly the pre-engine code path.
  const engine = config.engine === 'js' ? undefined : loadRustEngine()
  // Every pending file is offered to the engine, including the languages it does not handle: it drops
  // those itself (`RUST_LANGUAGES`), so the walk never keeps a second copy of that list in sync.
  const rusted = engine === undefined
    ? new Map<string, FileExtraction>()
    : await extractWithRust(pending.map(toRustInput), engine) ?? new Map<string, FileExtraction>()
  const extracted = new Array<ExtractedFile>(pending.length)
  const fallback: { readonly index: number; readonly file: PendingFile }[] = []
  for (const [index, file] of pending.entries()) {
    const extraction = rusted.get(file.path)
    // A hit is the addon's extraction; a miss is this one path falling back, for any of the reasons
    // `rust-engine.ts` documents — never a reason to distrust the batch.
    if (extraction === undefined) fallback.push({ index, file })
    else extracted[index] = extractedFile(file, extraction)
  }
  const parsed = await mapWithConcurrency(fallback, config.concurrency, async entry => ({
    index: entry.index,
    file: extractedFile(entry.file, await extractWithJs(entry.file, signal)),
  }))
  for (const result of parsed) extracted[result.index] = result.file
  return extracted
}

/**
 * One pending file as the native engine takes it: only the three fields it reads, so the walk's own
 * bookkeeping (stat data, spec, line count) never crosses the boundary.
 * @param file - the pending file.
 * @returns the addon's input shape.
 */
function toRustInput(file: PendingFile): RustExtractInput {
  return { path: file.path, language: file.language, text: file.text }
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
 *
 * Every candidate is read and decided first, then the files needing extraction go to the native
 * engine in batches with `extractFile` as the fallback — see {@link WalkConfig.engine}. The two phases
 * exist so one addon call can cover a whole workspace; neither changes what a per-file decision
 * (size, minified, cache) does.
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
  const prepared = await mapWithConcurrency(candidates, config.concurrency, candidate => prepareCandidate(candidate, config, cache, signal))
  const pending: PendingFile[] = []
  let filesSkipped = overflow
  let filesMinified = 0
  for (const result of prepared) {
    if (result.outcome === 'skipped') filesSkipped++
    else if (result.outcome === 'minified') filesMinified++
    else if (result.outcome === 'pending') pending.push(result.file)
  }
  const extracted = await extractPending(pending, config, signal)
  // One pass in discovery order: a cache hit is already a record, a pending file takes the next record
  // `extractPending` produced. Which engine extracted a file therefore never shows in the ordering.
  const files: ExtractedFile[] = []
  let filesReused = 0
  let next = 0
  for (const result of prepared) {
    if (result.outcome === 'skipped' || result.outcome === 'minified') continue
    if (result.outcome === 'pending') {
      const file = extracted[next]
      next++
      /* v8 ignore next 2 -- extractPending() returns exactly one record per pending file, in order. */
      if (file === undefined) continue
      files.push(file)
      continue
    }
    files.push(result.file)
    filesReused++
  }
  return { files, filesSkipped, filesMinified, filesReused }
}
