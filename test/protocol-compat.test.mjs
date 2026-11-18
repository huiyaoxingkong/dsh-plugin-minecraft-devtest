// Tests for the 26.2/26.3 protocol compatibility layer (lib/protocol-compat.js).
//
// Suites:
//   1) vendor payload + installation  -deterministic, no server required.
//   2) minecraft-data / version window -deterministic, no server required.
//   3) REAL vanilla 26.3 server (must pass) and REAL vanilla 26.2 server
//      (best effort): start `.tmp/compat-servers/<version>` with Java 25, join
//      with the patched mineflayer build, assert spawn -> chat -> state -> quit,
//      then stop the server and assert the port was released.
//
// Fixtures:
//   D:\Minecraft\dsh-mc\.tmp\compat-servers\26.3  (server.jar + eula + properties)
//   D:\Minecraft\dsh-mc\.tmp\compat-servers\26.2  (downloaded into place by the
//   task setup; the test patch-rewrites eula/properties and skips when missing)
// Both servers run one at a time (these are real JVMs, ~1.3 GB heap each); the
// test never touches the Lead's live 25565/25575 dev server.
//
// Run: node --test test/protocol-compat.test.mjs

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync
} from 'node:fs'
import net from 'node:net'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { after, before, describe, test } from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  EMULATED_VERSIONS,
  FUTURE_VERSIONS,
  SYNTHETIC_UPPER_BOUND,
  installUpstreamCompat,
  minecraftData,
  minecraftProtocol,
  mineflayer,
  syncFutureVersionProtocol,
  upstreamCompatStatus
} from '../lib/protocol-compat.js'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_DIR = resolve(TEST_DIR, '..')
const REPO_ROOT = resolve(PLUGIN_DIR, '..')
const NODE_MODULES = join(PLUGIN_DIR, 'node_modules')
const MD_PACKAGE = join(NODE_MODULES, 'minecraft-data')
const VENDOR_DIR = join(PLUGIN_DIR, 'vendor', 'upstream-26.3')
const COMPAT_SERVERS = join(REPO_ROOT, '.tmp', 'compat-servers')
const SERVER_LOG_DIR = join(COMPAT_SERVERS, 'logs')
const COMPAT_263_DIR = join(COMPAT_SERVERS, '26.3')
const COMPAT_262_DIR = join(COMPAT_SERVERS, '26.2')
const COMPAT_JAR_263 = join(COMPAT_263_DIR, 'server.jar')
const COMPAT_JAR_262 = join(COMPAT_262_DIR, 'server.jar')

const requireFromTest = createRequire(import.meta.url)

// Files the compat layer is allowed to write; the idempotency test hashes all
// of them plus the files it must never corrupt.
const INSTALLED_FILES = [
  'minecraft-data/data.js',
  'minecraft-data/minecraft-data/data/pc/common/features.json',
  'minecraft-data/minecraft-data/data/pc/common/versions.json',
  'minecraft-data/minecraft-data/data/pc/common/protocolVersions.json',
  'minecraft-data/minecraft-data/data/pc/26.2/version.json',
  'minecraft-data/minecraft-data/data/pc/26.2/blocks.json',
  'minecraft-data/minecraft-data/data/pc/26.3/version.json',
  'minecraft-data/minecraft-data/data/pc/26.3/blocks.json',
  'minecraft-data/minecraft-data/data/pc/26.4/version.json',
  'minecraft-data/minecraft-data/data/pc/26.4/blocks.json',
  'mineflayer/package.json',
  'mineflayer/lib/version.js',
  'mineflayer/lib/loader.js',
  'mineflayer/index.js',
  'minecraft-protocol/package.json',
  'minecraft-protocol/src/version.js',
  'prismarine-chunk/package.json',
  'prismarine-chunk/src/index.js',
  'prismarine-physics/package.json',
  'prismarine-physics/index.js'
]

function sha256(file) {
  return createHash('sha256').update(readFileSync(file)).digest('hex')
}

function snapshotInstalledState() {
  const files = {}
  for (const rel of INSTALLED_FILES) {
    const file = join(NODE_MODULES, rel)
    files[rel] = existsSync(file) ? sha256(file) : null
  }
  const marker = join(NODE_MODULES, '.dsh-upstream-compat.json')
  files['.dsh-upstream-compat.json'] = existsSync(marker) ? sha256(marker) : null
  // directory file counts catch duplicated/leftover data files as well
  const counts = {}
  for (const rel of ['minecraft-data/minecraft-data/data/pc/26.2', 'minecraft-data/minecraft-data/data/pc/26.3', 'minecraft-data/minecraft-data/data/pc/26.4']) {
    const dir = join(NODE_MODULES, rel)
    counts[rel] = existsSync(dir) ? readdirSync(dir).length : -1
  }
  return { files, counts }
}

