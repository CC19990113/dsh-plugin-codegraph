import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HOOK_MARKER_BEGIN, HOOK_MARKER_END, installGitHooks, uninstallGitHooks } from '../src/git-hooks.ts'

const HOOK_NAMES = ['post-checkout', 'post-merge', 'post-commit', 'post-rewrite']

/** A fresh, empty `.git/hooks`-shaped directory for one test — never a real git repository. */
async function freshHooksDir(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'dsh-codegraph-git-hooks-'))
}

describe('installGitHooks', () => {
  it('creates every hook fresh, executable, with a shebang and the marker block', async () => {
    const hooksDir = await freshHooksDir()
    const result = await installGitHooks({ hooksDir, command: 'codegraph_index --quiet' })
    expect(result.installed).toEqual(HOOK_NAMES)
    for (const hookName of HOOK_NAMES) {
      const path = join(hooksDir, hookName)
      const content = await readFile(path, 'utf8')
      expect(content.startsWith('#!/bin/sh\n')).toBe(true)
      expect(content).toContain(HOOK_MARKER_BEGIN)
      expect(content).toContain('codegraph_index --quiet')
      expect(content).toContain(HOOK_MARKER_END)
      const mode = (await stat(path)).mode & 0o777
      expect(mode & 0o111).not.toBe(0) // executable by someone
    }
  })

  it('is idempotent: installing twice over the same command leaves the file unchanged', async () => {
    const hooksDir = await freshHooksDir()
    await installGitHooks({ hooksDir, command: 'codegraph_index' })
    const firstContent = await readFile(join(hooksDir, 'post-commit'), 'utf8')
    const result = await installGitHooks({ hooksDir, command: 'codegraph_index' })
    const secondContent = await readFile(join(hooksDir, 'post-commit'), 'utf8')
    expect(secondContent).toBe(firstContent)
    expect(result.installed).toEqual(HOOK_NAMES)
  })

  it('replaces its own block in place when re-installed with a different command', async () => {
    const hooksDir = await freshHooksDir()
    await installGitHooks({ hooksDir, command: 'old-command' })
    await installGitHooks({ hooksDir, command: 'new-command' })
    const content = await readFile(join(hooksDir, 'post-checkout'), 'utf8')
    expect(content).not.toContain('old-command')
    expect(content).toContain('new-command')
    // Exactly one marker block, not two stacked on top of each other.
    expect(content.split(HOOK_MARKER_BEGIN)).toHaveLength(2)
  })

  it('preserves a hook file another tool already installed, appending its own block after it', async () => {
    const hooksDir = await freshHooksDir()
    const priorContent = '#!/bin/sh\nnpx lint-staged\n'
    await writeFile(join(hooksDir, 'post-commit'), priorContent, 'utf8')
    await installGitHooks({ hooksDir, command: 'codegraph_index' })
    const content = await readFile(join(hooksDir, 'post-commit'), 'utf8')
    expect(content).toContain('npx lint-staged')
    expect(content).toContain(HOOK_MARKER_BEGIN)
    expect(content.indexOf('npx lint-staged')).toBeLessThan(content.indexOf(HOOK_MARKER_BEGIN))
  })

  it('adds the missing newline before appending, when the existing file lacks a trailing one', async () => {
    const hooksDir = await freshHooksDir()
    const priorContent = '#!/bin/sh\nnpx lint-staged' // no trailing newline
    await writeFile(join(hooksDir, 'post-commit'), priorContent, 'utf8')
    await installGitHooks({ hooksDir, command: 'codegraph_index' })
    const content = await readFile(join(hooksDir, 'post-commit'), 'utf8')
    expect(content).toBe(`${priorContent}\n${HOOK_MARKER_BEGIN}\ncodegraph_index\n${HOOK_MARKER_END}\n`)
  })
})

describe('uninstallGitHooks', () => {
  it('removes only the marker block, leaving the rest of the file untouched', async () => {
    const hooksDir = await freshHooksDir()
    const priorContent = '#!/bin/sh\nnpx lint-staged\n'
    await writeFile(join(hooksDir, 'post-commit'), priorContent, 'utf8')
    await installGitHooks({ hooksDir, command: 'codegraph_index' })
    const result = await uninstallGitHooks({ hooksDir })
    expect(result.removed).toEqual(HOOK_NAMES)
    const content = await readFile(join(hooksDir, 'post-commit'), 'utf8')
    expect(content).not.toContain(HOOK_MARKER_BEGIN)
    expect(content).toContain('npx lint-staged')
  })

  it('is a no-op for a hook that was never installed by this package', async () => {
    const hooksDir = await freshHooksDir()
    const priorContent = '#!/bin/sh\nnpx lint-staged\n'
    await writeFile(join(hooksDir, 'post-commit'), priorContent, 'utf8')
    const result = await uninstallGitHooks({ hooksDir })
    expect(result.removed).toEqual([])
    expect(await readFile(join(hooksDir, 'post-commit'), 'utf8')).toBe(priorContent)
  })

  it('is a no-op when the hooks directory has no hook files at all', async () => {
    const hooksDir = await freshHooksDir()
    const result = await uninstallGitHooks({ hooksDir })
    expect(result.removed).toEqual([])
  })
})
