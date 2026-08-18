/**
 * One-file extraction: walk a parsed tree exactly once, collecting the definitions, call sites, and
 * import bindings the two-pass resolver in `resolve.ts` needs.
 *
 * The caller of a call node is the nearest enclosing definition, or the file itself when the call sits
 * at module top level — the on-disk format records it that way, and a third of the call edges in a
 * real workspace are of exactly this shape.
 * @module dsh-plugin-codegraph-tree-sitter/extract
 */

import type { Node as SyntaxNode, Tree } from 'web-tree-sitter'
import { SELF_NAME_FIELD } from './languages.ts'
import type { DefinitionRule, LanguageSpec } from './languages.ts'

/** The scope a definition sits in, tracked so a `scopeRestricted` rule (see `DefinitionRule`) can be
 * skipped once the walk has descended into a function or method body. */
type ScopeKind = 'module' | 'class' | 'other'

/** One declaration this file introduces, before cross-file resolution. */
export interface RawDefinition {
  /** Stable position-derived key, unique within the file. */
  readonly key: string
  /** The immediately enclosing definition's {@link key}, or `null` for a module-top-level definition. */
  readonly parentKey: string | null
  readonly kind: string
  readonly name: string
  /** Enclosing definition names, outermost first; used to build `qualifiedName`. */
  readonly container: readonly string[]
  readonly startLine: number
  readonly endLine: number
  readonly startColumn: number
  readonly endColumn: number
  readonly isExported: boolean
  readonly isAsync: boolean
  readonly isStatic: boolean
  /**
   * Decorator names applied to this declaration — recorded as descriptive metadata only, never
   * resolved to an edge (a decorator can be an arbitrary call, e.g. `@app.route('/x')`, with no
   * reliable single "target" the way an import or a base class has one). Empty for every language but
   * Python today.
   */
  readonly decorators: readonly string[]
}

/** One call site this file contains, before callee resolution. */
export interface RawCall {
  /** The calling definition's {@link RawDefinition.key}, or `null` for a module-top-level call. */
  readonly callerKey: string | null
  /** The callee's simple name, e.g. `parse` from `parse(x)` or `obj.parse(x)`. */
  readonly calleeName: string
  readonly line: number
  readonly column: number
  /**
   * Whether the callee expression is a member access (`obj.parse()`) rather than a bare identifier
   * (`parse()`). With no type information, a member call's receiver could be anything, so a name
   * match against it is far less trustworthy than a bare identifier's — `resolve.ts` uses this to
   * separate that noise from a genuine gap in the graph when a call goes unresolved.
   */
  readonly isMemberCall: boolean
}

/** One import binding this file introduces. */
export interface RawImport {
  /** The name this file's scope binds, after any `as` rename. */
  readonly localName: string
  /** The name as declared in the source module, `'default'` for a default import, or `'*'` for a
   * namespace or whole-package import — the latter two never drive resolution but are recorded for
   * completeness. */
  readonly importedName: string
  /** The raw module specifier text, e.g. `./bar` or `fmt`. */
  readonly specifier: string
}

/** One `extends`/`implements` reference a captured class or interface declares, before resolution. */
export interface RawHeritageRef {
  /** The declaring class or interface's own {@link RawDefinition.key}. */
  readonly sourceKey: string
  /** The base/interface's simple name — a member expression or call (a mixin, `class X extends f(Y)`)
   * is not a name this package attempts to resolve, matching its existing "don't guess" precedent. */
  readonly targetName: string
  readonly relation: 'extends' | 'implements'
}

/** Everything one file's walk produced. */
export interface FileExtraction {
  readonly definitions: RawDefinition[]
  readonly calls: RawCall[]
  readonly imports: RawImport[]
  readonly heritage: RawHeritageRef[]
}

/** A node's named children, with the `null` slots `web-tree-sitter` reserves for missing nodes dropped. */
function namedChildren(node: SyntaxNode): SyntaxNode[] {
  return node.namedChildren.filter(child => child !== null)
}

/** Every descendant of `node` matching `types`, with `null` slots dropped. */
function descendantsOfType(node: SyntaxNode, types: readonly string[]): SyntaxNode[] {
  return node.descendantsOfType([...types]).filter(child => child !== null)
}

