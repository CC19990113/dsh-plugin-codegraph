import { mkdir, readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import {
  EXTRACTION_CACHE_RELATIVE_PATH,
  EXTRACTION_CACHE_VERSION,
  readParseCache,
  writeParseCache,
} from '../src/cache.ts'
import type { ParseCacheFileSystem } from '../src/cache.ts'
import type { ExtractedFile } from '../src/resolve.ts'
import { walkAndExtract } from '../src/walk.ts'
import { writeProject } from './fixture.ts'

/**
 * The host backend the indexer mounts in production, over the real disk. The cache reaches its
 * document through `ctx.fs`, so these tests drive the port with the same implementation production
 * uses rather than a hand-written double — the atomic publication the writer relies on is that
 * backend's own, and the temporary sibling it stages is what the round-trip below proves was cleaned
 * up.
 */
async function localFileSystem(): Promise<ParseCacheFileSystem> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, {})
  return (ctx as Context & { readonly fs: ParseCacheFileSystem }).fs
}

/** One seam instance for the whole file: the backend is stateless, and its config is only a base. */
const fs = await localFileSystem()

/** A walk that never reads the cache, so a run produces a run's worth of extractions to record. */
const WALK = {
  exclude: ['node_modules', '.git'],
  respectGitignore: true,
  skipMinified: true,
  maxFileBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: 4,
  reuseParsedCache: false,
  cacheVerify: 'stat' as const,
}

/** A well-formed extraction, for hand-built cache documents. */
const EXTRACTION = { definitions: [], calls: [], imports: [], heritage: [] }

/** A well-formed cache entry, for documents that vary one field at a time. */
const ENTRY = {
  modifiedAt: 1_577_934_245_000,
  size: 2,
  contentHash: 'a'.repeat(64),
  lineCount: 3,
  language: 'typescript',
  extraction: EXTRACTION,
}

/** One file as the writer receives it, for tests that do not need a real parse. */
const EXTRACTED_FILE: ExtractedFile = {
  path: 'a.ts',
  language: 'typescript',
  size: 2,
  modifiedAt: 1_577_934_245_000,
  contentHash: 'b'.repeat(64),
  lineCount: 3,
  extraction: EXTRACTION,
}

/** A project holding exactly one file: a cache document written verbatim, bypassing the writer. */
async function writeRawCache(document: unknown): Promise<string> {
  return writeProject({ [EXTRACTION_CACHE_RELATIVE_PATH]: JSON.stringify(document) })
}

describe('readParseCache / writeParseCache', () => {
  it('round-trips a run\'s extractions through the cache file', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() { return 1 }\n' })
    const { files } = await walkAndExtract(root, WALK, fs)
    await writeParseCache(fs, root, files)

    const cache = await readParseCache(fs, root)
    expect([...cache.keys()]).toEqual(['src/a.ts'])
    expect(cache.get('src/a.ts')).toEqual({
      modifiedAt: files[0]?.modifiedAt,
      size: files[0]?.size,
      contentHash: files[0]?.contentHash,
      lineCount: files[0]?.lineCount,
      language: 'typescript',
      extraction: files[0]?.extraction,
    })
    // The backend publishes atomically and cleans its staging directory, so the document is the only
    // thing under the cache directory — this module no longer stages a `.tmp` sibling of its own.
    expect(await readdir(join(root, '.codegraph', 'cache'))).toEqual([basename(EXTRACTION_CACHE_RELATIVE_PATH)])
  })

  it('writes an empty cache for a run that extracted nothing', async () => {
    const root = await writeProject({})
    await writeParseCache(fs, root, [])
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })

  it('returns an empty map when the workspace has never written a cache', async () => {
    // The absent document the seam reports as `undefined` from `stat`: the ordinary first run.
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a current document that records no entries', async () => {
    // The miss at this layer: the document is well formed and written by this version, but nothing in
    // it applies — so the caller parses everything rather than reusing anything.
    const root = await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION, files: {} })
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a cache file that is not JSON', async () => {
    const root = await writeProject({ [EXTRACTION_CACHE_RELATIVE_PATH]: '{not json' })
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a document that is not an object', async () => {
    await expect(readParseCache(fs, await writeRawCache(42))).resolves.toEqual(new Map())
    await expect(readParseCache(fs, await writeRawCache(null))).resolves.toEqual(new Map())
  })

  it('returns an empty map for a cache written by another version', async () => {
    const root = await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION + 1, files: { 'a.ts': ENTRY } })
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a document with no files object', async () => {
    await expect(
      readParseCache(fs, await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION })),
    ).resolves.toEqual(new Map())
    await expect(
      readParseCache(fs, await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION, files: 7 })),
    ).resolves.toEqual(new Map())
  })

  it('discards the whole cache when any entry is malformed', async () => {
    const malformed: unknown[] = [
      null,
      [],
      { ...ENTRY, modifiedAt: '1' },
      { ...ENTRY, size: '2' },
      { ...ENTRY, contentHash: 3 },
      { ...ENTRY, lineCount: '3' },
      { ...ENTRY, language: 4 },
      { ...ENTRY, extraction: undefined },
      { ...ENTRY, extraction: [] },
      { ...ENTRY, extraction: { calls: [], imports: [], heritage: [] } },
      { ...ENTRY, extraction: { definitions: [], imports: [], heritage: [] } },
      { ...ENTRY, extraction: { definitions: [], calls: [], heritage: [] } },
      { ...ENTRY, extraction: { definitions: [], calls: [], imports: [] } },
    ]
    for (const entry of malformed) {
      const root = await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION, files: { 'a.ts': entry } })
      await expect(readParseCache(fs, root), `entry ${JSON.stringify(entry)}`).resolves.toEqual(new Map())
    }

    // A well-formed entry beside a broken one does not survive either: partial reuse is not worth
    // reasoning about when a damaged document is the only way to get one.
    const mixed = await writeRawCache({
      cacheVersion: EXTRACTION_CACHE_VERSION,
      files: { 'a.ts': ENTRY, 'b.ts': { ...ENTRY, size: '2' } },
    })
    await expect(readParseCache(fs, mixed)).resolves.toEqual(new Map())
  })

  it('treats a directory at the cache path as no cache, for reading and for writing', async () => {
    // A shape the document can never have: `stat` rejects it before a read is attempted, and the
    // backend refuses to replace a directory with text — both of which the cache must tolerate.
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    await mkdir(join(root, EXTRACTION_CACHE_RELATIVE_PATH), { recursive: true })
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
    await expect(writeParseCache(fs, root, [EXTRACTED_FILE])).resolves.toBeUndefined()
  })

  it('swallows a write failure so a workspace it may not write to still indexes', async () => {
    // `.codegraph` is a regular file here, so the cache's own path can never be resolved: the seam
    // rejects it, which is the same answer to this module as a permission failure would be.
    const root = await writeProject({ '.codegraph': 'not a directory', 'a.ts': 'export function a() {}\n' })
    await expect(writeParseCache(fs, root, [EXTRACTED_FILE])).resolves.toBeUndefined()
    await expect(readParseCache(fs, root)).resolves.toEqual(new Map())
  })
})
