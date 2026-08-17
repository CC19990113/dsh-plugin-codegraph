/**
 * Workspace directory walk: find every file this package can extract from, parse it, and hand back
 * one {@link ExtractedFile} per file that was actually indexed.
 *
 * The walk is deliberately simple: `exclude` entries name directory segments to never descend into
 * (not wildcard globs — the default set needs none), and every bound (`maxFileBytes`, `maxFiles`) is
 * a config field the deployment can retune rather than a constant, per the same-name entries this
 * package's `Config` exposes.
 * @module dsh-plugin-codegraph-tree-sitter/walk
 */

import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { posix } from 'node:path'
import { createParser } from './grammar.ts'
import { extractFile } from './extract.ts'
import { languageFor } from './languages.ts'
import type { ExtractedFile } from './resolve.ts'

/** The walk's tunable bounds, mirroring this package's `Config`. */
export interface WalkConfig {
  /** Directory segment names never descended into. */
  readonly exclude: readonly string[]
  /** Files larger than this are skipped and counted, never parsed. */
  readonly maxFileBytes: number
  /** The walk stops discovering new files once this many have been found. */
  readonly maxFiles: number
  /** Files parsed concurrently. */
  readonly concurrency: number
  /** Restrict extraction to these seam language labels when set; every loaded grammar otherwise. */
  readonly languages?: readonly string[]
}

/** What the walk produced. */
export interface WalkResult {
  readonly files: ExtractedFile[]
  readonly filesSkipped: number
}

/** One candidate file the directory scan found, not yet parsed. */
interface Candidate {
  readonly path: string
  readonly absolute: string
  readonly language: string
}

/**
 * Recursively list every candidate file under `projectRoot`, honoring `exclude` and `maxFiles`.
 * @param projectRoot - absolute path of the root to scan.
 * @param config - the walk's bounds.
 * @param signal - aborts the scan.
 * @returns the candidates found, and how many further candidates `maxFiles` cut off.
 */
async function discover(
  projectRoot: string,
  config: WalkConfig,
  signal?: AbortSignal,
): Promise<{ candidates: Candidate[]; overflow: number }> {
  const excluded = new Set(config.exclude)
  const candidates: Candidate[] = []
  let overflow = 0

  async function scan(relativeDir: string): Promise<void> {
    signal?.throwIfAborted()
    const entries = await readdir(posix.join(projectRoot, relativeDir), { withFileTypes: true })
    for (const entry of entries) {
      if (excluded.has(entry.name)) continue
      const relativePath = relativeDir === '' ? entry.name : `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        await scan(relativePath)
        continue
      }
      if (!entry.isFile()) continue
      const extension = posix.extname(entry.name)
      const spec = languageFor(extension)
      if (spec === undefined) continue
      if (config.languages !== undefined && !config.languages.includes(spec.language)) continue
      if (candidates.length >= config.maxFiles) {
        overflow++
        continue
      }
      candidates.push({ path: relativePath, absolute: posix.join(projectRoot, relativePath), language: spec.language })
    }
  }

  await scan('')
  return { candidates, overflow }
}

/** Parse one candidate, or return `undefined` when it is over {@link WalkConfig.maxFileBytes}. */
async function parseCandidate(candidate: Candidate, config: WalkConfig, signal?: AbortSignal): Promise<ExtractedFile | undefined> {
  const stats = await stat(candidate.absolute)
  if (stats.size > config.maxFileBytes) return undefined
  const spec = languageFor(posix.extname(candidate.path))
  /* v8 ignore next 2 -- discover() only ever produces a candidate whose extension resolved to a spec. */
  if (spec === undefined) return undefined
  const text = await readFile(candidate.absolute, 'utf8')
  const parser = await createParser(spec)
  try {
    signal?.throwIfAborted()
    const tree = parser.parse(text)
    /* v8 ignore next 2 -- createParser() always assigns a language before returning; parse() returns
     * null only when the parser has none. */
    if (tree === null) return undefined
    const extraction = extractFile(tree, spec)
    return {
      path: candidate.path,
      language: spec.language,
      size: stats.size,
      modifiedAt: stats.mtimeMs,
      contentHash: createHash('sha256').update(text).digest('hex'),
      lineCount: text.split('\n').length,
      extraction,
    }
  } finally {
    parser.delete()
  }
}

/** Run `tasks` with at most `concurrency` in flight at once, preserving input order in the result. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  task: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  async function worker(): Promise<void> {
    for (;;) {
      const index = next++
      if (index >= items.length) return
      // `index < items.length` above guarantees a defined element; `noUncheckedIndexedAccess` just
      // cannot express that.
      const item = items[index]
      /* v8 ignore next */
      if (item === undefined) continue
      results[index] = await task(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker))
  return results
}

/**
 * Walk `projectRoot` and parse every candidate file it finds.
 * @param projectRoot - absolute path of the workspace to index.
 * @param config - the walk's bounds.
 * @param signal - aborts the walk.
 * @returns the parsed files and how many candidates were skipped (over size, or past `maxFiles`).
 */
export async function walkAndExtract(projectRoot: string, config: WalkConfig, signal?: AbortSignal): Promise<WalkResult> {
  const { candidates, overflow } = await discover(projectRoot, config, signal)
  const parsed = await mapWithConcurrency(candidates, config.concurrency, candidate => parseCandidate(candidate, config, signal))
  const files: ExtractedFile[] = []
  let filesSkipped = overflow
  for (const file of parsed) {
    if (file === undefined) filesSkipped++
    else files.push(file)
  }
  return { files, filesSkipped }
}
