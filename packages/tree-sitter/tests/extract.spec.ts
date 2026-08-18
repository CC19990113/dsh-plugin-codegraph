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

  it('extracts a plain module-level (non-function) variable as a variable definition', async () => {
    const { extraction } = await extract('.ts', 'const value = 5\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'value', kind: 'variable' })])
  })

  it('extracts a module-level variable declared without an initializer', async () => {
    const { extraction } = await extract('.ts', 'let value: number\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'value', kind: 'variable' })])
  })

  it('does not name a destructuring variable_declarator after its pattern text', async () => {
    const { extraction } = await extract('.ts', 'const {a, b} = obj\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not extract a variable declared inside a function body', async () => {
    const { extraction } = await extract('.ts', 'function outer() {\n  const local = 1\n  return local\n}\n')
    expect(extraction.definitions.map(def => def.name)).toEqual(['outer'])
  })

  it('does not extract a variable declared inside a callback that is never itself a named definition', async () => {
    const { extraction } = await extract('.ts', 'arr.forEach(function (item) {\n  const total = compute(item)\n  return total\n})\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not extract a variable declared inside an IIFE at module top level', async () => {
    const { extraction } = await extract('.ts', 'const y = (() => {\n  const arrowLocal = 2\n  return arrowLocal\n})()\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'y', kind: 'variable' })])
  })

  it('extracts TypeScript class fields (public_field_definition), including a private one', async () => {
    const { extraction } = await extract('.ts', 'class Foo {\n  x = 1\n  static y = 2\n  #priv = 3\n}\n')
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('x')).toMatchObject({ kind: 'field', container: ['Foo'] })
    expect(byName.get('y')).toMatchObject({ kind: 'field', isStatic: true })
    expect(byName.get('#priv')).toMatchObject({ kind: 'field' })
  })

  it('extracts a bare enum member as an enum_member nested under its enum', async () => {
    const { extraction } = await extract('.ts', 'enum Color { Red, Blue }\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Red', kind: 'enum_member', container: ['Color'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Blue', kind: 'enum_member', container: ['Color'] }))
  })

  it('extracts a valued enum member (enum_assignment) as an enum_member', async () => {
    const { extraction } = await extract('.ts', 'enum Color { Green = 5 }\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Green', kind: 'enum_member', container: ['Color'] }))
  })

  it('does not mistake an ordinary property_identifier (e.g. a method name) for an enum member', async () => {
    const { extraction } = await extract('.ts', 'class Foo {\n  bar() {}\n}\n')
    expect(extraction.definitions).not.toContainEqual(expect.objectContaining({ kind: 'enum_member' }))
  })

  it('does not extract a computed callee as a call site', async () => {
    const { extraction } = await extract('.ts', 'obj[key](x)\n')
    expect(extraction.calls).toEqual([])
  })
})

describe('CommonJS require() import detection', () => {
  it('binds a require() assigned to a plain identifier', async () => {
    const { extraction } = await extract('.js', "const foo = require('./foo')\n")
    expect(extraction.imports).toContainEqual({ localName: 'foo', importedName: '*', specifier: './foo' })
  })

  it('resolves an empty string specifier without a string_fragment child', async () => {
    const { extraction } = await extract('.js', "const foo = require('')\n")
    expect(extraction.imports).toContainEqual({ localName: 'foo', importedName: '*', specifier: '' })
  })

  it('records a bare, side-effect-only require() statement', async () => {
    const { extraction } = await extract('.js', "require('./sideeffect')\n")
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: './sideeffect' })
  })

  it('does not bind a destructured require() (no single declared name to bind)', async () => {
    const { extraction } = await extract('.js', "const { a } = require('./bar')\n")
    expect(extraction.imports).toEqual([])
  })

  it('does not treat require() used as a sub-expression as an import binding', async () => {
    const { extraction } = await extract('.js', "console.log(require('./bar'))\n")
    expect(extraction.imports).toEqual([])
  })

  it('does not treat a require()-shaped call with the wrong argument count as an import', async () => {
    const { extraction: zeroArgs } = await extract('.js', "const a = require()\n")
    expect(zeroArgs.imports).toEqual([])
    const { extraction: twoArgs } = await extract('.js', "const b = require('./a', './b')\n")
    expect(twoArgs.imports).toEqual([])
  })

  it('does not treat require() with a non-string argument as an import', async () => {
    const { extraction } = await extract('.js', "const a = require(modulePath)\n")
    expect(extraction.imports).toEqual([])
    expect(extraction.calls).toContainEqual(expect.objectContaining({ calleeName: 'require' }))
  })
})

describe('CommonJS module.exports/exports export detection', () => {
  it('marks a declaration exported via module.exports.NAME = ...', async () => {
    const { extraction } = await extract('.js', 'function foo() {}\nmodule.exports.foo = foo\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'foo', isExported: true }))
  })

  it('marks a declaration exported via exports.NAME = ...', async () => {
    const { extraction } = await extract('.js', 'function bar() {}\nexports.bar = bar\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'bar', isExported: true }))
  })

  it('marks the single declaration a whole-module `module.exports = NAME` reassignment names', async () => {
    const { extraction } = await extract('.js', 'function whole() {}\nmodule.exports = whole\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'whole', isExported: true }))
  })

  it('does not export a plain top-level reassignment (left side is not a member expression)', async () => {
    const { extraction } = await extract('.js', 'let x = 1\nx = 2\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'x', isExported: false }))
  })

  it('does not export anything from an unrelated member assignment', async () => {
    const { extraction } = await extract('.js', 'function thing() {}\nsomeOther.thing = 1\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'thing', isExported: false }))
  })

  it('does not export anything from module.exports = <non-identifier>', async () => {
    const { extraction } = await extract('.js', 'function foo() {}\nmodule.exports = 42\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'foo', isExported: false }))
  })
})

describe('extends/implements (heritage) extraction', () => {
  it('extracts no heritage from a class with none', async () => {
    const { extraction } = await extract('.ts', 'class Foo {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('extracts a TypeScript extends target, keyed to the declaring class', async () => {
    const { extraction } = await extract('.ts', 'class Foo extends Base {}\n')
    expect(extraction.heritage).toEqual([{ sourceKey: '0:0', targetName: 'Base', relation: 'extends' }])
  })

  it('extracts multiple TypeScript implements targets alongside an extends target', async () => {
    const { extraction } = await extract('.ts', 'class Foo extends Base implements IThing, IOther {}\n')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: '0:0', targetName: 'Base', relation: 'extends' },
      { sourceKey: '0:0', targetName: 'IThing', relation: 'implements' },
      { sourceKey: '0:0', targetName: 'IOther', relation: 'implements' },
    ]))
  })

  it('does not name a mixin extends target after its call expression (extending a function call result)', async () => {
    const { extraction } = await extract('.ts', 'class Foo extends mixin(Base) {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('does not name a generic implements target (implements clause has a type_arguments wrapper)', async () => {
    const { extraction } = await extract('.ts', 'class Foo implements IThing<T> {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('does not name a plain JavaScript extends target that is not a bare identifier', async () => {
    const { extraction } = await extract('.js', 'class Foo extends (class {}) {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('extracts a plain JavaScript extends target (class_heritage with no extends_clause wrapper)', async () => {
    const { extraction } = await extract('.js', 'class Foo extends Base {}\n')
    expect(extraction.heritage).toEqual([{ sourceKey: '0:0', targetName: 'Base', relation: 'extends' }])
  })

  it('extracts a TypeScript interface extending multiple other interfaces', async () => {
    const { extraction } = await extract('.ts', 'interface C extends A, B {}\n')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: '0:0', targetName: 'A', relation: 'extends' },
      { sourceKey: '0:0', targetName: 'B', relation: 'extends' },
    ]))
  })

  it('extracts no heritage from an interface with no extends clause', async () => {
    const { extraction } = await extract('.ts', 'interface IThing {}\n')
    expect(extraction.heritage).toEqual([])
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

  it("extracts a plain JavaScript class field (field_definition, distinct from TypeScript's public_field_definition)", async () => {
    const { extraction } = await extract('.js', 'class Foo {\n  x = 1\n}\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'x', kind: 'field', container: ['Foo'] }))
  })

  it('extracts a module-level var declaration', async () => {
    const { extraction } = await extract('.js', 'var topVar = 1\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'topVar', kind: 'variable' })])
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

  it('records a wildcard from-import as a namespace binding, not a dropped statement', async () => {
    const { extraction } = await extract('.py', 'from x import *\n')
    expect(extraction.imports).toEqual([{ localName: '', importedName: '*', specifier: 'x' }])
  })

  it('extracts a module-level assignment as a variable definition', async () => {
    const { extraction } = await extract('.py', 'x = 1\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'x', kind: 'variable' })])
  })

  it('extracts a class-body assignment as a variable definition nested under its class', async () => {
    const { extraction } = await extract('.py', 'class Foo:\n    y = 2\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'y', kind: 'variable', container: ['Foo'] }))
  })

  it('does not extract an assignment inside a function or method body', async () => {
    const { extraction } = await extract('.py', 'class Foo:\n    def method(self):\n        z = 3\n        return z\n')
    expect(extraction.definitions.map(def => def.name)).toEqual(['Foo', 'method'])
  })

  it('does not name a tuple assignment after its pattern text', async () => {
    const { extraction } = await extract('.py', 'a, b = 1, 2\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not name an attribute assignment as a plain variable', async () => {
    const { extraction } = await extract('.py', 'obj.x = 1\n')
    expect(extraction.definitions).toEqual([])
  })

  it('resolves a relative from-import with no module name (only dots)', async () => {
    const { extraction } = await extract('.py', 'from . import foo\n')
    expect(extraction.imports).toEqual([{ localName: 'foo', importedName: 'foo', specifier: '.' }])
  })

  it('extracts an absolute (non-relative) from-import without confusing the module name for an imported symbol', async () => {
    const { extraction } = await extract('.py', 'from os import path\n')
    expect(extraction.imports).toEqual([{ localName: 'path', importedName: 'path', specifier: 'os' }])
  })

  it('extracts base classes from a Python class_definition, filtering out a keyword argument', async () => {
    const { extraction } = await extract('.py', 'class Foo(Base, metaclass=Meta):\n    pass\n')
    expect(extraction.heritage).toEqual([{ sourceKey: '0:0', targetName: 'Base', relation: 'extends' }])
  })

  it('extracts no heritage from a Python class with no base classes', async () => {
    const { extraction } = await extract('.py', 'class Foo:\n    pass\n')
    expect(extraction.heritage).toEqual([])
  })

  it('extracts no decorators from an undecorated definition', async () => {
    const { extraction } = await extract('.py', 'def foo():\n    pass\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'foo', decorators: [] })])
  })

  it('extracts a bare decorator name', async () => {
    const { extraction } = await extract('.py', '@staticmethod\ndef foo():\n    pass\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'foo', decorators: ['staticmethod'] })])
  })

  it('extracts multiple decorators, including a called one named by its dotted attribute', async () => {
    const { extraction } = await extract('.py', "@app.route('/x')\n@login_required\ndef bar():\n    pass\n")
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'bar', decorators: ['app.route', 'login_required'] })])
  })

  it('extracts a decorated class\'s decorator too, not just decorated functions', async () => {
    const { extraction } = await extract('.py', '@dataclass\nclass Foo:\n    pass\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'Foo', decorators: ['dataclass'] })])
  })

  it('does not name a decorator whose expression is not identifier/attribute-shaped', async () => {
    const { extraction } = await extract('.py', '@decorators[0]\ndef foo():\n    pass\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'foo', decorators: [] })])
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

  it('extracts single-name const_spec and var_spec declarations, split into constant/variable kinds', async () => {
    const { extraction } = await extract('.go', 'package main\nconst Single = 3\nvar x int = 5\n')
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('Single')).toMatchObject({ kind: 'constant' })
    expect(byName.get('x')).toMatchObject({ kind: 'variable' })
  })

  it('does not extract a multi-name const_spec/var_spec rather than pick just the first name', async () => {
    const { extraction } = await extract('.go', 'package main\nconst a, b = 1, 2\n')
    expect(extraction.definitions).toEqual([])
  })

  it('does not extract a var/const declared inside a function body', async () => {
    const { extraction } = await extract(
      '.go',
      'package main\nfunc main() {\n  var local = 1\n  const localConst = 2\n  _ = local\n  _ = localConst\n}\n',
    )
    expect(extraction.definitions.map(def => def.name)).toEqual(['main'])
  })

  it('does not extract a var declared inside a func_literal that a rejected multi-name spec never captures as a container', async () => {
    const { extraction } = await extract(
      '.go',
      'package main\nvar f, g = func() {\n  var x = 1\n  _ = x\n}, func() {}\n',
    )
    expect(extraction.definitions).toEqual([])
  })

  it('extracts named struct fields, nested under the struct, excluding an embedded (anonymous) field', async () => {
    const { extraction } = await extract('.go', 'package main\ntype Point struct {\n\tX int\n\tY int\n\tNested\n}\n')
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('X')).toMatchObject({ kind: 'field', container: ['Point'] })
    expect(byName.get('Y')).toMatchObject({ kind: 'field', container: ['Point'] })
    expect(byName.get('Nested')).toBeUndefined()
  })

  it('extracts an interface method signature, nested under the interface', async () => {
    const { extraction } = await extract('.go', 'package main\ntype Shape interface {\n\tArea() float64\n}\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Area', kind: 'method', container: ['Shape'] }))
  })

  it('extracts a struct field even when the struct type itself is declared inside a function body', async () => {
    const { extraction } = await extract(
      '.go',
      'package main\nfunc inner() {\n\ttype Local struct {\n\t\tA int\n\t}\n\t_ = Local{}\n}\n',
    )
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'A', kind: 'field', container: ['inner', 'Local'] }))
  })
})

describe('Java extraction', () => {
  const SOURCE = `
package com.example;

import java.util.List;
import java.util.Map;
import static java.lang.Math.max;
import java.util.*;

public class Foo extends Base implements Runnable, Serializable {
    public static final int X = 1;
    private String name;

    public Foo(String name) {
        this.name = name;
        helper();
    }

    public void run() {
        this.helper();
        Bar.staticCall();
    }

    private void helper() {}
}

interface Extra extends Runnable, AutoCloseable {
    void extra();
}

enum Color { RED, GREEN }
`

  it('extracts a public class, exported by an explicit public modifier', async () => {
    const { extraction } = await extract('.java', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'class', isExported: true }))
  })

  it('extracts a constructor and methods as kind method, nested under their class', async () => {
    const { extraction } = await extract('.java', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'class' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Foo', kind: 'method', container: ['Foo'] }))
    expect(byName.get('run')).toMatchObject({ kind: 'method', container: ['Foo'], isExported: true })
    expect(byName.get('helper')).toMatchObject({ kind: 'method', container: ['Foo'], isExported: false })
  })

  it('extracts a static final field, marked static, not exported without an explicit public check failing', async () => {
    const { extraction } = await extract('.java', SOURCE)
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'X', kind: 'field', isStatic: true, isExported: true, container: ['Foo'] }),
    )
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'name', kind: 'field', isStatic: false, isExported: false, container: ['Foo'] }),
    )
  })

  it('extracts call sites, distinguishing a bare call from this- and class-qualified member calls', async () => {
    const { extraction } = await extract('.java', SOURCE)
    const constructor = extraction.definitions.find(def => def.name === 'Foo' && def.kind === 'method')
    const run = extraction.definitions.find(def => def.name === 'run')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: constructor?.key, calleeName: 'helper', isMemberCall: false }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: run?.key, calleeName: 'helper', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: run?.key, calleeName: 'staticCall', isMemberCall: true }),
    )
  })

  it('extracts a regular import, a static import, and a wildcard import', async () => {
    const { extraction } = await extract('.java', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'List', importedName: '*', specifier: 'java.util.List' })
    expect(extraction.imports).toContainEqual({ localName: 'max', importedName: '*', specifier: 'java.lang.Math.max' })
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: 'java.util' })
  })

  it('extracts a single-segment import (a bare identifier, not a scoped_identifier)', async () => {
    const { extraction } = await extract('.java', 'import Foo;\n')
    expect(extraction.imports).toEqual([{ localName: 'Foo', importedName: '*', specifier: 'Foo' }])
  })

  it('extracts no heritage from an interface with no extends clause', async () => {
    const { extraction } = await extract('.java', 'interface Marker {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('extracts a class extends target alongside multiple implements targets', async () => {
    const { extraction } = await extract('.java', SOURCE)
    const foo = extraction.definitions.find(def => def.name === 'Foo' && def.kind === 'class')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: foo?.key, targetName: 'Base', relation: 'extends' },
      { sourceKey: foo?.key, targetName: 'Runnable', relation: 'implements' },
      { sourceKey: foo?.key, targetName: 'Serializable', relation: 'implements' },
    ]))
  })

  it('does not name a generic implements target (a type_arguments-wrapped type)', async () => {
    const { extraction } = await extract('.java', 'class Foo implements IThing<String> {}\n')
    expect(extraction.heritage).toEqual([])
  })

  it('extracts an interface extending multiple other interfaces', async () => {
    const { extraction } = await extract('.java', SOURCE)
    const extra = extraction.definitions.find(def => def.name === 'Extra')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: extra?.key, targetName: 'Runnable', relation: 'extends' },
      { sourceKey: extra?.key, targetName: 'AutoCloseable', relation: 'extends' },
    ]))
  })

  it('extracts enum constants nested under their enum', async () => {
    const { extraction } = await extract('.java', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'RED', kind: 'enum_member', container: ['Color'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'GREEN', kind: 'enum_member', container: ['Color'] }))
  })

  it('extracts a record with an implements target, mapped to kind class', async () => {
    const { extraction } = await extract('.java', 'record Point(int x, int y) implements Shape {}\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'Point', kind: 'class' })])
    expect(extraction.heritage).toEqual([{ sourceKey: '0:0', targetName: 'Shape', relation: 'implements' }])
  })

  it('does not extract a local variable declared inside a method body', async () => {
    const { extraction } = await extract('.java', 'class Foo {\n  void run() {\n    int local = 1;\n  }\n}\n')
    expect(extraction.definitions.map(def => def.name)).toEqual(['Foo', 'run'])
  })

  it('does not extract a local variable declared inside a lambda body that is never itself a named definition', async () => {
    const { extraction } = await extract(
      '.java',
      'class Foo {\n  Runnable r = () -> {\n    int local = 1;\n  };\n}\n',
    )
    expect(extraction.definitions.map(def => def.name)).toEqual(['Foo', 'r'])
  })

  it('extracts multi-name field declarations as independent field definitions', async () => {
    const { extraction } = await extract('.java', 'class Foo {\n  int a = 1, b = 2;\n}\n')
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('a')).toMatchObject({ kind: 'field' })
    expect(byName.get('b')).toMatchObject({ kind: 'field' })
  })
})

