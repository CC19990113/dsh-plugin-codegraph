#!/usr/bin/env node
/**
 * Second half of a release: regenerate the lockfile and prove the release is
 * consistent before the release commit.
 *
 * It exists because the lockfile cannot be regenerated in `release-prepare.mjs`:
 * a platform addon version can only be resolved after that version is on the
 * registry, and the addons are published by the tag-triggered workflow. Run this
 * once the addon publish job has finished.
 *
 * What it does, in order:
 *
 *   1. `pnpm install` — writes the addon pins into `pnpm-lock.yaml`. Without this
 *      step `.github/workflows/ci.yml`'s `--frozen-lockfile` fails on every run
 *      with `ERR_PNPM_OUTDATED_LOCKFILE`.
 *   2. `pnpm run check:versions` — re-runs the same gate CI runs, so the state
 *      that is about to be committed is the state CI will accept.
 *
 * Deliberately does not commit: the commit message and the decision to include
 * the lockfile belong to the human (and the diff is worth looking at).
 *
 * Usage:
 *   node scripts/release-finish.mjs
 *
 * Exit 0 when the lockfile regenerated and the gate passes; exit 1 quoting the
 * failing command otherwise.
 */

import { execFileSync } from 'node:child_process'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Run one command in the repo root, inheriting stdio so the human sees what the
 * tool printed rather than a summary of it.
 * @param command - the executable.
 * @param args - its arguments.
 * @returns true when it exited 0.
 */
function run(command, args) {
  try {
    execFileSync(command, args, { cwd: REPO_ROOT, stdio: 'inherit' })
    return true
  } catch (error) {
    console.error(`release finish failed: \`${command} ${args.join(' ')}\` did not succeed (${error.code ?? error.message})`)
    return false
  }
}

function main() {
  console.log('regenerating the lockfile (the addon pins can only resolve after they are published)')
  if (!run('pnpm', ['install'])) {
    console.error(
      'If pnpm cannot reach the registry, the addons were not published yet: wait for the tag workflow'
      + ' to finish, then run this again.',
    )
    process.exitCode = 1
    return
  }

  console.log('\nrunning the same version gate CI runs')
  if (!run('node', ['scripts/check-release-versions.mjs'])) {
    console.error('The release is inconsistent; fix the reported problems before committing.')
    process.exitCode = 1
    return
  }

  console.log('\nDone. Review the lockfile diff, then:')
  console.log('  git add -A && git commit -m "chore: 补上平台包在 lockfile 里的记录"')
  console.log('  git push && git push --tags')
}

main()
