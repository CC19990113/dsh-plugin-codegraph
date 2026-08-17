import { describe, expect, it } from 'vitest'
import { languageFor } from '../src/languages.ts'
import { createParser, loadGrammar } from '../src/grammar.ts'

describe('grammar loading', () => {
  it('loads a real grammar and parses with it', async () => {
    const spec = languageFor('.py')
    if (spec === undefined) throw new Error('python spec missing')
    const parser = await createParser(spec)
    const tree = parser.parse('def foo():\n    pass\n')
    expect(tree?.rootNode.type).toBe('module')
    parser.delete()
  })

  it('caches a grammar across calls instead of reloading it', async () => {
    const spec = languageFor('.go')
    if (spec === undefined) throw new Error('go spec missing')
    const first = await loadGrammar(spec)
    const second = await loadGrammar(spec)
    expect(second).toBe(first)
  })

  it('loads distinct grammars for distinct languages', async () => {
    const ts = languageFor('.ts')
    const py = languageFor('.py')
    if (ts === undefined || py === undefined) throw new Error('spec missing')
    const [tsLang, pyLang] = await Promise.all([loadGrammar(ts), loadGrammar(py)])
    expect(tsLang).not.toBe(pyLang)
  })
})