describe('C extraction', () => {
  const SOURCE = `
#include <stdio.h>
#include "local.h"

struct Point {
  int x;
  int y;
};

enum Color { RED, GREEN = 5 };

typedef struct Point PointT;

int g = 1;
static int hidden = 2;

int add(int a, int b) {
  return a + b;
}

static int helper(void) {
  return add(1, 2);
}

int *make(int a) {
  return &a;
}

void call_it(void) {
  obj.method();
  ptr->method2();
  add(1, 2);
}
`

  it('extracts a function via its nested declarator, exported without static', async () => {
    const { extraction } = await extract('.c', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('add')).toMatchObject({ kind: 'function', isExported: true, isStatic: false })
    expect(byName.get('helper')).toMatchObject({ kind: 'function', isExported: false, isStatic: true })
  })

  it('unwraps a pointer-returning function declarator to its plain name', async () => {
    const { extraction } = await extract('.c', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'make', kind: 'function' }))
  })

  it('extracts a top-level variable, exported without static, via its init_declarator', async () => {
    const { extraction } = await extract('.c', SOURCE)
    const byName = new Map(extraction.definitions.map(def => [def.name, def]))
    expect(byName.get('g')).toMatchObject({ kind: 'variable', isExported: true })
    expect(byName.get('hidden')).toMatchObject({ kind: 'variable', isExported: false, isStatic: true })
  })

  it('does not extract a variable declared inside a function body', async () => {
    const { extraction } = await extract('.c', 'void f(void) { int x = 1; }\n')
    expect(extraction.definitions.map(def => def.name)).toEqual(['f'])
  })

  it('extracts a struct, its fields nested under it, and an enum with its members', async () => {
    const { extraction } = await extract('.c', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'x', kind: 'field', container: ['Point'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'y', kind: 'field', container: ['Point'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'RED', kind: 'enum_member', container: ['Color'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'GREEN', kind: 'enum_member', container: ['Color'] }))
  })

  it('extracts a typedef as a type_alias', async () => {
    const { extraction } = await extract('.c', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'PointT', kind: 'type_alias' }))
  })

  it('does not extract a multi-declarator declaration rather than pick just the first name', async () => {
    const { extraction } = await extract('.c', 'int a, b;\n')
    expect(extraction.definitions).toEqual([])
  })

  it('unwraps a parenthesized function-pointer declarator to its plain name', async () => {
    const { extraction } = await extract('.c', 'int (*fp)(void);\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'fp', kind: 'variable' })])
  })

  it('extracts call sites, distinguishing a bare call from field-access member calls', async () => {
    const { extraction } = await extract('.c', SOURCE)
    const callIt = extraction.definitions.find(def => def.name === 'call_it')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'method', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'method2', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'add', isMemberCall: false }),
    )
  })

  it('extracts a system and a local #include, with no local binding', async () => {
    const { extraction } = await extract('.c', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: 'stdio.h' })
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: 'local.h' })
  })

  it('extracts an empty local #include as an empty specifier', async () => {
    const { extraction } = await extract('.c', '#include ""\n')
    expect(extraction.imports).toEqual([{ localName: '', importedName: '*', specifier: '' }])
  })
})

