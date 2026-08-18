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
 * @module dsh-plugin-codegraph-tree-sitter/worktree
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'

/**
 * Runs one git command and returns its stdout, throwing on any non-zero exit, missing `git` binary,
 * or timeout. Indirection over `execFileSync` so tests never fork a real process.
 */
export type GitExec = (args: readonly string[], cwd: string) => string

/** The real `git`-backed {@link GitExec}. Array arguments, no shell, a hard timeout. */
export const execGit: GitExec = (args, cwd) =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8', timeout: 2_000 })

/** What `detectWorktree` learned about one root. */
export interface WorktreeInfo {
  /** Whether `root` is a linked worktree rather than the main working tree (or a lone clone). */
  readonly isWorktree: boolean
  /** This worktree's own top-level directory (`git rev-parse --show-toplevel` from `root`). */
  readonly toplevel: string
  /** The main repository's working directory, present only when {@link isWorktree} is `true`. */
  readonly mainRepoRoot?: string
}

/** Memoized per root: git diagnostics are cheap to answer wrong (a stale worktree list) but not free. */
const cache = new Map<string, WorktreeInfo | undefined>()

/**
 * Whether `root` sits inside a linked `git worktree`, and the main repository's root when it does.
 *
 * Not a git repository, `git` missing from `PATH`, or the probe timing out are all reported the same
 * way as "not a worktree" — `undefined`, never a thrown error — matching this package's existing
 * `canIndex`/`indexes` idiom of "a failed probe is a negative answer, not a failure to report."
 * @param root - absolute path to probe.
 * @param exec - the git-invoking primitive; defaults to the real `git` binary.
 * @returns worktree diagnostics, or `undefined` when `root` isn't inside a (usable) git repository.
 */
export function detectWorktree(root: string, exec: GitExec = execGit): WorktreeInfo | undefined {
  if (cache.has(root)) return cache.get(root)
  const info = probeWorktree(root, exec)
  cache.set(root, info)
  return info
}

function probeWorktree(root: string, exec: GitExec): WorktreeInfo | undefined {
  let output: string
  try {
    // One call, not three: `git rev-parse` answers every query in the order given, so a single
    // process fork either answers all three questions or fails all three the same way.
    output = exec(['rev-parse', '--show-toplevel', '--git-dir', '--git-common-dir'], root)
  } catch {
    return undefined
  }
  const lines = output.split('\n')
  const toplevelLine = lines[0]
  const gitDirLine = lines[1]
  const commonDirLine = lines[2]
  if (toplevelLine === undefined || gitDirLine === undefined || commonDirLine === undefined) return undefined

  // `git rev-parse` reports these relative to `root` (the cwd it ran in) unless they point outside
  // that tree entirely, as `--git-common-dir` does from inside a linked worktree — `resolve` is a
  // no-op on an already-absolute path either way.
  const toplevel = resolve(root, toplevelLine.trim())
  const gitDir = resolve(root, gitDirLine.trim())
  const commonDir = resolve(root, commonDirLine.trim())

  if (gitDir === commonDir) return { isWorktree: false, toplevel }
  return { isWorktree: true, toplevel, mainRepoRoot: dirname(commonDir) }
}
