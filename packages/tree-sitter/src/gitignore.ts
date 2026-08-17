/**
 * A deliberately small subset of `.gitignore` pattern syntax, just enough to keep the indexer's
 * exclusion set in step with what a project's own build tooling already hides from version control —
 * without a new dependency on a full gitignore-matching library.
 *
 * Only the project root's `.gitignore` is read; per-directory `.gitignore` files nested below it are
 * not consulted, matching the walk's own root-relative worldview.
 *
 * Supported:
 *  - Blank lines and lines starting with `#` are comments.
 *  - A leading `!` negates: a later matching rule re-includes a path an earlier rule excluded.
 *  - A pattern containing `/` (leading or internal) is anchored to the project root; one with no `/`
 *    at all matches at any depth, by basename.
 *  - A trailing `/` restricts the rule to directories.
 *  - `*` matches any run of characters other than `/`, within one path segment.
 *
 * Not supported. Each is treated as a literal character (or, for `**`, as two literal `*` globs),
 * which only ever makes a pattern *more* specific than a real gitignore would — it degrades toward
 * "excludes nothing extra" rather than toward "excludes too much":
 *  - `**` (explicit multi-segment wildcards — plain unanchored patterns already cross depths)
 *  - character classes (`[abc]`), `?`, and backslash escapes
 *  - git's rule that a negation cannot resurrect a path inside an already-excluded directory: here,
 *    a negation re-includes whatever it matches regardless of ancestor exclusions.
 * @module dsh-plugin-codegraph-tree-sitter/gitignore
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'

/** One parsed `.gitignore` rule, pre-compiled to a matcher. */
export interface GitignoreRule {
  /** Matches a full project-relative, `/`-separated path. */
  readonly pattern: RegExp
  /** `!`-prefixed: a match re-includes rather than excludes. */
  readonly negated: boolean
  /** Trailing-`/`: only ever matches a directory. */
  readonly directoryOnly: boolean
}

/** Regex-escape everything except the one wildcard this subset understands. */
function toRegExp(pattern: string, anchored: boolean): RegExp {
  const escaped = pattern
    .split('*')
    .map(part => part.replace(/[.+^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*')
  // Anchored: the pattern must match the whole relative path. Unanchored: it must match the whole
  // final path segment, at any depth — either the entire path (top level) or whatever follows the
  // last `/` before it.
  const body = anchored ? escaped : `(?:^|.*/)${escaped}`
  return new RegExp(`^${body}$`)
}

/**
 * Parse `.gitignore` file content into an ordered rule list.
 * @param content - the raw file text.
 * @returns rules in file order. Matching must apply them in order and keep the last match, per
 *   git's own precedence — a later line overrides an earlier one it conflicts with.
 */
export function parseGitignore(content: string): GitignoreRule[] {
  const rules: GitignoreRule[] = []
  for (const rawLine of content.split('\n')) {
    const line = rawLine.replace(/\r$/, '')
    if (line.trim() === '' || line.startsWith('#')) continue

    let pattern = line
    let negated = false
    if (pattern.startsWith('!')) {
      negated = true
      pattern = pattern.slice(1)
    }

    let directoryOnly = false
    if (pattern.endsWith('/')) {
      directoryOnly = true
      pattern = pattern.slice(0, -1)
    }

    const anchored = pattern.includes('/')
    if (pattern.startsWith('/')) pattern = pattern.slice(1)
    // A bare "/", "!", or "!/" names nothing once stripped — skip rather than build a rule that
    // would match every path.
    if (pattern === '') continue

    rules.push({ pattern: toRegExp(pattern, anchored), negated, directoryOnly })
  }
  return rules
}

/**
 * Whether `relativePath` should be excluded per `rules`. Later rules win over earlier ones, matching
 * git's own precedence: the loop keeps applying matches rather than stopping at the first one.
 * @param rules - parsed rules, in file order.
 * @param relativePath - the path to test, relative to the project root, `/`-separated.
 * @param isDirectory - whether the path names a directory; directory-only rules skip files.
 * @returns whether the path is excluded.
 */
export function matchesGitignore(rules: readonly GitignoreRule[], relativePath: string, isDirectory: boolean): boolean {
  let excluded = false
  for (const rule of rules) {
    if (rule.directoryOnly && !isDirectory) continue
    if (!rule.pattern.test(relativePath)) continue
    excluded = !rule.negated
  }
  return excluded
}

/**
 * Load and parse `<projectRoot>/.gitignore`.
 * @param projectRoot - absolute path of the project root.
 * @returns the parsed rules, or an empty array when there is no root `.gitignore` — a missing file
 *   means "nothing extra to exclude," not a failure, so this never throws.
 */
export async function loadGitignore(projectRoot: string): Promise<GitignoreRule[]> {
  try {
    return parseGitignore(await readFile(join(projectRoot, '.gitignore'), 'utf8'))
  } catch {
    return []
  }
}