describe('C++ extraction', () => {
  const SOURCE = `
namespace ns {

class Base {};
class Other {};

class Derived : public Base, private Other {
public:
  int x;
  static void method() { helper(); }
  virtual void v() = 0;

  Derived() {}
  ~Derived() {}

  void call_it() {
    obj.member();
    ptr->member2();
    ns::helper();
  }
};

struct SPoint : Base {
  int x;
};

int freeFunc(int a) { return a; }

}
`

  it('extracts a class and nests its method under it', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Derived', kind: 'class' }))
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'method', kind: 'method', container: ['Derived'], isStatic: true }),
    )
  })

  it('extracts a pure-virtual method signature (a field_declaration with a function_declarator) as kind method', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'v', kind: 'method', container: ['Derived'] }))
  })

  it('extracts a plain field, not confused with the pure-virtual method above', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'x', kind: 'field', container: ['Derived'] }))
  })

  it('extracts a constructor and destructor as kind method, keeping the destructor name distinct', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    const derivedMethods = extraction.definitions.filter(def => def.container.includes('Derived') && def.kind === 'method')
    expect(derivedMethods.map(def => def.name)).toEqual(expect.arrayContaining(['Derived', '~Derived', 'method', 'v', 'call_it']))
  })

  it('extracts a free function outside any class as kind function, not method', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'freeFunc', kind: 'function', isExported: true }))
  })

  it('reports a method as not exported, having no linkage concept of its own', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'method', kind: 'method', isExported: false }))
  })

  it('extracts a struct with a base class, and its own field', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    const spoint = extraction.definitions.find(def => def.name === 'SPoint')
    expect(spoint).toMatchObject({ kind: 'struct' })
    expect(extraction.heritage).toContainEqual({ sourceKey: spoint?.key, targetName: 'Base', relation: 'extends' })
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'x', kind: 'field', container: ['SPoint'] }))
  })

  it('extracts every base_class_clause entry as extends, with no extends/implements distinction', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    const derived = extraction.definitions.find(def => def.name === 'Derived')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: derived?.key, targetName: 'Base', relation: 'extends' },
      { sourceKey: derived?.key, targetName: 'Other', relation: 'extends' },
    ]))
  })

  it('extracts call sites, distinguishing a bare call from field- and qualified-name member calls', async () => {
    const { extraction } = await extract('.cpp', SOURCE)
    const callIt = extraction.definitions.find(def => def.name === 'call_it')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'member', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'member2', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'helper', isMemberCall: true }),
    )
  })

  it('does not name an operator-overload declarator after its operator_name shape', async () => {
    const { extraction } = await extract('.cpp', 'class C {\n  bool operator==(const C& other) const;\n};\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'C', kind: 'class' })])
  })
})

