/**
 * Worktree diagnostics: is a given root a linked `git worktree`, and if so, where is the main
 * repository it was created from?
 *
 * This is a diagnostic, not a bug fix. The reference implementation's original incident here was
 * index resolution walking *up* from a linked worktree and finding the main repository's
 * `.codegraph/`, silently querying the wrong graph. This package has no such code path —
 * `databasePath()` is always `join(projectRoot, '.codegraph/codegraph.db')`, and `walkAndExtract`
 * never looks outside the `projectRoot` it was given. If a caller ever *does* end up pointed at the
 * wrong root, the bug is almost certainly in how the host resolves a session's working directory, not
 * in this package — this module exists to make that distinction diagnosable, not to route around it.
 *
 * Git runs through the host's subprocess seam (`ctx.subprocess`) instead of `node:child_process`.
 * That seam is where executable resolution, environment scrubbing, bounded output collection,
 * termination grace, timeouts, and sandbox containment live: a child started here inherits a parent
 * environment with ambient credentials and `DSH_*` deployment facts removed, its stdout/stderr are
 * capped before they can exhaust this process, and the host may satisfy the request by running the
 * command in another execution world entirely. `execFileSync` would bypass all of that, so the module
 * takes the seam as a structural port and the caller supplies `execGit(ctx.subprocess)`.
 * @module dsh-plugin-codegraph-tree-sitter/worktree
 */

import { dirname, resolve } from 'node:path'

/** Exit facts a spawned child settles with, as `handle.done` reports them. */
export interface GitSpawnOutcome {
  /** Exit status of the direct child; `null` when a signal terminated it instead. */
  readonly exitCode: number | null
  /** Name of the signal that terminated the child; `null` when it exited on its own. */
  readonly signal: string | null
}

/** One collected output stream, read in whole-stream byte offsets. */
export interface GitSpawnReader {
  /**
   * Read everything the collector still retains from `fromByte` onward.
   * @param fromByte - whole-stream byte offset to resume from; `0` for a first read.
   * @returns the collected text, and whether bytes before `fromByte` had already been dropped.
   */
  readFrom(fromByte: number): { readonly text: string; readonly lossy: boolean }
}

/** One live child returned by {@link GitSpawnPort.spawn}. */
export interface GitSpawnHandle {
  /**
   * Settles with the direct child's exit facts. Rejects when the child never started — a missing
   * executable, a refused spawn, or a failing provider — and carries no collected output then.
   */
  readonly done: Promise<GitSpawnOutcome>
  /** Buffered output, one entry per stream the spec asked to have collected. */
  readonly collected: {
    /** Collected stdout, present because {@link GitSpawnSpec.stdio} always asks for it. */
    readonly stdout?: GitSpawnReader
    /** Collected stderr, present because {@link GitSpawnSpec.stdio} always asks for it. */
    readonly stderr?: GitSpawnReader
  }
}

/** How one child is launched: fully explicit, never shell-interpreted. */
export interface GitSpawnSpec {
  /** Program and arguments; `argv[0]` is the program itself, never a shell command line. */
  readonly argv: readonly string[]
  /** Working directory the child starts in. */
  readonly cwd: string
  /** One disposition per standard stream. */
  readonly stdio: {
    /** stdin stays closed: none of these probes wants input, and a prompt would hang the run. */
    readonly stdin: 'ignore'
    /** Collect stdout, retaining at most this many bytes. */
    readonly stdout: { readonly maxBytes: number }
    /** Collect stderr, retaining at most this many bytes. */
    readonly stderr: { readonly maxBytes: number }
  }
  /** Milliseconds the host may take to terminate the child once termination has started. */
  readonly graceMs: number
  /** Cancels the child; aborting runs the host's own termination procedure, not a bare kill. */
  readonly signal: AbortSignal
  /** Environment overrides, merged over the host's scrubbed parent environment. */
  readonly env: { readonly [name: string]: string }
}

/**
 * The narrow slice of `ctx.subprocess` this module consumes.
 *
 * Deliberately structural rather than an import of `@deepseek-ai/dsh-subprocess`: the tree-sitter
 * package declares no dependency on the subprocess family, and only three members of a spawn are
 * read here (argv, stdio, exit facts). Naming those keeps the port small enough that a test double
 * is a few lines, and keeps the module loadable across the host versions this package supports.
 */
export interface GitSpawnPort {
  /**
   * Start one managed child.
   * @param spec - program, arguments, cwd, stdio, termination grace, cancellation, environment.
   * @returns the live handle whose `done` reports the child's exit facts.
   */
  spawn(spec: GitSpawnSpec): GitSpawnHandle
}

/**
 * Runs one git command and returns its stdout, rejecting on any non-zero exit, timeout, output
 * overflow, or spawn failure.
 *
 * Async, because the host owns the child's lifetime: a synchronous exec cannot express the seam's
 * cancellation, and blocking this process for the length of a git probe is exactly what the
 * subprocess service exists to avoid. Callers inject this instead of forking a real process.
 */
export type GitExec = (args: readonly string[], cwd: string) => Promise<string>

/** Bound on one git probe's lifetime; the same ceiling the sync implementation used. */
const GIT_TIMEOUT_MS = 2_000

/**
 * Ceiling on collected stdout. `git rev-parse` answers in tens of bytes; the limit exists so a
 * pathological repository cannot push unbounded output through this call, not because an answer
 * of this size is expected.
 */
