# dsh-plugin-codegraph

English | [中文](README.zh.md)

[![dshfind](https://dshfind.com/api/badge/CC19990113/dsh-plugin-codegraph?lang=zh)](https://dshfind.com/zh/plugins/CC19990113/dsh-plugin-codegraph?ref=badge)

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

The tool also reports its own state into the system prompt. Every prompt assembly carries one line describing the workspace's index — how many files, declarations and relationships it holds, when it was built, and how many generated artifacts were left out — or, when there is none, that `codegraph_index` has to run first. That line is a section whose text is a function, re-evaluated per request by the host; nothing is spent on a `status` round-trip to learn it.

**Re-indexing parses only what changed.** Every successful run leaves the extraction it produced for each file in `.codegraph/cache/`; the next run — a second `codegraph_index`, or a watch rebuild after one edit — confirms each file by its recorded modification time and size and reuses its extraction instead of reading and parsing it again. On a 337-file workspace measured here, a repeat run cost 45 ms against 991 ms for the first. Edges and call resolution are still rebuilt over the whole graph every time, deliberately: the rule that resolves a call by a workspace-unique name is global, so a symbol added in one file can invalidate edges pointing at another that never changed. `cacheVerify: 'hash'` trades that speed for correctness when a checkout can restore an older file without moving its mtime.

**A large workspace indexes in the background.** `codegraph_index` estimates the job from the previous run's summary: at or past `backgroundIndexThreshold` files it hands the run to the host's job registry and returns a job id immediately, instead of holding a tool call open for minutes. `job_output <id>` reads the report; `job_kill <id>` stops it. Small workspaces keep the synchronous path, so the common case never pays for a job round-trip. Set `backgroundIndex: true` or `false` to override the estimate.

**A new session starts with an index.** When an agent is created for a workspace that has no index yet, the plugin starts one in the background through the host's job registry, so the first structural question already has a graph to answer from instead of spending three round trips on `status` → `codegraph_index` → retry. A workspace that already has an index is left alone (the watcher maintains it), and a host without a job registry skips the auto-build rather than blocking session creation.

**Chinese task descriptions get English candidates.** `context` ranks by identifier overlap, and a task written in Chinese names no identifiers — measured on a React admin workspace, 「修改报表页的分页与筛选参数」 returned nothing at all. A built-in table now maps frequent Chinese development words to identifier candidates (报表 → `report`, 分页 → `page`/`pageSize`/`pagination`, 筛选 → `filter`/`search`, …) and appends them after the literal terms; the same task now leads with `report`, `page`, `filter`, `param`. `contextSynonyms` extends the table per deployment.

**It says so, once, when the registry has a newer release.** A plugin cannot upgrade itself — it lives in a profile's dependency tree, and rewriting that tree is the host's job. So it does the next best thing: after one of its tools runs, it checks the registry in the background and, when the published version is newer than the running one, appends a notice to the next step of the conversation, where both the model and the user can see it. Three details keep it from turning into noise: the check only ever happens *after* a tool was used, so nothing arrives out of nowhere; a release is announced once, with `notifiedVersion` persisted so a desktop restart does not replay it; and checks run at most every six hours, while an unreachable registry, a timeout, or an unwritable state file all mean "nothing to report" rather than an error. The registry follows npm's own resolution order — `npm_config_registry`, then `registry=` in the user's `~/.npmrc`, then npm's public default — so a machine behind a mirror checks the mirror it actually installs from. `updateCheck: false` turns the whole thing off, and `updateCheckIntervalMs` changes the interval.

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
- **The parse cache is incremental; the edges are not.** "Sync only the changed files" sounds obviously faster, but the rule this graph resolves calls by — one unique name wins workspace-wide — is global: adding a symbol in file A that collides with one already indexed from file B should invalidate edges that point at B, even though B never changed. A parser that reparses only the touched files *and patches in their own new edges* has no way to notice that. So this plugin splits the two: each file's extraction is cached and reused (**991 ms → 45 ms** on a 337-file workspace), while edges are rebuilt over the whole graph on every run. Reparsing everything was the wrong thing to save; re-resolving everything is cheap.

## Language coverage

Eighteen languages, all bundled — no per-language setup, and grammars load lazily, so a Go-only workspace never pays for the Python one.

| Language | Extensions | Language | Extensions |
|---|---|---|---|
| TypeScript | `.ts` `.mts` `.cts` | C | `.c` `.h` |
| TSX | `.tsx` | C++ | `.cpp` `.cc` `.cxx` `.hpp` `.hh` `.hxx` |
| JavaScript | `.js` `.mjs` `.cjs` | C# | `.cs` |
| JSX | `.jsx` | PHP | `.php` |
| Python | `.py` `.pyi` | Rust | `.rs` |
| Go | `.go` | Ruby | `.rb` |
| Java | `.java` | Zig | `.zig` |
| Kotlin | `.kt` `.kts` | Swift | `.swift` |
| Dart | `.dart` | Scala | `.scala` `.sc` |

The **store is format-bound, not language-bound**: a graph the `codegraph` CLI built over languages this indexer does not parse stays fully queryable. For anything outside the table above, index with the CLI and query through this plugin.

## Auto-indexing

Three things keep the graph current without you asking:

- **A new session starts with a current index.** Open a session in a workspace that has never been indexed — or whose index is more than ten minutes old — and the plugin starts a background build for it. That refresh is also what restarts the file watcher after a host restart, since watching only begins once a successful index has established a baseline; without it a restarted host would sit on the previous process's graph indefinitely.
- **Watching is on by default.** Every in-scope directory is watched through the host's filesystem seam, and a debounced change triggers a rebuild. An empty change set schedules nothing, so the plugin's own `.codegraph` writes never loop.
- **Re-indexing parses only what changed.** Each run persists its per-file extraction; the next one confirms each file by mtime+size (or a SHA-256, under `cacheVerify: 'hash'`) and reuses it. Measured on a 337-file workspace: **991 ms for the first run, 45 ms for every run after** — and a watch rebuild after one edit costs about the same as reusing everything else.

Two more things keep it *correct* rather than just current: committed build output (a checked-in `dist/` tree) is skipped by shape so its mangled names never pollute resolution, and a large workspace's first index moves to a background job instead of holding a tool call open.

## What this plugin adds

Five things you do not get from a CLI an agent shells out to:

1. **No second runtime.** `dsh plugin add dsh-plugin-codegraph` is the whole install — no binary on `PATH`, no MCP server to wire, no version to keep in sync with the plugin.
2. **An index that starts itself.** Opening a session in an unindexed workspace builds one in the background, and every change after that is picked up by a watcher.
3. **A model that knows the state of what it is querying.** Every request's prompt carries how large the index is, when it was built, and how many generated files were skipped — for free, instead of a `status` round-trip.
4. **Entry points for a human.** `/codegraph status|index|files`, and a settings panel with a rebuild button. Neither spends a model turn.
5. **Re-indexes that are cheap.** A parse cache makes a repeat run 991 ms → 45 ms on a 337-file workspace, so "just re-index before you answer" stops being an expensive habit.

## Compared with the `codegraph` CLI

The CLI is the origin of the on-disk format this plugin reads and writes, and it covers more languages than this indexer parses. They are aimed at different things:

| | This plugin | [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) |
|---|---|---|
| **Shape** | A DSH plugin: two tools, a `/codegraph` command, a settings panel, and a prompt section | An MCP server plus a CLI you install and wire into each agent |
| **Install** | `dsh plugin add dsh-plugin-codegraph` — no second runtime, no MCP config | Install the CLI, run its setup to wire the MCP server per agent, then `codegraph init` per project |
| **First index** | Automatic: opening a session in an unindexed workspace starts one | Explicit `codegraph init` per project |
| **Index state** | One line in the prompt on every request (size, age, skipped artifacts) plus a settings panel | Ask its MCP tool |
| **Re-index cost** | Parse cache — 991 ms → 45 ms on a 337-file workspace | Not measured here |
| **Background indexing** | Past ~1000 files the run becomes a `ctx.jobs` job | Not measured here |
| **Committed bundles** | Skipped by shape (`.min.`, or an average line > 500 chars) | Not measured here |
| **Languages** | 18 bundled grammars | 40+, including ArkTS, Vue, Svelte, Solidity, Terraform |
| **On-disk format** | Schema v4 — the CLI's own path and format | Schema v4 (origin) |

What this plugin adds is not a better graph — it is the same graph, delivered where DSH can act on it: no second process, no MCP plumbing, a state line the model reads for free, a human command, and a UI.

## The Rust engine

Parsing was the one place this plugin was visibly slow, and the reason was structural: `parse` plus `extractFile` ran on the host's main thread through `web-tree-sitter`, one file at a time. A native addon now does that work instead — `tree-sitter` compiled into Rust, one worker per core through rayon — and it is on for **TypeScript, TSX, JavaScript and JSX** already.

| | JS + WASM | Rust addon |
|---|---|---|
| parse + extract (336 files, same input) | 727 ms | **110 ms** |
| whole walk, 337-file workspace (median of 4) | 807–886 ms | **277–336 ms** (2.6–2.9×) |

The whole-walk number is lower than the engine number because the walk is not only extraction: reading files, hashing, caching decisions and the final write are unchanged, and three files in that workspace would need the JS engine anyway (below). On a workspace with no such files the gap widens.

Three details worth knowing:

- **It is optional, and it degrades quietly.** The addon ships as `.node` platform artifacts; if it is missing, unbuilt, or throws, every file falls back to the JS extractor. `engine: 'js'` forces that path, `'auto'` (default) uses the addon where it can.
- **The rule table is not duplicated.** The addon receives `LANGUAGE_TABLE` as JSON and builds its matchers from it, so the two engines cannot drift on what a rule says — only on how well they implement it, which is what the parity tests measure.
- **Files whose parse tree has errors are left to the JS engine.** The two grammars (WASM 0.20 vs crate 0.23/0.25) recover from malformed input differently — on a real workspace that showed up as one phantom definition and a line off by one — so the addon refuses those files and `walk` extracts them the old way. Correct over fast.

**It no longer freezes the host.** Before 0.6.0 `extractWorkspace` was a synchronous export: the napi call waited on the whole batch on the JS thread, and rayon only made that wait shorter, never optional. Auto-indexing runs inside the renderer, so that wait was the whole UI — opening a historical conversation could take the desktop down, and a sample of the main thread put 2415 of 2415 frames in `uv_fs_stat` at 47% CPU. The call is an `AsyncTask` now: the work goes to libuv's thread pool and the caller awaits a promise. Across one 1480-file, 644 ms call the event loop ticked 53 times, worst delay 12 ms.

**The binaries now arrive with npm.** Five platform packages (`dsh-plugin-codegraph-indexer-*`) are published as this package's `optionalDependencies`, and npm's `os`/`cpu` fields pull exactly the one this machine can `dlopen` — no more copying a `.node` into the package by hand. When it cannot be had (a pruned install, a mirror missing the package, an unsupported platform) the JS path still answers.

`packages/tree-sitter/tests/rust-parity.spec.ts` asserts the two engines produce **byte-identical** extractions on every fixture, and on a real workspace when `CODEGRAPH_PARITY_WORKSPACE` is set.

**Coverage and next.** Four languages today. Python, Go, Java, C/C++, Rust, C# and the rest still go through the JS extractor, which keeps working unchanged; each new language needs its own Rust-side special cases plus a parity run before it ships. The five-platform binaries are built by the `build-native` matrix in `.github/workflows/publish.yml`; the build details — especially the `npx -p @napi-rs/cli napi` invocation and the toolchain traps — live in [`crates/indexer-rust/README.md`](crates/indexer-rust/README.md).

## Call resolution never guesses

Every call site resolves in a fixed order: an import that lands on an indexed file wins; otherwise a declaration **in the calling file itself** wins when exactly one carries the name — lexical scope settles it before the workspace gets a say, which is what keeps a helper declared in two test files, or a `render` in two components, from being counted as ambiguous; otherwise a unique workspace-wide name wins; otherwise **no edge is emitted** and the site is recorded as unresolved.

The same-file tier applies to bare calls only. A member call (`x.map()`) names a property of a receiver this resolver cannot type, so letting a same-named local declaration win it would be a guess, not a scope resolution.

That last rule is deliberate. The model acts on `callers` output, so a confidently wrong caller sends it to edit the wrong file, while a missing caller merely sends it back to text search. The index report's `unresolved_count` is not, by itself, that gap's size — a type-free resolver was never going to settle a member call (`x.map()`) or a name already imported from elsewhere, and those dominate the total in a typical workspace. `unresolved_likely_internal_count` is the subset worth judging completeness by: bare, undeclared names that were structurally plausible workspace calls.

## Command and panel

Two human-facing surfaces over the same index, for when you would rather not ask the model:

- **`/codegraph [status|index|files <pattern>]`** — report the current workspace's index, rebuild it, or list indexed files. `status` is the default.
- **Settings → 代码图谱** — a panel showing the workspace's index state (files, declarations, relationships, unresolved counts, when it was built, how many generated artifacts were skipped), with a path box and a rebuild button. Its data comes from the plugin's own `/dsh-plugin-codegraph/api/state` and `/api/reindex` endpoints, which read nothing but `<root>/.codegraph/status.json` and never expose arbitrary files.

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
    skipMinified: true # the default; set false to index committed bundles anyway
    engine: auto # auto | js | rust — prefer the native addon where it applies
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

- **Watching is on by default, and it goes through the host's filesystem seam.** A successful `codegraph_index` starts watching that root automatically: one watch per in-scope directory, opened through `ctx.fs.watch` rather than `node:fs` directly, so a workspace a backend serves from another execution world is watched where it actually lives. The seam's change callback carries no filename, so a rebuild is triggered by re-listing the watched directories and diffing them against the previous snapshot; an empty diff schedules nothing, which is what keeps the indexer's own `.codegraph` writes from rebuilding forever. A backend that cannot watch degrades to explicit indexing with a logged reason instead of failing the plugin. Set `watch: false` to keep indexing purely explicit instead. It's overridden back off on a WSL2 kernel watching a path mounted in from the Windows host (`/mnt/<drive>/...`), since inotify doesn't reliably deliver events over that mount; `CODEGRAPH_FORCE_WATCH=1` and `CODEGRAPH_NO_WATCH=1` override that default either way. Whether or not watching is on, `status` still reports how many indexed files have gone stale — modified or removed since the last run — found by statting the filesystem directly, so a caller can always tell a trustworthy index from a drifted one instead of assuming the best.
- **Git hooks and worktree detection ship as library functions only** — `installGitHooks`/`uninstallGitHooks` (a `post-checkout`/`post-merge`/`post-commit`/`post-rewrite` hook running a command of your choosing, for environments where live watching isn't available) and `detectWorktree` (whether a root is a linked `git worktree`, and where its main repository lives). Neither is wired into plugin load or exposed as a model-visible tool: `.git/hooks/*` is shared, ambient state this package doesn't own, so installing it is left to a caller's own init script, never automatic.
- **Exclusion unions the built-in default directories with the project's own `.gitignore`.** Build output that lands outside `node_modules`/`dist`/`build`/`coverage` (a `lib` a TypeScript project compiles to, say) is almost always gitignored too, and indexing it alongside its own source would hand call resolution two same-named declarations of one symbol to pick between arbitrarily. Only a practical subset of gitignore syntax is understood — no `**`, character classes, or per-directory `.gitignore` files. Turn it off with `respectGitignore: false`.
- **Committed build output is left out by shape, not by `.gitignore`.** Some deployments commit `dist/` so a server can serve it straight from the repository, which makes it neither gitignored nor named in `exclude`. Those files are still bundler output: a workspace sampled here had 25 such files that contributed 90% of the declarations, 86% of the edges, and 92% of the unresolved call sites in a graph that otherwise described 335 source files — and their mangled one-letter names collided with real symbols, making the unique-name rule refuse calls it could have settled. `skipMinified` (default on) skips a file whose path carries a `.min.` segment, or whose average line length is past 500 characters — roughly 7× the widest average found in hand-written source — and reports the count as `files_minified`. It is a heuristic, not a build-system integration: naming the artifact directory in `exclude` is still the exact fix, and `skipMinified: false` indexes such files anyway.
- **The unresolved tail can be large**, and most of it is not a gap. `unresolved_count` includes every member call and already-imported name a type-free resolver could never have settled; `unresolved_likely_internal_count` is the narrower number that reflects re-exports and dynamic dispatch the graph actually missed.
- **`context` ranks by identifier-term overlap**, so a task phrased without naming any symbol ranks poorly. The Chinese synonym table covers common development vocabulary, not arbitrary prose, and there is no semantic matching — a task whose subject appears nowhere in the table still ranks poorly.
- `dsh` itself is in developer preview and iterating fast; expect compatibility-breaking changes.

## Credits

The on-disk graph format — schema version 4 at `.codegraph/codegraph.db` — originates with [`@colbymchenry/codegraph`](https://github.com/colbymchenry/codegraph) (MIT), a local-first code-intelligence tool for AI agents. This plugin adopts that format deliberately so the two remain mutually readable; the indexer, store, and tool here are independent implementations written against the DeepSeek Harness plugin model.

Built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and [Cordis](https://github.com/cordiverse/cordis).

## Feedback

Questions or need support? Open an [issue](https://github.com/CC19990113/dsh-plugin-codegraph/issues).

## License

[MIT](LICENSE)
