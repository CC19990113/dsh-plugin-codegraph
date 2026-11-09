import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  boundSummary,
  compareVersions,
  createUpdateChecker,
  defaultStateFile,
  encodePackageName,
  fetchLatestFromRegistry,
  parseNpmrcRegistry,
  readOwnVersion,
  readStateFile,
  readTextFile,
  resolveRegistry,
  UPDATE_CHECK_TIMEOUT_MS,
  writeStateFile,
} from '../src/version-check.ts'
import type { UpdateNoticeMessage, UpdateState } from '../src/version-check.ts'

const roots: string[] = []

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function tempDir(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-update-'))
  roots.push(root)
  return root
}

describe('compareVersions', () => {
  it('orders plain numeric versions', () => {
    expect(compareVersions('0.5.2', '0.5.1')).toBeGreaterThan(0)
    expect(compareVersions('0.5.1', '0.5.2')).toBeLessThan(0)
    expect(compareVersions('0.5.2', '0.5.2')).toBe(0)
    expect(compareVersions('1.0.0', '0.99.99')).toBeGreaterThan(0)
  })

  it('treats a missing field as zero', () => {
    expect(compareVersions('1.2', '1.2.0')).toBe(0)
    expect(compareVersions('1.2.1', '1.2')).toBeGreaterThan(0)
  })

  it('ignores a leading v and surrounding space', () => {
    expect(compareVersions(' v1.0.0 ', '1.0.0')).toBe(0)
  })

  it('ranks a release above its own prereleases', () => {
    expect(compareVersions('1.0.0', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0')).toBeLessThan(0)
  })

  it('orders prerelease segments the way semver does', () => {
    expect(compareVersions('1.0.0-rc.2', '1.0.0-rc.1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-beta')).toBeLessThan(0)
    // A numeric identifier always has lower precedence than an alphanumeric one.
    expect(compareVersions('1.0.0-1', '1.0.0-alpha')).toBeLessThan(0)
    expect(compareVersions('1.0.0-alpha', '1.0.0-1')).toBeGreaterThan(0)
    expect(compareVersions('1.0.0-rc.1', '1.0.0-rc.1')).toBe(0)
  })

  it('keeps a multi-segment prerelease together', () => {
    expect(compareVersions('1.0.0-alpha-1', '1.0.0-alpha-2')).toBeLessThan(0)
  })

  it('covers the remaining prerelease comparisons', () => {
    // Both sides numeric, and the left one higher.
    expect(compareVersions('1.0.0-2', '1.0.0-1')).toBeGreaterThan(0)
    // Alphanumeric on both sides, left higher.
    expect(compareVersions('1.0.0-beta', '1.0.0-alpha')).toBeGreaterThan(0)
    // A shorter prerelease on the left is the lower one.
    expect(compareVersions('1.0.0-rc', '1.0.0-rc.1')).toBeLessThan(0)
    // Fully matching prereleases exhaust the loop.
    expect(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.1')).toBe(0)
  })

  it('reads a hyphenated prerelease as one segment and an empty core as zero', () => {
    // `alpha-1` is one alphanumeric segment, not "alpha" followed by a numeric id.
    expect(compareVersions('1.0.0-alpha-1', '1.0.0-alpha')).toBeGreaterThan(0)
    expect(compareVersions('-rc.1', '0.0.0')).toBeLessThan(0)
  })
})

describe('parseNpmrcRegistry', () => {
  it('reads the plain registry key', () => {
    expect(parseNpmrcRegistry('registry=https://registry.npmmirror.com\n')).toBe('https://registry.npmmirror.com')
  })

  it('ignores comments, blank lines, and unrelated keys', () => {
    const text = [
      '# a comment',
      '; another comment',
      '',
      '//registry.npmjs.org/:_authToken=secret',
      '@scope:registry=https://scoped.example.com',
      'registry=https://mirror.example.com',
    ].join('\n')
    expect(parseNpmrcRegistry(text)).toBe('https://mirror.example.com')
  })

  it('strips surrounding quotes and tolerates spaces around the separator', () => {
    expect(parseNpmrcRegistry('registry = "https://mirror.example.com"')).toBe('https://mirror.example.com')
    expect(parseNpmrcRegistry("registry='https://mirror.example.com'")).toBe('https://mirror.example.com')
  })

  it('reports nothing for an absent file, a line without a separator, or an empty value', () => {
    expect(parseNpmrcRegistry(undefined)).toBeUndefined()
    expect(parseNpmrcRegistry('registry')).toBeUndefined()
    expect(parseNpmrcRegistry('registry=')).toBeUndefined()
  })
})

describe('resolveRegistry', () => {
  it('prefers the environment over the npmrc and the default', () => {
    const env = { npm_config_registry: 'https://env.example.com/' }
    expect(resolveRegistry(env, () => 'registry=https://file.example.com', '/home/x')).toBe('https://env.example.com')
  })

  it('accepts the upper-case environment spelling', () => {
    expect(resolveRegistry({ NPM_CONFIG_REGISTRY: 'https://upper.example.com' }, () => undefined, '/home/x'))
      .toBe('https://upper.example.com')
  })

  it('falls back to the user npmrc', () => {
    const read = (file: string): string | undefined => (file === join('/home/x', '.npmrc') ? 'registry=https://file.example.com/' : undefined)
    expect(resolveRegistry({}, read, '/home/x')).toBe('https://file.example.com')
  })

  it('falls back to the npm default when nothing is configured', () => {
    expect(resolveRegistry({}, () => undefined, '/home/x')).toBe('https://registry.npmjs.org')
    expect(resolveRegistry({ npm_config_registry: '   ' }, () => undefined, '/home/x')).toBe('https://registry.npmjs.org')
  })
})

describe('encodePackageName', () => {
  it('keeps a scope separator and encodes the rest', () => {
    expect(encodePackageName('dsh-plugin-codegraph')).toBe('dsh-plugin-codegraph')
    expect(encodePackageName('@scope/name')).toBe('@scope/name')
    expect(encodePackageName('has space')).toBe('has%20space')
  })
})

describe('fetchLatestFromRegistry', () => {
  it('returns the advertised version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '0.9.9' }), { status: 200 })))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBe('0.9.9')
  })

  it('reports nothing for a non-ok response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('nope', { status: 404 })))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBeUndefined()
  })

  it('reports nothing for a body without a usable version', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: '' }), { status: 200 })))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response('null', { status: 200 })))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBeUndefined()
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ version: 7 }), { status: 200 })))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBeUndefined()
  })

  it('reports nothing when the request throws', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('offline') }))
    await expect(fetchLatestFromRegistry('p', 'https://r.example.com', 10)).resolves.toBeUndefined()
  })
})

