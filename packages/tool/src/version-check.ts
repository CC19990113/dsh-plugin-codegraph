/**
 * The one notice this plugin ever volunteers: the registry has a newer release than the one running.
 *
 * A plugin cannot upgrade itself — the package lives in a profile's dependency tree, and rewriting
 * that tree from inside a session is the host's job, not a tool's. So the most useful thing it can do
 * is say so, once, at a moment the user is already looking at its output.
 *
 * That moment is *after a tool ran*, which is why this module splits the work in two halves:
 * {@link UpdateChecker.noteToolUse} is called from the tool's own `execute`, where a network request
 * would sit inside the caller's timeout budget, and {@link UpdateChecker.takeNotice} is called from
 * the `agent/pre-step` hook, which is synchronous by contract and runs before every model request. A
 * check therefore starts in the background and only ever joins the conversation on a later step.
 *
 * Three things keep it from becoming noise:
 *
 * - **It only speaks after the plugin was used.** A notice the user did not ask for, on a step where
 *   they were doing something else, is the definition of spam. `noteToolUse` is the only way the
 *   pending flag is set.
 * - **One notice per release.** `notifiedVersion` is persisted beside the check, so restarting the
 *   desktop does not re-announce a version the user already declined to install.
 * - **Silence is the failure mode, never an error.** Every step is wrapped: a registry that is
 *   unreachable, a state file that is not writable, a body that is not JSON — all of them end as "no
 *   notice", because a check that cannot run must not cost the user a tool call.
 *
 * The message is built as a plain object rather than with `createUserMessage` from
 * `@deepseek-ai/dsh-llm`: `dsh-llm` moves exports between minor releases (see this repo's CLAUDE.md),
 * and this module needs one shape the host documents as merge-extensible. A static import of a named
 * export that later moves takes the whole plugin out of the host; four lines of local typing do not.
 * @module dsh-plugin-codegraph-tool/version-check
 */

import { randomUUID } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** The npm project's own default registry — the last resort, used only when nothing else is configured. */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org'

/** How long a completed check is trusted before another one may start (six hours). */
export const DEFAULT_UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000

/** Bound on the registry request, so a hung socket cannot hold the one in-flight slot forever. */
export const UPDATE_CHECK_TIMEOUT_MS = 4000

/** The durable half of a check: what the registry said, when, and what the user was already told. */
export interface UpdateState {
  /** Newest version the registry advertised at `checkedAt`. */
  readonly latest?: string
  /** Epoch milliseconds of the completed check, absent until one finishes. */
  readonly checkedAt?: number
  /** Newest version a notice was already emitted for, so one release is announced once. */
  readonly notifiedVersion?: string
}

/**
 * A message-shaped notice, structurally identical to what `dsh-llm`'s `createMessage` builds.
 *
 * `MessageSourceMap` is documented as merge-extensible (each producer declares its own `kind`), and
 * `form: 'notice'` is the documented form for "a one-off account of something that just happened".
 */
export interface UpdateNoticeMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: string
    readonly form: 'notice'
    readonly summary: string
  }
}

/** Collaborators a {@link UpdateChecker} needs; every one is injectable so tests need no network. */
export interface UpdateCheckerOptions {
  /** The npm package this plugin ships as, e.g. `dsh-plugin-codegraph`. */
  readonly packageName: string
  /**
   * Version of the running build. Read from the package's own `package.json` by the caller rather
   * than by this module, because a bundled deployment may not ship that file where `require` finds it.
   */
  readonly currentVersion: string
  /** State file; absent keeps the check entirely in memory (a restart re-announces, nothing breaks). */
  readonly stateFile?: string
  /** Milliseconds a completed check stays trusted (default {@link DEFAULT_UPDATE_CHECK_INTERVAL_MS}). */
  readonly intervalMs?: number
  /** Registry base URL (default {@link DEFAULT_REGISTRY}). */
  readonly registry?: string
  /** Clock, for tests. */
  readonly now?: () => number
  /** Registry reader, for tests; resolves the advertised version or `undefined`. */
  readonly fetchLatest?: (packageName: string, registry: string, timeoutMs: number) => Promise<string | undefined>
  /** Writer, for tests; a throw is swallowed into "state not persisted". */
  readonly writeState?: (file: string, state: UpdateState) => void
  /** Reader, for tests; a throw becomes the empty state. */
  readonly readState?: (file: string) => UpdateState
}

