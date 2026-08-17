import { describe, expect, it } from 'vitest'
import { resolveWorkspace } from '../src/resolve.ts'
import type { ExtractedFile } from '../src/resolve.ts'
import type { RawCall, RawDefinition, RawImport } from '../src/extract.ts'

const NOW = 1700000000000

function def(overrides: Partial<RawDefinition> & Pick<RawDefinition, 'key' | 'name'>): RawDefinition {
  return {
    parentKey: null,
    kind: 'function',
    container: [],
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 1,
    isExported: true,
    isAsync: false,
    isStatic: false,
    ...overrides,
  }
}

function file(
  path: string,
  definitions: RawDefinition[],
  calls: RawCall[] = [],
  imports: RawImport[] = [],
): ExtractedFile {
  return {
    path,
    language: 'typescript',
    size: 100,
    modifiedAt: NOW,
    contentHash: 'hash',
    lineCount: 10,
    extraction: { definitions, calls, imports },
  }
}

describe('resolveWorkspace', () => {
  it('writes a file node and a contains edge for each top-level definition', () => {
    const files = [file('a.ts', [def({ key: '1:0', name: 'foo' })])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.nodes).toContainEqual(expect.objectContaining({ id: 'file:a.ts', kind: 'file' }))
    expect(graph.edges).toContainEqual({ source: 'file:a.ts', target: 'a.ts:1:0', kind: 'contains', provenance: 'tree-sitter' })
  })

  it('writes a contains edge from a definition to its nested definition', () => {
    const files = [file('a.ts', [
      def({ key: '1:0', name: 'MathHelper', kind: 'class', startLine: 1, startColumn: 0 }),
      def({ key: '2:2', name: 'calc', kind: 'method', parentKey: '1:0', container: ['MathHelper'], startLine: 2, startColumn: 2 }),
    ])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual({ source: 'a.ts:1:0', target: 'a.ts:2:2', kind: 'contains', provenance: 'tree-sitter' })
  })

  it('builds a qualifiedName from the container chain', () => {
    const files = [file('a.ts', [
      def({ key: '1:0', name: 'MathHelper', kind: 'class', startLine: 1, startColumn: 0 }),
      def({ key: '2:2', name: 'calc', kind: 'method', parentKey: '1:0', container: ['MathHelper'], startLine: 2, startColumn: 2 }),
    ])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.nodes.find(node => node.id === 'a.ts:2:2')?.qualifiedName).toBe('a.ts::MathHelper.calc')
  })

  it('resolves an import specifier that already names the exact indexed path, with no suffix needed', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'bar', specifier: './b.ts' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('resolves rule 1: a call whose import resolves to a workspace file matches that file\'s declaration', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'bar', specifier: './b' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'file:a.ts', target: 'b.ts:1:0', kind: 'calls' }))
    expect(graph.unresolved).toEqual([])
  })

  it('resolves a default import to the target file\'s sole exported declaration', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'Def', line: 1, column: 0 }], [
        { localName: 'Def', importedName: 'default', specifier: './b' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'baz' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'file:a.ts', target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('falls through to rule 2 when the imported name does not match any declaration in the target file', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'notThere', specifier: './b' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'somethingElse' })]),
      file('c.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'file:a.ts', target: 'c.ts:1:0', kind: 'calls' }))
  })

  it('resolves rule 2: a call with no matching import but exactly one workspace-wide declaration', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'unique', line: 1, column: 0 }]),
      file('b.ts', [def({ key: '1:0', name: 'unique' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('rule 3: a same-named twin in another module leaves the call unresolved with no calls edge', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'ambiguous', line: 3, column: 1 }]),
      file('b.ts', [def({ key: '1:0', name: 'ambiguous' })]),
      file('c.ts', [def({ key: '1:0', name: 'ambiguous' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([])
    expect(graph.unresolved).toEqual([{ source: 'file:a.ts', filePath: 'a.ts', calleeName: 'ambiguous', line: 3, col: 1 }])
  })

  it('rule 3: a call to a name that matches nothing is unresolved', () => {
    const files = [file('a.ts', [], [{ callerKey: null, calleeName: 'nowhere', line: 1, column: 0 }])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.unresolved).toHaveLength(1)
  })

  it('writes an imports edge between files whose relative specifier resolves', () => {
    const files = [
      file('a.ts', [], [], [{ localName: 'bar', importedName: 'bar', specifier: './b' }]),
      file('b.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual({ source: 'file:a.ts', target: 'file:b.ts', kind: 'imports', provenance: 'tree-sitter' })
  })

  it('writes an imports edge for a resolved namespace import, without binding it to a specific symbol', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'ns', line: 1, column: 0 }], [
        { localName: 'ns', importedName: '*', specifier: './b' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual({ source: 'file:a.ts', target: 'file:b.ts', kind: 'imports', provenance: 'tree-sitter' })
    // A namespace binding is never a rule-1 candidate, so a call to the namespace's local name itself
    // is unresolved rather than matched against something in the target file.
    expect(graph.unresolved).toContainEqual(expect.objectContaining({ calleeName: 'ns' }))
  })

  it('writes no imports edge for a specifier that does not resolve to an indexed file', () => {
    const files = [file('a.ts', [], [], [{ localName: 'x', importedName: 'x', specifier: 'some-package' }])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'imports')).toEqual([])
  })

  it('resolves a Python relative import (one leading dot: same package)', () => {
    const files = [
      { ...file('a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'bar', specifier: '.bar' },
      ]), language: 'python' },
      { ...file('bar.py', [def({ key: '1:0', name: 'bar' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'bar.py:1:0', kind: 'calls' }))
  })

  it('resolves a Python relative import climbing one parent level (two leading dots)', () => {
    const files = [
      { ...file('pkg/sub/a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'bar', specifier: '..bar' },
      ]), language: 'python' },
      { ...file('pkg/bar.py', [def({ key: '1:0', name: 'bar' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'pkg/bar.py:1:0', kind: 'calls' }))
  })

  it('writes no imports edge for a relative specifier that matches no indexed file, even after trying every suffix', () => {
    const files = [
      file('a.ts', [], [], [{ localName: 'x', importedName: 'x', specifier: './missing' }]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'imports')).toEqual([])
  })

  it('does not resolve a Python absolute (non-relative) import as a relative specifier', () => {
    const files = [
      { ...file('a.py', [], [{ callerKey: null, calleeName: 'path', line: 1, column: 0 }], [
        { localName: 'path', importedName: 'path', specifier: 'os' },
      ]), language: 'python' },
      { ...file('os.py', [def({ key: '1:0', name: 'path' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    // Rule 1 never applies (the specifier is not relative); rule 2 still resolves it, since the name
    // is workspace-wide unique.
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'os.py:1:0', kind: 'calls' }))
    expect(graph.edges.filter(edge => edge.kind === 'imports')).toEqual([])
  })

  it('resolves a Python relative import with nothing after the dots (climbing with no module name)', () => {
    const files = [
      { ...file('pkg/sub/a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0 }], [
        { localName: 'bar', importedName: 'bar', specifier: '..' },
      ]), language: 'python' },
      { ...file('pkg/bar.py', [def({ key: '1:0', name: 'bar' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'pkg/bar.py:1:0', kind: 'calls' }))
  })

  it('never resolves a Go package import to a specific declaration (importedName "*")', () => {
    const files = [
      { ...file('a.go', [], [{ callerKey: null, calleeName: 'Helper', line: 1, column: 0 }], [
        { localName: 'pkg', importedName: '*', specifier: './pkg' },
      ]), language: 'go' },
      { ...file('pkg/util.go', [def({ key: '1:0', name: 'Helper' })]), language: 'go' },
    ]
    const graph = resolveWorkspace(files, NOW)
    // No relative-import resolution is attempted for Go, but the name is workspace-wide unique, so
    // rule 2 still resolves it.
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'pkg/util.go:1:0', kind: 'calls' }))
  })

  it('attributes a nested call to its enclosing definition, not the file', () => {
    const files = [
      file('a.ts', [def({ key: '1:0', name: 'outer' })], [{ callerKey: '1:0', calleeName: 'unique', line: 2, column: 2 }]),
      file('b.ts', [def({ key: '1:0', name: 'unique' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'a.ts:1:0', target: 'b.ts:1:0', kind: 'calls', line: 2, col: 2 }))
  })
})
