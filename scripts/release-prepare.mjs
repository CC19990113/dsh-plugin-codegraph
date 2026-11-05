#!/usr/bin/env node
/**
 * First half of a release: bump every published manifest and the exclude list.
 *
 * A lockstep release touches more files than a hand bump reliably gets right,
 * and the two files it is easiest to miss are also the two that only fail at the
 * very end of a release job:
 *
 *   - `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude`. pnpm 11 keeps a
 *     freshly published package unresolvable for 1440 minutes unless it is
 *     excluded, so a missing line makes `pnpm install` fail *after* the platform
 *     addons are already on the registry.
 *   - `pnpm-lock.yaml`. `ci.yml` installs with `--frozen-lockfile`, so a manifest
 *     bumped without a regenerated lockfile fails every CI run with
 *     `ERR_PNPM_OUTDATED_LOCKFILE`.
 *
 * This script deliberately does **not** touch the lockfile: an addon version can
 * only enter it once that version exists on the registry, so the lockfile cannot
 * be regenerated before the addons are published. That is what
 * `release-finish.mjs` is for, and why the release is two commands rather than
 * one.
 *
 * Everything it edits is discovered, not hardcoded:
 *
 *   - `packages/<name>/package.json`            → the `version` field
 *   - `crates/<crate>/npm/<target>/package.json` → the `version` field
 *   - any `packages/<name>/package.json` whose `optionalDependencies` pins one of
 *     those addons                            → the pin for each addon
 *   - `pnpm-workspace.yaml`'s `minimumReleaseAgeExclude` → one entry per addon
 *
 * A repo with no `crates/<crate>/npm` publishes only JS packages; the addon and
 * exclude steps then simply have nothing to do.
 *
 * Usage:
 *   node scripts/release-prepare.mjs <version> [--dry-run]
 *
 * Exit 0 prints what changed (or would change, under `--dry-run`);
 * exit 1 prints every problem and changes nothing.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WORKSPACE_FILE = 'pnpm-workspace.yaml'
const EXCLUDE_KEY = 'minimumReleaseAgeExclude'

const problems = []
const changes = []

function complain(message) {
  problems.push(message)
}

function fail(message) {
  console.error(`release prepare failed: ${message}`)
  process.exitCode = 1
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

function readText(relativePath) {
  try {
    return readFileSync(join(REPO_ROOT, relativePath), 'utf8')
  } catch (error) {
    complain(`${relativePath}: cannot be read (${error.code ?? error.message})`)
    return undefined
  }
}

function readManifest(relativePath) {
  const text = readText(relativePath)
  if (text === undefined) return undefined
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

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/

/**
 * Compare two plain `x.y.z` versions. A pre-release suffix is compared as text,
 * which is enough here: this gate only needs "the new version must be greater".
 * @returns a negative number, zero, or a positive number.
 */
function compareVersions(left, right) {
  const parse = value => value.split('-')[0].split('.').map(Number)
  const a = parse(left)
  const b = parse(right)
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] - b[index]
  }
  const leftPre = left.includes('-') ? left.slice(left.indexOf('-')) : ''
  const rightPre = right.includes('-') ? right.slice(right.indexOf('-')) : ''
  if (leftPre === rightPre) return 0
  // A version without a pre-release suffix is greater than the same version with one.
  if (leftPre === '') return 1
  if (rightPre === '') return -1
  return leftPre < rightPre ? -1 : 1
}

