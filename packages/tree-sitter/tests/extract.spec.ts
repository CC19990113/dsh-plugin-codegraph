import { describe, expect, it } from 'vitest'
import { createParser } from '../src/grammar.ts'
import { languageFor } from '../src/languages.ts'
import { extractFile } from '../src/extract.ts'
import type { FileExtraction } from '../src/extract.ts'
import type { LanguageSpec } from '../src/languages.ts'

async function extract(extension: string, source: string): Promise<{ extraction: FileExtraction; spec: LanguageSpec }> {
  const spec = languageFor(extension)
  if (spec === undefined) throw new Error(`no grammar for ${extension}`)
  const parser = await createParser(spec)
  try {
    const tree = parser.parse(source)
    if (tree === null) throw new Error('parse failed')
    return { extraction: extractFile(tree, spec), spec }
  } finally {
    parser.delete()
  }
}

describe('TypeScript extraction', () => {
  const SOURCE = `
export function foo(a: number): number {
  return bar(a)
}
class MathHelper {
  static async calc(x: number) {
    return foo(x)
  }
}
export const arrow = (x: number) => foo(x)
export default function baz() {}
import { bar } from './bar'
import Def from './def'
interface Thing { x: number }
type Alias = number
`

  it('extracts function, method, class, arrow-function, interface, and type_alias definitions', async () => {
    const { extraction } = await extract('.ts', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('foo')).toMatchObject({ kind: 'function', isExported: true })
    expect(byName.get('calc')).toMatchObject({ kind: 'method', isStatic: true, isAsync: true })
    expect(byName.get('MathHelper')).toMatchObject({ kind: 'class', isExported: false })
    expect(byName.get('arrow')).toMatchObject({ kind: 'function', isExported: true })
    expect(byName.get('baz')).toMatchObject({ kind: 'function', isExported: true })
    expect(byName.get('Thing')).toMatchObject({ kind: 'interface', isExported: false })
    expect(byName.get('Alias')).toMatchObject({ kind: 'type_alias' })
  })

  it('nests the method under its class in the container chain', async () => {
    const { extraction } = await extract('.ts', SOURCE)
    const calc = extraction.definitions.find(def => def.name === 'calc')
    expect(calc?.container).toEqual(['MathHelper'])
  })

  it('extracts call sites attributed to their enclosing definition', async () => {
    const { extraction } = await extract('.ts', SOURCE)
    const foo = extraction.definitions.find(def => def.name === 'foo')
    const calc = extraction.definitions.find(def => def.name === 'calc')
    expect(extraction.calls).toContainEqual(expect.objectContaining({ callerKey: foo?.key, calleeName: 'bar' }))
    expect(extraction.calls).toContainEqual(expect.objectContaining({ callerKey: calc?.key, calleeName: 'foo' }))
  })

  it('extracts named and default import bindings with their specifiers', async () => {
    const { extraction } = await extract('.ts', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'bar', importedName: 'bar', specifier: './bar' })
    expect(extraction.imports).toContainEqual({ localName: 'Def', importedName: 'default', specifier: './def' })
  })

  it('extracts a renamed named import and a namespace import', async () => {
    const { extraction } = await extract('.ts', "import { bar as renamed } from './bar'\nimport * as ns from './ns'\n")
    expect(extraction.imports).toContainEqual({ localName: 'renamed', importedName: 'bar', specifier: './bar' })
    expect(extraction.imports).toContainEqual({ localName: 'ns', importedName: '*', specifier: './ns' })
  })

  it('extracts nothing from a side-effect-only import (no clause)', async () => {
    const { extraction } = await extract('.ts', "import './side'\n")
    expect(extraction.imports).toEqual([])
  })

  it('resolves an empty string specifier without a string_fragment child', async () => {
    const { extraction } = await extract('.ts', "import Def from ''\n")
    expect(extraction.imports).toEqual([{ localName: 'Def', importedName: 'default', specifier: '' }])
  })

  it('resolves a member-access call to the property name', async () => {
    const { extraction } = await extract('.ts', 'obj.parse(x)\n')
    expect(extraction.calls).toContainEqual(expect.objectContaining({ calleeName: 'parse' }))
  })

  it('does not extract a plain (non-function) variable as a definition', async () => {
    const { extraction } = await extract('.ts', 'const value = 5\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not extract a variable declared without an initializer', async () => {
    const { extraction } = await extract('.ts', 'let value: number\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not extract a computed callee as a call site', async () => {
    const { extraction } = await extract('.ts', 'obj[key](x)\n')
    expect(extraction.calls).toEqual([])
  })
})

describe('TSX extraction', () => {
  it('parses TSX syntax and extracts its function definition', async () => {
    const { extraction } = await extract('.tsx', 'export function App() { return <div>hi</div> }\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'App', kind: 'function' }))
  })
})

describe('JavaScript and JSX extraction', () => {
  it('extracts a plain JavaScript function and its call', async () => {
    const { extraction } = await extract('.js', 'function foo() { return bar() }\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'foo', kind: 'function' }))
    expect(extraction.calls).toContainEqual(expect.objectContaining({ calleeName: 'bar' }))
  })

  it('parses JSX syntax with the JavaScript grammar', async () => {
    const { extraction } = await extract('.jsx', 'function App() { return <div>hi</div> }\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'App' }))
  })
})

describe('Python extraction', () => {
  const SOURCE = `
def foo(a):
    return bar(a)

class MathHelper(Base):
    def calc(self, x):
        return foo(x)

from .bar import bar
from .bar import bar as renamed
import os
`

  it('extracts function and class definitions, with every declaration marked not exported', async () => {
    const { extraction } = await extract('.py', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('foo')).toMatchObject({ kind: 'function', isExported: false })
    expect(byName.get('MathHelper')).toMatchObject({ kind: 'class', isExported: false })
    expect(byName.get('calc')).toMatchObject({ kind: 'function', isExported: false, container: ['MathHelper'] })
  })

  it('extracts call sites attributed to their enclosing function', async () => {
    const { extraction } = await extract('.py', SOURCE)
    const foo = extraction.definitions.find(def => def.name === 'foo')
    expect(extraction.calls).toContainEqual(expect.objectContaining({ callerKey: foo?.key, calleeName: 'bar' }))
  })

  it('extracts a relative from-import, its rename, and a bare import', async () => {
    const { extraction } = await extract('.py', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'bar', importedName: 'bar', specifier: '.bar' })
    expect(extraction.imports).toContainEqual({ localName: 'renamed', importedName: 'bar', specifier: '.bar' })
    expect(extraction.imports).toContainEqual({ localName: 'os', importedName: '*', specifier: 'os' })
  })

  it('extracts a renamed bare import', async () => {
    const { extraction } = await extract('.py', 'import numpy as np\n')
    expect(extraction.imports).toEqual([{ localName: 'np', importedName: '*', specifier: 'numpy' }])
  })

  it('extracts nothing from a wildcard from-import', async () => {
    const { extraction } = await extract('.py', 'from x import *\n')
    expect(extraction.imports).toEqual([])
  })

  it('resolves a relative from-import with no module name (only dots)', async () => {
    const { extraction } = await extract('.py', 'from . import foo\n')
    expect(extraction.imports).toEqual([{ localName: 'foo', importedName: 'foo', specifier: '.' }])
  })

  it('extracts an absolute (non-relative) from-import without confusing the module name for an imported symbol', async () => {
    const { extraction } = await extract('.py', 'from os import path\n')
    expect(extraction.imports).toEqual([{ localName: 'path', importedName: 'path', specifier: 'os' }])
  })
})

describe('Go extraction', () => {
  const SOURCE = `
package main

import "fmt"
import myfmt "fmt"

func foo(a int) int {
	return bar(a)
}

type MathHelper struct{}

func (m *MathHelper) Calc(x int) int {
	return foo(x)
}

func unexported() {}
`

  it('extracts function and method declarations, exported by capitalization', async () => {
    const { extraction } = await extract('.go', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('foo')).toMatchObject({ kind: 'function', isExported: false })
    expect(byName.get('Calc')).toMatchObject({ kind: 'method', isExported: true })
    expect(byName.get('unexported')).toMatchObject({ isExported: false })
  })

  it('extracts a type declaration', async () => {
    const { extraction } = await extract('.go', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'MathHelper', kind: 'type_alias' }))
  })

  it('extracts call sites attributed to their enclosing function', async () => {
    const { extraction } = await extract('.go', SOURCE)
    const foo = extraction.definitions.find(def => def.name === 'foo')
    expect(extraction.calls).toContainEqual(expect.objectContaining({ callerKey: foo?.key, calleeName: 'bar' }))
  })

  it('extracts package imports, including a renamed one', async () => {
    const { extraction } = await extract('.go', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'fmt', importedName: '*', specifier: 'fmt' })
    expect(extraction.imports).toContainEqual({ localName: 'myfmt', importedName: '*', specifier: 'fmt' })
  })
})
