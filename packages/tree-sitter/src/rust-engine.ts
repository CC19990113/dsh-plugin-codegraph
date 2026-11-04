/**
 * The optional Rust extraction engine: a native addon built from `crates/indexer-rust`, used in place
 * of this package's own `extractFile` for the four ECMAScript-family grammars.
 *
 * Everything here is optional by construction. The addon is a build artifact — this package's `files`
 * list does not ship it, and a deployment without a Rust toolchain has no reason to produce one — so a
 * missing artifact, a stale artifact, a thrown call, or an unparsable answer all degrade to "no Rust
 * extraction". The walk then parses those files with `extractFile`, exactly as it would without this
 * module; a slower index is acceptable, a failed one is not.
 *
 * The addon never touches the filesystem: it takes every file's text as an input and answers with
 * JSON. That keeps the seam honest — filesystem policy (mtime, minified skips, cache reuse) stays in
 * `walk.ts`, and this module only turns text into {@link FileExtraction}s.
 * @module dsh-plugin-codegraph-tree-sitter/rust-engine
 */

import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { FileExtraction } from './extract.ts'
import { LANGUAGE_TABLE } from './languages.ts'

/** Seam language labels the addon extracts. Every other language is left to `extractFile`. */
export const RUST_LANGUAGES: readonly string[] = ['typescript', 'tsx', 'javascript', 'jsx']

/**
 * Files handed to one addon call. The addon parses a batch across every core it can, so a large batch
 * is what makes it fast. The call runs on libuv's thread pool (see {@link RustEngine}), so a batch no
 * longer stalls the event loop; the bound now keeps one promise's lifetime — and the file text it
 * holds in flight — reasonable, instead of capping a blocking call.
 */
export const RUST_BATCH_SIZE = 200

/** One file as the addon takes it. */
export interface RustExtractInput {
  /** Workspace-relative path, echoed back verbatim in the answer. */
  readonly path: string
  /** Seam language label — one of {@link RUST_LANGUAGES} to be extracted. */
  readonly language: string
  /** The file's full text. */
  readonly text: string
}

/**
 * The addon's one exported entry point, as this package uses it. The real artifact also exports
 * `__napiBindingTarget`, which nothing here reads.
 */
export interface RustEngine {
  /**
   * Extract definitions, calls, imports, and heritage for a batch of files.
   *
   * Answers a promise because the addon's body runs on libuv's thread pool: a synchronous native call
   * blocked the host's event loop for the whole batch, which is what froze the desktop when automatic
   * indexing ran inside the renderer. Callers `await` it; an older addon that still returns a string
   * keeps working, because `await` on a non-promise is the value itself.
   * @param inputs - the files to extract; inputs in an unsupported language are silently skipped.
   * @param rulesJson - the `LanguageSpec` table, as JSON.
   * @returns a promise of JSON `{ results: [{ path, extraction }], supported: string[] }`.
   */
  extractWorkspace(inputs: RustExtractInput[], rulesJson: string): Promise<string>
}

/** Options for {@link loadRustEngine}. */
export interface LoadRustEngineOptions {
  /**
   * Load the addon from this path instead of the default artifact under `crates/indexer-rust`. Tests
   * point it at a stand-in module or at a path that does not exist; production never sets it.
   */
  readonly modulePath?: string
}

const require = createRequire(import.meta.url)

/**
 * Where the native package for this platform lives, when npm installed one.
 *
 * The addon ships as one optional dependency per platform (`optionalDependencies` in this package's
 * manifest), so a `pnpm add` pulls exactly one binary — the one the running machine can `dlopen` —
 * instead of every platform's. npm's `os`/`cpu` fields do the selection; a platform this project does
 * not build for simply never installs one and the walk falls back to JS.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @returns the package name, or `undefined` for a platform with no published build.
 */
export function nativePackageName(platform: string, arch: string): string | undefined {
  const suffix = NATIVE_PACKAGES[`${platform}-${arch}`]
  return suffix === undefined ? undefined : `dsh-plugin-codegraph-indexer-${suffix}`
}

/**
 * The suffix each published platform package carries, keyed by `platform-arch`.
 *
 * A suffix is not mechanical: the Linux builds are `-gnu` because a musl one would have to be a
 * separate artifact, while Windows spells its ABI out. Keeping the table explicit is what stops this
 * from silently computing a package name nobody publishes.
 */
const NATIVE_PACKAGES: Record<string, string> = {
  'darwin-arm64': 'darwin-arm64',
  'darwin-x64': 'darwin-x64',
  'linux-x64': 'linux-x64-gnu',
  'linux-arm64': 'linux-arm64-gnu',
  'win32-x64': 'win32-x64-msvc',
}

