# indexer-rust — native extraction engine

A napi addon that parses TypeScript / TSX / JavaScript / JSX with tree-sitter compiled
into the addon, and returns the same extraction the JS/WASM extractor in
`packages/tree-sitter/src/extract.ts` produces.

`extract.ts` is the behaviour spec. This crate is measured against it, never the other
way round: every fixture's expected JSON is written by running the JS extractor
(`tools/gen-expected.mjs`), and `cargo test` fails on any field-level difference.

## Contract

```ts
interface ExtractInput {
  readonly path: string
  readonly language: 'typescript' | 'tsx' | 'javascript' | 'jsx'
  readonly text: string
}
declare function extractWorkspace(inputs: ExtractInput[], rulesJson: string): string
// => JSON: { results: [{ path, extraction: { definitions, calls, imports, heritage } }], supported: string[] }
```

- `rulesJson` is `LANGUAGE_TABLE`'s `LanguageSpec[]` for the four supported languages — the
  rule table is data, never duplicated in Rust. A `{ languages: [...] }` wrapper is also
  accepted; anything else is rejected.
- `supported` lists the languages this addon can extract **given that `rulesJson`** — the
  caller routes only those here and falls back to JS for the rest. Inputs in any other
  language are omitted from `results` (not an error), so one batch can carry mixed input.
- **A file whose parse tree contains syntax errors is omitted from `results`** (it never
  affects `supported`, which is a per-language list). The two engines' error recovery differs,
  so each side extracts the files it parses cleanly and the caller extracts the missing paths
  itself; the graph then records one interpretation per file instead of two different
  recoveries. `examples/parse-errors` proves the omitted set is exactly the Rust-side
  parse-error set.
- Every `extraction` object has exactly the four `FileExtraction` fields, in the JS
  declaration order, with `null` (never a missing key) for `parentKey`/`callerKey` when
  there is no enclosing definition.
- Malformed `rulesJson` rejects. A Rust panic becomes a rejected call (the whole body runs
  under `catch_unwind`); the host process is never aborted.
- No file I/O: text in, JSON out. The walk owns filesystem policy (mtime, minified skips,
  cache reuse) on the JS side.

## Build

```sh
cd crates/indexer-rust
npx --yes -p @napi-rs/cli napi build --platform --release --output-dir artifacts
# => artifacts/codegraph-indexer.<platform>-<arch>.node (+ generated index.js/index.d.ts)
```

`target/` and `artifacts/` are gitignored: building the addon is a local/CI step, not a
committed artifact.

Two environment facts this command depends on, both verified on this host:

1. **`npx @napi-rs/cli …` does not run the CLI.** The package's binary is named `napi`,
   and npm cannot pick it from the bare package name (`npm error could not determine
   executable to run`). `-p @napi-rs/cli napi …` is the working spelling.
2. **The default Rust toolchain here is `x86_64-apple-darwin`, while Node is arm64**
   (`rustc -vV` host). A default build therefore produces an x64 `.node` that Node refuses
   to `dlopen` (`incompatible architecture`). Build with the already-installed native
   toolchain:

   ```sh
   RUSTUP_TOOLCHAIN=stable-aarch64-apple-darwin \
     npx --yes -p @napi-rs/cli napi build --platform --release --output-dir artifacts
   ```

   or keep the default toolchain and cross-build with
   `--target aarch64-apple-darwin` after `rustup target add aarch64-apple-darwin`.

## Test

```sh
cd crates/indexer-rust
cargo test                                                     # unit + fixture parity
node --experimental-strip-types tools/gen-expected.mjs         # regenerate expectations from JS
node --experimental-strip-types tools/check-addon.mjs          # contract assertions on the built .node
node --experimental-strip-types tools/parity-adx.mjs [root]    # real-workspace parity + timing
cargo run --release --example bench -- <inputs.json> <rules.json>   # parse/extract/serialize split
```

Fifteen fixtures live in `tests/fixtures/{ts,tsx,js,jsx}` (5 TS, 3 TSX, 4 JS, 3 JSX), each
beside the `.expected.json` the JS extractor wrote for it. They cover: containers and
scope stack, arrow/function/generator definitions, class fields (public/private/static),
enum members (bare and valued), `import` clauses (named/renamed/default/namespace/
side-effect/empty specifier), CommonJS `require` + `module.exports`, heritage
(`extends`/`implements`/mixin/generic/non-bare), computed-callee rejection, destructuring
rejection, function-local `const` exclusion (including callbacks and IIFEs), UTF-8
identifiers/strings, CRLF line endings, and TSX/JSX component bodies.

## Column semantics: UTF-16, not bytes

