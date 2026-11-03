/**
 * Contract check for the built addon — the assertions the JS integration relies on,
 * run against the real `.node` rather than the Rust unit tests.
 *
 *   node --experimental-strip-types crates/indexer-rust/tools/check-addon.mjs
 */

import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { isDeepStrictEqual } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const crateRoot = join(here, '..')
const artifacts = join(crateRoot, 'artifacts')
const addonFile = readdirSync(artifacts).find(name => name.endsWith('.node'))
if (addonFile === undefined) throw new Error(`no .node artifact in ${artifacts}`)
const addon = createRequire(import.meta.url)(join(artifacts, addonFile))
const rules = readFileSync(join(crateRoot, 'tests', 'fixtures', 'language-rules.json'), 'utf8')

const checks = []
function check(name, run) {
  try {
    run()
    checks.push(`ok   ${name}`)
  } catch (error) {
    checks.push(`FAIL ${name}: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

check('empty batch answers an empty result list plus supported languages', () => {
  const answer = JSON.parse(addon.extractWorkspace([], rules))
  if (!isDeepStrictEqual(Object.keys(answer), ['results', 'supported'])) {
    throw new Error(`unexpected top-level keys ${JSON.stringify(Object.keys(answer))}`)
  }
  if (answer.results.length !== 0) throw new Error('expected no results')
  if (!isDeepStrictEqual(answer.supported, ['typescript', 'tsx', 'javascript', 'jsx'])) {
    throw new Error(`unexpected supported ${JSON.stringify(answer.supported)}`)
  }
})

check('a supported file yields exactly the four extraction fields', () => {
  const text = 'export function foo() { return bar() }\n'
  const answer = JSON.parse(addon.extractWorkspace([{ path: 'a.ts', language: 'typescript', text }], rules))
  const result = answer.results[0]
  if (!isDeepStrictEqual(Object.keys(result), ['path', 'extraction'])) {
    throw new Error(`unexpected result keys ${JSON.stringify(Object.keys(result))}`)
  }
  if (result.path !== 'a.ts') throw new Error('path not echoed')
  if (!isDeepStrictEqual(Object.keys(result.extraction), ['definitions', 'calls', 'imports', 'heritage'])) {
    throw new Error(`unexpected extraction keys ${JSON.stringify(Object.keys(result.extraction))}`)
  }
  const definition = result.extraction.definitions[0]
  if (!isDeepStrictEqual(Object.keys(definition), [
    'key', 'parentKey', 'kind', 'name', 'container', 'startLine', 'endLine',
    'startColumn', 'endColumn', 'isExported', 'isAsync', 'isStatic', 'decorators',
  ])) {
    throw new Error(`unexpected definition keys ${JSON.stringify(Object.keys(definition))}`)
  }
  if (definition.parentKey !== null) throw new Error('module-level parentKey must be null')
  if (!isDeepStrictEqual(result.extraction.calls, [{
    callerKey: definition.key,
    calleeName: 'bar',
    line: 1,
    // `export function foo() { return bar() }` — `bar` starts at UTF-16 offset 31.
    column: 31,
    isMemberCall: false,
  }])) {
    throw new Error(`unexpected call ${JSON.stringify(result.extraction.calls)}`)
  }
})

check('an unsupported input language is skipped, not an error', () => {
  const answer = JSON.parse(addon.extractWorkspace([
    { path: 'a.py', language: 'python', text: 'def foo(): pass\n' },
    { path: 'b.ts', language: 'typescript', text: 'export const x = 1\n' },
  ], rules))
  if (!isDeepStrictEqual(answer.results.map(result => result.path), ['b.ts'])) {
    throw new Error(`unexpected results ${JSON.stringify(answer.results.map(result => result.path))}`)
  }
})

check('a file whose parse has errors is omitted so the JS side can fall back', () => {
  const answer = JSON.parse(addon.extractWorkspace([
    { path: 'broken.ts', language: 'typescript', text: 'function broken( {\n  const = ;\n}\n' },
    { path: 'ok.ts', language: 'typescript', text: 'export const ok = 1\n' },
  ], rules))
  const paths = answer.results.map(result => result.path)
  if (!isDeepStrictEqual(paths, ['ok.ts'])) {
    throw new Error(`unexpected results ${JSON.stringify(paths)}; the broken file must be omitted`)
  }
  if (!isDeepStrictEqual(answer.supported, ['typescript', 'tsx', 'javascript', 'jsx'])) {
    throw new Error('omitting a file must not change the supported language list')
  }
})

check('malformed rulesJson rejects instead of crashing the process', () => {
  let threw = false
  try {
    addon.extractWorkspace([{ path: 'a.ts', language: 'typescript', text: 'const a = 1\n' }], 'not json')
  } catch (error) {
    threw = true
    if (!String(error).includes('rulesJson')) throw new Error(`unexpected error ${String(error)}`)
  }
  if (!threw) throw new Error('expected a rejected call')
})

check('UTF-16 columns match the JS extractor on non-ASCII lines', () => {
  const answer = JSON.parse(addon.extractWorkspace([{
    path: 'u.ts',
    language: 'typescript',
    text: 'const 变量 = foo(1)\n',
  }], rules))
  // Byte column would be 15; the JS side reports the UTF-16 offset 11.
  if (answer.results[0].extraction.calls[0].column !== 11) {
    throw new Error(`unexpected column ${answer.results[0].extraction.calls[0].column}`)
  }
})

console.log(`addon: ${addonFile}`)
console.log(checks.join('\n'))
