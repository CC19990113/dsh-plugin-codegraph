/**
 * Model-facing `codegraph` tool family over `ctx.codegraph` and `ctx.fs`. The `codegraph` tool is
 * read-only, with ten operations: the eight the seam answers directly, plus `explore` and `context`,
 * which compose graph queries with source reads because a graph store returns positions and cannot
 * reach a workspace's bytes. A second tool, `codegraph_index`, builds or refreshes the graph on
 * explicit request; it is separate so it can carry its own, much larger timeout budget than a query
 * — `defineTool`'s `timeoutMs` is fixed per registration, not per call, so one operation cannot borrow
 * a bigger budget from within a shared tool.
 *
 * The tools own every default the seam refuses to guess — result limits, traversal depth, source
 * caps — so the seam's requests stay fully specified and a deployment can retune the model's answer
 * size without touching a store. They runtime-inject only `tools`, `codegraph`, `fs`, and
 * `systemPrompt`, and import no store. The Settings panel's HTTP routes (`./panel.ts`) and the human
 * `/codegraph` command (`./command.ts`) attach through conditional injection instead, so a host
 * without a web server or a command registry still gets the whole tool family.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-plugin-codegraph-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { assertNever, CodegraphError } from 'dsh-plugin-codegraph-service'
import type { CodegraphIndexReport, CodegraphNode, CodegraphRelation } from 'dsh-plugin-codegraph-service'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { registerCommands } from './command.ts'
import { declarationsOnly, groupByFile, mergeByHits, mergeRelations, taskTerms } from './compose.ts'
import type { FileGroup } from './compose.ts'
import { registerPanelRoutes } from './panel.ts'
import { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
import type { ProjectionLimits, SymbolView } from './projection.ts'
import { renderCodegraph } from './render.ts'
import { CODEGRAPH_INDEX_PARAMETERS, CODEGRAPH_OUTPUT_SCHEMA, CODEGRAPH_PARAMETERS } from './schema.ts'
import type { CodegraphIndexToolArgs, CodegraphToolArgs, CodegraphToolValue, CodegraphValueFor } from './schema.ts'
import { readSlice } from './source.ts'
import type { SourceLimits } from './source.ts'
import { agentIdOf, indexStatusHint, readIndexFailureFile, readIndexStatus, readWatchState, workspaceOf } from './status-hint.ts'
import { createStructureHintState, noteStructureToolUse, registerStructureHint } from './structure-hint.ts'
import { commandRunHint } from './command-log.ts'
import { createUpdateChecker, defaultStateFile, DEFAULT_UPDATE_CHECK_INTERVAL_MS, readOwnVersion } from './version-check.ts'
import type { UpdateChecker } from './version-check.ts'

export {
  CODEGRAPH_INDEX_PARAMETERS,
  CODEGRAPH_OPERATIONS,
  CODEGRAPH_OUTPUT_SCHEMA,
  CODEGRAPH_PARAMETERS,
  type CodegraphIndexToolArgs,
  type CodegraphToolArgs,
  type CodegraphToolOperation,
  type CodegraphToolValue,
  type CodegraphValueFor,
} from './schema.ts'
export { COMMAND_DEFINITION_ID, COMMAND_DESCRIPTION, COMMAND_INPUT_HINT, COMMAND_NAME, COMMAND_USAGE, registerCommands } from './command.ts'
export type { CommandDefinition, CommandDefinitionId, CommandInvocation, CommandRegistry, CommandResult } from './command.ts'
export { declarationsOnly, groupByFile, mergeByHits, mergeRelations, taskTerms } from './compose.ts'
export { PANEL_ROUTE_PREFIX, registerPanelRoutes } from './panel.ts'
export type {
  PanelConfig,
  PanelErrorResponse,
  PanelReindexResponse,
  PanelRequest,
  PanelResponse,
  PanelRoute,
  PanelStateResponse,
  PanelWebServer,
} from './panel.ts'
export { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
export { renderCodegraph } from './render.ts'
export { readSlice } from './source.ts'
export { formatIndexedAt, indexStatusHint, readIndexStatus, readWatchState, watchStateHint, workspaceOf } from './status-hint.ts'
export { clearCommandRuns, commandRunHint, COMMAND_LOG_WINDOW_MS, recentCommandRun, recordCommandRun } from './command-log.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codegraph'

/** The npm package this code ships as; the registry is asked about this name's own releases. */
export const PACKAGE_NAME = 'dsh-plugin-codegraph'

/** Services required by this plugin. */
export const inject = ['tools', 'codegraph', 'fs', 'systemPrompt']

/** Default tool-call timeout budget (ms) for the query-side `codegraph` tool. */
export const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Default timeout budget (ms) for the `codegraph_index` tool. Indexing a monorepo is a different order of work than a query. */
export const DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS = 300_000

/**
 * Files a workspace's last index must have covered before `backgroundIndex: 'auto'` hands the next run
 * to a background job. A thousand files is roughly the point where a full parse stops fitting in a
 * single tool call's timeout, which is the only reason the job exists.
 */
