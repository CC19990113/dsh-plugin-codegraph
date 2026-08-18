/**
 * Git hooks as an opt-in alternative to live file watching: a caller who wants a reindex to follow
 * `git checkout`/`merge`/`commit`/`rebase` rather than (or in addition to) every individual file edit
 * can install a hook that runs one command after each.
 *
 * Deliberately just a library function, never wired into plugin load or exposed as a model-visible
 * tool: `.git/hooks/*` is shared, ambient state that outlives this plugin and can collide with a
 * user's other tooling (husky, lint-staged, ...) — installing it automatically, or letting a model
 * decide to install it, is a materially bigger blast radius than the `.codegraph/` cache this package
 * otherwise owns outright. A caller wires this in deliberately, from their own init script.
 *
 * Resolving *which* `hooksDir` to use — including the "worktrees share one hooks directory" case — is
 * the caller's job, composed from {@link detectWorktree} in `worktree.ts`; this module only ever
 * touches the one directory path it is given.
 * @module dsh-plugin-codegraph-tree-sitter/git-hooks
 */

import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/** Marks the start of this package's block inside a hook script. */
export const HOOK_MARKER_BEGIN = '# >>> dsh-plugin-codegraph sync >>>'
/** Marks the end of this package's block inside a hook script. */
export const HOOK_MARKER_END = '# <<< dsh-plugin-codegraph sync <<<'

/** The git hook names this module installs into: every point a working tree can change via git. */
const HOOK_NAMES = ['post-checkout', 'post-merge', 'post-commit', 'post-rewrite'] as const

/** Matches this package's own marker block (and one adjacent blank line) anywhere in a hook script. */
const MARKER_BLOCK = new RegExp(`\\n?${HOOK_MARKER_BEGIN}[\\s\\S]*?${HOOK_MARKER_END}\\n?`)

/** Where hooks live, and what to run once installed there. */
export interface GitHooksOptions {
  /** Absolute path to the git hooks directory (typically `<repo>/.git/hooks`). */
  readonly hooksDir: string
  /** Shell command to run from each installed hook, verbatim. */
  readonly command: string
}

/**
 * Install `options.command` into every hook in {@link HOOK_NAMES} under `options.hooksDir`.
 *
 * A hook that does not exist yet is created fresh (`#!/bin/sh` plus the marker block) and made
 * executable. A hook that already exists keeps its own content: a prior install's marker block is
 * replaced in place (idempotent re-install, e.g. after `command` changes), otherwise the block is
 * appended after whatever the file already contains — this package never discards another tool's hook.
 * @param options - the hooks directory and the command to install.
 * @returns the hook names now carrying this package's block (whether newly created or pre-existing).
 */
export async function installGitHooks(options: GitHooksOptions): Promise<{ installed: readonly string[] }> {
  await mkdir(options.hooksDir, { recursive: true })
  const block = `${HOOK_MARKER_BEGIN}\n${options.command}\n${HOOK_MARKER_END}\n`
  const installed: string[] = []
  for (const hookName of HOOK_NAMES) {
    const path = join(options.hooksDir, hookName)
    const existing = await readFile(path, 'utf8').catch(() => undefined)
    const content = existing === undefined
      ? `#!/bin/sh\n${block}`
      : MARKER_BLOCK.test(existing)
        ? existing.replace(MARKER_BLOCK, `\n${block}`)
        : `${existing.endsWith('\n') ? existing : `${existing}\n`}${block}`
    await writeFile(path, content, 'utf8')
    await chmod(path, 0o755)
    installed.push(hookName)
  }
  return { installed }
}

/**
 * Remove this package's marker block from every hook under `options.hooksDir`, leaving the rest of
 * each file (another tool's hook content, or a user's own) untouched. A hook that does not exist, or
 * exists but was never installed by {@link installGitHooks}, is left alone entirely — this never
 * deletes a hook file outright, even one that becomes empty once the block is removed.
 * @param options - the hooks directory to clean up.
 * @returns the hook names this package's block was actually removed from.
 */
export async function uninstallGitHooks(
  options: Pick<GitHooksOptions, 'hooksDir'>,
): Promise<{ removed: readonly string[] }> {
  const removed: string[] = []
  for (const hookName of HOOK_NAMES) {
    const path = join(options.hooksDir, hookName)
    const existing = await readFile(path, 'utf8').catch(() => undefined)
    if (existing === undefined || !MARKER_BLOCK.test(existing)) continue
    await writeFile(path, existing.replace(MARKER_BLOCK, ''), 'utf8')
    removed.push(hookName)
  }
  return { removed }
}
