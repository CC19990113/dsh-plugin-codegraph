// Local-only smoke against a real workspace indexed by the external codegraph CLI. Self-skips when
// that index is absent, so it never gates CI; it exists to prove the assembled tool answers from an
// index this repository did not create.
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
import * as ToolCodegraph from 'dsh-plugin-codegraph-tool'

// Opt-in: point DSH_CODEGRAPH_LIVE_ROOT at a workspace the external codegraph CLI has indexed.
const WORKSPACE = process.env['DSH_CODEGRAPH_LIVE_ROOT'] ?? ''
const present = WORKSPACE !== '' && existsSync(join(WORKSPACE, '.codegraph/codegraph.db'))

let boot: string | undefined
let context: Context | undefined

afterEach(async () => {
  await context?.fiber.dispose()
  context = undefined
  if (boot !== undefined) await rm(boot, { recursive: true, force: true })
  boot = undefined
})

describe.skipIf(!present)('tool-codegraph against a live external index', () => {
  it('answers every operation from the assembled tool', async () => {
    boot = await mkdtemp(join(tmpdir(), 'dsh-codegraph-live-'))
    const configPath = join(boot, 'cordis.yml')
    await writeFile(configPath, [
      "- name: '@deepseek-ai/dsh-agent'",
      "- name: '@deepseek-ai/dsh-system-prompt'",
      "- name: '@deepseek-ai/dsh-tools'",
      "- name: '@deepseek-ai/dsh-fs-local'",
      '  config:',
      `    cwd: ${JSON.stringify(WORKSPACE)}`,
      "- name: 'dsh-plugin-codegraph-service'",
      "- name: 'dsh-plugin-codegraph-sqlite'",
      "- name: 'dsh-plugin-codegraph-tool'",
      '',
    ].join('\n'))

    const ctx = new Context()
    context = ctx
    ctx.baseUrl = `${pathToFileURL(boot).href}/`
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

    const scope = ctx.plugin(() => {})
    const id = SessionId('codegraph-live')
    const session = Session.create(id, [], { version: SESSION_FORMAT_VERSION, id, createdAt: 0, cwd: WORKSPACE })
    const owner: Agent = {
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
    ctx.agents.register(owner)

    const calls: Record<string, unknown>[] = [
      { operation: 'status' },
      { operation: 'search', query: 'useUrlState', limit: 3 },
      { operation: 'node', symbol: 'useUrlState', limit: 3 },
      { operation: 'callers', symbol: 'useUrlState', limit: 4 },
      { operation: 'callees', symbol: 'AdapterListPage', limit: 4 },
      { operation: 'impact', symbol: 'useUrlState', depth: 2, limit: 4 },
      { operation: 'trace', from: 'AdapterListPage', to: 'useUrlState' },
      { operation: 'files', pattern: 'src/hooks/*', limit: 4 },
      { operation: 'explore', query: 'useUrlState', limit: 3 },
      { operation: 'context', task: 'how does url state sync with the adapter list page' },
    ]
    const transcript: string[] = []
    for (const [index, args] of calls.entries()) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: CallId(`live-${index}`),
        name: 'codegraph',
        arguments: args,
        agent: owner,
      })
      const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('')
      transcript.push(`### ${JSON.stringify(args['operation'])} (isError=${result.isError})\n${text}`)
      expect(result.isError).toBe(false)
    }
    await writeFile(join(tmpdir(), 'dsh-codegraph-live-tool.md'), transcript.join('\n\n'))
  }, 60_000)
})