export const DEFAULT_BACKGROUND_INDEX_THRESHOLD = 1000

/** The stable system-prompt guidance positioning the code graph against search and read. */
export const CODEGRAPH_PROMPT_TEXT =
  'Use codegraph for structural questions about code: where a symbol is declared, what calls it, what it calls, what a change to it reaches, and how one symbol reaches another. It answers from a pre-built index, so it is both faster and more precise than grepping for a name, which also matches comments, strings, and unrelated identifiers. Use search/read instead for literal text, and when codegraph reports no index for a workspace. When status reports no index, call codegraph_index once to build one — it runs on its own, longer timeout budget than a query. In a large workspace that run becomes a background job instead of blocking: the call returns a job id, and job_output reads its report. Re-indexing reuses the previous parse for every file that did not change, so repeating it after an edit is cheap. Results reflect the last time the workspace was indexed; a declaration added since then is absent.'

/** Plugin configuration: the defaults and caps the seam requires the consumer to own. */
export interface Config {
  /** Results returned when the model names no `limit` (default 20). */
  defaultLimit?: number
  /** Largest `limit` honored, whatever the model asks for (default 200). */
  maxLimit?: number
  /** Hops traversed by `impact` and `trace` when the model names no `depth` (default 2). */
  defaultDepth?: number
  /** Largest `depth` honored (default 6). */
  maxDepth?: number
  /** Distinct paths `trace` returns (default 5). */
  maxPaths?: number
  /** Files whose source `explore` and `context` return (default 5). */
  maxSourceFiles?: number
  /** Lines of source carried per file (default 200). */
  maxSourceLines?: number
  /** Characters of source carried per file (default 8000). */
  maxSourceChars?: number
  /** Characters of documentation carried per symbol (default 400). */
  maxDocstringChars?: number
  /** Characters of signature carried per symbol (default 200). */
  maxSignatureChars?: number
  /** Search terms extracted from a `context` task description (default 6). */
  maxContextTerms?: number
  /**
   * Chinese task words the built-in table does not cover, mapped to the English identifiers to search
   * for instead. Readings are added after the built-in ones, so a custom entry can only widen what a
   * task matches (default empty).
   */
  contextSynonyms?: Record<string, readonly string[]>
  /** Tool-call timeout budget in ms for the query-side `codegraph` tool (default 30000). */
  timeoutMs?: number
  /** Tool-call timeout budget in ms for the `codegraph_index` tool (default 300000). */
  indexTimeoutMs?: number
  /**
   * Whether an indexing run moves to the host's background-job registry: `'auto'` (default) decides by
   * the workspace's last indexed file count, `true` always uses a job when the host offers one, and
   * `false` always runs synchronously inside the tool call.
   */
  backgroundIndex?: 'auto' | boolean
  /** Files the last index must have covered before `'auto'` uses a job (default 1000). */
  backgroundIndexThreshold?: number
  /**
   * Whether to register the Settings panel's HTTP routes and the `/codegraph` command (default true).
   * Both are optional host surfaces: a composition without a web server or a command registry skips
   * them whatever this says, and turning this off is for deployments that want the model-facing tools
   * only.
   */
  panel?: boolean
  /**
   * Whether to ask the registry for a newer release after this plugin's tools are used, and append one
   * notice to the next step when there is one (default true). The notice is a user-role message, so it
   * reaches the model and the user both; it is emitted once per release and never blocks a tool call.
   * Turn this off in an offline or air-gapped deployment, where the check can only time out.
   */
  updateCheck?: boolean
  /**
   * Milliseconds a completed check stays trusted before the next one may start (default six hours).
   * Shorter intervals mean a notice lands sooner after a release; the request itself is one small
   * registry GET, so the cost of a shorter interval is latency nobody waits on, not tokens.
   */
  updateCheckIntervalMs?: number
  /**
   * Append one reminder to the model request whose user input reads as a structural code question,
   * when that conversation has not queried the graph yet (default true). The system prompt already
   * says the graph is more precise than text search; this is the moment-of-use nudge for a model that
   * would otherwise grep a repository. Once per conversation, never after the tool itself ran.
   */
  structureHint?: boolean
}

export const Config: z<Config> = z.object({
  defaultLimit: z.number().default(20),
  maxLimit: z.number().default(200),
  defaultDepth: z.number().default(2),
  maxDepth: z.number().default(6),
  maxPaths: z.number().default(5),
  maxSourceFiles: z.number().default(5),
  maxSourceLines: z.number().default(200),
  maxSourceChars: z.number().default(8000),
  maxDocstringChars: z.number().default(400),
  maxSignatureChars: z.number().default(200),
  maxContextTerms: z.number().default(6),
  // `dict` types its *input* as mutable arrays while the `Config` field it backs accepts read-only
  // ones; the two differ in a modifier only, so the runtime shape — and the validation — is unchanged.
  contextSynonyms: z.dict(z.array(z.string())).default({}) as z<Record<string, readonly string[]>>,
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS),
  indexTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS),
  backgroundIndex: z.union([z.const('auto'), z.boolean()]).default('auto'),
  backgroundIndexThreshold: z.number().default(DEFAULT_BACKGROUND_INDEX_THRESHOLD),
  panel: z.boolean().default(true),
  updateCheck: z.boolean().default(true),
  updateCheckIntervalMs: z.number().default(DEFAULT_UPDATE_CHECK_INTERVAL_MS),
  structureHint: z.boolean().default(true),
})

