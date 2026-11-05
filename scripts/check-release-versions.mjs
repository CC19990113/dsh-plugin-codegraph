#!/usr/bin/env node
/**
 * Release version gate: one version for every package a release publishes.
 *
 * The shape of a release differs per repo, so nothing here is hardcoded: the
 * published packages are discovered
 *
 *   - JS packages      → `packages/<name>/package.json`
 *   - platform addons  → `crates/<crate>/npm/<target>/package.json`
 *   - addon holders    → any JS package whose `optionalDependencies` pins them
 *
 * and then one version has to agree across all of them plus the two generated
 * files a release so easily forgets:
 *
 *   - `pnpm-lock.yaml`, whose `optionalDependencies` specifiers are the pins the
 *     frozen-lockfile CI install resolves. An addon version can only enter the
 *     lockfile once it exists on the registry, so the release order is: bump,
 *     publish the addons, `pnpm install`, commit the lockfile.
 *   - `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`. pnpm 11 defaults
 *     `minimumReleaseAge` to 1440 minutes, so an addon published seconds ago is
 *     unresolvable until it is excluded; a stale list kills the release job
 *     *after* the addons are already published.
 *
 * A repo with no `crates/*​/npm` (a pure-TypeScript plugin) publishes only the JS
 * packages; the addon, lockfile-pin and exclude checks then simply do not apply.
 * That is a shape, not an exemption: if the repo has no addons, there is nothing
 * to pin.
 *
 * Deliberately dependency-free and YAML-parser-free: both generated files are
 * scanned line by line. A parser dependency inside a release gate is a worse
 * trade than a few dozen lines of regex, and the blocks read here are short and
 * fixed in shape.
 *
 * Usage: node scripts/check-release-versions.mjs
 * Exit 0 prints one line `ok <version>`; any mismatch prints every problem and
 * sets exit code 1.
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const LOCKFILE = 'pnpm-lock.yaml'
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'

const problems = []

function complain(message) {
  problems.push(message)
}

/** Directory names directly under `relativePath`, or [] when it does not exist. */
function childDirs(relativePath) {
  try {
    return readdirSync(join(REPO_ROOT, relativePath), { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => entry.name)
  } catch {
    return []
  }
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

/** One layer of matching YAML quotes stripped from a scalar. */
function unquote(value) {
  const quoted = /^(['"])(.*)\1$/.exec(value)
  return quoted === null ? value : quoted[2]
}

/** The `version` of one manifest, complained about when absent. */
function versionOf(relativePath, manifest) {
  if (manifest === undefined) return undefined
  if (typeof manifest.version !== 'string' || manifest.version.trim() === '') {
    complain(`${relativePath}: has no "version" string`)
    return undefined
  }
  return manifest.version
}

/**
 * The `minimumReleaseAgeExclude` block, parsed as `{name, version}` entries.
 * @returns the entries, or undefined when the file or the key cannot be read.
 */
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
      inBlock = false
      continue
    }

    const value = unquote(item[1].replace(/\s+#.*$/, '').trim())
    if (value === '') {
      complain(`${where}: empty "${EXCLUDE_KEY}" entry`)
      continue
    }
    const separator = value.lastIndexOf('@')
    if (separator <= 0 || separator === value.length - 1) {
      complain(`${where}: "${value}" is not shaped like "<package>@<version>"`)
      continue
    }
    entries.push({ name: value.slice(0, separator), version: value.slice(separator + 1) })
  }

  return foundKey ? entries : []
}

/**
 * The `specifier`s one lockfile importer records under `optionalDependencies`.
 * @param importer - the importer path as the lockfile spells it, e.g. `packages/native`.
 * @returns the map, or undefined when the lockfile or that importer cannot be read.
 */
function readLockfileOptionalSpecifiers(importer) {
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
      inImporter = indent === 2 && line.trim() === `${importer}:`
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
    complain(`${LOCKFILE}: has no importer for "${importer}"`)
    return undefined
  }
  if (!foundBlock) {
    complain(`${LOCKFILE}: importer "${importer}" has no optionalDependencies block`)
    return undefined
  }
  return specifiers
}

function main() {
  // --- the published JS packages: one shared version ------------------------
  const jsPackages = childDirs('packages')
    .filter(name => existsSync(join(REPO_ROOT, 'packages', name, 'package.json')))
    .map(name => ({ dir: `packages/${name}`, manifestPath: `packages/${name}/package.json` }))
    .map(entry => ({
      ...entry,
      manifest: readManifest(entry.manifestPath),
    }))

  if (jsPackages.length === 0) {
    complain('no JS package manifest was found under packages/*')
    process.exitCode = 1
    return
  }

  const jsVersions = new Map()
  for (const entry of jsPackages) {
    const version = versionOf(entry.manifestPath, entry.manifest)
    if (version !== undefined) jsVersions.set(entry.manifestPath, version)
  }

  // The first readable manifest sets the expected version, so one stray file is
  // reported by name instead of making every other file look wrong.
  const [baselinePath, expected] = jsVersions.entries().next().value ?? []

  if (expected === undefined) {
    complain('no JS package version could be read, so there is no expected release version')
  } else {
    for (const [manifestPath, version] of jsVersions) {
      if (manifestPath !== baselinePath && version !== expected) {
        complain(`${manifestPath}: version "${version}" does not match "${expected}" (from ${baselinePath})`)
      }
    }

    // --- the platform addons: same version as the JS packages ---------------
    const addons = new Map()
    for (const crate of childDirs('crates')) {
      const npmDir = `crates/${crate}/npm`
      for (const target of childDirs(npmDir)) {
        const manifestPath = `${npmDir}/${target}/package.json`
        if (!existsSync(join(REPO_ROOT, manifestPath))) continue
        const manifest = readManifest(manifestPath)
        const version = versionOf(manifestPath, manifest)
        if (manifest === undefined) continue

        const name = manifest.name
        if (typeof name !== 'string' || name === '') {
          complain(`${manifestPath}: has no "name" string`)
        } else if (addons.has(name)) {
          complain(`${manifestPath}: duplicate addon package name "${name}" (also ${addons.get(name)})`)
        } else {
          addons.set(name, { manifestPath })
        }

        if (version !== undefined && version !== expected) {
          complain(`${manifestPath}: version "${version}" does not match "${expected}"`)
        }
      }
    }

    // --- every holder pins exactly the addons, at the release version -------
    for (const entry of jsPackages) {
      const optionalDependencies = entry.manifest?.optionalDependencies
      if (optionalDependencies === null || typeof optionalDependencies !== 'object') continue

      const pinnedNames = Object.keys(optionalDependencies)
      const looksLikeHolder = pinnedNames.some(name => addons.has(name))
      if (!looksLikeHolder && addons.size > 0) continue

      if (looksLikeHolder) {
        for (const name of addons.keys()) {
          const pinned = optionalDependencies[name]
          if (pinned === undefined) {
            complain(`${entry.manifestPath}: optionalDependencies is missing "${name}"`)
          } else if (pinned !== expected) {
            complain(`${entry.manifestPath}: optionalDependencies["${name}"] is "${pinned}", must be "${expected}"`)
          }
        }
        for (const name of pinnedNames) {
          if (!addons.has(name)) {
            complain(`${entry.manifestPath}: optionalDependencies pins "${name}", which is not one of the platform packages`)
          }
        }

        // --- the lockfile records the same pins ------------------------------
        const locked = readLockfileOptionalSpecifiers(entry.dir)
        if (locked !== undefined) {
          for (const name of addons.keys()) {
            const pinned = locked.get(name)
            if (pinned === undefined) {
              complain(
                `${LOCKFILE}: importer "${entry.dir}" does not pin "${name}" — the manifest names a`
                + ' version the lockfile cannot resolve (publish the addons, then run pnpm install)',
              )
            } else if (pinned !== expected) {
              complain(
                `${LOCKFILE}: importer "${entry.dir}" pins "${name}@${pinned}", must be "${expected}"`
                + ' — regenerate the lockfile with pnpm install',
              )
            }
          }
          for (const [name, pinned] of locked) {
            if (!addons.has(name)) {
              complain(`${LOCKFILE}: importer "${entry.dir}" pins "${name}@${pinned}", which is not one of the platform packages`)
            }
          }
        }
      }
    }

    // --- pnpm-workspace.yaml excludes every addon at the new version --------
    if (addons.size > 0) {
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

        for (const name of addons.keys()) {
          const entry = excludedEntries.get(name)
          if (entry === undefined) {
            complain(
              `${WORKSPACE_FILE}: "${EXCLUDE_KEY}" is missing "${name}@${expected}" — a freshly published`
              + " addon stays unresolvable under pnpm 11's minimumReleaseAge",
            )
          } else if (entry.version !== expected) {
            complain(`${WORKSPACE_FILE}: "${EXCLUDE_KEY}" pins "${name}@${entry.version}", must be "${name}@${expected}"`)
          }
        }
        for (const [name, entry] of excludedEntries) {
          if (!addons.has(name)) {
            complain(`${WORKSPACE_FILE}: "${EXCLUDE_KEY}" lists "${name}@${entry.version}", which is not one of the platform packages`)
          }
        }
      }
    }
  }

  // --- the workspace root stays unpublished ---------------------------------
  const rootManifest = readManifest('package.json')
  if (rootManifest !== undefined && rootManifest.private !== true) {
    complain(
      'package.json: the workspace root must stay "private": true — it is not a published package'
      + ' and carries no release version',
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
