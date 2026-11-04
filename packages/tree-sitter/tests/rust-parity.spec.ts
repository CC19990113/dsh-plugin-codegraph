/**
 * Parity between this package's own extractor and the native Rust addon, plus the fallback contract
 * that makes the addon optional.
 *
 * The parity cases only run where the addon was actually built: a checkout without a Rust toolchain
 * has no artifact under `crates/indexer-rust/artifacts`, and this package must never require one to
 * pass its own tests. The fallback cases run everywhere regardless, because they are about what
 * happens when the addon is missing, broken, or declines a file — the behaviour every deployment
 * depends on, whether or not it has an artifact at all.
 * @module dsh-plugin-codegraph-tree-sitter/tests/rust-parity
 */

import { readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import type { ParseCacheFileSystem } from '../src/cache.ts'
import { createParser } from '../src/grammar.ts'
import { extractFile } from '../src/extract.ts'
import type { FileExtraction } from '../src/extract.ts'
import { languageFor } from '../src/languages.ts'
import { candidateModulePaths, extractWithRust, modulePathsFor, installRustEngineForTests, loadRustEngine, nativePackageModulePath, nativePackageName, RUST_BATCH_SIZE } from '../src/rust-engine.ts'
import type { RustEngine, RustExtractInput } from '../src/rust-engine.ts'
import { walkAndExtract } from '../src/walk.ts'
import type { WalkConfig } from '../src/walk.ts'
import { writeProject } from './fixture.ts'

/** The addon, loaded once for the whole file — `undefined` when this checkout has no artifact. */
const addon = loadRustEngine()

/** This repository's root, three directories above this test file. */
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url))

/** One seam instance for the whole file: the local backend is stateless. */
const fs = await (async (): Promise<ParseCacheFileSystem> => {
  const ctx = new Context()
  await ctx.plugin(LocalFileSystem, {})
  return (ctx as Context & { readonly fs: ParseCacheFileSystem }).fs
})()

/** The walk's bounds, matching `walk.spec.ts`: no cache, so every file goes through an extractor. */
const BASE: WalkConfig = {
  exclude: ['node_modules', '.git'],
  respectGitignore: true,
  skipMinified: true,
  maxFileBytes: 2_000_000,
  maxFiles: 50_000,
  concurrency: 4,
  reuseParsedCache: false,
  cacheVerify: 'stat',
}

/**
 * The shapes the two extractors have to agree on, one file per grammar family: classes with heritage,
 * decorators and static/async members; generics; enums and namespaces; CommonJS exports; JSX; a
 * non-ASCII identifier (whose colunms differ between bytes and UTF-16 code units, which is exactly
 * where a native port drifts); a destructuring binding the rules must reject; and a file whose root
 * node carries a parse error, which the addon may decline outright.
 */
const FIXTURE: Record<string, string> = {
  'src/classes.ts': `
import { readFile } from 'node:fs/promises'
import * as path from 'node:path'
import defaultThing, { helper as renamed } from './helper'

export interface Shape { area(): number }
export type Point = { x: number; y: number }
export enum Colour { Red, Green }

@decorated
export abstract class Base<T> extends Parent implements Shape, Other {
  private static count = 0
  public field: string
  readonly items: number[] = []
  async method(input: T): Promise<number> {
    const local = () => helper(renamed(1))
    return this.field + local()
  }
  static create(): Base<unknown> { return new Base() }
  area() { return 0 }
}

export function standalone(a: number, b = 2, ...rest: string[]) {
  class Inner { nested() { return standalone(1) } }
  return path.join('a', 'b') + readFile + defaultThing + b + rest.length
}
const 变量 = standalone(1)
export const arrow = async (x: number) => standalone(x)
export default class {}
namespace NS { export const inside = 1 }
`,
  'src/app.tsx': `
import React, { useState } from 'react'
import { Button } from './button'

export function App({ title }: { title: string }) {
  const [count, setCount] = useState(0)
  const handle = () => setCount(count + 1)
  return <div className="app"><Button onClick={handle}>{title}</Button></div>
}

export const View = () => <span>{render(App)}</span>
class Comp extends React.Component<{ a: number }> {
  render() { return <Comp a={this.props.a} /> }
}
`,
  'src/util.js': `
const fs = require('node:fs')
const { join } = require('node:path')
module.exports = { run, helper }
function run(input) { return helper(input) + fs + join }
function helper(x) { return x }
exports.extra = (y) => run(y)
const obj = { method: function () { return run(1) } }
class Klass { static make() { return new Klass() } }
`,
  'src/view.jsx': `
import React from 'react'
export function List({ items }) {
  return <ul>{items.map(item => <li key={item.id}>{item.name}</li>)}</ul>
}
const Memo = React.memo(function Inner(props) { return <List {...props} /> })
`,
  'src/edge.ts': `
export const { a, b } = obj
export function f() { if (true) { function g() { return h() } } }
export class A extends mixin(Base) {}
export class B extends (Base as unknown) implements Shape {}
`,
  'src/broken.ts': 'export function oops( {\n  const = ;\n',
}

