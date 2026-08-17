import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Codegraph, {
  CodegraphError,
  CodegraphIndexerId,
  CodegraphNodeId,
  CodegraphStoreId,
  EDGE_KINDS,
  LANGUAGES,
  NODE_KINDS,
} from '../src/index.ts'
import type { CodegraphIndexer, CodegraphIndexReport, CodegraphRequest, CodegraphStoreProvider } from '../src/index.ts'

const STATUS = {
  kind: 'status' as const,
  projectRoot: '/repo',
  fileCount: 1,
  nodeCount: 2,
  edgeCount: 3,
  languages: [],
  formatVersion: 4,
  indexedAt: null,
}

/** A store that claims the roots it was told to, and answers `status` with a marker. */
function stubStore(id: string, roots: readonly string[]): CodegraphStoreProvider {
  return {
    id: CodegraphStoreId(id),
    indexes: (projectRoot: string) => Promise.resolve(roots.includes(projectRoot)),
    query: ((request: CodegraphRequest) =>
      Promise.resolve({ ...STATUS, projectRoot: `${id}:${request.projectRoot}` })) as CodegraphStoreProvider['query'],
  }
}

async function seam(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(Codegraph)
  return ctx
}

const STATUS_REQUEST = { operation: 'status', projectRoot: '/repo' } as const

describe('codegraph seam', () => {
  it('routes a query to the one store claiming the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/other']))
    const result = await ctx.codegraph.query(STATUS_REQUEST)
    expect(result.projectRoot).toBe('a:/repo')
  })

  it('forwards the caller signal to store selection and query', async () => {
    const ctx = await seam()
    const indexes = vi.fn(() => Promise.resolve(true))
    const query = vi.fn(() => Promise.resolve(STATUS))
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes,
      query: query as unknown as CodegraphStoreProvider['query'],
    })
    const signal = new AbortController().signal
    await ctx.codegraph.query(STATUS_REQUEST, signal)
    expect(indexes).toHaveBeenCalledWith('/repo', signal)
    expect(query).toHaveBeenCalledWith(STATUS_REQUEST, signal)
  })

  it('rejects an empty store id without publishing anything', async () => {
    const ctx = await seam()
    expect(() => ctx.codegraph.registerStore(stubStore('  ', ['/repo'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INVALID_PROVIDER' }))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
  })

  it('rejects a duplicate store id', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    expect(() => ctx.codegraph.registerStore(stubStore('a', ['/elsewhere'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }))
  })

  it('fails loud when no store indexes the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/other']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_UNAVAILABLE' }),
    )
  })

  it('fails loud rather than picking between two stores that claim one root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/a, b/)
  })

  it('releases the reservation when its disposer runs', async () => {
    const ctx = await seam()
    const dispose = ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    await expect(ctx.codegraph.query(STATUS_REQUEST)).resolves.toBeDefined()
    dispose()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
    // The same id is free again, proving the reservation was released rather than merely hidden.
    expect(() => ctx.codegraph.registerStore(stubStore('a', ['/repo']))).not.toThrow()
  })

  it('unregisters a store when its owning fiber unloads', async () => {
    const ctx = await seam()
    const fiber = ctx.plugin({
      inject: ['codegraph'],
      apply(scope: Context) {
        scope.codegraph.registerStore(stubStore('scoped', ['/repo']))
      },
    })
    await fiber.await()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(/no code-graph store indexes/)
  })

  it('brands ids as plain strings', () => {
    expect(CodegraphNodeId('function:1')).toBe('function:1')
    expect(CodegraphStoreId('store')).toBe('store')
  })

  it('publishes the on-disk format vocabulary', () => {
    expect(NODE_KINDS).toContain('function')
    expect(EDGE_KINDS).toContain('calls')
    expect(LANGUAGES).toContain('typescript')
  })
})

