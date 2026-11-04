import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import Codegraph, { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from 'dsh-plugin-codegraph-service'
import type { CodegraphIndexReport, CodegraphNode, CodegraphRequest, CodegraphStoreProvider } from 'dsh-plugin-codegraph-service'
import * as ToolCodegraph from '../src/index.ts'
import { callTitle, projectRoot } from '../src/index.ts'
import {
  COMMAND_DEFINITION_ID,
  COMMAND_DESCRIPTION,
  COMMAND_INPUT_HINT,
  COMMAND_NAME,
  COMMAND_USAGE,
  registerCommands,
} from '../src/command.ts'
import type { CommandDefinition, CommandResult } from '../src/command.ts'
import { declarationsOnly, groupByFile, mergeByHits, mergeRelations, taskTerms } from '../src/compose.ts'
import { PANEL_ROUTE_PREFIX, registerPanelRoutes } from '../src/panel.ts'
import type { PanelConfig, PanelRequest, PanelRoute } from '../src/panel.ts'
import { expandTerms, ZH_SYNONYMS } from '../src/zh-synonyms.ts'
import { toAffected, toHop, toRelation, toSymbol } from '../src/projection.ts'
import { clearCommandRuns, commandRunHint } from '../src/command-log.ts'
import { renderCodegraph } from '../src/render.ts'
import type { CodegraphToolValue } from '../src/schema.ts'
import { readSlice } from '../src/source.ts'

const roots: string[] = []
let context: Context | undefined

afterEach(async () => {
  clearCommandRuns()
  await context?.fiber.dispose()
  context = undefined
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-codegraph-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

function graphNode(overrides: Partial<CodegraphNode> = {}): CodegraphNode {
  return {
    id: CodegraphNodeId('fn:main'),
    kind: 'function',
    name: 'main',
    qualifiedName: 'main',
    filePath: 'app.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 3,
    startColumn: 0,
    endColumn: 0,
    isExported: true,
    isAsync: false,
    isStatic: false,
    isAbstract: false,
    decorators: [],
    typeParameters: [],
    updatedAt: 1,
    ...overrides,
  }
}

const LIMITS = { maxDocstringChars: 8, maxSignatureChars: 8 }

describe('model-facing projection', () => {
  it('drops graph-only fields and renames positions for the model', () => {
    const view = toSymbol(graphNode(), LIMITS)
    expect(view).toEqual({
      name: 'main', qualified_name: 'main', kind: 'function', path: 'app.ts',
      line: 1, end_line: 3, language: 'typescript', exported: true,
    })
  })

  it('marks a clipped signature and docstring rather than truncating silently', () => {
    const view = toSymbol(graphNode({ signature: '(a: string, b: number)', docstring: 'A very long note' }), LIMITS)
    expect(view.signature).toBe('(a: stri…')
    expect(view.docstring).toBe('A very l…')
  })

  it('carries the reaching edge on relations, affected nodes, and hops', () => {
    const edge = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'calls', line: 9 }
    expect(toRelation({ node: graphNode(), edge, siteCount: 3 }, LIMITS))
      .toMatchObject({ via: 'calls', site_line: 9, site_count: 3 })
    const placeless = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'contains' }
    expect(toRelation({ node: graphNode(), edge: placeless, siteCount: 1 }, LIMITS).site_line).toBeUndefined()
    expect(toAffected({ node: graphNode(), distance: 2, via: 'references' }, LIMITS))
      .toMatchObject({ distance: 2, via: 'references' })
    expect(toHop({ node: graphNode(), edge }, LIMITS)).toMatchObject({ via: 'calls', site_line: 9 })
    expect(toHop({ node: graphNode() }, LIMITS).via).toBeUndefined()
  })
})

describe('task decomposition and merging', () => {
  it('keeps identifier-shaped words whole and drops filler', () => {
    expect(taskTerms('how does the useUrlState hook sync with url_state', 10))
      .toEqual(['useUrlState', 'url_state', 'hook', 'sync'])
  })

  it('returns at most the requested number of terms, longest first', () => {
    expect(taskTerms('alpha bb gamma delta', 2)).toEqual(['alpha', 'gamma'])
  })

  it('reads a Chinese task as the English identifiers a graph is indexed under', () => {
    expect(taskTerms('修改报表页的分页与筛选参数', 6)).toEqual([
      '修改报表页的分页与筛选参数', 'report', 'page', 'filter', 'param', 'pageSize',
    ])
  })

  it('spends a tight budget on one reading of every word before a second of any', () => {
    // `分页` alone offers four readings, and a depth-first order would spend the whole budget on them,
    // leaving the task's filters unsearched.
    expect(taskTerms('修改报表页的分页与筛选参数', 4)).toEqual([
      '修改报表页的分页与筛选参数', 'report', 'page', 'filter',
    ])
  })

  it('keeps a two-character Chinese word, which is already a whole word', () => {
    expect(taskTerms('报表', 6)).toEqual(['报表', 'report'])
  })

  it('leaves an English task byte for byte as it was', () => {
    const task = 'how does the useUrlState hook sync with url_state'
    expect(taskTerms(task, 10, { 报表: ['kpi'] })).toEqual(taskTerms(task, 10))
    expect(taskTerms(task, 10)).toEqual(['useUrlState', 'url_state', 'hook', 'sync'])
  })

  it('merges deployment vocabulary over the built-in table', () => {
    expect(taskTerms('报表 漏斗', 10, { 报表: ['kpi'], 漏斗: ['funnel'] }))
      .toEqual(['报表', '漏斗', 'report', 'kpi', 'funnel'])
  })

  it('adds no candidate for a Chinese word it does not know', () => {
    expect(taskTerms('涂鸦墙', 6)).toEqual(['涂鸦墙'])
    expect(taskTerms('涂鸦墙', 6, { 报表: ['kpi'] })).toEqual(['涂鸦墙'])
  })

  it('returns no terms for an empty or blank task', () => {
    expect(taskTerms('', 6)).toEqual([])
    expect(taskTerms('  \n\t ', 6, { 报表: ['kpi'] })).toEqual([])
  })

  it('expands without truncating, leaving the budget to the caller', () => {
    expect(expandTerms(['分页'], { 分页: ['current'] }))
      .toEqual(['分页', 'page', 'pageSize', 'pagination', 'current'])
  })

  it('covers the high-frequency development words', () => {
    for (const word of ['报表', '分页', '筛选', '列表', '详情', '弹窗', '表单', '导入', '导出', '新增',
      '删除', '编辑', '权限', '配置', '缓存', '任务', '日志', '接口', '账户', '图表', '统计', '时间',
      '状态', '错误', '加载', '刷新', '排序']) {
      expect(ZH_SYNONYMS.get(word), word).toBeDefined()
    }
  })

  it('ranks a declaration found by several terms above one found by a single term', () => {
    const shared = graphNode({ name: 'shared', filePath: 'a.ts', startLine: 1 })
    const once = graphNode({ name: 'once', filePath: 'b.ts', startLine: 5 })
    const merged = mergeByHits([[once, shared], [shared]], 10)
    expect(merged.map(entry => [entry.node.name, entry.hits])).toEqual([['shared', 2], ['once', 1]])
  })

  it('breaks an equal-hit tie by the best position any single search gave', () => {
    const early = graphNode({ name: 'early', filePath: 'a.ts', startLine: 1 })
    const late = graphNode({ name: 'late', filePath: 'b.ts', startLine: 2 })
    expect(mergeByHits([[early, late]], 10).map(entry => entry.node.name)).toEqual(['early', 'late'])
  })

  it('groups declarations by file and spans the lines they cover', () => {
    const groups = groupByFile([
      graphNode({ filePath: 'a.ts', startLine: 10, endLine: 12 }),
      graphNode({ filePath: 'a.ts', startLine: 2, endLine: 4 }),
      graphNode({ filePath: 'b.ts', startLine: 1, endLine: 1 }),
    ], 5)
    expect(groups[0]).toMatchObject({ path: 'a.ts', startLine: 2, endLine: 12 })
    expect(groups.map(group => group.path)).toEqual(['a.ts', 'b.ts'])
    expect(groupByFile([graphNode({ filePath: 'a.ts' }), graphNode({ filePath: 'b.ts' })], 1)).toHaveLength(1)
  })

  it('keeps each related declaration once and stops at the limit', () => {
    const edge = { source: CodegraphNodeId('a'), target: CodegraphNodeId('b'), kind: 'calls' }
    const one = { node: graphNode({ name: 'one', filePath: 'a.ts' }), edge, siteCount: 1 }
    const two = { node: graphNode({ name: 'two', filePath: 'b.ts' }), edge, siteCount: 1 }
    expect(mergeRelations([[one, one], [two]], 10).map(relation => relation.node.name)).toEqual(['one', 'two'])
    expect(mergeRelations([[one], [two]], 1).map(relation => relation.node.name)).toEqual(['one'])
  })

  it('keeps declarations and drops the structural nodes that merely name them', () => {
    const kept = declarationsOnly([
      graphNode({ kind: 'function', name: 'real' }),
      graphNode({ kind: 'import', name: 'real' }),
      graphNode({ kind: 'file', name: 'a.ts' }),
    ])
    expect(kept.map(entry => entry.kind)).toEqual(['function'])
  })
})

describe('source retrieval', () => {
  const caps = { maxLines: 3, maxChars: 100 }

  it('returns the requested line window', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\ntwo\nthree\nfour\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 2, 3, caps)).toEqual({
      code: 'two\nthree', startLine: 2, truncated: false,
    })
  })

  it('clamps a range that runs past the file and reports line truncation', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\ntwo\nthree\nfour\nfive\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 0, 99, caps)).toMatchObject({
      code: 'one\ntwo\nthree', startLine: 1, truncated: true,
    })
  })

  it('reports character truncation separately from line truncation', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'abcdefghij\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'a.ts', 1, 1, { maxLines: 3, maxChars: 4 }))
      .toMatchObject({ code: 'abcd', truncated: true })
  })

  it('answers with no code when the file cannot be read', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace()
    await ctx.plugin(LocalFileSystem, { cwd: root })
    expect(await readSlice(ctx, root, 'missing.ts', 1, 2, caps))
      .toEqual({ code: null, truncated: false })
  })

  it('forwards a caller signal to the filesystem seam', async () => {
    const ctx = new Context()
    context = ctx
    const root = await workspace({ 'a.ts': 'one\n' })
    await ctx.plugin(LocalFileSystem, { cwd: root })
    const controller = new AbortController()
    controller.abort()
    expect(await readSlice(ctx, root, 'a.ts', 1, 1, caps, controller.signal)).toMatchObject({ code: null })
  })
})