/** The two operations the host calls, and nothing else. */
export interface UpdateChecker {
  /**
   * Record that the plugin's tool ran, starting a background check when the last one is stale.
   * @param agentId - the session that ran it, so the notice lands in that conversation rather than
   * whichever one happens to assemble a request next. Omitted when the call carried no agent.
   */
  noteToolUse(agentId?: string): void
  /**
   * The notice to append to this step, if the plugin has been used since the last one and the
   * registry knows a newer release than the running one.
   * @param agentId - the session assembling this step.
   * @returns the message, or `undefined` when there is nothing to say.
   */
  takeNotice(agentId?: string): UpdateNoticeMessage | undefined
  /** The state a completed check settled on, for diagnostics and tests. */
  peek(): UpdateState
}

/** Pending-use key for a tool call that carried no agent identity (a headless or test invocation). */
const ANY_AGENT = ''

/**
 * Build the checker. It never starts a request by itself: only {@link UpdateChecker.noteToolUse}
 * does, so an installed plugin that is never called costs nothing.
 * @param options - package identity plus the injectable collaborators.
 * @returns the checker the tool registration and the pre-step hook share.
 */
export function createUpdateChecker(options: UpdateCheckerOptions): UpdateChecker {
  const intervalMs = options.intervalMs ?? DEFAULT_UPDATE_CHECK_INTERVAL_MS
  // Resolved once per process: a registry the user changes mid-session is picked up on the next
  // reload, and re-reading `.npmrc` on every call would be a file read nobody asked for.
  const registry = (options.registry ?? resolveRegistry()).replace(/\/+$/, '')
  const now = options.now ?? Date.now
  const fetchLatest = options.fetchLatest ?? fetchLatestFromRegistry
  const writeState = options.writeState ?? writeStateFile
  const readState = options.readState ?? readStateFile
  const kind = `${options.packageName}-update`

  let state: UpdateState = options.stateFile === undefined ? {} : readState(options.stateFile)
  // Sessions whose next step should hear the result. A `Set` rather than a flag so one conversation
  // running a query cannot make another one announce a version it never asked about.
  const pendingAgents = new Set<string>()
  let inFlight = false

  /** Persist once per meaningful transition; a failure only costs a repeat notice after restart. */
  function persist(): void {
    if (options.stateFile === undefined) return
    try {
      writeState(options.stateFile, state)
    } catch {
      // A read-only profile directory is a legitimate deployment, not an error worth surfacing.
    }
  }

  /** One background check. Never rejects: its whole contract is "may set `latest`". */
  async function runCheck(): Promise<void> {
    inFlight = true
    try {
      const latest = await fetchLatest(options.packageName, registry, UPDATE_CHECK_TIMEOUT_MS)
      // `checkedAt` advances even when the registry answered nothing, so an unreachable or 404-ing
      // registry is retried once per interval instead of once per tool call.
      state = latest === undefined
        ? { ...state, checkedAt: now() }
        : { ...state, latest, checkedAt: now() }
      persist()
    } catch {
      state = { ...state, checkedAt: now() }
    } finally {
      inFlight = false
    }
  }

  return {
    noteToolUse(agentId?: string) {
      pendingAgents.add(agentId ?? ANY_AGENT)
      if (inFlight) return
      if (state.checkedAt !== undefined && now() - state.checkedAt < intervalMs) return
      // Deliberately not awaited: this runs inside a tool call whose timeout budget the user set for
      // their own work, and the notice is not worth one millisecond of it.
      void runCheck()
    },

    takeNotice(agentId?: string) {
      // No notice before the plugin was used in this session, and none while the answer is still on
      // its way — the pending entry stays so the step after the check completes can still speak.
      const key = agentId ?? ANY_AGENT
      if (!pendingAgents.has(key) && !pendingAgents.has(ANY_AGENT)) return undefined
      if (state.checkedAt === undefined || now() - state.checkedAt >= intervalMs) return undefined

      // The check for this use has settled: either it found nothing, or it is about to be reported.
      pendingAgents.delete(key)
      pendingAgents.delete(ANY_AGENT)
      const latest = state.latest
      if (latest === undefined) return undefined
      if (compareVersions(latest, options.currentVersion) <= 0) return undefined
      if (state.notifiedVersion === latest) return undefined

      state = { ...state, notifiedVersion: latest }
      persist()
      return buildNotice(kind, options.packageName, options.currentVersion, latest)
    },

    peek() {
      return state
    },
  }
}

