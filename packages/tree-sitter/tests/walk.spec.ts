import { chmod, symlink, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import { writeParseCache } from '../src/cache.ts'
import type { ParseCacheFileSystem } from '../src/cache.ts'
import { walkAndExtract } from '../src/walk.ts'
import type { WalkResult } from '../src/walk.ts'
import { writeProject } from './fixture.ts'

/**
 * The host backend the indexer mounts in production, over the real disk: the parse cache reaches its
 * document through `ctx.fs`, so a reuse test has to drive the seam production uses rather than a
 * double that could agree with a wrong port.
 */
async function localFileSystem(): Promise<ParseCacheFileSystem> {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, {})
  return (ctx as Context & { readonly fs: ParseCacheFileSystem }).fs
}

/** One seam instance for the whole file: the backend is stateless, and its config is only a base. */
const fs = await localFileSystem()

const BASE = {
  exclude: ['node_modules', '.git'],
  respectGitignore: true,
  skipMinified: true,
  maxFileBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: 4,
  reuseParsedCache: false,
  cacheVerify: 'stat' as const,
}

/** The same walk, but reading and writing the parse cache the way the indexer does. */
const REUSE = { ...BASE, reuseParsedCache: true }

/** Reuse gated on content rather than on stat, for the one behavior stat cannot see. */
const HASH = { ...REUSE, cacheVerify: 'hash' as const }

describe('walkAndExtract', () => {
  it('finds files across nested directories and skips excluded ones', async () => {
    const root = await writeProject({
      'src/main.ts': 'export function foo() {}\n',
      'node_modules/dep/index.ts': 'export function ignored() {}\n',
      'README.md': '# not code\n',
    })
    const { files, filesSkipped } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path).sort()).toEqual(['src/main.ts'])
    expect(filesSkipped).toBe(0)
  })

  it('skips a file over maxFileBytes and counts it', async () => {
    const root = await writeProject({ 'big.ts': `export function foo() {}\n${'x'.repeat(100)}` })
    const { files, filesSkipped } = await walkAndExtract(root, { ...BASE, maxFileBytes: 10 }, fs)
    expect(files).toEqual([])
    expect(filesSkipped).toBe(1)
  })

  it('stops discovering new files once maxFiles is reached and counts the overflow', async () => {
    const root = await writeProject({
      'a.ts': 'export function a() {}\n',
      'b.ts': 'export function b() {}\n',
      'c.ts': 'export function c() {}\n',
    })
    const { files, filesSkipped } = await walkAndExtract(root, { ...BASE, maxFiles: 2 }, fs)
    expect(files).toHaveLength(2)
    expect(filesSkipped).toBe(1)
  })

  it('restricts extraction to the configured languages', async () => {
    const root = await writeProject({
      'a.ts': 'export function a() {}\n',
      'b.py': 'def b():\n    pass\n',
    })
    const { files } = await walkAndExtract(root, { ...BASE, languages: ['python'] }, fs)
    expect(files.map(file => file.path)).toEqual(['b.py'])
  })

  it('produces a real extraction (definitions, size, hash) for each parsed file', async () => {
    const root = await writeProject({ 'a.ts': 'export function foo() { return 1 }\n' })
    const { files } = await walkAndExtract(root, BASE, fs)
    expect(files).toHaveLength(1)
    expect(files[0]?.extraction.definitions).toContainEqual(expect.objectContaining({ name: 'foo' }))
    expect(files[0]?.size).toBeGreaterThan(0)
    expect(files[0]?.lineCount).toBe(2)
    expect(files[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores a file extension no grammar owns', async () => {
    const root = await writeProject({ 'notes.md': '# hello\n', 'a.ts': 'export function a() {}\n' })
    const { files } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path)).toEqual(['a.ts'])
  })

  it('skips a directory entry that is neither a file nor a directory (a symlink)', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    await symlink(`${root}/a.ts`, `${root}/link.ts`)
    const { files } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path)).toEqual(['a.ts'])
  })

  it('unions the project .gitignore with the configured exclude list', async () => {
    const root = await writeProject({
      '.gitignore': 'lib/\n*.generated.ts\n',
      'src/a.ts': 'export function a() {}\n',
      'lib/a.ts': 'export function compiled() {}\n',
      'src/a.generated.ts': 'export function generated() {}\n',
      'node_modules/dep/index.ts': 'export function ignored() {}\n',
    })
    const { files } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path).sort()).toEqual(['src/a.ts'])
  })

  it('ignores the project .gitignore when respectGitignore is false', async () => {
    const root = await writeProject({
      '.gitignore': 'lib/\n',
      'src/a.ts': 'export function a() {}\n',
      'lib/a.ts': 'export function compiled() {}\n',
    })
    const { files } = await walkAndExtract(root, { ...BASE, respectGitignore: false }, fs)
    expect(files.map(file => file.path).sort()).toEqual(['lib/a.ts', 'src/a.ts'])
  })

  it('behaves the same with or without respectGitignore when there is no .gitignore file', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() {}\n' })
    const withGitignore = await walkAndExtract(root, BASE, fs)
    const withoutGitignore = await walkAndExtract(root, { ...BASE, respectGitignore: false }, fs)
    expect(withGitignore.files.map(file => file.path)).toEqual(withoutGitignore.files.map(file => file.path))
  })

  it('skips a committed bundle by its line shape, counting it apart from a size skip', async () => {
    const root = await writeProject({
      'src/a.ts': 'export function a() { return 1 }\n',
      'dist-test/js/vendor.js': `var a=1;${'b=2;'.repeat(400)}\n`,
    })
    const { files, filesSkipped, filesMinified } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path)).toEqual(['src/a.ts'])
    expect(filesMinified).toBe(1)
    expect(filesSkipped).toBe(0)
  })

  it('skips a .min. file by name alone, however ordinary its lines are', async () => {
    const root = await writeProject({
      'src/a.ts': 'export function a() { return 1 }\n',
      'lib/util.min.js': 'export function util() {\n  return 2\n}\n',
    })
    const { files, filesMinified } = await walkAndExtract(root, BASE, fs)
    expect(files.map(file => file.path)).toEqual(['src/a.ts'])
    expect(filesMinified).toBe(1)
  })

  it('indexes generated files when skipMinified is false', async () => {
    const root = await writeProject({ 'bundle.min.js': `var a = 1\n` })
    const { files, filesMinified } = await walkAndExtract(root, { ...BASE, skipMinified: false }, fs)
    expect(files.map(file => file.path)).toEqual(['bundle.min.js'])
    expect(filesMinified).toBe(0)
  })

  it('reports no generated files for a workspace of ordinary source', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() { return 1 }\n' })
    const { filesMinified } = await walkAndExtract(root, BASE, fs)
    expect(filesMinified).toBe(0)
  })
})

