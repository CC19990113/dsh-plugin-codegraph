import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { detectWorktree, execGit } from '../src/worktree.ts'
import type { GitExec } from '../src/worktree.ts'

/** A `GitExec` double that always returns one fixed string, ignoring `args`/`cwd`. */
function fixedExec(output: string): GitExec {
  return () => output
}

/** A `GitExec` double that always throws, as `execFileSync` does for a non-git dir or missing `git`. */
function throwingExec(error: unknown): GitExec {
  return () => { throw error }
}

describe('detectWorktree', () => {
  it('reports the main working tree (not a worktree) when git-dir equals git-common-dir', () => {
    const info = detectWorktree('/fake/main-repo-1', fixedExec('/fake/main-repo-1\n.git\n.git\n'))
    expect(info).toEqual({ isWorktree: false, toplevel: '/fake/main-repo-1' })
  })

  it('reports a linked worktree and resolves the main repo root when git-dir differs', () => {
    const output = '/fake/wt-1\n/fake/main-repo-2/.git/worktrees/wt\n/fake/main-repo-2/.git\n'
    const info = detectWorktree('/fake/wt-1', fixedExec(output))
    expect(info).toEqual({
      isWorktree: true,
      toplevel: '/fake/wt-1',
      mainRepoRoot: '/fake/main-repo-2',
    })
  })

  it('returns undefined, never throwing, when the root is not a git repository', () => {
    const error = Object.assign(new Error('fatal: not a git repository'), { status: 128 })
    expect(detectWorktree('/fake/not-a-repo-1', throwingExec(error))).toBeUndefined()
  })

  it('returns undefined, never throwing, when the git binary is missing', () => {
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    expect(detectWorktree('/fake/no-git-1', throwingExec(error))).toBeUndefined()
  })

  it('returns undefined rather than guessing, when the primitive answers fewer than 3 lines', () => {
    expect(detectWorktree('/fake/truncated-output-1', fixedExec('/fake/truncated-output-1\n'))).toBeUndefined()
  })

  it('caches by root: a second call for the same root never re-invokes the git primitive', () => {
    const exec = vi.fn(fixedExec('/fake/main-repo-3\n.git\n.git\n'))
    const first = detectWorktree('/fake/main-repo-3', exec)
    const second = detectWorktree('/fake/main-repo-3', exec)
    expect(second).toEqual(first)
    expect(exec).toHaveBeenCalledTimes(1)
  })

  it('detects a real linked worktree created with `git worktree add`', async () => {
    const stage = await mkdtemp(join(tmpdir(), 'dsh-codegraph-worktree-'))
    const mainRoot = join(stage, 'main')
    const worktreeRoot = join(stage, 'wt')
    await mkdir(mainRoot, { recursive: true })
    const git = (args: string[], cwd: string) => execFileSync('git', args, { cwd, encoding: 'utf8' })
    git(['init', '-q'], mainRoot)
    git(['config', 'user.email', 'test@example.com'], mainRoot)
    git(['config', 'user.name', 'Test'], mainRoot)
    await writeFile(join(mainRoot, 'a.txt'), 'x\n')
    git(['add', 'a.txt'], mainRoot)
    git(['commit', '-q', '-m', 'init'], mainRoot)
    git(['worktree', 'add', '-q', '-b', 'feature', worktreeRoot], mainRoot)

    // Derive the expected main-repo root through git's own canonicalization too, rather than
    // comparing against `mainRoot` verbatim — sidesteps any symlink normalization (e.g. macOS's
    // /tmp -> /private/tmp) git itself applies that a literal string comparison would trip over.
    const expectedMainRoot = execGit(['rev-parse', '--show-toplevel'], mainRoot).trim()

    const info = detectWorktree(worktreeRoot)
    expect(info?.isWorktree).toBe(true)
    expect(info?.mainRepoRoot).toBe(expectedMainRoot)

    const mainInfo = detectWorktree(mainRoot)
    expect(mainInfo).toEqual({ isWorktree: false, toplevel: expectedMainRoot })
  })
})

describe('execGit', () => {
  it('throws when the git command itself fails', () => {
    expect(() => execGit(['not-a-real-git-command'], process.cwd())).toThrow()
  })
})
