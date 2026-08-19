# dsh-plugin-codegraph

English | [中文](README.zh.md)

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

## Why not just spawn the CLI

A plugin can wrap `@colbymchenry/codegraph`'s own CLI instead of reimplementing the store and indexer: `spawn` it as a subprocess, expose each of its commands as a separate tool, done in an afternoon. This plugin chose not to, for three concrete reasons:

- **No second thing to install.** Shelling out to a CLI means the host needs that binary on `PATH`, at a version the plugin was actually tested against — an extra install step, and an extra way for the two to drift out of sync. `npm install` is the whole story here; the indexer and store run in-process.
- **Fewer tools, not more.** Every tool's schema rides along in the system prompt on every turn, whether or not it gets called that turn. Ten single-purpose tools (one per CLI subcommand) cost more of that budget, every turn, than the two this plugin exposes — `codegraph`'s `operation` field is a dispatch, not a compromise.
- **No incremental reparse, on purpose.** "Sync only the changed files" sounds obviously faster, but the rule this graph resolves calls by — one unique name wins workspace-wide — is global: adding a symbol in file A that collides with one already indexed from file B should invalidate edges that point at B, even though B never changed. A parser that reparses only the touched files and patches in their own new edges has no way to notice that. `codegraph_index` always rebuilds the whole graph instead — cheaper to reparse everything than to get that invalidation wrong — leaving incremental reparse as a future optimization only once it's an actual, measured bottleneck, not a default.

## Language coverage

The bundled indexer parses **TypeScript, TSX, JavaScript, JSX, Python, Go, Java, C, C++, C#, PHP, Rust, Ruby, Zig, Kotlin, Swift, Dart, and Scala**. Grammars load lazily — one per language, on first sight of a matching file — so a Go-only workspace never loads a Python grammar.

The **store is format-bound, not language-bound**: a graph built by the `codegraph` CLI over languages this indexer does not parse is still fully queryable. If you need broader indexing coverage today, index with the CLI and query through this plugin.

## Call resolution never guesses

Every call site resolves in a fixed order: an import that lands on an indexed file wins; otherwise a unique workspace-wide name wins; otherwise **no edge is emitted** and the site is recorded as unresolved.

That last rule is deliberate. The model acts on `callers` output, so a confidently wrong caller sends it to edit the wrong file, while a missing caller merely sends it back to text search. The index report's `unresolved_count` is not, by itself, that gap's size — a type-free resolver was never going to settle a member call (`x.map()`) or a name already imported from elsewhere, and those dominate the total in a typical workspace. `unresolved_likely_internal_count` is the subset worth judging completeness by: bare, undeclared names that were structurally plausible workspace calls.

## Install

```sh
dsh plugin --profile <name> add dsh-plugin-codegraph
```

That one command is the whole install: it fetches the package and reconciles the profile's manifest for you, appending `dsh-plugin-codegraph` to `dsh.profile.bundles`. There is no JSON to edit by hand. Afterwards, `$DSH_HOME/profiles/<name>/package.json` — `$DSH_HOME` defaults to `~/.dsh` — reads like this, shown here so you can check it rather than write it:

```jsonc
{
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "dsh-plugin-codegraph"]
    }
  }
}
```

To confirm the four plugins mounted without spending an API key, run `dsh --profile <name> --dump-default-config`; they appear grouped under a `# == dsh-plugin-codegraph` heading.

The bundle mounts all four plugins in one layer. Retune any of them from the profile's own `cordis.patch.yml`, addressing rows by the ids the bundle declares (`codegraph`, `codegraph-sqlite`, `codegraph-tree-sitter`, `codegraph-tool`):

```yaml
- id: codegraph-tree-sitter
  config:
    languages: ['typescript', 'tsx']
    exclude: ['node_modules', 'dist', 'vendor']
    respectGitignore: true
    watch: true # the default; shown for clarity — set false to keep indexing purely explicit

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

- **Watching is on by default, and self-limiting where it wouldn't help.** A successful `codegraph_index` starts watching that root automatically — a single recursive `fs.watch` on macOS/Windows, one inotify watch per directory on Linux — refreshing the index after a debounced quiet period. Set `watch: false` to keep indexing purely explicit instead. It's overridden back off on a WSL2 kernel watching a path mounted in from the Windows host (`/mnt/<drive>/...`), since inotify doesn't reliably deliver events over that mount; `CODEGRAPH_FORCE_WATCH=1` and `CODEGRAPH_NO_WATCH=1` override that default either way. Whether or not watching is on, `status` still reports how many indexed files have gone stale — modified or removed since the last run — found by statting the filesystem directly, so a caller can always tell a trustworthy index from a drifted one instead of assuming the best.
- **Git hooks and worktree detection ship as library functions only** — `installGitHooks`/`uninstallGitHooks` (a `post-checkout`/`post-merge`/`post-commit`/`post-rewrite` hook running a command of your choosing, for environments where live watching isn't available) and `detectWorktree` (whether a root is a linked `git worktree`, and where its main repository lives). Neither is wired into plugin load or exposed as a model-visible tool: `.git/hooks/*` is shared, ambient state this package doesn't own, so installing it is left to a caller's own init script, never automatic.
- **Exclusion unions the built-in default directories with the project's own `.gitignore`.** Build output that lands outside `node_modules`/`dist`/`build`/`coverage` (a `lib` a TypeScript project compiles to, say) is almost always gitignored too, and indexing it alongside its own source would hand call resolution two same-named declarations of one symbol to pick between arbitrarily. Only a practical subset of gitignore syntax is understood — no `**`, character classes, or per-directory `.gitignore` files. Turn it off with `respectGitignore: false`.
- **The unresolved tail can be large**, and most of it is not a gap. `unresolved_count` includes every member call and already-imported name a type-free resolver could never have settled; `unresolved_likely_internal_count` is the narrower number that reflects re-exports and dynamic dispatch the graph actually missed.
- **`context` ranks by identifier-term overlap**, so a task phrased without naming any symbol ranks poorly. There is no semantic matching.
- `dsh` itself is in developer preview and iterating fast; expect compatibility-breaking changes.

## Credits

The on-disk graph format — schema version 4 at `.codegraph/codegraph.db` — originates with [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) (MIT), a local-first code-intelligence tool for AI agents. This plugin adopts that format deliberately so the two remain mutually readable; the indexer, store, and tool here are independent implementations written against the DeepSeek Harness plugin model.

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis).

## License

[MIT](LICENSE)
