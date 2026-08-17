/**
 * Service Definition for the code-graph capability seam (`ctx.codegraph`): a graph-store provider
 * registry and per-query, order-independent selection over eight normalized graph queries —
 * search, node, callers, callees, impact, trace, files, and status — plus a separate graph-indexer
 * provider registry that builds or refreshes a graph on explicit request.
 *
 * A store reserves a branded id at registration and declares which project roots it can serve
 * through {@link CodegraphStoreProvider.indexes}. Selection asks every registered store per query
 * and requires exactly one claimant, so registration and hot-reload order never change routing;
 * zero claimants and several claimants are both loud failures rather than a silent pick. The seam
 * carries no source text and performs no filesystem access: retrieving a declaration's code composes
 * a graph query with a `ctx.fs` read in the consumer, which is the only role that can reach a remote
 * workspace's files.
 *
 * An indexer follows the same one-claimant reservation rule, but {@link CodegraphService.index} is
 * never called from {@link CodegraphService.query}: indexing is a caller-initiated, potentially
 * multi-minute operation, and `query` stays read-only so a store never hides a build behind a call the
 * model expects to return quickly.
 * @module dsh-plugin-codegraph-service
 */

import { Context, Service } from '@deepseek-ai/cordis'
import { HarnessError } from '@deepseek-ai/dsh-llm'
import type { CodegraphIndexerId, CodegraphStoreId } from './brand.ts'
import type {
  CodegraphIndexer,
  CodegraphIndexReport,
  CodegraphRequest,
  CodegraphResultFor,
  CodegraphService,
  CodegraphStoreProvider,
} from './types.ts'

export { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from './brand.ts'
export type {
  CodegraphCalleesRequest,
  CodegraphCallersRequest,
  CodegraphEdge,
  CodegraphFile,
  CodegraphFilesRequest,
  CodegraphFilesResult,
  CodegraphImpactEntry,
  CodegraphImpactRequest,
  CodegraphImpactResult,
  CodegraphIndexer,
  CodegraphIndexReport,
  CodegraphNode,
  CodegraphNodeRequest,
  CodegraphNodeResult,
  CodegraphOperation,
  CodegraphRelation,
  CodegraphRelationsResult,
  CodegraphRequest,
  CodegraphRequestBase,
  CodegraphResult,
  CodegraphResultFor,
  CodegraphSearchRequest,
  CodegraphSearchResult,
  CodegraphService,
  CodegraphStatusRequest,
  CodegraphStatusResult,
  CodegraphStoreProvider,
  CodegraphTraceHop,
  CodegraphTraceRequest,
  CodegraphTraceResult,
} from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    codegraph: CodegraphService
  }
}

/**
 * Structured code-graph failure. Extends {@link HarnessError} with a stable `code`
 * (`CODEGRAPH_INVALID_PROVIDER`, `CODEGRAPH_CONFLICT`, `CODEGRAPH_UNAVAILABLE`,
 * `CODEGRAPH_UNSUPPORTED_FORMAT`, `CODEGRAPH_MALFORMED_INDEX`, `CODEGRAPH_DISPOSED`,
 * `CODEGRAPH_NO_INDEXER`, …) that callers route on instead of parsing `message`.
 */
export class CodegraphError extends HarnessError {}

/**
 * The declaration categories the on-disk graph format defines. A store may return a kind absent from
 * this list when a newer indexer wrote the graph; consumers treat `kind` as data and use this array
 * only to describe or filter the known vocabulary.
 */
export const NODE_KINDS = [
  'file',
  'module',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'function',
  'method',
  'property',
  'field',
  'variable',
  'constant',
  'enum',
  'enum_member',
  'type_alias',
  'namespace',
  'parameter',
  'import',
  'export',
  'route',
  'component',
] as const

/**
 * The relationship categories the on-disk graph format defines. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export const EDGE_KINDS = [
  'contains',
  'calls',
  'imports',
  'exports',
  'extends',
  'implements',
  'references',
  'type_of',
  'returns',
  'instantiates',
  'overrides',
  'decorates',
] as const

/**
 * The source languages the on-disk graph format labels files with. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export const LANGUAGES = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'python',
  'go',
  'rust',
  'java',
  'c',
  'cpp',
  'csharp',
  'php',
  'ruby',
  'swift',
  'kotlin',
  'dart',
  'svelte',
  'vue',
  'liquid',
  'pascal',
  'scala',
  'lua',
  'luau',
  'objc',
  'yaml',
  'twig',
  'xml',
  'properties',
  'unknown',
] as const

/**
 * `ctx.codegraph`. Holds the store reservations; selection reads them per query so a store that
 * unloads mid-session stops serving without leaving a stale route behind.
 */