type ResolvedConfig = Required<Config>

/**
 * The project root a call runs against: the model's explicit `project_path`, else the calling
 * agent's session workspace. There is no process-cwd fallback — a graph query that silently answered
 * about a different checkout than the session is working in would be wrong in a way the model cannot
 * detect.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the absolute project root.
 */
export function projectRoot(args: CodegraphToolArgs, exec: ToolExecution): string {
  return resolvedProjectRoot(args.project_path, exec)
}

/**
 * Shared root-resolution logic behind {@link projectRoot} and the index tool's own argument shape.
 * @param explicit - the model's `project_path`, if given.
 * @param exec - the tool-execution context; only its optional `agent` is read.
 * @returns the absolute project root.
 */
function resolvedProjectRoot(explicit: string | undefined, exec: ToolExecution): string {
  if (explicit !== undefined && explicit.trim() !== '') return explicit
  const sessionCwd = exec.agent?.session.header.cwd
  if (sessionCwd === undefined) {
    throw new CodegraphError(
      'the codegraph tool requires a session workspace or an explicit project_path',
      'CODEGRAPH_WORKSPACE_REQUIRED',
    )
  }
  return sessionCwd
}

/** Read a required string argument, rejecting an absent or blank value. */
function required(args: CodegraphToolArgs, field: 'symbol' | 'query' | 'task' | 'from' | 'to'): string {
  const value = args[field]
  if (value === undefined || value.trim() === '') {
    throw new CodegraphError(
      `the codegraph "${args.operation}" operation requires a non-empty "${field}"`,
      'CODEGRAPH_INVALID_REQUEST',
    )
  }
  return value
}

/** Clamp a model-supplied bound into the configured range. */
function bounded(value: number | undefined, fallback: number, max: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.trunc(value)))
}

/**
 * Register the `codegraph` tool and its system-prompt guidance.
 * @param ctx - the plugin context (must inject `tools`, `codegraph`, `fs`, `systemPrompt`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  for (const field of [
    'defaultLimit', 'maxLimit', 'defaultDepth', 'maxDepth', 'maxPaths', 'maxSourceFiles',
    'maxSourceLines', 'maxSourceChars', 'maxDocstringChars', 'maxSignatureChars', 'maxContextTerms',
  ] as const) {
    assertPositiveInteger(field, resolved[field])
  }
  assertTimer('timeoutMs', resolved.timeoutMs)
  assertTimer('indexTimeoutMs', resolved.indexTimeoutMs)
  assertPositiveInteger('backgroundIndexThreshold', resolved.backgroundIndexThreshold)

  // Version checking is a convenience, never a dependency: turned off, or with an unreachable
  // registry, the tools above behave exactly as before. It only ever speaks after one of them ran —
  // see `version-check.ts` for why that gate exists and what keeps it from repeating.
  const updateChecker = resolved.updateCheck
    ? createUpdateChecker({
        packageName: PACKAGE_NAME,
        currentVersion: readOwnVersion(),
        stateFile: defaultStateFile(PACKAGE_NAME),
        intervalMs: resolved.updateCheckIntervalMs,
      })
    : undefined

  // Shared between the tools and the pre-step hook: a conversation that already queried the graph
  // must not be told the graph exists. Kept even when the hint is off, so turning the reminder back
  // on mid-process cannot re-nag a conversation that has been using the tool all along.
  const structureHintState = createStructureHintState()

  // A function, not a string: the host re-evaluates it on every assembly, which is what lets the model
  // learn the workspace's index size and freshness for free instead of spending a `status` round-trip.
  ctx.systemPrompt.section({
    name: 'tool:codegraph',
    order: 111,
    // Three parts, each optional except the guidance itself: the static copy, the workspace's index
    // state, and — when the user just ran `/codegraph` — what they asked and what came back. The
    // command plane never reaches the model's messages, so this is the only place it can surface.
    text: assemblyContext => [
      CODEGRAPH_PROMPT_TEXT,
      indexStatusHint(workspaceOf(assemblyContext)),
      commandRunHint(agentIdOf(assemblyContext)),
    ].filter(part => part !== '').join('\n\n'),
  })

  ctx.tools.register(defineTool({
    name: 'codegraph',
    description:
      'Query a pre-built index of the workspace\'s declarations and their relationships. Find where a symbol is declared, what calls it, what it calls, what a change to it can affect, and how one symbol reaches another. More precise than text search: it matches declarations, not occurrences in comments or strings. Answers reflect the last time the workspace was indexed.',
    parameters: CODEGRAPH_PARAMETERS,
    output: {
      schema: CODEGRAPH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderCodegraph(value) }],
    },
    timeoutMs: resolved.timeoutMs,
    async execute(args, exec) {
      updateChecker?.noteToolUse(agentIdOf(exec))
      noteStructureToolUse(structureHintState, exec)
      return run(ctx, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: callTitle(args),
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'codegraph_index',
    description:
      'Build or refresh the codegraph index for a workspace, so the codegraph tool can answer. Indexing a large workspace can take minutes, so this runs on its own timeout budget, separate from codegraph\'s query operations. A large run may be handed to a background job and answer immediately with that job\'s id; read its report with job_output.',
    parameters: CODEGRAPH_INDEX_PARAMETERS,
    output: {
      schema: CODEGRAPH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderCodegraph(value) }],
    },
    timeoutMs: resolved.indexTimeoutMs,
    async execute(args, exec) {
      updateChecker?.noteToolUse(agentIdOf(exec))
      noteStructureToolUse(structureHintState, exec)
      return runIndex(ctx, resolved, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: args.project_path === undefined ? 'codegraph_index' : `codegraph_index ${args.project_path}`,
      kind: 'search' as const,
      rawInput: args,
    }),
  }))

  // Two optional host surfaces. Each registers through `ctx.inject([...])` inside its own module, so
  // a profile that runs no web server or no command registry simply never runs those callbacks — the
  // tools above stay registered either way.
  registerPanelRoutes(ctx, resolved)
  registerCommands(ctx)

  // The notice rides the host's step-admission waterfall: `agent/pre-step` is the one surface a
  // plugin has between a tool result and the next model request, and it is where the host itself
  // inserts its `[model changed: …]` notice. Registering it here (rather than at module scope) keeps
  // the listener tied to this plugin instance's lifetime.
  if (updateChecker !== undefined) registerUpdateNotice(ctx, updateChecker)

  // The structural reminder rides the same waterfall: `agent/pre-step` is the one surface between the
  // user's input and the next model request, which is where "this is a question about where code lives,
  // and a grep cannot tell a declaration from a comment" belongs.
  if (resolved.structureHint) registerStructureHint(ctx, structureHintState)
}

/**
 * Structural face of the agent lifecycle this plugin listens to.
 *
 * Declared locally, like `tree-sitter`'s `agent/created` face, rather than by importing the agent
 * package: this module needs two event names and two payload shapes, not the whole agent surface,
 * and a static import of a host symbol is exactly what took this plugin off the host once before.
 */
