// 26.2 / 26.3 protocol compatibility layer for mineflayer.
//
// The published mineflayer 4.39.0 release only declares Minecraft 1.8.8 -26.1
// as tested. The upstream PR stack for 26.2/26.3 is vendored in
// `vendor/upstream-26.3/` and installed *idempotently* into this plugin's
// `node_modules/` the first time this module is loaded -before any package is
// required by mineflayer / minecraft-protocol, so their static requires always
// see the patched files.
//
// Everything this module exports is safe to import directly:
//
//   import {
//     mineflayer, minecraftData, minecraftProtocol,
//     installUpstreamCompat, upstreamCompatStatus,
//     syncFutureVersionProtocol, EMULATED_VERSIONS, FUTURE_VERSIONS
//   } from './protocol-compat.js'
//
// What the install step does (all file writes are idempotent, Node fs only, no
// BOM, no shell/PowerShell involved):
//   1. copy the four vendored PR packages over `node_modules/<pkg>` when the
//      installed copy differs (original package backed up once to
//      `node_modules/.dsh-upstream-bak-<pkg>`);
//   2. install the 26.2/26.3 minecraft-data json files, the `features.json`,
//      data.js getters and the `versions` / `protocolVersions` list entries;
//   3. create the best-effort 26.4 alias (26.3 data + 26.4 version.json) unless
//      real 26.4 data already exists;
//   4. widen the in-memory mineflayer version window: `testedVersions` gets
//      26.2 / 26.3 / a synthetic `999.0` upper bound, `latestSupportedVersion`
//      becomes `999.0` so no real (or future) server version is rejected by the
//      "latest supported version" gate; `oldestSupportedVersion` stays 1.8.8;
//   5. write the idempotency marker `node_modules/.dsh-upstream-compat.json`.

import { createHash } from 'node:crypto'
import {
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync
} from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = path.resolve(MODULE_DIR, '..')
const VENDOR_DIR = path.join(PLUGIN_DIR, 'vendor', 'upstream-26.3')
const VENDOR_VERSION = 'upstream-26.3.2'
const MARKER_NAME = '.dsh-upstream-compat.json'

/** Minecraft versions emulated by the vendored upstream PR stack. */
export const EMULATED_VERSIONS = ['26.2', '26.3']
/** Future/unreleased versions mapped onto the newest emulated data (best effort). */
export const FUTURE_VERSIONS = ['26.4']
/** Synthetic version that floats above every real Minecraft version. */
export const SYNTHETIC_UPPER_BOUND = '999.0'

const SYNTHETIC_DATA_VERSION = 1000000000
const FUTURE_DATA_VERSION = 9000000
const MERGED_DATA_VERSIONS = [...EMULATED_VERSIONS, ...FUTURE_VERSIONS]

const PROTOCOL_VERSIONS = { '26.2': 776, '26.3': 777, '26.4': 777 }
const RELEASE_DATA_VERSIONS = { '26.2': 4903, '26.3': 5023, '26.4': FUTURE_DATA_VERSION }

const FUTURE_ALIAS_IMAGE = EMULATED_VERSIONS[EMULATED_VERSIONS.length - 1] // '26.3'

// name ->vendored sub-directory. `main` files (relative to the package root) are
// listed in the vendor README; the installer compares the whole vendored tree.
const PACKAGES = [
  { name: 'minecraft-protocol', dir: 'minecraft-protocol' },
  { name: 'mineflayer', dir: 'mineflayer' },
  { name: 'prismarine-chunk', dir: 'prismarine-chunk' },
  { name: 'prismarine-physics', dir: 'prismarine-physics' }
]

// Candidate fallbacks for data files the PR's dataPaths.json maps to a
// directory the published minecraft-data package de-duplicated away. The first
// installed version that actually ships the file wins.
const DATA_FILE_CANDIDATES = ['1.16.1', '1.20.2', '1.20.3', '1.20.4', '1.20.5', '1.20.6', '1.21', '1.21.1', '1.21.3', '1.21.4', '1.21.5', '1.21.6', '1.21.8', '1.21.9', '1.21.11', '26.1']

const state = {
  installCount: 0,
  lastInstall: null,
  installError: null,
  /** protocol overrides applied through syncFutureVersionProtocol(version, protocol) */
  futureProtocolOverrides: {},
  paths: {
    pluginDir: PLUGIN_DIR,
    vendorDir: VENDOR_DIR,
    nodeModulesDir: null,
    minecraftData: null,
    markerFile: null
  }
}

// ---------------------------------------------------------------------------
// small fs helpers
// ---------------------------------------------------------------------------

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function walkFiles(root, rel = '') {
  const out = []
  const dir = rel ? path.join(root, rel) : root
  let entries
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const childRel = rel ? path.join(rel, entry.name) : entry.name
    if (entry.isDirectory()) out.push(...walkFiles(root, childRel))
    else if (entry.isFile()) out.push(childRel)
  }
  return out
}

