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
versions; the measured differences are confined to grammar **error recovery** and to two
reserved-word edge cases (below).

## Measured parity against `/Users/admin/www/adx-admin-backend`

File set comes from the JS walker itself (`walkAndExtract` with the indexer's defaults), so
both engines see one identical batch.

| set | files | field-exact | notes |
|---|---|---|---|
| JS production set (4 languages) | 336 | **335 (99.7%)** | 337 indexed, 1 is `.py` |
| + 23 minified files kept for stress | 359 | 356 (99.1%) | — |

The three differences, all explainable and none a port bug:

1. `canvases/hera-pages.canvas.tsx` — the file is **not valid TSX**: a JSX text node
   contains a bare `&` (`配置（底价&利润）`), so both engines' root node is `ERROR` and the
   remainder is recovery. Rust's recovery captured one extra bogus `method` named `if`.
2. `dist-test/js/@rc-component/@rc-component.SyV4LPoI.js` — minified bundle using the
   reserved word `in` as an import binding (`in as P`); grammar 0.20 tolerates it, 0.25
   reads the specifier differently.
3. `dist-test/js/index.CC5K3_PL.js` — minified bundle where Rust's grammar treats `await`
   as an identifier in one `f=await(...)(...)` position and emits one extra call
   (reproduced minimally: `async function f(){ let g = await(async n => n)(1) }`).

2 and 3 are both skipped by the indexer's minified filter, so they never reach a
production graph. 1 is a source file that already fails to parse in the JS engine too.

## Timing (same 336 files, 2,966,770 bytes, Apple silicon, 8 cores)

| phase | JS / WASM | Rust native (serial) |
|---|---|---|
| parse | 313.7 ms | 252.8 ms |
| extract | 421.2 ms | 253.4 ms |
| serialize | — | 2.7 ms |
| **pipeline** | **735.8 ms** | **508.8 ms** |
| addon, rayon + napi marshalling | — | **113–124 ms** (best of 3: 113.3) |

The addon call — napi object marshalling + parallel parse/extract on 8 rayon workers +
JSON serialization — is **6.5× faster** than the JS pipeline measured the same way
(113.3 ms vs 735.8 ms). The indexer's quoted baseline (425 ms parse + 491 ms extract) was
measured on different hardware/run conditions; re-measuring with this harness gave the
numbers in the table.

## Layout

| file | role |
|---|---|
| `src/lib.rs` | napi entry, rayon batch, panic→reject, output JSON |
| `src/languages.rs` | `LanguageSpec`/`DefinitionRule` deserialization, grammar lookup |
| `src/rules.rs` | `matchDefinition`, names, callees, imports, CommonJS exports, heritage |
| `src/extract.rs` | the single-pass walk, container/scope stacks, `FileExtraction` wire types |
| `tests/fixtures.rs` | fixture parity test with a first-difference diff |
| `tools/` | expectation generator, addon contract check, real-workspace parity/bench |
| `examples/` | `bench` (phase timings), `first-error` (grammar-drift diagnosis) |
