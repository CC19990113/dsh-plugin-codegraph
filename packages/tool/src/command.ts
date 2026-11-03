/**
 * The human `/codegraph` slash command.
 *
 * The model-facing tools answer the same questions, but a person at the composer should not have to
 * spend a model turn asking "is this workspace indexed?". This command runs directly against
 * `ctx.codegraph` in the UI's command plane: nothing it returns becomes a model message or a token.
 *
 * Registered through conditional injection (`ctx.inject(['commands'], …)`) for the same reason the
 * panel routes are: the command registry is a host composition choice, and its absence must not hide
 * the tools this plugin also registers. `@deepseek-ai/dsh-commands` is deliberately not imported —
 * the service may be absent, so its public shape is mirrored structurally here.
 * @module dsh-plugin-codegraph-tool/command
 */

import type { Context } from '@deepseek-ai/cordis'
import type { CodegraphStatusResult } from 'dsh-plugin-codegraph-service'
import { formatIndexedAt, workspaceOf } from './status-hint.ts'
import { recordCommandRun } from './command-log.ts'
import { agentIdOf } from './status-hint.ts'

/** Command name, without the leading slash. */
export const COMMAND_NAME = 'codegraph'

/** One-line discovery copy the UI shows in its command list. */
export const COMMAND_DESCRIPTION = '查看或重建当前会话工作区的代码图谱索引'

/** Input syntax the UI shows after the command name. */
export const COMMAND_INPUT_HINT = '[status|index|files <pattern>]'

/** The usage line every rejection repeats, so one screen never offers half an answer. */
export const COMMAND_USAGE = `用法：/${COMMAND_NAME} ${COMMAND_INPUT_HINT}`

/** Files `files` lists at most: one screenful, not the whole index. */
const MAX_COMMAND_FILES = 10

/**
 * Branded identity of this definition, mirroring `CommandDefinitionId` from
 * `@deepseek-ai/dsh-commands/brand` without importing it.
 *
 * The registry treats the value as an opaque string; the local brand only keeps a plain string from
 * being passed where a stable definition identity is meant.
 */
export type CommandDefinitionId = string & { readonly __commandDefinitionId: 'CommandDefinitionId' }

/** Brand one plugin-namespaced command identity. */
function commandDefinitionId(value: string): CommandDefinitionId {
  return value as CommandDefinitionId
}

/** Stable identity, independent of the display name or the UI's per-run id. */
export const COMMAND_DEFINITION_ID = commandDefinitionId('dsh-plugin-codegraph/command/codegraph')

/** What a handler settles with; mirrors the registry's `success | error` result. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/**
 * The invocation face a command handler receives, declared structurally — only the members this
 * command reads.
 */
export interface CommandInvocation {
  /** Everything after the command name, including its leading separator whitespace. */
  readonly rawInput: string
  /** The receiving agent: its id keys the prompt's command memory, its session names the workspace. */
  readonly agent?: {
    readonly id?: unknown
    readonly session?: { readonly header?: { readonly cwd?: unknown } }
  }
  /** UI request cancellation, forwarded to every graph call. */
  readonly signal?: AbortSignal
}

/** One command registration, as the registry's `register` takes it. */
export interface CommandDefinition {
  /** Stable plugin-namespaced identity. */
  readonly definitionId: CommandDefinitionId
  /** Lowercase command name, without the slash. */
  readonly name: string
  /** Discovery copy, shown in the UI's command list. */
  readonly description: string
  /** Input syntax shown after the name. */
  readonly input: { readonly hint: string }
  /**
   * Run the command against the receiving agent's workspace.
   * @param invocation - the accepted command line and its context.
   * @returns the settled result the UI renders.
   */
  readonly handler: (invocation: CommandInvocation) => CommandResult | Promise<CommandResult>
}

/** The command registry's registration surface, declared structurally. */
export interface CommandRegistry {
  /**
   * Register one command definition.
   * @param definition - discovery metadata and handler.
   * @returns the disposer unregistering it.
   */
  register(definition: CommandDefinition): () => void
}

/**
 * Register the `/codegraph` command when the host composition provides a command registry.
 * @param ctx - the plugin context (must carry `codegraph`; `commands` is optional).
 */
export function registerCommands(ctx: Context): void {
  try {
    ctx.inject(['commands'], child => {
      const commands = (child as Context & { commands: CommandRegistry }).commands
      child.effect(
        () => commands.register({
          definitionId: COMMAND_DEFINITION_ID,
          name: COMMAND_NAME,
          description: COMMAND_DESCRIPTION,
          input: { hint: COMMAND_INPUT_HINT },
          handler: invocation => runCommand(ctx, invocation),
        }),
        'codegraph: slash command',
      )
    })
  } catch (error) {
    console.warn('[codegraph] commands service unavailable; /codegraph is not registered:', error)
  }
}

/**
 * Parse and dispatch one invocation.
 *
 * A handler that throws makes the registry settle the command as an error from the thrown value
 * instead of from a result, so every expected failure is returned as `kind: 'error'` here; only a
 * defect escapes, and it still surfaces as the command's error.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param invocation - the accepted command line and its context.
 * @returns the settled result.
 */
