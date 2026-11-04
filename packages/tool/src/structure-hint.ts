/**
 * The "this is a structural code question, use the graph first" reminder.
 *
 * Same reasoning as the session index's history reminder, applied to code: the system prompt already
 * says the graph is more precise than text search, but a repository-wide `grep` is the reflex, and a
 * grep result conflates declarations with the comments, strings and same-named symbols around them.
 * This module nudges at the one moment it matters — right before a model request whose user input
 * asks where something is declared, who calls it, or what a change would reach.
 *
 * Three rules keep it from becoming noise:
 *
 * - **Only a genuine user input can trigger it.** Injected context, tool results and notices from
 *   other plugins carry the user role too; matching their text would let the reminder trigger itself.
 *   Only a message whose `source.kind` is `user` is read.
 * - **Once per conversation, and never after the tool was used.** A conversation that already called
 *   `codegraph` has demonstrated it knows the tool.
 * - **It rides the admission waterfall, never blocks it.** The listener answers only after `next()`
 *   resolved, appends to a batch that is already being sent, and returns a rejected decision
 *   untouched.
 * @module dsh-plugin-codegraph-tool/structure-hint
 */

import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import { agentIdOf } from './status-hint.ts'

/** `source.kind` of the reminder message, so a later step can tell it apart from real user input. */
export const STRUCTURE_HINT_SOURCE_KIND = 'codegraph-hint'

/**
 * Words that make a question about where code lives or what reaches it. Matched as substrings
 * against the user's own text.
 *
 * Deliberately broad for the same reason the session index's list is: a false positive costs one
 * short sentence once per conversation, while a miss sends the model to grep a repository for a name
 * that also appears in comments and strings.
 */
export const STRUCTURE_QUESTION_TERMS: readonly string[] = [
  '在哪定义',
  '定义在',
  '声明在',
  '谁调用',
  '调用谁',
  '调用链',
  '调用方',
  '被谁引用',
  '被引用',
  '引用了哪些',
  '影响面',
  '会影响',
  '改这个会',
  '哪些地方用',
  '哪里用到',
  '哪个文件',
  'where is',
  'who calls',
  'callers of',
  'callees of',
]

/**
 * A message-shaped reminder, structurally identical to what `dsh-llm`'s `createUserMessage` builds.
 *
 * Built as a plain object rather than through `@deepseek-ai/dsh-llm`: that package moves exports
 * between minor releases, and a static import of a symbol that later moves takes the whole plugin out
 * of the host. Four lines of local typing do not.
 */
export interface StructureHintMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly { readonly type: 'text'; readonly text: string }[]
  readonly source: {
    readonly kind: string
    readonly form: 'notice'
    readonly summary: string
  }
}

/** The reminder text. One short paragraph: it is read by a model that already has the system prompt. */
export const STRUCTURE_HINT_TEXT =
  '[代码图谱提醒] 这是结构性代码问题。先用 codegraph 查索引而不是直接 grep：search 找声明、'
  + 'node 看调用方与被调用方、impact 看改动影响范围、trace 看两点之间的调用链；'
  + '工作区还没建索引时先调 codegraph_index。'

/**
 * The per-conversation bookkeeping a {@link registerStructureHint} listener keeps.
 *
 * Shared between the pre-step hook and the tools on purpose: the tool reports that a conversation has
 * already reached the graph, which is what turns the reminder off for the rest of it.
 */
export interface StructureHintState {
  /** Agents that already called the `codegraph` tool. */
  readonly usedBy: Set<string>
  /** Agents that already received the reminder. */
  readonly hintedTo: Set<string>
}

/** A fresh state object; one per plugin registration. */
export function createStructureHintState(): StructureHintState {
  return { usedBy: new Set(), hintedTo: new Set() }
}

/**
 * Record that a conversation already reached the graph, which disables the reminder for it.
 * @param state - the per-registration bookkeeping.
 * @param context - the tool execution (or any record carrying `agent.id`).
 */
export function noteStructureToolUse(state: StructureHintState, context: unknown): void {
  const agentId = agentIdOf(context)
  if (agentId !== undefined) state.usedBy.add(agentId)
}