function countDataJsEntries(raw, version) {
  const escaped = version.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const matches = raw.match(new RegExp(`'${escaped}'\\s*:`, 'g'))
  return matches ? matches.length : 0
}

// ---------------------------------------------------------------------------
// deterministic suites (no server)
// ---------------------------------------------------------------------------

test('vendor payload is complete, provenance-documented and small', () => {
  assert.equal(existsSync(VENDOR_DIR), true, `vendor payload missing: ${VENDOR_DIR}`)
  assert.equal(existsSync(join(VENDOR_DIR, 'README.md')), true, 'vendor README.md missing')
  const manifestFile = join(VENDOR_DIR, 'manifest.json')
  assert.equal(existsSync(manifestFile), true, 'vendor manifest.json missing')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert.equal(manifest.name, 'upstream-26.3')
  assert.equal(manifest.vendorVersion, 'upstream-26.3.2')
  assert.deepEqual(manifest.minecraftDataExtra.dataVersions, ['26.2', '26.3'])

  const expectedCommits = {
    'minecraft-protocol': '3473413d32ee09af55aa77579000391be3bb9753',
    mineflayer: 'ad4af12611fd55309bb387b2b416212bffb0eddf',
    'prismarine-chunk': 'a96fd7050163b5ae3cbce240deab453a03cd3bc2',
    'prismarine-physics': 'b928638645a56a110a51da1f2080c6455b27984a'
  }
  for (const [name, commit] of Object.entries(expectedCommits)) {
    const entry = manifest.packages[name]
    assert.ok(entry, `manifest missing package ${name}`)
    assert.equal(entry.source.commit, commit, `${name} commit mismatch`)
    assert.equal(typeof entry.source.pullRequest, 'number', `${name} PR number must be numeric`)
    assert.match(entry.source.url || `https://github.com/${entry.source.repo.split('/').slice(3).join('/')}/pull/${entry.source.pullRequest}`, /^https:\/\/github\.com\/.+\/pull\/\d+$/)
    assert.match(entry.treeSha256, /^[0-9a-f]{64}$/)
    const dir = join(VENDOR_DIR, name)
    assert.equal(existsSync(join(dir, 'package.json')), true, `${name}/package.json missing`)
    assert.equal(existsSync(join(dir, 'LICENSE')), true, `${name}/LICENSE missing`)
  }
  // the PR mineflayer package.json is what pins the upstream nmp branch -keep
  // it in the payload so provenance survives a copy into node_modules.
  const vendoredMineflayer = JSON.parse(readFileSync(join(VENDOR_DIR, 'mineflayer', 'package.json'), 'utf8'))
  assert.equal(vendoredMineflayer.version, '4.39.0')

  const data = manifest.minecraftDataExtra
  for (const version of ['26.2', '26.3']) {
    const versionFile = join(VENDOR_DIR, 'minecraft-data-extra', 'pc', version, 'version.json')
    assert.equal(existsSync(versionFile), true, `${version} version.json missing from vendor`)
    const v = JSON.parse(readFileSync(versionFile, 'utf8'))
    assert.equal(v.minecraftVersion, version)
    assert.equal(v.version, version === '26.3' ? 777 : 776)
  }
  assert.equal(existsSync(join(VENDOR_DIR, 'minecraft-data-extra', 'features.json')), true)

  let totalBytes = 0
  const stack = [VENDOR_DIR]
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else totalBytes += statSync(full).size
    }
  }
  assert.ok(totalBytes > 5 * 1024 * 1024, `vendor payload suspiciously small (${totalBytes} bytes)`)
  assert.ok(totalBytes < 25 * 1024 * 1024, `vendor payload too large (${(totalBytes / 1024 / 1024).toFixed(1)} MB > 25 MB budget)`)
})

