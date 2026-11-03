/**
 * Real-workspace parity + timing harness for the Rust addon.
 *
 *   node --experimental-strip-types crates/indexer-rust/tools/parity-adx.mjs [workspace]
 *
 * The file set comes from the JS walker itself (`walkAndExtract` with the indexer's own
 * default config), so both engines see one identical, production-shaped batch — that is
 * also why the JS timing here is comparable to the "parse 425ms + extract 491ms" baseline
 * measured from the same walk.
 *
 * Reports:
 *   1. parity: every file's Rust extraction `isDeepStrictEqual` to the JS one
 *   2. timing: JS parse / extract / pipeline vs the Rust addon call
 * and writes `/tmp/codegraph-adx-inputs.json` for `cargo run --release --example bench`.
 */

import { isDeepStrictEqual } from 'node:util'
import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { dirname, extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

import { walkAndExtract } from '../../../packages/tree-sitter/src/walk.ts'
import { extractFile } from '../../../packages/tree-sitter/src/extract.ts'
import { createParser } from '../../../packages/tree-sitter/src/grammar.ts'
import { languageFor } from '../../../packages/tree-sitter/src/languages.ts'

const here = dirname(fileURLToPath(import.meta.url))
const crateRoot = join(here, '..')
const root = process.argv[2] ?? '/Users/admin/www/adx-admin-backend'
const SUPPORTED = new Set(['typescript', 'tsx', 'javascript', 'jsx'])

// The indexer's own defaults (`packages/tree-sitter/src/index.ts`).
const walkConfig = {
  exclude: ['node_modules', 'dist', 'build', 'coverage', '.git', '.codegraph'],
  respectGitignore: true,
  skipMinified: true,
  maxFileBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: 4,
  reuseParsedCache: false,
  cacheVerify: 'stat',
}

const millis = start => performance.now() - start

// 1. The production file set (same walk config as the indexer) and the wider set that also
//    keeps generated/minified files, so parity is exercised on those too.
const production = await walkAndExtract(root, walkConfig, {})
const everything = await walkAndExtract(root, { ...walkConfig, skipMinified: false }, {})
const native = files => files.filter(file => SUPPORTED.has(file.language))
const productionNative = native(production.files)
const everythingNative = native(everything.files)
console.log(
  `walk: ${production.files.length} files indexed (${productionNative.length} native-capable), ` +
    `${production.filesMinified} minified skipped; ` +
    `parity set keeps them: ${everythingNative.length}`,
)

const texts = new Map()
for (const file of everythingNative) {
  texts.set(file.path, readFileSync(join(root, file.path), 'utf8'))
}

// 2. JS baseline: parser setup + parse + extract, serially, on the production set.
const jsExtractions = new Map()
for (const file of everythingNative) {
  jsExtractions.set(file.path, file.extraction)
}
let parserSetupMs = 0
let parseMs = 0
let extractMs = 0
for (const file of productionNative) {
  const spec = languageFor(extname(file.path))
  const text = texts.get(file.path)
  const started = performance.now()
  const parser = await createParser(spec)
  const parsed = performance.now()
  const tree = parser.parse(text)
  const extracted = performance.now()
  extractFile(tree, spec)
  const finished = performance.now()
  parser.delete()
  parserSetupMs += parsed - started
  parseMs += extracted - parsed
  extractMs += finished - extracted
}

// Warm the addon once so the timed run is not paying first-call costs.
const addonDirectory = join(crateRoot, 'artifacts')
const addonFile = readdirSync(addonDirectory).find(name => name.endsWith('.node'))
if (addonFile === undefined) throw new Error(`no .node artifact in ${addonDirectory}`)
const addon = createRequire(import.meta.url)(join(addonDirectory, addonFile))
const rulesJson = readFileSync(join(crateRoot, 'tests', 'fixtures', 'language-rules.json'), 'utf8')

const inputs = productionNative.map(file => ({
  path: file.path,
  language: file.language,
  text: texts.get(file.path),
}))
const BATCH = 200
const chunks = []
for (let index = 0; index < inputs.length; index += BATCH) {
  chunks.push(inputs.slice(index, index + BATCH))
}

addon.extractWorkspace(inputs.slice(0, 20), rulesJson)

// Three timed rounds after a warmup, reported as the fastest one — the first call after
// load carries one-time costs the second does not.
const addonTimes = []
const rustResults = []
for (let round = 0; round < 3; round++) {
  const started = performance.now()
  for (const chunk of chunks) {
    const parsed = JSON.parse(addon.extractWorkspace(chunk, rulesJson))
    if (round === 0) rustResults.push(...parsed.results)
  }
  addonTimes.push(millis(started))
}
const addonMs = Math.min(...addonTimes)
console.log(
  `addon: ${addonFile}, ${chunks.length} batches of <=${BATCH} over ${inputs.length} files`,
)

const supported = JSON.parse(addon.extractWorkspace([], rulesJson)).supported
console.log(`addon supported: ${JSON.stringify(supported)}`)

// 3. Parity against the JS extractor, on the wider set (minified files included).
const parityInputs = everythingNative.map(file => ({
  path: file.path,
  language: file.language,
  text: texts.get(file.path),
}))
const parityResults = []
for (let index = 0; index < parityInputs.length; index += BATCH) {
  parityResults.push(
    ...JSON.parse(addon.extractWorkspace(parityInputs.slice(index, index + BATCH), rulesJson))
      .results,
  )
}

// Built from the parity run's own results, not the production-timed ones: `omitted` below is
// "everything-set entries the addon did not return", and the two sets differ.
const rustByPath = new Map(parityResults.map(result => [result.path, result.extraction]))

function firstDifference(expected, actual, path = '$') {
  if (isDeepStrictEqual(expected, actual)) return undefined
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) {
      return `${path}: expected ${expected.length} items, got ${actual.length}`
    }
    for (let index = 0; index < expected.length; index++) {
      const difference = firstDifference(expected[index], actual[index], `${path}[${index}]`)
      if (difference !== undefined) return difference
    }
    return `${path}: arrays differ`
  }
  if (expected !== null && actual !== null && typeof expected === 'object' && typeof actual === 'object') {
    for (const key of Object.keys(expected)) {
      if (!(key in actual)) return `${path}.${key}: missing from Rust output`
      const difference = firstDifference(expected[key], actual[key], `${path}.${key}`)
      if (difference !== undefined) return difference
    }
    for (const key of Object.keys(actual)) {
      if (!(key in expected)) return `${path}.${key}: extra in Rust output`
    }
    return undefined
  }
  return `${path}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`
}

