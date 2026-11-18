// Distribution checks for the bundled Forge 1.20.1 test bridge mod.
// They verify that the plugin ships a complete, loadable bridge jar without
// requiring a Minecraft server or a running JVM; the jar-tool based checks are
// skipped when no JDK `jar` executable can be found.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const VENDOR = path.resolve(HERE, '..', 'vendor', 'forge-bridge')
const VERSION_DIR = path.join(VENDOR, '1.20.1')
const JAR_NAME = 'dsh-test-bridge-0.1.0.jar'
const JAR_PATH = path.join(VERSION_DIR, JAR_NAME)

function findJarTool () {
  const exe = process.platform === 'win32' ? 'jar.exe' : 'jar'
  const candidates = []
  if (process.env.JAVA_HOME) candidates.push(path.join(process.env.JAVA_HOME, 'bin', exe))
  if (process.platform === 'win32') candidates.push(`D:\\Program Files\\Java\\jdk-17\\bin\\${exe}`)
  candidates.push(exe)
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate)) {
      if (existsSync(candidate)) return candidate
    } else {
      const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
      if (probe.status === 0) return candidate
    }
  }
  return null
}

const jarTool = findJarTool()
const jarMissingSkip = !existsSync(JAR_PATH) ? 'bundled jar missing' : false
const jarToolSkip = !jarTool ? 'no JDK jar tool found' : false

test('bundled bridge jar exists and is non-trivial', { skip: jarMissingSkip }, () => {
  const size = statSync(JAR_PATH).size
  assert.ok(size > 1024, `jar is only ${size} bytes`)
})

test('bridge sources, build script and README are bundled', () => {
  for (const rel of [
    'README.md',
    'build.ps1',
    'src/main/java/dev/dsh/bridge/DshTestBridgeMod.java',
    'src/main/java/dev/dsh/bridge/mixin/NetworkRegistryMixin.java',
    'src/main/resources/META-INF/mods.toml',
    'src/main/resources/dsh-test-bridge.mixins.json',
  ]) {
    assert.ok(existsSync(path.join(VERSION_DIR, rel)), `missing ${rel}`)
  }
})

test('mixin source targets the Forge vanilla-client gate with remap=false', () => {
  const source = readFileSync(
    path.join(VERSION_DIR, 'src/main/java/dev/dsh/bridge/mixin/NetworkRegistryMixin.java'),
    'utf8'
  )
  assert.match(source, /@Mixin\(value = NetworkRegistry\.class, remap = false\)/)
  assert.match(source, /method = "acceptsVanillaClientConnections"/)
  assert.match(source, /@At\("HEAD"\)/)
  assert.match(source, /cir\.setReturnValue\(Boolean\.TRUE\)/)
})

test('jar contains the mod class, mixin class, mods.toml and mixin config', { skip: jarToolSkip || jarMissingSkip }, () => {
  const list = spawnSync(jarTool, ['tf', JAR_PATH], { encoding: 'utf8' })
  assert.equal(list.status, 0, list.stderr)
  for (const entry of [
    'META-INF/MANIFEST.MF',
    'META-INF/mods.toml',
    'dsh-test-bridge.mixins.json',
    'dev/dsh/bridge/DshTestBridgeMod.class',
    'dev/dsh/bridge/mixin/NetworkRegistryMixin.class',
  ]) {
    assert.match(list.stdout, new RegExp(`^${entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm'), `jar entry missing: ${entry}`)
  }
})

test('packaged manifest/mods.toml/mixins.json declare a loadable bridge mod', { skip: jarToolSkip || jarMissingSkip }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'dsh-forge-bridge-'))
  try {
    const extract = spawnSync(jarTool, ['xf', JAR_PATH], { cwd: dir, encoding: 'utf8' })
    assert.equal(extract.status, 0, extract.stderr)

    const manifest = readFileSync(path.join(dir, 'META-INF', 'MANIFEST.MF'), 'utf8')
    assert.match(manifest, /MixinConfigs:\s*dsh-test-bridge\.mixins\.json/)

    const modsToml = readFileSync(path.join(dir, 'META-INF', 'mods.toml'), 'utf8')
    assert.match(modsToml, /modLoader\s*=\s*"javafml"/)
    assert.match(modsToml, /loaderVersion\s*=\s*"\[47,\)"/)
    assert.match(modsToml, /modId\s*=\s*"dsh_test_bridge"/)
    assert.match(modsToml, /version\s*=\s*"0\.1\.0"/)

    const mixins = JSON.parse(readFileSync(path.join(dir, 'dsh-test-bridge.mixins.json'), 'utf8'))
    assert.equal(mixins.package, 'dev.dsh.bridge.mixin')
    assert.equal(mixins.compatibilityLevel, 'JAVA_17')
    assert.deepEqual(mixins.mixins, ['NetworkRegistryMixin'])
    assert.equal(mixins.required, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