describe('C# extraction', () => {
  const SOURCE = `
using System;
using Alias = System.Text;

namespace MyNs {

public class Base {}
public interface IFoo {}

public class Derived : Base, IFoo {
  public static int Method() { return Helper(); }
  public int Field;
  public int Prop { get; set; }

  public void CallIt() {
    int local = 1;
    obj.Method();
    Plain(1);
  }
}

public struct SPoint { public int X; }
public enum Color { Red, Green = 5 }
public record Rec(int X);
public interface IBar : IFoo {}

}
`

  it('extracts a public class and interface, exported by an explicit public modifier', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Derived', kind: 'class', isExported: true }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'IFoo', kind: 'interface', isExported: true }))
  })

  it('extracts a static method, a field, and a property, nested under the class', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'Method', kind: 'method', container: ['Derived'], isStatic: true }),
    )
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Field', kind: 'field', container: ['Derived'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Prop', kind: 'property', container: ['Derived'] }))
  })

  it('does not extract a local variable declared inside a method body', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    expect(extraction.definitions.find(def => def.name === 'local')).toBeUndefined()
  })

  it('extracts a struct, an enum with its members, and a record mapped to kind class', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'SPoint', kind: 'struct' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'X', kind: 'field', container: ['SPoint'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Red', kind: 'enum_member', container: ['Color'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Rec', kind: 'class' }))
  })

  it('extracts a class base list with no extends/implements distinction, and an interface extending another', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    const derived = extraction.definitions.find(def => def.name === 'Derived')
    const ibar = extraction.definitions.find(def => def.name === 'IBar')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: derived?.key, targetName: 'Base', relation: 'extends' },
      { sourceKey: derived?.key, targetName: 'IFoo', relation: 'extends' },
      { sourceKey: ibar?.key, targetName: 'IFoo', relation: 'extends' },
    ]))
  })

  it('extracts call sites, distinguishing a bare call from a member-access invocation', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    const callIt = extraction.definitions.find(def => def.name === 'CallIt')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'Method', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: callIt?.key, calleeName: 'Plain', isMemberCall: false }),
    )
  })

  it('extracts a plain using and an aliased using directive', async () => {
    const { extraction } = await extract('.cs', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: 'System' })
    expect(extraction.imports).toContainEqual({ localName: 'Alias', importedName: '*', specifier: 'System.Text' })
  })

  it('does not name a tuple-deconstructing variable_declarator after its tuple_pattern shape', async () => {
    const { extraction } = await extract('.cs', 'class C {\n  void M() {\n    var (a, b) = (1, 2);\n  }\n}\n')
    expect(extraction.definitions.map(def => def.name)).toEqual(['C', 'M'])
  })
})