/**
 * Resolve this platform's optional native package to its `.node` entry, if it is installed.
 *
 * `require.resolve` is the only thing that knows where a dependency actually landed — pnpm's store,
 * npm's flat tree, a hoisted profile — so the path is asked for rather than constructed. A missing
 * package, or one whose `main` does not resolve, is `undefined`: that is the documented "no addon"
 * answer, not an error.
 * @param platform - `process.platform`.
 * @param arch - `process.arch`.
 * @param resolve - module resolution, injectable so a test does not depend on what this machine has
 *   installed.
 * @returns the absolute path to the addon, or `undefined`.
 */
export function nativePackageModulePath(
  platform: string,
  arch: string,
  resolve: (name: string) => string = require.resolve,
): string | undefined {
  const name = nativePackageName(platform, arch)
  if (name === undefined) return undefined
  try {
    return resolve(name)
  } catch {
    return undefined
  }
}

/**
 * Every place the addon may live, most specific first.
 *
 * Three layouts matter: a package that ships the binary puts it in `artifacts/` beside `lib/` (the
 * shape an older hand-copied install has), a repository checkout builds it under
 * `crates/indexer-rust/artifacts/` (three directories up from both `src/` and `lib/`, which sit at the
 * same depth), and an npm install carries it in the platform's optional dependency. Trying all three
 * means one module works whether it was installed, copied in, or checked out.
 * @param base - the importing module's URL; parameterized so a test can point at a scratch tree.
 * @param fromPackage - this platform's optional-dependency path, or `undefined` when there is none.
 * @returns absolute paths to try, in order.
 */
export function modulePathsFor(base: string, fromPackage: string | undefined): string[] {
  const artifact = `codegraph-indexer.${process.platform}-${process.arch}.node`
  return [
    fileURLToPath(new URL(`../artifacts/${artifact}`, base)),
    fileURLToPath(new URL(`../../../crates/indexer-rust/artifacts/${artifact}`, base)),
    ...fromPackage === undefined ? [] : [fromPackage],
  ]
}

/**
 * The paths production should try, with this platform's optional package worked out for it.
 * @param base - the importing module's URL; parameterized so a test can point at a scratch tree.
 * @returns absolute paths to try, in order.
 */
export function candidateModulePaths(base: string = import.meta.url): string[] {
  return modulePathsFor(base, nativePackageModulePath(process.platform, process.arch))
}

/** Addons already loaded, keyed by path, so a test's stand-in never shadows the real artifact. */
const loaded = new Map<string, RustEngine>()

/**
 * Paths whose load already failed. Kept so a workspace without the artifact pays one failed `require`
 * for the process rather than one per walk.
 */
const failed = new Set<string>()

/** Whether this process has already said why the addon is unusable — see {@link reportUnavailable}. */
let reportedFailure = false


/**
 * Say once, per process, why the addon could not be used. Never once per file and never once per
 * walk: a missing optional artifact must not turn into a console flood, but it must not be silent
 * either — otherwise a deployment that expected the faster engine has no way to notice it is not
 * running.
 * @param reason - what went wrong, in one phrase the reader can act on.
 */
function reportUnavailable(reason: string): void {
  if (reportedFailure) return
  reportedFailure = true
  console.error(`codegraph-tree-sitter: Rust extraction unavailable (${reason}); falling back to the JavaScript extractor`)
}

/** Whether `value` is a plain object, which is all the JSON and module shapes checked here ever are. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Whether a required module is the addon this package expects. A stale or mismatched artifact is a
 * load failure like any other: it must fall back rather than throw on the first batch call.
 * @param value - whatever `require` returned for the artifact path.
 */
function isRustEngine(value: unknown): value is RustEngine {
  return isRecord(value) && typeof value.extractWorkspace === 'function'
}

/**
 * Load the native addon, or report that it is unavailable.
 *
 * Never throws and never repeats a failure: the first failure is logged once (see
 * {@link reportUnavailable}), later calls answer `undefined` without touching the filesystem again.
 * @param options - see {@link LoadRustEngineOptions}; production passes none.
 * @returns the loaded addon, or `undefined` when this deployment has no usable one.
 */
export function loadRustEngine(options?: LoadRustEngineOptions): RustEngine | undefined {
  const candidates = options?.modulePath === undefined ? candidateModulePaths() : [options.modulePath]
  // Local, not module-level: a second call whose candidates are all already cached as failed must not
  // resurrect the previous call's reason and try to report it again.
  let lastFailure: string | undefined
  // Both caches are consulted before any `require`: a successful load is the process's engine, and a
  // failed path is not worth retrying on the next walk.
  for (const modulePath of candidates) {
    const cached = loaded.get(modulePath)
    if (cached !== undefined) return cached
    if (failed.has(modulePath)) continue
    let addon: unknown
    try {
      addon = require(modulePath)
    } catch (error) {
      failed.add(modulePath)
      lastFailure = `${modulePath}: ${String(error)}`
      continue
    }
    if (!isRustEngine(addon)) {
      failed.add(modulePath)
      lastFailure = `${modulePath}: no extractWorkspace export`
      continue
    }
    loaded.set(modulePath, addon)
    return addon
  }
  // Reported only once every candidate has been tried, so an installed package does not complain
  // about the checkout path it was never going to have.
  if (lastFailure !== undefined) reportUnavailable(lastFailure)
  return undefined
}