tree-sitter's native `Point.column` is a **byte** offset; web-tree-sitter reports a
**UTF-16 code-unit** offset (verified: `const 变量 = foo(1)` puts the call at UTF-16 column
11, byte column 15; an emoji counts as 2). Definition keys are `row:column`, so this is
load-bearing, not cosmetic. `SourceText::utf16_column` converts, fast-pathing ASCII lines
and counting `char::len_utf16` only on lines that actually hold non-ASCII text.

## Grammar versions

The JS side loads `tree-sitter-wasms@0.1.13`, whose grammars are `tree-sitter-typescript
^0.20.5` / `tree-sitter-javascript ^0.20.3`. This crate uses the current crates
(`tree-sitter-typescript 0.23`, `tree-sitter-javascript 0.25`) against `tree-sitter 0.27`.
Node types and field bindings the extraction table relies on are identical across those
versions — on well-formed input the two engines produce byte-identical extractions. What
does differ is **error recovery**, plus two reserved-word cases (`in` used as an import
binding, `await` used as an identifier) that only appear in already-malformed input. Those
are exactly the files the addon omits (see the contract above): the JS grammar sometimes
recovers into an error-free tree where 0.25 produces `ERROR` nodes, and letting each side
own its own recovery is what keeps the two results equal.

## Measured parity against `/Users/admin/www/adx-admin-backend`

File set comes from the JS walker itself (`walkAndExtract` with the indexer's defaults), so
both engines see one identical batch.

| set | files | result |
|---|---|---|
| production (indexer's own walk) | 337 (336 native + 1 `.py` handled by JS) | **337/337 accounted**: 334 returned and field-exact, 2 omitted -> JS fallback, 1 non-native language |
| + 23 minified files kept for stress | 359 | 355 returned, **all 355 field-exact**; 4 omitted |

Four files are omitted, and they are exactly the four this crate's grammar parses into an
error tree (checked independently with `examples/parse-errors`; the omitted set and the
Rust parse-error set were byte-for-byte identical):

- `canvases/hera-pages.canvas.tsx` — not valid TSX: a JSX text node holds a bare `&`
  (`配置（底价&利润）`). The JS grammar also errors on it.
- `src/pages/demand-ad-slot/BindAdSlotPage.tsx` — the JS grammar errors on it too.
- `dist-test/js/@ant-design/@ant-design.BDp91I8a.js` and
  `dist-test/js/@rc-component/@rc-component.SyV4LPoI.js` — minified bundles where 0.25 hits
  `ERROR` nodes the older grammar tolerated; both are skipped by the indexer's minified
  filter anyway.

Before the omission policy these four contributed the only divergences (a phantom
`method` named `if`, an off-by-one column, a mis-read `in as P` import, an extra `await`
call). With the policy in place the returned set matches field for field, and the
previously-differing `src/pages/ad-slot/ConfigAdSlotPage.tsx` turns out to parse cleanly in
both grammars and its extraction is byte-identical.

## Timing (same 336 files, 2,966,770 bytes, Apple silicon, 8 cores)

| phase | JS / WASM | Rust native (serial) |
|---|---|---|
| parse | 313.7–336.4 ms | 252.8–270.3 ms |
| extract | 421.2–457.3 ms | 253.4–272.5 ms |
| serialize | — | 2.6–2.7 ms |
| **pipeline** | **735.8–806.6 ms** | **508.8–545.4 ms** |
| addon, rayon + napi marshalling | — | **84–90 ms** (3 runs, best of 3 inside each) |

The addon call — napi object marshalling + parallel parse/extract on 8 rayon workers +
JSON serialization — lands around **85–90 ms** against **784–806 ms** for the JS pipeline
measured the same way (median of three runs: 786.3 ms vs 89.7 ms, ≈ 8.8×). Numbers move by
±10% between runs because the machine is shared. The JS timing covers all 336 native files
while the addon omits the 2 its grammar cannot parse, so the ratio is, if anything, slightly
flattering to Rust — though those two files are a rounding error (2 of 336).

The indexer's quoted baseline (425 ms parse + 491 ms extract) was measured on different
hardware/run conditions; the table is this host, re-measured by `tools/parity-adx.mjs`.

## Layout

| file | role |
|---|---|
| `src/lib.rs` | napi entry, rayon batch, panic→reject, output JSON |
| `src/languages.rs` | `LanguageSpec`/`DefinitionRule` deserialization, grammar lookup |
| `src/rules.rs` | `matchDefinition`, names, callees, imports, CommonJS exports, heritage |
| `src/extract.rs` | the single-pass walk, container/scope stacks, `FileExtraction` wire types |
| `tests/fixtures.rs` | fixture parity test with a first-difference diff |
| `tools/` | expectation generator, addon contract check, real-workspace parity/bench |
| `examples/` | `bench` (phase timings), `parse-errors` (which files the Rust grammar cannot parse), `first-error` (grammar-drift diagnosis) |