describe('boundSummary', () => {
  it('leaves a short summary alone and ellipsizes a long one', () => {
    expect(boundSummary('short')).toBe('short')
    const long = 'x'.repeat(200)
    const bounded = boundSummary(long)
    expect(bounded.length).toBe(120)
    expect(bounded.endsWith('…')).toBe(true)
  })
})

describe('state files', () => {
  it('round-trips through disk', async () => {
    const dir = await tempDir()
    const file = join(dir, 'state.json')
    const state: UpdateState = { latest: '1.2.3', checkedAt: 1234, notifiedVersion: '1.2.3' }
    writeStateFile(file, state)
    expect(readStateFile(file)).toEqual(state)
  })

  it('answers the empty state for an absent, malformed, or oddly typed file', async () => {
    const dir = await tempDir()
    expect(readStateFile(join(dir, 'missing.json'))).toEqual({})
    const bad = join(dir, 'bad.json')
    await writeFile(bad, 'not json')
    expect(readStateFile(bad)).toEqual({})
    const scalar = join(dir, 'scalar.json')
    await writeFile(scalar, '7')
    expect(readStateFile(scalar)).toEqual({})
    const wrong = join(dir, 'wrong.json')
    await writeFile(wrong, JSON.stringify({ latest: 7, checkedAt: 'soon', notifiedVersion: false }))
    expect(readStateFile(wrong)).toEqual({})
  })

  it('names the state file after the package, without the plugin prefix', () => {
    expect(defaultStateFile('dsh-plugin-codegraph', '/home/x')).toBe(join('/home/x', '.dsh', 'codegraph-update-check.json'))
    expect(defaultStateFile('plain', '/home/x')).toBe(join('/home/x', '.dsh', 'plain-update-check.json'))
  })

  it('defers to DSH_HOME when the host relocated its home', () => {
    const saved = process.env.DSH_HOME
    process.env.DSH_HOME = join('/relocated', '.dsh')
    try {
      // DSH_HOME already names the `.dsh` directory itself; re-appending it would nest a second one.
      expect(defaultStateFile('dsh-plugin-codegraph')).toBe(join('/relocated', '.dsh', 'codegraph-update-check.json'))
    } finally {
      if (saved === undefined) delete process.env.DSH_HOME
      else process.env.DSH_HOME = saved
    }
  })

  it('falls back to the OS home when DSH_HOME is unset', () => {
    const saved = process.env.DSH_HOME
    delete process.env.DSH_HOME
    try {
      expect(defaultStateFile('dsh-plugin-codegraph')).toBe(join(homedir(), '.dsh', 'codegraph-update-check.json'))
    } finally {
      if (saved !== undefined) process.env.DSH_HOME = saved
    }
  })

  it('reads this package version, and falls back when asked to', () => {
    expect(readOwnVersion()).toMatch(/^\d+\.\d+\.\d+/)
    expect(readOwnVersion('9.9.9')).toBe(readOwnVersion())
  })

  it('answers the fallback when the manifest is unreadable or malformed', () => {
    expect(readOwnVersion('9.9.9', () => undefined)).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => 'not json')).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => 'null')).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => '{}')).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => JSON.stringify({ version: '' }))).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => JSON.stringify({ version: 7 }))).toBe('9.9.9')
    expect(readOwnVersion('9.9.9', () => JSON.stringify({ version: '1.2.3' }))).toBe('1.2.3')
  })

  it('reads a text file, reporting an absent one as undefined', async () => {
    const dir = await tempDir()
    const file = join(dir, 'a.txt')
    await writeFile(file, 'hello')
    expect(readTextFile(file)).toBe('hello')
    expect(readTextFile(join(dir, 'missing.txt'))).toBeUndefined()
  })
})

