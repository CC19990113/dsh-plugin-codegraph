// `rename` is the one call that cannot be made to fail on demand through the filesystem alone: a
// POSIX host replaces the target happily, and only Windows refuses while a handle is open. So this
// file replaces that single import and runs every other fs call for real, which keeps the retry
// loop and the cleanup path under test against a real temp database rather than a stub writer.
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const renameControl = { remainingFailures: 0, code: 'EPERM' }
const readControl = { failFor: '' }
const openControl = { failCode: '' }

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string) => {
      if (renameControl.remainingFailures > 0) {
        renameControl.remainingFailures -= 1
        const error = new Error(`rename blocked (${renameControl.code})`) as NodeJS.ErrnoException
        // An empty code means "the platform reported no code at all", which is the shape the
        // retry predicate has to treat as non-transient rather than as a missing-field crash.
        if (renameControl.code !== '') error.code = renameControl.code
        throw error
      }
      return actual.rename(from, to)
    },
    open: async (...args: Parameters<typeof actual.open>) => {
      if (openControl.failCode !== '') {
        const error = new Error(`open blocked (${openControl.failCode})`) as NodeJS.ErrnoException
        error.code = openControl.failCode
        throw error
      }
      return actual.open(...args)
    },
    // The lock holder can be reclaimed by a rival between the failed exclusive create and this
    // read; no filesystem call can be made to lose that race on demand, so the read is the one
    // thing this file fakes.
    readFile: async (...args: Parameters<typeof actual.readFile>) => {
      if (readControl.failFor !== '' && String(args[0]).endsWith(readControl.failFor)) {
        const error = new Error('ENOENT: lock reclaimed') as NodeJS.ErrnoException
        error.code = 'ENOENT'
        throw error
      }
      return actual.readFile(...args)
    },
  }
})

const { writeGraph } = await import('../src/schema.ts')

const INPUT = { files: [], nodes: [], edges: [], unresolved: [], filesMinified: 0, indexedAt: 1 }

/** A temp database path inside a directory that already exists. */
async function tempDatabasePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-rename-'))
  return join(root, '.codegraph', 'codegraph.db')
}

beforeEach(() => {
  renameControl.remainingFailures = 0
  renameControl.code = 'EPERM'
  readControl.failFor = ''
  openControl.failCode = ''
})

describe('writeGraph rename retry', () => {
  it('publishes the graph when rename succeeds first time', async () => {
    const path = await tempDatabasePath()
    await writeGraph(path, INPUT)
    expect((await readdir(dirname(path))).sort()).toEqual(['codegraph.db', 'status.json'])
  })

  it('retries a transient EPERM and publishes on a later attempt', async () => {
    // One failure exercises the retryable branch; the second attempt must succeed.
    renameControl.remainingFailures = 1
    const path = await tempDatabasePath()
    await writeGraph(path, INPUT)
    expect((await readdir(dirname(path))).sort()).toEqual(['codegraph.db', 'status.json'])
  })

  it('treats EBUSY and EACCES as transient too', async () => {
    renameControl.remainingFailures = 2
    renameControl.code = 'EBUSY'
    const busy = await tempDatabasePath()
    await writeGraph(busy, INPUT)
    expect((await readdir(dirname(busy))).sort()).toEqual(['codegraph.db', 'status.json'])

    renameControl.remainingFailures = 1
    renameControl.code = 'EACCES'
    const denied = await tempDatabasePath()
    await writeGraph(denied, INPUT)
    expect((await readdir(dirname(denied))).sort()).toEqual(['codegraph.db', 'status.json'])
  })

  it('gives up after four attempts and leaves no temp file behind', async () => {
    renameControl.remainingFailures = Number.MAX_SAFE_INTEGER
    const path = await tempDatabasePath()
    await expect(writeGraph(path, INPUT)).rejects.toThrow('rename blocked')
    // The failed replace is inside the cleanup path now; a finished multi-megabyte temp used to
    // linger beside the database forever.
    expect(await readdir(dirname(path))).toEqual([])
  })

  it('does not retry a rename error that is not a sharing violation', async () => {
    renameControl.remainingFailures = Number.MAX_SAFE_INTEGER
    renameControl.code = 'EINVAL'
    const path = await tempDatabasePath()
    await expect(writeGraph(path, INPUT)).rejects.toThrow('rename blocked')
    expect(await readdir(dirname(path))).toEqual([])
  })

  it('reclaims a lock that vanished between the failed create and the read', async () => {
    const path = await tempDatabasePath()
    const dir = dirname(path)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, '.graph.lock'), '424242')
    // Another contender removed the file after our `wx` failed: the read cannot tell us who
    // held it, so the right answer is "dead holder" and a fresh attempt.
    readControl.failFor = '.graph.lock'
    await writeGraph(path, INPUT)
    expect((await readdir(dir)).sort()).toEqual(['codegraph.db', 'status.json'])
  })

  it('surfaces a lock-open failure that is not contention', async () => {
    // mkdir succeeds, so the exclusive create can only fail for a real reason — a read-only
    // parent, say — and waiting for a holder that is not there would be wrong.
    openControl.failCode = 'EACCES'
    const path = await tempDatabasePath()
    await expect(writeGraph(path, INPUT)).rejects.toThrow('open blocked (EACCES)')
  })

  it('does not retry a rename error that carries no code at all', async () => {
    renameControl.remainingFailures = 1
    renameControl.code = ''
    const path = await tempDatabasePath()
    await expect(writeGraph(path, INPUT)).rejects.toThrow('rename blocked')
    expect(await readdir(dirname(path))).toEqual([])
  })
})
