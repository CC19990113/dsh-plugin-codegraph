import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { InvariantRegistry } from '@deepseek-ai/dsh-invariants'
import { apply, inject, name } from '../src/invariant.ts'

const PACKAGE_NAME = 'dsh-plugin-codegraph-tree-sitter'

async function seam(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(InvariantRegistry)
  return ctx
}

describe('tree-sitter invariant companion', () => {
  it('names itself and declares its invariants dependency', () => {
    expect(name).toBe('codegraph-tree-sitter-invariant')
    expect(inject).toEqual(['invariants'])
  })

  it('registers the package invariant and hands back a working disposer', async () => {
    const ctx = await seam()
    const registerSpy = vi.spyOn(ctx.invariants, 'register')

    const dispose = await apply(ctx)

    expect(registerSpy).toHaveBeenCalledWith(PACKAGE_NAME, expect.any(Function))
    expect(dispose).toBeTypeOf('function')
    await dispose()
  })
})
