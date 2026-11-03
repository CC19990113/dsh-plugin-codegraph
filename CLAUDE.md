# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```sh
pnpm install                # workspace uses pnpm; koffi is the only allowed native build
pnpm run build               # tsc -b across the 4 TS project references (bundle ships no TS)
pnpm run typecheck            # same as build, no emit check needed separately — tsc -b is the typecheck
pnpm test                     # vitest run, all packages/*/tests/**/*.spec.ts
pnpm run test:coverage        # vitest run --coverage (v8, perFile thresholds — see Known gaps)
pnpm run clean                 # tsc -b --clean
```

Run a single test file or case directly with vitest, no per-package cd needed:

```sh
pnpm vitest run packages/tree-sitter/tests/resolve.spec.ts
pnpm vitest run -t "routes a query to the one store claiming the root"
```

There is no lint script; `tsc -b` (strict, `noUnusedLocals`/`noUnusedParameters`) is the only static gate besides tests.

## Architecture

Six packages under `packages/*`, split along a strict seam so that adding a new store or indexer never touches the model-facing tool:

| Package | Role |
|---|---|
| `bundle` | Installable meta-package: no source, just `cordis.patch.yml` wiring the other four into one profile layer |
| `service` | Defines the `ctx.codegraph` Cordis service — the query vocabulary, store/indexer provider registries, `CodegraphError` |
| `sqlite` | A `CodegraphStoreProvider`: read-only queries over an on-disk graph |
| `tree-sitter` | A `CodegraphIndexer`: builds/refreshes that graph with `web-tree-sitter` |
| `tool` | Consumer: the two model-facing tools (`codegraph`, `codegraph_index`), rendering, system-prompt copy, the `/codegraph` command, and the panel's HTTP routes |
| `panel` | Client bundle: one settings tab over the panel routes' data. No build step, no host code |

**Provider selection is "exactly one claimant" routing, not first-match.** `Codegraph.query`/`.index` (`packages/service/src/index.ts`) ask every registered store/indexer `indexes(projectRoot)`/`canIndex(projectRoot)` concurrently; zero claimants and multiple claimants both throw (`CODEGRAPH_UNAVAILABLE` / `CODEGRAPH_CONFLICT`) instead of picking by registration order. Keep this order-independence when adding a new provider.

**`codegraph` (query) and `codegraph_index` (build) are separate tools, not one with a mode flag** — a tool's `timeoutMs` is fixed at registration, and indexing a large repo can take minutes while a query is milliseconds; one budget can't fit both. `query` never triggers an implicit build, and `status` is the one operation that returns `indexed: false` instead of throwing when no index exists — every other operation fails loudly so "no index yet" and "empty index" are never confused.

**Call resolution favors a missing edge over a wrong one.** Order: import-resolved-to-an-indexed-file wins; else exactly one declaration *in the calling file itself* wins (lexical scope before workspace scope — this is what keeps a `helper` declared in two test files, or a `render` in two components, from being counted as ambiguous); else a workspace-unique name wins; else no edge is emitted and the site is recorded as unresolved. The same-file tier is skipped for member calls (`x.map()`), whose receiver this resolver cannot type. A wrong `callers` result sends the model to edit the wrong file; a missing one just falls back to text search.

**This plugin targets DSH, and owns its on-disk format; the `codegraph` CLI's compatibility is a bonus, not a constraint.** `sqlite`/`tree-sitter` still read and write schema v4 at `<projectRoot>/.codegraph/codegraph.db` so an index built by the CLI stays queryable, and that reading path is worth keeping. But the format is ours to evolve when DSH needs something the v4 shape cannot express — a new table, a new sidecar (`.codegraph/status.json` is the first), a different resolution policy. Do not refuse a change because an unrelated tool would stop reading the file; do keep the store able to read a graph this repo did not write.

**A `DefinitionRule.kind` is not always fixed per rule.** For a grammar where one node type conflates several seam kinds by an inspectable value or keyword rather than a distinct node type per kind — Zig's `variable_declaration` (struct/enum/constant/variable, by the value's shape), Kotlin's `class_declaration` (class/interface/enum, by a bare keyword), Swift's `class_declaration`/`property_declaration` (struct/class/enum; field/constant/variable) — `LANGUAGE_TABLE` carries a placeholder `kind`, and `extractFile` (`extract.ts`) computes the real one per node instead, keyed on `spec.language === '…' && node.type === '…'`. Also worth knowing before adding a new grammar: some bundled `tree-sitter-wasms` grammars bind zero fields at all (verified via `Language.fieldCount`/`fieldNameForId`, not guessed) — Kotlin is one — which forces name/callee resolution onto positional child access and a language-guarded bypass of `callFunctionField` in `extractFile`'s call-handling branch (see `kotlinDeclaredName`/`kotlinCallee`); always check `fieldCount` for a new grammar before assuming `childForFieldName` will work at all.

**Committed build output is skipped by shape, not by build-tool integration.** Some deployments commit `dist/` (a server serves it straight from git), so those files are neither gitignored nor in the default `exclude` list — `minified.ts` decides instead, on a `.min.` path segment or an average line length past `MINIFIED_AVERAGE_LINE_LENGTH` (500; hand-written source measured across real workspaces peaks near 70). This is load-bearing twice over: on a React admin repo here, 25 such files were 90% of the graph's declarations, 86% of its edges, and 92% of its unresolved sites, and their mangled one-letter names made the unique-name rule refuse calls it could otherwise settle. `walk.ts` calls `measureText` on text it already read (one pass, so `ExtractedFile.lineCount` costs nothing extra) and reports the skips as `filesMinified`, separately from `filesSkipped` — a decision about what the workspace is, not a bound the run hit. `skipMinified: false` turns it off.

**The prompt carries the index's own state, through a section whose `text` is a function.** `writeGraph` leaves a small `status.json` beside the graph (schema in `packages/service/src/status.ts`, written after the graph rename so a reader never describes a graph that is not there yet); `packages/tool/src/status-hint.ts` reads it synchronously at assembly time and `apply` registers `tool:codegraph` with `text: context => …`. It must stay a plain synchronous file read — a section is assembled on every model request, and a `ctx.codegraph` query there would open SQLite on each step. The host passes `{ agent, scope, signal }` to that function; the workspace comes from `agent.session.header.cwd`. Three outcomes are distinct on purpose: a summary, an index without one (built by an older run), and no index — collapsing the middle case into "no index" invites rebuilding a graph that already exists.

**The parse cache is keyed on content identity, and it caches extractions, never edges.** `cache.ts` persists each run's `FileExtraction` per path under `.codegraph/cache/`, stamped with `EXTRACTION_CACHE_VERSION`; `walk.ts` reuses an entry when the recorded mtime+size still match (`cacheVerify: 'stat'`, the default, reads nothing) or when a fresh SHA-256 does (`'hash'`, which catches a checkout restoring an older file without moving its mtime). Bump `EXTRACTION_CACHE_VERSION` whenever `extract.ts` changes what it produces — a stale cache would otherwise serve nodes the current parser would not emit. Edges and resolution are rebuilt over the whole graph on every run regardless: the unique-name rule is global, so a symbol added in one file can invalidate edges into another that never changed. Reused entries take *this* run's `modifiedAt`/`size` (the cached extraction, line count and hash), otherwise `status`'s `staleFileCount` — which compares `mtime > recorded` — would report a hashed-but-untouched file as stale forever.

**Background indexing is opt-in by measurement, and the job contract is the host's, not ours.** `runIndex` reads the previous `status.json`: at or past `backgroundIndexThreshold` (default 1000) it calls `ctx.jobs.start` and returns a job id, so a `codegraph_index` call never holds a tool budget open for minutes on a real monorepo. Two details are load-bearing and were verified against `dsh-jobs` 0.2.1-rc.5: `owner` must be `exec.agent.id` (the registry resolves a `SessionId`, not the agent object), and `run` must return `{ cancel, done }` — `start()` attaches to `hooks.done` *after* calling `run`, so a missing `done` leaves a permanently running job and then re-runs the index synchronously. Every failure path (`ctx.get('jobs')` absent, `start` throwing on a missing controller or the per-owner cap) falls back to the synchronous run rather than surfacing an error.

**Watching runs through `ctx.fs`, one watch per directory.** The seam's `watch(target, changed)` is chokidar-backed with `depth: 0`, so covering a tree means one watch per in-scope directory, capped by `maxWatchedDirectories`. `watcher.ts` takes the filesystem as a structural port (`WatchFileSystem`: `resolve`/`listDir`/`watch`) instead of importing `@deepseek-ai/dsh-fs`, because `watch` only exists from 0.2 and the package still supports 0.1.x — but the package now declares the fs peer and `inject`s it, and exclusion goes through `walk.ts`'s `isExcluded` so what is watched and what is indexed cannot drift. The callback carries no filename, so a rebuild is decided by re-listing the watched directories and diffing against the previous snapshot; **an empty diff schedules nothing**, which is what stops the indexer's own `.codegraph` write from rebuilding forever. Cleanup is generation-countered: a watch that finishes initializing after `stop()` closes itself immediately instead of landing in the disposer list.

**A sixth package ships a browser-only surface, and the host half is deliberately tiny.** `packages/panel` is a client bundle (`exports['./client']`, `dsh.client`, zero build step, CJS `window.__ModuleLoader__` factory, react supplied by the host) that registers one `settings.section` tab. Its data comes from `packages/tool/src/panel.ts`, which registers a prefix route through `ctx.inject(['webServer'], …)` — optional on purpose: `inject` stays `['tools','codegraph','fs','systemPrompt']` so a composition without a web server still loads the tools. That route reads exactly one relative path (`<root>/.codegraph/status.json`) and refuses anything else; `reindex` keeps an in-process per-root guard so a double-click cannot start two rebuilds. `panel: false` disables the route without disabling the package.

**`/codegraph` is a command, not a tool.** `packages/tool/src/command.ts` registers through `ctx.inject(['commands'], …)` and answers `status` / `index` / `files <pattern>` for a human at the keyboard, reusing the same `ctx.codegraph` seam the model-facing tools use — no separate code path, no separate budget. It is optional for the same reason as the route, and it resolves the workspace from the command invocation rather than assuming a process cwd.

**Auto-indexing a fresh session is a convenience that must never block session creation.** `agent/created` fires during agent registration, so the handler in `packages/tree-sitter/src/index.ts` only *starts* work: it checks for the status sidecar, needs `ctx.get('jobs')`, and otherwise returns. There is no synchronous fallback — building a graph inline would hold up the agent's own creation — and every failure is swallowed after one `console.error`. A process-local set keeps one root from being auto-built twice; the `agent/created` payload in 0.1.x carries only `{ agent }`, so read the workspace through `agent.session.header.cwd` and nothing else.

**Chinese task descriptions are mapped, not guessed.** `packages/tool/src/zh-synonyms.ts` carries a table of development vocabulary (报表→report, 分页→page/pageSize/pagination…), and `taskTerms` appends its candidates after the literal terms, breadth-first so one word cannot eat the whole budget. It is a table, not a model call: no API key, no latency, and a word that is not in it simply produces nothing. `contextSynonyms` lets a deployment extend it.

**Host-version compatibility is a load-time property, so never borrow a helper that can move.** `@deepseek-ai/dsh-llm` exported `assertNever` through 0.1.x and dropped it in 0.2.x (the implementation lives in `@deepseek-ai/dsh-util-values`, which 0.1.x does not ship). A static `import { assertNever } from '@deepseek-ai/dsh-llm'` therefore parses fine and fails at load with `does not provide an export named 'assertNever'` — the whole consumer plugin disappears from the host instead of failing at one unreachable branch, which is exactly how this plugin went missing on 0.2.1-rc.5 while every other profile plugin kept working. `service/src/assert.ts` now owns the three lines and `sqlite`/`tool` import it from `dsh-plugin-codegraph-service`. Keep host imports to symbols the whole supported range exports; run `pnpm vitest run` against a host checkout of the version you claim to support before assuming a load path still resolves.

**Every package (except `bundle`) ships an `invariant.ts` companion**, exported at the `<pkg>/invariant` subpath. It's a Cordis plugin (`name`, `inject: ['invariants']`, `apply(ctx)`) that registers a package-owned runtime invariant with `ctx.invariants` when that optional service is present in the host. Follow the existing shape (see any `packages/*/src/invariant.ts`) when adding one for a new package: `PACKAGE_NAME` constant, an `InvariantInstaller`, `apply` returning the registration's disposer.

**Tests resolve to live `src/`, never to built `lib/`.** `tsconfig.base.json`'s `paths` map (e.g. `dsh-plugin-codegraph-service` → `./packages/service/src`) is read by `vite-tsconfig-paths` in `vitest.config.ts` and takes priority over each package's `exports`. This exists so a test never accidentally loads a second copy of a module singleton through a stale `lib/` build — don't add `include`/`files` to `tsconfig.base.json`, it would narrow that match-all facade and break resolution for other packages' tests.

**Provider tests spin up a real `@deepseek-ai/cordis` `Context`** rather than mocking the service (see `packages/service/tests/codegraph.spec.ts`): `new Context()`, `await ctx.plugin(Codegraph)`, then register stub stores/indexers and assert on `ctx.codegraph`.

### Known gaps

- The default exclude list for the tree-sitter indexer is `node_modules`/`dist`/`build`/`coverage`/`.git` plus whatever the project's own `.gitignore` says; it does not hardcode `lib`, relying on `.gitignore` to catch TypeScript build output there.