describe('PHP extraction', () => {
  const SOURCE = `<?php
namespace App;

use Countable;
use App\\Contracts\\Cacheable;
use App\\Traits\\HasSlug as Sluggable;
use App\\{Foo, Bar as Baz};

interface Shape {
    const UNIT = "m";
    public function area(): float;
}

trait Loggable {
    protected string $tag = "log";
    public function log(string $msg): void {
        echo $msg;
    }
}

abstract class Base implements Shape {
    use Loggable;

    const VERSION = "1.0";
    public static int $count = 0;
    protected string $name;

    public function __construct(string $name) {
        $this->name = $name;
        self::$count++;
    }

    public static function make(string $name): self {
        return new self($name);
    }

    abstract public function area(): float;
}

class Circle extends Base {
    public function area(): float {
        return $this->radius();
    }

    public function radius(): float {
        return 1.0;
    }
}

function make_circle(string $name): Circle {
    return new Circle($name);
}

enum Suit: string implements JsonSerializable {
    case Hearts = 'H';
    case Spades = 'S';
}

$greet = function (string $name) {
    echo $name;
};

$double = fn($x) => $x * 2;

$x = 5;

make_circle("c1");
Base::make("b1");
$circle = new Circle("c2");
$circle->area();
Helpers\\format_date("now");
`

  it('extracts a namespace-scoped function, not exported (PHP has no top-level export keyword)', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'make_circle', kind: 'function', isExported: false }))
  })

  it('extracts a class, an interface, a trait, and an enum', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Base', kind: 'class' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Circle', kind: 'class' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'interface' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Loggable', kind: 'trait' }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Suit', kind: 'enum' }))
  })

  it('extracts enum cases nested under the enum', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Hearts', kind: 'enum_member', container: ['Suit'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Spades', kind: 'enum_member', container: ['Suit'] }))
  })

  it('extracts a method (including a static one, an interface signature, and an abstract one)', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'area', kind: 'method', container: ['Shape'] }))
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'make', kind: 'method', container: ['Base'], isStatic: true, isExported: true }),
    )
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: '__construct', kind: 'method', container: ['Base'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'radius', kind: 'method', container: ['Circle'] }))
  })

  it('extracts a class constant and an interface constant, neither scope-restricted', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'VERSION', kind: 'constant', container: ['Base'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'UNIT', kind: 'constant', container: ['Shape'] }))
  })

  it('extracts a static and non-static property, and a trait property, each mapped to kind field', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'count', kind: 'field', container: ['Base'], isStatic: true }),
    )
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'name', kind: 'field', container: ['Base'], isStatic: false }),
    )
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'tag', kind: 'field', container: ['Loggable'] }))
  })

  it('extracts a closure and an arrow function bound to a variable as kind function', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'greet', kind: 'function', container: [] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'double', kind: 'function', container: [] }))
  })

  it('does not capture a plain variable assignment as a definition', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.definitions.find(def => def.name === 'x')).toBeUndefined()
  })

  it('does not name a closure bound to a member-access target after its member_access_expression shape', async () => {
    const { extraction } = await extract('.php', '<?php\n$this->handler = function () {};\n')
    expect(extraction.definitions).toEqual([])
  })

  it('extracts extends and implements, including an enum implementing an interface', async () => {
    const { extraction } = await extract('.php', SOURCE)
    const base = extraction.definitions.find(def => def.name === 'Base')
    const circle = extraction.definitions.find(def => def.name === 'Circle')
    const suit = extraction.definitions.find(def => def.name === 'Suit')
    expect(extraction.heritage).toEqual(expect.arrayContaining([
      { sourceKey: base?.key, targetName: 'Shape', relation: 'implements' },
      { sourceKey: circle?.key, targetName: 'Base', relation: 'extends' },
      { sourceKey: suit?.key, targetName: 'JsonSerializable', relation: 'implements' },
    ]))
  })

  it('extracts a bare call, a static call, and a member call, distinguishing their trust level', async () => {
    const { extraction } = await extract('.php', SOURCE)
    const area = extraction.definitions.find(def => def.name === 'area' && def.container.includes('Circle'))
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: null, calleeName: 'make_circle', isMemberCall: false }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: null, calleeName: 'make', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: null, calleeName: 'area', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: area?.key, calleeName: 'radius', isMemberCall: true }),
    )
  })

  it('extracts a namespaced free-function call by its qualified_name final segment', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: null, calleeName: 'format_date', isMemberCall: true }),
    )
  })

  it('extracts a plain use, an aliased use, and a group use with its shared prefix', async () => {
    const { extraction } = await extract('.php', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'Countable', importedName: 'Countable', specifier: 'Countable' })
    expect(extraction.imports).toContainEqual({ localName: 'Cacheable', importedName: 'Cacheable', specifier: 'App\\Contracts\\Cacheable' })
    expect(extraction.imports).toContainEqual({ localName: 'Sluggable', importedName: 'HasSlug', specifier: 'App\\Traits\\HasSlug' })
    expect(extraction.imports).toContainEqual({ localName: 'Foo', importedName: 'Foo', specifier: 'App\\Foo' })
    expect(extraction.imports).toContainEqual({ localName: 'Baz', importedName: 'Bar', specifier: 'App\\Bar' })
  })

  it('does not name a fully-qualified extends or implements target after its qualified_name shape', async () => {
    const { extraction } = await extract('.php', '<?php\nclass D extends \\Foo\\Bar implements \\Foo\\Baz {}\n')
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'D', kind: 'class' })])
    expect(extraction.heritage).toEqual([])
  })
})