interface AgentLifecycleContext {
  on(name: 'agent/created', listener: (payload: AgentCreatedPayload) => void): () => boolean
}

/** The agent-created payload: the agent, and the scoped context its own hooks register on. */
interface AgentCreatedPayload {
  readonly agent?: {
    readonly id?: unknown
    /** The agent's scope. Registrations on it live and die with this agent. */
    readonly ctx?: AgentScopedContext
  }
}

/**
 * The per-agent context, whose `agent/pre-step` waterfall runs before every model request.
 *
 * `prepend` puts the listener first in the chain; the host's own `[model changed: …]` notice registers
 * the same way, which is why this shape is copied rather than invented.
 */
interface AgentScopedContext {
  on(
    name: 'agent/pre-step',
    listener: (payload: AgentPreStepPayload, next: () => Promise<AgentPreStepDecision>) => Promise<AgentPreStepDecision>,
    options?: { prepend?: boolean },
  ): () => boolean
}

/** What the host passes into the waterfall; only the agent identity is read here. */
interface AgentPreStepPayload {
  readonly agent?: { readonly id?: unknown }
  readonly signal?: AbortSignal
}

/**
 * The admitted-step decision. `reject` carries no messages and must be passed through untouched;
 * `enter` carries the batch that will be sent, which this plugin appends to.
 */
interface AgentPreStepDecision {
  readonly kind: string
  readonly messages: readonly unknown[]
}

/**
 * Append the "a newer release exists" notice to the next admitted step, once per release.
 *
 * Registered per agent rather than globally: the hook is agent-scoped in the host, its `next` only
 * means something inside that scope, and one registration per conversation is what keeps a notice
 * out of a session that never called the tool.
 * @param ctx - the plugin context.
 * @param checker - the shared checker the tool calls already report into.
 */
export function registerUpdateNotice(ctx: Context, checker: UpdateChecker): void {
  const events = ctx as unknown as AgentLifecycleContext
  // Registered inside this effect so the subscription follows the plugin's own lifetime: unloading
  // the plugin must stop future agents from calling into a checker that no longer exists.
  ctx.effect(() => events.on('agent/created', payload => {
    const agentCtx = payload.agent?.ctx
    if (agentCtx === undefined) return
    const agentId = agentIdOf(payload)
    agentCtx.on('agent/pre-step', async (_payload, next) => {
      const decision = await next()
      // A rejected step sends nothing, so there is no conversation to put a notice into.
      if (decision.kind !== 'enter') return decision
      const notice = checker.takeNotice(agentId)
      if (notice === undefined) return decision
      return { ...decision, messages: [...decision.messages, notice] }
    })
  }))
}