/**
 * A field's text, or `fallback` when the field is absent. `childForFieldName` is typed to return
 * `Node | null` for any field name on any node, but a specific field is absent only when the caller
 * asks for one the matched node type does not carry.
 * @param node - the node to read a field from.
 * @param field - the field name.
 * @param fallback - the text to use when the field is absent.
 * @returns the field's text, or `fallback`.
 */
function fieldText(node: SyntaxNode, field: string, fallback: string): string {
  return node.childForFieldName(field)?.text ?? fallback
}

/** Whether a node carries a modifier keyword as one of its own (non-named) children. */
function hasKeywordChild(node: SyntaxNode, keyword: string): boolean {
  for (let index = 0; index < node.childCount; index++) {
    const child = node.child(index)
    if (child !== null && !child.isNamed && child.text === keyword) return true
  }
  return false
}

/**
 * The lone named child bound to `field`, or `undefined` when zero or more than one is bound. A field
 * ordinarily binds exactly one child (a declaration's name); Go's `const a, b = 1, 2` is the exception
 * — both identifiers share the `name` field on one `const_spec` node — and this package extracts a
 * single declared name per definition, never a silently partial pick from an ambiguous group.
 */
function soleNamedField(node: SyntaxNode, field: string): SyntaxNode | undefined {
  const named = node.childrenForFieldName(field).filter((child): child is SyntaxNode => child !== null && child.isNamed)
  return named.length === 1 ? named[0] : undefined
}

/** The definition rule matching `node`, or `undefined` when it introduces no declaration. */
function matchDefinition(node: SyntaxNode, definitions: readonly DefinitionRule[]): DefinitionRule | undefined {
  for (const rule of definitions) {
    if (node.type !== rule.nodeType) continue
    if (rule.parentType !== undefined && node.parent?.type !== rule.parentType) continue
    if (rule.value !== undefined) {
      const value = node.childForFieldName(rule.value.field)
      if (value === null || !rule.value.types.includes(value.type)) continue
    }
    const nameNode = rule.nameField === SELF_NAME_FIELD ? node : soleNamedField(node, rule.nameField)
    if (nameNode === undefined) continue
    if (rule.nameNodeTypes !== undefined && !rule.nameNodeTypes.includes(nameNode.type)) continue
    return rule
  }
  return undefined
}

/**
 * The callee's simple name from a call node's function-field expression: the identifier itself, or
 * the rightmost property/field/selector name for a member access — `obj.parse()` resolves against
 * `parse`, the same ambiguity a workspace-wide name search already accepts and reports through
 * `unresolvedCount` when it cannot be settled.
 * @param callee - the call node's function-field expression.
 * @returns the simple name, or `undefined` when the expression names nothing identifier-shaped (a
 * computed or parenthesized callee, for instance).
 */
function calleeName(callee: SyntaxNode): string | undefined {
  if (callee.type === 'identifier') return callee.text
  const property = callee.childForFieldName('property')
    ?? callee.childForFieldName('field')
    ?? callee.childForFieldName('attribute')
  if (property !== null && property.type !== 'computed_property_name') return property.text
  return undefined
}

/** Seam language labels using the ECMAScript-family grammars, for CommonJS `require`/export detection. */
const ECMASCRIPT_LANGUAGES: ReadonlySet<string> = new Set(['typescript', 'tsx', 'javascript', 'jsx'])

/** Shared empty set for a non-ECMAScript file, which never has CommonJS export assignments to find. */
const EMPTY_NAME_SET: ReadonlySet<string> = new Set()

/**
 * A CommonJS `require('./foo')` call recognized as an import binding: `const foo = require('./foo')`
 * binds `foo`; a bare `require('./foo')` statement imports for its side effect only. Any other
 * position (a sub-expression, immediate member access on the call result) is not a binding this
 * package attempts to name — the same "don't guess a name" precedent `ecmascriptImports`/
 * `pythonBinding` already follow for shapes they do not fully resolve. Without this, CommonJS code
 * (still common outside pure-ESM projects) parses `require` as an ordinary, always-unresolved call
 * and the workspace gets no `imports` edge for it at all.
 * @param node - a `call_expression` node.
 * @returns the import binding, or `undefined` when `node` is not a bare top-level `require(...)` call.
 */
