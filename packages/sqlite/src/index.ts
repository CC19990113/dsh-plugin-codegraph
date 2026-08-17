/**
 * SQLite graph store for `ctx.codegraph`. One plugin instance registers one store that answers every
 * seam operation from the on-disk knowledge graph an external `codegraph` indexer writes to
 * `<projectRoot>/.codegraph/codegraph.db`, opening each project read-only and keeping a bounded set
 * of connections warm.
 *
 * The store is host-local by construction: `node:sqlite` opens a path on the machine running the
 * harness, so availability is decided against the host filesystem rather than `ctx.fs`. A workspace
 * that lives in a remote sandbox is not served by this store even when `ctx.fs` can read its files —
 * reporting availability from `ctx.fs` would claim a root the store then fails to open.
 *
 * Namespace plugin (named exports, no default export). Lifecycle is effect-scoped: disposal
 * unregisters from `ctx.codegraph` first, then closes every open connection.
 * @module dsh-plugin-codegraph-sqlite
 */

import { access } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CodegraphStoreId } from 'dsh-plugin-codegraph-service'
import type {
  CodegraphRequest,
  CodegraphResultFor,
  CodegraphStoreProvider,
} from 'dsh-plugin-codegraph-service'
import type {} from 'dsh-plugin-codegraph-service'
import { assertNever } from '@deepseek-ai/dsh-llm'
import { GraphPool, databasePath } from './database.ts'
import { files, impact, node, relations, search, status, trace } from './queries.ts'
import { walkImpact, walkTrace } from './traverse.ts'

export {
  DATABASE_RELATIVE_PATH,
  GraphPool,
  SUPPORTED_FORMAT_VERSION,
  databasePath,
  openGraph,
} from './database.ts'
export { toEdge, toFile, toNode } from './rows.ts'
export { ftsPhrase, likeAnywhere } from './sql.ts'
export { walkImpact, walkTrace, type ImpactHit, type ImpactWalk, type Step, type TraceWalk } from './traverse.ts'

/** Cordis plugin name for loader diagnostics. */
export const name = 'codegraph-sqlite'

/** Services required by this plugin. */
export const inject = ['codegraph']

/** Default branded identity this store reserves on the seam. */
export const DEFAULT_STORE_ID = 'codegraph-sqlite'

/** Default number of project databases kept open at once. */
export const DEFAULT_MAX_OPEN_DATABASES = 4

/** Default ceiling on distinct nodes one `impact` or `trace` walk may visit. */
export const DEFAULT_MAX_TRAVERSAL_NODES = 20_000

/** Plugin configuration: store identity and the bounds the seam's requests cannot express. */
export interface Config {
  /**
   * Branded identity to reserve on `ctx.codegraph`. Give each instance its own id when mounting
   * more than one, so a duplicate registration fails at load instead of shadowing the first store.
   */
  storeId?: string
  /**
   * Largest number of project databases held open at once (default 4). The least recently queried
   * connection closes when the limit is exceeded; a project queried again simply reopens.
   */
  maxOpenDatabases?: number
  /**
   * Largest number of distinct nodes one `impact` or `trace` walk may visit (default 20000). A
   * request's `depth`, `limit`, and `maxPaths` bound the answer; this bounds the work, so a query
   * against a large monorepo returns a truncated answer instead of running unboundedly.
   */
  maxTraversalNodes?: number
}

export const Config: z<Config> = z.object({
  storeId: z.string().default(DEFAULT_STORE_ID),
  maxOpenDatabases: z.number().default(DEFAULT_MAX_OPEN_DATABASES),
  maxTraversalNodes: z.number().default(DEFAULT_MAX_TRAVERSAL_NODES),
})

type ResolvedConfig = Required<Config>

/**
 * Register the SQLite graph store.
 * @param ctx - the plugin context (must inject `codegraph`).
 * @param config - the resolved plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveInteger('maxOpenDatabases', resolved.maxOpenDatabases)
  assertPositiveInteger('maxTraversalNodes', resolved.maxTraversalNodes)

  const pool = new GraphPool(resolved.maxOpenDatabases)
  const store: CodegraphStoreProvider = {
    id: CodegraphStoreId(resolved.storeId),
    async indexes(projectRoot) {
      try {
        await access(databasePath(projectRoot))
        return true
      } catch {
        // Only the existence probe runs in the try. Any rejection — missing file, missing
        // directory, or no permission to look — means this store cannot serve the root, which is
        // the answer the seam asked for rather than a failure to report.
        return false
      }
    },
    query<R extends CodegraphRequest>(request: R): Promise<CodegraphResultFor<R>> {
      return Promise.resolve(run(pool, resolved, request))
    },
  }

  ctx.effect(function* () {
    // Registered first, so it disposes LAST: the store unregisters before its connections close,
    // and no query can be routed to a pool that is already shut.
    yield () => {
      pool.close()
    }
    yield ctx.codegraph.registerStore(store)
  }, 'codegraph-sqlite')
}

/**
 * Answer one request from the pooled connection for its project root.
 * @param pool - the store's connection pool.
 * @param config - the resolved plugin configuration.
 * @param request - the normalized seam request.
 * @returns the result member matching `request.operation`.
 */
function run<R extends CodegraphRequest>(
  pool: GraphPool,
  config: ResolvedConfig,
  request: R,
): CodegraphResultFor<R> {
  const db = pool.acquire(request.projectRoot)
  switch (request.operation) {
    case 'search':
      return search(db, request) as CodegraphResultFor<R>
    case 'node':
      return node(db, request) as CodegraphResultFor<R>
    case 'callers':
    case 'callees':
      return relations(db, request) as CodegraphResultFor<R>
    case 'impact':
      return impact(db, request, (origin, depth) =>
        walkImpact(db, origin, depth, config.maxTraversalNodes)) as CodegraphResultFor<R>
    case 'trace':
      return trace(db, request, (from, to, maxDepth, maxPaths) =>
        walkTrace(db, from, to, maxDepth, maxPaths, config.maxTraversalNodes)) as CodegraphResultFor<R>
    case 'files':
      return files(db, request) as CodegraphResultFor<R>
    case 'status':
      return status(db, request.projectRoot) as CodegraphResultFor<R>
    /* v8 ignore next -- exhaustive over the seam's closed operation union; unreachable. */
    default:
      return assertNever(request, 'codegraph-sqlite request')
  }
}

/** Reject a non-positive-integer config value at load, so misconfiguration fails loud. */
function assertPositiveInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`codegraph-sqlite: ${field} must be a positive integer`)
  }
}
