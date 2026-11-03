import { readdir } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  EXTRACTION_CACHE_RELATIVE_PATH,
  EXTRACTION_CACHE_VERSION,
  readParseCache,
  writeParseCache,
} from '../src/cache.ts'
import type { ExtractedFile } from '../src/resolve.ts'
import { walkAndExtract } from '../src/walk.ts'
import { writeProject } from './fixture.ts'

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
    const { files } = await walkAndExtract(root, WALK)
    await writeParseCache(root, files)

    const cache = await readParseCache(root)
    expect([...cache.keys()]).toEqual(['src/a.ts'])
    expect(cache.get('src/a.ts')).toEqual({
      modifiedAt: files[0]?.modifiedAt,
      size: files[0]?.size,
      contentHash: files[0]?.contentHash,
      lineCount: files[0]?.lineCount,
      language: 'typescript',
      extraction: files[0]?.extraction,
    })
    // A successful write renamed its temporary sibling away, leaving only the cache document.
    expect(await readdir(join(root, '.codegraph', 'cache'))).toEqual([basename(EXTRACTION_CACHE_RELATIVE_PATH)])
  })

  it('writes an empty cache for a run that extracted nothing', async () => {
    const root = await writeProject({})
    await writeParseCache(root, [])
    await expect(readParseCache(root)).resolves.toEqual(new Map())
  })

  it('returns an empty map when the workspace has never written a cache', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    await expect(readParseCache(root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a cache file that is not JSON', async () => {
    const root = await writeProject({ [EXTRACTION_CACHE_RELATIVE_PATH]: '{not json' })
    await expect(readParseCache(root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a document that is not an object', async () => {
    await expect(readParseCache(await writeRawCache(42))).resolves.toEqual(new Map())
    await expect(readParseCache(await writeRawCache(null))).resolves.toEqual(new Map())
  })

  it('returns an empty map for a cache written by another version', async () => {
    const root = await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION + 1, files: { 'a.ts': ENTRY } })
    await expect(readParseCache(root)).resolves.toEqual(new Map())
  })

  it('returns an empty map for a document with no files object', async () => {
    await expect(readParseCache(await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION }))).resolves.toEqual(new Map())
    await expect(
      readParseCache(await writeRawCache({ cacheVersion: EXTRACTION_CACHE_VERSION, files: 7 })),
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
      await expect(readParseCache(root), `entry ${JSON.stringify(entry)}`).resolves.toEqual(new Map())
    }

    // A well-formed entry beside a broken one does not survive either: partial reuse is not worth
    // reasoning about when a damaged document is the only way to get one.
    const mixed = await writeRawCache({
      cacheVersion: EXTRACTION_CACHE_VERSION,
      files: { 'a.ts': ENTRY, 'b.ts': { ...ENTRY, size: '2' } },
    })
    await expect(readParseCache(mixed)).resolves.toEqual(new Map())
  })

  it('swallows a write failure so a workspace it may not write to still indexes', async () => {
    // `.codegraph` is a regular file here, so the cache's own directory can never be created.
    const root = await writeProject({ '.codegraph': 'not a directory', 'a.ts': 'export function a() {}\n' })
    await expect(writeParseCache(root, [EXTRACTED_FILE])).resolves.toBeUndefined()
    await expect(readParseCache(root)).resolves.toEqual(new Map())
  })
})