/** A checker whose registry answer is controlled by the test, with no file or network behind it. */
function checker(options: {
  current?: string
  latest?: string | undefined
  fetchError?: Error
  now?: () => number
  stateFile?: string
  hideLatest?: boolean
} = {}) {
  let clock = 1_000_000
  const now = options.now ?? (() => clock)
  const calls: string[] = []
  const instance = createUpdateChecker({
    packageName: 'dsh-plugin-codegraph',
    currentVersion: options.current ?? '0.5.2',
    ...(options.stateFile === undefined ? {} : { stateFile: options.stateFile }),
    intervalMs: 1000,
    now,
    async fetchLatest(name) {
      calls.push(name)
      if (options.fetchError !== undefined) throw options.fetchError
      return options.hideLatest === true ? undefined : (options.latest ?? '0.5.2')
    },
  })
  return {
    instance,
    calls,
    advance(ms: number) {
      clock += ms
    },
  }
}

/** Let the fire-and-forget check settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('createUpdateChecker', () => {
  it('says nothing before the plugin was used', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    await settle()
    expect(instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('announces a newer release once, after a tool call in that session', async () => {
    const { instance, calls } = checker({ latest: '0.5.3' })
    instance.noteToolUse('agent-1')
    await settle()
    expect(calls).toEqual(['dsh-plugin-codegraph'])
    const notice = instance.takeNotice('agent-1')
    expect(notice).toBeDefined()
    expect(notice?.role).toBe('user')
    expect(notice?.content[0]?.text).toContain('0.5.3')
    expect(notice?.content[0]?.text).toContain('0.5.2')
    expect(notice?.source.form).toBe('notice')
    expect(notice?.source.kind).toBe('dsh-plugin-codegraph-update')
    // One notice per release, however many times the tool runs.
    expect(instance.takeNotice('agent-1')).toBeUndefined()
    instance.noteToolUse('agent-1')
    await settle()
    expect(instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('keeps another session out of a notice its neighbour did not ask for', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    instance.noteToolUse('agent-1')
    await settle()
    expect(instance.takeNotice('agent-2')).toBeUndefined()
    expect(instance.takeNotice('agent-1')).toBeDefined()
  })

  it('lets a session-less use be picked up by any session', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    instance.noteToolUse()
    await settle()
    expect(instance.takeNotice('agent-1')).toBeDefined()
  })

  it('answers a session-less read from a session-less use', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    instance.noteToolUse()
    await settle()
    expect(instance.takeNotice()).toBeDefined()
  })

  it('stays silent when the running version is current or ahead', async () => {
    const current = checker({ latest: '0.5.2' })
    current.instance.noteToolUse('agent-1')
    await settle()
    expect(current.instance.takeNotice('agent-1')).toBeUndefined()

    const ahead = checker({ current: '0.5.3', latest: '0.5.2' })
    ahead.instance.noteToolUse('agent-1')
    await settle()
    expect(ahead.instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('stays silent when the registry has nothing to report', async () => {
    const { instance, calls } = checker({ hideLatest: true })
    instance.noteToolUse('agent-1')
    await settle()
    expect(calls).toHaveLength(1)
    expect(instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('swallows a failing check instead of surfacing it', async () => {
    const { instance } = checker({ fetchError: new Error('offline') })
    instance.noteToolUse('agent-1')
    await settle()
    expect(instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('honors the interval between checks and still reports the cached answer', async () => {
    const { instance, calls, advance } = checker({ latest: '0.5.3' })
    instance.noteToolUse('agent-1')
    await settle()
    instance.takeNotice('agent-1')
    // Inside the interval: no second request.
    instance.noteToolUse('agent-1')
    await settle()
    expect(calls).toHaveLength(1)
    // Past it: one more request, and the same release is still only announced once.
    advance(2000)
    instance.noteToolUse('agent-1')
    await settle()
    expect(calls).toHaveLength(2)
    expect(instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('does not report before the first check settles', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const instance = createUpdateChecker({
      packageName: 'dsh-plugin-codegraph',
      currentVersion: '0.5.2',
      intervalMs: 1000,
      now: () => 1_000_000,
      fetchLatest: async () => new Promise<string>(resolve => { resolveFetch = resolve }),
    })
    instance.noteToolUse('agent-1')
    expect(instance.takeNotice('agent-1')).toBeUndefined()
    resolveFetch?.('0.5.3')
    await settle()
    expect(instance.takeNotice('agent-1')).toBeDefined()
  })

  it('persists the check and the announced release, and survives a restart', async () => {
    const dir = await tempDir()
    const stateFile = join(dir, 'state.json')
    const first = checker({ latest: '0.5.3', stateFile })
    first.instance.noteToolUse('agent-1')
    await settle()
    expect(first.instance.takeNotice('agent-1')).toBeDefined()
    expect(readStateFile(stateFile)).toEqual({
      latest: '0.5.3',
      checkedAt: 1_000_000,
      notifiedVersion: '0.5.3',
    })

    // A fresh process reads the same state: no repeat announcement, no new request inside the interval.
    const second = checker({ latest: '0.5.3', stateFile })
    second.advance(0)
    second.instance.noteToolUse('agent-1')
    expect(second.calls).toHaveLength(0)
    expect(second.instance.takeNotice('agent-1')).toBeUndefined()
  })

  it('keeps working when the state file cannot be written', async () => {
    const { instance } = checker({ latest: '0.5.3', stateFile: join('/nonexistent-root', 'x', 'state.json') })
    instance.noteToolUse('agent-1')
    await settle()
    expect(instance.takeNotice('agent-1')).toBeDefined()
  })

  it('exposes the settled state', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    instance.noteToolUse('agent-1')
    await settle()
    expect(instance.peek()).toEqual({ latest: '0.5.3', checkedAt: 1_000_000 })
  })

  it('uses the injected registry, not the public one', async () => {
    const seen: string[] = []
    const instance = createUpdateChecker({
      packageName: 'dsh-plugin-codegraph',
      currentVersion: '0.5.2',
      registry: 'https://mirror.example.com/',
      intervalMs: 1000,
      now: () => 1_000_000,
      fetchLatest: async (_name, registry) => {
        seen.push(registry)
        return '0.5.2'
      },
    })
    instance.noteToolUse('agent-1')
    await settle()
    expect(seen).toEqual(['https://mirror.example.com'])
    expect(UPDATE_CHECK_TIMEOUT_MS).toBeGreaterThan(0)
  })

  it('falls back to the default interval when none is configured', async () => {
    let resolveFetch: ((value: string) => void) | undefined
    const instance = createUpdateChecker({
      packageName: 'dsh-plugin-codegraph',
      currentVersion: '0.5.2',
      now: () => 1_000_000,
      fetchLatest: async () => new Promise<string>(resolve => { resolveFetch = resolve }),
    })
    instance.noteToolUse('agent-1')
    // A second use while the first is in flight must not start another request.
    instance.noteToolUse('agent-1')
    resolveFetch?.('0.5.2')
    await settle()
    expect(instance.peek()).toEqual({ latest: '0.5.2', checkedAt: 1_000_000 })
  })
})

describe('UpdateNoticeMessage shape', () => {
  it('bears a unique identity and the bounded summary', async () => {
    const { instance } = checker({ latest: '0.5.3' })
    instance.noteToolUse('agent-1')
    await settle()
    const first = instance.takeNotice('agent-1') as UpdateNoticeMessage
    expect(first.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(first.source.summary).toBe('dsh-plugin-codegraph 0.5.2 → 0.5.3')
  })
})
