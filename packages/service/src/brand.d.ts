/**
 * dsh-codegraph's owned branded ids: {@link CodegraphNodeId}, the opaque symbol identity carried by
 * every graph node and edge endpoint; {@link CodegraphStoreId}, the identity a store provider
 * reserves on `ctx.codegraph`; and {@link CodegraphIndexerId}, the identity an indexer provider
 * reserves. The `Branded<B>` primitive lives in `@deepseek-ai/dsh-brand`; keeping each type with its
 * factory here lets `index.ts` re-export all three under one name.
 * @module dsh-plugin-codegraph-service/brand
 */
import type { Branded } from '@deepseek-ai/dsh-brand';
/**
 * Opaque identity of one graph node. The store assigns it; callers pass it back verbatim to follow
 * an edge. Its derivation (a hash of file path and qualified name in the reference format) is a
 * store-private detail no consumer may reconstruct or parse.
 */
export type CodegraphNodeId = Branded<'CodegraphNodeId'>;
/**
 * Brand a string as a {@link CodegraphNodeId}. No validation — a node id is only ever minted by the
 * store that owns the graph it indexes.
 * @param id - the store-assigned node identity.
 * @returns the same string, branded.
 */
export declare function CodegraphNodeId(id: string): CodegraphNodeId;
/** Opaque store-provider identity, reserved at registration and released by the disposer. */
export type CodegraphStoreId = Branded<'CodegraphStoreId'>;
/**
 * Brand a string as a {@link CodegraphStoreId}. No validation — the registry rejects an empty id at
 * registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export declare function CodegraphStoreId(id: string): CodegraphStoreId;
/** Opaque indexer-provider identity, reserved at registration and released by the disposer. */
export type CodegraphIndexerId = Branded<'CodegraphIndexerId'>;
/**
 * Brand a string as a {@link CodegraphIndexerId}. No validation — the registry rejects an empty id at
 * registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export declare function CodegraphIndexerId(id: string): CodegraphIndexerId;
//# sourceMappingURL=brand.d.ts.map