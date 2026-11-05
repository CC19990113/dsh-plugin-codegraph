#!/usr/bin/env node
/**
 * Release version gate for the lockstep codegraph release.
 *
 * One release version has to land in five different kinds of file, which makes
 * a half-finished bump easy:
 *
 *   - the six `packages/*` manifests (published together, one version)
 *   - the five platform addon manifests under `crates/indexer-rust/npm/*`
 *   - `packages/tree-sitter/package.json`'s optionalDependencies (one per addon)
 *   - `pnpm-workspace.yaml`'s minimumReleaseAgeExclude (one per addon)
 *   - `pnpm-lock.yaml`'s `packages/tree-sitter` importer, which records the pins
 *
 * The exclude list is one trap. pnpm 11 defaults `minimumReleaseAge` to 1440
 * minutes, so an addon published seconds ago is not resolvable; the exclude
 * list is what opens that window. If it still pins the previous version, the
 * release job dies in `pnpm install --no-frozen-lockfile` *after* the addons
 * are already published.
 *
 * The lockfile is the other trap, and the one CI hits first: `.github/workflows/
 * ci.yml` installs with `--frozen-lockfile`, so a manifest bumped without a
 * regenerated lockfile fails every run with `ERR_PNPM_OUTDATED_LOCKFILE` before
 * any test starts. An addon version can only enter the lockfile once it exists
 * on the registry, so the order for a release is: bump, publish the addons,
 * run `pnpm install`, commit the lockfile.
 *
 * Deliberately dependency-free (node:fs / node:path only) and YAML-parser-free:
 * pnpm-workspace.yaml is scanned line by line, because the file is a short
 * fixed-shape block list and a parser dependency in a release gate is a worse
 * trade than a dozen lines of regex.
 *
 * The workspace root is read only to keep it "private": true — it is not a
 * published package and carries no release version, so tying it to the lockstep
 * version would be wrong.
 *
 * The exclude list must name exactly the five addon packages, all at the new
 * version. One line missing leaves a freshly published addon unresolvable; one
 * line left behind points at a version that no longer exists; one extra line
 * drags an unintended package past the age gate. All three are release bugs, so
 * the set is matched exactly rather than by prefix — if a future exclusion is
 * genuinely intended, extend the expected set here deliberately.
 *
 * Usage: node scripts/check-release-versions.mjs
 * Exit 0 prints one line `ok <version>`; any mismatch prints every problem and
 * exits 1.
 */

import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Published together, in lockstep: one version for all six. */
const JS_PACKAGES = [
  'packages/bundle',
  'packages/panel',
  'packages/service',
  'packages/sqlite',
  'packages/tool',
  'packages/tree-sitter',
]

/** The native addons, one npm package per target triple. */
const PLATFORM_PACKAGES = [
  'crates/indexer-rust/npm/darwin-arm64',
  'crates/indexer-rust/npm/darwin-x64',
  'crates/indexer-rust/npm/linux-arm64-gnu',
  'crates/indexer-rust/npm/linux-x64-gnu',
  'crates/indexer-rust/npm/win32-x64-msvc',
]

const ADDON_PREFIX = 'dsh-plugin-codegraph-indexer-'
const TREE_SITTER_MANIFEST = 'packages/tree-sitter/package.json'
const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'
const LOCKFILE = 'pnpm-lock.yaml'
/** The lockfile importer block that pins the platform addons. */
const LOCKFILE_IMPORTER = 'packages/tree-sitter'

const problems = []

function complain(message) {
  problems.push(message)
}

function readManifest(relativePath) {
  let text
  try {
    text = readFileSync(join(REPO_ROOT, relativePath), 'utf8')
  } catch (error) {
    complain(`${relativePath}: cannot be read (${error.code ?? error.message})`)
    return undefined
  }
  try {
    const manifest = JSON.parse(text)
    if (manifest === null || typeof manifest !== 'object' || Array.isArray(manifest)) {
      complain(`${relativePath}: expected a JSON object at the top level`)
      return undefined
    }
    return manifest
  } catch (error) {
    complain(`${relativePath}: invalid JSON (${error.message})`)
    return undefined
  }
}

function versionOf(relativePath, manifest) {
  if (manifest === undefined) return undefined
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    complain(`${relativePath}: has no "version" string`)
    return undefined
  }
  return manifest.version
}