/**
 * The registry a session should consult, resolved the way npm itself resolves it: an explicit
 * `npm_config_registry` wins, then the user's `~/.npmrc`, and only then npm's own default.
 *
 * Hardcoding the public registry would check the wrong host in any deployment behind a mirror,
 * where the package the user actually installed came from the mirror and the public one may be
 * unreachable. Following the user's configuration means the answer we compare against is the answer
 * their install would get.
 * @param env - process environment, read for `npm_config_registry`.
 * @param readText - reader for the user's `.npmrc`; injectable for tests.
 * @param home - home directory holding `.npmrc`; injectable for tests.
 * @returns the registry base URL, without a trailing slash.
 */
export function resolveRegistry(
  env: NodeJS.ProcessEnv = process.env,
  readText: (file: string) => string | undefined = readTextFile,
  home: string = homedir(),
): string {
  const configured = (env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY ?? '').trim()
  if (configured !== '') return stripTrailingSlash(configured)
  const fromFile = parseNpmrcRegistry(readText(join(home, '.npmrc')))
  if (fromFile !== undefined) return stripTrailingSlash(fromFile)
  return DEFAULT_REGISTRY
}

/** The npmrc key that sets the default registry, as opposed to a scoped or auth entry. */
const NPMRC_REGISTRY_KEY = 'registry'

/**
 * Pull the `registry=` line out of npmrc text.
 *
 * Only the plain key is read: a scoped override (`@scope:registry=…`) does not apply to an unscoped
 * package, and the auth lines (`//host/:_authToken=…`) must never be mistaken for a base URL. Values
 * may be quoted, which npmrc allows.
 * @param text - file contents, or `undefined` when the file is absent.
 * @returns the configured registry, or `undefined` when this file sets none.
 */
export function parseNpmrcRegistry(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    // npmrc comments are both `#` and `;`; an empty value means "not configured here".
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const separator = line.indexOf('=')
    if (separator === -1) continue
    if (line.slice(0, separator).trim() !== NPMRC_REGISTRY_KEY) continue
    const value = line.slice(separator + 1).trim().replace(/^["']|["']$/g, '')
    if (value !== '') return value
  }
  return undefined
}

/**
 * Read a text file, treating every failure as "the file does not exist".
 * @param file - absolute path.
 * @returns the contents, or `undefined`.
 */
export function readTextFile(file: string): string | undefined {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return undefined
  }
}

/**
 * Drop trailing slashes so `${registry}/${name}/latest` never doubles a separator.
 * @param registry - the configured base URL.
 * @returns the URL without trailing slashes.
 */
function stripTrailingSlash(registry: string): string {
  return registry.replace(/\/+$/, '')
}

/**
 * Ask a registry for a package's `latest` dist-tag.
 * @param packageName - package name; scoped names are encoded per the registry's own routing.
 * @param registry - registry base URL.
 * @param timeoutMs - request bound.
 * @returns the advertised version, or `undefined` on any failure whatsoever.
 */
