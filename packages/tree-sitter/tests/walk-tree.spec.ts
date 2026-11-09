/**
 * The parse tree has to be freed together with the parser.
 *
 * A real tree cannot report that it was freed, so this file mocks the parser and the extractor and
 * counts `delete()` calls. That is the point: a regression that deletes only the parser -- which
 * leaked ~100 MB per index run, and 1.1 GB across 11 runs before the host ran out of memory -- must
 * fail here instead of only showing up as a dead host hours later.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { writeProject } from './fixture.ts'

const state = vi.hoisted(() => ({ parser: 0, tree: 0, throwOnExtract: false }))

vi.mock('../src/grammar.ts', () => ({
  createParser: async () => ({
    setLanguage() {},
    parse: () => ({
      delete: () => {
        state.tree += 1
      },
    }),
    delete: () => {
      state.parser += 1
    },
  }),
}))

vi.mock('../src/extract.ts', () => ({
  extractFile: () => {
    if (state.throwOnExtract) throw new Error('extract failed')
    return { definitions: [], calls: [], imports: [], heritage: [] }
  },
}))

import { walkAndExtract } from '../src/walk.ts'

const CONFIG = {
  exclude: ['node_modules', '.git'],
  respectGitignore: true,
  skipMinified: true,
  maxFileBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: 1,
  languages: ['typescript'],
  reuseParsedCache: false,
  cacheVerify: 'stat' as const,
  engine: 'js' as const,
}

/** `reuseParsedCache: false` never reads the seam, but the signature still takes one. */
const FS = {} as never

describe('parsing frees the parse tree', () => {
  beforeEach(() => {
    state.parser = 0
    state.tree = 0
    state.throwOnExtract = false
  })

  it(`deletes the tree once the extraction is done`, async () => {
    const root = await writeProject({ 'a.ts': 'export const a = 1\n' })
    await walkAndExtract(root, CONFIG, FS)
    expect(state.tree).toBe(1)
    expect(state.parser).toBe(1)
  })

  it(`still deletes the tree when the extraction throws`, async () => {
    state.throwOnExtract = true
    const root = await writeProject({ 'a.ts': 'export const a = 1\n' })
    await expect(walkAndExtract(root, CONFIG, FS)).rejects.toThrow('extract failed')
    expect(state.tree).toBe(1)
    expect(state.parser).toBe(1)
  })
})