describe('result rendering', () => {
  const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
  const local = toSymbol(graphNode({ name: 'inner', isExported: false, signature: 'a\nb' }),
    { maxDocstringChars: 100, maxSignatureChars: 100 })
  const relation = { ...symbol, via: 'calls', site_line: 4, site_count: 2 }
  const base = { project_path: '/repo' }

  it.each<[string, CodegraphToolValue, RegExp]>([
    ['an empty search', { ...base, operation: 'search', symbols: [], total: 0, truncated: false }, /No declaration matches/],
    ['a capped search', { ...base, operation: 'search', symbols: [symbol], total: 4, truncated: true }, /\(1 of 4 shown\)/],
    ['an uncapped search', { ...base, operation: 'search', symbols: [symbol], total: 1, truncated: false }, /\(1\)/],
    ['an unresolved node', { ...base, operation: 'node', symbol: null, incoming: [], outgoing: [], alternatives: [], code: null }, /No declaration matches/],
    ['unresolved callers', { ...base, operation: 'callers', symbol: null, relations: [], total: 0, truncated: false }, /No declaration matches/],
    ['callers with none recorded', { ...base, operation: 'callers', symbol, relations: [], total: 0, truncated: false }, /none in the index/],
    ['callees', { ...base, operation: 'callees', symbol, relations: [relation], total: 1, truncated: false }, /Called by main/],
    ['an unresolved impact', { ...base, operation: 'impact', symbol: null, affected: [], total: 0, truncated: false }, /No declaration matches/],
    ['an impact with no dependents', { ...base, operation: 'impact', symbol, affected: [], total: 0, truncated: false }, /Nothing in the index depends on main/],
    ['an unresolved trace', { ...base, operation: 'trace', from: null, to: symbol, paths: [] }, /No declaration matches/],
    ['a trace with no route', { ...base, operation: 'trace', from: symbol, to: local, paths: [] }, /dynamic dispatch/],
    ['an empty file list', { ...base, operation: 'files', files: [], total: 0, truncated: false }, /No indexed file matches/],
    ['an empty explore', { ...base, operation: 'explore', files: [], total: 0, truncated: false }, /No declaration matches/],
    ['an empty context', { ...base, operation: 'context', task: 'ship it', entry_points: [], related: [], files: [] }, /Nothing in the index matches "ship it"/],
  ])('renders %s', (_label, value, pattern) => {
    expect(renderCodegraph(value)).toMatch(pattern)
  })

  it('renders a node with alternatives, both edge directions, and its source', () => {
    const text = renderCodegraph({
      ...base,
      operation: 'node',
      symbol: { ...symbol, docstring: 'Does\nthings.' },
      incoming: [relation],
      outgoing: [{ ...relation, via: 'contains', site_line: 0 }],
      alternatives: [local],
      code: 'function main() {}',
    })
    expect(text).toContain('Also named this')
    expect(text).toContain('Reached by:')
    expect(text).toContain('Reaches:')
    expect(text).toContain('(local)')
    expect(text).toContain('function main() {}')
  })

  it('marks repeat call sites and singular counts', () => {
    const text = renderCodegraph({
      ...base,
      operation: 'callers',
      symbol,
      relations: [relation, { ...relation, name: 'once', site_count: 1 }],
      total: 2,
      truncated: false,
    })
    expect(text).toContain('×2')
    expect(text).toContain('at line 4')
    expect(text).not.toContain('×1')
  })

  it('renders hop counts and path steps in singular and plural', () => {
    expect(renderCodegraph({
      ...base, operation: 'impact', symbol,
      affected: [{ ...symbol, via: 'calls', distance: 1 }, { ...symbol, via: 'calls', distance: 2 }],
      total: 2, truncated: false,
    })).toMatch(/1 hop,.*\n.*2 hops,/s)
    const traced = renderCodegraph({
      ...base, operation: 'trace', from: symbol, to: local,
      paths: [[{ ...symbol }, { ...local, via: 'calls', site_line: 7 }]],
    })
    expect(traced).toContain('1 path from main to inner')
    expect(traced).toContain('[calls at line 7]')
  })

  it('renders index status, including an index that has never run', () => {
    expect(renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 2, symbol_count: 5, edge_count: 3,
      format_version: 4, indexed_at: 0, languages: [{ language: 'typescript', file_count: 2 }],
    })).toContain('Languages: typescript 2.')
    expect(renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 0, symbol_count: 0, edge_count: 0,
      format_version: 4, indexed_at: null, languages: [],
    })).toMatch(/Languages: none\.\nLast indexed: never\./)
  })

  it('tells the model how to build a missing index rather than failing', () => {
    expect(renderCodegraph({ ...base, operation: 'status', indexed: false }))
      .toBe('No index for `/repo`. Run codegraph_index to build one.')
  })

  it('treats a status answer with no languages array the same as an empty one', () => {
    const text = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 0, symbol_count: 0, edge_count: 0,
      format_version: 4, indexed_at: null,
    })
    expect(text).toContain('Languages: none.')
  })

  it('says nothing extra about staleness when nothing is stale', () => {
    const text = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 0, stale_file_count_truncated: false,
    })
    expect(text).not.toContain('codegraph_index to refresh')
  })

  it('names codegraph_index when the index has drifted from disk', () => {
    const one = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 1, stale_file_count_truncated: false,
    })
    expect(one).toContain('1 indexed file changed on disk or went missing since indexing. Call codegraph_index to refresh.')

    const many = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 3, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 3, stale_file_count_truncated: false,
    })
    expect(many).toContain('3 indexed files changed on disk or went missing since indexing.')

    const capped = renderCodegraph({
      ...base, operation: 'status', indexed: true, file_count: 1, symbol_count: 1, edge_count: 0,
      format_version: 4, indexed_at: 0, languages: [], stale_file_count: 1, stale_file_count_truncated: true,
    })
    expect(capped).toContain('at least 1 indexed files changed on disk or went missing since indexing.')
  })

  it('renders an index report in plain-fact style, distinguishing genuine gaps from likely-external noise', () => {
    const text = renderCodegraph({
      ...base, operation: 'index', files_indexed: 12, files_skipped: 1, files_minified: 3,
      symbol_count: 40, edge_count: 30, unresolved_count: 5, unresolved_likely_internal_count: 2,
      languages: [{ language: 'typescript', file_count: 12 }],
    })
    expect(text).toContain('Indexed /repo:')
    expect(text).toContain('12 files indexed, 1 skipped, 3 generated files left out.')
    expect(text).toContain('40 symbols, 30 relationships.')
    expect(text).toContain('2 of 5 unresolved call sites look like genuine gaps')
    expect(text).toContain('Languages: typescript 12.')
  })

  it('reports every call site resolved when none are left unresolved', () => {
    const text = renderCodegraph({
      ...base, operation: 'index', files_indexed: 0, files_skipped: 0, files_minified: 0, symbol_count: 0,
      edge_count: 0, unresolved_count: 0, unresolved_likely_internal_count: 0, languages: [],
    })
    expect(text).toContain('Every call site resolved.')
    expect(text).toContain('Languages: none.')
  })

  it('says a background run has no report yet and how to fetch it', () => {
    const text = renderCodegraph({ ...base, operation: 'index', status: 'started', job_id: 'job-7' })
    expect(text).toBe(
      'Indexing /repo in the background as job job-7. The run outlives this call — read its report with job_output job-7, or stop it with job_kill.',
    )
  })

  it('renders explored and contextual files, including unreadable ones', () => {
    expect(renderCodegraph({
      ...base, operation: 'explore', total: 2, truncated: true,
      files: [
        { path: 'a.ts', symbols: [symbol], code: 'code', code_start_line: 1, truncated: true },
        { path: 'b.ts', symbols: [], code: null, truncated: false },
      ],
    })).toMatch(/source truncated[\s\S]*source unavailable for b\.ts/)
    expect(renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [relation],
      files: [{ path: 'a.ts', symbols: [], code: 'x', truncated: false }],
    })).toContain('Related:')
  })

  it('renders a single indexed file listing', () => {
    expect(renderCodegraph({
      ...base, operation: 'files', total: 1, truncated: false,
      files: [{ path: 'a.ts', language: 'typescript', size: 10, symbol_count: 2 }],
    })).toContain('a.ts  typescript  2 symbols')
  })
})

