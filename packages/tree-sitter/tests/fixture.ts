// Real source trees on disk, written to a temp directory: every test exercises the actual
// tree-sitter grammars and the actual filesystem walk, so a grammar version bump that renames a node
// type fails a test instead of quietly emptying the graph.
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Write a project directory holding the given files.
 * @param files - project-relative path to file content.
 * @returns the absolute project root.
 */
export async function writeProject(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-codegraph-tree-sitter-'))
  for (const [path, content] of Object.entries(files)) {
    const absolute = join(root, path)
    await mkdir(join(absolute, '..'), { recursive: true })
    await writeFile(absolute, content)
  }
  return root
}