/**
 * The one-line label a pending call shows.
 * @param args - the validated tool arguments.
 * @returns the card title naming the operation and whichever subject the operation takes.
 */
export function callTitle(args: CodegraphToolArgs): string {
  const subject = args.symbol ?? args.query ?? args.task
    ?? (args.from === undefined ? undefined : `${args.from} → ${args.to ?? '?'}`)
    ?? args.pattern ?? args.path
  return subject === undefined ? `codegraph ${args.operation}` : `codegraph ${args.operation} ${subject}`
}

/**
 * Build or refresh the on-disk index for one project. The dedicated tool this backs carries its own,
 * much larger timeout budget than a query — indexing a monorepo is a different order of work.
 *
 * A run large enough to outlive the call moves to the host's background-job registry, where it keeps
 * its own timeout-free lifetime and reports through that job instead of this value. Everything that
 * cannot start a job — no registry in the composition, no owning agent, a workspace still small, a
 * refusal from the registry — falls through to the synchronous run, so the tool's answer never depends
 * on a host feature being present.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param args - the index tool's validated arguments.
 * @param exec - the tool-execution context.
 * @returns the index operation's canonical value: a started job, or the finished run's report.
 */
async function runIndex(
  ctx: Context,
  config: ResolvedConfig,
  args: CodegraphIndexToolArgs,
  exec: ToolExecution,
): Promise<CodegraphToolValue> {
  const root = resolvedProjectRoot(args.project_path, exec)
  const jobId = startBackgroundIndex(ctx, config, root, exec)
  if (jobId !== undefined) {
    return { operation: 'index', project_path: root, status: 'started', job_id: jobId }
  }
  const report = await ctx.codegraph.index(root, exec.signal)
  return indexReportValue(root, report)
}

/**
 * Hand one indexing run to the host's background-job registry, when the host offers one and the run
 * looks large enough to outlive the call.
 *
 * Every reason not to start a job falls back to the synchronous run rather than failing the call: a
 * composition without a job controller is a normal deployment, not an error, and the tool's contract
 * has always been "index it now".
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param root - the project root to index.
 * @param exec - the tool-execution context; its agent owns the job.
 * @returns the started job's id, or `undefined` when this call must index synchronously.
 */
function startBackgroundIndex(
  ctx: Context,
  config: ResolvedConfig,
  root: string,
  exec: ToolExecution,
): string | undefined {
  const owner = exec.agent
  if (owner === undefined) return undefined
  // `ctx.get` rather than an `inject` entry: `jobs` is a host composition choice, and requiring it in
  // `inject` would hide this entire tool family from a profile that runs no background jobs. Reading
  // the service optionally is what lets one build serve both kinds of deployment.
  const jobs = ctx.get('jobs') as BackgroundJobRegistry | undefined
  if (jobs === undefined) return undefined
  // Asked last, so a composition without a registry never pays for the status read below.
  if (!backgroundRunWanted(config, root)) return undefined
  try {
    return jobs.start({
      // The registry keys a job by its owning *session id*, not the agent object: it resolves the live
      // agent from that id and hangs the job's teardown (and therefore its cancellation) off it.
      owner: owner.id,
      kind: 'codegraph-index',
      label: `codegraph index ${root}`,
      run: handle => runIndexJob(ctx, root, handle),
    })
  } catch {
    // No controller serves this agent, or the owner already holds its maximum number of jobs: both
    // mean "do the work here instead", never "fail the model's call".
    return undefined
  }
}

/**
 * Whether this run is large enough — or configured — to belong in a background job.
 *
 * `'auto'` reads the previous run's file count from the status sidecar, which is the only size signal
 * available before a run starts and exactly the case a job exists for: a refresh of the workspace that
 * took minutes last time. A workspace with no summary has never been indexed by this plugin, so there
 * is no evidence it is large; it runs synchronously and writes the summary the next call decides from.
 * @param config - the resolved plugin configuration.
 * @param root - the project root to index.
 * @returns whether the caller should try to start a job.
 */
function backgroundRunWanted(config: ResolvedConfig, root: string): boolean {
  if (config.backgroundIndex === false) return false
  if (config.backgroundIndex === true) return true
  const status = readIndexStatus(root)
  return status !== undefined && status.filesIndexed >= config.backgroundIndexThreshold
}

/**
 * The producer body of one background indexing job.
 *
 * Both outcomes are reported twice on purpose: the appended line is the live log while the job is
 * recent, and the returned outcome carries the terminal status plus the report a later `job_output`
 * delivers even after the ring is trimmed. Neither may throw — a rejected `done` breaks the registry's
 * producer contract, which it can only log, leaving the job to look stuck.
 * @param ctx - the plugin context.
 * @param root - the project root to index.
 * @param handle - the job's producer face.
 * @returns the job's cancellation hook and settlement promise.
 */
