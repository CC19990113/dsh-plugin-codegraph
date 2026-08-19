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

Five packages under `packages/*`, split along a strict seam so that adding a new store or indexer never touches the model-facing tool:

| Package | Role |
|---|---|
| `bundle` | Installable meta-package: no source, just `cordis.patch.yml` wiring the other four into one profile layer |
| `service` | Defines the `ctx.codegraph` Cordis service — the query vocabulary, store/indexer provider registries, `CodegraphError` |
| `sqlite` | A `CodegraphStoreProvider`: read-only queries over an on-disk graph |
| `tree-sitter` | A `CodegraphIndexer`: builds/refreshes that graph with `web-tree-sitter` |
| `tool` | Consumer: the two model-facing tools (`codegraph`, `codegraph_index`), rendering, and system-prompt copy |

**Provider selection is "exactly one claimant" routing, not first-match.** `Codegraph.query`/`.index` (`packages/service/src/index.ts`) ask every registered store/indexer `indexes(projectRoot)`/`canIndex(projectRoot)` concurrently; zero claimants and multiple claimants both throw (`CODEGRAPH_UNAVAILABLE` / `CODEGRAPH_CONFLICT`) instead of picking by registration order. Keep this order-independence when adding a new provider.

**`codegraph` (query) and `codegraph_index` (build) are separate tools, not one with a mode flag** — a tool's `timeoutMs` is fixed at registration, and indexing a large repo can take minutes while a query is milliseconds; one budget can't fit both. `query` never triggers an implicit build, and `status` is the one operation that returns `indexed: false` instead of throwing when no index exists — every other operation fails loudly so "no index yet" and "empty index" are never confused.

**Call resolution favors a missing edge over a wrong one.** Order: import-resolved-to-an-indexed-file wins; else a workspace-unique name wins; else no edge is emitted and the site is recorded as unresolved. A wrong `callers` result sends the model to edit the wrong file; a missing one just falls back to text search.

**The on-disk format is an external contract, not ours to change freely.** `sqlite`/`tree-sitter` read and write schema v4 at `<projectRoot>/.codegraph/codegraph.db`, the same path/format as the `@colbymchenry/codegraph` CLI. Compatibility here is deliberate — don't add fields or change the schema without checking that CLI-built graphs still load and vice versa.

**A `DefinitionRule.kind` is not always fixed per rule.** For a grammar where one node type conflates several seam kinds by an inspectable value or keyword rather than a distinct node type per kind — Zig's `variable_declaration` (struct/enum/constant/variable, by the value's shape), Kotlin's `class_declaration` (class/interface/enum, by a bare keyword), Swift's `class_declaration`/`property_declaration` (struct/class/enum; field/constant/variable) — `LANGUAGE_TABLE` carries a placeholder `kind`, and `extractFile` (`extract.ts`) computes the real one per node instead, keyed on `spec.language === '…' && node.type === '…'`. Also worth knowing before adding a new grammar: some bundled `tree-sitter-wasms` grammars bind zero fields at all (verified via `Language.fieldCount`/`fieldNameForId`, not guessed) — Kotlin is one — which forces name/callee resolution onto positional child access and a language-guarded bypass of `callFunctionField` in `extractFile`'s call-handling branch (see `kotlinDeclaredName`/`kotlinCallee`); always check `fieldCount` for a new grammar before assuming `childForFieldName` will work at all.

**Every package (except `bundle`) ships an `invariant.ts` companion**, exported at the `<pkg>/invariant` subpath. It's a Cordis plugin (`name`, `inject: ['invariants']`, `apply(ctx)`) that registers a package-owned runtime invariant with `ctx.invariants` when that optional service is present in the host. Follow the existing shape (see any `packages/*/src/invariant.ts`) when adding one for a new package: `PACKAGE_NAME` constant, an `InvariantInstaller`, `apply` returning the registration's disposer.

**Tests resolve to live `src/`, never to built `lib/`.** `tsconfig.base.json`'s `paths` map (e.g. `dsh-plugin-codegraph-service` → `./packages/service/src`) is read by `vite-tsconfig-paths` in `vitest.config.ts` and takes priority over each package's `exports`. This exists so a test never accidentally loads a second copy of a module singleton through a stale `lib/` build — don't add `include`/`files` to `tsconfig.base.json`, it would narrow that match-all facade and break resolution for other packages' tests.

**Provider tests spin up a real `@deepseek-ai/cordis` `Context`** rather than mocking the service (see `packages/service/tests/codegraph.spec.ts`): `new Context()`, `await ctx.plugin(Codegraph)`, then register stub stores/indexers and assert on `ctx.codegraph`.

### Known gaps

- The default exclude list for the tree-sitter indexer is `node_modules`/`dist`/`build`/`coverage`/`.git` plus whatever the project's own `.gitignore` says; it does not hardcode `lib`, relying on `.gitignore` to catch TypeScript build output there.
