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
 * `systemPrompt`, and import no store.
 *
 * Namespace plugin (named exports, no default export).
 * @module dsh-plugin-codegraph-tool
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import { CodegraphError } from 'dsh-plugin-codegraph-service'
import type { CodegraphNode, CodegraphRelation } from 'dsh-plugin-codegraph-service'
import type {} from '@deepseek-ai/dsh-fs'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { declarationsOnly, groupByFile, mergeByHits, mergeRelations, taskTerms } from './compose.ts'
import type { FileGroup } from './compose.ts'
import { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
import type { ProjectionLimits, SymbolView } from './projection.ts'
import { renderCodegraph } from './render.ts'
import { CODEGRAPH_INDEX_PARAMETERS, CODEGRAPH_OUTPUT_SCHEMA, CODEGRAPH_PARAMETERS } from './schema.ts'
import type { CodegraphIndexToolArgs, CodegraphToolArgs, CodegraphToolValue } from './schema.ts'
import { readSlice } from './source.ts'
import type { SourceLimits } from './source.ts'

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
export { declarationsOnly, groupByFile, mergeByHits, mergeRelations, taskTerms } from './compose.ts'
export { toAffected, toHop, toRelation, toSymbol } from './projection.ts'
export { renderCodegraph } from './render.ts'
export { readSlice } from './source.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'tool-codegraph'

/** Services required by this plugin. */
export const inject = ['tools', 'codegraph', 'fs', 'systemPrompt']

/** Default tool-call timeout budget (ms) for the query-side `codegraph` tool. */
export const DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS = 30_000

/** Default timeout budget (ms) for the `codegraph_index` tool. Indexing a monorepo is a different order of work than a query. */
export const DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS = 300_000

/** The stable system-prompt guidance positioning the code graph against search and read. */
export const CODEGRAPH_PROMPT_TEXT =
  'Use codegraph for structural questions about code: where a symbol is declared, what calls it, what it calls, what a change to it reaches, and how one symbol reaches another. It answers from a pre-built index, so it is both faster and more precise than grepping for a name, which also matches comments, strings, and unrelated identifiers. Use search/read instead for literal text, and when codegraph reports no index for a workspace. When status reports no index, call codegraph_index once to build one — it runs on its own, longer timeout budget than a query — then retry. Results reflect the last time the workspace was indexed; a declaration added since then is absent.'

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
  /** Tool-call timeout budget in ms for the query-side `codegraph` tool (default 30000). */
  timeoutMs?: number
  /** Tool-call timeout budget in ms for the `codegraph_index` tool (default 300000). */
  indexTimeoutMs?: number
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
  timeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_TOOL_TIMEOUT_MS),
  indexTimeoutMs: z.number().max(MAX_TIMER_DELAY_MS).default(DEFAULT_CODEGRAPH_INDEX_TIMEOUT_MS),
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

  ctx.systemPrompt.section({ name: 'tool:codegraph', order: 111, text: CODEGRAPH_PROMPT_TEXT })

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
      'Build or refresh the codegraph index for a workspace, so the codegraph tool can answer. Indexing a large workspace can take minutes, so this runs on its own timeout budget, separate from codegraph\'s query operations.',
    parameters: CODEGRAPH_INDEX_PARAMETERS,
    output: {
      schema: CODEGRAPH_OUTPUT_SCHEMA,
      render: (_args, value) => [{ type: 'text', text: renderCodegraph(value) }],
    },
    timeoutMs: resolved.indexTimeoutMs,
    async execute(args, exec) {
      return runIndex(ctx, args, exec)
    },
    presentCall: args => ({
      card: 'generic' as const,
      title: args.project_path === undefined ? 'codegraph_index' : `codegraph_index ${args.project_path}`,
      kind: 'search' as const,
      rawInput: args,
    }),
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
 * @param ctx - the plugin context.
 * @param args - the index tool's validated arguments.
 * @param exec - the tool-execution context.
 * @returns the index operation's canonical value.
 */
async function runIndex(
  ctx: Context,
  args: CodegraphIndexToolArgs,
  exec: ToolExecution,
): Promise<CodegraphToolValue> {
  const root = resolvedProjectRoot(args.project_path, exec)
  const report = await ctx.codegraph.index(root, exec.signal)
  return {
    operation: 'index',
    project_path: root,
    files_indexed: report.filesIndexed,
    files_skipped: report.filesSkipped,
    symbol_count: report.nodeCount,
    edge_count: report.edgeCount,
    unresolved_count: report.unresolvedCount,
    languages: report.languages.map(entry => ({ language: entry.language, file_count: entry.fileCount })),
  }
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
      if (!available) {
        return { operation: 'status', project_path: root, indexed: false }
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
      const terms = taskTerms(task, config.maxContextTerms)
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
