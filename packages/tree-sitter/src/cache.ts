/**
 * Parse-result cache: the extraction this package computed for each file on the previous run, so a
 * repeat index of an unchanged workspace can skip the read, the parse, and the tree walk for every
 * file whose content did not change.
 *
 * The cache is an accelerator with no authority. It is read only as a hint — anything missing,
 * unreadable, corrupt, written by another version, or shaped unexpectedly is discarded and the file
 * is parsed again, so losing it costs time and never correctness. That is what lets
 * {@link readParseCache} swallow every failure and {@link writeParseCache} tolerate a workspace this
 * process may not write to.
 * @module dsh-plugin-codegraph-tree-sitter/cache
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { FileExtraction } from './extract.ts'
import type { ExtractedFile } from './resolve.ts'

/**
 * Version of the extraction semantics this cache records. Bump it by hand whenever `extract.ts` (or
 * a grammar that feeds it) starts producing a different result for the same source text: a stale
 * entry would otherwise be reused as if it were current, and the graph would silently keep the old
 * shape.
 */
export const EXTRACTION_CACHE_VERSION = 1

/** Path of the parse cache, relative to a project root. */
export const EXTRACTION_CACHE_RELATIVE_PATH = '.codegraph/cache/extractions.json'

/** One file's cached extraction, together with the identity it was computed from. */
export interface CachedFile {
  /** Epoch milliseconds of the file's modification time when its extraction was produced. */
  readonly modifiedAt: number
  /** File size in bytes at that same moment. */
  readonly size: number
  /** SHA-256 of the content the extraction was produced from, hex-encoded. */
  readonly contentHash: string
  /** Line count of that content, recorded so a reused file still gets a correct span. */
  readonly lineCount: number
  /** Seam language label the extraction was produced for. */
  readonly language: string
  /** The extraction itself. */
  readonly extraction: FileExtraction
}

/** The on-disk document this module writes and reads. */
interface ParseCacheDocument {
  readonly cacheVersion: number
  readonly files: Record<string, CachedFile>
}

/**
 * Whether `value` is a plain JSON object. Arrays are deliberately included: every caller still
 * validates the fields it needs, and an array simply carries none of them.
 * @param value - the parsed JSON value to test.
 * @returns whether it is a non-null object.
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * Whether `value` is a usable extraction. Deliberately shallow past the four arrays: those are what
 * `resolveWorkspace` indexes into, and the only expected producer is this package's own writer.
 * @param value - the value to test.
 * @returns whether it has the four collections an extraction consists of.
 */
function isFileExtraction(value: unknown): value is FileExtraction {
  return isRecord(value)
    && Array.isArray(value.definitions)
    && Array.isArray(value.calls)
    && Array.isArray(value.imports)
    && Array.isArray(value.heritage)
}

/**
 * Whether `value` is a complete cache entry.
 * @param value - the value to test.
 * @returns whether every field is present and of the type a reader will use it as.
 */
function isCachedFile(value: unknown): value is CachedFile {
  if (!isRecord(value)) return false
  return typeof value.modifiedAt === 'number'
    && typeof value.size === 'number'
    && typeof value.contentHash === 'string'
    && typeof value.lineCount === 'number'
    && typeof value.language === 'string'
    && isFileExtraction(value.extraction)
}

/**
 * Load the previous run's extractions for `projectRoot`.
 *
 * Never throws: a cache that cannot be read, parsed, or trusted yields an empty map, which makes the
 * caller parse everything. A single malformed entry discards the whole file — an entry is either a
 * complete record this package wrote or evidence the document was damaged, and reasoning about
 * partial reuse is not worth the risk of a graph built from a half-written entry.
 * @param projectRoot - absolute path of the workspace whose cache to load.
 * @returns the cached extractions keyed by project-relative path, empty when none can be trusted.
 */
export async function readParseCache(projectRoot: string): Promise<Map<string, CachedFile>> {
  const cachePath = join(projectRoot, EXTRACTION_CACHE_RELATIVE_PATH)
  let raw: string
  try {
    raw = await readFile(cachePath, 'utf8')
  } catch {
    // The ordinary first run has no cache file yet; an unreadable one is the same answer to the
    // caller — nothing to reuse — and must not fail an index that can still parse the workspace.
    return new Map()
  }
  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    return new Map()
  }
  if (!isRecord(document)) return new Map()
  if (document.cacheVersion !== EXTRACTION_CACHE_VERSION) return new Map()
  const entries = document.files
  if (!isRecord(entries)) return new Map()

  const cache = new Map<string, CachedFile>()
  for (const [path, entry] of Object.entries(entries)) {
    if (!isCachedFile(entry)) return new Map()
    cache.set(path, entry)
  }
  return cache
}

/**
 * Record this run's extractions as the next run's cache.
 *
 * Written through a sibling temporary name and `rename`d into place, the same way `./schema.ts`
 * replaces its status sidecar, so a reader never sees half a document. The temporary name is fixed
 * rather than unique: a write interrupted before its rename is overwritten by the next attempt
 * instead of accumulating, and a torn leftover is rejected by {@link readParseCache} at the cost of
 * one run's reuse.
 *
 * A failure is swallowed on purpose. A read-only workspace, a full disk, or a locked directory must
 * still be indexable; the cache is the optimization, never the product.
 * @param projectRoot - absolute path of the workspace to record the cache for.
 * @param files - every file this run produced an extraction for.
 */
export async function writeParseCache(projectRoot: string, files: readonly ExtractedFile[]): Promise<void> {
  const cachePath = join(projectRoot, EXTRACTION_CACHE_RELATIVE_PATH)
  const tempPath = `${cachePath}.tmp`
  try {
    const entries: Record<string, CachedFile> = {}
    for (const file of files) {
      entries[file.path] = {
        modifiedAt: file.modifiedAt,
        size: file.size,
        contentHash: file.contentHash,
        lineCount: file.lineCount,
        language: file.language,
        extraction: file.extraction,
      }
    }
    const document: ParseCacheDocument = { cacheVersion: EXTRACTION_CACHE_VERSION, files: entries }
    await mkdir(dirname(cachePath), { recursive: true })
    await writeFile(tempPath, JSON.stringify(document))
    await rename(tempPath, cachePath)
  } catch {
    // See above: an unusable cache location only means the next run parses everything again.
  }
}