describe('call labelling and workspace resolution', () => {
  it('labels a call by whichever subject the operation takes', () => {
    expect(callTitle({ operation: 'callers', symbol: 'main' })).toBe('codegraph callers main')
    expect(callTitle({ operation: 'search', query: 'main' })).toBe('codegraph search main')
    expect(callTitle({ operation: 'context', task: 'ship it' })).toBe('codegraph context ship it')
    expect(callTitle({ operation: 'trace', from: 'a', to: 'b' })).toBe('codegraph trace a → b')
    expect(callTitle({ operation: 'trace', from: 'a' })).toBe('codegraph trace a → ?')
    expect(callTitle({ operation: 'files', pattern: '*.ts' })).toBe('codegraph files *.ts')
    expect(callTitle({ operation: 'files', path: 'src' })).toBe('codegraph files src')
    expect(callTitle({ operation: 'status' })).toBe('codegraph status')
  })

  it('prefers an explicit project path over the session workspace', () => {
    const exec = { agent: { session: { header: { cwd: '/session' } } } } as never
    expect(projectRoot({ operation: 'status', project_path: '/explicit' }, exec)).toBe('/explicit')
    expect(projectRoot({ operation: 'status', project_path: '   ' }, exec)).toBe('/session')
    expect(projectRoot({ operation: 'status' }, exec)).toBe('/session')
  })

  it('refuses to guess a workspace when neither is available', () => {
    expect(() => projectRoot({ operation: 'status' }, {} as never))
      .toThrow(/requires a session workspace or an explicit project_path/)
  })
})