test('installUpstreamCompat() is idempotent (no file churn, no duplicate entries)', () => {
  const first = installUpstreamCompat()
  assert.equal(first.ok, true)
  const baseline = snapshotInstalledState()
  for (const rel of INSTALLED_FILES) {
    assert.notEqual(baseline.files[rel], null, `expected ${rel} to exist after install`)
  }
  assert.notEqual(baseline.files['.dsh-upstream-compat.json'], null, 'idempotency marker was not written')

  // plain second call: marker fast path, nothing may change
  const second = installUpstreamCompat()
  assert.equal(second.ok, true)
  assert.equal(second.skipped, true, 'a second install should be skipped through the marker')
  assert.deepEqual(snapshotInstalledState(), baseline, 'second install changed installed files')

  // forced full verification/patch pass: must also be content-identical
  const forced = installUpstreamCompat({ force: true })
  assert.equal(forced.ok, true)
  assert.equal(forced.skipped, false)
  assert.deepEqual(forced.packages.copied, [], 'force install copied packages even though they already match the vendor payload')
  assert.deepEqual(forced.packages.backedUp, [], 'force install created backups even though packages already match')
  assert.deepEqual(forced.minecraftData.dataJsInserted, [], 'force install re-inserted data.js entries')
  assert.deepEqual(forced.minecraftData.protocolVersionsInserted, [], 'force install re-inserted protocolVersions entries')
  assert.equal(forced.minecraftData.featuresChanged, false)
  assert.equal(forced.minecraftData.versionsListChanged, false)
  assert.deepEqual(snapshotInstalledState(), baseline, 'forced install changed installed files')
  assert.ok(forced.durationMs < 5000, `forced install took ${forced.durationMs}ms (budget 5s)`)

  // data.js: exactly one entry per version, entries point at real data files
  const dataJs = readFileSync(join(MD_PACKAGE, 'data.js'), 'utf8')
  for (const version of ['26.2', '26.3', '26.4']) {
    assert.equal(countDataJsEntries(dataJs, version), 1, `data.js contains a duplicate '${version}' entry`)
    assert.ok(dataJs.includes(`require("./minecraft-data/data/pc/${version}/blocks.json")`), `data.js ${version} getter missing`)
  }
  const protocolVersions = JSON.parse(readFileSync(join(MD_PACKAGE, 'minecraft-data/data/pc/common/protocolVersions.json'), 'utf8'))
  for (const version of ['26.2', '26.3', '26.4']) {
    assert.equal(protocolVersions.filter(entry => entry.minecraftVersion === version).length, 1, `protocolVersions has a duplicate ${version} entry`)
  }
  const versionsList = JSON.parse(readFileSync(join(MD_PACKAGE, 'minecraft-data/data/pc/common/versions.json'), 'utf8'))
  for (const version of ENV_VERSIONS()) assert.ok(versionsList.includes(version), `versions.json missing ${version}`)

  // marker payload is stable and reports what was installed
  const marker = JSON.parse(readFileSync(join(NODE_MODULES, '.dsh-upstream-compat.json'), 'utf8'))
  assert.equal(marker.vendorVersion, 'upstream-26.3.2')
  assert.deepEqual(marker.emulatedVersions, ['26.2', '26.3'])
  assert.deepEqual(marker.futureVersions, ['26.4'])
  assert.equal(marker.window.latestSupportedVersion, SYNTHETIC_UPPER_BOUND)
  assert.equal(marker.window.oldestSupportedVersion, '1.8.8')
  for (const name of ['minecraft-protocol', 'mineflayer', 'prismarine-chunk', 'prismarine-physics']) {
    assert.equal(marker.packages[name].identicalToVendor, true, `${name} not identical to vendor payload`)
  }
})

function ENV_VERSIONS() {
  return [...EMULATED_VERSIONS, ...FUTURE_VERSIONS]
}

test('minecraft-data serves 26.2 / 26.3 / 26.4 and keeps older versions intact', () => {
  const data262 = minecraftData('26.2')
  assert.ok(data262, "minecraftData('26.2') returned null")
  assert.equal(data262.version.minecraftVersion, '26.2')
  assert.equal(data262.version.version, 776)
  assert.equal(data262.version.dataVersion, 4903)
  assert.equal(data262.version.majorVersion, '26.2')
  assert.ok(Object.keys(data262.blocksByName).length > 1000, '26.2 blocks missing')
  assert.ok(Object.keys(data262.itemsByName).length > 1000, '26.2 items missing')

  const data263 = minecraftData('26.3')
  assert.ok(data263, "minecraftData('26.3') returned null")
  assert.equal(data263.version.minecraftVersion, '26.3')
  assert.equal(data263.version.version, 777)
  assert.equal(data263.version.dataVersion, 5023)
  assert.equal(data263.version.majorVersion, '26.3')
  assert.ok(Object.keys(data263.blocks).length > 1200, '26.3 blocks missing')
  assert.ok(Object.keys(data263.items).length > 1500, '26.3 items missing')
  assert.ok(data263.blocksByName.stone, '26.3 blocksByName.stone missing')
  assert.ok(data263.protocol, '26.3 protocol definition missing')
  assert.equal(data263.supportFeature('playerActionHasChangeDestroyDirection'), true, '26.3 feature lookup broken')
  assert.equal(data263.supportFeature('swingUsesPunchPacket'), true, '26.3 feature lookup broken')

  // 26.4 is the best-effort future alias: 26.3 data under a 26.4 version label
  const data264 = minecraftData('26.4')
  assert.ok(data264, "minecraftData('26.4') returned null")
  assert.equal(data264.version.minecraftVersion, '26.4')
  assert.equal(data264.version.majorVersion, '26.3', '26.4 alias must reuse 26.3 chunk/physics data')
  assert.equal(data264.version.version, 777)
  assert.equal(data264.version.dataVersion, 9000000)
  assert.equal(Object.keys(data264.blocksByName).length, Object.keys(data263.blocksByName).length)

  // pre-existing versions keep working (no regression from the data.js patch)
  const data1201 = minecraftData('1.20.1')
  assert.ok(data1201, "minecraftData('1.20.1') returned null")
  assert.equal(data1201.version.version, 763)
  const dataLatest = minecraftData('1.21.11')
  assert.ok(dataLatest, 'latest pre-26 version broken')
})

