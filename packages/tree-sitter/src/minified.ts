/**
 * Detection of generated (bundled or minified) code, so an index can leave it out.
 *
 * A workspace's build output is not always gitignored: a deployment that ships committed artifacts
 * (`dist/` committed so a server can serve it as-is) hands the walk megabytes of bundler output that
 * is neither source nor hidden from version control. Indexing it is not merely wasted time — those
 * files declare thousands of short, mangled names (`e`, `t`, `n`) that collide with real source
 * symbols, and "one unique workspace-wide name wins" then refuses to resolve every call that the
 * duplicate makes ambiguous.
 *
 * Two signals, both structural rather than name-based on a build tool:
 *  - a `.min.` path segment (`bundle.min.js`) — the conventional marker, checked before any read;
 *  - an average source line longer than {@link MINIFIED_AVERAGE_LINE_LENGTH} characters, which
 *    hand-written code does not reach. Measured on real workspaces: the longest average found in
 *    hand-written source is ~70 characters, while bundled output runs from thousands to tens of
 *    thousands.
 * @module dsh-plugin-codegraph-tree-sitter/minified
 */

import { posix } from 'node:path'

/**
 * Average line length at or above which a file is treated as generated output. Chosen with roughly
 * 7× headroom over the widest real source line measured (~70 characters), and far below the narrowest
 * generated sample seen (~5 000).
 */
export const MINIFIED_AVERAGE_LINE_LENGTH = 500

/** A file's size expressed in lines, without allocating one array element per line. */
export interface TextShape {
  /** Number of newline-separated lines, matching `text.split('\n').length`. */
  readonly lineCount: number
  /** Mean characters per line, counting the trailing partial line. */
  readonly averageLineLength: number
}

/**
 * Measure a file's line structure in one pass over its text.
 * @param text - the file's decoded contents.
 * @returns its line count and mean line length. An empty file is one empty line, matching
 *   `''.split('\n').length`.
 */
export function measureText(text: string): TextShape {
  let newlines = 0
  for (let index = 0; index < text.length; index++) {
    if (text.charCodeAt(index) === 10) newlines++
  }
  const lineCount = newlines + 1
  return { lineCount, averageLineLength: text.length / lineCount }
}

/**
 * Whether a path carries the conventional `.min.` marker, which needs no content read to decide.
 * @param path - project-relative path of the file.
 * @returns whether its own name marks it as minified.
 */
export function isMinifiedName(path: string): boolean {
  return posix.basename(path).includes('.min.')
}

/**
 * Whether a file is generated output the index should leave out.
 * @param path - project-relative path of the file.
 * @param shape - the file's measured line structure.
 * @returns whether its name or its line shape marks it as generated.
 */
export function looksMinified(path: string, shape: TextShape): boolean {
  return isMinifiedName(path) || shape.averageLineLength >= MINIFIED_AVERAGE_LINE_LENGTH
}
