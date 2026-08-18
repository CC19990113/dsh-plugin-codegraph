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