describe('Rust extraction', () => {
  const SOURCE = `
use std::collections::HashMap;
use std::fmt::{self, Display};
use std::io::*;
use std::cmp::Ordering as Ord2;

pub const MAX: i32 = 10;
pub static COUNT: i32 = 0;

pub fn add(a: i32, b: i32) -> i32 {
    let sum = a + b;
    fn nested() {}
    helper();
    sum
}

fn helper() {}

pub struct Point {
    pub x: i32,
    y: i32,
}

pub trait Shape: Display {
    fn area(&self) -> f64;
    fn name(&self) -> String {
        String::from("shape")
    }
}

impl Shape for Point {
    fn area(&self) -> f64 {
        0.0
    }
}

impl Point {
    pub fn new(x: i32, y: i32) -> Self {
        Point { x, y }
    }

    fn describe(&self) -> String {
        self.name();
        Point::helper_fn();
        format!("Point({}, {})", self.x, self.y).parse::<String>().unwrap()
    }
}

pub enum Color {
    Red,
    Custom(i32, i32, i32),
}

pub mod geometry {
    pub const PI: f64 = 3.14;
    pub fn area() {}
}

type Alias = i32;

add(1, 2);
`

  it('extracts a top-level function, exported by a bare pub', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'add', kind: 'function', isExported: true }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'helper', kind: 'function', isExported: false }))
  })

  it('extracts a function nested inside another function, as kind function under its container', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'nested', kind: 'function', container: ['add'] }))
  })

  it('does not capture a let binding as a definition', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions.find(def => def.name === 'sum')).toBeUndefined()
  })

  it('does not capture a function-local let binding, const, or static as a definition', async () => {
    const { extraction } = await extract(
      '.rs',
      'fn scoped() {\n    let x = 1;\n    const LOCAL: i32 = 1;\n    static LOCAL_STATIC: i32 = 2;\n}\n',
    )
    expect(extraction.definitions).toEqual([expect.objectContaining({ name: 'scoped', kind: 'function' })])
  })

  it('extracts a top-level const (exported) and static (not exported), the static also flagged isStatic', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'MAX', kind: 'constant', isExported: true }))
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'COUNT', kind: 'variable', isExported: true, isStatic: true }),
    )
  })

  it('extracts a struct and its public and private fields', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Point', kind: 'struct', isExported: true }))
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'x', kind: 'field', container: ['Point'], isExported: true }),
    )
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'y', kind: 'field', container: ['Point'], isExported: false }),
    )
  })

  it('extracts a union as kind struct, matching the C/C++ precedent', async () => {
    const { extraction } = await extract('.rs', 'union Slot {\n    a: i32,\n    b: f32,\n}\n')
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Slot', kind: 'struct' }))
  })

  it('extracts a trait, its body-less method signature, and its default-body method, both under the trait container', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Shape', kind: 'trait', isExported: true }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'area', kind: 'method', container: ['Shape'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'name', kind: 'method', container: ['Shape'] }))
  })

  it('extracts a supertrait bound as heritage extends', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    const shape = extraction.definitions.find(def => def.name === 'Shape')
    expect(extraction.heritage).toContainEqual({ sourceKey: shape?.key, targetName: 'Display', relation: 'extends' })
  })

  it('extracts an impl method with no container, since an impl block is never itself a definition', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'new', kind: 'method', container: [], isExported: true }),
    )
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'describe', kind: 'method', container: [], isExported: false }),
    )
    // Two distinct `impl_item` blocks each define a method named `area` — both still resolve to kind
    // `method` with no container, since neither impl block is captured as a definition.
    expect(extraction.definitions.filter(def => def.name === 'area' && def.kind === 'method' && def.container.length === 0))
      .toHaveLength(1)
  })

  it('extracts an enum and its variants nested under it', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Color', kind: 'enum', isExported: true }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Red', kind: 'enum_member', container: ['Color'] }))
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Custom', kind: 'enum_member', container: ['Color'] }))
  })

  it('extracts a mod as kind namespace, with its own const and function nested under it', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'geometry', kind: 'namespace', isExported: true }))
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'PI', kind: 'constant', container: ['geometry'], isExported: true }),
    )
    expect(extraction.definitions).toContainEqual(
      expect.objectContaining({ name: 'area', kind: 'function', container: ['geometry'], isExported: true }),
    )
  })

  it('extracts a type alias, not exported without a bare pub', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.definitions).toContainEqual(expect.objectContaining({ name: 'Alias', kind: 'type_alias', isExported: false }))
  })

  it('extracts a bare call, a member call, and a qualified (Type::method) call', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    const add = extraction.definitions.find(def => def.name === 'add')
    const describe = extraction.definitions.find(def => def.name === 'describe')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: add?.key, calleeName: 'helper', isMemberCall: false }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: describe?.key, calleeName: 'name', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: describe?.key, calleeName: 'helper_fn', isMemberCall: true }),
    )
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: null, calleeName: 'add', isMemberCall: false }),
    )
  })

  it('resolves a turbofish (generic_function) call to its unwrapped callee name', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    const describe = extraction.definitions.find(def => def.name === 'describe')
    expect(extraction.calls).toContainEqual(
      expect.objectContaining({ callerKey: describe?.key, calleeName: 'parse', isMemberCall: true }),
    )
  })

  it('does not extract a macro invocation as a call', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.calls.find(call => call.calleeName === 'format')).toBeUndefined()
  })

  it('extracts a plain use, a grouped use with self and a nested member, a wildcard use, and an aliased use', async () => {
    const { extraction } = await extract('.rs', SOURCE)
    expect(extraction.imports).toContainEqual({ localName: 'HashMap', importedName: 'HashMap', specifier: 'std::collections::HashMap' })
    expect(extraction.imports).toContainEqual({ localName: 'fmt', importedName: 'fmt', specifier: 'std::fmt' })
    expect(extraction.imports).toContainEqual({ localName: 'Display', importedName: 'Display', specifier: 'std::fmt::Display' })
    expect(extraction.imports).toContainEqual({ localName: '', importedName: '*', specifier: 'std::io' })
    expect(extraction.imports).toContainEqual({ localName: 'Ord2', importedName: 'Ordering', specifier: 'std::cmp::Ordering' })
  })
})