function commonJsRequireImport(node: SyntaxNode): RawImport | undefined {
  const callee = node.childForFieldName('function')
  // A call node's `function` field is required by the grammar; the null case only satisfies
  // `childForFieldName`'s general return type.
  /* v8 ignore next */
  if (callee === null) return undefined
  if (callee.type !== 'identifier' || callee.text !== 'require') return undefined
  const argsNode = node.childForFieldName('arguments')
  // Likewise required by the grammar, present (empty) even for a zero-argument call.
  /* v8 ignore next */
  if (argsNode === null) return undefined
  const args = namedChildren(argsNode)
  const specifierNode = args.length === 1 ? args[0] : undefined
  if (specifierNode?.type !== 'string') return undefined
  const specifier = namedChildren(specifierNode)[0]?.text ?? specifierNode.text.slice(1, -1)
  const parent = node.parent
  if (parent?.type === 'variable_declarator') {
    const name = parent.childForFieldName('name')
    if (name?.type !== 'identifier') return undefined
    return { localName: name.text, importedName: '*', specifier }
  }
  if (parent?.type === 'expression_statement') return { localName: '', importedName: '*', specifier }
  return undefined
}

/** ECMAScript-family import extraction: `import_statement` with a `import_clause` and a `source`. */
function ecmascriptImports(node: SyntaxNode): RawImport[] {
  // `source` is required by the grammar; the null case only satisfies `childForFieldName`'s general
  // `Node | null` return type.
  const source = node.childForFieldName('source')
  /* v8 ignore next */
  if (source === null) return []
  // An empty string literal (`import ''`) parses with no `string_fragment` child.
  const specifier = namedChildren(source)[0]?.text ?? source.text.slice(1, -1)
  // A side-effect-only import (`import './side'`) carries no `import_clause`.
  const clause = namedChildren(node).find(child => child.type === 'import_clause')
  if (clause === undefined) return []
  const imports: RawImport[] = []
  for (const child of namedChildren(clause)) {
    if (child.type === 'identifier') {
      imports.push({ localName: child.text, importedName: 'default', specifier })
    }
    if (child.type === 'namespace_import') {
      // The grammar requires `* as <identifier>` together; a `namespace_import` node is never
      // produced with no named child.
      const local = namedChildren(child)[0]
      /* v8 ignore next */
      if (local === undefined) continue
      imports.push({ localName: local.text, importedName: '*', specifier })
    }
    if (child.type !== 'named_imports') continue
    // The grammar allows only `import_specifier` as a `named_imports` child; `{}` produces zero
    // named children, never one of a different type.
    for (const specifierNode of namedChildren(child)) {
      /* v8 ignore next */
      if (specifierNode.type !== 'import_specifier') continue
      // `name` is required by the grammar; only `alias` is conditional on an `as` clause.
      const name = specifierNode.childForFieldName('name')
      const alias = specifierNode.childForFieldName('alias')
      /* v8 ignore next */
      if (name === null) continue
      imports.push({ localName: alias?.text ?? name.text, importedName: name.text, specifier })
    }
  }
  return imports
}

/**
 * One Python `decorator` node's name — a bare `@staticmethod` names its own `identifier`; `@app.route`
 * names its dotted `attribute` verbatim (not just the rightmost segment, unlike `calleeName`'s call-site
 * ambiguity — a decorator name is metadata, not something this package resolves, so there is no reason
 * to throw away the qualifying prefix); `@app.route('/x')` first unwraps the `call` to its `function`
 * field, then applies the same rule. Any other shape (e.g. a subscript, `@decorators[0]`) is not named —
 * the "don't guess" precedent this file already follows elsewhere.
 * @param decorator - the `decorator` node.
 * @returns the decorator's name, or `undefined` when its expression is not identifier/attribute-shaped.
 */
function pythonDecoratorName(decorator: SyntaxNode): string | undefined {
  let expr = namedChildren(decorator)[0]
  // A decorator's expression is required by the grammar (`@` alone does not parse); the undefined case
  // only satisfies `namedChildren`'s general array-access return type.
  /* v8 ignore next */
  if (expr === undefined) return undefined
  if (expr.type === 'call') {
    // A call node's `function` field is required by the grammar; the null case only satisfies
    // `childForFieldName`'s general return type.
    const callee = expr.childForFieldName('function')
    /* v8 ignore next */
    if (callee === null) return undefined
    expr = callee
  }
  if (expr.type === 'identifier' || expr.type === 'attribute') return expr.text
  return undefined
}

