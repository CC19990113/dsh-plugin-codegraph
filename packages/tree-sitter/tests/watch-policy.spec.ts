import { describe, expect, it } from 'vitest'
import { decideWatch, readProcVersion } from '../src/watch-policy.ts'
import type { WatchPolicyInput } from '../src/watch-policy.ts'

/** A fully-specified `WatchPolicyInput`, overridable per test so each case only states what differs. */
function input(overrides: Partial<WatchPolicyInput> = {}): WatchPolicyInput {
  return {
    configuredWatch: true,
    root: '/home/user/project',
    env: {},
    platform: 'linux',
    procVersion: () => undefined,
    ...overrides,
  }
}

describe('decideWatch', () => {
  it('enables watching when configured on, off WSL2, with no env overrides', () => {
    expect(decideWatch(input({ platform: 'darwin' }))).toEqual({ enabled: true })
  })

  it('never enables watching the config itself never asked for', () => {
    expect(decideWatch(input({ configuredWatch: false }))).toEqual({ enabled: false, reason: 'ENV_DISABLED' })
  })

  it('does not let CODEGRAPH_FORCE_WATCH turn on a watch the config left off', () => {
    expect(decideWatch(input({ configuredWatch: false, env: { CODEGRAPH_FORCE_WATCH: '1' } })))
      .toEqual({ enabled: false, reason: 'ENV_DISABLED' })
  })

  it('CODEGRAPH_NO_WATCH=1 is a total kill switch, even over a configured-on watch', () => {
    expect(decideWatch(input({ env: { CODEGRAPH_NO_WATCH: '1' } })))
      .toEqual({ enabled: false, reason: 'ENV_DISABLED' })
  })

  it('CODEGRAPH_NO_WATCH=1 wins over CODEGRAPH_FORCE_WATCH=1', () => {
    expect(decideWatch(input({ env: { CODEGRAPH_NO_WATCH: '1', CODEGRAPH_FORCE_WATCH: '1' } })))
      .toEqual({ enabled: false, reason: 'ENV_DISABLED' })
  })

  it('disables a WSL2 root mounted in from the Windows host over DrvFs', () => {
    expect(decideWatch(input({
      root: '/mnt/c/Users/dev/project',
      procVersion: () => '5.15.90.1-microsoft-standard-WSL2',
    }))).toEqual({ enabled: false, reason: 'WSL2_MOUNT' })
  })

  it('CODEGRAPH_FORCE_WATCH=1 overrides the WSL2 DrvFs heuristic', () => {
    expect(decideWatch(input({
      root: '/mnt/c/Users/dev/project',
      procVersion: () => '5.15.90.1-microsoft-standard-WSL2',
      env: { CODEGRAPH_FORCE_WATCH: '1' },
    }))).toEqual({ enabled: true })
  })

  it('is case-insensitive matching the WSL2 kernel marker and drive letter', () => {
    expect(decideWatch(input({
      root: '/mnt/D/project',
      procVersion: () => 'Linux version 5.15.0 (Microsoft@Microsoft.com)',
    }))).toEqual({ enabled: false, reason: 'WSL2_MOUNT' })
  })

  it('does not disable a WSL2 kernel when the root sits under the Linux filesystem, not a DrvFs mount', () => {
    expect(decideWatch(input({
      root: '/home/dev/project',
      procVersion: () => '5.15.90.1-microsoft-standard-WSL2',
    }))).toEqual({ enabled: true })
  })

  it('does not treat a multi-letter /mnt segment as a DrvFs drive mount', () => {
    expect(decideWatch(input({
      root: '/mnt/network-share/project',
      procVersion: () => '5.15.90.1-microsoft-standard-WSL2',
    }))).toEqual({ enabled: true })
  })

  it('never runs the WSL2 heuristic off Linux, even if /proc/version somehow matched', () => {
    expect(decideWatch(input({
      platform: 'win32',
      root: '/mnt/c/Users/dev/project',
      procVersion: () => 'microsoft',
    }))).toEqual({ enabled: true })
  })

  it('treats an unreadable /proc/version (procVersion returning undefined) as not WSL2', () => {
    expect(decideWatch(input({ root: '/mnt/c/project', procVersion: () => undefined })))
      .toEqual({ enabled: true })
  })

  it('does not flag a Linux root merely because /proc/version lacks the WSL2 marker', () => {
    expect(decideWatch(input({ root: '/mnt/c/project', procVersion: () => '5.15.0-generic' })))
      .toEqual({ enabled: true })
  })
})

describe('readProcVersion', () => {
  it('never throws, returning a string or undefined depending on whether /proc/version exists', () => {
    const result = readProcVersion()
    expect(result === undefined || typeof result === 'string').toBe(true)
  })
})