/**
 * Whether one piece of user text reads as a structural code question.
 * @param text - the user's own words (never injected context).
 * @returns true when any {@link STRUCTURE_QUESTION_TERMS} appears in it.
 */
export function looksLikeStructureQuestion(text: string): boolean {
  const haystack = text.toLowerCase()
  return STRUCTURE_QUESTION_TERMS.some(term => haystack.includes(term.toLowerCase()))
}

/** Minimal structural read of a message the host put in the admission batch. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

/**
 * The text of the last message the user actually typed in this batch.
 *
 * Only `role: 'user'` with `source.kind: 'user'` counts. Everything else that can carry the user role
 * — recall blocks, job notices, time context, this module's own reminder — is excluded, because
 * matching against injected text is how a reminder ends up triggering itself.
 * @param messages - the batch the host is about to send.
 * @returns the typed text, or undefined when this batch has none.
 */
export function lastStructureUserText(messages: readonly unknown[] | undefined): string | undefined {
  if (!Array.isArray(messages)) return undefined
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (!isRecord(message) || message.role !== 'user') continue
    const source = message.source
    if (!isRecord(source) || source.kind !== 'user') continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((part): part is { type: string; text: string } =>
        isRecord(part) && part.type === 'text' && typeof part.text === 'string')
      .map(part => part.text)
      .join('\n')
      .trim()
    if (text !== '') return text
  }
  return undefined
}

/**
 * Build the reminder message.
 * @returns a message-shaped reminder with its own id.
 */
export function buildStructureHint(): StructureHintMessage {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: STRUCTURE_HINT_TEXT }],
    source: {
      kind: STRUCTURE_HINT_SOURCE_KIND,
      form: 'notice',
      summary: 'codegraph: 结构性问题先查代码图谱',
    },
  }
}

/** The agent lifecycle surface this module listens to; declared locally rather than imported. */
interface AgentLifecycleContext {
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/** The `agent/created` payload: the agent and the scoped context its own hooks live on. */
interface AgentCreatedPayload {
  readonly agent?: {
    readonly id?: unknown
    readonly ctx?: AgentScopedContext
  }
}

/** The per-agent context, whose `agent/pre-step` waterfall runs before every model request. */
interface AgentScopedContext {
  on(
    name: 'agent/pre-step',
    listener: (payload: AgentPreStepPayload, next: () => Promise<AgentPreStepDecision>) => Promise<AgentPreStepDecision>,
  ): () => boolean
}

/** What the host passes into the waterfall; the batch is read, the agent identifies the memory. */
interface AgentPreStepPayload {
  readonly agent?: { readonly id?: unknown }
  readonly messages?: readonly unknown[]
  readonly signal?: AbortSignal
}

/**
 * The admitted-step decision. `reject` carries no messages and must be passed through untouched;
 * `enter` carries the batch that will be sent, which this module appends to.
 */
interface AgentPreStepDecision {
  readonly kind: string
  readonly messages: readonly unknown[]
}

/**
 * Append the structural-question reminder to the next admitted step, once per conversation.
 * @param ctx - the plugin context.
 * @param state - the per-registration bookkeeping shared with the tools.
 */
export function registerStructureHint(ctx: Context, state: StructureHintState): void {
  const events = ctx as unknown as AgentLifecycleContext
  // Inside an effect so the subscription follows the plugin's own lifetime.
  ctx.effect(() => events.on('agent/created', payload => {
    const agentCtx = payload.agent?.ctx
    if (agentCtx === undefined) return
    const agentId = agentIdOf(payload)
    agentCtx.on('agent/pre-step', async (stepPayload, next) => {
      const decision = await next()
      // A rejected step sends nothing, so there is no batch to put a reminder into.
      if (decision.kind !== 'enter') return decision
      const text = lastStructureUserText(stepPayload.messages)
      if (text === undefined || !looksLikeStructureQuestion(text)) return decision
      const key = agentId ?? 'unknown-agent'
      if (state.usedBy.has(key) || state.hintedTo.has(key)) return decision
      state.hintedTo.add(key)
      return { ...decision, messages: [...decision.messages, buildStructureHint()] }
    })
  }))
}
