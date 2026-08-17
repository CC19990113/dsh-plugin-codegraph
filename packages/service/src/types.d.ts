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
import type { CodegraphIndexerId, CodegraphNodeId, CodegraphStoreId } from './brand.ts';
/**
 * One symbol in the graph: a declaration site with its position, modifiers, and documentation. Every
 * field except the optional ones is present for every node the store returns; a store normalizes a
 * missing durable value to the empty array or `false` rather than surfacing null.
 */
export interface CodegraphNode {
    /** Opaque store-assigned identity; pass it back verbatim to follow an edge. */
    readonly id: CodegraphNodeId;
    /** Declaration category, e.g. `function`, `class`, `interface`. See `NODE_KINDS`. */
    readonly kind: string;
    /** Simple declared name, e.g. `calculateTotal`. */
    readonly name: string;
    /** Disambiguated name including its container, e.g. `src/utils.ts::MathHelper.calculateTotal`. */
    readonly qualifiedName: string;
    /** Declaring file, relative to the project root the store indexed. */
    readonly filePath: string;
    /** Source language of the declaring file. See `LANGUAGES`. */
    readonly language: string;
    /** One-based first line of the declaration. */
    readonly startLine: number;
    /** One-based last line of the declaration. */
    readonly endLine: number;
    /** Zero-based column the declaration starts at. */
    readonly startColumn: number;
    /** Zero-based column the declaration ends at. */
    readonly endColumn: number;
    /** Attached documentation comment, when the indexer captured one. */
    readonly docstring?: string;
    /** Declared signature, when the indexer captured one. */
    readonly signature?: string;
    /** Declared visibility, when the language expresses one (`public`, `private`, …). */
    readonly visibility?: string;
    /** Whether the declaration is exported from its module. */
    readonly isExported: boolean;
    /** Whether the declaration is asynchronous. */
    readonly isAsync: boolean;
    /** Whether the declaration is static. */
    readonly isStatic: boolean;
    /** Whether the declaration is abstract. */
    readonly isAbstract: boolean;
    /** Decorators or annotations applied to the declaration; empty when none. */
    readonly decorators: readonly string[];
    /** Generic type parameters declared on the symbol; empty when none. */
    readonly typeParameters: readonly string[];
    /** Epoch milliseconds when the indexer last wrote this node. */
    readonly updatedAt: number;
}
/**
 * One directed relationship between two nodes. `line` and `column` locate the relationship's site
 * (the call site for a `calls` edge), which differs from either endpoint's declaration position.
 */
export interface CodegraphEdge {
    /** Node the relationship originates from. */
    readonly source: CodegraphNodeId;
    /** Node the relationship points at. */
    readonly target: CodegraphNodeId;
    /** Relationship category, e.g. `calls`, `contains`, `imports`. See `EDGE_KINDS`. */
    readonly kind: string;
    /** One-based line of the relationship's site, when the indexer recorded one. */
    readonly line?: number;
    /** Zero-based column of the relationship's site, when the indexer recorded one. */
    readonly column?: number;
    /** How the indexer derived the edge, e.g. `tree-sitter`, `heuristic`. */
    readonly provenance?: string;
}
/**
 * One related node paired with the edge that reached it. `callers` and `callees` return these so a
 * caller has both the related declaration and a site linking them, without a second query.
 *
 * Relations are DISTINCT per related node and relationship kind: a function that calls another five
 * times is one relation with `siteCount: 5`, not five relations. "Which declarations are involved"
 * is the question these operations answer, and counting sites instead would let one repetitive
 * caller consume the whole result limit while other callers went unreported.
 */
export interface CodegraphRelation {
    /** The node at the far end of {@link edge}. */
    readonly node: CodegraphNode;
    /** The earliest-positioned relationship of its kind reaching {@link node}. */
    readonly edge: CodegraphEdge;
    /** How many relationships of this kind connect the two nodes; at least 1. */
    readonly siteCount: number;
}
/** One indexed file and the extraction outcome recorded for it. */
export interface CodegraphFile {
    /** File path relative to the project root. */
    readonly path: string;
    /** Detected source language. See `LANGUAGES`. */
    readonly language: string;
    /** File size in bytes at index time. */
    readonly size: number;
    /** Number of nodes the indexer extracted from the file. */
    readonly nodeCount: number;
    /** Epoch milliseconds of the file's modification time at index time. */
    readonly modifiedAt: number;
    /** Epoch milliseconds when the indexer last processed the file. */
    readonly indexedAt: number;
}
/**
 * One hop of a {@link CodegraphTraceResult} path: the node reached and the edge that reached it. The
 * first hop of every path carries the path's origin node and no edge.
 */