/** The declaration names a walk recovered for one path, in file order. */
function declaredNames(result: WalkResult, path: string): string[] {
  const file = result.files.find(candidate => candidate.path === path)
  return (file?.extraction.definitions ?? []).map(def => def.name)
}

describe('walkAndExtract parse cache', () => {
  /** A whole-second modification time every filesystem stores exactly, so a stat comparison is
   * deterministic instead of racing the clock. */
  const FIXED_TIME = new Date('2020-01-02T03:04:05.000Z')

  it('reports no reuse on a run that has no cache to reuse from', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const { files, filesReused } = await walkAndExtract(root, REUSE, fs)
    expect(filesReused).toBe(0)
    expect(files).toHaveLength(1)
  })

  it('reuses an unchanged file\'s cached extraction instead of parsing it again', async () => {
    const root = await writeProject({ 'src/a.ts': 'export function a() { return 1 }\n' })
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files)

    const second = await walkAndExtract(root, REUSE, fs)
    expect(second.filesReused).toBe(1)
    expect(second.files).toHaveLength(1)
    expect(second.files[0]?.extraction).toEqual(first.files[0]?.extraction)
    expect(second.files[0]?.contentHash).toBe(first.files[0]?.contentHash)
    expect(second.files[0]?.lineCount).toBe(first.files[0]?.lineCount)
  })

  it('parses a file whose mtime changed even though its size did not', async () => {
    const root = await writeProject({ 'a.ts': 'export function aaa() {}\n' })
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files)

    const target = join(root, 'a.ts')
    // Same length as the cached content, so only the mtime can tell the two apart — and it is moved
    // to a value the cached one cannot share.
    await writeFile(target, 'export function bbb() {}\n')
    await utimes(target, FIXED_TIME, FIXED_TIME)

    const second = await walkAndExtract(root, REUSE, fs)
    expect(second.filesReused).toBe(0)
    expect(declaredNames(second, 'a.ts')).toContain('bbb')
  })

  it('parses a file whose size changed even when its mtime is identical', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const target = join(root, 'a.ts')
    // Pinned before the first run, so the cache records exactly this mtime; pinning it again after
    // the rewrite leaves the size comparison as the only thing between this file and a stale reuse.
    await utimes(target, FIXED_TIME, FIXED_TIME)
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files)

    await writeFile(target, 'export function longerName() {}\n')
    await utimes(target, FIXED_TIME, FIXED_TIME)

    const second = await walkAndExtract(root, REUSE, fs)
    expect(second.filesReused).toBe(0)
    expect(declaredNames(second, 'a.ts')).toContain('longerName')
  })

  it('reuses a cached extraction without reading the file it describes', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const target = join(root, 'a.ts')
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files)

    // Stat still works without read permission, but an actual read would fail — so a run that reaches
    // the parser here has no way to return this file.
    await chmod(target, 0o000)
    try {
      const second = await walkAndExtract(root, REUSE, fs)
      expect(second.filesReused).toBe(1)
      expect(declaredNames(second, 'a.ts')).toEqual(['a'])
    } finally {
      await chmod(target, 0o644)
    }
  })

  it('parses a file the cache does not cover while reusing the ones it does', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n', 'b.ts': 'export function b() {}\n' })
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files.filter(file => file.path === 'a.ts'))

    const second = await walkAndExtract(root, REUSE, fs)
    expect(second.filesReused).toBe(1)
    expect(second.files.map(file => file.path).sort()).toEqual(['a.ts', 'b.ts'])
    expect(declaredNames(second, 'b.ts')).toEqual(['b'])
  })

  it('verifies by content hash when configured, reusing an unchanged file', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const first = await walkAndExtract(root, HASH, fs)
    await writeParseCache(fs, root, first.files)

    const second = await walkAndExtract(root, HASH, fs)
    expect(second.filesReused).toBe(1)
    expect(declaredNames(second, 'a.ts')).toEqual(['a'])
  })

  it('catches a same-size rewrite with a preserved mtime when verifying by hash', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const target = join(root, 'a.ts')
    await utimes(target, FIXED_TIME, FIXED_TIME)
    const first = await walkAndExtract(root, HASH, fs)
    await writeParseCache(fs, root, first.files)

    // Same length, same mtime: stat verification cannot tell these two contents apart, which is the
    // case hash verification exists for.
    await writeFile(target, 'export function b() {}\n')
    await utimes(target, FIXED_TIME, FIXED_TIME)

    const statVerified = await walkAndExtract(root, REUSE, fs)
    expect(statVerified.filesReused).toBe(1)
    expect(declaredNames(statVerified, 'a.ts')).toEqual(['a'])

    const hashVerified = await walkAndExtract(root, HASH, fs)
    expect(hashVerified.filesReused).toBe(0)
    expect(declaredNames(hashVerified, 'a.ts')).toEqual(['b'])
  })

  it('records the current mtime for a hash-matched file that was touched since the cache was written', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const target = join(root, 'a.ts')
    await utimes(target, FIXED_TIME, FIXED_TIME)
    const first = await walkAndExtract(root, HASH, fs)
    await writeParseCache(fs, root, first.files)

    // Identical content, newer mtime: the extraction is still valid, but the graph must describe the
    // file as it is now or `status` would report it stale forever after a plain `touch`.
    const touched = new Date('2021-02-03T04:05:06.000Z')
    await utimes(target, touched, touched)

    const second = await walkAndExtract(root, HASH, fs)
    expect(second.filesReused).toBe(1)
    expect(second.files[0]?.modifiedAt).toBe(touched.getTime())
    expect(second.files[0]?.modifiedAt).not.toBe(first.files[0]?.modifiedAt)
  })

  it('parses every file when reuse is off, even with a cache present', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    const first = await walkAndExtract(root, REUSE, fs)
    await writeParseCache(fs, root, first.files)

    const second = await walkAndExtract(root, BASE, fs)
    expect(second.filesReused).toBe(0)
    expect(declaredNames(second, 'a.ts')).toEqual(['a'])
  })
})
