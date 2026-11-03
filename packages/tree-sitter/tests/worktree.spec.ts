import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { detectWorktree, execGit } from '../src/worktree.ts'
import type {
  GitExec,
  GitSpawnHandle,
  GitSpawnOutcome,
  GitSpawnPort,
  GitSpawnReader,
  GitSpawnSpec,
} from '../src/worktree.ts'

/** A `GitExec` double that always resolves one fixed string, ignoring `args`/`cwd`. */
function fixedExec(output: string): GitExec {
  return async () => output
}

/** A `GitExec` double that always rejects, as a failed probe or missing `git` does. */
function rejectingExec(error: unknown): GitExec {
  return async () => { throw error }
}

/** One collected stream double. A single `readFrom(0)` is all this module ever performs. */
function collectedText(text: string, lossy = false): GitSpawnReader {
  return { readFrom: () => ({ text, lossy }) }
}

/** Options for {@link fakeHandle}: what the fake child wrote and how it exited. */
interface FakeHandleOptions {
  /** Exit facts the fake child settles with. */
  readonly outcome: GitSpawnOutcome
  /** Collected stdout; omit to model a provider that returned no stdout collector. */
  readonly stdout?: string
  /** Collected stderr; omit to model a provider that returned no stderr collector. */
  readonly stderr?: string
  /** Whether the collected stdout was truncated before the first read. */
  readonly lossy?: boolean
}

/** A handle double with exactly the fields {@link execGit} reads. */
function fakeHandle(options: FakeHandleOptions): GitSpawnHandle {
  const collected: { stdout?: GitSpawnReader; stderr?: GitSpawnReader } = {}
  if (options.stdout !== undefined) collected.stdout = collectedText(options.stdout, options.lossy ?? false)
  if (options.stderr !== undefined) collected.stderr = collectedText(options.stderr)
  return { done: Promise.resolve(options.outcome), collected }
}

/** A port double that records each spec and answers every spawn with `handle`. */
function recordingPort(handle: GitSpawnHandle): {
  readonly port: GitSpawnPort
  readonly specs: GitSpawnSpec[]
} {
  const specs: GitSpawnSpec[] = []
  return {
    specs,
    port: {
      spawn(spec) {
        specs.push(spec)
        return handle
      },
    },
  }
}

/**
 * A port backed by a real `git`, for the one test that has to see git's own path canonicalization.
 * `execFileSync` stands in for the host's spawn: the probe only reads argv/cwd/env and the exit
 * facts, so a faithful-enough double is a synchronous exec plus a collected-text reader.
 */
function realPort(): GitSpawnPort {
  return {
    spawn(spec) {
      const [program, ...args] = spec.argv
      if (program === undefined) throw new Error('a spawn spec needs a program at argv[0]')
      try {
        const stdout = execFileSync(program, args, {
          cwd: spec.cwd,
          encoding: 'utf8',
          env: { ...process.env, ...spec.env },
          // stderr stays piped into the thrown error; without pinning stdio, Node would also echo a
          // failing child's stderr onto the test runner's own output.
          stdio: ['ignore', 'pipe', 'pipe'],
        })
        return {
          done: Promise.resolve({ exitCode: 0, signal: null }),
          collected: { stdout: collectedText(stdout) },
        }
      } catch (error) {
        const failed = error as NodeJS.ErrnoException & {
          readonly status?: number | null
          readonly signal?: string | null
          readonly stderr?: string
        }
        return {
          done: Promise.resolve({ exitCode: failed.status ?? null, signal: failed.signal ?? null }),
          collected: { stderr: collectedText(failed.stderr ?? failed.message) },
        }
      }
    },
  }
}