export interface CodegraphTraceHop {
    /** The node this hop reaches. */
    readonly node: CodegraphNode;
    /** The edge traversed to reach {@link node}; absent on a path's first hop. */
    readonly edge?: CodegraphEdge;
}
/**
 * The eight primitive graph queries the seam exposes. A closed union: adding an operation is a
 * compile-enforced change across the seam, its stores, and every consumer. Source-text retrieval and
 * task-level aggregation are deliberately absent — they compose these primitives with a filesystem
 * read, which a graph store neither owns nor can perform for a remote workspace.
 */
export type CodegraphOperation = 'search' | 'node' | 'callers' | 'callees' | 'impact' | 'trace' | 'files' | 'status';
/**
 * Fields every request carries. `projectRoot` selects which indexed project the query runs against
 * and is always caller-supplied: a store never falls back to a process working directory.
 */
export interface CodegraphRequestBase {
    /** Absolute path of the indexed project root to query. */
    readonly projectRoot: string;
}
/** Find declarations whose name, qualified name, documentation, or signature matches `query`. */
export interface CodegraphSearchRequest extends CodegraphRequestBase {
    readonly operation: 'search';
    /** The symbol name or partial name to match. */
    readonly query: string;
    /** Restrict results to this node kind when set. See `NODE_KINDS`. */
    readonly kind?: string;
    /** Restrict results to this language when set. See `LANGUAGES`. */
    readonly language?: string;
    /** Largest number of nodes to return; the store reports whether it truncated. */
    readonly limit: number;
}
/** Resolve one symbol by name and return it with its immediate incoming and outgoing edges. */
export interface CodegraphNodeRequest extends CodegraphRequestBase {
    readonly operation: 'node';
    /** Simple or qualified name to resolve. */
    readonly symbol: string;
    /** Largest number of related nodes to return on each side of the resolved symbol. */
    readonly limit: number;
}
/** Find the declarations that call `symbol`. */
export interface CodegraphCallersRequest extends CodegraphRequestBase {
    readonly operation: 'callers';
    /** Simple or qualified name of the called symbol. */
    readonly symbol: string;
    /** Largest number of callers to return; the store reports whether it truncated. */
    readonly limit: number;
}
/** Find the declarations `symbol` calls. */
export interface CodegraphCalleesRequest extends CodegraphRequestBase {
    readonly operation: 'callees';
    /** Simple or qualified name of the calling symbol. */
    readonly symbol: string;
    /** Largest number of callees to return; the store reports whether it truncated. */
    readonly limit: number;
}
/** Walk incoming edges transitively to enumerate what a change to `symbol` can reach. */
export interface CodegraphImpactRequest extends CodegraphRequestBase {
    readonly operation: 'impact';
    /** Simple or qualified name of the symbol being changed. */
    readonly symbol: string;
    /** Largest number of edge hops to traverse outward from the symbol. */
    readonly depth: number;
    /** Largest number of affected nodes to return; the store reports whether it truncated. */
    readonly limit: number;
}
/** Find directed paths from one symbol to another through the call and containment graph. */
export interface CodegraphTraceRequest extends CodegraphRequestBase {
    readonly operation: 'trace';
    /** Simple or qualified name the flow starts at. */
    readonly from: string;
    /** Simple or qualified name the flow should reach. */
    readonly to: string;
    /** Largest number of hops a returned path may contain. */
    readonly maxDepth: number;
    /** Largest number of distinct paths to return. */
    readonly maxPaths: number;
}
/** List indexed files, optionally restricted to a subtree or glob pattern. */
export interface CodegraphFilesRequest extends CodegraphRequestBase {
    readonly operation: 'files';
    /** Restrict results to files under this project-relative directory when set. */
    readonly path?: string;
    /** Restrict results to paths matching this glob pattern when set. */
    readonly pattern?: string;
    /** Largest number of files to return; the store reports whether it truncated. */
    readonly limit: number;
}
/** Report index size, coverage, and freshness. */
export interface CodegraphStatusRequest extends CodegraphRequestBase {
    readonly operation: 'status';
}
/** A caller's normalized query: one member per {@link CodegraphOperation}. */
export type CodegraphRequest = CodegraphSearchRequest | CodegraphNodeRequest | CodegraphCallersRequest | CodegraphCalleesRequest | CodegraphImpactRequest | CodegraphTraceRequest | CodegraphFilesRequest | CodegraphStatusRequest;
/** Matching declarations, ordered by the store's relevance ranking. */
export interface CodegraphSearchResult {
    readonly kind: 'search';
    /** Matching nodes, most relevant first. */
    readonly nodes: readonly CodegraphNode[];
    /** Matches the store found before applying the request's limit. */
    readonly total: number;
    /** Whether {@link total} exceeded the request's limit. */
    readonly truncated: boolean;
}
/**
 * One resolved symbol with its immediate neighbourhood. `node` is `null` when no declaration
 * matches, which is an ordinary answer rather than a failure.
 */
