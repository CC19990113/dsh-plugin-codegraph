import { afterEach, describe, expect, it } from 'vitest'
import {
  clearCommandRuns,
  commandRunHint,
  COMMAND_LOG_WINDOW_MS,
  recentCommandRun,
  recordCommandRun,
} from '../src/command-log.ts'

const NOW = Date.UTC(2026, 10, 3, 3, 0)

afterEach(() => {
  clearCommandRuns()
})

describe('recordCommandRun / recentCommandRun', () => {
  it('remembers the last run for an agent', () => {
    recordCommandRun('agent-1', { input: 'index', text: '已重建：2 文件', ok: true, at: NOW })
    expect(recentCommandRun('agent-1', NOW)).toEqual({ input: 'index', text: '已重建：2 文件', ok: true, at: NOW })
  })

  it('keeps agents apart', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'one', ok: true, at: NOW })
    recordCommandRun('agent-2', { input: 'files', text: 'two', ok: true, at: NOW })
    expect(recentCommandRun('agent-1', NOW)?.text).toBe('one')
    expect(recentCommandRun('agent-2', NOW)?.text).toBe('two')
  })

  it('overwrites instead of accumulating per agent', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'first', ok: true, at: NOW })
    recordCommandRun('agent-1', { input: 'index', text: 'second', ok: true, at: NOW + 1 })
    expect(recentCommandRun('agent-1', NOW + 1)?.text).toBe('second')
  })

  it('answers undefined for an agent that never ran one', () => {
    expect(recentCommandRun('nobody', NOW)).toBeUndefined()
  })

  it('answers undefined when the assembly carries no agent id', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'x', ok: true, at: NOW })
    expect(recentCommandRun(undefined, NOW)).toBeUndefined()
  })

  it('forgets a run once it is past the window', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'x', ok: true, at: NOW })
    expect(recentCommandRun('agent-1', NOW + COMMAND_LOG_WINDOW_MS)).toBeDefined()
    expect(recentCommandRun('agent-1', NOW + COMMAND_LOG_WINDOW_MS + 1)).toBeUndefined()
  })

  it('ignores a run recorded without an agent id', () => {
    recordCommandRun('', { input: 'status', text: 'x', ok: true, at: NOW })
    expect(recentCommandRun('', NOW)).toBeUndefined()
  })

  it('drops the oldest agent once the memory is full', () => {
    for (let index = 0; index < 200; index++) {
      recordCommandRun(`agent-${index}`, { input: 'status', text: 'x', ok: true, at: NOW })
    }
    recordCommandRun('agent-overflow', { input: 'status', text: 'x', ok: true, at: NOW })
    expect(recentCommandRun('agent-0', NOW)).toBeUndefined()
    expect(recentCommandRun('agent-overflow', NOW)).toBeDefined()
  })
})

describe('commandRunHint', () => {
  it('says nothing when no command ran', () => {
    expect(commandRunHint('agent-1', NOW)).toBe('')
  })

  it('reports a bare command as status', () => {
    recordCommandRun('agent-1', { input: '', text: '已索引：2 文件', ok: true, at: NOW })
    expect(commandRunHint('agent-1', NOW)).toBe(
      'In this session the user ran /codegraph status and saw: 已索引：2 文件',
    )
  })

  it('carries the subcommand the user actually typed', () => {
    recordCommandRun('agent-1', { input: 'files *report*', text: 'a.ts  typescript  3 声明', ok: true, at: NOW })
    expect(commandRunHint('agent-1', NOW)).toBe(
      'In this session the user ran /codegraph files *report* and saw: a.ts  typescript  3 声明',
    )
  })

  it('says a failed command failed', () => {
    recordCommandRun('agent-1', { input: 'index', text: 'Error: boom', ok: false, at: NOW })
    expect(commandRunHint('agent-1', NOW)).toBe(
      'In this session the user ran /codegraph index and it failed: Error: boom',
    )
  })

  it('keeps only the first line of a multi-line answer', () => {
    recordCommandRun('agent-1', { input: 'files x', text: 'header\nsecond\nthird', ok: true, at: NOW })
    expect(commandRunHint('agent-1', NOW)).toBe(
      'In this session the user ran /codegraph files x and saw: header',
    )
  })

  it('clips a long first line', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'x'.repeat(300), ok: true, at: NOW })
    const hint = commandRunHint('agent-1', NOW)
    expect(hint.endsWith('…')).toBe(true)
    expect(hint.length).toBeLessThan(300)
  })

  it('says nothing for a stale run', () => {
    recordCommandRun('agent-1', { input: 'index', text: 'x', ok: true, at: NOW })
    expect(commandRunHint('agent-1', NOW + COMMAND_LOG_WINDOW_MS + 1)).toBe('')
  })
})

describe('clearCommandRuns', () => {
  it('forgets everything', () => {
    recordCommandRun('agent-1', { input: 'status', text: 'x', ok: true, at: NOW })
    clearCommandRuns()
    expect(recentCommandRun('agent-1', NOW)).toBeUndefined()
  })
})