/** The `minimumReleaseAgeExclude` block, parsed as `{name, version}` entries. */
function readExcludeList() {
  const text = readText(WORKSPACE_FILE)
  if (text === undefined) return undefined

  const entries = []
  let foundKey = false
  let inBlock = false
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const where = `${WORKSPACE_FILE}:${index + 1}`
    if (line.trim() === '' || line.trimStart().startsWith('#')) continue
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
    let value = item[1].replace(/\s+#.*$/, '').trim()
    const quoted = /^(['"])(.*)\1$/.exec(value)
    if (quoted !== null) value = quoted[2]
    const separator = value.lastIndexOf('@')
    if (separator <= 0 || separator === value.length - 1) {
      complain(`${where}: "${value}" is not shaped like "<package>@<version>"`)
      continue
    }
    entries.push({ name: value.slice(0, separator), version: value.slice(separator + 1) })
  }

  return foundKey ? entries : undefined
}

/**
 * Rewrite the `minimumReleaseAgeExclude` block to hold exactly `entries`,
 * leaving every other line of the file byte-identical.
 * @returns the new file text, or undefined when the block shape is not recognised.
 */
function rewriteExcludeBlock(text, entries) {
  const lines = text.split(/\r?\n/)
  const blockLines = entries.map(entry => `  - ${entry}`)

  let start = -1
  let end = -1
  for (const [index, line] of lines.entries()) {
    if (/^[A-Za-z0-9_-]+\s*:/.test(line) && line.split(':')[0].trim() === EXCLUDE_KEY) {
      start = index
      end = index + 1
      while (end < lines.length && (/^\s/.test(lines[end]) || lines[end].trim() === '')) {
        // A blank line only belongs to the block while another list item follows it.
        if (lines[end].trim() === '' && !/^\s*-\s+/.test(lines[end + 1] ?? '')) break
        end += 1
      }
      break
    }
  }

  if (start === -1) return undefined
  return [...lines.slice(0, start + 1), ...blockLines, ...lines.slice(end)].join('\n')
}

function main() {
  const args = process.argv.slice(2)
  const dryRun = args.includes('--dry-run')
  const version = args.find(argument => !argument.startsWith('--'))

  if (version === undefined) {
    fail('pass the release version, e.g. `node scripts/release-prepare.mjs 0.6.2 --dry-run`')
    return
  }
  if (!SEMVER.test(version)) {
    fail(`"${version}" is not a plain \`x.y.z\` version`)
    return
  }

  // --- the published JS packages -------------------------------------------
  const jsPackages = childDirs('packages')
    .filter(name => existsSync(join(REPO_ROOT, 'packages', name, 'package.json')))
    .map(name => {
      const manifestPath = `packages/${name}/package.json`
      return { dir: `packages/${name}`, manifestPath, manifest: readManifest(manifestPath) }
    })
    .filter(entry => entry.manifest !== undefined)

  if (jsPackages.length === 0) {
    fail('no JS package manifest was found under packages/*')
    return
  }

  const currentVersions = jsPackages
    .map(entry => entry.manifest.version)
    .filter(candidate => typeof candidate === 'string')
  const current = currentVersions[0]
  if (current === undefined) {
    fail('no JS package records a version, so there is no current release to bump')
    return
  }
  for (const entry of jsPackages) {
    if (entry.manifest.version !== current) {
      complain(
        `${entry.manifestPath}: version "${entry.manifest.version}" already disagrees with`
        + ` "${current}" — run check:versions and settle on one version first`,
      )
    }
  }
  if (problems.length > 0) {
    for (const problem of problems) console.error(`  - ${problem}`)
    fail('the working tree is not on one version, so bumping it would hide the drift')
    return
  }

  const direction = compareVersions(version, current)
  if (direction === 0) {
    fail(`"${version}" is already the current version`)
    return
  }
  if (direction < 0) {
    fail(`"${version}" is lower than the current "${current}"`)
    return
  }

  for (const entry of jsPackages) {
    changes.push({ path: entry.manifestPath, what: `version ${current} → ${version}` })
  }

  // --- the platform addons -------------------------------------------------
  const addons = new Map()
  for (const crate of childDirs('crates')) {
    const npmDir = `crates/${crate}/npm`
    for (const target of childDirs(npmDir)) {
      const manifestPath = `${npmDir}/${target}/package.json`
      if (!existsSync(join(REPO_ROOT, manifestPath))) continue
      const manifest = readManifest(manifestPath)
      if (manifest === undefined) continue
      if (manifest.version !== current) {
        complain(`${manifestPath}: version "${manifest.version}" disagrees with "${current}"`)
      }
      if (typeof manifest.name !== 'string' || manifest.name === '') {
        complain(`${manifestPath}: has no "name" string`)
        continue
      }
      addons.set(manifest.name, manifestPath)
      changes.push({ path: manifestPath, what: `version ${current} → ${version}` })
    }
  }

  // --- the manifests that pin those addons ---------------------------------
  for (const entry of jsPackages) {
    const optionalDependencies = entry.manifest.optionalDependencies
    if (optionalDependencies === null || typeof optionalDependencies !== 'object') continue
    const pinned = Object.keys(optionalDependencies).filter(name => addons.has(name))
    if (pinned.length === 0) continue

    const missing = [...addons.keys()].filter(name => !(name in optionalDependencies))
    for (const name of missing) {
      complain(`${entry.manifestPath}: optionalDependencies is missing "${name}"`)
    }
    for (const name of Object.keys(optionalDependencies)) {
      if (name.startsWith('dsh-') && !addons.has(name)) {
        complain(`${entry.manifestPath}: optionalDependencies pins "${name}", which has no addon manifest`)
      }
    }
    for (const name of pinned) {
      changes.push({ path: entry.manifestPath, what: `optionalDependencies["${name}"] → ${version}` })
    }
  }

  if (addons.size > 0) {
    const excluded = readExcludeList()
    if (excluded !== undefined) {
      const desired = [...addons.keys()].map(name => `${name}@${version}`)
      const actual = excluded.map(entry => `${entry.name}@${entry.version}`)
      const sameSet = desired.length === actual.length && desired.every(item => actual.includes(item))
      changes.push({
        path: WORKSPACE_FILE,
        what: sameSet
          ? `"${EXCLUDE_KEY}" already lists every addon at ${version}`
          : `"${EXCLUDE_KEY}" → ${String(desired.length)} entries at ${version}`,
      })
    }
  }

  if (problems.length > 0) {
    console.error(`release prepare failed with ${problems.length} problem(s):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exitCode = 1
    return
  }

  // --- apply ----------------------------------------------------------------
  const notes = []
  if (!dryRun) {
    for (const entry of jsPackages) {
      entry.manifest.version = version
      writeFileSync(join(REPO_ROOT, entry.manifestPath), `${JSON.stringify(entry.manifest, null, 2)}\n`)
    }
    for (const [name, manifestPath] of addons) {
      const manifest = readManifest(manifestPath)
      if (manifest === undefined) continue
      manifest.version = version
      writeFileSync(join(REPO_ROOT, manifestPath), `${JSON.stringify(manifest, null, 2)}\n`)
      notes.push(`${name}@${version}`)
    }
    for (const entry of jsPackages) {
      const optionalDependencies = entry.manifest.optionalDependencies
      if (optionalDependencies === null || typeof optionalDependencies !== 'object') continue
      let touched = false
      for (const name of Object.keys(optionalDependencies)) {
        if (!addons.has(name)) continue
        optionalDependencies[name] = version
        touched = true
      }
      if (touched) {
        writeFileSync(join(REPO_ROOT, entry.manifestPath), `${JSON.stringify(entry.manifest, null, 2)}\n`)
      }
    }
    if (addons.size > 0) {
      const text = readText(WORKSPACE_FILE)
      if (text !== undefined) {
        const rewritten = rewriteExcludeBlock(text, [...addons.keys()].map(name => `${name}@${version}`))
        if (rewritten === undefined) {
          console.error(`${WORKSPACE_FILE}: "${EXCLUDE_KEY}" block is not shaped like a flat list; add the entries by hand`)
        } else {
          writeFileSync(join(REPO_ROOT, WORKSPACE_FILE), rewritten)
        }
      }
    }
  }

  console.log(`release ${current} → ${version}${dryRun ? ' (dry run, nothing written)' : ''}`)
  for (const change of changes) console.log(`  ${change.path}: ${change.what}`)
  console.log()
  console.log('Next:')
  console.log('  1. git commit -am "chore(release): ' + version + '"')
  console.log('  2. git tag v' + version + ' && git push --tags   # CI publishes the addons first')
  console.log('  3. wait for the addons to finish publishing, then run: pnpm run release:finish')
}

main()