describe('the tool plugin', () => {
  /** A store that records the request it received and answers with a minimal valid result. */
  const relation = {
    node: graphNode({ name: 'caller', filePath: 'caller.ts' }),
    edge: { source: CodegraphNodeId('a'), target: CodegraphNodeId('fn:main'), kind: 'calls', line: 4 },
    siteCount: 2,
  }
  const answers: Record<string, unknown> = {
    search: { kind: 'search', nodes: [graphNode()], total: 1, truncated: false },
    node: {
      kind: 'node', node: graphNode(), incoming: [relation], outgoing: [relation],
      alternatives: [graphNode({ name: 'main', filePath: 'other.ts' })],
    },
    callers: { kind: 'callers', subject: graphNode(), relations: [relation], total: 1, truncated: false },
    callees: { kind: 'callees', subject: graphNode(), relations: [relation], total: 1, truncated: false },
    impact: {
      kind: 'impact', subject: graphNode(), total: 1, truncated: false,
      entries: [{ node: graphNode({ name: 'dependent' }), distance: 1, via: 'calls' }],
    },
    trace: {
      kind: 'trace', from: graphNode(), to: graphNode({ name: 'far' }),
      paths: [[{ node: graphNode() }, { node: graphNode({ name: 'far' }), edge: relation.edge }]],
    },
    files: {
      kind: 'files', total: 1, truncated: false,
      files: [{ path: 'app.ts', language: 'typescript', size: 10, nodeCount: 2, modifiedAt: 1, indexedAt: 2 }],
    },
    status: {
      kind: 'status', projectRoot: '/repo', fileCount: 1, nodeCount: 1, edgeCount: 0,
      languages: [{ language: 'typescript', fileCount: 1 }], formatVersion: 4, indexedAt: null,
      staleFileCount: 1, staleFileCountTruncated: false,
    },
  }
  const seen: CodegraphRequest[] = []
  const indexed: string[] = []
  const indexReport: CodegraphIndexReport = {
    projectRoot: '/repo', filesIndexed: 2, filesSkipped: 1, filesMinified: 3, filesReused: 0, nodeCount: 5, edgeCount: 3,
    unresolvedCount: 1, unresolvedLikelyInternalCount: 1, languages: [{ language: 'typescript', fileCount: 2 }],
  }

  async function mount(
    root: string,
    config?: Record<string, unknown>,
    options: {
      /** A stand-in for the host's `jobs` service; omit to mount a composition that has none. */
      jobs?: unknown
      /** Replaces the stub indexer's body, for the job paths that fail or hang. */
      index?: (projectRoot: string, signal: AbortSignal | undefined) => Promise<CodegraphIndexReport>
    } = {},
  ): Promise<Context> {
    seen.length = 0
    indexed.length = 0
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    if (options.jobs !== undefined) ctx.provide('jobs', options.jobs)
    const store: CodegraphStoreProvider = {
      id: CodegraphStoreId('stub'),
      indexes: () => Promise.resolve(true),
      query: ((request: CodegraphRequest) => {
        seen.push(request)
        return Promise.resolve(answers[request.operation])
      }) as CodegraphStoreProvider['query'],
    }
    ctx.codegraph.registerStore(store)
    ctx.codegraph.registerIndexer({
      id: CodegraphIndexerId('stub-indexer'),
      canIndex: () => Promise.resolve(true),
      index: options.index ?? ((projectRoot) => {
        indexed.push(projectRoot)
        return Promise.resolve({ ...indexReport, projectRoot })
      }),
    })
    await ctx.plugin(ToolCodegraph, config)
    return ctx
  }

  function agent(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-unit')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
    const value: Agent = {
      id, options: {}, session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  async function call(ctx: Context, owner: Agent, args: Record<string, unknown>, id = 'unit') {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(id),
      name: 'codegraph',
      arguments: args,
      agent: owner,
    })
  }

  async function callIndex(ctx: Context, owner: Agent | undefined, args: Record<string, unknown>, id = 'index') {
    return ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(id),
      name: 'codegraph_index',
      arguments: args,
      ...owner === undefined ? {} : { agent: owner },
    })
  }

  it('contributes its prompt section and schema', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('codegraph')
    expect(ctx.tools.schemas().map(schema => schema.name)).toContain('codegraph_index')
    const assembled = await ctx.systemPrompt.assemble()
    expect(assembled.sections.map(section => section.text).join('\n'))
      .toContain('Use codegraph for structural questions')
  })

  it('rejects "index" as an operation on the query tool', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'index' })
    expect(result.isError).toBe(true)
  })

  it('runs the dedicated index tool against the resolved project root', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await callIndex(ctx, owner, {})
    expect(result.isError).toBe(false)
    expect(indexed).toEqual([root])
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toContain('Indexed')
    expect(text).toContain('2 files indexed, 1 skipped, 3 generated files left out')
  })

  it('lets the index tool target an explicit project outside any session', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const result = await callIndex(ctx, undefined, { project_path: '/elsewhere' }, 'explicit')
    expect(result.isError).toBe(false)
    expect(indexed).toEqual(['/elsewhere'])
  })

  it('tells the model the workspace index state on every prompt assembly', async () => {
    const root = await workspace({
      '.codegraph/status.json': JSON.stringify({
        indexedAt: Date.UTC(2026, 10, 3, 1, 57),
        filesIndexed: 12, filesMinified: 3, nodeCount: 40, edgeCount: 30,
        unresolvedCount: 5, unresolvedLikelyInternalCount: 2,
      }),
    })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const assembly = await ctx.systemPrompt.assemble({ agent: owner, scope: owner })
    const section = assembly.sections.find(entry => entry.name === 'tool:codegraph')
    expect(section?.text).toContain('Use codegraph for structural questions')
    expect(section?.text).toContain(
      `The code graph for ${root} was built 2026-11-03T01:57Z from 12 files: 40 declarations, 30 relationships. 3 generated files were left out.`,
    )
  })

  it('carries its own timeout budget, distinct from the query tool', async () => {
    const root = await workspace()
    const ctx = await mount(root, { timeoutMs: 5000, indexTimeoutMs: 600_000 })
    expect(ctx.tools.get('codegraph')?.timeoutMs).toBe(5000)
    expect(ctx.tools.get('codegraph_index')?.timeoutMs).toBe(600_000)
  })

  it('runs every operation and passes the resolved bounds down', async () => {
    const root = await workspace({ 'app.ts': 'function main() {}\n' })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    for (const args of [
      { operation: 'search', query: 'main', kind: 'function', language: 'typescript' },
      { operation: 'node', symbol: 'main', include_code: true },
      { operation: 'callers', symbol: 'main' },
      { operation: 'callees', symbol: 'main' },
      { operation: 'impact', symbol: 'main' },
      { operation: 'trace', from: 'main', to: 'main' },
      { operation: 'files', path: 'src', pattern: '*.ts' },
      { operation: 'status' },
      { operation: 'explore', query: 'main' },
      { operation: 'context', task: 'how does main work' },
    ]) {
      const result = await call(ctx, owner, args, args.operation)
      expect(result.isError, `${args.operation} failed`).toBe(false)
    }
    expect(seen.some(request => request.operation === 'search' && request.kind === 'function')).toBe(true)
  })

  it('omits source for node unless the model asks for it', async () => {
    const root = await workspace({ 'app.ts': 'function main() {}\n' })
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const plain = await call(ctx, owner, { operation: 'node', symbol: 'main' }, 'plain')
    expect(plain.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .not.toContain('function main() {}')
  })

  it('clamps a model-supplied limit and depth into the configured range', async () => {
    const root = await workspace()
    const ctx = await mount(root, { defaultLimit: 7, maxLimit: 9, defaultDepth: 2, maxDepth: 3 })
    const owner = agent(ctx, root)
    await call(ctx, owner, { operation: 'search', query: 'main' }, 'default')
    await call(ctx, owner, { operation: 'search', query: 'main', limit: 500 }, 'over')
    await call(ctx, owner, { operation: 'search', query: 'main', limit: 0 }, 'under')
    await call(ctx, owner, { operation: 'impact', symbol: 'main', depth: 99 }, 'depth')
    const limits = seen.filter(request => request.operation === 'search').map(request => request.limit)
    expect(limits).toEqual([7, 9, 1])
    expect(seen.find(request => request.operation === 'impact')?.depth).toBe(3)
  })

  it('searches the English identifiers a Chinese task stands for', async () => {
    const root = await workspace({ 'app.ts': 'function main() {}\n' })
    const ctx = await mount(root, { contextSynonyms: { 漏斗: ['funnel'] } })
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, { operation: 'context', task: '报表的漏斗' }, 'zh')
    expect(result.isError).toBe(false)
    // The built-in `报表` reading and the deployment's own `漏斗` reading reach the store together.
    expect(seen.filter(request => request.operation === 'search').map(request => request.query))
      .toEqual(['报表的漏斗', 'report', 'funnel'])
  })

  it.each([
    ['node', { operation: 'node' }, /requires a non-empty "symbol"/],
    ['search', { operation: 'search' }, /requires a non-empty "query"/],
    ['search with a blank query', { operation: 'search', query: '  ' }, /requires a non-empty "query"/],
    ['trace', { operation: 'trace', from: 'a' }, /requires a non-empty "to"/],
    ['context', { operation: 'context' }, /requires a non-empty "task"/],
  ])('rejects %s without its required argument', async (_label, args, pattern) => {
    const root = await workspace()
    const ctx = await mount(root)
    const owner = agent(ctx, root)
    const result = await call(ctx, owner, args)
    expect(result.isError).toBe(true)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join('')).toMatch(pattern)
  })

  it('labels the pending card from the call arguments', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const args = { operation: 'callers', symbol: 'main' }
    expect(ctx.tools.get('codegraph')?.presentCall?.(args)).toEqual({
      card: 'generic', title: 'codegraph callers main', kind: 'search', rawInput: args,
    })
  })

  it('labels the pending index card, with and without an explicit project', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    expect(ctx.tools.get('codegraph_index')?.presentCall?.({})).toEqual({
      card: 'generic', title: 'codegraph_index', kind: 'search', rawInput: {},
    })
    const args = { project_path: '/elsewhere' }
    expect(ctx.tools.get('codegraph_index')?.presentCall?.(args)).toEqual({
      card: 'generic', title: 'codegraph_index /elsewhere', kind: 'search', rawInput: args,
    })
  })

  it('fails a call made outside any session workspace', async () => {
    const root = await workspace()
    const ctx = await mount(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('no-agent'),
      name: 'codegraph',
      arguments: { operation: 'status' },
    })
    expect(result.isError).toBe(true)
  })

  it.each([
    ['maxSourceFiles', { maxSourceFiles: 0 }],
    ['timeoutMs', { timeoutMs: 0 }],
    ['indexTimeoutMs', { indexTimeoutMs: 0 }],
    ['backgroundIndexThreshold', { backgroundIndexThreshold: 0 }],
  ])('fails loading when %s is out of range', async (field, config) => {
    const root = await workspace()
    await expect(mount(root, config)).rejects.toThrow(new RegExp(field))
  })

  it('answers normally with update checking switched off', async () => {
    // Both tools call `updateChecker?.noteToolUse(...)`, so the disabled path has to prove a call
    // still answers rather than the optional chain short-circuiting the tool itself.
    const root = await workspace()
    const ctx = await mount(root, { updateCheck: false })
    const owner = agent(ctx, root)
    expect((await call(ctx, owner, { operation: 'status' })).isError).toBe(false)
    expect((await callIndex(ctx, owner, { project_path: root })).isError).toBe(false)
  })

  interface FakeJobHandle {
    append(text: string): void
    updateProgress(line: string): void
  }

  interface FakeJobHooks {
    cancel(reason?: string): void
    done: Promise<{ status: string; detail?: string; result?: string }>
  }

  interface RecordedJob {
    spec: { owner?: string; kind: string; label: string; run: (handle: FakeJobHandle) => FakeJobHooks }
    output: string[]
    progress: string[]
  }

  /**
   * A stand-in for `@deepseek-ai/dsh-jobs`'s registry. It never runs a producer itself — a test drives
   * the recorded spec's `run` through {@link driveJob}, so both halves of the contract can be asserted:
   * what the tool registered, and what the job body then wrote and settled with.
   */
  function fakeJobs(options: { refuse?: true } = {}) {
    const started: RecordedJob[] = []
    const jobs = {
      start(spec: RecordedJob['spec']): string {
        // The host refuses on two real conditions — no controller for the agent, owner at its cap —
        // and the tool must treat both as "index here instead", so one throw stands in for both.
        if (options.refuse === true) throw new Error('background jobs unavailable: no job controller serves this agent')
        started.push({ spec, output: [], progress: [] })
        return 'job-1'
      },
    }
    return { started, jobs }
  }

  /** Invoke one recorded job's producer face; the caller awaits `hooks.done`. */
  function driveJob(job: RecordedJob): { output: string[]; progress: string[]; hooks: FakeJobHooks } {
    const hooks = job.spec.run({
      append: (text) => { job.output.push(text) },
      updateProgress: (line) => { job.progress.push(line) },
    })
    return { output: job.output, progress: job.progress, hooks }
  }

  /** A workspace whose last run left a status sidecar, which is what `'auto'` sizes it by. */
  async function sizedWorkspace(filesIndexed: number): Promise<string> {
    return workspace({
      '.codegraph/status.json': JSON.stringify({
        indexedAt: Date.UTC(2026, 10, 3, 1, 57),
        filesIndexed, filesMinified: 0, nodeCount: 5, edgeCount: 3,
        unresolvedCount: 0, unresolvedLikelyInternalCount: 0,
      }),
    })
  }

  /** The text blocks one tool result carries, joined as the model reads them. */
  function resultText(result: { content: readonly { type: string; text?: string }[] }): string {
    return result.content.map(block => (block.type === 'text' ? block.text ?? '' : '')).join('')
  }

  describe('background indexing', () => {
    it('hands a large refresh to a background job and answers with its id', async () => {
      const root = await sizedWorkspace(1000)
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, { jobs: registry.jobs })
      const owner = agent(ctx, root)
      const result = await callIndex(ctx, owner, {})
      expect(result.isError).toBe(false)
      // A job means the call did not index anything itself.
      expect(indexed).toEqual([])
      expect(registry.started).toHaveLength(1)
      expect(registry.started[0]?.spec).toMatchObject({
        owner: owner.id,
        kind: 'codegraph-index',
        label: `codegraph index ${root}`,
      })
      const text = resultText(result)
      expect(text).toContain(`Indexing ${root} in the background as job job-1.`)
      expect(text).toContain('job_output job-1')
    })

    it('indexes synchronously below the auto threshold', async () => {
      const root = await sizedWorkspace(999)
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      expect(registry.started).toHaveLength(0)
      expect(indexed).toEqual([root])
    })

    it('indexes synchronously when no earlier run has sized the workspace', async () => {
      const root = await workspace()
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      expect(registry.started).toHaveLength(0)
      expect(indexed).toEqual([root])
    })

    it('decides "auto" by the configured threshold', async () => {
      const root = await sizedWorkspace(4)
      const registry = fakeJobs()
      const ctx = await mount(root, { backgroundIndexThreshold: 4 }, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      expect(registry.started).toHaveLength(1)
    })

    it('always uses a job when backgroundIndex is true, however small the workspace', async () => {
      const root = await workspace()
      const registry = fakeJobs()
      const ctx = await mount(root, { backgroundIndex: true }, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      expect(registry.started).toHaveLength(1)
      expect(indexed).toEqual([])
    })

    it('never uses a job when backgroundIndex is false, however large the workspace', async () => {
      const root = await sizedWorkspace(5000)
      const registry = fakeJobs()
      const ctx = await mount(root, { backgroundIndex: false }, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      expect(registry.started).toHaveLength(0)
      expect(indexed).toEqual([root])
    })

    it('indexes synchronously when the composition has no jobs service', async () => {
      const root = await sizedWorkspace(5000)
      const ctx = await mount(root)
      await callIndex(ctx, agent(ctx, root), {})
      expect(indexed).toEqual([root])
    })

    it('falls back to a synchronous run when the registry refuses the registration', async () => {
      const root = await sizedWorkspace(5000)
      const registry = fakeJobs({ refuse: true })
      const ctx = await mount(root, undefined, { jobs: registry.jobs })
      const result = await callIndex(ctx, agent(ctx, root), {})
      expect(result.isError).toBe(false)
      expect(indexed).toEqual([root])
      expect(resultText(result)).toContain('files indexed')
    })

    it('runs the job to completion and reports what it wrote', async () => {
      const root = await sizedWorkspace(1000)
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, { jobs: registry.jobs })
      await callIndex(ctx, agent(ctx, root), {})
      const job = registry.started[0] as RecordedJob
      const { output, progress, hooks } = driveJob(job)
      const outcome = await hooks.done
      expect(progress).toEqual([`indexing ${root}`])
      expect(output).toEqual([`Indexed ${root}: 2 files, 5 symbols, 3 relationships.\n`])
      expect(outcome.status).toBe('completed')
      expect(outcome.result).toContain(`Indexed ${root}:`)
      expect(outcome.result).toContain('2 files indexed, 1 skipped, 3 generated files left out.')
    })

    it('reports a failed run through the job instead of throwing', async () => {
      const root = await sizedWorkspace(1000)
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, {
        jobs: registry.jobs,
        index: () => Promise.reject(new Error('stub exploded')),
      })
      await callIndex(ctx, agent(ctx, root), {})
      const { output, hooks } = driveJob(registry.started[0] as RecordedJob)
      const outcome = await hooks.done
      expect(output).toEqual([`codegraph index failed for ${root}: stub exploded\n`])
      expect(outcome).toEqual({ status: 'failed', detail: 'stub exploded' })
    })

    it('reports a non-Error rejection as its string form', async () => {
      const root = await sizedWorkspace(1000)
      const registry = fakeJobs()
      const ctx = await mount(root, undefined, {
        jobs: registry.jobs,
        index: () => Promise.reject('plain string'),
      })
      await callIndex(ctx, agent(ctx, root), {})
      const { output, hooks } = driveJob(registry.started[0] as RecordedJob)
      expect(await hooks.done).toEqual({ status: 'failed', detail: 'plain string' })
      expect(output[0]).toContain('plain string')
    })

    it('stops a running job through its cancellation hook', async () => {
      const root = await sizedWorkspace(1000)
      const registry = fakeJobs()
      let seen: AbortSignal | undefined
      const ctx = await mount(root, undefined, {
        jobs: registry.jobs,
        // Answers only when cancelled, so the job is still running when the hook fires. The up-front
        // check covers the other ordering: the run may start after the abort already happened.
        index: (_projectRoot, signal) => {
          seen = signal
          if (signal?.aborted === true) return Promise.reject(new Error('index aborted'))
          return new Promise((_resolve, reject) => {
            signal?.addEventListener('abort', () => reject(new Error('index aborted')))
          })
        },
      })
      await callIndex(ctx, agent(ctx, root), {})
      const { output, hooks } = driveJob(registry.started[0] as RecordedJob)
      hooks.cancel('the model changed its mind')
      expect(await hooks.done).toEqual({ status: 'failed', detail: 'index aborted' })
      expect(seen?.aborted).toBe(true)
      expect(output).toEqual([`codegraph index failed for ${root}: index aborted\n`])
    })
  })
})