/**
 * Every decorator name applied to a Python `function_definition`/`class_definition`, from its enclosing
 * `decorated_definition`'s `decorator` children (a decorated declaration is wrapped one level up by the
 * grammar, not marked on the declaration node itself — verified against a real parse, not guessed).
 * Empty when the language is not Python or the declaration is undecorated.
 * @param node - the `function_definition`/`class_definition` node.
 * @param language - the seam language label the file was parsed as.
 * @returns every decorator name applied, outermost first.
 */
function pythonDecorators(node: SyntaxNode, language: string): readonly string[] {
  if (language !== 'python') return []
  if (node.parent?.type !== 'decorated_definition') return []
  const names: string[] = []
  for (const child of namedChildren(node.parent)) {
    if (child.type !== 'decorator') continue
    const name = pythonDecoratorName(child)
    if (name !== undefined) names.push(name)
  }
  return names
}

/**
 * One `dotted_name` or `aliased_import` child of a Python import statement, resolved to a binding.
 * @param child - the `dotted_name` or `aliased_import` node.
 * @param bindsSymbol - whether this statement binds one module-level name (`from x import y`) rather
 * than the whole module (`import x`), which decides whether the binding's `importedName` is the
 * declared name or the seam's namespace marker `'*'`.
 * @param specifier - the module specifier this binding resolves against.
 * @returns the resolved import binding.
 */
function pythonBinding(child: SyntaxNode, bindsSymbol: boolean, specifier: string): RawImport {
  const name = child.type === 'aliased_import' ? fieldText(child, 'name', child.text) : child.text
  const local = child.type === 'aliased_import' ? fieldText(child, 'alias', name) : name
  return { localName: local, importedName: bindsSymbol ? name : '*', specifier }
}

/** Python import extraction: `import_statement` (bare) and `import_from_statement` (relative-capable). */
function pythonImports(node: SyntaxNode): RawImport[] {
  if (node.type === 'import_statement') {
    return namedChildren(node)
      .filter(child => child.type === 'dotted_name' || child.type === 'aliased_import')
      .map((child) => {
        const name = child.type === 'aliased_import' ? fieldText(child, 'name', child.text) : child.text
        return pythonBinding(child, false, name)
      })
  }
  // `module_name` is required by the grammar's `import_from_statement` rule, including the dots-only
  // form (`from . import x`); the null case only satisfies `childForFieldName`'s general return type.
  const moduleNode = node.childForFieldName('module_name')
  /* v8 ignore next */
  const specifier = moduleNode?.text ?? ''
  return namedChildren(node)
    // The module node itself is a named child alongside the imported names — excluded by identity,
    // not by node type, because an absolute module specifier is a `dotted_name` too, indistinguishable
    // by type from an imported symbol written the same way (`from x import y`).
    .filter(child => !(moduleNode !== null && child.equals(moduleNode)))
    .filter(child => child.type === 'dotted_name' || child.type === 'aliased_import' || child.type === 'wildcard_import')
    .map((child) => {
      // `from x import *` binds no individual symbol this package tracks by name, but the module
      // itself is still imported — recording it (with no `localName`, `importedName: '*'`, matching
      // the namespace-import convention `pythonBinding` already uses) keeps the `imports` edge to
      // `specifier` instead of silently dropping the statement.
      if (child.type === 'wildcard_import') return { localName: '', importedName: '*', specifier }
      return pythonBinding(child, true, specifier)
    })
}

/** Go import extraction: `import_declaration` wraps one or more `import_spec` nodes, each requiring a `path`. */
function goImports(node: SyntaxNode): RawImport[] {
  return descendantsOfType(node, ['import_spec']).map((spec) => {
    // `path` is required by the grammar's `import_spec` rule; the null case only satisfies
    // `childForFieldName`'s general `Node | null` return type.
    const path = spec.childForFieldName('path')
    /* v8 ignore next */
    const raw = path === null ? '' : (namedChildren(path)[0]?.text ?? path.text.slice(1, -1))
    // `String.prototype.split` always returns at least one element, so `.pop()` is never `undefined`;
    // the fallback only satisfies the general array-access return type.
    /* v8 ignore next */
    const local = fieldText(spec, 'name', raw.split('/').pop() ?? raw)
    // A package import binds no individual symbol; resolution never matches on `importedName: '*'`,
    // but recording the binding still lets `status`-adjacent tooling see what a file imports.
    return { localName: local, importedName: '*', specifier: raw }
  })
}