test('version window is widened with a synthetic upper bound before mineflayer loads', () => {
  const versionModule = requireFromTest('mineflayer/lib/version.js')
  assert.ok(versionModule.testedVersions.includes('26.2'), 'testedVersions missing 26.2')
  assert.ok(versionModule.testedVersions.includes('26.3'), 'testedVersions missing 26.3')
  assert.ok(versionModule.testedVersions.includes(SYNTHETIC_UPPER_BOUND), 'testedVersions missing synthetic upper bound')
  assert.equal(versionModule.latestSupportedVersion, SYNTHETIC_UPPER_BOUND)
  assert.equal(versionModule.oldestSupportedVersion, '1.8.8')

  // loader.js captures the window at require time; prove the patch ran before it
  const loader = requireFromTest('mineflayer/lib/loader.js')
  assert.equal(loader.latestSupportedVersion, SYNTHETIC_UPPER_BOUND)
  assert.equal(loader.oldestSupportedVersion, '1.8.8')
  assert.ok(loader.testedVersions.includes('26.2'))
  assert.equal(typeof mineflayer.createBot, 'function')

  const byMinecraftVersion = minecraftData.versionsByMinecraftVersion.pc
  const synthetic = byMinecraftVersion[SYNTHETIC_UPPER_BOUND]
  assert.ok(synthetic, 'synthetic 999.0 entry missing from minecraft-data indexes')
  assert.equal(synthetic.dataVersion, 1000000000)
  assert.equal(synthetic.version, 777) // truthy: mineflayer's loader rejects a falsy protocol here
  for (const version of ['26.2', '26.3', '26.4']) {
    assert.ok(byMinecraftVersion[version], `versionsByMinecraftVersion missing ${version}`)
  }
  assert.ok(minecraftData.versions.pc.some(entry => entry.minecraftVersion === '26.4'), 'protocolVersions list missing 26.4')

  // the vendored minecraft-protocol PR build (entityDelta support) is in use
  assert.ok(Array.isArray(minecraftProtocol.supportedVersions))
  assert.ok(minecraftProtocol.supportedVersions.includes('26.3'), 'vendored minecraft-protocol does not advertise 26.3')
  assert.equal(typeof minecraftProtocol.createClient, 'function')
})

test('upstreamCompatStatus() reports the layer state', () => {
  const status = upstreamCompatStatus()
  assert.equal(status.installed, true)
  assert.equal(status.vendorVersion, 'upstream-26.3.2')
  assert.deepEqual(status.emulated, ['26.2', '26.3'])
  assert.equal(status.supported['26.2'], true)
  assert.equal(status.supported['26.3'], true)
  assert.deepEqual(status.future, ['26.4'])
  assert.equal(status.futureTested, false)
  assert.deepEqual(status.futureProtocolOverrides, {})
  assert.equal(status.installError, null)
  assert.equal(status.vendorDir, VENDOR_DIR)
  assert.notEqual(status.markerFile, null)
  assert.ok(status.marker && status.marker.vendorVersion === 'upstream-26.3.2')

  for (const name of ['minecraft-protocol', 'mineflayer', 'prismarine-chunk', 'prismarine-physics']) {
    assert.equal(status.packages[name].identicalToVendor, true, `${name} not identical to vendor payload`)
    assert.equal(status.packages[name].vendoredVersion, status.packages[name].installedVersion)
  }

  assert.equal(status.minecraftData.dataVersions.length, 3)
  assert.equal(status.minecraftData.loadable['26.2'], true)
  assert.equal(status.minecraftData.loadable['26.3'], true)
  assert.equal(status.minecraftData.loadable['26.4'], true)
  assert.deepEqual(status.minecraftData.dataJsEntries, { '26.2': true, '26.3': true, '26.4': true })
  assert.equal(status.minecraftData.features.matchesVendor, true)
  assert.deepEqual(status.minecraftData.protocolVersions['26.2'], { protocol: 776, dataVersion: 4903 })
  assert.deepEqual(status.minecraftData.protocolVersions['26.3'], { protocol: 777, dataVersion: 5023 })
  assert.deepEqual(status.minecraftData.protocolVersions['26.4'], { protocol: 777, dataVersion: 9000000 })
  assert.deepEqual(status.minecraftData.futureAliasVersionJson, {
    version: 777,
    minecraftVersion: '26.4',
    majorVersion: '26.3',
    releaseType: 'release'
  })

  assert.equal(status.versionWindow.latestSupportedVersion, SYNTHETIC_UPPER_BOUND)
  assert.equal(status.versionWindow.oldestSupportedVersion, '1.8.8')
  assert.equal(status.versionWindow.syntheticEntry.dataVersion, 1000000000)
  assert.ok(status.versionWindow.testedVersions.includes('26.2'))
  assert.ok(status.versionWindow.testedVersions.includes('26.3'))
})