/**
 * {@link FIXTURE} minus the one file a per-path assertion cannot demand: a file whose root node
 * carries a parse error is expected to be **absent** from the addon's answer (it declines what it
 * cannot vouch for, and the walk parses that path with `extractFile`). Its guarantee is therefore at
 * the walk level — `auto` and `js` must produce byte-identical results — which is asserted below
 * rather than here.
 */
const STRICT_FILES = Object.keys(FIXTURE).filter(path => path !== 'src/broken.ts')

/**
 * An extra workspace to check `auto` against `js` over, when one is named in the environment. The
 * three-file divergence that motivated this check lives in a workspace this repository does not
 * contain, so a run against it has to be opt-in: `CODEGRAPH_PARITY_WORKSPACE=/path/to/repo pnpm test`.
 * Unset (the default, and CI) skips the case instead of failing on a checkout that lacks the dir.
 */
const PARITY_WORKSPACE = process.env['CODEGRAPH_PARITY_WORKSPACE']

/**
 * Real files from this repository, one per package that ships TypeScript plus the one hand-written
 * JavaScript file in the tree. Actual source is where the two implementations meet shapes no fixture
 * would think to include.
 */
const REAL_FILES = [
  'packages/tree-sitter/src/extract.ts',
  'packages/tree-sitter/src/walk.ts',
  'packages/tree-sitter/src/rust-engine.ts',
  'packages/sqlite/src/index.ts',
  'packages/tool/src/index.ts',
  'packages/panel/lib/client.js',
]

/**
 * What this package's own extractor finds in one file, for comparison with the addon's answer.
 * @param path - project-relative path, whose extension picks the grammar.
 * @param text - the file's full text.
 * @returns the extraction.
 */
async function extractWithJsFile(path: string, text: string): Promise<FileExtraction> {
  const spec = languageFor(extname(path))
  if (spec === undefined) throw new Error(`no grammar for ${path}`)
  const parser = await createParser(spec)
  try {
    const tree = parser.parse(text)
    if (tree === null) throw new Error(`parse produced no tree for ${path}`)
    return extractFile(tree, spec)
  } finally {
    parser.delete()
  }
}

/**
 * The addon's input shape for a set of in-memory files.
 * @param files - project-relative path to content.
 * @returns one input per file, with the language its extension resolves to.
 */
function rustInputs(files: Record<string, string>): RustExtractInput[] {
  return Object.entries(files).map(([path, text]) => {
    const spec = languageFor(extname(path))
    if (spec === undefined) throw new Error(`no grammar for ${path}`)
    return { path, language: spec.language, text }
  })
}

/**
 * Write a stand-in addon module that a `require` of its path loads.
 * @param source - the module's CommonJS source.
 * @returns the module's absolute path.
 */
async function writeModule(source: string): Promise<string> {
  const path = join(tmpdir(), `codegraph-rust-engine-${process.pid}-${Math.random().toString(36).slice(2)}.cjs`)
  await writeFile(path, source)
  return path
}

/** One extraction the fake addons below answer with: structurally valid, and empty on purpose. */
const EMPTY_EXTRACTION: FileExtraction = { definitions: [], calls: [], imports: [], heritage: [] }