/** Whether `node` is a bare name this package resolves heritage references against — a member
 * expression (`ns.Base`) or a call (a mixin, `f(Base)`) is not, matching the "don't guess" precedent
 * `calleeName`/`ecmascriptImports` already follow for shapes they do not fully resolve. */
function isHeritageName(node: SyntaxNode): boolean {
  return node.type === 'identifier' || node.type === 'type_identifier'
}

/**
 * ECMAScript-family `extends`/`implements` extraction from a `class_declaration`'s `class_heritage`
 * child. Plain JavaScript's `class_heritage` wraps the extended expression directly (`extends Base` has
 * no further wrapper — JavaScript has no `implements`); TypeScript's wraps an `extends_clause` and an
 * optional `implements_clause` instead, verified against a real parse, not guessed.
 * @param node - the `class_declaration` node.
 * @param sourceKey - the declaring class's own {@link RawDefinition.key}.
 * @returns every heritage reference the class declares.
 */
function ecmascriptClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const heritage = namedChildren(node).find(child => child.type === 'class_heritage')
  if (heritage === undefined) return []
  const refs: RawHeritageRef[] = []
  for (const child of namedChildren(heritage)) {
    if (child.type === 'extends_clause') {
      const target = namedChildren(child)[0]
      if (target !== undefined && isHeritageName(target)) refs.push({ sourceKey, targetName: target.text, relation: 'extends' })
      continue
    }
    if (child.type === 'implements_clause') {
      for (const impl of namedChildren(child)) {
        if (isHeritageName(impl)) refs.push({ sourceKey, targetName: impl.text, relation: 'implements' })
      }
      continue
    }
    // Plain JavaScript: `child` is the extended expression itself.
    if (isHeritageName(child)) refs.push({ sourceKey, targetName: child.text, relation: 'extends' })
  }
  return refs
}

/**
 * TypeScript `interface_declaration` `extends` extraction from its `extends_type_clause` child — an
 * interface can extend more than one other interface (`interface C extends A, B {}`).
 * @param node - the `interface_declaration` node.
 * @param sourceKey - the declaring interface's own {@link RawDefinition.key}.
 * @returns every heritage reference the interface declares.
 */
function tsInterfaceHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const clause = namedChildren(node).find(child => child.type === 'extends_type_clause')
  if (clause === undefined) return []
  return namedChildren(clause)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * Python `class_definition` base-class extraction from its `argument_list` child — shared with call
 * argument syntax, so a `keyword_argument` (`metaclass=Meta`) is filtered out rather than treated as a
 * base; Python draws no distinction between a base class and an interface, so every entry is `extends`.
 * @param node - the `class_definition` node.
 * @param sourceKey - the declaring class's own {@link RawDefinition.key}.
 * @returns every heritage reference the class declares.
 */
function pythonClassHeritage(node: SyntaxNode, sourceKey: string): RawHeritageRef[] {
  const args = namedChildren(node).find(child => child.type === 'argument_list')
  if (args === undefined) return []
  return namedChildren(args)
    .filter(isHeritageName)
    .map(target => ({ sourceKey, targetName: target.text, relation: 'extends' as const }))
}

/**
 * Dispatch heritage extraction to the language family that owns a captured class or interface node's
 * syntax. Go is absent: its interfaces are satisfied structurally, never declared at the implementing
 * type, so there is no static reference here to extract.
 * @param node - the captured `class`- or `interface`-kind definition node.
 * @param kind - the captured definition's seam kind (`'class'` or `'interface'`).
 * @param sourceKey - the declaring definition's own {@link RawDefinition.key}.
 * @param language - the seam language label the file was parsed as.
 * @returns every heritage reference the definition declares.
 */
function extractHeritage(node: SyntaxNode, kind: string, sourceKey: string, language: string): RawHeritageRef[] {
  // `kind === 'interface'` only ever comes from TYPESCRIPT_DEFINITIONS's `interface_declaration` rule —
  // no other language in LANGUAGE_TABLE produces it.
  if (kind === 'interface') return tsInterfaceHeritage(node, sourceKey)
  if (kind !== 'class') return []
  if (language === 'python') return pythonClassHeritage(node, sourceKey)
  // `kind === 'class'` otherwise only comes from ECMASCRIPT_DEFINITIONS's `class_declaration` rule —
  // Go has no class concept, so this is never reached with `language === 'go'`.
  return ecmascriptClassHeritage(node, sourceKey)
}

