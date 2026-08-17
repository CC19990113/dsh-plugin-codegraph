# dsh-plugin-codegraph

Structural code intelligence for [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`).

Gives the agent two tools — `codegraph` and `codegraph_index` — so it can ask **where is this declared**, **who calls it**, **what breaks if I change it**, and **how does one symbol reach another**, answered from a pre-built index instead of from text search.

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

## Why

An agent editing code asks structural questions before it touches anything. The tools it usually has answer them badly or not at all:

- **grep** matches a name inside comments, strings, and unrelated identifiers, and cannot answer "who calls this" at all.
- **LSP** answers precisely, but needs a running server per language, a warm workspace index, and a *cursor position* rather than a name.

A symbol graph answers all of it from one cheap lookup. This plugin ships both halves: a **store** that serves queries from an on-disk graph, and an **indexer** that builds one, so a fresh workspace needs no external tooling.

## What the model gets

Two tools, deliberately separate.

### `codegraph` — ten read-only operations

| Operation | Answers | Required |
|---|---|---|
| `search` | Where is a symbol declared? | `query` |
| `node` | One symbol with its immediate callers and callees | `symbol` |
| `callers` | What calls this? | `symbol` |
| `callees` | What does this call? | `symbol` |
| `impact` | What can a change to this reach? | `symbol` |
| `trace` | How does one symbol reach another? | `from`, `to` |
| `files` | What is indexed, under a directory or glob? | — |
| `status` | How large and how fresh is the index? | — |
| `explore` | Several related declarations with their source | `query` |
| `context` | Everything relevant to a task | `task` |

### `codegraph_index` — build or refresh the graph

Separate from `codegraph` rather than an eleventh operation, because indexing a large workspace takes minutes while a query takes milliseconds, and a tool's timeout budget is fixed per registration. Folding them together would force one budget that is either too tight for a real build or too loose to catch a hung query.

Indexing is always explicit. No query ever triggers it implicitly: a `callers` call that silently took four minutes would be indistinguishable, to the model, from a hung tool.

When no index exists, `status` answers plainly rather than failing — it says there is no index and names `codegraph_index` as the fix. Every other operation fails loudly instead, so an unindexed workspace is never mistaken for an empty one.

## Interoperability with the `codegraph` CLI

The on-disk format is **not ours**. This plugin reads and writes **schema version 4 at `<projectRoot>/.codegraph/codegraph.db`** — the same path and format that [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) writes.

That means:

- **Already using the `codegraph` CLI?** Its index is picked up as-is. Mount the plugin, skip `codegraph_index` entirely, and query.
- **Indexed with this plugin?** The CLI still reads it.
- There is never a second, disagreeing graph for one workspace.

## Language coverage

The bundled indexer parses **TypeScript, TSX, JavaScript, JSX, Python, and Go**. Grammars load lazily — one per language, on first sight of a matching file — so a Go-only workspace never loads a Python grammar.

The **store is format-bound, not language-bound**: a graph built by the `codegraph` CLI over languages this indexer does not parse is still fully queryable. If you need broader indexing coverage today, index with the CLI and query through this plugin.

## Call resolution never guesses

Every call site resolves in a fixed order: an import that lands on an indexed file wins; otherwise a unique workspace-wide name wins; otherwise **no edge is emitted** and the site is recorded as unresolved.

That last rule is deliberate. The model acts on `callers` output, so a confidently wrong caller sends it to edit the wrong file, while a missing caller merely sends it back to text search. The index report's `unresolved_count` makes the size of that gap visible instead of hiding it.

## Install

```sh
# 1. add the plugin to a profile
dsh plugin --profile <name> add dsh-plugin-codegraph
```

```jsonc
// 2. list it in $DSH_HOME/profiles/<name>/package.json
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-codegraph"]
    }
  }
}
```

The bundle mounts all four plugins in one layer. Retune any of them from the profile's own `cordis.patch.yml`, addressing rows by the ids the bundle declares (`codegraph`, `codegraph-sqlite`, `codegraph-tree-sitter`, `codegraph-tool`):

```yaml
- id: codegraph-tree-sitter
  config:
    languages: ['typescript', 'tsx']
    exclude: ['node_modules', 'dist', 'vendor']

- id: codegraph-tool
  config:
    maxLimit: 50
    indexTimeoutMs: 600000
```

## Packages

Installing the bundle is enough; these are listed for anyone composing by hand.

| Package | Role |
|---|---|
| [`dsh-plugin-codegraph`](packages/bundle) | The bundle — depends on the four below and ships the patch layer |
| [`dsh-plugin-codegraph-service`](packages/service) | Service Definition: `ctx.codegraph`, the provider registries, the query vocabulary |
| [`dsh-plugin-codegraph-sqlite`](packages/sqlite) | Service Provider: read-only SQLite store over the on-disk graph |
| [`dsh-plugin-codegraph-tree-sitter`](packages/tree-sitter) | Service Provider: the tree-sitter indexer that writes that graph |
| [`dsh-plugin-codegraph-tool`](packages/tool) | Consumer: the model-facing tools, their bounds, and their rendering |

The split is not ceremony. The seam carries no source text and performs no filesystem access, so a store needs no filesystem capability at all; retrieving a declaration's code composes a graph query with a `ctx.fs` read in the consumer, which is the only role that can reach a remote workspace's files.

## Known limits

- **Freshness is nobody's job.** This builds an index; it does not watch for changes. A file edited after a `codegraph_index` run keeps its old declarations until the next one.
- **The unresolved tail can be large** in a codebase leaning on re-exports or dynamic dispatch. `unresolved_count` measures it.
- **`context` ranks by identifier-term overlap**, so a task phrased without naming any symbol ranks poorly. There is no semantic matching.
- `dsh` itself is in developer preview and iterating fast; expect compatibility-breaking changes.

## Credits

The on-disk graph format — schema version 4 at `.codegraph/codegraph.db` — originates with [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) (MIT), a local-first code-intelligence tool for AI agents. This plugin adopts that format deliberately so the two remain mutually readable; the indexer, store, and tool here are independent implementations written against the DeepSeek Harness plugin model.

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis).

## License

[MIT](LICENSE)