afterEach(() => {
  vi.restoreAllMocks()
})

// Declared before the parity cases because the report-once assertion has to be the first failure this
// process sees — see the case itself.
describe('rust-engine availability', () => {
  it('reports a missing artifact once per process, in a module instance of its own', async () => {
    // `vi.resetModules()` gives this case an unshared copy of the module, so an earlier (or later)
    // failure elsewhere in the run cannot have already spent the one report it is asserting.
    vi.resetModules()
    const fresh = await import('../src/rust-engine.ts')
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const modulePath = join(tmpdir(), `codegraph-absent-${process.pid}`, 'codegraph-indexer.node')
    expect(fresh.loadRustEngine({ modulePath })).toBeUndefined()
    // Second call: a failed path is remembered, so no second `require` and no second log.
    expect(fresh.loadRustEngine({ modulePath })).toBeUndefined()
    expect(errors).toHaveBeenCalledTimes(1)
    expect(String(errors.mock.calls[0]?.[0])).toContain('Rust extraction unavailable')
  })

  it('treats a module without the entry point as unavailable', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const modulePath = await writeModule('module.exports = {}\n')
    expect(loadRustEngine({ modulePath })).toBeUndefined()
  })

  it('loads a given artifact once and hands back the same instance', async () => {
    const modulePath = await writeModule('module.exports = { extractWorkspace: () => "{}" }\n')
    const first = loadRustEngine({ modulePath })
    expect(first).toBeDefined()
    expect(loadRustEngine({ modulePath })).toBe(first)
  })
})

describe('rust-engine fallback', () => {
  /**
   * A stand-in addon whose one method is scripted by the case.
   * @param extractWorkspace - what the addon does when called.
   * @returns the double.
   */
  function fakeEngine(extractWorkspace: RustEngine['extractWorkspace']): RustEngine {
    return { extractWorkspace }
  }

  it('answers undefined when there is no addon at all', async () => {
    expect(await extractWithRust(rustInputs({ 'a.ts': 'export const a = 1\n' }), undefined)).toBeUndefined()
  })

  it('never calls the addon for a language it does not handle', async () => {
    const called = vi.fn<RustEngine['extractWorkspace']>(() => '{}')
    const rusted = await extractWithRust([{ path: 'a.py', language: 'python', text: 'x = 1\n' }], fakeEngine(called))
    expect(rusted?.size).toBe(0)
    expect(called).not.toHaveBeenCalled()
  })

  it('treats unparsable JSON, and JSON of the wrong shape, as no extraction at all', async () => {
    const inputs = rustInputs({ 'a.ts': 'export const a = 1\n' })
    for (const answer of ['not json', 'null', '{}', '{"results":42}']) {
      expect(await extractWithRust(inputs, fakeEngine(() => answer)), answer).toBeUndefined()
    }
  })

  it('keeps every well-formed entry and skips the malformed ones', async () => {
    const answer = JSON.stringify({
      results: [
        null,
        42,
        [],
        { path: 7, extraction: EMPTY_EXTRACTION },
        { path: 'no-extraction.ts' },
        { path: 'kept.ts', extraction: EMPTY_EXTRACTION },
      ],
      supported: ['typescript'],
    })
    const rusted = await extractWithRust(rustInputs({ 'kept.ts': 'export const a = 1\n' }), fakeEngine(() => answer))
    expect([...(rusted?.keys() ?? [])]).toEqual(['kept.ts'])
    expect(rusted?.get('kept.ts')).toStrictEqual(EMPTY_EXTRACTION)
  })

  it('treats a thrown addon call as no extraction at all', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const inputs = rustInputs({ 'a.ts': 'export const a = 1\n' })
    const engine = fakeEngine(() => { throw new Error('boom') })
    expect(await extractWithRust(inputs, engine)).toBeUndefined()
  })

  it('splits a large batch at RUST_BATCH_SIZE and merges every answer', async () => {
    const sizes: number[] = []
    const engine = fakeEngine((inputs) => {
      sizes.push(inputs.length)
      return JSON.stringify({ results: inputs.map(input => ({ path: input.path, extraction: EMPTY_EXTRACTION })), supported: [] })
    })
    const files: Record<string, string> = {}
    for (let index = 0; index < RUST_BATCH_SIZE + 1; index++) files[`f${index}.ts`] = 'export const x = 1\n'
    const rusted = await extractWithRust(rustInputs(files), engine)
    expect(sizes).toEqual([RUST_BATCH_SIZE, 1])
    expect(rusted?.size).toBe(RUST_BATCH_SIZE + 1)
  })
})