describe('status against a root no store claims', () => {
  async function mountWithoutStore(root: string): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    await ctx.plugin(ToolCodegraph)
    return ctx
  }

  function owner(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-unindexed')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
    const value: Agent = {
      id, options: {}, session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  it('answers indexed:false rather than failing when nothing claims the root', async () => {
    const root = await workspace()
    const ctx = await mountWithoutStore(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('unindexed-status'),
      name: 'codegraph',
      arguments: { operation: 'status' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    const text = result.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(text).toBe(`No index for \`${root}\`. Run codegraph_index to build one.`)
  })
})

describe('remaining display and parsing paths', () => {
  it('counts a repeated task word once, keeping its first spelling', () => {
    expect(taskTerms('Cache cache caching', 5)).toEqual(['caching', 'Cache'])
  })

  it('renders a traced hop whose edge site the indexer never recorded', () => {
    const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
    const text = renderCodegraph({
      project_path: '/repo',
      operation: 'trace',
      from: symbol,
      to: symbol,
      paths: [[{ ...symbol }, { ...symbol, via: 'contains' }]],
    })
    expect(text).toContain('[contains]')
    expect(text).not.toContain('at line')
  })
})

describe('answers a store returns when nothing resolves', () => {
  /** A store whose every operation reports "no such symbol" rather than failing. */
  const EMPTY: Record<string, unknown> = {
    search: { kind: 'search', nodes: [graphNode({ filePath: 'gone.ts' })], total: 1, truncated: false },
    node: { kind: 'node', node: null, incoming: [], outgoing: [], alternatives: [] },
    callers: { kind: 'callers', subject: null, relations: [], total: 0, truncated: false },
    callees: { kind: 'callees', subject: null, relations: [], total: 0, truncated: false },
    impact: { kind: 'impact', subject: null, entries: [], total: 0, truncated: false },
    trace: { kind: 'trace', from: graphNode(), to: null, paths: [] },
    files: { kind: 'files', files: [], total: 0, truncated: false },
  }

  async function mountEmpty(root: string): Promise<Context> {
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('empty'),
      indexes: () => Promise.resolve(true),
      query: ((request: CodegraphRequest) =>
        Promise.resolve(EMPTY[request.operation])) as CodegraphStoreProvider['query'],
    })
    await ctx.plugin(ToolCodegraph)
    return ctx
  }

  function owner(ctx: Context, cwd: string): Agent {
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-empty')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
    const value: Agent = {
      id, options: {}, session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    return value
  }

  it.each([
    ['node', { operation: 'node', symbol: 'gone', include_code: true }],
    ['callers', { operation: 'callers', symbol: 'gone' }],
    ['callees', { operation: 'callees', symbol: 'gone' }],
    ['impact', { operation: 'impact', symbol: 'gone' }],
    ['trace', { operation: 'trace', from: 'main', to: 'gone' }],
  ])('reports %s against an unresolved symbol as a successful answer', async (label, args) => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId(`empty-${label}`),
      name: 'codegraph',
      arguments: args,
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
  })

  it('runs the filtered operations with no filters supplied', async () => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const agentValue = owner(ctx, root)
    for (const args of [{ operation: 'search', query: 'gone' }, { operation: 'files' }]) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`bare-${args.operation}`),
        name: 'codegraph',
        arguments: args,
        agent: agentValue,
      })
      expect(result.isError).toBe(false)
    }
  })

  it('explores a file the index names but the workspace no longer holds', async () => {
    const root = await workspace()
    const ctx = await mountEmpty(root)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('explore-missing'),
      name: 'codegraph',
      arguments: { operation: 'explore', query: 'gone' },
      agent: owner(ctx, root),
    })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('source unavailable for gone.ts')
  })
})

describe('the last shapes a trace answer can take', () => {
  it('renders several routes in the plural', () => {
    const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
    const hop = { ...symbol, via: 'calls', site_line: 2 }
    expect(renderCodegraph({
      project_path: '/repo', operation: 'trace', from: symbol, to: symbol,
      paths: [[{ ...symbol }, hop], [{ ...symbol }, hop]],
    })).toContain('2 paths from main to main')
  })

  it('reports a trace whose origin is the unresolved end', async () => {
    const root = await workspace()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('no-origin'),
      indexes: () => Promise.resolve(true),
      query: (() =>
        Promise.resolve({ kind: 'trace', from: null, to: graphNode(), paths: [] })) as CodegraphStoreProvider['query'],
    })
    await ctx.plugin(ToolCodegraph)
    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-no-origin')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: root })
    const value: Agent = {
      id, options: {}, session,
      inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
      status: 'idle', ctx: scope.ctx,
      followup: () => {}, steer: () => {}, inject: () => {}, send: () => {}, cancel() {},
      runMaintenance: task => task(new AbortController().signal),
      whenIdle: () => Promise.resolve(),
    }
    ctx.agents.register(value)
    const result = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('trace-no-origin'),
      name: 'codegraph',
      arguments: { operation: 'trace', from: 'gone', to: 'main' },
      agent: value,
    })
    expect(result.isError).toBe(false)
    expect(result.content.map(block => block.type === 'text' ? block.text : '').join(''))
      .toContain('No declaration matches')
  })
})