test('syncFutureVersionProtocol() retargets the 26.4 alias handshake protocol', () => {
  const dataJsBefore = sha256(join(MD_PACKAGE, 'data.js'))
  const aliasVersionFile = join(MD_PACKAGE, 'minecraft-data/data/pc/26.4/version.json')
  const versionFileBefore = sha256(aliasVersionFile)

  try {
    const synced = syncFutureVersionProtocol('26.4', 778)
    assert.equal(synced.version, '26.4')
    assert.equal(synced.protocol, 778)
    assert.equal(synced.presentAs, '26.4')
    assert.equal(synced.majorVersion, '26.3')
    assert.equal(minecraftData('26.4').version.version, 778, 'cached mcData protocol was not updated')
    assert.equal(minecraftData.versionsByMinecraftVersion.pc['26.4'].version, 778)
    assert.equal(minecraftData.versions.pc.find(entry => entry.minecraftVersion === '26.4').version, 778)
    assert.deepEqual(upstreamCompatStatus().futureProtocolOverrides, {
      '26.4': { protocol: 778, presentAs: '26.4' }
    })
    // in-memory only: the on-disk placeholder must stay 777
    assert.equal(sha256(aliasVersionFile), versionFileBefore)
    assert.equal(sha256(join(MD_PACKAGE, 'data.js')), dataJsBefore)
  } finally {
    syncFutureVersionProtocol('26.4', 777)
  }
  assert.equal(minecraftData('26.4').version.version, 777)
  assert.equal(minecraftData('26.4').version.minecraftVersion, '26.4')

  // optional escape hatch: present the alias as the emulated 26.3 client
  try {
    const presented = syncFutureVersionProtocol('26.4', 777, { presentAs: '26.3' })
    assert.equal(presented.presentAs, '26.3')
    assert.equal(presented.majorVersion, '26.3')
    assert.equal(minecraftData('26.4').version.minecraftVersion, '26.3')
    assert.equal(minecraftData('26.4').version.version, 777)
  } finally {
    syncFutureVersionProtocol('26.4', 777)
  }
  assert.equal(minecraftData('26.4').version.minecraftVersion, '26.4', 'plain sync must restore the alias presentation')

  assert.throws(() => syncFutureVersionProtocol('26.2', 776), /only supports future aliases/)
  assert.throws(() => syncFutureVersionProtocol('26.4', 0), /positive integer/)
  assert.throws(() => syncFutureVersionProtocol('26.4', 'not-a-number'), /positive integer/)
  assert.throws(() => syncFutureVersionProtocol('26.4', 777, { presentAs: '26.4' }), /presentAs must be an emulated version/)
})

// ---------------------------------------------------------------------------
// real server helpers
// ---------------------------------------------------------------------------

const RCON_PASSWORD = 'compatpass'

function findJava(major) {
  const explicit = {
    25: process.env.DSH_JAVA_25 || 'D:\\Program Files\\Java\\graalvm-jdk-25.0.4+7.1\\bin\\java.exe',
    21: process.env.DSH_JAVA_21 || 'D:\\Program Files\\Java\\graalvm-jdk-21.0.10+8.1\\bin\\java.exe'
  }[major]
  if (explicit && existsSync(explicit)) return explicit
  const roots = ['D:\\Program Files\\Java']
  for (const root of roots) {
    if (!existsSync(root)) continue
    const pattern = new RegExp(`(?:graalvm-)?jdk-?${major}(?:\\.|$)`, 'i')
    for (const name of readdirSync(root)) {
      if (!pattern.test(name)) continue
      const candidate = join(root, name, 'bin', 'java.exe')
      if (existsSync(candidate)) return candidate
    }
  }
  return null
}

function isPortOpen(port, host = '127.0.0.1', timeoutMs = 700) {
  return new Promise(resolvePromise => {
    const socket = net.connect({ host, port })
    let done = false
    const finish = value => {
      if (done) return
      done = true
      socket.destroy()
      resolvePromise(value)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(timeoutMs, () => finish(false))
  })
}

async function waitFor(check, timeoutMs, intervalMs = 200) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (await check()) return true
    await sleep(intervalMs)
  }
  return false
}