function runIndexJob(ctx: Context, root: string, handle: BackgroundJobHandle): BackgroundJobHooks {
  const controller = new AbortController()
  // Called while the registry is still building the job record, so it seeds the registered projection
  // instead of racing an update against a job that does not exist yet.
  handle.updateProgress(`indexing ${root}`)
  const done = (async (): Promise<BackgroundJobOutcome> => {
    try {
      const report = await ctx.codegraph.index(root, controller.signal)
      handle.append(`${indexSummaryLine(root, report)}\n`)
      return { status: 'completed', result: renderCodegraph(indexReportValue(root, report)) }
    } catch (error) {
      const message = failureMessage(error)
      handle.append(`codegraph index failed for ${root}: ${message}\n`)
      return { status: 'failed', detail: message }
    }
  })()
  return { cancel: () => controller.abort(), done }
}

/**
 * The last indexing failure, converted to the `status` answer's snake_case shape.
 *
 * The reader lives in `status-hint.ts` because `/codegraph status` owes the same explanation; only
 * the wire shape is this boundary's business.
 * @param root - absolute project root.
 * @returns the record in the tool's shape, or undefined when there is none to report.
 */
function readIndexFailure(root: string): CodegraphValueFor<'status'>['last_failure'] {
  const record = readIndexFailureFile(root)
  return record === undefined
    ? undefined
    : { failed_at: record.failedAt, message: record.message, source: record.source }
}

/**
 * The watcher's recorded state, converted to the `status` answer's snake_case shape.
 *
 * Reported only when watching is off. "Watching is on" is what every caller assumes; "watching
 * stopped" is the fact that used to exist nowhere but `console.error`, and it is the one that changes
 * what a caller should do after an edit. The reader lives in `status-hint.ts` because the prompt line
 * owes the same warning.
 * @param root - absolute project root.
 * @returns the degradation in the tool's shape, or undefined when nothing degraded.
 */
function readWatchStateField(root: string): CodegraphValueFor<'status'>['watch'] {
  const record = readWatchState(root)
  if (record === undefined || record.watching) return undefined
  return record.code === undefined
    ? { degraded: true, at: record.at }
    : { degraded: true, code: record.code, at: record.at }
}

/**
 * The canonical value for a finished indexing run.
 * @param root - the indexed project root, as reported to the model.
 * @param report - the indexer's report.
 * @returns the `index` operation's completed-report value.
 */
function indexReportValue(root: string, report: CodegraphIndexReport): CodegraphValueFor<'index'> {
  return {
    operation: 'index',
    project_path: root,
    files_indexed: report.filesIndexed,
    files_skipped: report.filesSkipped,
    files_minified: report.filesMinified,
    symbol_count: report.nodeCount,
    edge_count: report.edgeCount,
    unresolved_count: report.unresolvedCount,
    unresolved_likely_internal_count: report.unresolvedLikelyInternalCount,
    languages: report.languages.map(entry => ({ language: entry.language, file_count: entry.fileCount })),
  }
}

/**
 * One line of the counts a finished run wrote, for a job's live log.
 * @param root - the indexed project root.
 * @param report - the indexer's report.
 * @returns the summary line.
 */
function indexSummaryLine(root: string, report: CodegraphIndexReport): string {
  return `Indexed ${root}: ${report.filesIndexed} files, ${report.nodeCount} symbols, ${report.edgeCount} relationships.`
}

/**
 * The text a failed job reports.
 * @param error - whatever the indexer threw.
 * @returns the error's own message when it has one, else its string form.
 */
function failureMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * The slice of the host's background-job registry this plugin calls, declared structurally.
 *
 * `@deepseek-ai/dsh-jobs` is deliberately not a dependency: the service may be absent, which is what
 * the optional lookup tolerates, and importing its types would tie this package's install to a host
 * package it is written to live without. The shape below is the seam's public contract — a job is
 * registered with one owner, one label, and a producer whose settlement promise the registry watches.
 */
interface BackgroundJobRegistry {
  /**
   * Register a job and return its id immediately.
   * @param spec - the job's owner, label, and producer body.
   * @returns the new job's id.
   */
  start(spec: BackgroundJobSpec): string
}

/** One job registration. */
interface BackgroundJobSpec {
  /** Session id of the agent that owns the job; its disposal cancels the work. */
  owner?: string
  /** Stable kind, used for retention and diagnostics (`codegraph-index`). */
  kind: string
  /** Human-readable label shown in job listings and completion notices. */
  label: string
  /** The producer body, invoked once while the registration is still being built. */
  run(handle: BackgroundJobHandle): BackgroundJobHooks
}

/** What a producer may write while its job runs. */
interface BackgroundJobHandle {
  /**
   * Append one chunk of output to the job's log.
   * @param text - the text to append, verbatim.
   */
  append(text: string): void
  /**
   * Replace the job's live progress line.
   * @param line - the new progress line.
   */
  updateProgress(line: string): void
}

