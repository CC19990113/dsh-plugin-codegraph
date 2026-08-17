/**
 * Durable-boundary mapping from SQLite rows to seam records. Every value crossing this module comes
 * from a file an independently versioned indexer wrote, so each field is checked before it becomes a
 * typed record; a row that violates the format fails loud as `CODEGRAPH_MALFORMED_INDEX` rather than
 * reaching a consumer as a plausible-looking wrong value.
 * @module dsh-plugin-codegraph-sqlite/rows
 */

import { CodegraphError, CodegraphNodeId } from 'dsh-plugin-codegraph-service'
import type { CodegraphEdge, CodegraphFile, CodegraphNode } from 'dsh-plugin-codegraph-service'

/** One `nodes` row as `node:sqlite` returns it, before validation. */
export type NodeRow = Record<string, unknown>

/**
 * Read a required text column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's string value.
 */
function text(row: NodeRow, column: string, what: string): string {
  const value = row[column]
  if (typeof value !== 'string') {
    throw new CodegraphError(`${what} has a non-text "${column}"`, 'CODEGRAPH_MALFORMED_INDEX')
  }
  return value
}

/**
 * Read a required integer column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's numeric value.
 */
function integer(row: NodeRow, column: string, what: string): number {
  const value = row[column]
  if (typeof value === 'number') return value
  // A stored INTEGER outside the safe range never reaches here: `node:sqlite` raises a RangeError
  // while reading the row, because this store opens connections without bigint reads.
  throw new CodegraphError(`${what} has a non-integer "${column}"`, 'CODEGRAPH_MALFORMED_INDEX')
}

/**
 * Read an optional text column, treating SQL NULL and the empty string alike as absent.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's string value, or undefined when absent.
 */
function optionalText(row: NodeRow, column: string, what: string): string | undefined {
  const value = row[column]
  if (value === null || value === undefined || value === '') return undefined
  if (typeof value !== 'string') {
    throw new CodegraphError(`${what} has a non-text "${column}"`, 'CODEGRAPH_MALFORMED_INDEX')
  }
  return value
}

/**
 * Read an optional integer column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the column's numeric value, or undefined when NULL.
 */
function optionalInteger(row: NodeRow, column: string, what: string): number | undefined {
  const value = row[column]
  if (value === null || value === undefined) return undefined
  return integer(row, column, what)
}

/**
 * Read a boolean stored as INTEGER 0/1, treating NULL as false.
 * @param row - the raw row.
 * @param column - the column name.
 * @returns whether the flag is set.
 */
function flag(row: NodeRow, column: string): boolean {
  return row[column] === 1
}

/**
 * Read a JSON-array text column.
 * @param row - the raw row.
 * @param column - the column name.
 * @param what - the record being built, for the failure message.
 * @returns the parsed strings, or an empty array when the column is NULL or empty.
 */
function stringArray(row: NodeRow, column: string, what: string): readonly string[] {
  const raw = optionalText(row, column, what)
  if (raw === undefined) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    // Only JSON.parse runs in the try; any throw here is a syntax error in the stored text, which
    // is exactly the malformed-index case reported below.
    throw new CodegraphError(`${what} has an unparseable "${column}"`, 'CODEGRAPH_MALFORMED_INDEX')
  }
  if (!Array.isArray(parsed) || parsed.some(entry => typeof entry !== 'string')) {
    throw new CodegraphError(`${what} has a non-string-array "${column}"`, 'CODEGRAPH_MALFORMED_INDEX')
  }
  return parsed as string[]
}

/**
 * Build a {@link CodegraphNode} from a `nodes` row.
 * @param row - the raw row, selected with every `nodes` column present.
 * @returns the validated node record.
 */
export function toNode(row: NodeRow): CodegraphNode {
  const what = 'a graph node'
  const id = text(row, 'id', what)
  const named = `graph node "${id}"`
  const docstring = optionalText(row, 'docstring', named)
  const signature = optionalText(row, 'signature', named)
  const visibility = optionalText(row, 'visibility', named)
  return {
    id: CodegraphNodeId(id),
    kind: text(row, 'kind', named),
    name: text(row, 'name', named),
    qualifiedName: text(row, 'qualified_name', named),
    filePath: text(row, 'file_path', named),
    language: text(row, 'language', named),
    startLine: integer(row, 'start_line', named),
    endLine: integer(row, 'end_line', named),
    startColumn: integer(row, 'start_column', named),
    endColumn: integer(row, 'end_column', named),
    ...docstring === undefined ? {} : { docstring },
    ...signature === undefined ? {} : { signature },
    ...visibility === undefined ? {} : { visibility },
    isExported: flag(row, 'is_exported'),
    isAsync: flag(row, 'is_async'),
    isStatic: flag(row, 'is_static'),
    isAbstract: flag(row, 'is_abstract'),
    decorators: stringArray(row, 'decorators', named),
    typeParameters: stringArray(row, 'type_parameters', named),
    updatedAt: integer(row, 'updated_at', named),
  }
}

/**
 * Build a {@link CodegraphEdge} from an `edges` row selected with the `edge_` column prefix that
 * {@link toNode} joins avoid colliding with.
 * @param row - the raw row carrying `edge_source`, `edge_target`, `edge_kind`, `edge_line`,
 * `edge_col`, and `edge_provenance`.
 * @returns the validated edge record.
 */
export function toEdge(row: NodeRow): CodegraphEdge {
  const what = 'a graph edge'
  const line = optionalInteger(row, 'edge_line', what)
  const column = optionalInteger(row, 'edge_col', what)
  const provenance = optionalText(row, 'edge_provenance', what)
  return {
    source: CodegraphNodeId(text(row, 'edge_source', what)),
    target: CodegraphNodeId(text(row, 'edge_target', what)),
    kind: text(row, 'edge_kind', what),
    ...line === undefined ? {} : { line },
    ...column === undefined ? {} : { column },
    ...provenance === undefined ? {} : { provenance },
  }
}

/**
 * Build a {@link CodegraphFile} from a `files` row.
 * @param row - the raw row, selected with every `files` column present.
 * @returns the validated file record.
 */
export function toFile(row: NodeRow): CodegraphFile {
  const path = text(row, 'path', 'an indexed file')
  const named = `indexed file "${path}"`
  return {
    path,
    language: text(row, 'language', named),
    size: integer(row, 'size', named),
    nodeCount: integer(row, 'node_count', named),
    modifiedAt: integer(row, 'modified_at', named),
    indexedAt: integer(row, 'indexed_at', named),
  }
}