function patchServerProperties(dir, { port, rconPort, motd }) {
  const propertiesFile = join(dir, 'server.properties')
  const existing = existsSync(propertiesFile) ? readFileSync(propertiesFile, 'utf8') : ''
  const overrides = new Map([
    ['server-port', String(port)],
    ['enable-rcon', 'true'],
    ['rcon.port', String(rconPort)],
    ['rcon.password', RCON_PASSWORD],
    ['online-mode', 'false'],
    ['white-list', 'false'],
    ['enforce-whitelist', 'false'],
    ['motd', motd],
    ['max-players', '5'],
    ['spawn-protection', '0'],
    ['view-distance', '6'],
    ['sync-chunk-writes', 'false']
  ])
  const lines = existing.split(/\r?\n/)
  const written = new Set()
  const out = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) {
      out.push(line)
      continue
    }
    const eq = line.indexOf('=')
    if (eq < 0) {
      out.push(line)
      continue
    }
    const key = line.slice(0, eq)
    if (overrides.has(key)) {
      out.push(`${key}=${overrides.get(key)}`)
      written.add(key)
    } else {
      out.push(line)
    }
  }
  for (const [key, value] of overrides) if (!written.has(key)) out.push(`${key}=${value}`)
  writeFileSync(propertiesFile, `${out.filter((line, index) => !(index === out.length - 1 && line === '')).join('\n')}\n`, 'utf8')
}

