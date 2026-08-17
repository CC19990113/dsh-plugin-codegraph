import { symlink } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { walkAndExtract } from '../src/walk.ts'
import { writeProject } from './fixture.ts'

const BASE = { exclude: ['node_modules', '.git'], maxFileBytes: 2_000_000, maxFiles: 50_000, concurrency: 4 }

describe('walkAndExtract', () => {
  it('finds files across nested directories and skips excluded ones', async () => {
    const root = await writeProject({
      'src/main.ts': 'export function foo() {}\n',
      'node_modules/dep/index.ts': 'export function ignored() {}\n',
      'README.md': '# not code\n',
    })
    const { files, filesSkipped } = await walkAndExtract(root, BASE)
    expect(files.map(file => file.path).sort()).toEqual(['src/main.ts'])
    expect(filesSkipped).toBe(0)
  })

  it('skips a file over maxFileBytes and counts it', async () => {
    const root = await writeProject({ 'big.ts': `export function foo() {}\n${'x'.repeat(100)}` })
    const { files, filesSkipped } = await walkAndExtract(root, { ...BASE, maxFileBytes: 10 })
    expect(files).toEqual([])
    expect(filesSkipped).toBe(1)
  })

  it('stops discovering new files once maxFiles is reached and counts the overflow', async () => {
    const root = await writeProject({
      'a.ts': 'export function a() {}\n',
      'b.ts': 'export function b() {}\n',
      'c.ts': 'export function c() {}\n',
    })
    const { files, filesSkipped } = await walkAndExtract(root, { ...BASE, maxFiles: 2 })
    expect(files).toHaveLength(2)
    expect(filesSkipped).toBe(1)
  })

  it('restricts extraction to the configured languages', async () => {
    const root = await writeProject({
      'a.ts': 'export function a() {}\n',
      'b.py': 'def b():\n    pass\n',
    })
    const { files } = await walkAndExtract(root, { ...BASE, languages: ['python'] })
    expect(files.map(file => file.path)).toEqual(['b.py'])
  })

  it('produces a real extraction (definitions, size, hash) for each parsed file', async () => {
    const root = await writeProject({ 'a.ts': 'export function foo() { return 1 }\n' })
    const { files } = await walkAndExtract(root, BASE)
    expect(files).toHaveLength(1)
    expect(files[0]?.extraction.definitions).toContainEqual(expect.objectContaining({ name: 'foo' }))
    expect(files[0]?.size).toBeGreaterThan(0)
    expect(files[0]?.contentHash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('ignores a file extension no grammar owns', async () => {
    const root = await writeProject({ 'notes.md': '# hello\n', 'a.ts': 'export function a() {}\n' })
    const { files } = await walkAndExtract(root, BASE)
    expect(files.map(file => file.path)).toEqual(['a.ts'])
  })

  it('skips a directory entry that is neither a file nor a directory (a symlink)', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() {}\n' })
    await symlink(`${root}/a.ts`, `${root}/link.ts`)
    const { files } = await walkAndExtract(root, BASE)
    expect(files.map(file => file.path)).toEqual(['a.ts'])
  })
})