export class Codegraph extends Service implements CodegraphService {
  private readonly stores = new Map<CodegraphStoreId, CodegraphStoreProvider>()
  private readonly indexers = new Map<CodegraphIndexerId, CodegraphIndexer>()

  constructor(ctx: Context) {
    super(ctx, 'codegraph')
  }

  registerStore(provider: CodegraphStoreProvider): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new CodegraphError('a code-graph store id must be a non-empty string', 'CODEGRAPH_INVALID_PROVIDER')
    }
    if (this.stores.has(id)) {
      throw new CodegraphError(`a code-graph store with id "${id}" is already registered`, 'CODEGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(function* (this: Codegraph) {
      this.stores.set(id, provider)
      yield () => {
        this.stores.delete(id)
      }
    }.bind(this), 'codegraph.registerStore()')
    // ctx.effect's disposer returns Promise<void>; our disposer API is synchronous
    // fire-and-forget — discard the (always-resolved) promise.
    return () => void dispose()
  }

  registerIndexer(provider: CodegraphIndexer): () => void {
    const id = provider.id
    if (id.trim() === '') {
      throw new CodegraphError('a code-graph indexer id must be a non-empty string', 'CODEGRAPH_INVALID_PROVIDER')
    }
    if (this.indexers.has(id)) {
      throw new CodegraphError(`a code-graph indexer with id "${id}" is already registered`, 'CODEGRAPH_CONFLICT')
    }

    const dispose = this.ctx.effect(function* (this: Codegraph) {
      this.indexers.set(id, provider)
      yield () => {
        this.indexers.delete(id)
      }
    }.bind(this), 'codegraph.registerIndexer()')
    return () => void dispose()
  }

  async available(projectRoot: string, signal?: AbortSignal): Promise<boolean> {
    const candidates = [...this.stores.values()]
    const claims = await Promise.all(candidates.map(store => store.indexes(projectRoot, signal)))
    return claims.some(Boolean)
  }

  async index(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexReport> {
    const indexer = await this.selectIndexer(projectRoot, signal)
    return indexer.index(projectRoot, signal)
  }

  async query<R extends CodegraphRequest>(request: R, signal?: AbortSignal): Promise<CodegraphResultFor<R>> {
    return (await this.select(request.projectRoot, signal)).query(request, signal)
  }

  /**
   * The one store that indexes `projectRoot`. Every registered store is asked concurrently, so the
   * answer does not depend on registration order; zero and several claimants both throw.
   * @param projectRoot - absolute path of the project root to route to.
   * @param signal - aborts the availability checks.
   * @returns the single claiming store.
   */
  private async select(projectRoot: string, signal?: AbortSignal): Promise<CodegraphStoreProvider> {
    const candidates = [...this.stores.values()]
    const claims = await Promise.all(candidates.map(store => store.indexes(projectRoot, signal)))
    const claimants = candidates.filter((_, index) => claims[index])
    const [only, rival] = claimants
    if (only === undefined) {
      throw new CodegraphError(`no code-graph store indexes "${projectRoot}"`, 'CODEGRAPH_UNAVAILABLE')
    }
    if (rival !== undefined) {
      const ids = claimants.map(store => store.id).join(', ')
      throw new CodegraphError(`several code-graph stores index "${projectRoot}": ${ids}`, 'CODEGRAPH_CONFLICT')
    }
    return only
  }

  /**
   * The one indexer that claims `projectRoot`. Every registered indexer is asked concurrently, so the
   * answer does not depend on registration order; zero and several claimants both throw.
   * @param projectRoot - absolute path of the project root to index.
   * @param signal - aborts the availability checks.
   * @returns the single claiming indexer.
   */
  private async selectIndexer(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexer> {
    const candidates = [...this.indexers.values()]
    const claims = await Promise.all(candidates.map(indexer => indexer.canIndex(projectRoot, signal)))
    const claimants = candidates.filter((_, index) => claims[index])
    const [only, rival] = claimants
    if (only === undefined) {
      throw new CodegraphError(`no code-graph indexer can index "${projectRoot}"`, 'CODEGRAPH_NO_INDEXER')
    }
    if (rival !== undefined) {
      const ids = claimants.map(indexer => indexer.id).join(', ')
      throw new CodegraphError(`several code-graph indexers can index "${projectRoot}": ${ids}`, 'CODEGRAPH_CONFLICT')
    }
    return only
  }
}

export default Codegraph