async function startServer(handle) {
  const { dir, port, rconPort, version } = handle
  assert.equal(existsSync(join(dir, 'server.jar')), true, `${version} fixture missing server.jar in ${dir}`)
  const java = findJava(handle.javaMajor)
  assert.ok(java, `Java ${handle.javaMajor} not found; set DSH_JAVA_${handle.javaMajor} to its java.exe path`)
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8')
  patchServerProperties(dir, { port, rconPort, motd: `dsh compat ${version}` })
  assert.equal(await isPortOpen(port), false, `${version} server port ${port} is already in use`)
  mkdirSync(SERVER_LOG_DIR, { recursive: true })

  handle.logFile = join(SERVER_LOG_DIR, `${version.replace(/\./g, '_')}-${Date.now()}.log`)
  handle.output = ''
  const proc = spawn(java, ['-Xmx1320M', '-jar', 'server.jar', 'nogui'], {
    cwd: dir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
  handle.proc = proc
  const collect = chunk => {
    handle.output += chunk.toString('utf8')
    if (handle.output.length > 2_000_000) handle.output = handle.output.slice(-1_500_000)
  }
  proc.stdout.on('data', collect)
  proc.stderr.on('data', collect)
  handle.exitCode = null
  handle.exitPromise = new Promise(resolvePromise => {
    proc.once('exit', code => {
      handle.exitCode = code
      resolvePromise(code)
    })
  })
  proc.once('error', error => {
    handle.output += `\n[spawn error] ${error.message}\n`
  })

  const dumpTail = () => handle.output.split(/\r?\n/).filter(Boolean).slice(-60).join('\n')
  const ready = await waitFor(async () => {
    if (handle.exitCode !== null) return true
    return /Done \(/.test(handle.output) || /RCON running on/.test(handle.output)
  }, 240000)
  if (!ready || !/Done \(/.test(handle.output)) {
    writeFileSync(handle.logFile, handle.output, 'utf8')
    throw new Error(`${version} server did not become ready.\n---- log tail ----\n${dumpTail()}`)
  }
  assert.equal(await isPortOpen(port), true, `${version} server port ${port} is not listening after startup`)
  return handle
}

async function stopServer(handle) {
  if (!handle || !handle.proc) return
  if (handle.exitCode === null) {
    try {
      handle.proc.stdin.write('stop\n')
    } catch {
      // stdin may already be closed
    }
    let exited = false
    try {
      exited = await Promise.race([handle.exitPromise.then(() => true), sleep(45000, false, { ref: false }).then(() => false)])
    } catch {
      exited = false
    }
    if (!exited && handle.exitCode === null) {
      spawnSync('taskkill', ['/pid', String(handle.proc.pid), '/T', '/F'], { stdio: 'ignore' })
      await Promise.race([handle.exitPromise.catch(() => null), sleep(15000, null, { ref: false })])
    }
  }
  if (handle.logFile) {
    try {
      writeFileSync(handle.logFile, handle.output, 'utf8')
    } catch {
      // logging is best effort
    }
  }
  const released = await waitFor(async () => (await isPortOpen(handle.port)) === false, 30000, 300)
  assert.equal(released, true, `port ${handle.port} was not released after stopping the ${handle.version} server`)
  assert.notEqual(handle.exitCode, null, `the ${handle.version} server process did not exit`)
}

function createJoinedBot({ port, username, version }) {
  return new Promise((resolvePromise, rejectPromise) => {
    let bot
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      cleanup()
      if (error) rejectPromise(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => {
      const tail = bot && bot._client ? ' (client exists)' : ''
      finish(new Error(`bot ${username} did not reach 'spawn' on ${version}:${tail}`))
    }, 60000)
    const cleanup = () => {
      if (!bot) return
      bot.removeListener('spawn', onSpawn)
      bot.removeListener('error', onError)
      bot.removeListener('end', onEnd)
      bot.removeListener('kicked', onKicked)
    }
    const onSpawn = () => finish(null, bot)
    const onError = error => finish(new Error(`bot ${username} on ${version}: ${error.message}`))
    const onEnd = reason => finish(new Error(`bot ${username} ended before spawn: ${reason}`))
    const onKicked = reason => finish(new Error(`bot ${username} was kicked: ${reason}`))
    try {
      bot = mineflayer.createBot({
        host: '127.0.0.1',
        port,
        username,
        auth: 'offline',
        version,
        hideErrors: true,
        logErrors: false
      })
    } catch (error) {
      settled = true
      clearTimeout(timer)
      rejectPromise(error)
      return
    }
    bot.once('spawn', onSpawn)
    bot.once('error', onError)
    bot.once('end', onEnd)
    bot.once('kicked', onKicked)
  })
}

async function quitBot(bot) {
  if (!bot) return
  try {
    bot.quit('protocol-compat test done')
  } catch {
    // ignore
  }
  await sleep(1200)
}

function assertBotState(bot, { version, protocolVersion, username }) {
  assert.equal(bot.username, username)
  assert.equal(bot.version, version, `auto/explicit version mismatch: ${bot.version}`)
  assert.equal(bot.protocolVersion, protocolVersion, `protocol mismatch for ${version}`)
  assert.ok(bot.entity, 'bot.entity missing after spawn')
  for (const axis of ['x', 'y', 'z']) {
    assert.ok(Number.isFinite(bot.entity.position[axis]), `bot position ${axis} is not finite`)
  }
  assert.ok(bot.health > 0, `bot health invalid: ${bot.health}`)
  assert.equal(typeof bot.food, 'number')
  assert.ok(bot.food >= 0 && bot.food <= 20, `bot food invalid: ${bot.food}`)
  assert.equal(typeof bot.game.dimension, 'string')
  assert.ok(bot.game.dimension.length > 0, 'bot dimension missing')
  assert.ok(bot.registry && bot.registry.version, 'bot registry missing')
  assert.equal(bot.registry.version.minecraftVersion, version)
  // the registry must resolve the chunk implementation for the (major) version
  const chunk = requireFromTest('prismarine-chunk')(bot.registry)
  assert.ok(chunk, 'prismarine-chunk could not create a chunk for the bot registry')
}

// ---------------------------------------------------------------------------
// real 26.3 server (must pass)
// ---------------------------------------------------------------------------

describe('real vanilla 26.3 server', { concurrency: 1 }, () => {
  const handle = {
    version: '26.3',
    dir: COMPAT_263_DIR,
    port: 25692,
    rconPort: 25712,
    javaMajor: 25,
    username: 'Compat263',
    protocolVersion: 777,
    proc: null
  }
  const available = existsSync(COMPAT_JAR_263)

  before(async () => {
    if (!available) return
    await startServer(handle)
  }, { timeout: 300000 })

  after(async () => {
    if (!available) return
    await stopServer(handle)
  }, { timeout: 120000 })

  test('join -> spawn -> chat -> state -> quit', { skip: available ? false : 'fixture .tmp/compat-servers/26.3 missing' }, async () => {
    assert.ok(/Starting minecraft server version 26\.3/.test(handle.output), '26.3 server version banner missing')
    const bot = await createJoinedBot({ port: handle.port, username: handle.username, version: '26.3' })
    try {
      assertBotState(bot, { version: '26.3', protocolVersion: 777, username: handle.username })
      bot.chat('hello from dsh protocol-compat 26.3')
      await sleep(1500)
      assert.match(handle.output, /Compat263 joined the game/, 'server did not log the 26.3 bot join')
    } finally {
      await quitBot(bot)
    }
    const left = await waitFor(() => /Compat263 lost connection|Compat263 left the game/.test(handle.output), 20000, 300)
    assert.equal(left, true, 'server did not log the 26.3 bot disconnect')
    assert.match(handle.output, /hello from dsh protocol-compat 26\.3/, 'chat from the 26.3 bot did not reach the server')
  })

  test('26.4 best-effort alias joins a 26.3-compatible server', { skip: available ? false : 'fixture .tmp/compat-servers/26.3 missing' }, async () => {
    // 26.4 is unreleased: the alias reuses the 26.3 packet data. Point its
    // handshake protocol at the protocol the real server reports (777 here) and
    // prove the whole stack (window gate, data lookups, registry, chunks) works.
    // NOTE: with the plain alias the vendored mineflayer physics plugin skips its
    // hardcoded `bot.version === '26.3'` teleport-confirm path, so a 26.3 server
    // may log "Invalid move player packet received" and drop the bot shortly
    // after spawn. Join/spawn/state/chat are still proven here; the next test
    // shows the `presentAs` escape hatch for full play.
    const synced = syncFutureVersionProtocol('26.4', 777)
    assert.equal(synced.protocol, 777)
    assert.equal(synced.majorVersion, '26.3')
    const bot = await createJoinedBot({ port: handle.port, username: 'Compat264', version: '26.4' })
    try {
      assertBotState(bot, { version: '26.4', protocolVersion: 777, username: 'Compat264' })
      assert.equal(bot.registry.version.majorVersion, '26.3', '26.4 alias must reuse 26.3 chunk/physics data')
      bot.chat('hello from the 26.4 best-effort alias')
      await sleep(1500)
      assert.match(handle.output, /Compat264 joined the game/, 'server did not log the 26.4 alias bot join')
    } finally {
      await quitBot(bot)
    }
    assert.match(handle.output, /hello from the 26\.4 best-effort alias/, 'chat from the 26.4 alias bot did not reach the server')
  })

  test('26.4 alias can present itself as the emulated 26.3 wire client (presentAs)', { skip: available ? false : 'fixture .tmp/compat-servers/26.3 missing' }, async () => {
    // Escape hatch for the hardcoded `bot.version === '26.3'` checks: identify as
    // the emulated release while the data key / handshake protocol retargeting
    // stay 26.4. This is what makes the alias actually playable on a wire-format
    // compatible server (26.4 will need a new upstream port once it changes).
    const presented = syncFutureVersionProtocol('26.4', 777, { presentAs: '26.3' })
    assert.equal(presented.presentAs, '26.3')
    const bot = await createJoinedBot({ port: handle.port, username: 'Compat264b', version: '26.4' })
    let earlyEnd = null
    bot.once('end', reason => { earlyEnd = reason })
    try {
      assert.equal(bot.version, '26.3', 'presentAs should make the client identify as 26.3')
      assert.equal(bot.protocolVersion, 777)
      assert.ok(bot.entity, 'bot.entity missing after spawn')
      assert.ok(bot.health > 0)
      assert.equal(bot.registry.version.minecraftVersion, '26.3')
      bot.chat('hello from the 26.4 alias presented as 26.3')
      // longer than the kick window observed with the plain alias
      await sleep(3000)
      assert.equal(earlyEnd, null, `presentAs alias bot was disconnected early: ${earlyEnd}`)
      assert.match(handle.output, /Compat264b joined the game/)
    } finally {
      await quitBot(bot)
      syncFutureVersionProtocol('26.4', 777)
    }
    assert.equal(minecraftData('26.4').version.minecraftVersion, '26.4', 'plain sync must restore the alias presentation')
    assert.match(handle.output, /hello from the 26\.4 alias presented as 26\.3/)
    const left = await waitFor(() => /Compat264b lost connection|Compat264b left the game/.test(handle.output), 20000, 300)
    assert.equal(left, true, 'server did not log the presentAs alias bot disconnect')
  })
})

// ---------------------------------------------------------------------------
// real 26.2 server (best effort; skipped when the fixture jar is absent)
// ---------------------------------------------------------------------------

describe('real vanilla 26.2 server', { concurrency: 1 }, () => {
  const handle = {
    version: '26.2',
    dir: COMPAT_262_DIR,
    port: 25693,
    rconPort: 25713,
    javaMajor: 25,
    username: 'Compat262',
    protocolVersion: 776,
    proc: null
  }
  const available = existsSync(COMPAT_JAR_262)

  before(async () => {
    if (!available) return
    await startServer(handle)
  }, { timeout: 300000 })

  after(async () => {
    if (!available) return
    await stopServer(handle)
  }, { timeout: 120000 })

  test('join -> spawn -> chat -> state -> quit', { skip: available ? false : 'fixture .tmp/compat-servers/26.2 missing' }, async () => {
    assert.ok(/Starting minecraft server version 26\.2/.test(handle.output), '26.2 server version banner missing')
    const bot = await createJoinedBot({ port: handle.port, username: handle.username, version: '26.2' })
    try {
      assertBotState(bot, { version: '26.2', protocolVersion: 776, username: handle.username })
      bot.chat('hello from dsh protocol-compat 26.2')
      await sleep(1500)
      assert.match(handle.output, /Compat262 joined the game/, 'server did not log the 26.2 bot join')
    } finally {
      await quitBot(bot)
    }
    const left = await waitFor(() => /Compat262 lost connection|Compat262 left the game/.test(handle.output), 20000, 300)
    assert.equal(left, true, 'server did not log the 26.2 bot disconnect')
    assert.match(handle.output, /hello from dsh protocol-compat 26\.2/, 'chat from the 26.2 bot did not reach the server')
  })
})