/** What a producer hands back so the registry can stop and await it. */
interface BackgroundJobHooks {
  /**
   * Stop the work.
   * @param reason - why the job was stopped, when the caller has a reason.
   */
  cancel(reason?: string): void
  /** Settles once the producer is done, carrying the job's terminal outcome. */
  done: Promise<BackgroundJobOutcome>
}

/** The terminal report a producer settles with. */
interface BackgroundJobOutcome {
  /** Terminal status the registry records. */
  status: 'completed' | 'failed' | 'killed'
  /** Failure detail, when the job failed. */
  detail?: string
  /** The result a `job_output` read delivers, when the job completed. */
  result?: string
}

/**
 * Answer one tool call.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin configuration.
 * @param args - the validated tool arguments.
 * @param exec - the tool-execution context.
 * @returns the canonical value for the requested operation.
 */
async function run(
  ctx: Context,
  config: ResolvedConfig,
  args: CodegraphToolArgs,
  exec: ToolExecution,
): Promise<CodegraphToolValue> {
  const root = projectRoot(args, exec)
  const limit = bounded(args.limit, config.defaultLimit, config.maxLimit)
  const depth = bounded(args.depth, config.defaultDepth, config.maxDepth)
  const projection: ProjectionLimits = {
    maxDocstringChars: config.maxDocstringChars,
    maxSignatureChars: config.maxSignatureChars,
  }
  const source: SourceLimits = { maxLines: config.maxSourceLines, maxChars: config.maxSourceChars }
  const signal = exec.signal

  switch (args.operation) {
    case 'search': {
      const result = await ctx.codegraph.query({
        operation: 'search',
        projectRoot: root,
        query: required(args, 'query'),
        ...args.kind === undefined ? {} : { kind: args.kind },
        ...args.language === undefined ? {} : { language: args.language },
        limit,
      }, signal)
      return {
        operation: 'search',
        project_path: root,
        symbols: result.nodes.map(node => toSymbol(node, projection)),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'node': {
      const result = await ctx.codegraph.query({
        operation: 'node',
        projectRoot: root,
        symbol: required(args, 'symbol'),
        limit,
      }, signal)
      const symbol = result.node === null ? null : toSymbol(result.node, projection)
      const code = args.include_code === true && result.node !== null
        ? (await readSlice(ctx, root, result.node.filePath, result.node.startLine, result.node.endLine, source, signal)).code
        : null
      return {
        operation: 'node',
        project_path: root,
        symbol,
        incoming: result.incoming.map(relation => toRelation(relation, projection)),
        outgoing: result.outgoing.map(relation => toRelation(relation, projection)),
        alternatives: result.alternatives.map(node => toSymbol(node, projection)),
        code,
      }
    }
    case 'callers':
    case 'callees': {
      const result = await ctx.codegraph.query({
        operation: args.operation,
        projectRoot: root,
        symbol: required(args, 'symbol'),
        limit,
      }, signal)
      return {
        operation: args.operation,
        project_path: root,
        symbol: result.subject === null ? null : toSymbol(result.subject, projection),
        relations: result.relations.map(relation => toRelation(relation, projection)),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'impact': {
      const result = await ctx.codegraph.query({
        operation: 'impact',
        projectRoot: root,
        symbol: required(args, 'symbol'),
        depth,
        limit,
      }, signal)
      return {
        operation: 'impact',
        project_path: root,
        symbol: result.subject === null ? null : toSymbol(result.subject, projection),
        affected: result.entries.map(entry => toAffected(entry, projection)),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'trace': {
      const result = await ctx.codegraph.query({
        operation: 'trace',
        projectRoot: root,
        from: required(args, 'from'),
        to: required(args, 'to'),
        maxDepth: depth,
        maxPaths: config.maxPaths,
      }, signal)
      return {
        operation: 'trace',
        project_path: root,
        from: result.from === null ? null : toSymbol(result.from, projection),
        to: result.to === null ? null : toSymbol(result.to, projection),
        paths: result.paths.map(path => path.map(hop => toHop(hop, projection))),
      }
    }
    case 'files': {
      const result = await ctx.codegraph.query({
        operation: 'files',
        projectRoot: root,
        ...args.path === undefined ? {} : { path: args.path },
        ...args.pattern === undefined ? {} : { pattern: args.pattern },
        limit,
      }, signal)
      return {
        operation: 'files',
        project_path: root,
        files: result.files.map(file => ({
          path: file.path,
          language: file.language,
          size: file.size,
          symbol_count: file.nodeCount,
        })),
        total: result.total,
        truncated: result.truncated,
      }
    }
    case 'status': {
      const available = await ctx.codegraph.available(root, signal)
      // Read before branching, so the answer explains itself in both states: no index at all, and an
      // index whose newest refresh failed. The watcher's state is read here for the same reason — a
      // graph can be present and still never refresh, and that is exactly the case a caller cannot
      // otherwise tell apart from a healthy workspace.
      const failure = readIndexFailure(root)
      const lastFailure = failure === undefined ? {} : { last_failure: failure }
      const watch = readWatchStateField(root)
      const watchState = watch === undefined ? {} : { watch }
      if (!available) {
        return { operation: 'status', project_path: root, indexed: false, ...lastFailure, ...watchState }
      }
      const result = await ctx.codegraph.query({ operation: 'status', projectRoot: root }, signal)
      return {
        operation: 'status',
        project_path: root,
        indexed: true,
        file_count: result.fileCount,
        symbol_count: result.nodeCount,
        edge_count: result.edgeCount,
        format_version: result.formatVersion,
        indexed_at: result.indexedAt,
        languages: result.languages.map(entry => ({
          language: entry.language,
          file_count: entry.fileCount,
        })),
        stale_file_count: result.staleFileCount,
        stale_file_count_truncated: result.staleFileCountTruncated,
        ...lastFailure,
        ...watchState,
      }
    }
    case 'explore': {
      const result = await ctx.codegraph.query({
        operation: 'search',
        projectRoot: root,
        query: required(args, 'query'),
        limit,
      }, signal)
      const declarations = declarationsOnly(result.nodes)
      const groups = groupByFile(declarations, config.maxSourceFiles)
      return {
        operation: 'explore',
        project_path: root,
        files: await Promise.all(groups.map(group => explored(ctx, root, group, projection, source, signal))),
        total: result.total,
        truncated: result.truncated || groups.length < countFiles(declarations),
      }
    }
    case 'context': {
      const task = required(args, 'task')
      const terms = taskTerms(task, config.maxContextTerms, config.contextSynonyms)
      const batches = await Promise.all(terms.map(async term => (await ctx.codegraph.query({
        operation: 'search',
        projectRoot: root,
        query: term,
        limit,
      }, signal)).nodes))
      const ranked = mergeByHits(batches.map(declarationsOnly), limit).map(scored => scored.node)
      const related = await relatedTo(ctx, root, ranked, config, signal)
      const groups = groupByFile(ranked, config.maxSourceFiles)
      return {
        operation: 'context',
        project_path: root,
        task,
        entry_points: ranked.map(node => toSymbol(node, projection)),
        related: related.map(relation => toRelation(relation, projection)),
        files: await Promise.all(groups.map(group => explored(ctx, root, group, projection, source, signal))),
      }
    }
    /* v8 ignore next -- exhaustive over the parameter schema's closed operation enum; unreachable. */
    default:
      return assertNever(args.operation, 'tool-codegraph operation')
  }
}

/** How many distinct files a ranked result set spans. */
function countFiles(nodes: readonly CodegraphNode[]): number {
  return new Set(nodes.map(node => node.filePath)).size
}

/** Read one file group's source and pair it with the declarations that selected it. */
async function explored(
  ctx: Context,
  root: string,
  group: FileGroup,
  projection: ProjectionLimits,
  source: SourceLimits,
  signal?: AbortSignal,
): Promise<{
  path: string
  symbols: SymbolView[]
  code: string | null
  code_start_line?: number
  truncated: boolean
}> {
  const slice = await readSlice(ctx, root, group.path, group.startLine, group.endLine, source, signal)
  return {
    path: group.path,
    symbols: group.nodes.map(node => toSymbol(node, projection)),
    code: slice.code,
    ...slice.startLine === undefined ? {} : { code_start_line: slice.startLine },
    truncated: slice.truncated,
  }
}

/**
 * Callers and callees of the highest-ranked declarations a task matched.
 *
 * Only the top declarations are expanded: a task's context is the neighbourhood of what it is about,
 * and querying every match's relations would spend the result budget on the tail of the ranking.
 * @param ctx - the plugin context.
 * @param root - the project root.
 * @param ranked - the task's matched declarations, most relevant first.
 * @param config - the resolved plugin configuration.
 * @param signal - aborts the queries.
 * @returns the merged relations.
 */
async function relatedTo(
  ctx: Context,
  root: string,
  ranked: readonly CodegraphNode[],
  config: ResolvedConfig,
  signal?: AbortSignal,
): Promise<CodegraphRelation[]> {
  const seeds = ranked.slice(0, config.maxSourceFiles)
  const batches = await Promise.all(seeds.flatMap(node => (['callers', 'callees'] as const).map(
    async operation => (await ctx.codegraph.query({
      operation,
      projectRoot: root,
      symbol: node.qualifiedName,
      limit: config.defaultLimit,
    }, signal)).relations,
  )))
  return mergeRelations(batches, config.defaultLimit)
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`tool-codegraph: ${field} must be a positive integer`)
  }
}

/** Reject a timer value Node would clamp instead of scheduling as configured. */
function assertTimer(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1 || value > MAX_TIMER_DELAY_MS) {
    throw new Error(`tool-codegraph: ${field} must be a positive integer no greater than ${MAX_TIMER_DELAY_MS}`)
  }
}
