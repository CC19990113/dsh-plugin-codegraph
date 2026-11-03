import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { UpdateChecker } from '../src/version-check.ts'
import { createUpdateChecker } from '../src/version-check.ts'
import { registerUpdateNotice } from '../src/index.ts'

/** One `agent/pre-step` listener, as the host would hold it on an agent's scope. */
type PreStepListener = (
  payload: { agent?: { id?: unknown } },
  next: () => Promise<{ kind: string; messages: readonly unknown[] }>,
) => Promise<{ kind: string; messages: readonly unknown[] }>

/** The agent-scoped context an `agent/created` payload carries, holding this agent's hooks. */
interface FakeAgentScope {
  on(name: string, listener: PreStepListener): () => boolean
}

/** A context that records what `registerUpdateNotice` registers instead of running a host. */
function fakeContext(): {
  ctx: Context
  created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[]
  disposers: (() => void)[]
} {
  const created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[] = []
  const disposers: (() => void)[] = []
  const fake = {
    on(_name: string, listener: (payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void) {
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      disposers.push(run() as () => void)
      return () => Promise.resolve()
    },
  }
  return { ctx: fake as unknown as Context, created, disposers }
}

/** A fresh agent scope that records the pre-step listener registered on it. */
function fakeAgentScope(): { scope: FakeAgentScope; listeners: PreStepListener[] } {
  const listeners: PreStepListener[] = []
  return {
    scope: {
      on(_name: string, listener: PreStepListener) {
        listeners.push(listener)
        return () => true
      },
    },
    listeners,
  }
}

/** A checker that announces `0.5.3` for a `0.5.2` build, without touching a registry. */
function newerRelease(): UpdateChecker {
  return createUpdateChecker({
    packageName: 'dsh-plugin-codegraph',
    currentVersion: '0.5.2',
    intervalMs: 1000,
    now: () => 1_000_000,
    fetchLatest: async () => '0.5.3',
  })
}

/** Let a fire-and-forget check settle. */
async function settle(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 0))
}

describe('registerUpdateNotice', () => {
  it('registers nothing on the plugin context itself, only a created-agent subscription', () => {
    const { ctx, created, disposers } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    expect(created).toHaveLength(1)
    // One disposer from `ctx.effect`, holding the registration's own disposer.
    expect(disposers).toHaveLength(1)
    expect(typeof disposers[0]).toBe('function')
  })

  it('skips an agent whose payload carries no scope', () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    // No `ctx` on the payload: nothing to register on, and no throw.
    expect(() => created[0]?.({ agent: { id: 'agent-1' } })).not.toThrow()
    expect(agent.listeners).toHaveLength(0)
  })

  it('leaves a rejected step untouched', async () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })

    const rejected = { kind: 'reject', messages: [] }
    expect(await agent.listeners[0]?.({}, async () => rejected)).toEqual(rejected)
  })

  it('leaves an admitted step untouched when there is nothing to say', async () => {
    const { ctx, created } = fakeContext()
    registerUpdateNotice(ctx, newerRelease())
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })

    const entered = { kind: 'enter', messages: [{ id: 'one' }] }
    expect(await agent.listeners[0]?.({}, async () => entered)).toEqual(entered)
  })

  it('appends the notice to an admitted step after a tool ran in that session', async () => {
    const { ctx, created } = fakeContext()
    const checker = newerRelease()
    registerUpdateNotice(ctx, checker)
    const agent = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: agent.scope } })
    checker.noteToolUse('agent-1')
    await settle()

    const existing = { id: 'existing' }
    const decision = await agent.listeners[0]?.(
      {},
      async () => ({ kind: 'enter', messages: [existing] }),
    )
    expect(decision?.kind).toBe('enter')
    expect(decision?.messages).toHaveLength(2)
    expect(decision?.messages[0]).toBe(existing)
    expect(decision?.messages[1]).toMatchObject({ role: 'user', source: { form: 'notice' } })
  })

  it('does not hand a neighbour session an announcement it did not trigger', async () => {
    const { ctx, created } = fakeContext()
    const checker = newerRelease()
    registerUpdateNotice(ctx, checker)
    const first = fakeAgentScope()
    const second = fakeAgentScope()
    created[0]?.({ agent: { id: 'agent-1', ctx: first.scope } })
    created[0]?.({ agent: { id: 'agent-2', ctx: second.scope } })
    checker.noteToolUse('agent-1')
    await settle()

    const neighbour = await second.listeners[0]?.({}, async () => ({ kind: 'enter', messages: [] }))
    expect(neighbour?.messages).toHaveLength(0)
    const owner = await first.listeners[0]?.({}, async () => ({ kind: 'enter', messages: [] }))
    expect(owner?.messages).toHaveLength(1)
  })
})
