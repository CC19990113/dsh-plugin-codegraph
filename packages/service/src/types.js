/**
 * Codegraph seam vocabulary: the graph records, the normalized request and result unions, and the
 * store-provider contract. Types only — the {@link CodegraphError} taxonomy, the branded-id
 * factories, and the `NODE_KINDS` / `EDGE_KINDS` / `LANGUAGES` vocabulary arrays are runtime and
 * live in `index.ts`.
 *
 * Line numbers are one-based and column numbers zero-based, matching the on-disk graph the reference
 * indexer writes; the model-facing tool owns any other display convention. `kind` and `language` are
 * plain strings rather than closed unions because the graph is read from a durable file written by
 * an independently versioned indexer: a record whose kind this build does not know must still reach
 * the model as data, not fail the query. `NODE_KINDS`, `EDGE_KINDS`, and `LANGUAGES` document the
 * values that format defines today.
 * @module dsh-plugin-codegraph-service/types
 */
export {};
//# sourceMappingURL=types.js.map