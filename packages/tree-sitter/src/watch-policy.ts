/**
 * Whether to actually start watching a root, on top of whether `Config.watch` asked for it.
 *
 * WSL2 mounts a Windows drive over 9P (`/mnt/<drive>/...`), and that filesystem does not deliver
 * inotify events reliably — a watcher that looks alive there silently misses edits, which is worse
 * than not watching at all (the caller believes the index stays fresh and never falls back to a
 * manual `codegraph_index`). This module decides, from injected environment/platform/proc-version
 * probes only, whether to override the user's own `watch: true` for that one case.
 * @module dsh-plugin-codegraph-tree-sitter/watch-policy
 */

import { readFileSync } from 'node:fs'
import { posix, sep } from 'node:path'

/** Whether watching should actually start, and why it was overridden when it should not. */
export type WatchDecision =
  | { readonly enabled: true }
  | { readonly enabled: false; readonly reason: 'ENV_DISABLED' | 'WSL2_MOUNT' }

/** Everything {@link decideWatch} needs, all injected so no test touches the real environment. */
export interface WatchPolicyInput {
  /** The already-resolved `Config.watch` value; a policy override never turns this on when it is off. */
  readonly configuredWatch: boolean
  /** Absolute workspace root being considered for watching. */
  readonly root: string
  /** Process environment to read `CODEGRAPH_NO_WATCH`/`CODEGRAPH_FORCE_WATCH` from. */
  readonly env: NodeJS.ProcessEnv
  /** `process.platform`, injected so the WSL2 check is only ever exercised via a fake `'linux'`. */
  readonly platform: NodeJS.Platform
  /** Reads `/proc/version` (or an equivalent), returning `undefined` on any failure. */
  readonly procVersion: () => string | undefined
}

/** Matches the "Microsoft"/"microsoft-standard" marker WSL2 kernels put in `/proc/version`. */
const WSL_KERNEL_MARKER = /microsoft/i

/**
 * Decide whether to start watching `input.root`.
 *
 * Precedence: `CODEGRAPH_NO_WATCH=1` is a total kill switch that never lets any root watch, regardless
 * of `configuredWatch` or the WSL2 heuristic. Otherwise, watching stays off unless `configuredWatch` is
 * `true` — this function only ever narrows an on request, never widens an off one. With watching
 * requested, a WSL2 kernel watching a path under a `/mnt/<drive>` 9P mount is disabled by default,
 * since inotify there does not reliably deliver events; `CODEGRAPH_FORCE_WATCH=1` is the escape hatch
 * for a caller who has verified their own WSL2 setup delivers events anyway.
 */
export function decideWatch(input: WatchPolicyInput): WatchDecision {
  if (input.env.CODEGRAPH_NO_WATCH === '1') return { enabled: false, reason: 'ENV_DISABLED' }
  if (!input.configuredWatch) return { enabled: false, reason: 'ENV_DISABLED' }
  if (input.env.CODEGRAPH_FORCE_WATCH === '1') return { enabled: true }
  if (isWsl2MountedRoot(input)) return { enabled: false, reason: 'WSL2_MOUNT' }
  return { enabled: true }
}

/** Whether `input.root` is a WSL2 process watching a path mounted in from the Windows host. */
function isWsl2MountedRoot(input: WatchPolicyInput): boolean {
  if (input.platform !== 'linux') return false
  const version = input.procVersion()
  if (version === undefined || !WSL_KERNEL_MARKER.test(version)) return false
  return isDrvfsMountPath(input.root)
}

/** Whether an absolute path sits under WSL2's `/mnt/<single-letter-drive>/...` DrvFs mount convention. */
function isDrvfsMountPath(root: string): boolean {
  const normalized = root.split(sep).join(posix.sep)
  return /^\/mnt\/[a-z](\/|$)/i.test(normalized)
}

/**
 * The real {@link WatchPolicyInput.procVersion}: reads `/proc/version`, `undefined` on any failure.
 * @param path - overridable only so tests can force both the success and failure path deterministically
 * on any OS — whether the real `/proc/version` exists depends on the platform running the test, which
 * would otherwise make one of these two branches uncovered depending on where CI happens to run.
 */
export function readProcVersion(path = '/proc/version'): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}