describe('execGit', () => {
  it('spawns `git` through the port with the hardened spec and returns collected stdout', async () => {
    const { port, specs } = recordingPort(fakeHandle({
      outcome: { exitCode: 0, signal: null },
      stdout: '/fake/repo\n',
    }))

    const output = await execGit(port)(['rev-parse', '--show-toplevel'], '/fake/work')

    expect(output).toBe('/fake/repo\n')
    expect(specs).toHaveLength(1)
    const spec = specs[0]
    expect(spec?.argv).toEqual(['git', 'rev-parse', '--show-toplevel'])
    expect(spec?.cwd).toBe('/fake/work')
    expect(spec?.stdio).toEqual({
      stdin: 'ignore',
      stdout: { maxBytes: 64 * 1024 },
      stderr: { maxBytes: 64 * 1024 },
    })
    expect(spec?.graceMs).toBe(2_000)
    expect(spec?.signal).toBeInstanceOf(AbortSignal)
    // git's own hardening: no user config, no terminal prompt, no optional locks, stable locale.
    expect(spec?.env).toEqual({
      GIT_CONFIG_COUNT: '0',
      GIT_TERMINAL_PROMPT: '0',
      GIT_OPTIONAL_LOCKS: '0',
      LC_ALL: 'C',
    })
  })

  it('rejects with the exit code and the stderr tail on a non-zero exit', async () => {
    const { port } = recordingPort(fakeHandle({
      outcome: { exitCode: 128, signal: null },
      stderr: 'fatal: not a git repository (or any of the parent directories)\n',
    }))

    await expect(execGit(port)(['rev-parse', '--show-toplevel'], '/tmp')).rejects.toThrow(
      'git rev-parse --show-toplevel exited with code 128: fatal: not a git repository ' +
      '(or any of the parent directories)',
    )
  })

  it('rejects without a trailing detail when the provider collected no stderr', async () => {
    const { port } = recordingPort(fakeHandle({ outcome: { exitCode: 128, signal: null } }))

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toThrow(
      'git rev-parse exited with code 128',
    )
  })

  it('names the signal when the child was terminated instead of exiting', async () => {
    const { port } = recordingPort(fakeHandle({ outcome: { exitCode: null, signal: 'SIGTERM' } }))

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toThrow(
      'git rev-parse was terminated by SIGTERM',
    )
  })

  it('reports a signal exit that names no signal without inventing one', async () => {
    const { port } = recordingPort(fakeHandle({ outcome: { exitCode: null, signal: null } }))

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toThrow('git rev-parse was terminated')
  })

  it('propagates a spawn failure, which carries no output at all', async () => {
    const spawnError = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    const port: GitSpawnPort = {
      spawn() {
        return { done: Promise.reject(spawnError), collected: {} }
      },
    }

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toBe(spawnError)
  })

  it('rejects rather than returning a truncated tail when stdout overflowed', async () => {
    const { port } = recordingPort(fakeHandle({
      outcome: { exitCode: 0, signal: null },
      stdout: 'ail-of-the-output',
      lossy: true,
    }))

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toThrow(
      'git rev-parse wrote more than 65536 bytes of stdout',
    )
  })

  it('rejects when the provider returned no stdout collector at all', async () => {
    const { port } = recordingPort(fakeHandle({ outcome: { exitCode: 0, signal: null } }))

    await expect(execGit(port)(['rev-parse'], '/tmp')).rejects.toThrow(
      'git rev-parse produced no collected stdout',
    )
  })
})

describe('detectWorktree', () => {
  it('reports the main working tree (not a worktree) when git-dir equals git-common-dir', async () => {
    const info = await detectWorktree('/fake/main-repo-1', fixedExec('/fake/main-repo-1\n.git\n.git\n'))
    expect(info).toEqual({ isWorktree: false, toplevel: '/fake/main-repo-1' })
  })

  it('reports a linked worktree and resolves the main repo root when git-dir differs', async () => {
    const output = '/fake/wt-1\n/fake/main-repo-2/.git/worktrees/wt\n/fake/main-repo-2/.git\n'
    const info = await detectWorktree('/fake/wt-1', fixedExec(output))
    expect(info).toEqual({
      isWorktree: true,
      toplevel: '/fake/wt-1',
      mainRepoRoot: '/fake/main-repo-2',
    })
  })

  it('returns undefined, never rejecting, when the root is not a git repository', async () => {
    const error = Object.assign(new Error('fatal: not a git repository'), { status: 128 })
    expect(await detectWorktree('/fake/not-a-repo-1', rejectingExec(error))).toBeUndefined()
  })

  it('returns undefined, never rejecting, when the git binary is missing', async () => {
    const error = Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' })
    expect(await detectWorktree('/fake/no-git-1', rejectingExec(error))).toBeUndefined()
  })

  it('returns undefined rather than guessing, when the primitive answers fewer than 3 lines', async () => {
    expect(await detectWorktree('/fake/truncated-output-1', fixedExec('/fake/truncated-output-1\n')))
      .toBeUndefined()
  })

  it('returns undefined when only two of the three answers arrived', async () => {
    expect(await detectWorktree('/fake/two-line-output-1', fixedExec('/fake/two-line-output-1\n.git')))
      .toBeUndefined()
  })

  it('caches by root: a second call for the same root never re-invokes the git primitive', async () => {
    const exec = vi.fn(async () => '/fake/main-repo-3\n.git\n.git\n')
    const first = await detectWorktree('/fake/main-repo-3', exec)
    const second = await detectWorktree('/fake/main-repo-3', exec)
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
    const expectedMainRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd: mainRoot,
      encoding: 'utf8',
    }).trim()

    const info = await detectWorktree(worktreeRoot, execGit(realPort()))
    expect(info?.isWorktree).toBe(true)
    expect(info?.mainRepoRoot).toBe(expectedMainRoot)

    const mainInfo = await detectWorktree(mainRoot, execGit(realPort()))
    expect(mainInfo).toEqual({ isWorktree: false, toplevel: expectedMainRoot })
  })

  it('treats a real non-repository directory as "not a worktree" through the real port', async () => {
    const notARepo = await mkdtemp(join(tmpdir(), 'dsh-codegraph-no-git-'))
    const exec = execGit(realPort())
    await expect(exec(['rev-parse', '--show-toplevel'], notARepo)).rejects.toThrow(/exited with code 128/)
    expect(await detectWorktree(notARepo, exec)).toBeUndefined()
  })
})