describe('rendering permutations of an otherwise identical answer', () => {
  const symbol = toSymbol(graphNode(), { maxDocstringChars: 100, maxSignatureChars: 100 })
  const relation = { ...symbol, via: 'calls', site_line: 4, site_count: 2 }
  const base = { project_path: '/repo' }

  it('omits the sections a node answer has nothing for', () => {
    const text = renderCodegraph({
      ...base, operation: 'node', symbol, incoming: [], outgoing: [], alternatives: [], code: null,
    })
    expect(text).not.toContain('Also named this')
    expect(text).not.toContain('Reached by:')
    expect(text).not.toContain('Reaches:')
    expect(text).not.toContain('```')
  })

  it('omits the related section when a task matched no neighbours', () => {
    const text = renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [], files: [],
    })
    expect(text).not.toContain('Related:')
  })

  it('renders explored source that carries no start line', () => {
    const text = renderCodegraph({
      ...base, operation: 'explore', total: 1, truncated: false,
      files: [{ path: 'a.ts', symbols: [symbol], code: 'x', truncated: false }],
    })
    expect(text).toContain('  a.ts:')
    expect(text).not.toContain('source truncated')
  })

  it('renders callers whose sites the index placed and counted differently', () => {
    const text = renderCodegraph({
      ...base, operation: 'callers', symbol,
      relations: [{ ...relation, site_count: 1 }],
      total: 1, truncated: false,
    })
    expect(text).toContain('at line 4')
    expect(text).not.toContain('×')
  })

  it('renders a caller the index could not place', () => {
    const text = renderCodegraph({
      ...base, operation: 'callers', symbol,
      relations: [{ ...symbol, via: 'calls', site_count: 1 }],
      total: 1, truncated: false,
    })
    expect(text).not.toContain('at line')
  })

  it('marks truncated source in a task context too', () => {
    const text = renderCodegraph({
      ...base, operation: 'context', task: 'ship', entry_points: [symbol], related: [],
      files: [{ path: 'a.ts', symbols: [], code: 'x', truncated: true }],
    })
    expect(text).toContain('(source truncated)')
  })
})

// ---------------------------------------------------------------------------
// Settings-panel routes and the /codegraph command.
//
// Both surfaces attach through conditional injection, so these tests drive them through a minimal
// stand-in host instead of a full Cordis composition: `inject` runs the callback synchronously with
// the fake child, `effect` runs its body and keeps the disposer. That is exactly the contract the
// production code relies on, and it lets every handler be called directly with a fake request and
// response.
// ---------------------------------------------------------------------------

/** The summary shape `readIndexStatus` accepts. */
const PANEL_STATUS = {
  indexedAt: Date.UTC(2026, 10, 3, 1, 57),
  filesIndexed: 12,
  filesMinified: 3,
  nodeCount: 40,
  edgeCount: 30,
  unresolvedCount: 5,
  unresolvedLikelyInternalCount: 2,
}

/**
 * A fake host context: `inject` executes its callback synchronously with a child that carries the
 * same services, and `effect` runs its body so the registration's disposer can be exercised.
 */
function stubHost(services: Record<string, unknown>, options: { injectThrows?: boolean } = {}): {
  ctx: Context
  disposers: (() => void)[]
  injections: string[][]
} {
  const disposers: (() => void)[] = []
  const injections: string[][] = []
  const child = {
    effect(execute: () => () => void) {
      const disposer = execute()
      disposers.push(disposer)
      return disposer
    },
    ...services,
  }
  const ctx = {
    inject(deps: string[], callback: (value: unknown) => void) {
      injections.push(deps)
      if (options.injectThrows === true) throw new Error('service injection failed')
      callback(child)
    },
    ...services,
  } as unknown as Context
  return { ctx, disposers, injections }
}

/** A fake web server that records the routes it is given. */
function fakeWebServer(): { routes: PanelRoute[]; register(route: PanelRoute): () => void } {
  const routes: PanelRoute[] = []
  return {
    routes,
    register(route: PanelRoute) {
      routes.push(route)
      return () => {
        const index = routes.indexOf(route)
        if (index >= 0) routes.splice(index, 1)
      }
    },
  }
}

/** A fake request; an absent body ends the async iterable immediately. */
function panelRequest(url: string, method = 'GET', body?: string | Buffer): PanelRequest {
  return {
    url,
    method,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield body
    },
  }
}

/** Call the one registered route and collect the answer it wrote. */
async function invokePanel(route: PanelRoute | undefined, req: PanelRequest): Promise<{
  statusCode: number
  headers: Record<string, string>
  body: string
}> {
  if (route === undefined) throw new Error('the panel route was not registered')
  const answer = {
    statusCode: 0,
    headers: {} as Record<string, string>,
    body: '',
    setHeader(name: string, value: string) {
      answer.headers[name] = value
    },
    end(body?: string) {
      answer.body = body ?? ''
    },
  }
  await route.handler(req, answer)
  return answer
}

/** The parsed JSON body of one answer. */
function panelBody(answer: { body: string }): Record<string, unknown> {
  return JSON.parse(answer.body) as Record<string, unknown>
}

/** Register the panel routes over a fake host and hand back the recorded registration. */
function panelSubject(codegraph: Record<string, unknown>, config: PanelConfig = { panel: true }): {
  host: ReturnType<typeof stubHost>
  webServer: ReturnType<typeof fakeWebServer>
  route: PanelRoute | undefined
} {
  const webServer = fakeWebServer()
  const host = stubHost({ webServer, codegraph })
  registerPanelRoutes(host.ctx, config)
  return { host, webServer, route: webServer.routes[0] }
}

/** The URL the browser client requests for one workspace's state. */
function stateUrl(root: string): string {
  return `${PANEL_ROUTE_PREFIX}/state?root=${encodeURIComponent(root)}`
}

