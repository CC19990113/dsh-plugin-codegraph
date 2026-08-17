// Proves the three-package seam works as an assembled application, not just as units: a cordis.yml
// booted through the real Loader mounts the Service Definition, the SQLite store, and this tool,
// and the model-facing `codegraph` tool answers real operations from a real schema-v4 graph on disk.
import { access, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import { CallId } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import Codegraph from 'dsh-plugin-codegraph-service'
import * as FsLocal from '@deepseek-ai/dsh-fs-local'
import * as CodegraphSqlite from 'dsh-plugin-codegraph-sqlite'
import * as CodegraphTreeSitter from 'dsh-plugin-codegraph-tree-sitter'
import * as ToolCodegraph from 'dsh-plugin-codegraph-tool'
import { seedProject } from '../../sqlite/tests/fixture.ts'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'

let root: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

const APP_SOURCE = [
  'export function main() {',
  '  helper()',
  '  helper()',
  '}',
].join('\n')

/** A two-file project whose graph records one caller, one callee, and one unreferenced symbol. */
const SEED = {
  nodes: [
    { id: 'file:src/app.ts', kind: 'file', name: 'app.ts', qualifiedName: 'src/app.ts', filePath: 'src/app.ts', startLine: 1, endLine: 4 },
    { id: 'fn:main', kind: 'function', name: 'main', filePath: 'src/app.ts', startLine: 1, endLine: 4, signature: '()', isExported: true },
    { id: 'fn:helper', kind: 'function', name: 'helper', filePath: 'src/util.ts', startLine: 2, endLine: 4, signature: '(): void', isExported: true, docstring: 'Does the work.' },
    { id: 'import:helper', kind: 'import', name: 'helper', filePath: 'src/app.ts', startLine: 1, endLine: 1 },
    { id: 'fn:orphan', kind: 'function', name: 'orphan', filePath: 'src/util.ts', startLine: 8, endLine: 9 },
  ],
  edges: [
    { source: 'file:src/app.ts', target: 'fn:main', kind: 'contains' },
    { source: 'fn:main', target: 'fn:helper', kind: 'calls', line: 2 },
    { source: 'fn:main', target: 'fn:helper', kind: 'calls', line: 3 },
  ],
  files: [
    { path: 'src/app.ts', nodeCount: 2, text: APP_SOURCE },
    { path: 'src/util.ts', nodeCount: 2, text: 'export function helper(): void {}\n' },
  ],
}

function agent(ctx: Context, cwd: string): Agent {
  const scope = ctx.plugin(() => {})
  const id = SessionId('codegraph-loader-agent')
  const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    followup: () => {},
    steer: () => {},
    inject: () => {},
    send: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function resultText(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

/**
 * Boot a cordis.yml mounting the whole seam over a seeded project.
 * @param projectRoot - the seeded project the filesystem and store resolve against.
 * @param toolConfigLines - YAML lines nested under the tool's `config:` key.
 * @returns the booted context.
 */
async function boot(projectRoot: string, toolConfigLines: readonly string[] = []): Promise<Context> {
  const configPath = join(projectRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(projectRoot)}`,
    "- name: 'dsh-plugin-codegraph-service'",
    "- name: 'dsh-plugin-codegraph-sqlite'",
    "- name: 'dsh-plugin-codegraph-tool'",
    ...toolConfigLines.length > 0 ? ['  config:', ...toolConfigLines] : [],
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(projectRoot).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', FsLocal],
    ['dsh-plugin-codegraph-service', Codegraph],
    ['dsh-plugin-codegraph-sqlite', CodegraphSqlite],
    ['dsh-plugin-codegraph-tool', ToolCodegraph],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

async function call(ctx: Context, owner: Agent, args: Record<string, unknown>, id = 'call') {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: CallId(id),
    name: 'codegraph',
    arguments: args,
    agent: owner,
  })
}

describe('tool-codegraph real Loader composition through cordis.yml', () => {
  it('answers structural questions from a graph on disk', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const status = await call(ctx, owner, { operation: 'status' }, 'status')
    expect(status.isError).toBe(false)
    expect(resultText(status)).toContain('2 files, 5 symbols, 3 relationships')

    const callers = await call(ctx, owner, { operation: 'callers', symbol: 'helper' }, 'callers')
    expect(callers.isError).toBe(false)
    // Two call sites collapse into ONE caller carrying the repeat count.
    expect(resultText(callers)).toContain('src/app.ts:1  function main')
    expect(resultText(callers)).toContain('×2')
    expect(resultText(callers)).toContain('Callers of helper (1)')

    const callees = await call(ctx, owner, { operation: 'callees', symbol: 'main' }, 'callees')
    expect(resultText(callees)).toContain('src/util.ts:2  function helper')

    const none = await call(ctx, owner, { operation: 'callers', symbol: 'orphan' }, 'none')
    expect(none.isError).toBe(false)
    expect(resultText(none)).toContain('none in the index')
  }, 30_000)

  it('resolves a name to its declaration rather than its import', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const result = await call(ctx, owner, { operation: 'node', symbol: 'helper' })
    expect(result.isError).toBe(false)
    const text = resultText(result)
    // `import:helper` shares the name exactly; declaration ranking must still win.
    expect(text.startsWith('src/util.ts:2  function helper')).toBe(true)
    expect(text).toContain('Does the work.')
  }, 30_000)

  it('reads source through ctx.fs for the composed operations', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const result = await call(ctx, owner, { operation: 'explore', query: 'main' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toContain('export function main() {')
  }, 30_000)

  it('traces a call path and reports when none exists', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const found = await call(ctx, owner, { operation: 'trace', from: 'main', to: 'helper' }, 'trace-found')
    expect(resultText(found)).toContain('1 path from main to helper')

    const missing = await call(ctx, owner, { operation: 'trace', from: 'helper', to: 'main' }, 'trace-missing')
    expect(missing.isError).toBe(false)
    expect(resultText(missing)).toContain('No call path from helper to main')
  }, 30_000)

  it('honors a cordis.yml result limit on the model-facing answer', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root, ['    defaultLimit: 1', '    maxLimit: 1'])
    const owner = agent(ctx, root)

    const result = await call(ctx, owner, { operation: 'search', query: 'helper', limit: 50 })
    // The model asked for 50; the deployment's cap decides, and the answer says it was capped.
    expect(resultText(result)).toContain('(1 of 2 shown)')
  }, 30_000)

  it('answers status honestly rather than failing when no store indexes the requested project', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const result = await call(ctx, owner, { operation: 'status', project_path: '/nonexistent/project' })
    expect(result.isError).toBe(false)
    expect(resultText(result)).toBe('No index for `/nonexistent/project`. Run codegraph_index to build one.')
  }, 30_000)

  it('fails loud on every other operation when no store indexes the requested project', async () => {
    root = await seedProject(SEED)
    const ctx = await boot(root)
    const owner = agent(ctx, root)

    const result = await call(ctx, owner, { operation: 'search', query: 'main', project_path: '/nonexistent/project' })
    expect(result.isError).toBe(true)
    expect(resultText(result)).toContain('no code-graph store indexes')
  }, 30_000)
})

/**
 * Boot a cordis.yml mounting the whole seam PLUS the self-built tree-sitter indexer, over a fresh
 * workspace with real source on disk (no pre-seeded graph).
 * @param projectRoot - the fresh workspace the filesystem, indexer, and store all resolve against.
 * @returns the booted context.
 */
async function bootWithIndexer(projectRoot: string): Promise<Context> {
  const configPath = join(projectRoot, 'cordis.yml')
  await writeFile(configPath, [
    "- name: '@deepseek-ai/dsh-agent'",
    "- name: '@deepseek-ai/dsh-system-prompt'",
    "- name: '@deepseek-ai/dsh-tools'",
    "- name: '@deepseek-ai/dsh-fs-local'",
    '  config:',
    `    cwd: ${JSON.stringify(projectRoot)}`,
    "- name: 'dsh-plugin-codegraph-service'",
    "- name: 'dsh-plugin-codegraph-sqlite'",
    "- name: 'dsh-plugin-codegraph-tree-sitter'",
    "- name: 'dsh-plugin-codegraph-tool'",
    '',
  ].join('\n'))

  const ctx = new Context()
  context = ctx
  ctx.baseUrl = `${pathToFileURL(projectRoot).href}/`
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([
    ['@deepseek-ai/dsh-agent', AgentRegistry],
    ['@deepseek-ai/dsh-system-prompt', SystemPrompt],
    ['@deepseek-ai/dsh-tools', ToolRuntime],
    ['@deepseek-ai/dsh-fs-local', FsLocal],
    ['dsh-plugin-codegraph-service', Codegraph],
    ['dsh-plugin-codegraph-sqlite', CodegraphSqlite],
    ['dsh-plugin-codegraph-tree-sitter', CodegraphTreeSitter],
    ['dsh-plugin-codegraph-tool', ToolCodegraph],
  ])
  ctx.loader.internal = {
    version: 'v2',
    async import(specifier: string) {
      if (!modules.has(specifier)) throw new Error(`unexpected Loader import: ${specifier}`)
      return modules.get(specifier)
    },
  } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  return ctx
}

describe('codegraph_index real Loader composition through cordis.yml', () => {
  it('builds a real .codegraph/codegraph.db from source on disk, then answers a query', async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-tool-codegraph-index-'))
    await writeFile(join(root, 'app.ts'), [
      'export function main() {',
      '  helper()',
      '}',
      'export function helper() {}',
      '',
    ].join('\n'))
    const ctx = await bootWithIndexer(root)
    const owner = agent(ctx, root)
    const databasePath = join(root, '.codegraph', 'codegraph.db')

    const before = await call(ctx, owner, { operation: 'status' }, 'before')
    expect(before.isError).toBe(false)
    expect(resultText(before)).toBe(`No index for \`${root}\`. Run codegraph_index to build one.`)
    await expect(access(databasePath)).rejects.toThrow()

    const indexResult = await ctx.tools.execute({
      signal: new AbortController().signal,
      callId: CallId('index'),
      name: 'codegraph_index',
      arguments: {},
      agent: owner,
    })
    expect(indexResult.isError).toBe(false)
    expect(resultText(indexResult)).toContain('files indexed')

    // The tool answered from an on-disk write, not merely an in-memory report: the real file is there.
    await expect(access(databasePath)).resolves.toBeUndefined()

    const after = await call(ctx, owner, { operation: 'status' }, 'after')
    expect(after.isError).toBe(false)
    expect(resultText(after)).toMatch(/^Index for .*\n1 files, \d+ symbols, \d+ relationships\./m)

    const search = await call(ctx, owner, { operation: 'search', query: 'helper' }, 'search')
    expect(resultText(search)).toContain('function helper')
  }, 30_000)
})