describe('walk fallback', () => {
  it('parses one declined file with extractFile and keeps the rest of the batch', async () => {
    const root = await writeProject({
      'a.ts': 'export function a() { return helper() }\n',
      'b.ts': 'export function b() { return 1 }\n',
    })
    installRustEngineForTests({
      extractWorkspace: inputs => JSON.stringify({
        results: inputs.filter(input => input.path === 'a.ts').map(input => ({ path: input.path, extraction: EMPTY_EXTRACTION })),
        supported: ['typescript'],
      }),
    })
    try {
      const auto = await walkAndExtract(root, { ...BASE, engine: 'auto' }, fs)
      const js = await walkAndExtract(root, { ...BASE, engine: 'js' }, fs)
      // `a.ts` carries the addon's answer, so it is empty rather than the definition `a`.
      expect(auto.files.find(file => file.path === 'a.ts')?.extraction).toStrictEqual(EMPTY_EXTRACTION)
      // `b.ts` was not answered for, so it came from `extractFile` — identically to the `'js'` run.
      const expected = js.files.find(file => file.path === 'b.ts')?.extraction
      expect(expected?.definitions).toHaveLength(1)
      expect(auto.files.find(file => file.path === 'b.ts')?.extraction).toStrictEqual(expected)
      // Both engines still report the same set of files: the fallback changes who parsed a file, not
      // what was indexed.
      expect(auto.files.map(file => file.path)).toEqual(js.files.map(file => file.path))
    } finally {
      installRustEngineForTests(undefined)
    }
  })

  it('indexes everything through extractFile when the addon throws', async () => {
    const root = await writeProject({ 'a.ts': 'export function a() { return helper() }\n' })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    installRustEngineForTests({ extractWorkspace: () => { throw new Error('boom') } })
    try {
      const rust = await walkAndExtract(root, { ...BASE, engine: 'rust' }, fs)
      const js = await walkAndExtract(root, { ...BASE, engine: 'js' }, fs)
      expect(rust.files).toStrictEqual(js.files)
      expect(rust.files[0]?.extraction.definitions.length).toBeGreaterThan(0)
    } finally {
      installRustEngineForTests(undefined)
    }
  })
})