describe('the settings-panel routes', () => {
  it('registers one prefix route under the panel prefix and drops it on disposal', () => {
    const webServer = fakeWebServer()
    const host = stubHost({ webServer, codegraph: {} })
    registerPanelRoutes(host.ctx, { panel: true })
    expect(host.injections).toEqual([['webServer']])
    expect(webServer.routes).toHaveLength(1)
    expect(webServer.routes[0]).toMatchObject({ kind: 'prefix', path: PANEL_ROUTE_PREFIX })
    host.disposers.forEach(dispose => dispose())
    expect(webServer.routes).toEqual([])
  })

  it('registers nothing when the panel is turned off in config', () => {
    const webServer = fakeWebServer()
    const host = stubHost({ webServer, codegraph: {} })
    registerPanelRoutes(host.ctx, { panel: false })
    expect(host.injections).toEqual([])
    expect(webServer.routes).toEqual([])
  })

  it('stays out of the way when the service cannot be injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = stubHost({}, { injectThrows: true })
      expect(() => registerPanelRoutes(host.ctx, { panel: true })).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('answers for the open session workspace when the caller names none', async () => {
    // Opening the settings page used to demand the very path the session already knows. With no
    // `root`, the route resolves the newest registered agent's cwd and echoes it back.
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(PANEL_STATUS) })
    const webServer = fakeWebServer()
    const host = stubHost({
      webServer,
      codegraph: {},
      agents: {
        list: () => [
          { session: { header: { cwd: '/somewhere/else' } } },
          { session: { header: { cwd: root } } },
        ],
      },
    })
    registerPanelRoutes(host.ctx, { panel: true })
    const answer = await invokePanel(webServer.routes[0], panelRequest(`${PANEL_ROUTE_PREFIX}/state`))
    expect(answer.statusCode).toBe(200)
    expect(panelBody(answer)).toEqual({ ok: true, root, status: PANEL_STATUS })
  })

  it('still asks for a path when no session has a workspace', async () => {
    const webServer = fakeWebServer()
    // Agents that exist but carry no usable workspace: every shape the lookup has to skip.
    const host = stubHost({
      webServer,
      codegraph: {},
      agents: { list: () => [{ session: { header: {} } }, { session: {} }, {}, { session: { header: { cwd: '  ' } } }] },
    })
    registerPanelRoutes(host.ctx, { panel: true })
    const answer = await invokePanel(webServer.routes[0], panelRequest(`${PANEL_ROUTE_PREFIX}/state`))
    expect(answer.statusCode).toBe(400)
  })

  it('answers a workspace whose summary the indexer wrote', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(PANEL_STATUS) })
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(root)))
    expect(answer.statusCode).toBe(200)
    expect(answer.headers['content-type']).toBe('application/json; charset=utf-8')
    expect(answer.headers['cache-control']).toBe('no-store')
    // The answer echoes the workspace it resolved, so the panel can show it without another round-trip.
    expect(panelBody(answer)).toEqual({ ok: true, root, status: PANEL_STATUS })
  })

  it('tolerates a trailing slash on the route', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(PANEL_STATUS) })
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(`${PANEL_ROUTE_PREFIX}/state/?root=${encodeURIComponent(root)}`))
    expect(answer.statusCode).toBe(200)
  })

  it.each<[string, string]>([
    ['no root parameter', `${PANEL_ROUTE_PREFIX}/state`],
    ['a blank root', `${PANEL_ROUTE_PREFIX}/state?root=%20%20`],
    ['a relative root', `${PANEL_ROUTE_PREFIX}/state?root=${encodeURIComponent('relative/path')}`],
    ['a NUL byte in the root', `${PANEL_ROUTE_PREFIX}/state?root=${encodeURIComponent('/tmp/a\0b')}`],
  ])('answers 400 for %s', async (_label, url) => {
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(url))
    expect(answer.statusCode).toBe(400)
    expect(panelBody(answer)).toEqual({ ok: false, message: 'root 必须是一个存在的绝对路径' })
  })

  it('answers 400 for an absolute path that does not exist', async () => {
    const root = await workspace()
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(join(root, 'missing'))))
    expect(answer.statusCode).toBe(400)
  })

  it('answers 400 for a path that is a file rather than a directory', async () => {
    const root = await workspace({ 'a.ts': 'export {}\n' })
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(join(root, 'a.ts'))))
    expect(answer.statusCode).toBe(400)
  })

  it('tells the user how to create a missing index', async () => {
    const root = await workspace()
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(root)))
    expect(answer.statusCode).toBe(404)
    expect(panelBody(answer)).toEqual({ ok: false, root, message: '这个工作区还没有索引，先跑一次 codegraph_index' })
  })

  it('distinguishes an index built before the summary sidecar existed', async () => {
    const root = await workspace({ '.codegraph/codegraph.db': '' })
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(root)))
    expect(answer.statusCode).toBe(404)
    expect(panelBody(answer)).toEqual({
      ok: false,
      root,
      message: '这个工作区的索引由旧版本构建，没有状态摘要；先跑一次 codegraph_index 重建',
    })
  })

  it('answers 400 for a summary file it cannot parse', async () => {
    const root = await workspace({ '.codegraph/status.json': '{ not json' })
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(stateUrl(root)))
    expect(answer.statusCode).toBe(400)
    expect(panelBody(answer)).toEqual({ ok: false, message: '索引状态文件无法解析，先跑一次 codegraph_index 重建' })
  })

  it('answers 404 for an unknown path and defaults a bare request to GET /', async () => {
    const { route } = panelSubject({})
    const unknown = await invokePanel(route, panelRequest(`${PANEL_ROUTE_PREFIX}/nope`))
    expect(unknown.statusCode).toBe(404)
    expect(panelBody(unknown)).toEqual({ ok: false, message: '未知的面板接口' })
    const bare: PanelRequest = { async *[Symbol.asyncIterator]() {} }
    const defaulted = await invokePanel(route, bare)
    expect(defaulted.statusCode).toBe(404)
    expect(panelBody(defaulted)).toEqual({ ok: false, message: '未知的面板接口' })
  })

  it('turns an unparseable request target into a JSON failure', async () => {
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest('http://[invalid'))
    expect(answer.statusCode).toBe(500)
    expect(panelBody(answer)).toMatchObject({ ok: false })
    expect(String(panelBody(answer).message)).toContain('Invalid URL')
  })

  it('answers 404 for a method the route does not take', async () => {
    const root = await workspace()
    const { route } = panelSubject({})
    const wrongStateMethod = await invokePanel(
      route,
      panelRequest(`${PANEL_ROUTE_PREFIX}/state?root=${encodeURIComponent(root)}`, 'POST'),
    )
    expect(wrongStateMethod.statusCode).toBe(404)
    const wrongReindexMethod = await invokePanel(route, panelRequest(`${PANEL_ROUTE_PREFIX}/reindex`, 'GET'))
    expect(wrongReindexMethod.statusCode).toBe(404)
  })

  it('rebuilds a workspace and reports what the run wrote', async () => {
    const root = await workspace()
    const indexed: string[] = []
    const { route } = panelSubject({
      async index(projectRoot: string) {
        indexed.push(projectRoot)
        return { filesIndexed: 2, nodeCount: 5 }
      },
    })
    const answer = await invokePanel(
      route,
      panelRequest(`${PANEL_ROUTE_PREFIX}/reindex`, 'POST', JSON.stringify({ root })),
    )
    expect(indexed).toEqual([root])
    expect(answer.statusCode).toBe(200)
    expect(panelBody(answer)).toEqual({ ok: true, message: '已重建：2 文件 / 5 符号' })
  })

  it('refuses a second rebuild of the same workspace while the first is in flight', async () => {
    const root = await workspace()
    let release!: () => void
    let started!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const began = new Promise<void>(resolve => { started = resolve })
    let runs = 0
    const { route } = panelSubject({
      async index() {
        runs += 1
        started()
        await gate
        return { filesIndexed: 1, nodeCount: 1 }
      },
    })
    const url = `${PANEL_ROUTE_PREFIX}/reindex`
    const first = invokePanel(route, panelRequest(url, 'POST', JSON.stringify({ root })))
    await began
    const second = await invokePanel(route, panelRequest(url, 'POST', JSON.stringify({ root })))
    expect(second.statusCode).toBe(409)
    expect(panelBody(second)).toEqual({ ok: false, message: '这个工作区正在重建' })
    release()
    expect((await first).statusCode).toBe(200)
    // The in-flight entry is dropped on completion, so the next request is accepted again.
    const third = await invokePanel(route, panelRequest(url, 'POST', JSON.stringify({ root })))
    expect(third.statusCode).toBe(200)
    expect(runs).toBe(2)
  })

  it('reports a failed rebuild without locking the workspace', async () => {
    const root = await workspace()
    let attempts = 0
    const { route } = panelSubject({
      async index() {
        attempts += 1
        if (attempts === 1) throw new Error('disk full')
        return { filesIndexed: 0, nodeCount: 0 }
      },
    })
    const url = `${PANEL_ROUTE_PREFIX}/reindex`
    const failed = await invokePanel(route, panelRequest(url, 'POST', JSON.stringify({ root })))
    expect(failed.statusCode).toBe(500)
    expect(panelBody(failed)).toEqual({ ok: false, message: 'Error: disk full' })
    const retried = await invokePanel(route, panelRequest(url, 'POST', JSON.stringify({ root })))
    expect(retried.statusCode).toBe(200)
  })

  it.each<[string, string | Buffer, string]>([
    ['a body that is not JSON', Buffer.from('not json'), '请求体不是合法 JSON'],
    ['an empty body', '', '请求体不是合法 JSON'],
    ['a body that is not an object', '"root"', 'root 必须是一个存在的绝对路径'],
    ['a null body', 'null', 'root 必须是一个存在的绝对路径'],
    ['a body whose root is not a string', JSON.stringify({ root: 7 }), 'root 必须是一个存在的绝对路径'],
    ['a body whose root is relative', JSON.stringify({ root: 'relative/path' }), 'root 必须是一个存在的绝对路径'],
  ])('answers 400 for %s', async (_label, body, message) => {
    const { route } = panelSubject({})
    const answer = await invokePanel(route, panelRequest(`${PANEL_ROUTE_PREFIX}/reindex`, 'POST', body))
    expect(answer.statusCode).toBe(400)
    expect(panelBody(answer)).toEqual({ ok: false, message })
  })

  it('refuses a request body larger than the contract allows', async () => {
    const { route } = panelSubject({})
    const body = JSON.stringify({ root: '/tmp' }) + 'x'.repeat(64 * 1024)
    const answer = await invokePanel(route, panelRequest(`${PANEL_ROUTE_PREFIX}/reindex`, 'POST', body))
    expect(answer.statusCode).toBe(400)
    expect(panelBody(answer)).toEqual({ ok: false, message: '请求体过大' })
  })

  it('registers both optional surfaces in a real Cordis composition and drops them on disposal', async () => {
    const root = await workspace()
    const ctx = new Context()
    context = ctx
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(LocalFileSystem, { cwd: root })
    await ctx.plugin(Codegraph)
    const routes: PanelRoute[] = []
    ctx.provide('webServer', {
      register(route: PanelRoute) {
        routes.push(route)
        return () => {
          const index = routes.indexOf(route)
          if (index >= 0) routes.splice(index, 1)
        }
      },
    })
    const definitions: CommandDefinition[] = []
    ctx.provide('commands', {
      register(definition: CommandDefinition) {
        definitions.push(definition)
        return () => {
          const index = definitions.indexOf(definition)
          if (index >= 0) definitions.splice(index, 1)
        }
      },
    })
    await ctx.plugin(ToolCodegraph, {})
    await vi.waitFor(() => {
      expect(routes.map(route => route.path)).toEqual([PANEL_ROUTE_PREFIX])
      expect(definitions.map(definition => definition.name)).toEqual([COMMAND_NAME])
    })
    await ctx.fiber.dispose()
    context = undefined
    expect(routes).toEqual([])
    expect(definitions).toEqual([])
  })
})

