// The pool outlives a query by design — it caches one connection per project root — which is why
// `forget` exists and why its tolerances are worth pinning: the store closes the connection first
// and then asks the pool to drop it, so a second close has to be survivable on every path.
import { rm } from 'node:fs/promises'
import { describe, expect, it } from 'vitest'
import { GraphPool } from '../src/database.ts'
import { seedProject } from './fixture.ts'

describe('GraphPool.forget', () => {
  it('forgets nothing for a root that was never opened', () => {
    const pool = new GraphPool(2)
    expect(() => pool.forget('/never/opened')).not.toThrow()
    pool.close()
  })

  it('tolerates a connection the caller already closed', async () => {
    const root = await seedProject({})
    const pool = new GraphPool(2)
    try {
      pool.acquire(root).close()
      // The store closes before it forgets; a bare second close throws "database is not open".
      expect(() => pool.forget(root)).not.toThrow()
    } finally {
      pool.close()
      await rm(root, { recursive: true, force: true })
    }
  })

  it('opens a fresh connection after a forget, so the next query sees the replaced file', async () => {
    const root = await seedProject({})
    const pool = new GraphPool(2)
    try {
      const first = pool.acquire(root)
      pool.forget(root)
      const second = pool.acquire(root)
      // Asserting on behaviour rather than identity: the forgotten connection is closed, and the
      // pool must hand back a usable one instead of the dead handle it dropped.
      expect(() => first.prepare('SELECT 1')).toThrow('database is not open')
      expect(second.prepare('SELECT 1 AS n').get()).toEqual({ n: 1 })
    } finally {
      pool.close()
      await rm(root, { recursive: true, force: true })
    }
  })
})
