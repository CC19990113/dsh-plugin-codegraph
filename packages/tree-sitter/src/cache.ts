/**
 * Parse-result cache: the extraction this package computed for each file on the previous run, so a
 * repeat index of an unchanged workspace can skip the read, the parse, and the tree walk for every
 * file whose content did not change.
 *
 * The cache document is read and written through the host's filesystem seam (`ctx.fs`), named here as
 * the structural {@link ParseCacheFileSystem} port — the same discipline `./watcher.ts` applies to
 * `WatchFileSystem`. The seam is what DSH's read policy and sandbox actually gate, and it is the only
 * way this file can follow a backend whose files live in another execution world; a path-based
 * `node:fs` write would silently land somewhere the graph's readers are not looking.
 *
 * The cache is an accelerator with no authority. It is read only as a hint — anything missing,
 * unreadable, corrupt, written by another version, or shaped unexpectedly is discarded and the file
 * is parsed again, so losing it costs time and never correctness. That is what lets
 * {@link readParseCache} swallow every failure and {@link writeParseCache} tolerate a workspace this
 * process may not write to.
 * @module dsh-plugin-codegraph-tree-sitter/cache
 */

import { join } from 'node:path'
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

/**
 * One resolved filesystem target — the opaque identity `ctx.fs` hands back and every other call
 * takes. Only `targetKey` is read here: the module never parses it, and a remote backend's key is as
 * valid as a local path.
 */
export interface CacheTarget {
  /** Opaque backend identity of the target. */
  readonly targetKey: string
}

/**
 * The metadata this module consumes from a target, as `ctx.fs.stat` reports it.
 *
 * Deliberately narrower than the seam's own metadata: a cache document has no version to guard and no
 * mtime to compare (the files it describes carry their own identity inside the document), so presence
 * and kind are the whole decision. Naming the one field it reads rather than the whole `FsInfo` is
 * also what keeps this port assignable to the host's `FileSystem`.
 */
export interface CacheTargetInfo {
  /** Whether the target is a regular file, a directory, or something else. */
  readonly type: 'file' | 'directory' | 'other'
}

/**
 * The narrow slice of `ctx.fs` the parse cache consumes.
 *
 * Deliberately structural rather than an import of the host's `FileSystem`: the tree-sitter package
 * declares no dependency on `@deepseek-ai/dsh-fs`, so it names the four calls it uses instead —
 * resolve a path, ask whether it exists, read it, replace it. That keeps this module compilable and
 * loadable across the peer range the package supports, and keeps the port small enough that a test
 * double is a few lines.
 */
export interface ParseCacheFileSystem {
  /**
   * Resolve a path into a stable backend target.
   * @param path - the path to resolve; absolute paths are what this module passes.
   * @param opts - optional resolution base for a relative path.
   * @returns the resolved target, resolvable even before the file exists.
   */
  resolve(path: string, opts?: { readonly cwd?: string }): Promise<CacheTarget>
  /**
   * Report a target's metadata.
   * @param target - the resolved target to probe.
   * @returns its metadata, or undefined when nothing is there.
   */
  stat(target: CacheTarget): Promise<CacheTargetInfo | undefined>
  /**
   * Read the whole file as decoded text.
   * @param target - the resolved target to read.
   * @returns the file's content.
   */
  readText(target: CacheTarget): Promise<string>
  /**
   * Atomically create or replace the whole file. The outcome is ignored: this module only needs the
   * write to have happened, and the seam's guards are not this call's business.
   * @param target - the resolved target to write.
   * @param content - the full new content.
   * @returns the publication outcome, whose details this module does not read.
   */
  writeText(target: CacheTarget, content: string): Promise<unknown>
}

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
 * Never throws: a cache that cannot be resolved, read, parsed, or trusted yields an empty map, which
 * makes the caller parse everything. A single malformed entry discards the whole file — an entry is
 * either a complete record this package wrote or evidence the document was damaged, and reasoning
 * about partial reuse is not worth the risk of a graph built from a half-written entry.
 * @param fs - the filesystem seam to resolve, probe, and read through.
 * @param projectRoot - absolute path of the workspace whose cache to load.
 * @returns the cached extractions keyed by project-relative path, empty when none can be trusted.
 */
export async function readParseCache(fs: ParseCacheFileSystem, projectRoot: string): Promise<Map<string, CachedFile>> {
  const cachePath = join(projectRoot, EXTRACTION_CACHE_RELATIVE_PATH)
  let raw: string
  try {
    const target = await fs.resolve(cachePath)
    // The seam reports an absent target as `undefined` from `stat` but as a thrown error from
    // `readText`. Probing first keeps the ordinary first run — no cache document written yet — a plain
    // return instead of exception control flow, and rejects a directory or special file that took the
    // document's place before asking a reader to decode it.
    const info = await fs.stat(target)
    if (info === undefined || info.type !== 'file') return new Map()
    raw = await fs.readText(target)
  } catch {
    // An unreadable document is the same answer to the caller as an absent one — nothing to reuse —
    // and must not fail an index that can still parse the workspace.
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
 * Publication is the backend's contract, not this module's. `writeText` is specified as an atomic
 * create-or-replace — the local backend stages a temporary sibling and renames it into place — so the
 * previous implementation's own `.tmp` write plus `rename` is gone. That is not a shortcut taken for
 * its own sake: a path-based rename has no meaning for a backend whose files live in another
 * execution world, which is exactly the backend this module moved onto the seam to follow. The seam
 * also has no `mkdir`, so this write relies on the backend creating a missing parent directory (the
 * local one does, before staging); a backend that did not would make this write fail, which the
 * swallow below already treats as "no cache this run".
 *
 * Should a backend ever publish non-atomically, or a crash interrupt it, the worst case is a torn
 * document: {@link readParseCache} rejects it as unparseable and the next run parses everything.
 * Losing one run's reuse is the acceptable side of that trade, because the cache has no authority to
 * lose — a corrupted graph would be the unacceptable one, and no torn cache can produce it.
 *
 * A failure is swallowed on purpose. A read-only workspace, a full disk, or a locked directory must
 * still be indexable; the cache is the optimization, never the product.
 * @param fs - the filesystem seam to resolve and write through.
 * @param projectRoot - absolute path of the workspace to record the cache for.
 * @param files - every file this run produced an extraction for.
 */
export async function writeParseCache(
  fs: ParseCacheFileSystem,
  projectRoot: string,
  files: readonly ExtractedFile[],
): Promise<void> {
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
    const target = await fs.resolve(join(projectRoot, EXTRACTION_CACHE_RELATIVE_PATH))
    await fs.writeText(target, JSON.stringify(document))
  } catch {
    // See above: an unusable cache location only means the next run parses everything again.
  }
}
