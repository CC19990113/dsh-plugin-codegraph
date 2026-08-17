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
import { Context, Service } from '@deepseek-ai/cordis';
import { HarnessError } from '@deepseek-ai/dsh-llm';
import type { CodegraphIndexer, CodegraphIndexReport, CodegraphRequest, CodegraphResultFor, CodegraphService, CodegraphStoreProvider } from './types.ts';
export { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from './brand.ts';
export type { CodegraphCalleesRequest, CodegraphCallersRequest, CodegraphEdge, CodegraphFile, CodegraphFilesRequest, CodegraphFilesResult, CodegraphImpactEntry, CodegraphImpactRequest, CodegraphImpactResult, CodegraphIndexer, CodegraphIndexReport, CodegraphNode, CodegraphNodeRequest, CodegraphNodeResult, CodegraphOperation, CodegraphRelation, CodegraphRelationsResult, CodegraphRequest, CodegraphRequestBase, CodegraphResult, CodegraphResultFor, CodegraphSearchRequest, CodegraphSearchResult, CodegraphService, CodegraphStatusRequest, CodegraphStatusResult, CodegraphStoreProvider, CodegraphTraceHop, CodegraphTraceRequest, CodegraphTraceResult, } from './types.ts';
declare module '@deepseek-ai/cordis' {
    interface Context {
        codegraph: CodegraphService;
    }
}
/**
 * Structured code-graph failure. Extends {@link HarnessError} with a stable `code`
 * (`CODEGRAPH_INVALID_PROVIDER`, `CODEGRAPH_CONFLICT`, `CODEGRAPH_UNAVAILABLE`,
 * `CODEGRAPH_UNSUPPORTED_FORMAT`, `CODEGRAPH_MALFORMED_INDEX`, `CODEGRAPH_DISPOSED`,
 * `CODEGRAPH_NO_INDEXER`, …) that callers route on instead of parsing `message`.
 */
export declare class CodegraphError extends HarnessError {
}
/**
 * The declaration categories the on-disk graph format defines. A store may return a kind absent from
 * this list when a newer indexer wrote the graph; consumers treat `kind` as data and use this array
 * only to describe or filter the known vocabulary.
 */
export declare const NODE_KINDS: readonly ["file", "module", "class", "struct", "interface", "trait", "protocol", "function", "method", "property", "field", "variable", "constant", "enum", "enum_member", "type_alias", "namespace", "parameter", "import", "export", "route", "component"];
/**
 * The relationship categories the on-disk graph format defines. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export declare const EDGE_KINDS: readonly ["contains", "calls", "imports", "exports", "extends", "implements", "references", "type_of", "returns", "instantiates", "overrides", "decorates"];
/**
 * The source languages the on-disk graph format labels files with. Open for the same reason as
 * {@link NODE_KINDS}.
 */
export declare const LANGUAGES: readonly ["typescript", "javascript", "tsx", "jsx", "python", "go", "rust", "java", "c", "cpp", "csharp", "php", "ruby", "swift", "kotlin", "dart", "svelte", "vue", "liquid", "pascal", "scala", "lua", "luau", "objc", "yaml", "twig", "xml", "properties", "unknown"];
/**
 * `ctx.codegraph`. Holds the store reservations; selection reads them per query so a store that
 * unloads mid-session stops serving without leaving a stale route behind.
 */
export declare class Codegraph extends Service implements CodegraphService {
    private readonly stores;
    private readonly indexers;
    constructor(ctx: Context);
    registerStore(provider: CodegraphStoreProvider): () => void;
    registerIndexer(provider: CodegraphIndexer): () => void;
    available(projectRoot: string, signal?: AbortSignal): Promise<boolean>;
    index(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexReport>;
    query<R extends CodegraphRequest>(request: R, signal?: AbortSignal): Promise<CodegraphResultFor<R>>;
    /**
     * The one store that indexes `projectRoot`. Every registered store is asked concurrently, so the
     * answer does not depend on registration order; zero and several claimants both throw.
     * @param projectRoot - absolute path of the project root to route to.
     * @param signal - aborts the availability checks.
     * @returns the single claiming store.
     */
    private select;
    /**
     * The one indexer that claims `projectRoot`. Every registered indexer is asked concurrently, so the
     * answer does not depend on registration order; zero and several claimants both throw.
     * @param projectRoot - absolute path of the project root to index.
     * @param signal - aborts the availability checks.
     * @returns the single claiming indexer.
     */
    private selectIndexer;
}
export default Codegraph;
//# sourceMappingURL=index.d.ts.map