describe.skipIf(addon === undefined)('rust parity against extractFile', () => {
  it('matches on every fixture file', async () => {
    const inputs = rustInputs(FIXTURE).filter(input => STRICT_FILES.includes(input.path))
    const rusted = await extractWithRust(inputs, addon)
    expect(rusted).toBeDefined()
    for (const input of inputs) {
      const native = rusted?.get(input.path)
      expect(native, `${input.path} is missing from the addon's answer`).toBeDefined()
      expect(native, input.path).toStrictEqual(await extractWithJsFile(input.path, input.text))
    }
  })

  it('produces an identical walk result for a file with a root parse error', async () => {
    const root = await writeProject({
      'src/broken.ts': FIXTURE['src/broken.ts'] ?? '',
      'src/ok.ts': 'export function ok() { return 1 }\n',
    })
    const auto = await walkAndExtract(root, { ...BASE, engine: 'auto' }, fs)
    const js = await walkAndExtract(root, { ...BASE, engine: 'js' }, fs)
    // Strict on purpose, unlike the per-path presence check above: whether the addon answers for this
    // file or declines it, what the user sees must be exactly the `js` result. That is the whole point
    // of declining per path instead of failing a batch — and it makes a regression on either side
    // visible here, which a "declines or agrees" allowance would let through.
    expect(auto).toStrictEqual(js)
    expect(auto.files.map(file => file.path)).toEqual(['src/broken.ts', 'src/ok.ts'])
  })

  it.skipIf(PARITY_WORKSPACE === undefined)('produces an identical walk result over an external workspace', async () => {
    const auto = await walkAndExtract(PARITY_WORKSPACE ?? '', { ...BASE, engine: 'auto' }, fs)
    const js = await walkAndExtract(PARITY_WORKSPACE ?? '', { ...BASE, engine: 'js' }, fs)
    expect(auto).toStrictEqual(js)
  })

  it("matches on this repository's own source files", async () => {
    const inputs: RustExtractInput[] = []
    for (const path of REAL_FILES) {
      const text = await readFile(join(REPO_ROOT, path), 'utf8')
      const spec = languageFor(extname(path))
      if (spec === undefined) throw new Error(`no grammar for ${path}`)
      inputs.push({ path, language: spec.language, text })
    }
    const rusted = await extractWithRust(inputs, addon)
    expect(rusted?.size).toBe(inputs.length)
    for (const input of inputs) {
      const native = rusted?.get(input.path)
      expect(native, `${input.path} is missing from the addon's answer`).toBeDefined()
      expect(native, input.path).toStrictEqual(await extractWithJsFile(input.path, input.text))
    }
  })

  it('produces an identical walk result whichever engine parses the files', async () => {
    const root = await writeProject(FIXTURE)
    const auto = await walkAndExtract(root, { ...BASE, engine: 'auto' }, fs)
    const js = await walkAndExtract(root, { ...BASE, engine: 'js' }, fs)
    // Every field is compared, `filesReused` included: no cache is involved in this walk, so the
    // engine choice must be invisible in the whole result, not just in the extractions.
    expect(auto).toStrictEqual(js)
    // Same files, same order — a declined path falling back must not reorder or drop anything.
    expect(auto.files.map(file => file.path)).toEqual(js.files.map(file => file.path))
    expect(auto.files).toHaveLength(Object.keys(FIXTURE).length)
  })
})

describe('optional native package resolution', () => {
  it('names one package per published platform, and nothing for the rest', () => {
    expect(nativePackageName('darwin', 'arm64')).toBe('dsh-plugin-codegraph-indexer-darwin-arm64')
    expect(nativePackageName('darwin', 'x64')).toBe('dsh-plugin-codegraph-indexer-darwin-x64')
    expect(nativePackageName('linux', 'x64')).toBe('dsh-plugin-codegraph-indexer-linux-x64-gnu')
    expect(nativePackageName('linux', 'arm64')).toBe('dsh-plugin-codegraph-indexer-linux-arm64-gnu')
    expect(nativePackageName('win32', 'x64')).toBe('dsh-plugin-codegraph-indexer-win32-x64-msvc')
    // A platform this project publishes no build for must answer nothing rather than guess a name.
    expect(nativePackageName('freebsd', 'x64')).toBeUndefined()
  })

  it('resolves through the injected resolver, and reports a miss as no addon', () => {
    expect(nativePackageModulePath('darwin', 'arm64', () => '/scratch/addon.node')).toBe('/scratch/addon.node')
    expect(nativePackageModulePath('darwin', 'arm64', () => { throw new Error('not installed') })).toBeUndefined()
    // An unsupported platform never reaches the resolver at all.
    expect(nativePackageModulePath('freebsd', 'x64', () => { throw new Error('must not be called') })).toBeUndefined()
  })

  it('offers the package path last, after both local layouts', () => {
    const base = import.meta.url
    // The two local layouts always come first, whether or not this machine happens to have the
    // optional package installed (passing `undefined` falls back to the real resolution).
    const paths = modulePathsFor(base, '/scratch/addon.node')
    expect(paths).toHaveLength(3)
    expect(paths[0]).toContain('packages/tree-sitter/artifacts')
    expect(paths[1]).toContain('crates/indexer-rust/artifacts')
    // Last, not first: a checkout's own build and a hand-copied artifact stay preferred.
    expect(paths[2]).toBe('/scratch/addon.node')
    // Without an optional package the answer is the two local layouts and nothing else.
    expect(modulePathsFor(base, undefined)).toHaveLength(2)
    // Production resolves the package itself; it must still start with the local layouts.
    expect(candidateModulePaths(base).length).toBeGreaterThanOrEqual(2)
  })
})
