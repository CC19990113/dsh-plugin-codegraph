import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { formatIndexedAt, indexStatusHint, readIndexStatus, workspaceOf } from '../src/status-hint.ts'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

async function workspace(files: Record<string, string> = {}): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-hint-'))
  roots.push(root)
  for (const [path, text] of Object.entries(files)) {
    await mkdir(join(root, path, '..'), { recursive: true })
    await writeFile(join(root, path), text)
  }
  return root
}

const STATUS = {
  indexedAt: Date.UTC(2026, 10, 3, 1, 57),
  filesIndexed: 337,
  filesMinified: 23,
  nodeCount: 3074,
  edgeCount: 6786,
  unresolvedCount: 8337,
  unresolvedLikelyInternalCount: 2993,
}

describe('readIndexStatus', () => {
  it('reads a well-formed summary', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(STATUS) })
    expect(readIndexStatus(root)).toEqual(STATUS)
  })

  it('answers undefined when the file is absent', async () => {
    const root = await workspace()
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined when the file is not JSON', async () => {
    const root = await workspace({ '.codegraph/status.json': 'not json' })
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined when the parsed value is JSON null', async () => {
    const root = await workspace({ '.codegraph/status.json': 'null' })
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined for a JSON primitive', async () => {
    const root = await workspace({ '.codegraph/status.json': '42' })
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined when the value is an array carrying none of the fields', async () => {
    const root = await workspace({ '.codegraph/status.json': '[1,2,3]' })
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined when a field is missing', async () => {
    const partial = { ...STATUS } as Record<string, unknown>
    delete partial['unresolvedLikelyInternalCount']
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(partial) })
    expect(readIndexStatus(root)).toBeUndefined()
  })

  it('answers undefined when a field carries the wrong type', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify({ ...STATUS, filesIndexed: '337' }) })
    expect(readIndexStatus(root)).toBeUndefined()
  })
})

describe('formatIndexedAt', () => {
  it('renders UTC at minute precision', () => {
    expect(formatIndexedAt(Date.UTC(2026, 10, 3, 1, 57, 44))).toBe('2026-11-03T01:57Z')
  })
})

describe('indexStatusHint', () => {
  it('names the workspace it cannot see when the session has none', () => {
    expect(indexStatusHint(undefined)).toBe(
      'This session has no workspace bound, so codegraph needs an explicit project_path on every call.',
    )
  })

  it('reports size, age, and skipped artifacts from the summary', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify(STATUS) })
    expect(indexStatusHint(root)).toBe(
      `The code graph for ${root} was built 2026-11-03T01:57Z from 337 files: 3074 declarations, 6786 relationships. `
      + '23 generated files were left out.',
    )
  })

  it('omits the artifact clause when nothing was skipped', async () => {
    const root = await workspace({ '.codegraph/status.json': JSON.stringify({ ...STATUS, filesMinified: 0 }) })
    expect(indexStatusHint(root)).toContain('6786 relationships.')
    expect(indexStatusHint(root)).not.toContain('generated files')
  })

  it('distinguishes an index without a summary from no index at all', async () => {
    const withGraph = await workspace({ '.codegraph/codegraph.db': '' })
    expect(indexStatusHint(withGraph)).toBe(
      `A code graph exists for ${withGraph} but predates this plugin's status summary — call codegraph status for its size and freshness.`,
    )
  })

  it('says so plainly when nothing has been indexed', async () => {
    const empty = await workspace()
    expect(indexStatusHint(empty)).toBe(
      `No code graph exists for ${empty} yet. Call codegraph_index once to build one; queries fail until then.`,
    )
  })
})

describe('workspaceOf', () => {
  it("reads the assembly context's session workspace", () => {
    expect(workspaceOf({ agent: { session: { header: { cwd: '/repo' } } } })).toBe('/repo')
  })

  it('answers undefined for a session without a workspace', () => {
    expect(workspaceOf({ agent: { session: { header: {} } } })).toBeUndefined()
  })

  it('answers undefined for a blank workspace', () => {
    expect(workspaceOf({ agent: { session: { header: { cwd: '   ' } } } })).toBeUndefined()
  })

  it('answers undefined for a non-string workspace', () => {
    expect(workspaceOf({ agent: { session: { header: { cwd: 42 } } } })).toBeUndefined()
  })

  it('answers undefined for an assembly context that carries no agent', () => {
    expect(workspaceOf(undefined)).toBeUndefined()
    expect(workspaceOf({})).toBeUndefined()
  })
})