function parseExcludeItem(rawValue, where) {
  let value = rawValue.replace(/\s+#.*$/, '').trim()
  const quoted = /^(['"])(.*)\1$/.exec(value)
  if (quoted !== null) value = quoted[2]
  if (value === '') {
    complain(`${where}: empty "${EXCLUDE_KEY}" entry`)
    return undefined
  }
  const separator = value.lastIndexOf('@')
  if (separator <= 0 || separator === value.length - 1) {
    complain(`${where}: "${value}" is not shaped like "<package>@<version>"`)
    return undefined
  }
  return { name: value.slice(0, separator), version: value.slice(separator + 1) }
}

function readExcludeList() {
  let text
  try {
    text = readFileSync(join(REPO_ROOT, WORKSPACE_FILE), 'utf8')
  } catch (error) {
    complain(`${WORKSPACE_FILE}: cannot be read (${error.code ?? error.message})`)
    return undefined
  }

  const entries = []
  let foundKey = false
  let inBlock = false

  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const where = `${WORKSPACE_FILE}:${index + 1}`
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue

    // An unindented line is a top-level key, which always ends the current block.
    if (!/^\s/.test(line)) {
      inBlock = false
      const header = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line)
      if (header === null || header[1] !== EXCLUDE_KEY) continue
      foundKey = true
      if (header[2].trim() !== '') {
        complain(`${where}: "${EXCLUDE_KEY}" must be a block list, not an inline value`)
        continue
      }
      inBlock = true
      continue
    }

    if (!inBlock) continue

    const item = /^\s*-\s+(.*)$/.exec(line)
    if (item === null) {
      // Indented content that is not a list item (e.g. a nested key) ends the block.
      inBlock = false
      continue
    }

    const entry = parseExcludeItem(item[1], where)
    if (entry !== undefined) entries.push(entry)
  }

  if (!foundKey) {
    complain(`${WORKSPACE_FILE}: has no "${EXCLUDE_KEY}" key`)
    return undefined
  }
  return entries
}

/** Strip one layer of matching YAML quotes from a scalar. */
function unquote(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted === null ? value : quoted[2]
}

/**
 * The `specifier`s the lockfile records in `packages/tree-sitter`'s
 * `optionalDependencies` block, keyed by package name.
 *
 * Scanned line by line like the workspace file: the lockfile is generated, and
 * this gate only needs one indented block of it. A missing importer or block is
 * a problem rather than "no pins", because the manifest always pins the addons.
 * @returns the recorded specifiers, or undefined when the block cannot be read.
 */
function readLockfileOptionalSpecifiers() {
  let text
  try {
    text = readFileSync(join(REPO_ROOT, LOCKFILE), 'utf8')
  } catch (error) {
    complain(`${LOCKFILE}: cannot be read (${error.code ?? error.message})`)
    return undefined
  }

  const specifiers = new Map()
  let foundImporter = false
  let foundBlock = false
  let inImporter = false
  let inOptional = false
  let currentName

  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === '') continue
    const indent = /^ */.exec(line)[0].length
    // Importers are the only keys at two spaces; anything shallower ends the section.
    if (indent <= 2) {
      inImporter = indent === 2 && line.trim() === `${LOCKFILE_IMPORTER}:`
      if (inImporter) foundImporter = true
      inOptional = false
      currentName = undefined
      continue
    }
    if (!inImporter) continue
    if (indent === 4) {
      inOptional = /^ {4}optionalDependencies:\s*$/.test(line)
      if (inOptional) foundBlock = true
      currentName = undefined
      continue
    }
    if (!inOptional) continue
    if (indent === 6) {
      const entry = /^ {6}(.+):\s*$/.exec(line)
      currentName = entry === null ? undefined : unquote(entry[1].trim())
      continue
    }
    if (indent === 8 && currentName !== undefined) {
      const entry = /^ {8}specifier:\s*(.*)$/.exec(line)
      if (entry !== null) {
        specifiers.set(currentName, unquote(entry[1].trim()))
        currentName = undefined
      }
    }
  }

  if (!foundImporter) {
    complain(`${LOCKFILE}: has no importer for "${LOCKFILE_IMPORTER}"`)
    return undefined
  }
  if (!foundBlock) {
    complain(`${LOCKFILE}: importer "${LOCKFILE_IMPORTER}" has no optionalDependencies block`)
    return undefined
  }
  return specifiers
}

