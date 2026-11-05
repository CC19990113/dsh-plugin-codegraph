import { describe, expect, it, vi } from 'vitest'
import { resolveWorkspace } from '../src/resolve.ts'
import type { ExtractedFile } from '../src/resolve.ts'
import type { RawCall, RawDefinition, RawHeritageRef, RawImport } from '../src/extract.ts'

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
  heritage: RawHeritageRef[] = [],
): ExtractedFile {
  return {
    path,
    language: 'typescript',
    size: 100,
    modifiedAt: NOW,
    contentHash: 'hash',
    lineCount: 10,
    extraction: { definitions, calls, imports, heritage },
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
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
        { localName: 'bar', importedName: 'bar', specifier: './b.ts' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'bar' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('resolves rule 1: a call whose import resolves to a workspace file matches that file\'s declaration', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
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
      file('a.ts', [], [{ callerKey: null, calleeName: 'Def', line: 1, column: 0, isMemberCall: false }], [
        { localName: 'Def', importedName: 'default', specifier: './b' },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'baz' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'file:a.ts', target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('falls through to rule 2 when the imported name does not match any declaration in the target file', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
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
      file('a.ts', [], [{ callerKey: null, calleeName: 'unique', line: 1, column: 0, isMemberCall: false }]),
      file('b.ts', [def({ key: '1:0', name: 'unique' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'b.ts:1:0', kind: 'calls' }))
  })

  it('resolves a call the calling file itself declares, even when other files reuse the name', () => {
    const files = [
      file('a.ts', [def({ key: '1:0', name: 'helper' })], [
        { callerKey: null, calleeName: 'helper', line: 3, column: 1, isMemberCall: false },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'helper' })]),
      file('c.ts', [def({ key: '1:0', name: 'helper' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'file:a.ts', target: 'a.ts:1:0', kind: 'calls' }))
    expect(graph.unresolved).toEqual([])
  })

  it('attributes a same-file call to its enclosing declaration, not to the file node', () => {
    const files = [file('a.ts', [
      def({ key: '1:0', name: 'outer', kind: 'function' }),
      def({ key: '2:2', name: 'inner', kind: 'function', parentKey: '1:0', container: ['outer'], startLine: 2, startColumn: 2 }),
    ], [
      { callerKey: '1:0', calleeName: 'inner', line: 2, column: 2, isMemberCall: false },
    ])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'a.ts:1:0', target: 'a.ts:2:2', kind: 'calls' }))
  })

  it('does not apply the same-file tier to a member call, whose receiver it cannot type', () => {
    const files = [
      file('a.ts', [def({ key: '1:0', name: 'map' })], [
        { callerKey: null, calleeName: 'map', line: 3, column: 1, isMemberCall: true },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'map' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([])
    expect(graph.unresolved).toEqual([
      { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'map', line: 3, col: 1, likelyExternal: true },
    ])
  })

  it('falls through to the workspace-wide rule when the calling file declares the name twice', () => {
    const files = [
      file('a.ts', [
        def({ key: '1:0', name: 'dup' }),
        def({ key: '5:0', name: 'dup' }),
      ], [
        { callerKey: null, calleeName: 'dup', line: 9, column: 0, isMemberCall: false },
      ]),
      file('b.ts', [def({ key: '1:0', name: 'other' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([])
    expect(graph.unresolved).toHaveLength(1)
  })

  it('rule 3: a same-named twin in another module leaves the call unresolved with no calls edge', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'ambiguous', line: 3, column: 1, isMemberCall: false }]),
      file('b.ts', [def({ key: '1:0', name: 'ambiguous' })]),
      file('c.ts', [def({ key: '1:0', name: 'ambiguous' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges.filter(edge => edge.kind === 'calls')).toEqual([])
    expect(graph.unresolved).toEqual([
      { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'ambiguous', line: 3, col: 1, likelyExternal: false },
    ])
  })

  it('rule 3: a call to a name that matches nothing is unresolved and not flagged as likely external', () => {
    const files = [file('a.ts', [], [{ callerKey: null, calleeName: 'nowhere', line: 1, column: 0, isMemberCall: false }])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.unresolved).toEqual([
      { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'nowhere', line: 1, col: 0, likelyExternal: false },
    ])
  })

  it('flags an unresolved member call as likely external: no type information backs its receiver', () => {
    const files = [file('a.ts', [], [{ callerKey: null, calleeName: 'parse', line: 1, column: 0, isMemberCall: true }])]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.unresolved).toEqual([
      { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'parse', line: 1, col: 0, likelyExternal: true },
    ])
  })

  it('flags an unresolved bare call as likely external when the file itself imports that name', () => {
    const files = [
      file('a.ts', [], [{ callerKey: null, calleeName: 'expect', line: 1, column: 0, isMemberCall: false }], [
        { localName: 'expect', importedName: 'expect', specifier: 'vitest' },
      ]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.unresolved).toEqual([
      { source: 'file:a.ts', filePath: 'a.ts', calleeName: 'expect', line: 1, col: 0, likelyExternal: true },
    ])
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
      file('a.ts', [], [{ callerKey: null, calleeName: 'ns', line: 1, column: 0, isMemberCall: false }], [
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
      { ...file('a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
        { localName: 'bar', importedName: 'bar', specifier: '.bar' },
      ]), language: 'python' },
      { ...file('bar.py', [def({ key: '1:0', name: 'bar' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'bar.py:1:0', kind: 'calls' }))
  })

  it('resolves a Python relative import climbing one parent level (two leading dots)', () => {
    const files = [
      { ...file('pkg/sub/a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
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
      { ...file('a.py', [], [{ callerKey: null, calleeName: 'path', line: 1, column: 0, isMemberCall: false }], [
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
      { ...file('pkg/sub/a.py', [], [{ callerKey: null, calleeName: 'bar', line: 1, column: 0, isMemberCall: false }], [
        { localName: 'bar', importedName: 'bar', specifier: '..' },
      ]), language: 'python' },
      { ...file('pkg/bar.py', [def({ key: '1:0', name: 'bar' })]), language: 'python' },
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ target: 'pkg/bar.py:1:0', kind: 'calls' }))
  })

  it('never resolves a Go package import to a specific declaration (importedName "*")', () => {
    const files = [
      { ...file('a.go', [], [{ callerKey: null, calleeName: 'Helper', line: 1, column: 0, isMemberCall: false }], [
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
      file('a.ts', [def({ key: '1:0', name: 'outer' })], [{ callerKey: '1:0', calleeName: 'unique', line: 2, column: 2, isMemberCall: false }]),
      file('b.ts', [def({ key: '1:0', name: 'unique' })]),
    ]
    const graph = resolveWorkspace(files, NOW)
    expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'a.ts:1:0', target: 'b.ts:1:0', kind: 'calls', line: 2, col: 2 }))
  })

  // `RawDefinition.key` is `row:column`, so a nested declaration that starts on the same row and
  // column as the declaration enclosing it is indistinguishable *by key*: C/C++'s
  // `struct X { … } y;` captures both the enclosing `declaration`/`field_declaration` (`y`) and the
  // nested `struct_specifier` (`X`) at the same source position. Two such definitions used to take the
  // same `path:row:col` node id (`UNIQUE constraint failed: nodes.id` on write) and, because the parent
  // lookup went through a last-write-wins key map, the inner one also became its own `contains` parent.
  describe('two definitions sharing one source position', () => {
    /** The real C shape, as `extract.ts` reports it: outer `variable`/`field` at 120:4, inner `struct` there too. */
    function duplicateKeyFile(): ExtractedFile {
      return file('x.c', [
        def({ key: '120:4', name: 'dec', kind: 'variable', startLine: 120, startColumn: 4, endLine: 130, endColumn: 6 }),
        def({ key: '120:4', name: 'xz_dec', kind: 'struct', parentKey: '120:4', container: ['dec'], startLine: 120, startColumn: 4, endLine: 130, endColumn: 6 }),
        def({ key: '200:0', name: 'sink', kind: 'function', startLine: 200, startColumn: 0 }),
      ])
    }

    it('gives them distinct ids, keeping the bare id for the first occurrence', () => {
      const graph = resolveWorkspace([duplicateKeyFile()], NOW)
      const ids = graph.nodes.filter(node => node.filePath === 'x.c').map(node => node.id).sort()
      expect(ids).toEqual(['file:x.c', 'x.c:120:4', 'x.c:120:4#2', 'x.c:200:0'])
    })

    it('never emits a duplicate node id', () => {
      const graph = resolveWorkspace([duplicateKeyFile()], NOW)
      expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length)
    })

    it('nests inner under outer instead of pointing both at the inner one', () => {
      const graph = resolveWorkspace([duplicateKeyFile()], NOW)
      expect(graph.edges).toContainEqual({ source: 'file:x.c', target: 'x.c:120:4', kind: 'contains', provenance: 'tree-sitter' })
      expect(graph.edges).toContainEqual({ source: 'x.c:120:4', target: 'x.c:120:4#2', kind: 'contains', provenance: 'tree-sitter' })
      // The regression itself: with a key-only parent lookup the inner def's parent resolved to the
      // inner def's own id, i.e. a node containing itself.
      expect(graph.edges.filter(edge => edge.kind === 'contains' && edge.source === edge.target)).toEqual([])
    })

    it('attributes a call whose callerKey names the shared position to the inner declaration', () => {
      const graph = resolveWorkspace([
        file('x.c', [
          def({ key: '120:4', name: 'dec', kind: 'variable', startLine: 120, startColumn: 4 }),
          def({ key: '120:4', name: 'xz_dec', kind: 'struct', parentKey: '120:4', container: ['dec'], startLine: 120, startColumn: 4 }),
          def({ key: '200:0', name: 'sink', kind: 'function', startLine: 200, startColumn: 0 }),
        ], [
          { callerKey: '120:4', calleeName: 'sink', line: 125, column: 8, isMemberCall: false },
        ]),
      ], NOW)
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'x.c:120:4#2', target: 'x.c:200:0', kind: 'calls' }))
    })

    it('attributes a heritage reference whose sourceKey names the shared position to the inner declaration', () => {
      const graph = resolveWorkspace([
        file('x.c', [
          def({ key: '120:4', name: 'dec', kind: 'variable', startLine: 120, startColumn: 4 }),
          def({ key: '120:4', name: 'xz_dec', kind: 'struct', parentKey: '120:4', container: ['dec'], startLine: 120, startColumn: 4 }),
        ], [], [], [{ sourceKey: '120:4', targetName: 'Base', relation: 'extends' }]),
        file('b.ts', [def({ key: '1:0', name: 'Base', kind: 'class' })]),
      ], NOW)
      expect(graph.edges).toContainEqual(expect.objectContaining({ source: 'x.c:120:4#2', target: 'b.ts:1:0', kind: 'extends' }))
    })

    it('numbers the third occurrence with its own suffix', () => {
      const graph = resolveWorkspace([
        file('x.c', [
          def({ key: '120:4', name: 'dec', kind: 'variable', startLine: 120, startColumn: 4 }),
          def({ key: '120:4', name: 'xz_dec', kind: 'struct', parentKey: '120:4', container: ['dec'], startLine: 120, startColumn: 4 }),
          def({ key: '120:4', name: 'inner', kind: 'struct', parentKey: '120:4', container: ['dec', 'xz_dec'], startLine: 120, startColumn: 4 }),
        ]),
      ], NOW)
      expect(graph.nodes.map(node => node.id)).toContain('x.c:120:4#3')
      expect(new Set(graph.nodes.map(node => node.id)).size).toBe(graph.nodes.length)
      expect(graph.edges.filter(edge => edge.kind === 'contains')).toEqual([
        { source: 'file:x.c', target: 'x.c:120:4', kind: 'contains', provenance: 'tree-sitter' },
        { source: 'x.c:120:4', target: 'x.c:120:4#2', kind: 'contains', provenance: 'tree-sitter' },
        { source: 'x.c:120:4#2', target: 'x.c:120:4#3', kind: 'contains', provenance: 'tree-sitter' },
      ])
    })

    it('leaves the id of a definition whose position is unique in the old `path:row:col` form', () => {
      const graph = resolveWorkspace([file('a.ts', [def({ key: '1:0', name: 'foo' })])], NOW)
      expect(graph.nodes.map(node => node.id)).toEqual(['file:a.ts', 'a.ts:1:0'])
    })
  })

  describe('stack-based parent reconstruction', () => {
    it('reaches a grandparent that is no longer the immediately preceding definition', () => {
      const graph = resolveWorkspace([file('a.ts', [
        def({ key: '1:0', name: 'A', kind: 'class' }),
        def({ key: '2:2', name: 'B', kind: 'method', parentKey: '1:0', container: ['A'], startLine: 2, startColumn: 2 }),
        def({ key: '3:4', name: 'C', kind: 'variable', parentKey: '2:2', container: ['A', 'B'], startLine: 3, startColumn: 4 }),
        // A sibling of `B`: `B`'s subtree is finished, so this pops back to `A`.
        def({ key: '5:2', name: 'D', kind: 'method', parentKey: '1:0', container: ['A'], startLine: 5, startColumn: 2 }),
      ])], NOW)
      expect(graph.edges).toContainEqual({ source: 'a.ts:1:0', target: 'a.ts:5:2', kind: 'contains', provenance: 'tree-sitter' })
      expect(graph.edges.filter(edge => edge.source === edge.target)).toEqual([])
    })

    it('falls back to the file node for an unresolvable parentKey instead of throwing', () => {
      const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        const graph = resolveWorkspace([file('a.ts', [def({ key: '1:0', name: 'orphan', parentKey: '9:9', container: ['ghost'] })])], NOW)
        expect(graph.edges).toContainEqual({ source: 'file:a.ts', target: 'a.ts:1:0', kind: 'contains', provenance: 'tree-sitter' })
        // The fallback keeps the graph usable, which is exactly why it has to be recorded: a dangling
        // parent key is an extraction/resolution disagreement, and the log is the only place it shows.
        expect(errorSpy).toHaveBeenCalledTimes(1)
        const logged = String(errorSpy.mock.calls[0]?.[0])
        expect(logged).toContain('a.ts:1:0')
        expect(logged).toContain('9:9')
      } finally {
        errorSpy.mockRestore()
      }
    })
  })

  describe('extends/implements resolution', () => {
    it('resolves rule 1: an extends target imported from a workspace file', () => {
      const files = [
        file(
          'a.ts',
          [def({ key: '1:0', name: 'Foo', kind: 'class' })],
          [],
          [{ localName: 'Base', importedName: 'Base', specifier: './b' }],
          [{ sourceKey: '1:0', targetName: 'Base', relation: 'extends' }],
        ),
        file('b.ts', [def({ key: '1:0', name: 'Base', kind: 'class' })]),
      ]
      const graph = resolveWorkspace(files, NOW)
      expect(graph.edges).toContainEqual({ source: 'a.ts:1:0', target: 'b.ts:1:0', kind: 'extends', provenance: 'tree-sitter' })
    })

    it('resolves rule 2: an implements target with no matching import but a workspace-wide-unique name', () => {
      const files = [
        file(
          'a.ts',
          [def({ key: '1:0', name: 'Foo', kind: 'class' })],
          [],
          [],
          [{ sourceKey: '1:0', targetName: 'IThing', relation: 'implements' }],
        ),
        file('b.ts', [def({ key: '1:0', name: 'IThing', kind: 'interface' })]),
      ]
      const graph = resolveWorkspace(files, NOW)
      expect(graph.edges).toContainEqual({ source: 'a.ts:1:0', target: 'b.ts:1:0', kind: 'implements', provenance: 'tree-sitter' })
    })

    it('rule 3: an ambiguous heritage target is silently dropped, not routed through `unresolved`', () => {
      const files = [
        file(
          'a.ts',
          [def({ key: '1:0', name: 'Foo', kind: 'class' })],
          [],
          [],
          [{ sourceKey: '1:0', targetName: 'Base', relation: 'extends' }],
        ),
        file('b.ts', [def({ key: '1:0', name: 'Base', kind: 'class' })]),
        file('c.ts', [def({ key: '1:0', name: 'Base', kind: 'class' })]),
      ]
      const graph = resolveWorkspace(files, NOW)
      expect(graph.edges.filter(edge => edge.kind === 'extends')).toEqual([])
      expect(graph.unresolved).toEqual([])
    })

    it('does not let a same-named function win a heritage reference (type-only name index)', () => {
      const files = [
        file(
          'a.ts',
          [def({ key: '1:0', name: 'Foo', kind: 'class' })],
          [],
          [],
          [{ sourceKey: '1:0', targetName: 'Base', relation: 'extends' }],
        ),
        file('b.ts', [def({ key: '1:0', name: 'Base', kind: 'function' })]),
      ]
      const graph = resolveWorkspace(files, NOW)
      expect(graph.edges.filter(edge => edge.kind === 'extends')).toEqual([])
    })
  })
})