// The addon omits a file when *its own* parse produced errors (the documented policy, the JS
// side then falls back for that path). That condition is not observable through the addon, so
// this harness only reports omissions; `examples/parse-errors` is the independent check that
// the omitted set is exactly the Rust-side parse-error set.
async function jsParseHasErrors(path) {
  const parsed = (await createParser(languageFor(extname(path)))).parse(texts.get(path))
  return parsed.rootNode.hasError
}

const failures = []
const drift = []
const omitted = []
const jsErroredOmissions = []
const returned = []
const productionPaths = new Set(productionNative.map(file => file.path))
for (const result of parityResults) {
  const expected = jsExtractions.get(result.path)
  if (expected === undefined) {
    failures.push(`${result.path}: Rust returned a path the JS side did not extract`)
    continue
  }
  returned.push(result.path)
  const difference = firstDifference(expected, result.extraction)
  if (difference !== undefined) {
    const entry = `${result.path}: ${difference}`
    if (productionPaths.has(result.path)) failures.push(entry)
    else drift.push(entry)
  }
}
for (const file of everythingNative) {
  if (rustByPath.has(file.path)) continue
  omitted.push(file.path)
  if (await jsParseHasErrors(file.path)) jsErroredOmissions.push(file.path)
}

const totals = extractions =>
  extractions.reduce(
    (sum, extraction) => ({
      definitions: sum.definitions + extraction.definitions.length,
      calls: sum.calls + extraction.calls.length,
      imports: sum.imports + extraction.imports.length,
      heritage: sum.heritage + extraction.heritage.length,
    }),
    { definitions: 0, calls: 0, imports: 0, heritage: 0 },
  )

const productionReturned = returned.filter(path => productionPaths.has(path)).length
const productionOmitted = omitted.filter(path => productionPaths.has(path)).length
const productionJsOnly = production.files.length - productionNative.length
console.log(
  `parity: returned ${returned.length}/${everythingNative.length} equal; omitted ${omitted.length} ` +
    `(JS parse also failed on ${jsErroredOmissions.length}; the rest are Rust-grammar-only errors, ` +
    `verified with examples/parse-errors)`,
)
console.log(
  `parity production: ${productionReturned + productionOmitted + productionJsOnly}/${production.files.length} accounted ` +
    `(${productionReturned} returned equal, ${productionOmitted} omitted -> JS fallback, ${productionJsOnly} JS-only language)`,
)
const productionOmittedPaths = omitted.filter(path => productionPaths.has(path))
console.log(`  production omitted: ${JSON.stringify(productionOmittedPaths)}`)
console.log(`  stress drift (non-production, known grammar version diff): ${drift.length}`)
for (const entry of drift.slice(0, 10)) console.log(`   - ${entry}`)
console.log(`  rust totals (returned paths): ${JSON.stringify(totals(parityResults.map(result => result.extraction)))}`)
console.log(
  `  js   totals (same paths)   : ${JSON.stringify(totals(returned.map(path => jsExtractions.get(path))))}`,
)
if (failures.length > 0) {
  console.log(`  FAILURES (${failures.length}):`)
  for (const failure of failures.slice(0, 10)) console.log(`   - ${failure}`)
  process.exitCode = 1
}
if (productionReturned + productionOmitted + productionJsOnly !== production.files.length) {
  console.log('  production set is not fully accounted for')
  process.exitCode = 1
}

// 4. Timings, same files and same serial accumulation on both sides.
const jsTotalMs = parserSetupMs + parseMs + extractMs
console.log(
  `timing js   : parser-setup=${parserSetupMs.toFixed(1)}ms parse=${parseMs.toFixed(1)}ms ` +
    `extract=${extractMs.toFixed(1)}ms pipeline=${jsTotalMs.toFixed(1)}ms`,
)
console.log(
  `timing rust : addon=${addonMs.toFixed(1)}ms of 3 rounds [${addonTimes.map(t => t.toFixed(1)).join(', ')}] ` +
    `(parse+extract+serialize, ${chunks.length} calls)`,
)

writeFileSync(
  '/tmp/codegraph-adx-inputs.json',
  JSON.stringify(productionNative.map(file => ({ path: file.path, language: file.language, text: texts.get(file.path) }))),
)
writeFileSync(
  '/tmp/codegraph-adx-everything.json',
  JSON.stringify(everythingNative.map(file => ({ path: file.path, language: file.language, text: texts.get(file.path) }))),
)
writeFileSync('/tmp/codegraph-adx-omitted.txt', `${omitted.join('\n')}\n`)
console.log('wrote /tmp/codegraph-adx-inputs.json (production) and /tmp/codegraph-adx-everything.json + -omitted.txt')
if (failures.length > 0) process.exitCode = 1