async function runCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const result = await dispatchCommand(ctx, invocation)
  // Remember the outcome for the prompt: the host logs a command but never projects it into the
  // model's messages, and the model is the next reader that cares (did the graph just change? did
  // the user already see an answer it cannot?). Recording here rather than inside each subcommand
  // keeps the four return paths from drifting.
  recordCommandRun(agentIdOf(invocation) ?? '', {
    input: invocation.rawInput.trim(),
    /* v8 ignore next -- every subcommand above returns a `text`; the fallback is the type's, not a path. */
    text: result.text ?? '',
    ok: result.kind === 'success',
    at: Date.now(),
  })
  return result
}

/**
 * Execute one parsed invocation, without recording it.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param invocation - the accepted command line and its context.
 * @returns the settled result.
 */
async function dispatchCommand(ctx: Context, invocation: CommandInvocation): Promise<CommandResult> {
  const root = workspaceOf(invocation)
  if (root === undefined) {
    return { kind: 'error', text: '这个命令需要会话工作区：请在一个绑定了工作区的会话里运行' }
  }
  const trimmed = invocation.rawInput.trim()
  // The registry keeps the separator whitespace in `rawInput`, so a bare `/codegraph` arrives as an
  // empty string (or spaces) and must still mean `status`.
  const [subcommand = 'status', ...rest] = trimmed === '' ? [] : trimmed.split(/\s+/u)
  try {
    switch (subcommand) {
      case 'status':
        return await statusCommand(ctx, root, invocation.signal)
      case 'index':
        return await indexCommand(ctx, root, invocation.signal)
      case 'files':
        return await filesCommand(ctx, root, rest.join(' '), invocation.signal)
      default:
        return { kind: 'error', text: `未知的子命令 "${subcommand}"。${COMMAND_USAGE}` }
    }
  } catch (error) {
    return { kind: 'error', text: String(error) }
  }
}

/**
 * Report the workspace's index at a glance.
 *
 * `available` is asked first so "no index yet" is a helpful answer rather than the seam's
 * `CODEGRAPH_UNAVAILABLE` failure — the same distinction the `status` tool operation makes.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param root - the session workspace root.
 * @param signal - stops the check and the query.
 * @returns one status line, or how to build the missing index.
 */
async function statusCommand(ctx: Context, root: string, signal?: AbortSignal): Promise<CommandResult> {
  if (!(await ctx.codegraph.available(root, signal))) {
    return { kind: 'success', text: `这个工作区还没有索引：${root}。先跑 /${COMMAND_NAME} index` }
  }
  const result = await ctx.codegraph.query({ operation: 'status', projectRoot: root }, signal)
  return { kind: 'success', text: statusLine(result) }
}

/**
 * One line naming the index's size and the moment its summary was written.
 * @param result - the seam's status answer.
 * @returns the rendered line.
 */
function statusLine(result: CodegraphStatusResult): string {
  const built = result.indexedAt === null ? '尚未记录索引时间' : formatIndexedAt(result.indexedAt)
  return `已索引：${result.fileCount} 文件 / ${result.nodeCount} 声明 / ${result.edgeCount} 关系（${built}）`
}

/**
 * Build or refresh the workspace's index right now.
 *
 * Unlike the model-facing tool this never moves to a background job: a human ran a command and is
 * waiting for its answer, and the command plane has no `job_output` equivalent to read later.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param root - the session workspace root.
 * @param signal - stops the run.
 * @returns the completed run's summary line.
 */
async function indexCommand(ctx: Context, root: string, signal?: AbortSignal): Promise<CommandResult> {
  const report = await ctx.codegraph.index(root, signal)
  return { kind: 'success', text: `已重建：${report.filesIndexed} 文件 / ${report.nodeCount} 符号` }
}

/**
 * List indexed files matching a pattern, capped at one screenful.
 * @param ctx - the plugin context carrying `codegraph`.
 * @param root - the session workspace root.
 * @param pattern - the caller's pattern; may be a substring or glob, as the store defines it.
 * @param signal - stops the query.
 * @returns the matching files, or why the request is unusable.
 */
async function filesCommand(
  ctx: Context,
  root: string,
  pattern: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  if (pattern === '') return { kind: 'error', text: `files 需要一个 pattern。${COMMAND_USAGE}` }
  const result = await ctx.codegraph.query(
    { operation: 'files', projectRoot: root, pattern, limit: MAX_COMMAND_FILES },
    signal,
  )
  if (result.files.length === 0) {
    return { kind: 'success', text: `没有匹配 ${pattern} 的已索引文件` }
  }
  const lines = result.files.map(file => `${file.path}  ${file.language}  ${file.nodeCount} 声明`)
  return {
    kind: 'success',
    text: `匹配 ${pattern} 的已索引文件（显示 ${result.files.length} / ${result.total}）：\n${lines.join('\n')}`,
  }
}