/** An indexer that claims the roots it was told to, and reports a marked project root. */
function stubIndexer(id: string, roots: readonly string[]): CodegraphIndexer {
  return {
    id: CodegraphIndexerId(id),
    canIndex: (projectRoot: string) => Promise.resolve(roots.includes(projectRoot)),
    index: (projectRoot: string) => Promise.resolve({
      projectRoot: `${id}:${projectRoot}`,
      filesIndexed: 1,
      filesSkipped: 0,
      nodeCount: 1,
      edgeCount: 0,
      unresolvedCount: 0,
      languages: [],
    } satisfies CodegraphIndexReport),
  }
}

describe('codegraph indexer registry', () => {
  it('runs the one indexer claiming the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    ctx.codegraph.registerIndexer(stubIndexer('b', ['/other']))
    const report = await ctx.codegraph.index('/repo')
    expect(report.projectRoot).toBe('a:/repo')
  })

  it('forwards the caller signal to indexer selection and the run', async () => {
    const ctx = await seam()
    const canIndex = vi.fn(() => Promise.resolve(true))
    const index = vi.fn(() => Promise.resolve({
      projectRoot: '/repo',
      filesIndexed: 0,
      filesSkipped: 0,
      nodeCount: 0,
      edgeCount: 0,
      unresolvedCount: 0,
      languages: [],
    } satisfies CodegraphIndexReport))
    ctx.codegraph.registerIndexer({ id: CodegraphIndexerId('spy'), canIndex, index })
    const signal = new AbortController().signal
    await ctx.codegraph.index('/repo', signal)
    expect(canIndex).toHaveBeenCalledWith('/repo', signal)
    expect(index).toHaveBeenCalledWith('/repo', signal)
  })

  it('rejects an empty indexer id without publishing anything', async () => {
    const ctx = await seam()
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('  ', ['/repo'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_INVALID_PROVIDER' }))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
  })

  it('rejects a duplicate indexer id', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('a', ['/elsewhere'])))
      .toThrow(expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }))
  })

  it('fails loud as CODEGRAPH_NO_INDEXER when no indexer can index the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/other']))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_NO_INDEXER' }),
    )
  })

  it('fails loud rather than picking between two indexers that claim one root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    ctx.codegraph.registerIndexer(stubIndexer('b', ['/repo']))
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/a, b/)
  })

  it('releases the reservation when its disposer runs', async () => {
    const ctx = await seam()
    const dispose = ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))
    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    dispose()
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
    expect(() => ctx.codegraph.registerIndexer(stubIndexer('a', ['/repo']))).not.toThrow()
  })

  it('unregisters an indexer when its owning fiber unloads', async () => {
    const ctx = await seam()
    const fiber = ctx.plugin({
      inject: ['codegraph'],
      apply(scope: Context) {
        scope.codegraph.registerIndexer(stubIndexer('scoped', ['/repo']))
      },
    })
    await fiber.await()
    await expect(ctx.codegraph.index('/repo')).resolves.toBeDefined()
    await fiber.dispose()
    await expect(ctx.codegraph.index('/repo')).rejects.toThrow(/no code-graph indexer can index/)
  })
})

describe('codegraph availability', () => {
  it('reports unavailable when no store claims the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/other']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(false)
  })

  it('reports available when exactly one store claims the root', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(true)
  })

  it('reports available even when several stores claim the root, leaving query to report the conflict', async () => {
    const ctx = await seam()
    ctx.codegraph.registerStore(stubStore('a', ['/repo']))
    ctx.codegraph.registerStore(stubStore('b', ['/repo']))
    await expect(ctx.codegraph.available('/repo')).resolves.toBe(true)
    await expect(ctx.codegraph.query(STATUS_REQUEST)).rejects.toThrow(
      expect.objectContaining<Partial<CodegraphError>>({ code: 'CODEGRAPH_CONFLICT' }),
    )
  })

  it('forwards the caller signal to every store\'s availability check', async () => {
    const ctx = await seam()
    const indexes = vi.fn(() => Promise.resolve(true))
    ctx.codegraph.registerStore({
      id: CodegraphStoreId('spy'),
      indexes,
      query: () => Promise.reject(new Error('not queried')),
    })
    const signal = new AbortController().signal
    await ctx.codegraph.available('/repo', signal)
    expect(indexes).toHaveBeenCalledWith('/repo', signal)
  })
})