/**
 * Extract every definition, call, and import from one parsed file.
 * @param tree - the file's parsed syntax tree.
 * @param spec - the language's extraction table entry.
 * @returns the raw, not-yet-resolved extraction.
 */
export function extractFile(tree: Tree, spec: LanguageSpec): FileExtraction {
  const definitions: RawDefinition[] = []
  const calls: RawCall[] = []
  const imports: RawImport[] = []
  const heritage: RawHeritageRef[] = []
  const containerNames: string[] = []
  const containerKeys: (string | null)[] = [null]
  const commonJsExports = ECMASCRIPT_LANGUAGES.has(spec.language) ? commonJsExportedNames(tree.rootNode) : EMPTY_NAME_SET
  // Tracks whether the node currently being visited sits at module top level, directly inside a class
  // body, or inside a function/method body — see `DefinitionRule.scopeRestricted` and
  // `LanguageSpec.bareFunctionScopeTypes`.
  const scopeKinds: ScopeKind[] = ['module']

  function visit(node: SyntaxNode): void {
    const rule = matchDefinition(node, spec.definitions)
    // A `scopeRestricted` rule matched inside a function/method body is treated as no match at all —
    // the node still gets visited below, just without becoming a definition or a container.
    const captured = rule !== undefined
      && (rule.scopeRestricted !== true || scopeKinds[scopeKinds.length - 1] !== 'other')
    if (captured) {
      const nameNode = rule.nameField === SELF_NAME_FIELD ? node : node.childForFieldName(rule.nameField)
      // A matched rule's node type is always the NAMED-declaration form the grammar mandates a name
      // for; the anonymous form (`function_expression`, `class` as an expression, both produced by an
      // anonymous default export) parses as a different node type this rule never matches.
      /* v8 ignore next */
      if (nameNode !== null) {
        const key = `${node.startPosition.row}:${node.startPosition.column}`
        const parentKey = containerKeys[containerKeys.length - 1] ?? null
        definitions.push({
          key,
          parentKey,
          kind: rule.kind,
          name: nameNode.text,
          container: [...containerNames],
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          startColumn: node.startPosition.column,
          endColumn: node.endPosition.column,
          isExported: isExported(node, spec.language, nameNode.text, commonJsExports),
          isAsync: hasKeywordChild(node, 'async'),
          isStatic: hasKeywordChild(node, 'static'),
          decorators: pythonDecorators(node, spec.language),
        })
        heritage.push(...extractHeritage(node, rule.kind, key, spec.language))
        containerNames.push(nameNode.text)
        containerKeys.push(key)
        scopeKinds.push(rule.kind === 'class' ? 'class' : 'other')
        for (const child of namedChildren(node)) visit(child)
        scopeKinds.pop()
        containerKeys.pop()
        containerNames.pop()
        return
      }
    }

    if (spec.callTypes.includes(node.type)) {
      // Every call-shaped node type in every language table entry requires its callee field; the null
      // case only satisfies `childForFieldName`'s general return type.
      const callee = node.childForFieldName(spec.callFunctionField)
      /* v8 ignore next */
      const name = callee === null ? undefined : calleeName(callee)
      if (name !== undefined) {
        calls.push({
          callerKey: containerKeys[containerKeys.length - 1] ?? null,
          calleeName: name,
          line: node.startPosition.row + 1,
          column: node.startPosition.column,
          // `callee` is non-null whenever `name` is: the optional chaining only satisfies the type
          // system's view of the field lookup above, not a real possibility here.
          /* v8 ignore next */
          isMemberCall: callee?.type !== 'identifier',
        })
      }
    }

    if (spec.importTypes.includes(node.type)) {
      imports.push(...extractImports(node, spec.language))
    }

    if (node.type === 'call_expression' && ECMASCRIPT_LANGUAGES.has(spec.language)) {
      const requireImport = commonJsRequireImport(node)
      if (requireImport !== undefined) imports.push(requireImport)
    }

    // A callback or IIFE's function value is never itself captured as a definition (only a *named*
    // declaration, or one assigned through a captured `variable_declarator`, is) — but a `const`/`var`
    // in its body is still function-local, so its scope must flip to `'other'` here regardless.
    const entersBareFunctionScope = spec.bareFunctionScopeTypes.includes(node.type)
    if (entersBareFunctionScope) scopeKinds.push('other')
    for (const child of namedChildren(node)) visit(child)
    if (entersBareFunctionScope) scopeKinds.pop()
  }

  visit(tree.rootNode)
  return { definitions, calls, imports, heritage }
}

