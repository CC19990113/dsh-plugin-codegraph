/**
 * Fixture-expectation generator.
 *
 * The JS extractor in `packages/tree-sitter/src/extract.ts` is the behaviour spec this
 * crate is measured against, so every `<fixture>.expected.json` next to a source file
 * below is written by it, never by hand. Re-run after adding a fixture:
 *
 *   node --experimental-strip-types crates/indexer-rust/tools/gen-expected.mjs
 *
 * It also refreshes `tests/fixtures/language-rules.json` — the `LANGUAGE_TABLE` entries
 * for the four supported languages, i.e. exactly the `rulesJson` the JS side will pass
 * to `extractWorkspace`.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { LANGUAGE_TABLE, languageFor } from '../../../packages/tree-sitter/src/languages.ts'
import { extractFile } from '../../../packages/tree-sitter/src/extract.ts'
import { createParser } from '../../../packages/tree-sitter/src/grammar.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixturesRoot = join(here, '..', 'tests', 'fixtures')
const SUPPORTED = ['typescript', 'tsx', 'javascript', 'jsx']
const GROUPS = ['ts', 'tsx', 'js', 'jsx']

const rules = LANGUAGE_TABLE.filter(spec => SUPPORTED.includes(spec.language))
writeFileSync(join(fixturesRoot, 'language-rules.json'), `${JSON.stringify(rules, null, 2)}\n`)

const parsers = new Map()
async function parserFor(spec) {
  let parser = parsers.get(spec.language)
  if (parser === undefined) {
    parser = await createParser(spec)
    parsers.set(spec.language, parser)
  }
  return parser
}

let sources = 0
for (const group of GROUPS) {
  const directory = join(fixturesRoot, group)
  for (const name of readdirSync(directory).sort()) {
    if (name.endsWith('.expected.json')) continue
    const sourcePath = join(directory, name)
    const source = readFileSync(sourcePath, 'utf8')
    const spec = languageFor(name.slice(name.lastIndexOf('.')))
    if (spec === undefined) throw new Error(`no grammar for fixture ${sourcePath}`)
    const parser = await parserFor(spec)
    const tree = parser.parse(source)
    if (tree === null) throw new Error(`parse failed for ${sourcePath}`)
    const extraction = extractFile(tree, spec)
    const expectedPath = sourcePath.replace(/\.[^.]+$/, '.expected.json')
    writeFileSync(expectedPath, `${JSON.stringify(extraction, null, 2)}\n`)
    sources += 1
    console.log(
      `${expectedPath}: ${extraction.definitions.length} defs, ${extraction.calls.length} calls, ` +
        `${extraction.imports.length} imports, ${extraction.heritage.length} heritage`,
    )
  }
}
console.log(`wrote ${sources} expectations and ${rules.length} language specs`)
