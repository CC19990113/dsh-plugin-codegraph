import { describe, expect, it } from 'vitest'
import { isMinifiedName, looksMinified, MINIFIED_AVERAGE_LINE_LENGTH, measureText } from '../src/minified.ts'

describe('measureText', () => {
  it('counts an empty file as one empty line, matching String.prototype.split', () => {
    expect(measureText('')).toEqual({ lineCount: 1, averageLineLength: 0 })
  })

  it('counts a single unterminated line', () => {
    expect(measureText('abc')).toEqual({ lineCount: 1, averageLineLength: 3 })
  })

  it('counts the trailing empty line a final newline produces', () => {
    expect(measureText('a\n')).toEqual({ lineCount: 2, averageLineLength: 1 })
  })

  it('averages across every line, counting the trailing partial line', () => {
    expect(measureText('abc\nde')).toEqual({ lineCount: 2, averageLineLength: 3 })
    expect(measureText('a\nb\nc')).toEqual({ lineCount: 3, averageLineLength: 1.6666666666666667 })
  })

  it('agrees with split() for a file with mixed line endings', () => {
    const text = 'line one\r\nline two\n\nlast'
    expect(measureText(text).lineCount).toBe(text.split('\n').length)
  })
})

describe('isMinifiedName', () => {
  it('recognises the conventional marker at any depth', () => {
    expect(isMinifiedName('bundle.min.js')).toBe(true)
    expect(isMinifiedName('dist/js/app.min.mjs')).toBe(true)
  })

  it('does not fire on a name that merely contains the letters', () => {
    expect(isMinifiedName('minimum.ts')).toBe(false)
    expect(isMinifiedName('administrative/min.ts')).toBe(false)
  })
})

describe('looksMinified', () => {
  it('fires on the name alone, without consulting the shape', () => {
    expect(looksMinified('app.min.js', measureText('function a() {}\n'))).toBe(true)
  })

  it('fires on an average line length at the threshold', () => {
    const text = 'x'.repeat(MINIFIED_AVERAGE_LINE_LENGTH)
    expect(looksMinified('bundle.js', measureText(text))).toBe(true)
  })

  it('fires on a bundle whose average line length is far past the threshold', () => {
    expect(looksMinified('dist/js/echarts.js', measureText('y'.repeat(2_000)))).toBe(true)
  })

  it('leaves a hand-written file alone', () => {
    const text = Array.from({ length: 40 }, (_, index) => `export function f${index}() { return ${index} }`).join('\n')
    expect(looksMinified('src/a.ts', measureText(text))).toBe(false)
  })

  it('leaves a single short line alone', () => {
    expect(looksMinified('src/a.ts', measureText('const a = 1'))).toBe(false)
  })
})