/** The rules the addon extracts by, as JSON — built once from {@link LANGUAGE_TABLE}, then reused. */
let rulesJson: string | undefined

/**
 * The addon's rule table: this package's own `LANGUAGE_TABLE` entries for the languages the addon
 * handles, so the two extractors can never disagree about what a rule matches. The table stays the
 * single source of truth — the crate keeps no copy of it.
 * @returns the `LanguageSpec[]` the addon parses, JSON-encoded.
 */
function rustRulesJson(): string {
  rulesJson ??= JSON.stringify(LANGUAGE_TABLE.filter(spec => RUST_LANGUAGES.includes(spec.language)))
  return rulesJson
}

/**
 * Extract a batch of files with the addon, in at most {@link RUST_BATCH_SIZE} files per call.
 *
 * A file the addon did not answer for is simply absent from the returned map: an unsupported
 * language, a file it declines (a root parse error, whose extraction it will not vouch for), or one
 * lost to a batch whose call failed. That is the contract the caller relies on — **per-path** absence
 * means "extract this one with `extractFile`", not "discard the batch".
 * `engine` is required rather than defaulted to {@link loadRustEngine}: `undefined` has to mean "no
 * addon" here, and a default parameter would silently load one instead of accepting that answer — the
 * caller that already resolved the engine (`walk.ts`) is the one that should decide.
 * @param files - the files to extract, in any language; unsupported ones are dropped here.
 * @param engine - the loaded addon, or `undefined` when this deployment has none.
 * @returns one extraction per path the addon answered for, or `undefined` when no answer can be
 *   trusted at all — no addon, a thrown call, or JSON that is not the documented shape.
 */
export async function extractWithRust(
  files: readonly RustExtractInput[],
  engine: RustEngine | undefined,
): Promise<Map<string, FileExtraction> | undefined> {
  const supported = files.filter(file => RUST_LANGUAGES.includes(file.language))
  if (supported.length === 0) return new Map()
  if (engine === undefined) return undefined
  const extractions = new Map<string, FileExtraction>()
  try {
    for (let start = 0; start < supported.length; start += RUST_BATCH_SIZE) {
      const batch = supported.slice(start, start + RUST_BATCH_SIZE)
      // Awaited one batch at a time: the addon already parses a batch across every core, so
      // overlapping batches would only compete for the same threads while multiplying the text held
      // in flight.
      const answer: unknown = JSON.parse(await engine.extractWorkspace(batch, rustRulesJson()))
      if (!isRecord(answer) || !Array.isArray(answer.results)) return undefined
      for (const entry of answer.results) {
        // A malformed entry is treated as a path the addon did not answer for: the caller falls back
        // for it, and a bad answer for one file never costs the rest of the batch its extraction.
        if (!isRecord(entry) || typeof entry.path !== 'string' || !isRecord(entry.extraction)) continue
        // The wire shape is `FileExtraction` field for field — camelCase `Raw*` fields, arrays of the
        // same objects — which `rust-parity.spec.ts` pins with `toStrictEqual` against `extractFile`.
        extractions.set(entry.path, (entry as unknown as { readonly extraction: FileExtraction }).extraction)
      }
    }
  } catch (error) {
    reportUnavailable(`extractWorkspace failed: ${String(error)}`)
    return undefined
  }
  return extractions
}

/**
 * Install a stand-in for the addon the walk resolves, or restore the real one.
 *
 * This exists for tests, and only for tests: the per-path fallback contract above is a promise about
 * what happens when the addon *declines a file*, which the real artifact only does for its own
 * reasons — a workspace with a syntactically broken file, at the time of writing. A test that needs
 * that answer deterministically installs one here instead of depending on the artifact's current
 * behaviour. Not exported from the package entry point; production code has no reason to call it.
 * @param engine - the double to install, or `undefined` to let the next call load the real artifact.
 */
export function installRustEngineForTests(engine: RustEngine | undefined): void {
  // Every candidate, so a stand-in covers whichever layout this checkout resolves to.
  for (const modulePath of candidateModulePaths()) {
    if (engine === undefined) loaded.delete(modulePath)
    else loaded.set(modulePath, engine)
  }
}