function readJsonSafe(file) {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function writeTextFile(file, content) {
  mkdirSync(path.dirname(file), { recursive: true })
  // Node writes UTF-8 without a byte order mark; never use PowerShell for this.
  writeFileSync(file, content, 'utf8')
}

function sameFile(a, b) {
  if (!existsSync(a) || !existsSync(b)) return false
  try {
    if (statSync(a).size !== statSync(b).size) return false
    return sha256(a) === sha256(b)
  } catch {
    return false
  }
}

function treeMatches(srcDir, dstDir) {
  if (!existsSync(dstDir) || !statSync(dstDir).isDirectory()) {
    return { equal: false, reason: 'missing-target' }
  }
  const files = walkFiles(srcDir)
  if (files.length === 0) return { equal: false, reason: 'empty-vendor-package' }
  for (const rel of files) {
    if (!sameFile(path.join(srcDir, rel), path.join(dstDir, rel))) {
      return { equal: false, reason: `differs:${rel.split(path.sep).join('/')}` }
    }
  }
  return { equal: true, files: files.length }
}

function copyTree(srcDir, dstDir) {
  mkdirSync(path.dirname(dstDir), { recursive: true })
  cpSync(srcDir, dstDir, { recursive: true, force: true })
}

function tryResolvePackageDir(name) {
  try {
    return path.dirname(require.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

function resolveNodeModulesDir() {
  for (const probe of ['minecraft-data', 'mineflayer', 'minecraft-protocol']) {
    const dir = tryResolvePackageDir(probe)
    if (dir) return path.dirname(dir)
  }
  return path.join(PLUGIN_DIR, 'node_modules')
}

function readPackageVersion(packageDir) {
  const pkg = readJsonSafe(path.join(packageDir, 'package.json'))
  return pkg ? pkg.version : null
}

// ---------------------------------------------------------------------------
// minecraft-data helpers
// ---------------------------------------------------------------------------

function resolveMinecraftDataPaths(nodeModulesDir) {
  const packageDir = tryResolvePackageDir('minecraft-data') || path.join(nodeModulesDir, 'minecraft-data')
  return {
    packageDir,
    packageVersion: readPackageVersion(packageDir),
    dataJs: path.join(packageDir, 'data.js'),
    pcDataRoot: path.join(packageDir, 'minecraft-data', 'data', 'pc'),
    commonDir: path.join(packageDir, 'minecraft-data', 'data', 'pc', 'common')
  }
}

function vendorDataDir(version) {
  return path.join(VENDOR_DIR, 'minecraft-data-extra', 'pc', version)
}

/** install (or refresh) one real minecraft-data version directory from the vendor payload */
function installDataVersion(paths, version) {
  const srcDir = vendorDataDir(version)
  if (!existsSync(srcDir)) throw new Error(`protocol-compat: vendored minecraft-data for ${version} is missing (${srcDir})`)
  const dstDir = path.join(paths.pcDataRoot, version)
  let copied = 0
  for (const rel of walkFiles(srcDir)) {
    const dst = path.join(dstDir, rel)
    if (sameFile(path.join(srcDir, rel), dst)) continue
    mkdirSync(path.dirname(dst), { recursive: true })
    copyFileSync(path.join(srcDir, rel), dst)
    copied++
  }
  return copied
}

function futureVersionJson(version) {
  return {
    version: PROTOCOL_VERSIONS[version],
    minecraftVersion: version,
    majorVersion: FUTURE_ALIAS_IMAGE,
    releaseType: 'release'
  }
}

/**
 * Best-effort future alias: copy the newest emulated data directory and relabel
 * its version.json. Only version/protocol metadata changes; packet schemas stay
 * those of the emulated release (26.3). When real data for the future version
 * already exists in minecraft-data it is left untouched.
 */
function installFutureAlias(paths, version) {
  const imageRoot = path.join(paths.pcDataRoot, FUTURE_ALIAS_IMAGE)
  if (!existsSync(imageRoot)) throw new Error(`protocol-compat: cannot create ${version} alias, ${FUTURE_ALIAS_IMAGE} data missing (${imageRoot})`)
  const dstRoot = path.join(paths.pcDataRoot, version)
  const aliasMarker = path.join(dstRoot, '.dsh-future-alias.json')
  if (existsSync(dstRoot) && !existsSync(aliasMarker)) {
    // not created by us: if it looks like genuine upstream data for this version,
    // never overwrite it with the alias
    const existing = readJsonSafe(path.join(dstRoot, 'version.json'))
    if (existing && existing.minecraftVersion === version && existing.majorVersion !== FUTURE_ALIAS_IMAGE) {
      return { copiedFiles: 0, realData: true }
    }
  }
  let copied = 0
  for (const rel of walkFiles(imageRoot)) {
    // version.json is relabelled below; the future alias marker is not copied
    if (rel === 'version.json' || rel === '.dsh-future-alias.json') continue
    const dst = path.join(dstRoot, rel)
    if (sameFile(path.join(imageRoot, rel), dst)) continue
    mkdirSync(path.dirname(dst), { recursive: true })
    copyFileSync(path.join(imageRoot, rel), dst)
    copied++
  }
  const versionFile = path.join(dstRoot, 'version.json')
  const expected = futureVersionJson(version)
  const current = readJsonSafe(versionFile)
  const sameVersionJson = current &&
    current.version === expected.version &&
    current.minecraftVersion === expected.minecraftVersion &&
    current.majorVersion === expected.majorVersion &&
    current.releaseType === expected.releaseType
  if (!sameVersionJson) {
    // keep the file formatting of the real data files (compact JSON + newline)
    writeTextFile(versionFile, `${JSON.stringify(expected)}\n`)
    copied++
  }
  if (!existsSync(aliasMarker)) {
    writeTextFile(aliasMarker, `${JSON.stringify({
      kind: 'dsh-future-alias',
      dataVersion: version,
      copiedFrom: FUTURE_ALIAS_IMAGE,
      note: 'Unreleased Minecraft version. 26.3 packet data is reused; call syncFutureVersionProtocol(version, protocol) with the server ping protocol before joining.'
    }, null, 2)}\n`)
  }
  return { copiedFiles: copied, realData: false }
}

// dataPaths override table shipped by the minecraft-data PR (the upstream
// `bin/generate_data.js` input). It is the source of truth for which directory
// each 26.2/26.3 data getter points at -e.g. 26.2 reuses 26.1's
// effects/enchantments/instruments and 1.20.2's mapIcons.
function loadVendoredDataPaths() {
  const file = path.join(VENDOR_DIR, 'minecraft-data-extra', 'dataPaths.json')
  const parsed = readJsonSafe(file)
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`protocol-compat: vendored dataPaths.json missing or invalid (${file})`)
  }
  const table = {}
  for (const version of EMULATED_VERSIONS) {
    if (!parsed[version] || typeof parsed[version] !== 'object') {
      throw new Error(`protocol-compat: vendored dataPaths.json has no entry for ${version}`)
    }
    table[version] = parsed[version]
  }
  return table
}

/** Resolve a (name ->"pc/<dir>") dataPaths entry to an installed "pc/<dir>" path. */
function resolveDataDir(dataRoot, dataName, mappedDir, ownVersion) {
  const fileName = `${dataName}.json`
  const existsIn = dir => existsSync(path.join(dataRoot, dir.replace(/^pc[\\/]/, ''), fileName))
  if (mappedDir && existsIn(mappedDir)) return mappedDir
  // The published minecraft-data package de-duplicates data files: some mapped
  // directories do not exist yet (e.g. the PR maps windows to pc/1.20.3 but the
  // published package keeps the only windows.json in pc/1.16.1). Fall back to
  // the nearest installed version that actually ships the file.
  const preferred = { mapIcons: '1.20.2', windows: '1.16.1' }[dataName]
  const candidates = []
  if (preferred) candidates.push(`pc/${preferred}`)
  if (ownVersion) candidates.push(`pc/${ownVersion}`)
  candidates.push(...DATA_FILE_CANDIDATES.map(version => `pc/${version}`))
  for (const dir of candidates) {
    if (existsIn(dir)) return dir
  }
  try {
    for (const version of readdirSync(dataRoot)) {
      if (existsIn(`pc/${version}`)) return `pc/${version}`
    }
  } catch {
    // ignore: handled by the caller
  }
  return null
}

/** dataPaths table for a future alias: image version dirs relabelled to the alias. */
function dataPathsForVersion(version, table) {
  if (EMULATED_VERSIONS.includes(version)) return table[version]
  const image = table[FUTURE_ALIAS_IMAGE]
  if (!image) throw new Error(`protocol-compat: no dataPaths image for ${FUTURE_ALIAS_IMAGE}`)
  const relabelled = {}
  const imageDir = `pc/${FUTURE_ALIAS_IMAGE}`
  const aliasDir = `pc/${version}`
  for (const [name, dir] of Object.entries(image)) {
    relabelled[name] = dir === imageDir ? aliasDir : dir
  }
  return relabelled
}

/**
 * Render the data.js object literal for one version, following the exact style
 * of minecraft-data's own `bin/generate_data.js` output.
 */
function dataJsBlock(version, dataPaths, dataRoot) {
  const lines = [`    '${version}': {`]
  for (const [name, dir] of Object.entries(dataPaths)) {
    if (name === 'proto') continue
    const resolvedDir = resolveDataDir(dataRoot, name, dir, version)
    if (!resolvedDir) {
      throw new Error(`protocol-compat: no installed minecraft-data file for '${name}' (${version})`)
    }
    lines.push(`      get ${name} () { return require("./minecraft-data/data/${resolvedDir}/${name}.json") },`)
  }
  const protoDir = dataPaths.proto || `pc/${version}`
  lines.push(`      proto: __dirname + '/minecraft-data/data/${protoDir}/proto.yml'`)
  lines.push('    },')
  return lines.join('\n')
}

function dataJsHasVersion(pcBlock, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`['"]${escaped}['"]\\s*:`).test(pcBlock)
}

/** Locate one `'<version>': { ... },` object literal inside the data.js `pc` section. */
function findDataJsBlock(raw, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const marker = new RegExp(`^    '${escaped}': \\{\\r?\\n`, 'm')
  const match = marker.exec(raw)
  if (!match) return null
  const start = match.index
  const endMarker = '\n    },'
  const end = raw.indexOf(endMarker, start)
  if (end < 0) return null
  return { start, end: end + endMarker.length }
}

/**
 * Insert the 26.2/26.3/26.4 entries into minecraft-data's generated data.js and
 * refresh them when the expected getter set changed (upstream regeneration).
 */
function ensureDataJsEntries(paths, versions) {
  let raw = readFileSync(paths.dataJs, 'utf8')
  const pcStart = raw.indexOf("'pc': {")
  if (pcStart < 0) throw new Error(`protocol-compat: cannot find the 'pc' section in ${paths.dataJs}`)
  const bedrockStart = raw.indexOf("'bedrock':")
  const pcEnd = bedrockStart > pcStart ? bedrockStart : raw.length
  const dataPathsTable = loadVendoredDataPaths()
  const changed = []
  for (const version of versions) {
    const block = dataJsBlock(version, dataPathsForVersion(version, dataPathsTable), paths.pcDataRoot)
    const existing = findDataJsBlock(raw, version)
    if (existing) {
      const current = raw.slice(existing.start, existing.end)
      if (current === block) continue
      raw = raw.slice(0, existing.start) + block + raw.slice(existing.end)
      changed.push(version)
      continue
    }
    // first insertion: right after the `'pc': {` line, newest version first
    const lineEnd = raw.indexOf('\n', pcStart)
    const insertAt = lineEnd >= 0 ? lineEnd + 1 : pcStart + "'pc': {".length
    raw = raw.slice(0, insertAt) + `${block}\n` + raw.slice(insertAt)
    changed.push(version)
  }
  if (changed.length > 0) {
    // sanity: the block we just (re)wrote must be inside the pc section
    const newPcStart = raw.indexOf("'pc': {")
    const newBedrockStart = raw.indexOf("'bedrock':")
    const newPcEnd = newBedrockStart > newPcStart ? newBedrockStart : raw.length
    const pcBlock = raw.slice(newPcStart, newPcEnd)
    for (const version of versions) {
      if (!dataJsHasVersion(pcBlock, version)) {
        throw new Error(`protocol-compat: failed to patch data.js for ${version}`)
      }
    }
    writeTextFile(paths.dataJs, raw)
  }
  return changed
}

function ensureFeaturesJson(paths) {
  const src = path.join(VENDOR_DIR, 'minecraft-data-extra', 'features.json')
  if (!existsSync(src)) throw new Error(`protocol-compat: vendored features.json missing (${src})`)
  const dst = path.join(paths.commonDir, 'features.json')
  if (sameFile(src, dst)) return false
  mkdirSync(path.dirname(dst), { recursive: true })
  copyFileSync(src, dst)
  return true
}

function ensureVersionsList(paths) {
  const file = path.join(paths.commonDir, 'versions.json')
  const current = readJsonSafe(file)
  const list = Array.isArray(current) ? current : []
  const missing = MERGED_DATA_VERSIONS.filter(version => !list.includes(version))
  if (missing.length === 0) return false
  const wanted = new Set(MERGED_DATA_VERSIONS)
  const merged = [...MERGED_DATA_VERSIONS, ...list.filter(version => !wanted.has(version))]
  writeTextFile(file, JSON.stringify(merged))
  return true
}

function protocolVersionEntry(version) {
  return {
    minecraftVersion: version,
    version: PROTOCOL_VERSIONS[version],
    dataVersion: RELEASE_DATA_VERSIONS[version],
    usesNetty: true,
    majorVersion: version,
    releaseType: 'release'
  }
}

/** insert 26.2/26.3/26.4 entries into data/pc/common/protocolVersions.json */
function ensureProtocolVersions(paths) {
  const file = path.join(paths.commonDir, 'protocolVersions.json')
  const current = readJsonSafe(file)
  if (!Array.isArray(current)) throw new Error(`protocol-compat: cannot parse ${file}`)
  const missing = MERGED_DATA_VERSIONS.filter(version => !current.some(entry => entry && entry.minecraftVersion === version))
  if (missing.length === 0) return []
  // newest first: future alias (dataVersion 9000000) sits above the 26.x releases
  current.unshift(...missing.map(protocolVersionEntry))
  writeTextFile(file, `${JSON.stringify(current, null, 2)}\n`)
  return missing
}

// ---------------------------------------------------------------------------
// package + version-window installation
// ---------------------------------------------------------------------------

function installPackages(nodeModulesDir) {
  const copied = []
  const backedUp = []
  for (const spec of PACKAGES) {
    const srcDir = path.join(VENDOR_DIR, spec.dir)
    if (!existsSync(srcDir)) throw new Error(`protocol-compat: vendored package ${spec.name} missing (${srcDir})`)
    const dstDir = tryResolvePackageDir(spec.name) || path.join(nodeModulesDir, spec.name)
    const comparison = treeMatches(srcDir, dstDir)
    if (comparison.equal) continue
    if (existsSync(dstDir)) {
      const backupDir = path.join(nodeModulesDir, `.dsh-upstream-bak-${spec.name}`)
      if (!existsSync(backupDir)) {
        try {
          copyTree(dstDir, backupDir)
          backedUp.push(spec.name)
        } catch {
          // backing up is best effort; never fail the install because of it
        }
      }
      rmSync(dstDir, { recursive: true, force: true })
    }
    copyTree(srcDir, dstDir)
    copied.push(spec.name)
  }
  return { copied, backedUp }
}

/**
 * Widen the mineflayer supported-version window in memory.
 * Must run before `require('mineflayer')`: lib/loader.js destructures
 * `{ testedVersions, latestSupportedVersion, oldestSupportedVersion }` at load
 * time and computes `latestSupportedProtocolVersion` from
 * minecraft-data's `versionsByMinecraftVersion.pc[latestSupportedVersion]`.
 */
function applyVersionWindow() {
  const minecraftDataModule = require('minecraft-data')
  const byMinecraftVersion = minecraftDataModule.versionsByMinecraftVersion &&
    minecraftDataModule.versionsByMinecraftVersion.pc

  // A synthetic entry above every real version keeps the "latest supported
  // version" gate open for unreleased/unknown future versions.
  //
  // mineflayer/lib/loader.js does:
  //   const latestSupportedProtocolVersion =
  //     minecraftData.versionsByMinecraftVersion.pc[latestSupportedVersion].version
  //   if (!latestSupportedProtocolVersion) throw ...
  // so the `version` field must be truthy. We use the protocol of the newest
  // emulated release (777 = 26.3) instead of 0: it is never compared against a
  // real server (dataVersion 1e9 already makes every real version "older"), it
  // only satisfies the loader's truthiness check.
  if (byMinecraftVersion && !byMinecraftVersion[SYNTHETIC_UPPER_BOUND]) {
    byMinecraftVersion[SYNTHETIC_UPPER_BOUND] = {
      minecraftVersion: SYNTHETIC_UPPER_BOUND,
      version: PROTOCOL_VERSIONS[EMULATED_VERSIONS[EMULATED_VERSIONS.length - 1]],
      dataVersion: SYNTHETIC_DATA_VERSION,
      usesNetty: true,
      majorVersion: SYNTHETIC_UPPER_BOUND,
      releaseType: 'release'
    }
  }

  // Defensive: if minecraft-data was already loaded before the file patches
  // above ran, its in-memory indexes may miss the 26.2/26.4 entries. Inject them
  // so the layer still works within this process.
  if (byMinecraftVersion) {
    for (const version of [...EMULATED_VERSIONS, ...FUTURE_VERSIONS]) {
      if (!byMinecraftVersion[version]) byMinecraftVersion[version] = protocolVersionEntry(version)
    }
  }
  const protocols = minecraftDataModule.versions && minecraftDataModule.versions.pc
  if (Array.isArray(protocols)) {
    for (const version of [...FUTURE_VERSIONS, ...EMULATED_VERSIONS]) {
      if (!protocols.some(entry => entry && entry.minecraftVersion === version)) {
        protocols.unshift(protocolVersionEntry(version))
      }
    }
  }

  let versionModule = null
  try {
    versionModule = require('mineflayer/lib/version.js')
  } catch {
    versionModule = null
  }
  if (!versionModule || !Array.isArray(versionModule.testedVersions)) {
    return { applied: false, testedVersions: [], latestSupportedVersion: null, oldestSupportedVersion: null }
  }
  for (const version of [...EMULATED_VERSIONS, SYNTHETIC_UPPER_BOUND]) {
    if (!versionModule.testedVersions.includes(version)) versionModule.testedVersions.push(version)
  }
  versionModule.latestSupportedVersion = SYNTHETIC_UPPER_BOUND
  versionModule.oldestSupportedVersion = versionModule.testedVersions[0]
  return {
    applied: true,
    testedVersions: [...versionModule.testedVersions],
    latestSupportedVersion: versionModule.latestSupportedVersion,
    oldestSupportedVersion: versionModule.oldestSupportedVersion
  }
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

function setupPaths() {
  const nodeModulesDir = resolveNodeModulesDir()
  const minecraftData = resolveMinecraftDataPaths(nodeModulesDir)
  state.paths = {
    pluginDir: PLUGIN_DIR,
    vendorDir: VENDOR_DIR,
    nodeModulesDir,
    minecraftData,
    markerFile: path.join(nodeModulesDir, MARKER_NAME)
  }
  return state.paths
}

function readMarker(paths) {
  return readJsonSafe(paths.markerFile)
}

/**
 * Cheap sanity check used by the marker fast path: if `node_modules` was
 * re-installed (`npm install`, a package upgrade, ...) the marker may still be
 * around while the patched files are gone. In that case fall through to the
 * full (idempotent) install pass instead of trusting the marker.
 */
function installedStateLooksValid(mdPaths) {
  try {
    const raw = readFileSync(mdPaths.dataJs, 'utf8')
    const pcStart = raw.indexOf("'pc': {")
    if (pcStart < 0) return false
    const bedrockStart = raw.indexOf("'bedrock':")
    const pcBlock = raw.slice(pcStart, bedrockStart > pcStart ? bedrockStart : raw.length)
    for (const version of MERGED_DATA_VERSIONS) {
      if (!dataJsHasVersion(pcBlock, version)) return false
    }
    if (!sameFile(path.join(VENDOR_DIR, 'minecraft-data-extra', 'features.json'), path.join(mdPaths.commonDir, 'features.json'))) {
      return false
    }
    const aliasDir = path.join(mdPaths.pcDataRoot, FUTURE_VERSIONS[0])
    const aliasMarker = path.join(aliasDir, '.dsh-future-alias.json')
    if (existsSync(aliasMarker)) {
      // our synthetic alias must still carry the 26.3-relabelled version.json
      const alias = readJsonSafe(path.join(aliasDir, 'version.json'))
      const expected = futureVersionJson(FUTURE_VERSIONS[0])
      if (!alias || alias.version !== expected.version || alias.minecraftVersion !== expected.minecraftVersion || alias.majorVersion !== expected.majorVersion) {
        return false
      }
    } else {
      // genuine upstream future data is equally fine: the alias is not needed
      const existing = readJsonSafe(path.join(aliasDir, 'version.json'))
      if (!existing || existing.minecraftVersion !== FUTURE_VERSIONS[0] || existing.majorVersion === FUTURE_ALIAS_IMAGE) return false
    }
    return true
  } catch {
    return false
  }
}

/**
 * Install / refresh the vendored upstream 26.3 payload. Idempotent: when the
 * marker is present, matches the current vendor version and the patched files
 * are still in place this is a no-op and touches no file. Pass `{ force: true }`
 * to re-run the full (still idempotent) verification/patch pass.
 */
export function installUpstreamCompat(options = {}) {
  const force = options.force === true
  const startedAt = Date.now()
  state.installCount++
  let paths
  try {
    paths = setupPaths()
    if (!existsSync(VENDOR_DIR)) {
      throw new Error(`protocol-compat: vendor payload missing (${VENDOR_DIR})`)
    }
    const marker = readMarker(paths)
    if (!force && marker && marker.vendorVersion === VENDOR_VERSION && installedStateLooksValid(paths.minecraftData)) {
      const window = applyVersionWindow()
      const summary = {
        ok: true,
        installed: true,
        skipped: true,
        vendorVersion: VENDOR_VERSION,
        markerFile: paths.markerFile,
        installedAt: marker.installedAt || null,
        durationMs: Date.now() - startedAt,
        window
      }
      state.lastInstall = summary
      state.installError = null
      return summary
    }

    const packages = installPackages(paths.nodeModulesDir)

    const mdPaths = paths.minecraftData
    if (!existsSync(mdPaths.pcDataRoot)) {
      throw new Error(`protocol-compat: minecraft-data data directory not found (${mdPaths.pcDataRoot})`)
    }
    const data = {}
    for (const version of EMULATED_VERSIONS) data[version] = { copiedFiles: installDataVersion(mdPaths, version) }
    for (const version of FUTURE_VERSIONS) data[version] = { copiedFiles: installFutureAlias(mdPaths, version) }
    const insertedDataJs = ensureDataJsEntries(mdPaths, MERGED_DATA_VERSIONS)
    const featuresChanged = ensureFeaturesJson(mdPaths)
    const versionsListChanged = ensureVersionsList(mdPaths)
    const insertedProtocolVersions = ensureProtocolVersions(mdPaths)
    const window = applyVersionWindow()

    const changed = packages.copied.length > 0 || packages.backedUp.length > 0 ||
      Object.values(data).some(entry => entry.copiedFiles > 0) ||
      insertedDataJs.length > 0 || featuresChanged || versionsListChanged ||
      insertedProtocolVersions.length > 0

    const markerMissing = !marker || marker.vendorVersion !== VENDOR_VERSION
    if (changed || markerMissing) {
      const nextMarker = {
        vendorVersion: VENDOR_VERSION,
        installedAt: new Date().toISOString(),
        nodeModulesDir: paths.nodeModulesDir,
        packages: Object.fromEntries(PACKAGES.map(spec => [spec.name, {
          version: readPackageVersion(path.join(paths.nodeModulesDir, spec.name)),
          identicalToVendor: treeMatches(path.join(VENDOR_DIR, spec.dir), tryResolvePackageDir(spec.name) || '').equal
        }])),
        minecraftData: {
          packageVersion: mdPaths.packageVersion,
          dataVersions: [...EMULATED_VERSIONS],
          futureAlias: [...FUTURE_VERSIONS],
          dataJsInserted: insertedDataJs,
          featuresInstalled: sha256(path.join(mdPaths.commonDir, 'features.json')),
          versionsListChanged,
          protocolVersionsInserted: insertedProtocolVersions
        },
        window: {
          oldestSupportedVersion: window.oldestSupportedVersion,
          latestSupportedVersion: window.latestSupportedVersion,
          syntheticUpperBound: SYNTHETIC_UPPER_BOUND,
          testedVersions: window.testedVersions
        },
        emulatedVersions: [...EMULATED_VERSIONS],
        futureVersions: [...FUTURE_VERSIONS]
      }
      writeTextFile(paths.markerFile, `${JSON.stringify(nextMarker, null, 2)}\n`)
    }

    const summary = {
      ok: true,
      installed: true,
      skipped: false,
      vendorVersion: VENDOR_VERSION,
      markerFile: paths.markerFile,
      durationMs: Date.now() - startedAt,
      packages,
      minecraftData: {
        dataVersions: data,
        dataJsInserted: insertedDataJs,
        featuresChanged,
        versionsListChanged,
        protocolVersionsInserted: insertedProtocolVersions
      },
      window
    }
    state.lastInstall = summary
    state.installError = null
    return summary
  } catch (error) {
    state.installError = error
    state.lastInstall = { ok: false, error: error.message, durationMs: Date.now() - startedAt }
    throw error
  }
}

/**
 * Point a future alias (e.g. `26.4`) at the protocol number reported by the real
 * server ping. Packet schemas stay those of 26.3, only the handshake protocol
 * number is updated (in memory + in the loaded minecraft-data indexes).
 *
 * Options:
 *   presentAs: an emulated version (e.g. '26.3') to present in place of the
 *     alias. The vendored mineflayer physics plugin contains hardcoded
 *     `bot.version === '26.3'` checks (26.3 teleport confirm semantics), so a
 *     bot that keeps `bot.version === '26.4'` gets "Invalid move player packet
 *     received" kicks from a 26.3 server. Passing `presentAs: '26.3'` makes the
 *     whole client stack identify as the emulated release while the data key
 *     stays 26.4 - use it when the server wire format is 26.3-compatible.
 *     Call again without options to restore the plain alias presentation.
 */
export function syncFutureVersionProtocol(version, protocol, options = {}) {
  const wantedVersion = String(version)
  const wantedProtocol = Number(protocol)
  const presentAs = options.presentAs == null ? null : String(options.presentAs)
  if (!FUTURE_VERSIONS.includes(wantedVersion)) {
    throw new Error(`protocol-compat: syncFutureVersionProtocol only supports future aliases [${FUTURE_VERSIONS.join(', ')}] (got '${wantedVersion}')`)
  }
  if (!Number.isInteger(wantedProtocol) || wantedProtocol <= 0) {
    throw new Error(`protocol-compat: protocol must be a positive integer (got ${JSON.stringify(protocol)})`)
  }
  if (presentAs !== null && !EMULATED_VERSIONS.includes(presentAs)) {
    throw new Error(`protocol-compat: presentAs must be an emulated version [${EMULATED_VERSIONS.join(', ')}] (got '${presentAs}')`)
  }
  const minecraftDataModule = require('minecraft-data')
  const data = minecraftDataModule(wantedVersion)
  if (!data) throw new Error(`protocol-compat: no minecraft-data for '${wantedVersion}'`)
  const byMinecraftVersion = minecraftDataModule.versionsByMinecraftVersion && minecraftDataModule.versionsByMinecraftVersion.pc
  if (byMinecraftVersion && byMinecraftVersion[wantedVersion]) byMinecraftVersion[wantedVersion].version = wantedProtocol
  const protocols = minecraftDataModule.versions && minecraftDataModule.versions.pc
  if (Array.isArray(protocols)) {
    for (const entry of protocols) {
      if (entry && (entry.minecraftVersion === wantedVersion || entry.majorVersion === wantedVersion)) entry.version = wantedProtocol
    }
  }
  // nmcData.version is shared through minecraft-data's cache, so mutating it is
  // visible to createClient()/prismarine-registry within this process.
  data.version.version = wantedProtocol
  data.version.minecraftVersion = presentAs || wantedVersion
  state.futureProtocolOverrides[wantedVersion] = {
    protocol: wantedProtocol,
    presentAs: presentAs || wantedVersion
  }
  return {
    version: wantedVersion,
    protocol: wantedProtocol,
    presentAs: presentAs || wantedVersion,
    overrides: { ...state.futureProtocolOverrides },
    dataVersion: data.version.dataVersion,
    majorVersion: data.version.majorVersion
  }
}

/** Live, JSON-serialisable view of the compatibility layer state. */
export function upstreamCompatStatus() {
  let paths = state.paths
  try {
    if (!paths.minecraftData) paths = setupPaths()
  } catch {
    // status must never throw: fall back to the static paths
  }
  const nodeModulesDir = state.paths.nodeModulesDir || path.join(PLUGIN_DIR, 'node_modules')
  const mdPaths = state.paths.minecraftData || resolveMinecraftDataPaths(nodeModulesDir)
  const marker = state.paths.markerFile ? readMarker(state.paths) : null
  const dataJsRaw = (() => {
    try {
      return readFileSync(mdPaths.dataJs, 'utf8')
    } catch {
      return ''
    }
  })()
  const pcBlockStart = dataJsRaw.indexOf("'pc': {")
  const pcBlockEnd = dataJsRaw.indexOf("'bedrock':")
  const pcBlock = pcBlockStart >= 0
    ? dataJsRaw.slice(pcBlockStart, pcBlockEnd > pcBlockStart ? pcBlockEnd : dataJsRaw.length)
    : ''
  const dataJsEntries = Object.fromEntries(MERGED_DATA_VERSIONS.map(version => [version, dataJsHasVersion(pcBlock, version)]))

  const protocolVersions = (() => {
    const parsed = readJsonSafe(path.join(mdPaths.commonDir, 'protocolVersions.json'))
    return Array.isArray(parsed) ? parsed : []
  })()
  const versionsList = readJsonSafe(path.join(mdPaths.commonDir, 'versions.json'))
  const featuresFile = path.join(mdPaths.commonDir, 'features.json')
  const featuresVendor = path.join(VENDOR_DIR, 'minecraft-data-extra', 'features.json')
  const versionModule = (() => {
    try {
      return require('mineflayer/lib/version.js')
    } catch {
      return null
    }
  })()
  const minecraftDataModule = (() => {
    try {
      return require('minecraft-data')
    } catch {
      return null
    }
  })()
  const byMinecraftVersion = minecraftDataModule && minecraftDataModule.versionsByMinecraftVersion &&
    minecraftDataModule.versionsByMinecraftVersion.pc
  const loadable = {}
  if (minecraftDataModule) {
    for (const version of MERGED_DATA_VERSIONS) {
      try {
        loadable[version] = Boolean(minecraftDataModule(version))
      } catch {
        loadable[version] = false
      }
    }
  }

  return {
    vendorVersion: VENDOR_VERSION,
    vendorDir: VENDOR_DIR,
    nodeModulesDir,
    markerFile: state.paths.markerFile || null,
    installed: Boolean(marker && marker.vendorVersion === VENDOR_VERSION),
    marker: marker || null,
    installCount: state.installCount,
    lastInstall: state.lastInstall ? { ...state.lastInstall } : null,
    installError: state.installError ? state.installError.message : null,
    emulated: [...EMULATED_VERSIONS],
    supported: Object.fromEntries(EMULATED_VERSIONS.map(version => [version, true])),
    protocols: Object.fromEntries([...EMULATED_VERSIONS, ...FUTURE_VERSIONS].map(version => [version, PROTOCOL_VERSIONS[version]])),
    future: [...FUTURE_VERSIONS],
    futureTested: false,
    futureProtocolOverrides: { ...state.futureProtocolOverrides },
    packages: Object.fromEntries(PACKAGES.map(spec => {
      const installedDir = tryResolvePackageDir(spec.name) || path.join(nodeModulesDir, spec.name)
      const comparison = treeMatches(path.join(VENDOR_DIR, spec.dir), installedDir)
      return [spec.name, {
        installedVersion: readPackageVersion(installedDir),
        vendoredVersion: readPackageVersion(path.join(VENDOR_DIR, spec.dir)),
        identicalToVendor: comparison.equal,
        target: installedDir
      }]
    })),
    minecraftData: {
      packageDir: mdPaths.packageDir,
      packageVersion: mdPaths.packageVersion,
      dataRoot: mdPaths.pcDataRoot,
      dataJs: mdPaths.dataJs,
      dataVersions: MERGED_DATA_VERSIONS,
      loadable,
      dataJsEntries,
      features: {
        file: featuresFile,
        matchesVendor: sameFile(featuresFile, featuresVendor),
        sha256: existsSync(featuresFile) ? sha256(featuresFile) : null
      },
      versionsListIncludes: Object.fromEntries(MERGED_DATA_VERSIONS.map(version => [version, Array.isArray(versionsList) && versionsList.includes(version)])),
      protocolVersions: Object.fromEntries(MERGED_DATA_VERSIONS.map(version => {
        const entry = protocolVersions.find(candidate => candidate && candidate.minecraftVersion === version)
        return [version, entry ? { protocol: entry.version, dataVersion: entry.dataVersion } : null]
      })),
      futureAliasVersionJson: readJsonSafe(path.join(mdPaths.pcDataRoot, FUTURE_VERSIONS[0], 'version.json'))
    },
    versionWindow: {
      platform: process.version,
      mineflayerLoadedBeforePatch: versionModule ? versionModule.latestSupportedVersion === SYNTHETIC_UPPER_BOUND : false,
      testedVersions: versionModule ? [...versionModule.testedVersions] : [],
      latestSupportedVersion: versionModule ? versionModule.latestSupportedVersion : null,
      oldestSupportedVersion: versionModule ? versionModule.oldestSupportedVersion : null,
      syntheticUpperBound: SYNTHETIC_UPPER_BOUND,
      syntheticEntry: byMinecraftVersion && byMinecraftVersion[SYNTHETIC_UPPER_BOUND]
        ? { ...byMinecraftVersion[SYNTHETIC_UPPER_BOUND] }
        : null
    }
  }
}

// ---------------------------------------------------------------------------
// module initialisation: install first, then load the patched packages
// ---------------------------------------------------------------------------

const initialInstall = installUpstreamCompat()

/** Vendored + installed mineflayer (26.2/26.3 capable). */
export let mineflayer
/** minecraft-data package with the 26.2/26.3 data installed. */
export let minecraftData
/** minecraft-protocol (the vendored PR build). */
export let minecraftProtocol

try {
  // Apply the version window *before* mineflayer loads: loader.js captures
  // latestSupportedVersion at require time.
  minecraftData = require('minecraft-data')
  applyVersionWindow()
  mineflayer = require('mineflayer')
  minecraftProtocol = require('minecraft-protocol')
} catch (error) {
  const suffix = initialInstall && initialInstall.ok
    ? ''
    : ` (install step failed: ${state.installError ? state.installError.message : 'unknown error'})`
  throw new Error(`protocol-compat: failed to load the patched protocol stack: ${error.message}${suffix}`)
}

export default {
  mineflayer,
  minecraftData,
  minecraftProtocol,
  installUpstreamCompat,
  upstreamCompatStatus,
  syncFutureVersionProtocol,
  EMULATED_VERSIONS,
  FUTURE_VERSIONS,
  SYNTHETIC_UPPER_BOUND
}