const GIT_MAX_OUTPUT_BYTES = 64 * 1024

/**
 * The real `git`-backed {@link GitExec}, running through the host's subprocess port.
 *
 * Every failure is a rejection, never an empty string: the callers here parse git's output
 * positionally, so a silent empty answer would be read as "truncated output" rather than "the probe
 * failed", and the module's "a failed probe is a negative answer" contract lives above this layer.
 * Environment overrides are git's own hardening — no user config, no terminal prompt, no optional
 * locks — copied from the host's own git consumer so both behave identically.
 * @param port - the spawn port; normally the host's `ctx.subprocess`.
 * @returns a git runner whose rejections describe the command and git's stderr tail.
 */
export function execGit(port: GitSpawnPort): GitExec {
  return async (args, cwd) => {
    const handle = port.spawn({
      argv: ['git', ...args],
      cwd,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: GIT_MAX_OUTPUT_BYTES },
        stderr: { maxBytes: GIT_MAX_OUTPUT_BYTES },
      },
      graceMs: GIT_TIMEOUT_MS,
      // The host drives termination from this signal, so a hung git is stopped the same way a
      // cancelled tool call is, and `done` settles with a signal exit instead of blocking forever.
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
      env: {
        GIT_CONFIG_COUNT: '0',
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        LC_ALL: 'C',
      },
    })
    const outcome = await handle.done
    if (outcome.exitCode !== 0) {
      const stderr = handle.collected.stderr
      const detail = stderr === undefined ? '' : stderr.readFrom(0).text.trim()
      // A signal exit carries no code, so name the signal instead of printing `null`.
      const how = outcome.exitCode === null
        ? `was terminated${outcome.signal === null ? '' : ` by ${outcome.signal}`}`
        : `exited with code ${outcome.exitCode}`
      throw new Error(`git ${args.join(' ')} ${how}${detail === '' ? '' : `: ${detail}`}`)
    }
    const stdout = handle.collected.stdout
    if (stdout === undefined) throw new Error(`git ${args.join(' ')} produced no collected stdout`)
    const collected = stdout.readFrom(0)
    // A lossy first read means the child wrote past the collection limit before exiting. What
    // survived is a tail, not an answer — and a first line read off it would be a fragment of the
    // real path or hash, so this is a failure rather than a truncated success.
    if (collected.lossy) {
      throw new Error(`git ${args.join(' ')} wrote more than ${GIT_MAX_OUTPUT_BYTES} bytes of stdout`)
    }
    return collected.text
  }
}

/** What `detectWorktree` learned about one root. */
export interface WorktreeInfo {
  /** Whether `root` is a linked worktree rather than the main working tree (or a lone clone). */
  readonly isWorktree: boolean
  /** This worktree's own top-level directory (`git rev-parse --show-toplevel` from `root`). */
  readonly toplevel: string
  /** The main repository's working directory, present only when {@link isWorktree} is `true`. */
  readonly mainRepoRoot?: string
}

/**
 * Memoized per root: git diagnostics are cheap to answer wrong (a stale worktree list) but not free.
 * The promise itself is cached so two concurrent probes of one root share a single child process
 * instead of racing two; `probeWorktree` resolves every failure to `undefined`, so this map never
 * holds a rejection.
 */
const cache = new Map<string, Promise<WorktreeInfo | undefined>>()

/**
 * Whether `root` sits inside a linked `git worktree`, and the main repository's root when it does.
 *
 * Not a git repository, `git` missing from `PATH`, or the probe timing out are all reported the same
 * way as "not a worktree" — `undefined`, never a thrown error — matching this package's existing
 * `canIndex`/`indexes` idiom of "a failed probe is a negative answer, not a failure to report."
 * @param root - absolute path to probe.
 * @param exec - the git-invoking primitive; pass `execGit(ctx.subprocess)` for a real probe.
 * @returns worktree diagnostics, or `undefined` when `root` isn't inside a (usable) git repository.
 */
export function detectWorktree(root: string, exec: GitExec): Promise<WorktreeInfo | undefined> {
  const cached = cache.get(root)
  if (cached !== undefined) return cached
  const pending = probeWorktree(root, exec)
  cache.set(root, pending)
  return pending
}

async function probeWorktree(root: string, exec: GitExec): Promise<WorktreeInfo | undefined> {
  let output: string
  try {
    // One call, not three: `git rev-parse` answers every query in the order given, so a single
    // process fork either answers all three questions or fails all three the same way.
    output = await exec(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], root)
  } catch {
    return undefined
  }
  const lines = output.split('\n')
  const toplevelLine = lines[0]
  const gitDirLine = lines[1]
  const commonDirLine = lines[2]
  if (toplevelLine === undefined || gitDirLine === undefined || commonDirLine === undefined) {
    return undefined
  }

  // `git rev-parse` reports these relative to `root` (the cwd it ran in) unless they point outside
  // that tree entirely, as `--git-common-dir` does from inside a linked worktree — `resolve` is a
  // no-op on an already-absolute path either way.
  const toplevel = resolve(root, toplevelLine.trim())
  const gitDir = resolve(root, gitDirLine.trim())
  const commonDir = resolve(root, commonDirLine.trim())

  if (gitDir === commonDir) return { isWorktree: false, toplevel }
  return { isWorktree: true, toplevel, mainRepoRoot: dirname(commonDir) }
}
