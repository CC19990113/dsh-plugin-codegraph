import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { StructureHintMessage } from '../src/structure-hint.ts'
import {
  buildStructureHint,
  createStructureHintState,
  lastStructureUserText,
  looksLikeStructureQuestion,
  noteStructureToolUse,
  registerStructureHint,
  STRUCTURE_HINT_SOURCE_KIND,
  STRUCTURE_QUESTION_TERMS,
} from '../src/structure-hint.ts'

/** One `agent/pre-step` listener, as the host would hold it on an agent's scope. */
type PreStepListener = (
  payload: { agent?: { id?: unknown }; messages?: readonly unknown[] },
  next: () => Promise<{ kind: string; messages: readonly unknown[] }>,
) => Promise<{ kind: string; messages: readonly unknown[] }>

/** The agent-scoped context an `agent/created` payload carries. */
interface FakeAgentScope {
  on(name: string, listener: PreStepListener): () => boolean
}

/** A context that records what `registerStructureHint` registers instead of running a host. */
function fakeContext(): {
  ctx: Context
  created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[]
} {
  const created: ((payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void)[] = []
  const fake = {
    on(_name: string, listener: (payload: { agent?: { id?: unknown; ctx?: FakeAgentScope } }) => void) {
      created.push(listener)
      return () => true
    },
    effect(run: () => unknown) {
      return run()
    },
  }
  return { ctx: fake as unknown as Context, created }
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

/** A user message as the host builds it from something the user typed. */
function userMessage(text: string): unknown {
  return { role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text }] }
}

/** Injected context carrying the user role, which must never be read as typed input. */
function injectedMessage(text: string): unknown {
  return { role: 'user', source: { kind: 'recall' }, content: [{ type: 'text', text }] }
}

/** Register the hook for one agent and hand back the listener installed on that agent. */
function mountOneAgent(): {
  listener: PreStepListener
  state: ReturnType<typeof createStructureHintState>
} {
  const { ctx, created } = fakeContext()
  const state = createStructureHintState()
  registerStructureHint(ctx, state)
  const { scope, listeners } = fakeAgentScope()
  // The listener lands on the agent's own scope, which only exists once `agent/created` fired.
  for (const listener of created) listener({ agent: { id: 'agent-1', ctx: scope } })
  return { listener: listeners[0] as PreStepListener, state }
}

/** Run one admitted step through the listener with the given batch. */
async function enter(
  listener: PreStepListener,
  messages: readonly unknown[],
): Promise<{ kind: string; messages: readonly unknown[] }> {
  return listener({ agent: { id: 'agent-1' }, messages }, async () => ({ kind: 'enter', messages }))
}

describe('looksLikeStructureQuestion', () => {
  it('matches the questions the graph exists to answer', () => {
    expect(looksLikeStructureQuestion('这个函数在哪定义的')).toBe(true)
    expect(looksLikeStructureQuestion('谁调用了 describeError')).toBe(true)
    expect(looksLikeStructureQuestion('改这个会影响哪些地方')).toBe(true)
    expect(looksLikeStructureQuestion('where is the job registry declared')).toBe(true)
  })

  it('leaves ordinary work requests alone', () => {
    expect(looksLikeStructureQuestion('把这个按钮颜色改成蓝色')).toBe(false)
    expect(looksLikeStructureQuestion('跑一下测试')).toBe(false)
  })
})

describe('lastStructureUserText', () => {
  it('reads the last genuine user input', () => {
    expect(lastStructureUserText([userMessage('第一句'), userMessage('谁调用了它')])).toBe('谁调用了它')
  })

  it('ignores injected context that carries the user role', () => {
    expect(lastStructureUserText([userMessage('谁调用了它'), injectedMessage('回忆片段：谁调用')])).toBe('谁调用了它')
  })

  it('ignores the reminder itself, so it cannot trigger on its own text', () => {
    expect(lastStructureUserText([buildStructureHint(), injectedMessage('谁调用')])).toBeUndefined()
  })

  it('returns undefined for a batch with no typed input', () => {
    expect(lastStructureUserText([])).toBeUndefined()
    expect(lastStructureUserText(undefined)).toBeUndefined()
  })

  it('walks past entries that are not user messages at all', () => {
    // Shapes a real batch carries besides typed input, placed *after* it: the walk is newest-first, so
    // these are what it has to step over before it reaches the one message the user typed.
    const batch = [
      userMessage('谁调用了它'),
      null,
      'plain text entry',
      { role: 'assistant', source: { kind: 'user' }, content: [{ type: 'text', text: '谁调用' }] },
    ]
    expect(lastStructureUserText(batch)).toBe('谁调用了它')
  })

  it('walks past a user message whose content is not a block array', () => {
    // A malformed message is skipped rather than throwing: the hook runs on every model request.
    const odd = { role: 'user', source: { kind: 'user' }, content: 'who calls this' }
    expect(lastStructureUserText([userMessage('谁调用了它'), odd])).toBe('谁调用了它')
  })

  it('keeps looking when the newest typed input has no text blocks', () => {
    // Blocks that are not text join to the empty string; that is not user input, so the walk continues
    // to the earlier message instead of returning "" and silencing the reminder.
    const empty = { role: 'user', source: { kind: 'user' }, content: [{ type: 'image' }] }
    expect(lastStructureUserText([userMessage('谁调用了它'), empty])).toBe('谁调用了它')
  })
})