export interface CodegraphNodeResult {
    readonly kind: 'node';
    /** The resolved declaration, or `null` when the name matches nothing. */
    readonly node: CodegraphNode | null;
    /** Declarations that reach {@link node} by one edge. */
    readonly incoming: readonly CodegraphRelation[];
    /** Declarations {@link node} reaches by one edge. */
    readonly outgoing: readonly CodegraphRelation[];
    /** Other declarations sharing the requested name, when the name was ambiguous. */
    readonly alternatives: readonly CodegraphNode[];
}
/** Callers or callees of one symbol, discriminated by which direction was queried. */
export interface CodegraphRelationsResult {
    readonly kind: 'callers' | 'callees';
    /** The symbol the relations were resolved against, or `null` when the name matches nothing. */
    readonly subject: CodegraphNode | null;
    /** The related declarations with their call sites. */
    readonly relations: readonly CodegraphRelation[];
    /** Relations the store found before applying the request's limit. */
    readonly total: number;
    /** Whether {@link total} exceeded the request's limit. */
    readonly truncated: boolean;
}
/** One node reached by an impact walk, with the hop distance that reached it. */
export interface CodegraphImpactEntry {
    /** The affected declaration. */
    readonly node: CodegraphNode;
    /** Number of hops from the queried symbol; `1` is a direct dependent. */
    readonly distance: number;
    /** The relationship kind that reached this node on the shortest walk found. */
    readonly via: string;
}
/** Everything a change to one symbol can reach, ordered by increasing hop distance. */
export interface CodegraphImpactResult {
    readonly kind: 'impact';
    /** The symbol the walk started from, or `null` when the name matches nothing. */
    readonly subject: CodegraphNode | null;
    /** Affected declarations, nearest first. */
    readonly entries: readonly CodegraphImpactEntry[];
    /** Affected declarations found before applying the request's limit. */
    readonly total: number;
    /** Whether {@link total} exceeded the request's limit. */
    readonly truncated: boolean;
}
/** Directed paths between two symbols; an empty `paths` means no static path was found. */
export interface CodegraphTraceResult {
    readonly kind: 'trace';
    /** The origin declaration, or `null` when the name matches nothing. */
    readonly from: CodegraphNode | null;
    /** The destination declaration, or `null` when the name matches nothing. */
    readonly to: CodegraphNode | null;
    /** Each path from origin to destination, shortest first. */
    readonly paths: readonly (readonly CodegraphTraceHop[])[];
}
/** Indexed files matching the request's filters. */
export interface CodegraphFilesResult {
    readonly kind: 'files';
    /** Matching files, ordered by path. */
    readonly files: readonly CodegraphFile[];
    /** Matching files found before applying the request's limit. */
    readonly total: number;
    /** Whether {@link total} exceeded the request's limit. */
    readonly truncated: boolean;
}
/** Index size, language coverage, and the format version the store read. */
export interface CodegraphStatusResult {
    readonly kind: 'status';
    /** Absolute path of the indexed project root. */
    readonly projectRoot: string;
    /** Number of indexed files. */
    readonly fileCount: number;
    /** Number of graph nodes. */
    readonly nodeCount: number;
    /** Number of graph edges. */
    readonly edgeCount: number;
    /** Node counts per language, most files first. */
    readonly languages: readonly {
        readonly language: string;
        readonly fileCount: number;
    }[];
    /** The on-disk graph format version the store read. */
    readonly formatVersion: number;
    /** Epoch milliseconds of the most recent index write, or `null` when nothing is indexed. */
    readonly indexedAt: number | null;
}
/**
 * A store's answer: a CLOSED discriminated union whose `kind` matches the requested operation, so
 * consumers `switch` to exhaustiveness and a new operation breaks compilation until handled.
 */
export type CodegraphResult = CodegraphSearchResult | CodegraphNodeResult | CodegraphRelationsResult | CodegraphImpactResult | CodegraphTraceResult | CodegraphFilesResult | CodegraphStatusResult;
/** The result member a given request produces, so `query()` narrows without a caller-side cast. */
export type CodegraphResultFor<R extends CodegraphRequest> = R extends CodegraphSearchRequest ? CodegraphSearchResult : R extends CodegraphNodeRequest ? CodegraphNodeResult : R extends CodegraphCallersRequest | CodegraphCalleesRequest ? CodegraphRelationsResult : R extends CodegraphImpactRequest ? CodegraphImpactResult : R extends CodegraphTraceRequest ? CodegraphTraceResult : R extends CodegraphFilesRequest ? CodegraphFilesResult : CodegraphStatusResult;
/**
 * A graph store: it owns one on-disk or in-memory index format and answers every operation over it.
 * A store is registered once and serves any project root it recognizes; {@link indexes} reports
 * whether a root is available WITHOUT opening the graph, so the seam can fail a query loudly instead
 * of routing it into a store that has nothing to read.
 */
