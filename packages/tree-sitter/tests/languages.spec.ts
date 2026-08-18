import { describe, expect, it } from 'vitest'
import { LANGUAGE_TABLE, languageFor } from '../src/languages.ts'

describe('languageFor', () => {
  it('resolves every extension in the table to its language', () => {
    for (const spec of LANGUAGE_TABLE) {
      for (const extension of spec.extensions) {
        expect(languageFor(extension)?.language).toBe(spec.language)
      }
    }
  })

  it('returns undefined for an extension no grammar owns', () => {
    expect(languageFor('.rb')).toBeUndefined()
  })

  it('routes .tsx to the tsx grammar and .ts to the typescript grammar', () => {
    expect(languageFor('.tsx')?.wasmFile).toBe('tree-sitter-tsx.wasm')
    expect(languageFor('.ts')?.wasmFile).toBe('tree-sitter-typescript.wasm')
  })
})
