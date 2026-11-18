import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { connect, createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { test } from 'node:test';

import { inferServerProfile, ServerManager } from '../lib/server.js';
import { requiredJavaMajor, scanInstalledJavas } from '../lib/versions.js';

// Isolated dev-test server directory. Recreated from the user's vanilla jar if
// it was cleaned from .tmp (only under .tmp; never the shared 25565 server).
const SERVER_DIR = 'D:\\Minecraft\\dsh-mc\\.tmp\\server-sdev';
const SERVER_JAR = join(SERVER_DIR, 'server.jar');

const PORT = 25566;
const RCON_PORT = 25576;
const RCON_PASSWORD = 'sdevpass';

// Multi-loader/multi-version fixtures are built as COPIES under .tmp only.
// The user's original D:\Minecraft\数据包\_mw_server is never modified or started.
const MV_ROOT = 'D:\\Minecraft\\dsh-mc\\.tmp\\mvtest';
const USER_MW = 'D:\\Minecraft\\数据包\\_mw_server';
const USER_VANILLA_JAR = join(USER_MW, 'server-1.20.1.jar');
const USER_FABRIC_DIR = join(USER_MW, 'fp-1.20.1');
const USER_FORGE_DIR = join(USER_MW, 'forge-1.20.1');
const HAS_VANILLA_JAR = existsSync(USER_VANILLA_JAR);
const HAS_FABRIC_ENV = existsSync(join(USER_FABRIC_DIR, 'fabric-server-launch.jar'));
const HAS_FORGE_ENV = existsSync(join(USER_FORGE_DIR, 'run.bat'));
// The rich jar-mode lifecycle test can run if we still have either the old
// prepared dir or the user's vanilla jar (used to recreate it on demand).
const HAS_SERVER_JAR = existsSync(SERVER_JAR) || HAS_VANILLA_JAR;

// Isolated ports (25620+) so we never fight the user/Lead test servers
// (25565/25575/25585+/25599+) or each other.
const FABRIC_PORT = 25620;
const FABRIC_RCON_PORT = 25621;
const VANILLA_PORT = 25622;
const VANILLA_RCON_PORT = 25623;
const SCRIPT_PORT = 25624;
const SCRIPT_RCON_PORT = 25625;
const FORGE_PORT = 25626;
const FORGE_RCON_PORT = 25627;

// MC 1.7.10-26.x version matrix fixtures (Lead-provided; a fixture may be absent
// while still downloading, in which case that version is skipped rather than failed).
const VER_SERVERS = 'D:\\Minecraft\\dsh-mc\\.tmp\\ver-servers';
const VER_COPIES = 'D:\\Minecraft\\dsh-mc\\.tmp\\ver-copies';
const VER_PORT_BASE = 25720;
const VER_RCON_PORT_BASE = 25740;
const VERSION_MATRIX = [
  { version: '1.7.10', javaMajor: 8, memoryMb: 1024 },
  { version: '1.12.2', javaMajor: 8, memoryMb: 1024 },
  { version: '1.13.2', javaMajor: 8, memoryMb: 1024 },
  { version: '1.14.4', javaMajor: 8, memoryMb: 1024 },
  { version: '1.16.5', javaMajor: 8, memoryMb: 1024 },
  { version: '1.18.2', javaMajor: 17, memoryMb: 1320 },
  { version: '1.19.4', javaMajor: 17, memoryMb: 1320 },
  { version: '26.3', javaMajor: 25, memoryMb: 1320 },
];
// 26.3 compat fixture (vanilla 26.3 defaults to white-list=true). Fixtures may
// live in either the version matrix dir or the compat dir depending on cleanup.
const COMPAT_SERVERS = 'D:\\Minecraft\\dsh-mc\\.tmp\\compat-servers';
const COMPAT_263_JAR = join(COMPAT_SERVERS, '26.3', 'server.jar');
const HAS_COMPAT_263 = existsSync(COMPAT_263_JAR) || existsSync(join(VER_SERVERS, '26.3', 'server.jar'));

/** Resolve a version fixture dir from the matrix dir or the compat dir. */
function versionFixtureDir(version) {
  for (const candidate of [join(VER_SERVERS, version), join(COMPAT_SERVERS, version)]) {
    if (existsSync(join(candidate, 'server.jar'))) return candidate;
  }
  return null;
}

const AVAILABLE_VERSIONS = VERSION_MATRIX.filter((entry) => versionFixtureDir(entry.version) !== null);
const AVAILABLE_VERSION_MAP = new Map(AVAILABLE_VERSIONS.map((entry) => [entry.version, entry]));
const JAVA8_ENTRY = (() => {
  try {
    return scanInstalledJavas().find((entry) => entry.major === 8) ?? null;
  } catch {
    return null;
  }
})();
const JAVA25_ENTRY = (() => {
  try {
    return scanInstalledJavas().find((entry) => entry.major === 25) ?? null;
  } catch {
    return null;
  }
})();

function versionPorts(entry) {
  const index = VERSION_MATRIX.indexOf(entry);
  return { port: VER_PORT_BASE + index, rconPort: VER_RCON_PORT_BASE + index };
}

const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms));

function freePort() {
  return new Promise((resolvePort, rejectPort) => {
    const server = createServer();
    server.once('error', rejectPort);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolvePort(port));
    });
  });
}

async function twoFreePorts() {
  const first = await freePort();
  let second = await freePort();
  while (second === first) second = await freePort();
  return [first, second];
}

function tcpConnectable(port, timeoutMs = 700) {
  return new Promise((resolveProbe) => {
    const socket = connect({ host: '127.0.0.1', port });
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      resolveProbe(value);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function waitUntil(predicate, timeoutMs = 10000, intervalMs = 200) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      if (await predicate()) return true;
    } catch {
      // treat transient probe failures as "not yet"
    }
    if (Date.now() > deadline) return false;
    await sleep(intervalMs);
  }
}

/** Does a process with this pid still exist? (tasklist works for any Windows process). */
function processExists(pid) {
  const value = Number(pid);
  if (!Number.isInteger(value) || value <= 0) return false;
  const result = spawnSync('tasklist', ['/FI', `PID eq ${value}`, '/NH'], { encoding: 'utf8', windowsHide: true });
  if (result.status !== 0) return false;
  return String(result.stdout ?? '').includes(String(value));
}

/** Count node.exe processes whose command line contains the unique marker. */
function markerProcessCount(marker) {
  const script = `@(Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' }).Count`;
  const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
  if (result.status !== 0) return -1;
  const parsed = Number.parseInt(String(result.stdout ?? '').trim(), 10);
  return Number.isNaN(parsed) ? -1 : parsed;
}