export async function fetchLatestFromRegistry(
  packageName: string,
  registry: string,
  timeoutMs: number,
): Promise<string | undefined> {
  // The `/latest` endpoint is the dist-tag, not the newest semver: an install follows the tag, so a
  // notice that compared against a raw maximum would nag about prereleases nobody is installing.
  const url = `${registry}/${encodePackageName(packageName)}/latest`
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: 'application/vnd.npm.install-v1+json, application/json' },
    })
    if (!response.ok) return undefined
    const body: unknown = await response.json()
    if (typeof body !== 'object' || body === null) return undefined
    const version = (body as Record<string, unknown>).version
    return typeof version === 'string' && version !== '' ? version : undefined
  } catch {
    // Unreachable network, DNS failure, abort, malformed body: all mean "nothing to report".
    return undefined
  }
}

/**
 * Encode a package name into one registry path segment, keeping the scope's `/` meaningful.
 * @param packageName - bare or scoped package name.
 * @returns the registry-safe path.
 */
export function encodePackageName(packageName: string): string {
  return packageName.startsWith('@') ? `@${encodeURIComponent(packageName.slice(1)).replace(/%2F/gi, '/')}` : encodeURIComponent(packageName)
}

/**
 * Compare two semantic versions, prerelease-aware.
 *
 * `1.0.0` outranks `1.0.0-rc.1`, which outranks `1.0.0-rc.0`; a numeric prerelease segment compares
 * numerically while an alphanumeric one compares as text, which is what semver specifies and what
 * decides whether an rc channel user is told about the next rc.
 * @param a - left version.
 * @param b - right version.
 * @returns a negative number when `a < b`, zero when equal, positive when `a > b`.
 */
export function compareVersions(a: string, b: string): number {
  const left = splitVersion(a)
  const right = splitVersion(b)
  // `as const` keeps the index a literal, so the tuple's three fields are read directly instead of
  // through an index the compiler would have to widen to `number | undefined`.
  for (const index of [0, 1, 2] as const) {
    const difference = left.numbers[index] - right.numbers[index]
    if (difference !== 0) return difference
  }
  // A release outranks any prerelease of the same core version.
  if (left.prerelease.length === 0 && right.prerelease.length === 0) return 0
  if (left.prerelease.length === 0) return 1
  if (right.prerelease.length === 0) return -1
  const depth = Math.max(left.prerelease.length, right.prerelease.length)
  for (let index = 0; index < depth; index += 1) {
    const one = left.prerelease[index]
    const other = right.prerelease[index]
    // A shorter prerelease is the lower one when all its segments matched (`1.0.0-rc` < `1.0.0-rc.1`).
    if (one === undefined) return -1
    if (other === undefined) return 1
    if (one === other) continue
    const numericOne = /^\d+$/.test(one)
    const numericOther = /^\d+$/.test(other)
    if (numericOne && numericOther) return Number(one) - Number(other)
    // Numeric identifiers always have lower precedence than alphanumeric ones.
    if (numericOne) return -1
    if (numericOther) return 1
    return one < other ? -1 : 1
  }
  return 0
}

/** The comparable parts of one version string. */
interface SplitVersion {
  readonly numbers: [number, number, number]
  readonly prerelease: readonly string[]
}

/**
 * Split a version into its three numeric fields and its prerelease segments.
 * @param version - version string, optionally `v`-prefixed.
 * @returns the parsed fields; anything unparseable counts as zero, which makes an unrecognizable
 * published version compare as "older" and therefore never nag.
 */
function splitVersion(version: string): SplitVersion {
  const trimmed = version.trim().replace(/^v/i, '')
  // Splitting on the first hyphen keeps a prerelease like `rc-1` intact; an empty core (`-rc.1`)
  // yields no numeric fields, which reads as "zero".
  const hyphen = trimmed.indexOf('-')
  const core = hyphen === -1 ? trimmed : trimmed.slice(0, hyphen)
  const parts = core.split('.')
  const numbers: [number, number, number] = [
    toNumber(parts[0]),
    toNumber(parts[1]),
    toNumber(parts[2]),
  ]
  const prerelease = hyphen === -1
    ? []
    : trimmed.slice(hyphen + 1).split('.').filter(part => part !== '')
  return { numbers, prerelease }
}