export interface CodegraphStoreProvider {
    /** Opaque identity reserved at registration; releasing it is the disposer's job. */
    readonly id: CodegraphStoreId;
    /**
     * Whether this store has an index for `projectRoot`.
     * @param projectRoot - absolute path of the project root to test.
     * @param signal - aborts the availability check.
     * @returns true when {@link query} can serve this root.
     */
    indexes(projectRoot: string, signal?: AbortSignal): Promise<boolean>;
    /**
     * Answer one query against the store's index.
     * @param request - the normalized query, with every bound already resolved by the caller.
     * @param signal - aborts the query.
     * @returns the result member matching `request.operation`.
     */
    query<R extends CodegraphRequest>(request: R, signal?: AbortSignal): Promise<CodegraphResultFor<R>>;
}
/** What one indexing run produced, returned to the caller that requested it. */
export interface CodegraphIndexReport {
    /** Absolute path of the project root that was indexed. */
    readonly projectRoot: string;
    /** Files parsed and written to the graph. */
    readonly filesIndexed: number;
    /** Files skipped (too large, over the file-count ceiling, or excluded). */
    readonly filesSkipped: number;
    /** Declaration nodes written. */
    readonly nodeCount: number;
    /** Relationship edges written. */
    readonly edgeCount: number;
    /** Call sites whose callee could not be resolved to exactly one declaration. */
    readonly unresolvedCount: number;
    /** Node counts per language, most files first. */
    readonly languages: readonly {
        readonly language: string;
        readonly fileCount: number;
    }[];
}
/**
 * A graph indexer: it builds or refreshes an on-disk graph for a project root. Indexing is explicit
 * and caller-initiated — a provider never runs itself from {@link CodegraphService.query}, because a
 * multi-minute build does not belong inside a call the model expects to return quickly.
 */
export interface CodegraphIndexer {
    /** Opaque identity reserved at registration; releasing it is the disposer's job. */
    readonly id: CodegraphIndexerId;
    /**
     * Whether this indexer can build a graph for `projectRoot`.
     * @param projectRoot - absolute path of the project root to test.
     * @param signal - aborts the check.
     * @returns true when {@link index} can run against this root.
     */
    canIndex(projectRoot: string, signal?: AbortSignal): Promise<boolean>;
    /**
     * Build or refresh the graph, replacing whatever was there.
     * @param projectRoot - absolute path of the project root to index.
     * @param signal - aborts the run.
     * @returns a summary of what the run produced.
     */
    index(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexReport>;
}
/** `ctx.codegraph`: the store registry, the indexer registry, and the query entry point. */
export interface CodegraphService {
    /**
     * Register a graph store.
     * @param provider - the store to publish, carrying an unused branded id.
     * @returns a disposer releasing the reservation; disposed with the calling fiber.
     */
    registerStore(provider: CodegraphStoreProvider): () => void;
    /**
     * Register a graph indexer.
     * @param provider - the indexer to publish, carrying an unused branded id.
     * @returns a disposer releasing the reservation; disposed with the calling fiber.
     */
    registerIndexer(provider: CodegraphIndexer): () => void;
    /**
     * Whether any registered store already claims `projectRoot`, without opening it. Lets a caller
     * distinguish "not indexed" from "query failed" without catching {@link query}'s error.
     * @param projectRoot - absolute path of the project root to check.
     * @param signal - aborts the check.
     * @returns true when {@link query} can serve this root right now.
     */
    available(projectRoot: string, signal?: AbortSignal): Promise<boolean>;
    /**
     * Run the single indexer that claims `projectRoot`.
     * @param projectRoot - absolute path of the project root to index.
     * @param signal - aborts the run.
     * @returns the report the indexer produced.
     */
    index(projectRoot: string, signal?: AbortSignal): Promise<CodegraphIndexReport>;
    /**
     * Route one query to the store that indexes `request.projectRoot`.
     * @param request - the normalized query.
     * @param signal - aborts store selection and the query.
     * @returns the result member matching `request.operation`.
     */
    query<R extends CodegraphRequest>(request: R, signal?: AbortSignal): Promise<CodegraphResultFor<R>>;
}
//# sourceMappingURL=types.d.ts.map