/** A fake command registry that records the definitions it is given. */
function fakeCommands(): { definitions: CommandDefinition[]; register(definition: CommandDefinition): () => void } {
  const definitions: CommandDefinition[] = []
  return {
    definitions,
    register(definition: CommandDefinition) {
      definitions.push(definition)
      return () => {
        const index = definitions.indexOf(definition)
        if (index >= 0) definitions.splice(index, 1)
      }
    },
  }
}

/** Register the command over a fake host and expose the recorded definition. */
function commandSubject(codegraph: Record<string, unknown>): {
  host: ReturnType<typeof stubHost>
  commands: ReturnType<typeof fakeCommands>
  definition(): CommandDefinition
} {
  const commands = fakeCommands()
  const host = stubHost({ commands, codegraph })
  registerCommands(host.ctx)
  return {
    host,
    commands,
    definition() {
      const found = commands.definitions[0]
      if (found === undefined) throw new Error('the command was not registered')
      return found
    },
  }
}

/** The agent face the command reads its workspace and identity from. */
function commandOwner(cwd: string, id = 'command-agent'): { id: string; session: { header: { cwd: string } } } {
  return { id, session: { header: { cwd } } }
}

/** Call one command handler the way the registry does. */
async function runCommand(
  definition: CommandDefinition,
  rawInput: string,
  options: {
    agent?: { session: { header: { cwd: string } } }
    signal?: AbortSignal
  } = {},
): Promise<CommandResult> {
  return definition.handler({
    rawInput,
    ...options.agent === undefined ? {} : { agent: options.agent },
    ...options.signal === undefined ? {} : { signal: options.signal },
  })
}

describe('the /codegraph command', () => {
  it('surfaces the run to the next prompt assembly, which the command plane never reaches', async () => {
    const root = await workspace()
    const subject = commandSubject({ available: () => Promise.resolve(true), query: () => Promise.resolve({
      kind: 'status', projectRoot: root, fileCount: 2, nodeCount: 5, edgeCount: 3,
      languages: [], formatVersion: 4, indexedAt: Date.UTC(2026, 10, 3, 3, 0),
      staleFileCount: 0, staleFileCountTruncated: false,
    }) })
    const owner = commandOwner(root, 'agent-command')
    const result = await runCommand(subject.definition(), 'status', { agent: owner })
    expect(result.kind).toBe('success')
    const hint = commandRunHint('agent-command')
    expect(hint).toContain('the user ran /codegraph status')
    expect(hint).toContain('已索引：2 文件')
  })

  it('registers one command with its discovery copy and drops it on disposal', () => {
    const subject = commandSubject({})
    expect(subject.host.injections).toEqual([['commands']])
    const definition = subject.definition()
    expect(definition.definitionId).toBe(COMMAND_DEFINITION_ID)
    expect(definition.name).toBe(COMMAND_NAME)
    expect(definition.description).toBe(COMMAND_DESCRIPTION)
    expect(definition.input).toEqual({ hint: COMMAND_INPUT_HINT })
    expect(typeof definition.handler).toBe('function')
    subject.host.disposers.forEach(dispose => dispose())
    expect(subject.commands.definitions).toEqual([])
  })

  it('stays out of the way when the service cannot be injected', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const host = stubHost({}, { injectThrows: true })
      expect(() => registerCommands(host.ctx)).not.toThrow()
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('reports the workspace index as one line', async () => {
    const root = await workspace()
    const calls: unknown[] = []
    const subject = commandSubject({
      async available(projectRoot: string) {
        calls.push(['available', projectRoot])
        return true
      },
      async query(request: unknown) {
        calls.push(['query', request])
        return {
          kind: 'status', projectRoot: root, fileCount: 3, nodeCount: 9, edgeCount: 4, languages: [],
          formatVersion: 4, indexedAt: Date.UTC(2026, 10, 3, 1, 57), staleFileCount: 0, staleFileCountTruncated: false,
        }
      },
    })
    const result = await runCommand(subject.definition(), 'status', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'success', text: '已索引：3 文件 / 9 声明 / 4 关系（2026-11-03T01:57Z）' })
    expect(calls).toEqual([['available', root], ['query', { operation: 'status', projectRoot: root }]])
  })

  it('treats a bare invocation as status', async () => {
    const root = await workspace()
    const calls: string[] = []
    const subject = commandSubject({
      async available() {
        calls.push('available')
        return true
      },
      async query() {
        calls.push('query')
        return {
          kind: 'status', projectRoot: root, fileCount: 1, nodeCount: 1, edgeCount: 0, languages: [],
          formatVersion: 4, indexedAt: null, staleFileCount: 0, staleFileCountTruncated: false,
        }
      },
    })
    const result = await runCommand(subject.definition(), '   ', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'success', text: '已索引：1 文件 / 1 声明 / 0 关系（尚未记录索引时间）' })
    expect(calls).toEqual(['available', 'query'])
  })

  it('points an unindexed workspace at index instead of failing', async () => {
    const root = await workspace()
    let queried = false
    const subject = commandSubject({
      async available() {
        return false
      },
      async query() {
        queried = true
        return undefined
      },
    })
    const result = await runCommand(subject.definition(), 'status', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'success', text: `这个工作区还没有索引：${root}。先跑 /${COMMAND_NAME} index` })
    expect(queried).toBe(false)
  })

  it('surfaces a failed status query as the command error text', async () => {
    const root = await workspace()
    const subject = commandSubject({
      async available() {
        return true
      },
      async query() {
        throw new Error('seam down')
      },
    })
    const result = await runCommand(subject.definition(), 'status', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'error', text: 'Error: seam down' })
  })

  it('rebuilds the workspace and forwards cancellation to the indexer', async () => {
    const root = await workspace()
    const controller = new AbortController()
    const calls: unknown[] = []
    const subject = commandSubject({
      async index(projectRoot: string, signal: AbortSignal | undefined) {
        calls.push([projectRoot, signal])
        return { filesIndexed: 2, nodeCount: 5 }
      },
    })
    const result = await runCommand(subject.definition(), 'index', {
      agent: commandOwner(root),
      signal: controller.signal,
    })
    expect(result).toEqual({ kind: 'success', text: '已重建：2 文件 / 5 符号' })
    expect(calls).toEqual([[root, controller.signal]])
  })

  it('reports a failed rebuild as the command error text', async () => {
    const root = await workspace()
    const subject = commandSubject({
      async index() {
        throw new Error('disk full')
      },
    })
    const result = await runCommand(subject.definition(), 'index', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'error', text: 'Error: disk full' })
  })

  it('lists at most a screenful of indexed files matching a pattern', async () => {
    const root = await workspace()
    const requests: unknown[] = []
    const subject = commandSubject({
      async query(request: unknown) {
        requests.push(request)
        return {
          kind: 'files', total: 5, truncated: false,
          files: [
            { path: 'src/a.ts', language: 'typescript', size: 10, nodeCount: 2, modifiedAt: 1, indexedAt: 2 },
            { path: 'src/b.ts', language: 'typescript', size: 5, nodeCount: 1, modifiedAt: 1, indexedAt: 2 },
          ],
        }
      },
    })
    const result = await runCommand(subject.definition(), 'files *.ts', { agent: commandOwner(root) })
    expect(result).toEqual({
      kind: 'success',
      text: '匹配 *.ts 的已索引文件（显示 2 / 5）：\nsrc/a.ts  typescript  2 声明\nsrc/b.ts  typescript  1 声明',
    })
    expect(requests).toEqual([{ operation: 'files', projectRoot: root, pattern: '*.ts', limit: 10 }])
  })

  it('says so when nothing matches the pattern', async () => {
    const root = await workspace()
    const subject = commandSubject({
      async query() {
        return { kind: 'files', total: 0, truncated: false, files: [] }
      },
    })
    const result = await runCommand(subject.definition(), 'files *.rs', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'success', text: '没有匹配 *.rs 的已索引文件' })
  })

  it('asks for a pattern when files is called without one', async () => {
    const root = await workspace()
    const subject = commandSubject({})
    const result = await runCommand(subject.definition(), 'files', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'error', text: `files 需要一个 pattern。${COMMAND_USAGE}` })
  })

  it('rejects an unknown subcommand with the usage line', async () => {
    const root = await workspace()
    const subject = commandSubject({})
    const result = await runCommand(subject.definition(), 'nope', { agent: commandOwner(root) })
    expect(result).toEqual({ kind: 'error', text: `未知的子命令 "nope"。${COMMAND_USAGE}` })
  })

  it('refuses to guess a workspace when the session has none', async () => {
    const subject = commandSubject({})
    const result = await runCommand(subject.definition(), 'status')
    expect(result).toEqual({
      kind: 'error',
      text: '这个命令需要会话工作区：请在一个绑定了工作区的会话里运行',
    })
  })
})