/** One numeric version field, defaulting to zero. */
function toNumber(field: string | undefined): number {
  const parsed = Number(field)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * Build the notice the model and the user both see.
 * @param kind - producer kind recorded on the message source.
 * @param packageName - package to name in the upgrade instruction.
 * @param currentVersion - version currently running.
 * @param latest - version the registry advertised.
 * @returns a frozen, message-shaped notice.
 */
function buildNotice(
  kind: string,
  packageName: string,
  currentVersion: string,
  latest: string,
): UpdateNoticeMessage {
  const text = [
    `[${packageName} 有新版本] 当前运行 ${currentVersion}，npm 上最新为 ${latest}。`,
    `升级方式：在 DSH 插件的 profile 目录执行 pnpm add ${packageName}@latest，然后重启 DSH。`,
    '这条提示由插件自动发出，同一版本只提醒一次。',
  ].join('')
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: {
      kind,
      form: 'notice',
      // The durable one-line account, bounded the way the host bounds every notice summary.
      summary: boundSummary(`${packageName} ${currentVersion} → ${latest}`),
    },
  }
}

/** Longest notice summary the host persists (`CONTEXT_SUMMARY_MAX_CHARS`). */
const CONTEXT_SUMMARY_MAX_CHARS = 120

/**
 * Bound a notice summary to what the host will store.
 * @param summary - the account, of any length.
 * @returns the account, ellipsized to {@link CONTEXT_SUMMARY_MAX_CHARS}.
 */
export function boundSummary(summary: string): string {
  return summary.length <= CONTEXT_SUMMARY_MAX_CHARS
    ? summary
    : `${summary.slice(0, CONTEXT_SUMMARY_MAX_CHARS - 1)}…`
}

/**
 * Read a persisted state file.
 * @param file - absolute path.
 * @returns the state; an absent, unreadable, or unrecognizable file yields the empty state.
 */
export function readStateFile(file: string): UpdateState {
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
  if (typeof parsed !== 'object' || parsed === null) return {}
  const record = parsed as Record<string, unknown>
  const latest = typeof record.latest === 'string' ? record.latest : undefined
  const checkedAt = typeof record.checkedAt === 'number' && Number.isFinite(record.checkedAt)
    ? record.checkedAt
    : undefined
  const notifiedVersion = typeof record.notifiedVersion === 'string' ? record.notifiedVersion : undefined
  return {
    ...(latest === undefined ? {} : { latest }),
    ...(checkedAt === undefined ? {} : { checkedAt }),
    ...(notifiedVersion === undefined ? {} : { notifiedVersion }),
  }
}

/**
 * Write a state file, creating it if needed.
 * @param file - absolute path.
 * @param state - the state to persist.
 */
export function writeStateFile(file: string, state: UpdateState): void {
  writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

/**
 * Where this plugin remembers its last check: beside the host's other per-user state, so it outlives
 * the profile a package happens to be installed in.
 *
 * `~/.dsh` is the host's own directory and is writable in every deployment this plugin runs in; a
 * failure to create or write the file is already handled by the caller, and simply means the notice
 * may repeat after a restart.
 * @param packageName - the npm package name, used to keep sibling plugins' state apart.
 * @returns the absolute state-file path.
 */
export function defaultStateFile(packageName: string, home: string = homedir()): string {
  const short = packageName.replace(/^dsh-plugin-/, '')
  return join(home, '.dsh', `${short}-update-check.json`)
}

/**
 * The version of the package this module was built into.
 *
 * Read from the package's own `package.json` relative to the built file rather than through
 * `require`, because a deployment may bundle or relocate the code. `../package.json` resolves to the
 * package root both from `src/` (tests) and from `lib/` (installed).
 * @param fallback - returned when the file cannot be read or carries no version.
 * @param readText - reader for the package manifest; injectable for tests.
 * @returns the version string.
 */
export function readOwnVersion(
  fallback = '0.0.0',
  readText: (file: string) => string | undefined = readTextFile,
): string {
  const raw = readText(new URL('../package.json', import.meta.url).pathname)
  if (raw === undefined) return fallback
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }
  if (typeof parsed !== 'object' || parsed === null) return fallback
  const version = (parsed as Record<string, unknown>).version
  return typeof version === 'string' && version !== '' ? version : fallback
}