/** Dispatch import extraction to the language family that owns `node`'s syntax. */
function extractImports(node: SyntaxNode, language: string): RawImport[] {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return ecmascriptImports(node)
    case 'python':
      return pythonImports(node)
    case 'go':
      return goImports(node)
    /* v8 ignore next 2 -- exhaustive over LANGUAGE_TABLE's current language labels; unreachable. */
    default:
      return []
  }
}

/** Whether `node` is the two-level `module.exports` member expression itself (not `module.exports.x`). */
function isModuleExportsExpression(node: SyntaxNode | null): boolean {
  return node?.type === 'member_expression'
    && node.childForFieldName('object')?.type === 'identifier'
    && node.childForFieldName('object')?.text === 'module'
    && node.childForFieldName('property')?.text === 'exports'
}

/**
 * Every name a top-level CommonJS export assignment marks exported: `module.exports.NAME = ...` /
 * `exports.NAME = ...` (named export), and `module.exports = NAME` (whole-module reassignment to a
 * single local declaration). `module.exports = { a, b }` (object-literal reassignment) is not handled
 * — distinguishing a shorthand property from a computed or renamed one adds a second layer of "don't
 * guess" cases this pass does not need yet; only the two unambiguous forms above are recognized.
 * Restricted to true top-level statements, matching this file's existing module/class-only scope
 * restriction for a `scopeRestricted` `DefinitionRule` — a conditional or function-body export
 * assignment is not a module's public surface in the same unconditional sense.
 * @param root - the file's parsed root (`program`) node.
 * @returns every name a CommonJS export assignment binds.
 */
function commonJsExportedNames(root: SyntaxNode): ReadonlySet<string> {
  const names = new Set<string>()
  for (const statement of namedChildren(root)) {
    if (statement.type !== 'expression_statement') continue
    const expr = namedChildren(statement)[0]
    if (expr?.type !== 'assignment_expression') continue
    const left = expr.childForFieldName('left')
    if (left?.type !== 'member_expression') continue
    const object = left.childForFieldName('object')
    const property = left.childForFieldName('property')
    if (isModuleExportsExpression(object) || (object?.type === 'identifier' && object.text === 'exports')) {
      // `property` is required by the grammar's `member_expression` rule; the null case only
      // satisfies `childForFieldName`'s general return type.
      /* v8 ignore next */
      if (property !== null) names.add(property.text)
      continue
    }
    if (isModuleExportsExpression(left)) {
      const right = expr.childForFieldName('right')
      if (right?.type === 'identifier') names.add(right.text)
    }
  }
  return names
}

/**
 * Whether a declaration is exported from its module, by the export construct its own language
 * defines: ECMAScript wraps an exported statement in `export_statement`, or — for CommonJS code, still
 * common outside pure-ESM projects — is named by a top-level `module.exports`/`exports` assignment (see
 * {@link commonJsExportedNames}); Go's spec defines an exported identifier as one starting with an
 * uppercase letter, with no separate keyword; Python defines no export construct at all, so every
 * Python declaration reports `false` rather than guess one from a naming convention or an `__all__`
 * list the extractor does not read.
 * @param node - the definition node.
 * @param language - the seam language label the file was parsed as.
 * @param name - the declaration's simple name.
 * @param commonJsExports - every name a CommonJS export assignment in this file binds.
 * @returns whether the language's own export rule marks this declaration exported.
 */
function isExported(node: SyntaxNode, language: string, name: string, commonJsExports: ReadonlySet<string>): boolean {
  if (language === 'go') return /^\p{Lu}/u.test(name)
  if (language === 'python') return false
  if (commonJsExports.has(name)) return true
  let current: SyntaxNode | null = node.parent
  while (current !== null) {
    if (current.type === 'export_statement') return true
    // A statement block or class body ends the search: an export wraps a top-level statement, never
    // reaches inside a function or class body to a nested declaration.
    if (current.type === 'statement_block' || current.type === 'class_body') return false
    current = current.parent
  }
  return false
}
