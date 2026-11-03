import { describe, expect, it } from 'vitest'
import { assertNever } from '../src/assert.ts'

describe('assertNever', () => {
  it('throws naming the union it was called for', () => {
    expect(() => assertNever('stray' as never, 'codegraph operation')).toThrow(
      'unreachable variant in codegraph operation: "stray"',
    )
  })

  it('throws without the context clause when none is given', () => {
    expect(() => assertNever({ kind: 'stray' } as never)).toThrow('unreachable variant: {"kind":"stray"}')
  })

  it('falls back to String() for a value JSON cannot represent', () => {
    expect(() => assertNever(Symbol('stray') as never)).toThrow('unreachable variant: Symbol(stray)')
  })
})