function main() {
  // --- the six JS packages: one shared version ------------------------------
  const jsVersions = new Map()
  for (const dir of JS_PACKAGES) {
    const manifestPath = `${dir}/package.json`
    const version = versionOf(manifestPath, readManifest(manifestPath))
    if (version !== undefined) jsVersions.set(manifestPath, version)
  }

  // The first readable manifest sets the expected version, so a single stray
  // manifest is reported by name instead of making every other file look wrong.
  const [baselinePath, expected] = jsVersions.entries().next().value ?? []

  if (expected === undefined) {
    complain('no JS package version could be read, so there is no expected release version')
  } else {
    for (const [manifestPath, version] of jsVersions) {
      if (manifestPath !== baselinePath && version !== expected) {
        complain(`${manifestPath}: version "${version}" does not match "${expected}" (from ${baselinePath})`)
      }
    }

    // --- the five platform addons: same version as the JS packages ----------
    const addonManifestPaths = new Map()
    for (const dir of PLATFORM_PACKAGES) {
      const manifestPath = `${dir}/package.json`
      const manifest = readManifest(manifestPath)
      const version = versionOf(manifestPath, manifest)
      if (manifest === undefined) continue

      const name = manifest.name
      if (typeof name !== 'string' || name === '') {
        complain(`${manifestPath}: has no "name" string`)
      } else if (!name.startsWith(ADDON_PREFIX)) {
        complain(`${manifestPath}: package name "${name}" does not start with "${ADDON_PREFIX}"`)
      } else if (addonManifestPaths.has(name)) {
        complain(`${manifestPath}: duplicate addon package name "${name}" (also ${addonManifestPaths.get(name)})`)
      } else {
        addonManifestPaths.set(name, manifestPath)
      }

      if (version !== undefined && version !== expected) {
        complain(`${manifestPath}: version "${version}" does not match "${expected}"`)
      }
    }

    if (addonManifestPaths.size === 0) {
      complain('no platform addon package name could be read')
    }

    // --- tree-sitter's optionalDependencies pin every addon -----------------
    const treeSitterPath = TREE_SITTER_MANIFEST
    const treeSitter = readManifest(treeSitterPath)
    if (treeSitter !== undefined) {
      const optionalDependencies = treeSitter.optionalDependencies
      if (
        optionalDependencies === null ||
        typeof optionalDependencies !== 'object' ||
        Array.isArray(optionalDependencies)
      ) {
        complain(`${treeSitterPath}: has no "optionalDependencies" object`)
      } else {
        for (const name of addonManifestPaths.keys()) {
          const pinned = optionalDependencies[name]
          if (pinned === undefined) {
            complain(`${treeSitterPath}: optionalDependencies is missing "${name}"`)
          } else if (pinned !== expected) {
            complain(
              `${treeSitterPath}: optionalDependencies["${name}"] is "${pinned}", must be "${expected}"`,
            )
          }
        }
        for (const key of Object.keys(optionalDependencies)) {
          if (key.startsWith(ADDON_PREFIX) && !addonManifestPaths.has(key)) {
            complain(
              `${treeSitterPath}: optionalDependencies pins "${key}", which is not one of the platform packages`,
            )
          }
        }
      }
    }

    // --- the lockfile records the same addon pins --------------------------
    const locked = readLockfileOptionalSpecifiers()
    if (locked !== undefined) {
      for (const name of addonManifestPaths.keys()) {
        const pinned = locked.get(name)
        if (pinned === undefined) {
          complain(
            `${LOCKFILE}: importer "${LOCKFILE_IMPORTER}" does not pin "${name}" — the manifest names a version the lockfile cannot resolve (publish the addons, then run pnpm install)`,
          )
        } else if (pinned !== expected) {
          complain(
            `${LOCKFILE}: importer "${LOCKFILE_IMPORTER}" pins "${name}@${pinned}", must be "${expected}" — regenerate the lockfile with pnpm install`,
          )
        }
      }
      for (const [name, pinned] of locked) {
        if (!addonManifestPaths.has(name)) {
          complain(
            `${LOCKFILE}: importer "${LOCKFILE_IMPORTER}" pins "${name}@${pinned}", which is not one of the platform packages`,
          )
        }
      }
    }

    // --- pnpm-workspace.yaml excludes every addon at the new version --------
    const excluded = readExcludeList()
    if (excluded !== undefined) {
      const excludedEntries = new Map()
      for (const entry of excluded) {
        if (excludedEntries.has(entry.name)) {
          complain(`${WORKSPACE_FILE}: "${EXCLUDE_KEY}" lists "${entry.name}" more than once`)
          continue
        }
        excludedEntries.set(entry.name, entry)
      }

      for (const name of addonManifestPaths.keys()) {
        const entry = excludedEntries.get(name)
        if (entry === undefined) {
          complain(
            `${WORKSPACE_FILE}: "${EXCLUDE_KEY}" is missing "${name}@${expected}" — a freshly published addon stays unresolvable under pnpm 11's minimumReleaseAge`,
          )
        } else if (entry.version !== expected) {
          complain(
            `${WORKSPACE_FILE}: "${EXCLUDE_KEY}" pins "${name}@${entry.version}", must be "${name}@${expected}"`,
          )
        }
      }

      for (const [name, entry] of excludedEntries) {
        if (!addonManifestPaths.has(name)) {
          complain(
            `${WORKSPACE_FILE}: "${EXCLUDE_KEY}" lists "${name}@${entry.version}", which is not one of the platform packages`,
          )
        }
      }
    }
  }

  // --- the workspace root stays unpublished ---------------------------------
  const rootManifest = readManifest('package.json')
  if (rootManifest !== undefined && rootManifest.private !== true) {
    complain(
      'package.json: the workspace root must stay "private": true — it is not a published package and carries no release version',
    )
  }

  if (problems.length > 0) {
    console.error(`release version check failed with ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    // Set the code instead of calling process.exit(): stdout/stderr are pipes in
    // CI, and an immediate exit can drop the buffered report that says why.
    process.exitCode = 1
    return
  }

  console.log(`ok ${expected}`)
}

main()