function killMarkerProcesses(marker) {
  const script = `Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  });
}

function createTempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort cleanup
    }
  });
  return dir;
}

/** Write a fake gradlew.bat that never becomes ready (used for timeout tests). */
function writeFakeGradlew(projectDir, lines) {
  writeFileSync(join(projectDir, 'gradlew.bat'), `${lines.join('\r\n')}\r\n`, 'utf8');
}

// ---------------------------------------------------------------------------
// Multi-loader / multi-version fixtures: .tmp copies with junctions to the
// user's read-only libraries/.fabric data (never written by these tests).
// ---------------------------------------------------------------------------

function ensureDirLocal(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** Hardlink a file (cheap, same volume) with a copy fallback. */
function linkOrCopyFile(source, dest) {
  ensureDirLocal(dirname(dest));
  if (existsSync(dest)) return dest;
  try {
    linkSync(source, dest);
  } catch {
    copyFileSync(source, dest);
  }
  return dest;
}

/** Create a directory junction so no library data is copied. */
function ensureJunction(linkPath, targetPath) {
  if (existsSync(linkPath)) return linkPath;
  ensureDirLocal(dirname(linkPath));
  symlinkSync(targetPath, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
  return linkPath;
}

function writeServerProperties(file, entries) {
  const lines = [
    '#Minecraft server properties (dsh multiversion test copy)',
    ...Object.entries(entries).map(([key, value]) => `${key}=${value}`),
    '',
  ];
  writeFileSync(file, lines.join('\n'), 'utf8');
}

/** Shared test properties: flat/fast world so starts stay short. */
function baseTestProperties(entries) {
  return {
    'server-ip': '127.0.0.1',
    'level-name': 'world',
    'level-type': 'minecraft\\:flat',
    'level-seed': '1',
    'view-distance': '4',
    'simulation-distance': '4',
    'max-players': '5',
    'spawn-protection': '0',
    'online-mode': 'false',
    'enable-rcon': 'true',
    ...entries,
  };
}

/** Recreate the .tmp/server-sdev lifecycle fixture if .tmp was cleaned. */
function ensureLegacyServerDir() {
  if (existsSync(SERVER_JAR)) return SERVER_DIR;
  if (!HAS_VANILLA_JAR) return null;
  ensureDirLocal(SERVER_DIR);
  linkOrCopyFile(USER_VANILLA_JAR, SERVER_JAR);
  writeFileSync(join(SERVER_DIR, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(
    join(SERVER_DIR, 'server.properties'),
    baseTestProperties({
      'server-port': String(PORT),
      'rcon.port': String(RCON_PORT),
      'rcon.password': RCON_PASSWORD,
      'enable-command-block': 'true',
      motd: 'dsh devtest sdev',
    }),
  );
  return SERVER_DIR;
}

/** Copy of fp-1.20.1: fabric launcher + server.jar hardlinked, libraries junctioned. */
function prepareFabricCopy() {
  if (!HAS_FABRIC_ENV) return null;
  const dir = ensureDirLocal(join(MV_ROOT, 'fabric-1.20.1'));
  ensureJunction(join(dir, 'libraries'), join(USER_FABRIC_DIR, 'libraries'));
  linkOrCopyFile(join(USER_FABRIC_DIR, 'fabric-server-launch.jar'), join(dir, 'fabric-server-launch.jar'));
  linkOrCopyFile(join(USER_FABRIC_DIR, 'server.jar'), join(dir, 'server.jar'));
  const cacheSource = join(USER_FABRIC_DIR, '.fabric');
  if (existsSync(cacheSource)) {
    cpSync(cacheSource, join(dir, '.fabric'), { recursive: true, force: false, errorOnExist: false });
  }
  ensureDirLocal(join(dir, 'mods'));
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(
    join(dir, 'server.properties'),
    baseTestProperties({
      'server-port': String(FABRIC_PORT),
      'rcon.port': String(FABRIC_RCON_PORT),
      'rcon.password': 'mwtest',
      // must be forced to true by ServerManager
      'enable-rcon': 'false',
      motd: 'dsh fabric multiversion test',
    }),
  );
  return dir;
}

/** Vanilla 1.20.1 server dir whose jar lives OUTSIDE it (..\server-1.20.1.jar). */
function prepareVanillaJarCopy() {
  if (!HAS_VANILLA_JAR) return null;
  const dir = ensureDirLocal(join(MV_ROOT, 'vanilla-1.20.1'));
  linkOrCopyFile(USER_VANILLA_JAR, join(MV_ROOT, 'server-1.20.1.jar'));
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(
    join(dir, 'server.properties'),
    baseTestProperties({
      'server-port': String(VANILLA_PORT),
      'rcon.port': String(VANILLA_RCON_PORT),
      'rcon.password': 'vtestpass',
      'enable-rcon': 'false',
      'online-mode': 'true',
      motd: 'dsh vanilla external jar test',
    }),
  );
  return dir;
}

/** Script mode: installer-style run.bat that actually launches the vanilla jar. */
function prepareScriptStubCopy() {
  if (!HAS_VANILLA_JAR) return null;
  const dir = ensureDirLocal(join(MV_ROOT, 'script-stub'));
  linkOrCopyFile(USER_VANILLA_JAR, join(MV_ROOT, 'server-1.20.1.jar'));
  writeFileSync(
    join(dir, 'run.bat'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      'java -Xmx1024M -jar "..\\server-1.20.1.jar" %*',
      // Forge installer scripts end with `pause`; with stdin ignored it must not block shutdown.
      'pause',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(
    join(dir, 'server.properties'),
    baseTestProperties({
      'server-port': String(SCRIPT_PORT),
      'rcon.port': String(SCRIPT_RCON_PORT),
      'rcon.password': 'scriptpass',
      motd: 'dsh script stub test',
    }),
  );
  return dir;
}

/** Copy of forge-1.20.1: run.bat/run.sh + user_jvm_args copied, libraries junctioned. */
function prepareForgeCopy() {
  if (!HAS_FORGE_ENV) return null;
  const dir = ensureDirLocal(join(MV_ROOT, 'forge-1.20.1'));
  ensureJunction(join(dir, 'libraries'), join(USER_FORGE_DIR, 'libraries'));
  for (const name of ['run.bat', 'run.sh']) {
    const source = join(USER_FORGE_DIR, name);
    if (existsSync(source)) copyFileSync(source, join(dir, name));
  }
  writeFileSync(join(dir, 'user_jvm_args.txt'), '-Xmx1320M\n-Xms512M\n', 'utf8');
  ensureDirLocal(join(dir, 'mods'));
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(
    join(dir, 'server.properties'),
    baseTestProperties({
      'server-port': String(FORGE_PORT),
      'rcon.port': String(FORGE_RCON_PORT),
      'rcon.password': 'forgepass',
      'online-mode': 'false',
      gamemode: 'creative',
      motd: 'dsh forge script multiversion test',
    }),
  );
  return dir;
}

/**
 * Copy one version fixture to .tmp/ver-copies/<version> (hardlinked server.jar)
 * with dedicated matrix ports + a flat fast world so starts stay short.
 */
function prepareVersionCopy(entry) {
  const { port, rconPort } = versionPorts(entry);
  const fixtureDir = versionFixtureDir(entry.version);
  if (!fixtureDir) throw new Error(`no fixture jar for MC ${entry.version}`);
  const dir = ensureDirLocal(join(VER_COPIES, entry.version));
  linkOrCopyFile(join(fixtureDir, 'server.jar'), join(dir, 'server.jar'));
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  const legacyFlat = /^1\.(?:7|8|9|10|11|12)(?:\.|$)/.test(entry.version);
  writeServerProperties(join(dir, 'server.properties'), {
    'server-ip': '127.0.0.1',
    'server-port': String(port),
    'rcon.port': String(rconPort),
    'rcon.password': 'verpass',
    'enable-rcon': 'true',
    'online-mode': 'false',
    'level-name': 'world',
    'level-type': legacyFlat ? 'FLAT' : 'minecraft\\:flat',
    'level-seed': '1',
    'view-distance': '4',
    'max-players': '5',
    'spawn-protection': '0',
    motd: `dsh version matrix ${entry.version}`,
  });
  return { dir, port, rconPort };
}

async function startCapture(manager, options) {
  return manager.start(options).then(
    (value) => ({ ok: true, value }),
    (error) => ({ ok: false, error }),
  );
}

test('status/logTail/command/stop on a fresh manager (no server)', async () => {
  const manager = new ServerManager();
  assert.equal(manager.active, null);
  assert.equal(manager.logPath, null);

  const status = manager.status();
  assert.equal(status.active, false);
  assert.equal(status.ready, false);

  assert.deepEqual(manager.logTail(), []);
  assert.deepEqual(manager.logTail(5), []);
  assert.deepEqual(manager.logTail(0), []);

  await assert.rejects(manager.command('list'), /not running/i);

  const stopped = await manager.stop();
  assert.equal(stopped.stopped, false);
  assert.equal(stopped.alreadyStopped, true);
  assert.equal(stopped.pid, null);

  // stopping twice is still fine
  assert.equal((await manager.stop()).alreadyStopped, true);
});

test('start() fails clearly when directories/jars are missing', { timeout: 60000 }, async (t) => {
  const root = createTempDir(t, 'dsh-sdev-missing-');
  const manager = new ServerManager();

  const emptyServerDir = join(root, 'empty-server');
  mkdirSync(emptyServerDir, { recursive: true });
  await assert.rejects(
    manager.start({ mode: 'jar', serverDir: emptyServerDir, port: PORT, rconPort: RCON_PORT, timeoutMs: 3000 }),
    (error) => /no server jar found/i.test(error.message) && error.message.includes(emptyServerDir),
  );
  assert.equal(manager.active, null);
  assert.equal(manager.status().active, false);

  await assert.rejects(
    manager.start({ mode: 'jar', serverDir: join(root, 'not-there'), timeoutMs: 3000 }),
    /serverDir not found/i,
  );

  const projectDir = join(root, 'no-gradle-project');
  mkdirSync(projectDir, { recursive: true });
  await assert.rejects(
    manager.start({ mode: 'gradle', projectDir, port: PORT, rconPort: RCON_PORT, timeoutMs: 3000 }),
    /no gradlew\.bat found/i,
  );
  assert.equal(manager.active, null);
});

test('gradle mode: startup timeout kills the process tree and reports the log tail', { timeout: 120000 }, async (t) => {
  const projectDir = createTempDir(t, 'dsh-sdev-gradle-');
  const runDir = join(projectDir, 'run');
  mkdirSync(runDir, { recursive: true });

  const marker = `DSH_SDEV_MARK_${process.pid}_${Date.now()}`;
  writeFileSync(join(projectDir, 'child-marker.mjs'), 'setTimeout(() => {}, 60000);\n', 'utf8');
  writeFakeGradlew(projectDir, [
    '@echo off',
    `start "" /b node child-marker.mjs ${marker}`,
    'echo Starting minecraft server version 1.20.1',
    'for /l %%i in (1,1,5100) do @echo filler-line-%%i',
    'ping -n 30 127.0.0.1 >nul',
  ]);

  const propertiesPath = join(runDir, 'server.properties');
  const originalProperties = 'motd=keep-me\nserver-port=1\n';
  writeFileSync(propertiesPath, originalProperties, 'utf8');

  const [port, rconPort] = await twoFreePorts();
  const manager = new ServerManager();
  try {
    const startResult = manager
      .start({
        mode: 'gradle',
        projectDir,
        task: 'runServer',
        port,
        rconPort,
        rconPassword: 'secret',
        timeoutMs: 7000,
        patchProperties: false,
      })
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

    const markerAppeared = await waitUntil(() => markerProcessCount(marker) > 0, 8000);
    const result = await startResult;

    assert.equal(result.ok, false, 'start() should reject when the server never becomes ready');
    const message = result.error.message;
    assert.match(message, /did not become ready within 7000ms/);
    assert.match(message, /pid \d+/);
    // The error must carry the last 30 log lines, i.e. the newest output.
    assert.match(message, /filler-line-5100/);
    assert.equal(markerAppeared, true, `gradlew child process (${marker}) should have been started`);

    assert.equal(manager.active, null);
    assert.equal(manager.status().active, false);

    // In-memory ring keeps at most 5000 lines, even though the full log is tee'd.
    const ring = manager.logTail(10000);
    assert.equal(ring.length, 5000);
    assert.ok(ring.some((line) => line.includes('filler-line-5100')), 'newest lines should be kept');
    assert.ok(ring.every((line) => !line.includes('Starting minecraft server version')), 'old lines should be evicted');

    // patchProperties:false must leave server.properties untouched and create no backup.
    assert.equal(readFileSync(propertiesPath, 'utf8'), originalProperties);
    assert.equal(existsSync(`${propertiesPath}.dsh-backup`), false);
    // eula.txt is always written into the detected run dir.
    assert.match(readFileSync(join(runDir, 'eula.txt'), 'utf8'), /eula=true/);

    // The tee'd log file exists even for a failed start and keeps the full output.
    const logPath = manager.logPath;
    assert.ok(logPath && existsSync(logPath));
    assert.match(readFileSync(logPath, 'utf8'), /Starting minecraft server version 1\.20\.1/);

    // The whole process tree (cmd.exe + batch + spawned node + ping) must be gone.
    const pid = Number((/pid (\d+)/.exec(message) ?? [])[1]);
    assert.ok(Number.isInteger(pid) && pid > 0, 'timeout error should mention the pid');
    assert.equal(await waitUntil(() => !processExists(pid), 20000), true, `gradle wrapper pid ${pid} should be dead`);
    assert.equal(
      await waitUntil(() => markerProcessCount(marker) === 0, 20000),
      true,
      'the child node process should be killed together with the tree',
    );
    assert.equal(await tcpConnectable(port), false);
  } finally {
    if (manager.active) {
      try {
        await manager.stop();
      } catch {
        // cleanup only
      }
    }
    killMarkerProcesses(marker);
  }
});

test('gradle mode: patches server.properties, preserves other keys and backs up once', { timeout: 120000 }, async (t) => {
  const projectDir = createTempDir(t, 'dsh-sdev-patch-');
  const runDir = join(projectDir, 'run');
  mkdirSync(runDir, { recursive: true });
  writeFakeGradlew(projectDir, [
    '@echo off',
    'echo booting fake gradle server',
    'ping -n 30 127.0.0.1 >nul',
  ]);

  const propertiesPath = join(runDir, 'server.properties');
  const originalProperties = [
    '# custom comment kept by dsh',
    'motd=keep this motd',
    'server-port=59999',
    'online-mode=true',
    'white-list=true',
    'enforce-whitelist=true',
    'enable-command-block=true',
    '',
  ].join('\n');
  writeFileSync(propertiesPath, originalProperties, 'utf8');

  const [port, rconPort] = await twoFreePorts();
  const manager = new ServerManager();
  try {
    const startResult = await manager
      .start({
        mode: 'gradle',
        projectDir,
        task: 'runServer',
        port,
        rconPort,
        rconPassword: 'sdevpass2',
        levelName: 'world',
        timeoutMs: 2500,
      })
      .then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }));

    assert.equal(startResult.ok, false);
    assert.match(startResult.error.message, /did not become ready within 2500ms/);
    assert.match(startResult.error.message, /booting fake gradle server/);

    const patched = readFileSync(propertiesPath, 'utf8');
    assert.match(patched, /^# custom comment kept by dsh$/m);
    assert.match(patched, /^motd=keep this motd$/m);
    assert.match(patched, /^online-mode=false$/m);
    assert.match(patched, /^enable-rcon=true$/m);
    assert.match(patched, new RegExp(`^rcon\\.port=${rconPort}$`, 'm'));
    assert.match(patched, new RegExp(`^rcon\\.password=sdevpass2$`, 'm'));
    assert.match(patched, new RegExp(`^server-port=${port}$`, 'm'));
    assert.match(patched, /^level-name=world$/m);
    assert.match(patched, /^enable-command-block=true$/m);
    // 26.3+ vanilla defaults white-list=true; mcdt_server must always force it off.
    assert.match(patched, /^white-list=false$/m);
    assert.match(patched, /^enforce-whitelist=false$/m);

    const backupPath = `${propertiesPath}.dsh-backup`;
    assert.ok(existsSync(backupPath), 'first patch should create server.properties.dsh-backup');
    assert.equal(readFileSync(backupPath, 'utf8'), originalProperties);

    assert.equal(manager.active, null);
  } finally {
    if (manager.active) {
      try {
        await manager.stop();
      } catch {
        // cleanup only
      }
    }
  }
});

test(
  'jar mode: real 1.20.1 server start -> status -> RCON -> logTail -> stop',
  { skip: !HAS_SERVER_JAR, timeout: 300000 },
  async () => {
    ensureLegacyServerDir();
    const manager = new ServerManager();
    try {
      // --- before start ---
      assert.equal(manager.active, null);
      assert.equal(manager.status().active, false);
      await assert.rejects(manager.command('list'), /not running/i);

      const propertiesPath = join(SERVER_DIR, 'server.properties');
      const backupPath = `${propertiesPath}.dsh-backup`;
      const backupExistedBefore = existsSync(backupPath);
      const originalProperties = readFileSync(propertiesPath, 'utf8');

      // --- start (auto mode must choose jar when serverDir holds a jar) ---
      const runInfo = await manager.start({
        mode: 'auto',
        serverDir: SERVER_DIR,
        port: PORT,
        rconPort: RCON_PORT,
        rconPassword: RCON_PASSWORD,
        memoryMb: 1024,
        timeoutMs: 180000,
      });

      assert.equal(runInfo.ready, true);
      assert.equal(runInfo.mode, 'jar');
      assert.equal(runInfo.dir, SERVER_DIR);
      assert.equal(runInfo.runDir, SERVER_DIR);
      assert.equal(runInfo.levelName, 'world');
      assert.equal(runInfo.worldDir, join(SERVER_DIR, 'world'));
      assert.ok(existsSync(runInfo.worldDir), 'worldDir should exist after a successful start');
      assert.ok(Number.isInteger(runInfo.pid) && runInfo.pid > 0);
      assert.equal(runInfo.port, PORT);
      assert.equal(runInfo.rconPort, RCON_PORT);
      assert.match(runInfo.logPath, /[\\/]logs[\\/]dsh-devtest-\d{8}-\d{6}(-\d+)?\.log$/);
      assert.ok(existsSync(runInfo.logPath), 'tee log file should exist');
      assert.equal(runInfo.version, '1.20.1');
      assert.equal(runInfo.loader, 'vanilla');
      assert.ok(!Number.isNaN(Date.parse(runInfo.startedAt)));

      // --- eula / server.properties patching ---
      assert.match(readFileSync(join(SERVER_DIR, 'eula.txt'), 'utf8'), /eula=true/);
      const patched = readFileSync(propertiesPath, 'utf8');
      assert.match(patched, /^online-mode=false$/m);
      assert.match(patched, /^enable-rcon=true$/m);
      assert.match(patched, new RegExp(`^rcon\\.port=${RCON_PORT}$`, 'm'));
      assert.match(patched, new RegExp(`^rcon\\.password=${RCON_PASSWORD}$`, 'm'));
      assert.match(patched, new RegExp(`^server-port=${PORT}$`, 'm'));
      assert.match(patched, /^level-name=world$/m);
      assert.match(patched, /^motd=dsh devtest sdev$/m);
      assert.match(patched, /^enable-command-block=true$/m);
      const backupPathAfterStart = `${propertiesPath}.dsh-backup`;
      assert.ok(existsSync(backupPathAfterStart), 'server.properties.dsh-backup should exist after patching');
      if (!backupExistedBefore) {
        // First patch ever: the untouched original file must be preserved.
        assert.equal(readFileSync(backupPathAfterStart, 'utf8'), originalProperties);
      } else {
        // Vanilla rewrites server.properties on boot, so a pre-existing backup
        // is intentionally NOT overwritten by later starts.
        assert.ok(readFileSync(backupPathAfterStart, 'utf8').length > 0);
      }

      // --- status ---
      const status = manager.status();
      assert.equal(status.active, true);
      assert.equal(status.ready, true);
      assert.equal(status.pid, runInfo.pid);
      assert.equal(status.mode, 'jar');
      assert.equal(status.dir, SERVER_DIR);
      assert.equal(status.runDir, SERVER_DIR);
      assert.equal(status.worldDir, join(SERVER_DIR, 'world'));
      assert.equal(status.levelName, 'world');
      assert.equal(status.port, PORT);
      assert.equal(status.rconPort, RCON_PORT);
      assert.equal(status.logPath, runInfo.logPath);
      assert.equal(status.startedAt, runInfo.startedAt);
      assert.equal(status.version, '1.20.1');
      assert.equal(status.loader, 'vanilla');
      assert.deepEqual(manager.active, runInfo);

      // --- must refuse to clash with an already-running server / port ---
      const secondManager = new ServerManager();
      await assert.rejects(
        secondManager.start({
          serverDir: SERVER_DIR,
          mode: 'jar',
          port: PORT,
          rconPort: RCON_PORT,
          rconPassword: RCON_PASSWORD,
          timeoutMs: 3000,
        }),
        /already in use/i,
      );
      assert.equal(secondManager.active, null);
      assert.notEqual(manager.active, null, 'the original manager must keep running');

      // --- real RCON commands ---
      const gametime = await manager.command('time query gametime');
      assert.equal(gametime.command, 'time query gametime');
      assert.equal(typeof gametime.response, 'string');
      assert.match(gametime.response, /time is \d+/i);
      assert.ok(Number.isFinite(gametime.ms) && gametime.ms >= 0);

      const listed = await manager.command('/list');
      assert.equal(listed.command, 'list', 'leading slash is stripped');
      assert.match(listed.response, /There are \d+ of a max of \d+ players online/i);

      // --- log tail: ring buffer, readiness line, tee'd file ---
      assert.deepEqual(manager.logTail(0), []);
      assert.equal(manager.logTail(5).length, 5);
      const tail = manager.logTail(500);
      assert.ok(tail.length > 0 && tail.length <= 500);
      assert.ok(tail.some((line) => line.includes('Done (')), 'logTail should include the readiness line');
      assert.ok(tail.some((line) => line.includes('Starting minecraft server version 1.20.1')));
      assert.ok(tail.some((line) => /RCON running on/.test(line)), 'logTail should include the RCON line');
      assert.match(readFileSync(runInfo.logPath, 'utf8'), /Done \(/);
      assert.equal(manager.logPath, runInfo.logPath);

      // --- stop via RCON (falls back to process-tree kill only if needed) ---
      const stopped = await manager.stop();
      assert.equal(stopped.mode, 'jar');
      assert.equal(stopped.pid, runInfo.pid);
      assert.equal(stopped.stopped, true);
      assert.equal(stopped.alreadyStopped, false);
      assert.equal(manager.active, null);
      assert.equal(manager.status().active, false);
      assert.equal(manager.status().ready, false);
      await assert.rejects(manager.command('list'), /not running/i);
      assert.equal((await manager.stop()).alreadyStopped, true);
      // Post-mortem tail stays readable after stop.
      assert.ok(manager.logTail(200).length > 0);

      // --- java exited, ports released, log file remains readable ---
      assert.equal(
        await waitUntil(() => !processExists(runInfo.pid), 20000),
        true,
        `java pid ${runInfo.pid} should have exited`,
      );
      assert.equal(
        await waitUntil(async () => !(await tcpConnectable(PORT)) && !(await tcpConnectable(RCON_PORT)), 20000),
        true,
        `ports ${PORT}/${RCON_PORT} should be released`,
      );
      assert.equal(await tcpConnectable(RCON_PORT), false);
      await sleep(150);
      assert.match(readFileSync(runInfo.logPath, 'utf8'), /Done \(/);
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

// ---------------------------------------------------------------------------
// Multi-loader / multi-version support: inference + fabric / script / jar
// (all fixtures are .tmp copies; user's _mw_server is never touched)
// ---------------------------------------------------------------------------

test('inferServerProfile() detects mode, loader and version from directory layout', async (t) => {
  const root = createTempDir(t, 'dsh-sdev-infer-');
  const makeDir = (relative) => ensureDirLocal(join(root, relative));

  // vanilla jar dir
  const vanillaDir = makeDir('vanilla-1.20.1');
  writeFileSync(join(vanillaDir, 'server.jar'), '');
  makeDir(join('vanilla-1.20.1', 'libraries', 'com', 'mojang'));
  let profile = inferServerProfile({ serverDir: vanillaDir });
  assert.equal(profile.mode, 'jar');
  assert.equal(profile.loader, 'vanilla');
  assert.equal(profile.version, '1.20.1');

  // explicit jar outside the server dir
  writeFileSync(join(root, 'server-1.20.6.jar'), '');
  const externalJarDir = makeDir('external-jar');
  profile = inferServerProfile({ serverDir: externalJarDir, jar: '..\\server-1.20.6.jar' });
  assert.equal(profile.mode, 'jar');
  assert.equal(profile.version, '1.20.6');
  assert.equal(profile.jarPath, join(root, 'server-1.20.6.jar'));

  // multi-version layout: no jar inside, version-matching jar next to the dir
  const multiVersionParent = makeDir('multi-version');
  writeFileSync(join(multiVersionParent, 'server-1.20.6.jar'), '');
  writeFileSync(join(multiVersionParent, 'server-1.21.1.jar'), '');
  const multiVersionDir = makeDir(join('multi-version', '1.20.6'));
  makeDir(join('multi-version', '1.20.6', 'libraries', 'com', 'mojang'));
  profile = inferServerProfile({ serverDir: multiVersionDir });
  assert.equal(profile.mode, 'jar');
  assert.equal(profile.version, '1.20.6');
  assert.equal(profile.jarPath, join(multiVersionParent, 'server-1.20.6.jar'));

  // fabric launcher
  const fabricDir = makeDir('fp-1.21.11');
  writeFileSync(join(fabricDir, 'fabric-server-launch.jar'), '');
  makeDir(join('fp-1.21.11', 'libraries', 'com', 'mojang'));
  profile = inferServerProfile({ serverDir: fabricDir });
  assert.equal(profile.mode, 'fabric');
  assert.equal(profile.loader, 'fabric');
  assert.equal(profile.version, '1.21.11');

  // quilt launcher runs like fabric but the loader must be reported as quilt
  const quiltDir = makeDir('quilt-1.21.1');
  writeFileSync(join(quiltDir, 'quilt-server-launch.jar'), '');
  writeFileSync(join(quiltDir, 'server.jar'), '');
  makeDir(join('quilt-1.21.1', 'libraries', 'com', 'mojang'));
  profile = inferServerProfile({ serverDir: quiltDir });
  assert.equal(profile.mode, 'fabric', 'quilt launcher is launched in fabric mode');
  assert.equal(profile.loader, 'quilt');
  assert.equal(profile.version, '1.21.1');
  assert.equal(basename(profile.jarPath), 'quilt-server-launch.jar');

  // forge installer script dir
  const forgeDir = makeDir('forge-1.20.1');
  writeFileSync(join(forgeDir, 'run.bat'), '');
  makeDir(join('forge-1.20.1', 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.28'));
  profile = inferServerProfile({ serverDir: forgeDir });
  assert.equal(profile.mode, 'script');
  assert.equal(profile.loader, 'forge');
  assert.equal(profile.version, '1.20.1');

  // neoforge installer script dir (NeoForge 21.1.x maps to MC 1.21.1)
  const neoDir = makeDir('neoforge-server');
  writeFileSync(join(neoDir, 'run.bat'), '');
  makeDir(join('neoforge-server', 'libraries', 'net', 'neoforged', 'neoforge', '21.1.119'));
  profile = inferServerProfile({ serverDir: neoDir });
  assert.equal(profile.mode, 'script');
  assert.equal(profile.loader, 'neoforge');
  assert.equal(profile.version, '1.21.1', 'NeoForge 21.1.x must map back to MC 1.21.1');

  // gradle project
  const projectDir = makeDir('gradle-project');
  writeFileSync(join(projectDir, 'gradlew.bat'), '');
  ensureDirLocal(join(projectDir, 'run'));
  writeFileSync(join(projectDir, 'run', 'server.properties'), 'server-port=25650\n');
  profile = inferServerProfile({ projectDir });
  assert.equal(profile.mode, 'gradle');
  assert.equal(profile.runDir, join(projectDir, 'run'));

  // nothing to infer (isolated dir: no jar inside and none next to it)
  const emptyRoot = createTempDir(t, 'dsh-sdev-infer-empty-');
  const emptyDir = ensureDirLocal(join(emptyRoot, 'empty'));
  profile = inferServerProfile({ serverDir: emptyDir });
  assert.equal(profile.mode, null);
});

test('start() rejects unknown modes and missing mode-specific launch files', { timeout: 60000 }, async (t) => {
  const root = createTempDir(t, 'dsh-sdev-modes-');
  const manager = new ServerManager();

  await assert.rejects(manager.start({ mode: 'docker', serverDir: root }), /unknown server mode/i);
  await assert.rejects(manager.start({ mode: 'fabric' }), /serverDir is required for fabric mode/i);
  await assert.rejects(manager.start({ mode: 'script', serverDir: root }), /no run\.bat\/run\.sh found/i);
  await assert.rejects(manager.start({ mode: 'fabric', serverDir: root }), /no fabric-server-launch\.jar/i);
  await assert.rejects(manager.start({ mode: 'gradle', serverDir: root }), /projectDir is required for gradle mode/i);

  // ambiguous jars inside a jar-mode directory
  const ambiguous = ensureDirLocal(join(root, 'many-jars'));
  for (const name of ['a.jar', 'b.jar', 'c.jar']) writeFileSync(join(ambiguous, name), '');
  await assert.rejects(manager.start({ mode: 'jar', serverDir: ambiguous, timeoutMs: 3000 }), /multiple jars found/i);

  // RCON disabled on disk + patchProperties:false must fail clearly and fast
  const noRcon = ensureDirLocal(join(root, 'no-rcon'));
  writeFileSync(join(noRcon, 'run.bat'), '@echo off\r\n');
  writeServerProperties(join(noRcon, 'server.properties'), {
    'enable-rcon': 'false',
    'server-port': '25655',
    'rcon.port': '25656',
  });
  await assert.rejects(
    manager.start({ mode: 'script', serverDir: noRcon, patchProperties: false, timeoutMs: 3000 }),
    /RCON is disabled/i,
  );

  // a quilt/fabric launcher jar is never treated as a plain server jar
  const quiltOnly = ensureDirLocal(join(root, 'quilt-launcher-only-1.21.1'));
  writeFileSync(join(quiltOnly, 'quilt-server-launch.jar'), '');
  await assert.rejects(
    manager.start({ mode: 'jar', serverDir: quiltOnly, timeoutMs: 3000 }),
    /no server jar found/i,
  );
  assert.equal(manager.active, null);
});

test('script mode: startup timeout kills the cmd.exe -> java/node process tree', { timeout: 120000 }, async () => {
  const dir = ensureDirLocal(join(MV_ROOT, 'script-timeout'));
  const marker = `DSH_SDEV_SCRIPT_${process.pid}_${Date.now()}`;
  writeFileSync(join(dir, 'child-marker.mjs'), 'setTimeout(() => {}, 60000);\n', 'utf8');
  writeFileSync(
    join(dir, 'run.bat'),
    [
      '@echo off',
      'cd /d "%~dp0"',
      `start "" /b node child-marker.mjs ${marker}`,
      'echo Starting minecraft server version 1.20.1',
      'ping -n 30 127.0.0.1 >nul',
      '',
    ].join('\r\n'),
    'utf8',
  );
  writeFileSync(join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  writeServerProperties(join(dir, 'server.properties'), { motd: 'script timeout' });

  const [port, rconPort] = await twoFreePorts();
  const manager = new ServerManager();
  try {
    const result = await startCapture(manager, {
      serverDir: dir,
      mode: 'script',
      port,
      rconPort,
      rconPassword: 'secret',
      timeoutMs: 5000,
      patchProperties: false,
    });
    assert.equal(result.ok, false);
    assert.match(result.error.message, /did not become ready within 5000ms/);
    assert.match(result.error.message, /Starting minecraft server version 1\.20\.1/);
    const pid = Number((/pid (\d+)/.exec(result.error.message) ?? [])[1]);
    assert.ok(Number.isInteger(pid) && pid > 0);
    assert.equal(await waitUntil(() => !processExists(pid), 20000), true, `script wrapper pid ${pid} should be dead`);
    assert.equal(
      await waitUntil(() => markerProcessCount(marker) === 0, 20000),
      true,
      'the spawned child process should be killed together with the cmd tree',
    );
    assert.equal(manager.active, null);
  } finally {
    if (manager.active) {
      try {
        await manager.stop();
      } catch {
        // cleanup only
      }
    }
    killMarkerProcesses(marker);
  }
});

test(
  'jar mode: explicit jar outside serverDir + respects on-disk ports and password',
  { skip: !HAS_VANILLA_JAR, timeout: 300000 },
  async () => {
    const dir = prepareVanillaJarCopy();
    assert.ok(dir, 'vanilla 1.20.1 fixture should be prepared');
    const manager = new ServerManager();
    try {
      const runInfo = await manager.start({
        serverDir: dir,
        mode: 'auto',
        jar: '..\\server-1.20.1.jar',
        memoryMb: 1024,
        timeoutMs: 180000,
      });

      assert.equal(runInfo.mode, 'jar');
      assert.equal(runInfo.loader, 'vanilla');
      assert.equal(runInfo.version, '1.20.1');
      assert.equal(runInfo.port, VANILLA_PORT, 'port must come from the existing server.properties');
      assert.equal(runInfo.rconPort, VANILLA_RCON_PORT, 'rcon.port must come from the existing server.properties');
      assert.equal(runInfo.runDir, dir);
      assert.equal(runInfo.worldDir, join(dir, 'world'));
      assert.ok(existsSync(runInfo.logPath));
      assert.ok(existsSync(runInfo.worldDir), 'worldDir should exist after a successful start');

      const patched = readFileSync(join(dir, 'server.properties'), 'utf8');
      assert.match(patched, /^enable-rcon=true$/m, 'enable-rcon=false must be forced to true');
      assert.match(patched, /^online-mode=false$/m);
      assert.match(patched, new RegExp(`^server-port=${VANILLA_PORT}$`, 'm'));
      assert.match(patched, new RegExp(`^rcon\\.port=${VANILLA_RCON_PORT}$`, 'm'));
      assert.match(patched, /^rcon\.password=vtestpass$/m, 'the on-disk RCON password must be kept');

      // external jar really used: the tee'd log records the resolved command line
      assert.match(readFileSync(runInfo.logPath, 'utf8'), /-jar .*server-1\.20\.1\.jar/);

      // RCON works with the password taken from the properties file
      const listed = await manager.command('list');
      assert.match(listed.response, /players online/i);

      const status = manager.status();
      assert.equal(status.mode, 'jar');
      assert.equal(status.loader, 'vanilla');
      assert.equal(status.version, '1.20.1');
      assert.equal(status.port, VANILLA_PORT);
      assert.equal(status.rconPort, VANILLA_RCON_PORT);
      assert.equal(status.levelName, 'world');

      const stopped = await manager.stop();
      assert.equal(stopped.stopped, true);
      assert.equal(manager.active, null);
      assert.equal(
        await waitUntil(
          async () => !(await tcpConnectable(VANILLA_PORT)) && !(await tcpConnectable(VANILLA_RCON_PORT)),
          20000,
        ),
        true,
        'vanilla test ports should be released',
      );
      assert.equal(await tcpConnectable(VANILLA_RCON_PORT), false);

      // --- second start WITHOUT explicit jar: version-matching sibling jar is auto-discovered ---
      const autoInfo = await manager.start({ serverDir: dir, mode: 'auto', memoryMb: 1024, timeoutMs: 180000 });
      assert.equal(autoInfo.mode, 'jar');
      assert.equal(autoInfo.version, '1.20.1');
      assert.equal(autoInfo.port, VANILLA_PORT);
      assert.equal(typeof (await manager.command('list')).response, 'string');
      assert.equal((await manager.stop()).stopped, true);
      assert.equal(
        await waitUntil(async () => !(await tcpConnectable(VANILLA_RCON_PORT)), 20000),
        true,
        'vanilla test rcon port should be released after the auto-discovered jar start',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

test(
  'script mode: installer-style run.bat launches/stops a server (pause must not block)',
  { skip: !HAS_VANILLA_JAR, timeout: 300000 },
  async () => {
    const dir = prepareScriptStubCopy();
    assert.ok(dir, 'script stub fixture should be prepared');
    const manager = new ServerManager();
    try {
      const runInfo = await manager.start({ serverDir: dir, mode: 'auto', timeoutMs: 180000 });
      assert.equal(runInfo.mode, 'script');
      assert.equal(runInfo.loader, 'vanilla');
      assert.equal(runInfo.version, '1.20.1');
      assert.equal(runInfo.port, SCRIPT_PORT);
      assert.equal(runInfo.rconPort, SCRIPT_RCON_PORT);
      assert.match((await manager.command('list')).response, /players online/i);

      const stopped = await manager.stop();
      assert.equal(stopped.mode, 'script');
      assert.equal(stopped.stopped, true);
      assert.equal(manager.active, null);
      assert.equal(await waitUntil(() => !processExists(runInfo.pid), 20000), true, 'cmd.exe wrapper should exit');
      assert.equal(
        await waitUntil(
          async () => !(await tcpConnectable(SCRIPT_PORT)) && !(await tcpConnectable(SCRIPT_RCON_PORT)),
          20000,
        ),
        true,
        'script test ports should be released',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

test(
  'fabric mode: fp-1.20.1 copy starts, respects on-disk ports/password and is detected as fabric',
  { skip: !HAS_FABRIC_ENV, timeout: 300000 },
  async () => {
    const dir = prepareFabricCopy();
    assert.ok(dir, 'fabric fixture should be prepared');
    const manager = new ServerManager();
    try {
      const runInfo = await manager.start({ serverDir: dir, mode: 'auto', memoryMb: 1024, timeoutMs: 180000 });

      assert.equal(runInfo.mode, 'fabric');
      assert.equal(runInfo.loader, 'fabric', 'log should correct the loader to fabric');
      assert.equal(runInfo.version, '1.20.1');
      assert.equal(runInfo.port, FABRIC_PORT, 'port must come from the existing server.properties');
      assert.equal(runInfo.rconPort, FABRIC_RCON_PORT, 'rcon.port must come from the existing server.properties');
      assert.equal(runInfo.runDir, dir);
      assert.equal(runInfo.worldDir, join(dir, 'world'));
      assert.equal(runInfo.levelName, 'world');
      assert.ok(existsSync(runInfo.worldDir));
      assert.ok(manager.logTail(500).some((line) => /Fabric Loader/i.test(line)), 'log should mention Fabric Loader');

      const patched = readFileSync(join(dir, 'server.properties'), 'utf8');
      assert.match(patched, /^enable-rcon=true$/m, 'enable-rcon=false must be forced to true');
      assert.match(patched, /^rcon\.password=mwtest$/m, 'the on-disk RCON password must be kept');
      assert.match(patched, new RegExp(`^server-port=${FABRIC_PORT}$`, 'm'));

      // RCON works with the on-disk password, without passing any option
      const listed = await manager.command('list');
      assert.match(listed.response, /players online/i);

      const status = manager.status();
      assert.equal(status.mode, 'fabric');
      assert.equal(status.loader, 'fabric');
      assert.equal(status.version, '1.20.1');
      assert.equal(status.port, FABRIC_PORT);
      assert.equal(status.rconPort, FABRIC_RCON_PORT);
      assert.equal(status.runDir, dir);
      assert.equal(status.worldDir, join(dir, 'world'));
      assert.equal(status.levelName, 'world');
      assert.equal(status.logPath, runInfo.logPath);

      // A second manager must preflight the ON-DISK ports even without explicit options.
      const clash = new ServerManager();
      await assert.rejects(clash.start({ serverDir: dir, mode: 'auto' }), /already in use/i);
      assert.equal(clash.active, null);
      assert.notEqual(manager.active, null);

      const stopped = await manager.stop();
      assert.equal(stopped.stopped, true);
      assert.equal(manager.active, null);
      assert.equal(
        await waitUntil(
          async () => !(await tcpConnectable(FABRIC_PORT)) && !(await tcpConnectable(FABRIC_RCON_PORT)),
          20000,
        ),
        true,
        'fabric test ports should be released',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

test(
  'script mode: real Forge 1.20.1 run.bat copy starts and is detected as forge',
  { skip: !HAS_FORGE_ENV, timeout: 300000 },
  async () => {
    const dir = prepareForgeCopy();
    assert.ok(dir, 'forge fixture should be prepared');
    const manager = new ServerManager();
    try {
      const runInfo = await manager.start({ serverDir: dir, mode: 'auto', timeoutMs: 240000 });
      assert.equal(runInfo.mode, 'script');
      assert.equal(runInfo.loader, 'forge');
      assert.equal(runInfo.version, '1.20.1');
      assert.equal(runInfo.port, FORGE_PORT);
      assert.equal(runInfo.rconPort, FORGE_RCON_PORT);
      assert.match((await manager.command('list')).response, /players online/i);

      const stopped = await manager.stop();
      assert.equal(stopped.stopped, true);
      assert.equal(await waitUntil(() => !processExists(runInfo.pid), 30000), true, 'Forge cmd.exe wrapper should exit');
      assert.equal(
        await waitUntil(
          async () => !(await tcpConnectable(FORGE_PORT)) && !(await tcpConnectable(FORGE_RCON_PORT)),
          20000,
        ),
        true,
        'forge test ports should be released',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

// ---------------------------------------------------------------------------
// MC 1.7.10 - 26.x version matrix: jar prioritisation, version inference,
// automatic Java selection and Java-mismatch retry
// ---------------------------------------------------------------------------

test('jar selection: legacy Forge universal / Paper / vanilla priority + version inference', async (t) => {
  const root = createTempDir(t, 'dsh-sdev-jarrank-');

  // 1.7.10 legacy install: minecraft_server + Forge universal -> Forge jar wins
  const legacy = ensureDirLocal(join(root, 'legacy-forge-1.7.10'));
  writeFileSync(join(legacy, 'minecraft_server.1.7.10.jar'), '');
  writeFileSync(join(legacy, 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar'), '');
  let profile = inferServerProfile({ serverDir: legacy });
  assert.equal(profile.mode, 'jar');
  assert.equal(basename(profile.jarPath), 'forge-1.7.10-10.13.4.1614-1.7.10-universal.jar');
  assert.equal(profile.loader, 'forge');
  assert.equal(profile.version, '1.7.10');
  assert.equal(profile.versionSource, 'filename');

  // 1.12.2 Forge install: plain forge jar wins over minecraft_server jar
  const forge1122 = ensureDirLocal(join(root, 'forge-1.12.2'));
  writeFileSync(join(forge1122, 'minecraft_server.1.12.2.jar'), '');
  writeFileSync(join(forge1122, 'forge-1.12.2-14.23.5.2860.jar'), '');
  profile = inferServerProfile({ serverDir: forge1122 });
  assert.equal(basename(profile.jarPath), 'forge-1.12.2-14.23.5.2860.jar');
  assert.equal(profile.version, '1.12.2');
  assert.equal(profile.loader, 'forge');

  // Paper shard beats a generic server.jar
  const paperDir = ensureDirLocal(join(root, 'paper-1.21.4-232'));
  writeFileSync(join(paperDir, 'server.jar'), '');
  writeFileSync(join(paperDir, 'paper-1.21.4-232.jar'), '');
  profile = inferServerProfile({ serverDir: paperDir });
  assert.equal(basename(profile.jarPath), 'paper-1.21.4-232.jar');
  assert.equal(profile.version, '1.21.4');
  assert.equal(profile.loader, 'paper');

  // Installer jars are never launched directly
  const installerOnly = ensureDirLocal(join(root, 'installer-only-1.12.2'));
  writeFileSync(join(installerOnly, 'forge-1.12.2-14.23.5.2860-installer.jar'), '');
  profile = inferServerProfile({ serverDir: installerOnly });
  assert.equal(profile.mode, null);
});

test(
  'version.json inference + Java requirement table for matrix fixtures',
  { skip: AVAILABLE_VERSIONS.length === 0 },
  async () => {
    for (const entry of AVAILABLE_VERSIONS) {
      const fixtureDir = versionFixtureDir(entry.version);
      const profile = inferServerProfile({ serverDir: fixtureDir });
      assert.equal(profile.mode, 'jar', `${entry.version}: mode`);
      assert.equal(profile.version, entry.version, `${entry.version}: inferred version`);
      assert.ok(
        ['version.json', 'filename', 'dirname', 'logs'].includes(profile.versionSource),
        `${entry.version}: unexpected versionSource ${profile.versionSource}`,
      );
      assert.equal(requiredJavaMajor(entry.version), entry.javaMajor, `${entry.version}: required Java major`);
    }
  },
);

test(
  'multi-version real matrix: start -> status(version/javaPath/javaMajor) -> RCON -> stop',
  { skip: AVAILABLE_VERSIONS.length === 0, timeout: 1800000 },
  async (t) => {
    const manager = new ServerManager();
    const results = [];
    try {
      for (const entry of AVAILABLE_VERSIONS) {
        const { dir, port, rconPort } = prepareVersionCopy(entry);
        const startedAt = Date.now();
        let runInfo = null;
        try {
          runInfo = await manager.start({
            serverDir: dir,
            mode: 'auto',
            memoryMb: entry.memoryMb,
            timeoutMs: 240000,
          });
        } catch (error) {
          throw new Error(`[${entry.version}] start failed: ${error.message}`);
        }
        try {
          assert.equal(runInfo.ready, true, `${entry.version}: ready`);
          assert.equal(runInfo.version, entry.version, `${entry.version}: version`);
          assert.ok(runInfo.versionSource, `${entry.version}: versionSource present`);
          assert.equal(runInfo.javaMajor, entry.javaMajor, `${entry.version}: javaMajor (${runInfo.javaPath})`);
          assert.ok(existsSync(runInfo.javaPath), `${entry.version}: javaPath exists`);
          assert.equal(runInfo.port, port);
          assert.equal(runInfo.rconPort, rconPort);

          const status = manager.status();
          assert.equal(status.active, true);
          assert.equal(status.ready, true);
          assert.equal(status.mode, 'jar');
          assert.equal(status.version, entry.version);
          assert.equal(status.versionSource, runInfo.versionSource);
          assert.equal(status.javaMajor, entry.javaMajor);
          assert.equal(status.javaPath, runInfo.javaPath);
          assert.equal(status.runDir, dir);
          assert.ok(status.logPath && existsSync(status.logPath));

          const listed = await manager.command('list');
          assert.match(listed.response, /players online|There are/i, `${entry.version}: RCON list response`);

          const stopped = await manager.stop();
          assert.equal(stopped.stopped, true, `${entry.version}: stop`);
          assert.equal(manager.active, null);
          assert.equal(
            await waitUntil(() => !processExists(runInfo.pid), 30000),
            true,
            `${entry.version}: java pid should exit`,
          );
          assert.equal(
            await waitUntil(async () => !(await tcpConnectable(port)) && !(await tcpConnectable(rconPort)), 30000),
            true,
            `${entry.version}: ports should be released`,
          );
          results.push({
            version: entry.version,
            javaMajor: runInfo.javaMajor,
            javaPath: basename(runInfo.javaPath),
            versionSource: runInfo.versionSource,
            ms: Date.now() - startedAt,
          });
        } finally {
          if (manager.active) {
            try {
              await manager.stop();
            } catch {
              // cleanup only
            }
          }
        }
      }
      for (const result of results) {
        t.diagnostic(
          `${result.version}: Java ${result.javaMajor} (${result.javaPath}), versionSource=${result.versionSource}, ${result.ms}ms`,
        );
      }
      t.diagnostic(`validated ${results.length} version(s); skipped (fixture missing): ${VERSION_MATRIX.filter((entry) => !AVAILABLE_VERSION_MAP.has(entry.version)).map((entry) => entry.version).join(', ') || 'none'}`);
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

test(
  'UnsupportedClassVersionError: automatically retries with the required Java',
  { skip: !AVAILABLE_VERSION_MAP.has('1.18.2') || !JAVA8_ENTRY, timeout: 400000 },
  async () => {
    const entry = VERSION_MATRIX.find((candidate) => candidate.version === '1.18.2');
    const { dir, port, rconPort } = prepareVersionCopy(entry);
    const manager = new ServerManager();
    try {
      // 1.18.2 requires Java 17 (class file 61); Java 8 must fail and be retried automatically.
      const runInfo = await manager.start({
        serverDir: dir,
        mode: 'auto',
        javaPath: JAVA8_ENTRY.path,
        memoryMb: 1320,
        timeoutMs: 240000,
      });
      assert.equal(runInfo.version, '1.18.2');
      assert.equal(runInfo.javaMajor, 17);
      assert.notEqual(runInfo.javaPath.toLowerCase(), JAVA8_ENTRY.path.toLowerCase());
      assert.ok(
        manager.logTail(4000).some((line) => /retrying startup with Java/i.test(line)),
        'a Java retry should be logged',
      );
      assert.match((await manager.command('list')).response, /players online|There are/i);
      assert.equal((await manager.stop()).stopped, true);
      assert.equal(
        await waitUntil(async () => !(await tcpConnectable(port)) && !(await tcpConnectable(rconPort)), 30000),
        true,
        'retry test ports should be released',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);

test(
  '26.3 whitelist: real start forces white-list=false / enforce-whitelist=false',
  { skip: !HAS_COMPAT_263 || !JAVA25_ENTRY, timeout: 300000 },
  async () => {
    const entry = VERSION_MATRIX.find((candidate) => candidate.version === '26.3');
    const { dir, port, rconPort } = prepareVersionCopy(entry);
    // Simulate vanilla 26.3 defaults (white-list=true) which would kick every test bot.
    const propertiesPath = join(dir, 'server.properties');
    writeFileSync(
      propertiesPath,
      `${readFileSync(propertiesPath, 'utf8')}white-list=true\nenforce-whitelist=true\n`,
      'utf8',
    );

    const manager = new ServerManager();
    try {
      const runInfo = await manager.start({ serverDir: dir, mode: 'auto', memoryMb: 1320, timeoutMs: 240000 });
      assert.equal(runInfo.version, '26.3');
      assert.equal(runInfo.javaMajor, 25, `26.3 must run on Java 25 (got ${runInfo.javaPath})`);

      const patched = readFileSync(propertiesPath, 'utf8');
      assert.match(patched, /^white-list=false$/m, 'white-list=true must be forced to false');
      assert.match(patched, /^enforce-whitelist=false$/m, 'enforce-whitelist=true must be forced to false');

      assert.match((await manager.command('list')).response, /players online|There are/i);
      assert.equal((await manager.stop()).stopped, true);
      assert.equal(await waitUntil(() => !processExists(runInfo.pid), 30000), true, '26.3 java pid should exit');
      assert.equal(
        await waitUntil(async () => !(await tcpConnectable(port)) && !(await tcpConnectable(rconPort)), 30000),
        true,
        '26.3 test ports should be released',
      );
    } finally {
      if (manager.active) {
        try {
          await manager.stop();
        } catch {
          // cleanup only
        }
      }
    }
  },
);



