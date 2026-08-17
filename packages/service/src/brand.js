/**
 * dsh-codegraph's owned branded ids: {@link CodegraphNodeId}, the opaque symbol identity carried by
 * every graph node and edge endpoint; {@link CodegraphStoreId}, the identity a store provider
 * reserves on `ctx.codegraph`; and {@link CodegraphIndexerId}, the identity an indexer provider
 * reserves. The `Branded<B>` primitive lives in `@deepseek-ai/dsh-brand`; keeping each type with its
 * factory here lets `index.ts` re-export all three under one name.
 * @module dsh-plugin-codegraph-service/brand
 */
/**
 * Brand a string as a {@link CodegraphNodeId}. No validation — a node id is only ever minted by the
 * store that owns the graph it indexes.
 * @param id - the store-assigned node identity.
 * @returns the same string, branded.
 */
export function CodegraphNodeId(id) {
    return id;
}
/**
 * Brand a string as a {@link CodegraphStoreId}. No validation — the registry rejects an empty id at
 * registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function CodegraphStoreId(id) {
    return id;
}
/**
 * Brand a string as a {@link CodegraphIndexerId}. No validation — the registry rejects an empty id at
 * registration.
 * @param id - the provider's stable identifier.
 * @returns the same string, branded.
 */
export function CodegraphIndexerId(id) {
    return id;
}
//# sourceMappingURL=brand.js.map