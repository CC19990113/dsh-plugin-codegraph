import { writeFile } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { loadGitignore, matchesGitignore, parseGitignore } from '../src/gitignore.ts'
import { writeProject } from './fixture.ts'

describe('parseGitignore', () => {
  it('skips blank lines and comments', () => {
    expect(parseGitignore('\n# comment\n  \nnode_modules\n')).toHaveLength(1)
  })

  it('parses a plain name as an unanchored, any-depth rule', () => {
    const [rule] = parseGitignore('node_modules')
    expect(matchesGitignore([rule!], 'node_modules', true)).toBe(true)
    expect(matchesGitignore([rule!], 'packages/a/node_modules', true)).toBe(true)
    expect(matchesGitignore([rule!], 'other', true)).toBe(false)
  })

  it('expands * to match any run of characters within one segment', () => {
    const rules = parseGitignore('*.log')
    expect(matchesGitignore(rules, 'debug.log', false)).toBe(true)
    expect(matchesGitignore(rules, 'nested/debug.log', false)).toBe(true)
    expect(matchesGitignore(rules, 'nested/debug.log.txt', false)).toBe(false)
  })

  it('anchors a leading-slash pattern to the project root', () => {
    const rules = parseGitignore('/dist')
    expect(matchesGitignore(rules, 'dist', true)).toBe(true)
    expect(matchesGitignore(rules, 'packages/a/dist', true)).toBe(false)
  })

  it('anchors a pattern with an internal slash even without a leading slash', () => {
    const rules = parseGitignore('src/generated')
    expect(matchesGitignore(rules, 'src/generated', true)).toBe(true)
    expect(matchesGitignore(rules, 'other/src/generated', true)).toBe(false)
  })

  it('restricts a trailing-slash pattern to directories', () => {
    const rules = parseGitignore('build/')
    expect(matchesGitignore(rules, 'build', true)).toBe(true)
    expect(matchesGitignore(rules, 'build', false)).toBe(false)
  })

  it('lets a later negated rule re-include what an earlier rule excluded', () => {
    const rules = parseGitignore('*.log\n!keep.log\n')
    expect(matchesGitignore(rules, 'debug.log', false)).toBe(true)
    expect(matchesGitignore(rules, 'keep.log', false)).toBe(false)
  })

  it('lets a later rule re-exclude what an earlier negation re-included', () => {
    const rules = parseGitignore('*.log\n!keep.log\nkeep.log\n')
    expect(matchesGitignore(rules, 'keep.log', false)).toBe(true)
  })

  it('drops a bare "/" or "!" that names nothing once stripped', () => {
    expect(parseGitignore('/\n!\n')).toEqual([])
  })

  it('strips a trailing carriage return from a CRLF-authored file', () => {
    const rules = parseGitignore('node_modules\r\n')
    expect(matchesGitignore(rules, 'node_modules', true)).toBe(true)
  })

  it('reports no exclusion for an empty rule list', () => {
    expect(matchesGitignore([], 'anything', false)).toBe(false)
  })
})

describe('loadGitignore', () => {
  it('parses the project root .gitignore when present', async () => {
    const root = await writeProject({ 'a.ts': 'export {}\n' })
    await writeFile(`${root}/.gitignore`, 'lib/\n')
    const rules = await loadGitignore(root)
    expect(matchesGitignore(rules, 'lib', true)).toBe(true)
  })

  it('returns no rules, without throwing, when there is no .gitignore', async () => {
    const root = await writeProject({ 'a.ts': 'export {}\n' })
    await expect(loadGitignore(root)).resolves.toEqual([])
  })
})