describe('buildStructureHint', () => {
  it('is a user-role notice that a later step can tell apart', () => {
    const hint = buildStructureHint()
    expect(hint.role).toBe('user')
    expect(hint.source.kind).toBe(STRUCTURE_HINT_SOURCE_KIND)
    expect(hint.source.form).toBe('notice')
    expect(hint.content[0]?.text).toContain('codegraph')
  })
})

describe('the pre-step hook', () => {
  it('appends one reminder when the user asks a structural question', async () => {
    const { listener } = mountOneAgent()

    const decision = await enter(listener, [userMessage('这个函数在哪定义的')])

    expect(decision.kind).toBe('enter')
    expect(decision.messages).toHaveLength(2)
    expect((decision.messages[1] as StructureHintMessage).source.kind).toBe(STRUCTURE_HINT_SOURCE_KIND)
  })

  it('says nothing for an ordinary request', async () => {
    const { listener } = mountOneAgent()

    const decision = await enter(listener, [userMessage('把这个按钮改成蓝色')])

    expect(decision.messages).toHaveLength(1)
  })

  it('reminds at most once per conversation', async () => {
    const { listener } = mountOneAgent()

    const first = await enter(listener, [userMessage('谁调用了它')])
    expect(first.messages).toHaveLength(2)

    const second = await enter(listener, [userMessage('改这个会影响哪些地方')])
    expect(second.messages).toHaveLength(1)
  })

  it('stays quiet once the conversation has used the tool', async () => {
    const { listener, state } = mountOneAgent()
    noteStructureToolUse(state, { agent: { id: 'agent-1' } })

    const decision = await enter(listener, [userMessage('这个函数在哪定义的')])

    expect(decision.messages).toHaveLength(1)
  })

  it('passes a rejected step through untouched', async () => {
    const { listener } = mountOneAgent()

    const decision = await listener({ agent: { id: 'agent-1' }, messages: [userMessage('谁调用')] }, async () => ({
      kind: 'reject',
      messages: [],
    }))

    expect(decision).toEqual({ kind: 'reject', messages: [] })
  })

  it('keeps conversations apart', async () => {
    const { ctx, created } = fakeContext()
    const state = createStructureHintState()
    registerStructureHint(ctx, state)
    const a = fakeAgentScope()
    const b = fakeAgentScope()
    for (const listener of created) {
      listener({ agent: { id: 'agent-a', ctx: a.scope } })
      listener({ agent: { id: 'agent-b', ctx: b.scope } })
    }

    // One conversation uses the tool; the other one must still be reminded.
    noteStructureToolUse(state, { agent: { id: 'agent-a' } })

    const decisionA = await (a.listeners[0] as PreStepListener)(
      { agent: { id: 'agent-a' }, messages: [userMessage('谁调用')] },
      async () => ({ kind: 'enter', messages: [userMessage('谁调用')] }),
    )
    const decisionB = await (b.listeners[0] as PreStepListener)(
      { agent: { id: 'agent-b' }, messages: [userMessage('谁调用')] },
      async () => ({ kind: 'enter', messages: [userMessage('谁调用')] }),
    )

    expect(decisionA.messages).toHaveLength(1)
    expect(decisionB.messages).toHaveLength(2)
  })

  it('ignores an agent created without a scope to hook onto', () => {
    const { ctx, created } = fakeContext()
    registerStructureHint(ctx, createStructureHintState())

    // A payload the host's own registry would never build, but a listener on a shared event must
    // tolerate: an agent with no per-agent context has no `agent/pre-step` waterfall to join.
    expect(() => {
      for (const listener of created) listener({ agent: {} })
    }).not.toThrow()
  })

  it('keys a conversation without an id under one fallback identity', async () => {
    const { ctx, created } = fakeContext()
    const state = createStructureHintState()
    registerStructureHint(ctx, state)
    const { scope, listeners } = fakeAgentScope()
    for (const listener of created) listener({ agent: { ctx: scope } })
    const listener = listeners[0] as PreStepListener

    // No `id` means the agent cannot be told apart from another one, so the reminder's per-conversation
    // dedupe keys on the fallback rather than skipping it — one reminder per hooked step, still.
    const first = await enter(listener, [userMessage('谁调用了它')])
    expect(first.messages).toHaveLength(2)
    const second = await enter(listener, [userMessage('改这个会影响哪些地方')])
    expect(second.messages).toHaveLength(1)
  })

  it('covers the vocabulary the reminder is built on', () => {
    // Guard against an accidental empty table: an entry that matches nothing would silently disable
    // the whole hook.
    expect(STRUCTURE_QUESTION_TERMS.length).toBeGreaterThan(5)
  })
})
