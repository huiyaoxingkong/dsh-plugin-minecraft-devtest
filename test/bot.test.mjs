// Real integration test for lib/bot.js.
//
// Four suites:
//
// 1) `live dev server on 25565` - the original deterministic end-to-end suite.
//    Prerequisites (managed by the Lead, this test never starts/stops that server):
//      - Minecraft 1.20.1 server on 127.0.0.1:25565, online-mode=false
//      - RCON on 127.0.0.1:25575 with password dshmcdevtest
//
// 2) `fabric multi-version compatibility` - starts COPIES of the user's Fabric
//    test servers (monster-war mods) one at a time, verifies join/state/chat/leave
//    and then stops the copy immediately. Never touches the original directories:
//      - libraries/ and versions/ are directory junctions to the user dirs
//      - mods/, world/, .fabric/ and fabric-server-launch.jar are copied
//      - server.properties is copied with server-port/rcon.port/rcon.password and
//        server-ip=127.0.0.1 overridden (ports 25640+, RCON ports 25650+)
//    The source dirs are D:\Minecraft\数据包\\_mw_server\fp-* (skipped when absent).
//    Java 21+ is required (detected automatically); copies are deleted afterwards.
//
// 3) `native version matrix` - optional vanilla fixtures in .tmp/ver-servers/<ver>/
//    (1.12.2-1.19.4, Java 8/17); the real cases are skipped when fixtures are absent.
//
// 4) `bot join modes` - mode dispatch from task-14: 1.7.10 through the built-in
//    LegacyBot and 26.3 through the protocol-compat emulated stack. Fixtures in
//    .tmp/compat-servers/{1.7.10,26.3} (ports 25696/25697), one server at a time.
//
// The ~50 line raw-socket RCON helper below is intentionally self-contained:
// lib/rcon.js is owned by another teammate and this test must not depend on it.
//
// Run:  node --test test/bot.test.mjs                    (full file, needs 25565)
//       node --test --test-name-pattern "bot join modes" test/bot.test.mjs
//       node --test --test-name-pattern "fabric multi-version" test/bot.test.mjs

import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  closeSync,
  cpSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from 'node:fs';
import net from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { BOT_VERSION_UNSUPPORTED, botManager, botSupport } from '../lib/bot.js';
import { compareVersions, pickJavaForVersion } from '../lib/versions.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const PLUGIN_DIR = resolve(TEST_DIR, '..');
const REPO_ROOT = resolve(PLUGIN_DIR, '..');

const RCON_HOST = '127.0.0.1';
const RCON_PORT = 25575;
const RCON_PASSWORD = 'dshmcdevtest';
const RC = { timeoutMs: 8000 };

const USERNAME = 'BotTester';
const BASE = { x: 400, y: 100, z: 400 };
const PLATFORM = { x1: 398, y: 99, z1: 398, x2: 402, z2: 402 };
// Wide air-clear region: also removes blocks left above the platform by a
// previous (crashed) run, which would otherwise suffocate the freshly spawned bot.
const AIR_CLEAR = { x1: 396, y1: 100, z1: 396, x2: 406, y2: 108, z2: 406 };
const CHEST = { x: 401, y: 100, z: 400 };

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function rcon(command, { host = RCON_HOST, port = RCON_PORT, password = RCON_PASSWORD, timeoutMs = RC.timeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let buffer = Buffer.alloc(0);
    let authenticated = false;
    let response = '';
    let idleTimer = null;
    let settled = false;
    const timer = setTimeout(() => {
      finish(new Error(`rcon timeout after ${timeoutMs}ms for '${command}'`));
    }, timeoutMs);
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      socket.destroy();
      if (error) reject(error);
      else resolve(response);
    };
    const send = (requestId, type, body) => {
      const payload = Buffer.from(String(body), 'utf8');
      const packet = Buffer.alloc(14 + payload.length);
      packet.writeInt32LE(10 + payload.length, 0);
      packet.writeInt32LE(requestId, 4);
      packet.writeInt32LE(type, 8);
      payload.copy(packet, 12);
      socket.write(packet);
    };
    socket.on('error', (error) => finish(new Error(`rcon connection error: ${error.message}`)));
    socket.on('connect', () => send(1, 3, password));
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= 12) {
        const length = buffer.readInt32LE(0);
        if (buffer.length < 4 + length) break;
        const requestId = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const body = buffer.subarray(12, 4 + length - 2).toString('utf8');
        buffer = buffer.subarray(4 + length);
        if (!authenticated) {
          if (requestId === -1) return finish(new Error('rcon authentication failed (wrong password)'));
          if (type === 2 && requestId === 1) {
            authenticated = true;
            send(2, 2, command);
          }
          continue;
        }
        if (requestId === 2 && type === 0) {
          response += body;
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => finish(), 80);
        }
      }
    });
  });
}

async function waitFor(check, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const value = await check();
      if (value) return value;
    } catch (error) {
      lastError = error;
    }
    await sleep(150);
  }
  throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}${lastError ? `: ${lastError.message}` : ''}`);
}

function stringHasAtMostTwoDecimals(value) {
  const text = String(value);
  const dot = text.indexOf('.');
  return dot === -1 || text.length - dot - 1 <= 2;
}

// ===========================================================================
// Multi-version compatibility helpers (Fabric + monster-war copies)
// ===========================================================================

const USER_SERVER_ROOT = 'D:\\Minecraft\\数据包\\_mw_server';
const COMPAT_WORK_ROOT = join(REPO_ROOT, '.tmp', 'bot-compat');
const COMPAT_USERNAME = 'CompatBot';

const COMPAT_SERVERS = [
  {
    label: 'fabric-1.21.1',
    dir: 'fp-1.21.1',
    port: 25641,
    rconPort: 25651,
    rconPassword: 'botcompat',
    expectedVersion: '1.21.1',
    versionGateProbe: true // unknown explicit versions must degrade with BOT_VERSION_UNSUPPORTED
  },
  {
    label: 'fabric-1.21.11',
    dir: 'fp-1.21.11',
    port: 25642,
    rconPort: 25652,
    rconPassword: 'botcompat',
    expectedVersion: '1.21.11'
  },
  {
    label: 'fabric-1.20.1-monster-war',
    dir: 'fp-1.20.1',
    port: 25640,
    rconPort: 25650,
    rconPassword: 'botcompat',
    expectedVersion: '1.20.1'
  }
];

let cachedJava21;
function findJava21() {
  if (cachedJava21 !== undefined) return cachedJava21;
  const candidates = [];
  for (const javaRoot of ['D:\\Program Files\\Java', 'C:\\Program Files\\Java']) {
    try {
      for (const name of readdirSync(javaRoot)) {
        if (/(?:graalvm-)?jdk-?21/i.test(name)) candidates.push(join(javaRoot, name, 'bin', 'java.exe'));
      }
    } catch {
      // directory missing, ignore
    }
  }
  if (process.env.JAVA_HOME) candidates.push(join(process.env.JAVA_HOME, 'bin', 'java.exe'));
  candidates.push('java'); // PATH fallback
  for (const candidate of candidates) {
    try {
      const result = spawnSync(candidate, ['-version'], { encoding: 'utf8', timeout: 15000, windowsHide: true });
      const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
      const match = /version "(\d+)/.exec(text);
      if (match && Number(match[1]) >= 21) {
        cachedJava21 = candidate;
        return cachedJava21;
      }
    } catch {
      // try next candidate
    }
  }
  cachedJava21 = null;
  return cachedJava21;
}

function compatSkipReason(config) {
  if (!findJava21()) return 'Java 21+ not found (the 1.21.x Fabric servers require it)';
  const sourceDir = join(USER_SERVER_ROOT, config.dir);
  if (!existsSync(sourceDir)) return `user Fabric server dir not found: ${sourceDir}`;
  if (!existsSync(join(sourceDir, 'fabric-server-launch.jar'))) return `fabric-server-launch.jar missing in ${sourceDir}`;
  return false;
}

function tailText(text, lines = 40) {
  return String(text ?? '').split(/\r?\n/).slice(-lines).join('\n');
}

function prepareCompatCopy(config) {
  const sourceDir = join(USER_SERVER_ROOT, config.dir);
  const workDir = join(COMPAT_WORK_ROOT, config.dir);
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  // Heavy, read-only directories stay linked to the user install (no copies).
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of ['libraries', 'versions']) symlinkSync(join(sourceDir, dir), join(workDir, dir), linkType);
  // Small dirs are copied so the server only ever writes into .tmp.
  for (const dir of ['.fabric', 'mods', 'world']) {
    if (existsSync(join(sourceDir, dir))) cpSync(join(sourceDir, dir), join(workDir, dir), { recursive: true });
  }
  cpSync(join(sourceDir, 'fabric-server-launch.jar'), join(workDir, 'fabric-server-launch.jar'));
  writeFileSync(join(workDir, 'eula.txt'), 'eula=true\n');

  const overrides = {
    'server-port': String(config.port),
    'server-ip': '127.0.0.1',
    'rcon.port': String(config.rconPort),
    'rcon.password': config.rconPassword,
    'enable-rcon': 'true',
    'enable-status': 'true',
    'online-mode': 'false',
    'level-name': 'world',
    'view-distance': '4',
    'simulation-distance': '4',
    'max-players': '5',
    'spawn-protection': '0',
    'sync-chunk-writes': 'false',
    'log-ips': 'false'
  };
  const lines = readFileSync(join(sourceDir, 'server.properties'), 'utf8').split(/\r?\n/);
  const seen = new Set();
  const output = [];
  for (const line of lines) {
    const match = /^([^#=]+)=(.*)$/.exec(line);
    if (match && Object.hasOwn(overrides, match[1])) {
      output.push(`${match[1]}=${overrides[match[1]]}`);
      seen.add(match[1]);
    } else {
      output.push(line);
    }
  }
  for (const [key, value] of Object.entries(overrides)) {
    if (!seen.has(key)) output.push(`${key}=${value}`);
  }
  writeFileSync(join(workDir, 'server.properties'), output.join('\n'));
  return workDir;
}

function startCompatServer(config, workDir, javaPath) {
  const child = spawn(javaPath, ['-Xmx1024M', '-jar', 'fabric-server-launch.jar', 'nogui'], {
    cwd: workDir,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  const collect = (chunk) => {
    output += chunk.toString('utf8');
    if (output.length > 400000) output = output.slice(-200000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, getOutput: () => output };
}

async function waitCompatReady(server, config, timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/Done \([\d.]+s\)!/.test(server.getOutput())) return;
    if (server.child.exitCode != null) {
      throw new Error(`${config.label} server exited during startup (code ${server.child.exitCode}):\n${tailText(server.getOutput())}`);
    }
    await sleep(200);
  }
  throw new Error(`${config.label} server startup timed out after ${timeoutMs}ms:\n${tailText(server.getOutput())}`);
}

function waitChildExit(child, timeoutMs) {
  return new Promise((resolveExit) => {
    if (child.exitCode != null) {
      resolveExit({ exited: true, code: child.exitCode });
      return;
    }
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolveExit(result);
    };
    const timer = setTimeout(() => finish({ exited: false }), timeoutMs);
    child.once('exit', (code) => finish({ exited: true, code }));
  });
}

async function waitPortClosed(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const open = await new Promise((resolveOpen) => {
      const socket = net.createConnection({ host: '127.0.0.1', port });
      const finish = (value) => {
        try {
          socket.destroy();
        } catch {
          // ignore
        }
        resolveOpen(value);
      };
      socket.setTimeout(500, () => finish(false));
      socket.once('connect', () => finish(true));
      socket.once('error', () => finish(false));
    });
    if (!open) return true;
    await sleep(200);
  }
  return false;
}

async function stopCompatServer(server, config) {
  const child = server.child;
  if (child.exitCode != null) {
    return { exited: true, alreadyStopped: true, code: child.exitCode, portClosed: await waitPortClosed(config.port, 5000) };
  }
  try {
    await rcon('stop', { port: config.rconPort, password: config.rconPassword, timeoutMs: 10000 });
  } catch {
    // RCON may not be up yet; the kill fallback below still guarantees cleanup.
  }
  let exit = await waitChildExit(child, 25000);
  if (!exit.exited) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    exit = await waitChildExit(child, 10000);
  }
  const portClosed = await waitPortClosed(config.port, 10000);
  return { exited: exit.exited, code: exit.code ?? child.exitCode ?? null, portClosed };
}

async function verifyBotOnServer(config) {
  // Requirement: join WITHOUT an explicit version (server-ping auto detection).
  const joined = await botManager.join({ host: '127.0.0.1', port: config.port, username: COMPAT_USERNAME, timeoutMs: 60000 });
  try {
    assert.equal(joined.connected, true);
    assert.equal(joined.username, COMPAT_USERNAME);
    assert.equal(String(joined.version), config.expectedVersion);
    assert.equal(joined.versionSource, 'auto-ping', 'join() must auto-detect the version via server ping');
    assert.equal(String(joined.requestedVersion), config.expectedVersion);
    assert.ok(Array.isArray(joined.warnings), 'join() returns a warnings array');
    const parseWarnings = joined.warnings.filter((warning) => /unknown block|chunk|palette|registry data/i.test(warning.message));
    assert.deepEqual(parseWarnings, [], `modded server must not degrade chunk/block parsing: ${JSON.stringify(parseWarnings)}`);

    // state()
    const state = botManager.state();
    assert.equal(state.connected, true);
    assert.equal(String(state.version), config.expectedVersion);
    assert.ok(state.position && Number.isFinite(state.position.x) && Number.isFinite(state.position.y) && Number.isFinite(state.position.z));
    assert.ok(Number.isFinite(state.position.yaw) && Number.isFinite(state.position.pitch));
    assert.ok(typeof state.health === 'number' && state.health > 0);
    assert.ok(typeof state.food === 'number' && state.food >= 0);
    assert.ok(typeof state.gameMode === 'string' && state.gameMode.length > 0);
    assert.ok(typeof state.dimension === 'string' && state.dimension.length > 0);
    assert.ok(Array.isArray(state.inventory));
    assert.ok(Array.isArray(state.players));
    assert.ok(Array.isArray(state.chat));

    // chat + chat_history (local ring buffer is authoritative, echo deduped)
    const marker = `compat-${config.label}-${Date.now()}`;
    const sent = await botManager.action('chat', { message: marker });
    assert.equal(sent.sent, true);
    const recorded = botManager.state().chat.some((entry) => entry.message === marker && entry.username === COMPAT_USERNAME);
    assert.equal(recorded, true, 'chat action must be visible in state().chat');
    const history = await botManager.action('chat_history', { limit: 10 });
    assert.ok(history.messages.some((entry) => entry.message === marker && entry.username === COMPAT_USERNAME));

    // a couple of low-risk actions: look, wait and a no-op goto on the current block
    const looked = await botManager.action('look', { yaw: 0, pitch: 0 });
    assert.ok(Number.isFinite(looked.yaw) && Number.isFinite(looked.pitch));
    const waited = await botManager.action('wait', { ms: 100 });
    assert.equal(waited.waited, 100);
    const gotoResult = await botManager.action('goto', {
      x: Math.floor(state.position.x),
      z: Math.floor(state.position.z),
      timeoutMs: 10000
    });
    assert.equal(typeof gotoResult.arrived, 'boolean');
  } finally {
    await botManager.leave().catch(() => {});
  }
  return joined;
}

// ===========================================================================
// Suite 1: original deterministic E2E against the main dev server (25565)
// ===========================================================================

describe('live dev server on 25565', () => {
  before(async () => {
    // A crashed previous run could leave the bot player online; try to kick it.
    await rcon(`kick ${USERNAME}`).catch(() => {});
    await rcon('gamerule doMobSpawning false');
    await rcon('gamerule doDaylightCycle false');
    await rcon('gamerule doWeatherCycle false');
    await rcon('gamerule fallDamage false');
    await rcon('time set day');
    // Commands only touch loaded chunks, so force-load the playground chunks first.
    await rcon(`forceload add ${AIR_CLEAR.x1} ${AIR_CLEAR.z1} ${AIR_CLEAR.x2} ${AIR_CLEAR.z2}`);
    // Remove anything a previous crashed run left in the air above the platform.
    await rcon(
      `fill ${AIR_CLEAR.x1} ${AIR_CLEAR.y1} ${AIR_CLEAR.z1} ${AIR_CLEAR.x2} ${AIR_CLEAR.y2} ${AIR_CLEAR.z2} minecraft:air`
    );
    // Floating stone platform far away from the world spawn (avoids spawn protection).
    await rcon(`fill ${PLATFORM.x1} ${PLATFORM.y} ${PLATFORM.z1} ${PLATFORM.x2} ${PLATFORM.y} ${PLATFORM.z2} minecraft:stone`);
    await rcon(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:chest`);
    await rcon(`kill @e[type=item,x=${AIR_CLEAR.x1},y=90,z=${AIR_CLEAR.z1},dx=20,dy=20,dz=20]`).catch(() => {});
  });

  after(async () => {
    await botManager.leave().catch(() => {});
    await sleep(200);
    try {
      await rcon(
        `fill ${AIR_CLEAR.x1} ${AIR_CLEAR.y1} ${AIR_CLEAR.z1} ${AIR_CLEAR.x2} ${AIR_CLEAR.y2} ${AIR_CLEAR.z2} minecraft:air`
      );
      await rcon(`fill ${PLATFORM.x1} ${PLATFORM.y} ${PLATFORM.z1} ${PLATFORM.x2} ${PLATFORM.y} ${PLATFORM.z2} minecraft:air`);
      await rcon(`setblock ${CHEST.x} ${CHEST.y} ${CHEST.z} minecraft:air`);
      await rcon(`kill @e[type=item,x=${AIR_CLEAR.x1},y=90,z=${AIR_CLEAR.z1},dx=20,dy=20,dz=20]`);
      await rcon(`kick ${USERNAME}`);
      await rcon(`forceload remove ${AIR_CLEAR.x1} ${AIR_CLEAR.z1} ${AIR_CLEAR.x2} ${AIR_CLEAR.z2}`);
    } catch {
      // best effort cleanup only; the main assertions already ran
    }
    await rcon('gamerule doDaylightCycle true').catch(() => {});
    await rcon('gamerule doMobSpawning true').catch(() => {});
    await rcon('gamerule doWeatherCycle true').catch(() => {});
    await rcon('gamerule fallDamage true').catch(() => {});
  });

  test('join: connects a real offline-mode player to the server', async () => {
    const info = await botManager.join({ username: USERNAME, timeoutMs: 60000 });
    assert.equal(info.connected, true);
    assert.equal(info.username, USERNAME);
    assert.match(String(info.version), /^1\.20\.1/);
    assert.ok(info.position && Number.isFinite(info.position.x) && Number.isFinite(info.position.y) && Number.isFinite(info.position.z));
    assert.equal(botManager.connected, true);
  });

  test('join: a second join replaces the existing connection', async () => {
    const first = botManager.state();
    assert.equal(first.connected, true);
    const info = await botManager.join({ username: USERNAME, timeoutMs: 60000 });
    assert.equal(info.connected, true);
    assert.equal(info.username, first.username);
    assert.equal(botManager.connected, true);
  });

  test('state: reflects an RCON teleport, given items and vitals', async () => {
    // Normalise a possibly stale saved player position, then hand out a known inventory.
    await rcon(`tp ${USERNAME} ${BASE.x} ${BASE.y} ${BASE.z}`);
    await rcon(`clear ${USERNAME}`);
    await rcon(`give ${USERNAME} minecraft:dirt 64`);
    await rcon(`give ${USERNAME} minecraft:oak_log 4`);

    const state = await waitFor(() => {
      const current = botManager.state();
      if (!current.connected) return null;
      const nearBase =
        Math.abs(current.position.x - BASE.x) <= 2 &&
        Math.abs(current.position.z - BASE.z) <= 2 &&
        current.position.y >= BASE.y - 1 &&
        current.position.y <= BASE.y + 2;
      const dirt = current.inventory.find((slot) => slot.name === 'dirt');
      const logs = current.inventory.find((slot) => slot.name === 'oak_log');
      return nearBase && dirt && logs ? current : null;
    }, 20000, 'state() to show the teleported position and the given items');

    assert.equal(state.username, USERNAME);
    assert.ok(stringHasAtMostTwoDecimals(state.position.yaw), `yaw should keep 2 decimals: ${state.position.yaw}`);
    assert.ok(stringHasAtMostTwoDecimals(state.position.pitch), `pitch should keep 2 decimals: ${state.position.pitch}`);
    assert.ok(state.health > 0 && state.health <= 20, `health out of range: ${state.health}`);
    assert.ok(state.food >= 0 && state.food <= 20, `food out of range: ${state.food}`);
    assert.ok(typeof state.saturation === 'number');
    assert.ok(String(state.dimension).toLowerCase().includes('overworld'), `dimension: ${state.dimension}`);
    assert.ok(['survival', 'creative', 'adventure', 'spectator'].includes(state.gameMode), `gameMode: ${state.gameMode}`);
    assert.ok(Array.isArray(state.players));
    assert.ok(Array.isArray(state.chat));
    const dirt = state.inventory.find((slot) => slot.name === 'dirt');
    const logs = state.inventory.find((slot) => slot.name === 'oak_log');
    assert.ok(dirt.count >= 60, `expected ~64 dirt, got ${dirt.count}`);
    assert.equal(logs.count, 4);
    for (const slot of state.inventory) {
      assert.equal(typeof slot.slot, 'number');
      assert.equal(typeof slot.name, 'string');
      assert.equal(typeof slot.count, 'number');
    }
  });

  test('chat: sends a message and records it in the ring buffer exactly once', async () => {
    const marker = `dsh-bot-chat-${Date.now()}`;
    const sent = await botManager.action('chat', { message: marker });
    assert.equal(sent.sent, true);
    assert.equal(sent.message, marker);

    // The chat action must record locally right away (quickcheck assertions rely
    // on this without waiting for a server echo).
    const immediate = botManager.state().chat.filter((entry) => entry.message === marker);
    assert.equal(immediate.length, 1);
    assert.equal(immediate[0].username, USERNAME);
    assert.ok(Number.isFinite(immediate[0].at));

    await sleep(700);
    const history = await botManager.action('chat_history', { limit: 10 });
    assert.ok(Array.isArray(history.messages));
    const echoes = history.messages.filter((entry) => entry.message === marker);
    assert.equal(echoes.length, 1, 'the server echo must not duplicate the locally recorded chat entry');

    const waited = await botManager.action('wait', { ms: 120 });
    assert.equal(waited.waited, 120);
    assert.ok(Number.isFinite(waited.tick) || waited.tick === null);
  });

  test('look: turns toward a coordinate and by explicit angles', async () => {
    const toward = await botManager.action('look', { x: BASE.x + 1, y: BASE.y + 1, z: BASE.z });
    assert.ok(Number.isFinite(toward.yaw));
    assert.ok(Number.isFinite(toward.pitch));
    const byAngles = await botManager.action('look', { yaw: 0, pitch: 0 });
    assert.ok(Math.abs(byAngles.yaw) < 0.01, `yaw should be ~0, got ${byAngles.yaw}`);
    assert.ok(Math.abs(byAngles.pitch) < 0.01, `pitch should be ~0, got ${byAngles.pitch}`);
  });

  test('goto: walk to a nearby x/z goal with the pathfinder', async () => {
    const result = await botManager.action('goto', { x: BASE.x + 1, z: BASE.z + 1, timeoutMs: 20000 });
    assert.equal(result.arrived, true, `goto should arrive, reason: ${result.reason ?? 'n/a'}`);
    assert.ok(result.position && Number.isFinite(result.position.x));
  });

  test('goto: an unreachable goal returns arrived:false instead of throwing', async () => {
    const result = await botManager.action('goto', { x: BASE.x, y: BASE.y + 30, z: BASE.z, timeoutMs: 2500 });
    assert.equal(result.arrived, false);
    assert.ok(typeof result.reason === 'string' && result.reason.length > 0, 'arrived:false should explain why');
    assert.ok(result.position && Number.isFinite(result.position.y));
    // Regression guard: the pathfinder must never dig or place scaffolding blocks
    // (1x1 towers) while pathing, otherwise it can trap the bot inside a block.
    const headBlock = await rcon(`execute if block ${BASE.x} ${BASE.y + 1} ${BASE.z} minecraft:air`);
    assert.match(headBlock, /passed/i, `goto must not place blocks above the bot, RCON said: ${headBlock}`);
    const feetBlock = await rcon(`execute if block ${BASE.x} ${BASE.y} ${BASE.z} minecraft:air`);
    assert.match(feetBlock, /passed/i, `goto must not place blocks at the bot position, RCON said: ${feetBlock}`);
  });

  test('inventory/utilities: list, drop (both forms), use_item, use_block, eat error', async () => {
    const listed = await botManager.action('inventory', { action: 'list' });
    assert.ok(Array.isArray(listed.slots));
    assert.ok(listed.slots.length > 0);
    for (const slot of listed.slots) {
      assert.equal(typeof slot.slot, 'number');
      assert.equal(typeof slot.name, 'string');
      assert.equal(typeof slot.count, 'number');
    }

    const before = botManager.state().inventory.find((slot) => slot.name === 'dirt').count;
    const droppedViaInventory = await botManager.action('inventory', { action: 'drop', name: 'dirt', count: 1 });
    assert.equal(droppedViaInventory.dropped, 1);
    const droppedViaAction = await botManager.action('drop', { name: 'dirt', count: 1 });
    assert.equal(droppedViaAction.dropped, 1);
    const after = botManager.state().inventory.find((slot) => slot.name === 'dirt').count;
    assert.equal(after, before - 2);

    const usedItem = await botManager.action('use_item', {});
    assert.equal(usedItem.used, true);
    const usedBlock = await botManager.action('use_block', { x: BASE.x, y: BASE.y - 1, z: BASE.z, face: 'up' });
    assert.equal(usedBlock.used, true);
    assert.equal(usedBlock.block, 'stone');

    // No food was given, so eat must explain that instead of hanging.
    await assert.rejects(botManager.action('eat', {}), /no food/i);

    await assert.rejects(botManager.action('fly_to_the_moon', {}), /unknown action 'fly_to_the_moon'/);
  });

  test('equip + place: equips dirt and places two blocks next to the bot', async () => {
    // Normalise the position again after the goto tests.
    await rcon(`tp ${USERNAME} ${BASE.x} ${BASE.y} ${BASE.z}`);
    await waitFor(() => {
      const state = botManager.state();
      return state.connected && Math.abs(state.position.x - BASE.x) <= 1 && Math.abs(state.position.z - BASE.z) <= 1;
    }, 5000, 'teleport back to the base position');

    const equipped = await botManager.action('equip', { name: 'dirt' });
    assert.equal(equipped.heldItem, 'dirt');
    assert.equal(botManager.state().heldItem, 'dirt');

    // No `item` param: place uses the currently held item.
    const placedHeld = await botManager.action('place', { x: BASE.x, y: BASE.y, z: BASE.z + 1 });
    assert.equal(placedHeld.placed, true);
    assert.equal(placedHeld.block, 'dirt');
    const checkHeld = await rcon(`execute if block ${BASE.x} ${BASE.y} ${BASE.z + 1} minecraft:dirt`);
    assert.match(checkHeld, /passed/i, `expected dirt block after place, RCON said: ${checkHeld}`);

    // Explicit `item` param.
    const placedItem = await botManager.action('place', { x: BASE.x, y: BASE.y, z: BASE.z + 2, item: 'minecraft:dirt' });
    assert.equal(placedItem.placed, true);
    const checkItem = await rcon(`execute if block ${BASE.x} ${BASE.y} ${BASE.z + 2} minecraft:dirt`);
    assert.match(checkItem, /passed/i, `expected second dirt block after place, RCON said: ${checkItem}`);
  });

  test('dig: breaks both placed blocks', async () => {
    for (const zOffset of [1, 2]) {
      const dug = await botManager.action('dig', { x: BASE.x, y: BASE.y, z: BASE.z + zOffset });
      assert.equal(dug.dug, true);
      assert.equal(dug.block, 'dirt');
      const check = await rcon(`execute if block ${BASE.x} ${BASE.y} ${BASE.z + zOffset} minecraft:air`);
      assert.match(check, /passed/i, `expected air after dig, RCON said: ${check}`);
    }
  });

  test('craft: explains missing materials and crafts oak_planks from oak_log', async () => {
    // 400 planks need 100 logs and only 4 were given: must fail with a readable
    // "missing oak_log" message, not a hang or an opaque error.
    await assert.rejects(
      botManager.action('craft', { name: 'oak_planks', count: 400 }),
      /missing .*oak_log/i
    );
    // 3x3 recipes must explain that a crafting table is required.
    await assert.rejects(botManager.action('craft', { name: 'diamond_sword' }), /crafting table/i);

    const crafted = await botManager.action('craft', { name: 'oak_planks', count: 4 });
    assert.equal(crafted.crafted, true);
    assert.equal(crafted.item, 'oak_planks');
    assert.ok(crafted.count >= 4, `expected at least 4 planks, got ${crafted.count}`);

    const state = botManager.state();
    const planks = state.inventory.find((slot) => slot.name === 'oak_planks');
    assert.ok(planks && planks.count >= 4);
    const logs = state.inventory.find((slot) => slot.name === 'oak_log');
    assert.ok(!logs || logs.count <= 3, 'crafting should have consumed oak_log');
  });

  test('open_container + container_move + close_container: move items into a chest', async () => {
    const opened = await botManager.action('open_container', { x: CHEST.x, y: CHEST.y, z: CHEST.z });
    assert.equal(opened.opened, true);
    assert.ok(typeof opened.windowTitle === 'string' && opened.windowTitle.length > 0);
    assert.ok(Array.isArray(opened.slots));
    const dirt = opened.slots.find((slot) => slot.name === 'dirt');
    assert.ok(dirt, 'the open container window should expose the dirt in the bot inventory');
    assert.ok(dirt.count >= 2);

    const moved = await botManager.action('container_move', { from: dirt.index, to: 0, count: 2 });
    assert.equal(moved.moved, true);
    assert.equal(moved.item, 'dirt');
    assert.equal(moved.count, 2);

    const closed = await botManager.action('close_container', {});
    assert.equal(closed.closed, true);

    const reopened = await botManager.action('open_container', { x: CHEST.x, y: CHEST.y, z: CHEST.z });
    assert.equal(reopened.opened, true);
    const chestSlot = reopened.slots.find((slot) => slot.index === 0);
    assert.ok(chestSlot, 'chest slot 0 should not be empty after container_move');
    assert.equal(chestSlot.name, 'dirt');
    assert.equal(chestSlot.count, 2);
    const closedAgain = await botManager.action('close_container', {});
    assert.equal(closedAgain.closed, true);
    const closedTwice = await botManager.action('close_container', {});
    assert.equal(closedTwice.closed, false);
  });

  test('attack: reports no nearby target instead of throwing', async () => {
    // doMobSpawning=false and the platform is empty, so there should be no mob;
    // never assume a specific outcome for the world, just assert the shape.
    const result = await botManager.action('attack', {});
    assert.equal(typeof result.attacked, 'boolean');
    if (result.attacked) {
      assert.ok(typeof result.target === 'string' && result.target.length > 0);
    } else {
      assert.equal(result.target, null);
    }
  });

  test('leave: disconnects, then every action reports "not connected"', async () => {
    const left = await botManager.leave();
    assert.deepEqual(left, { connected: false, left: true });
    assert.equal(botManager.state().connected, false);
    await assert.rejects(botManager.action('chat', { message: 'after leave' }), /not connected/);
    await assert.rejects(botManager.action('wait', { ms: 1 }), /not connected/);
    const second = await botManager.leave();
    assert.equal(second.connected, false);
    assert.equal(second.left, false);
  });
});

// ===========================================================================
// Suite 2: Fabric multi-version compatibility (monster-war test servers)
// ===========================================================================

describe('fabric multi-version compatibility', () => {
  for (const config of COMPAT_SERVERS) {
    test(`${config.label}: join(auto version) -> state -> chat -> look/goto -> leave`, { skip: compatSkipReason(config) }, async (t) => {
      const timings = {};
      const time = async (label, fn) => {
        const started = Date.now();
        try {
          return await fn();
        } finally {
          timings[label] = Date.now() - started;
        }
      };
      const javaPath = findJava21();
      const workDir = await time('prepare', async () => prepareCompatCopy(config));
      let server = null;
      let stopResult = null;
      try {
        server = await time('spawn', async () => startCompatServer(config, workDir, javaPath));
        await time('startup', async () => waitCompatReady(server, config));
        const joined = await time('verify', async () => verifyBotOnServer(config));
        if (config.versionGateProbe) {
          // Version gate (task-10): a caller-supplied version is validated against
          // the support matrix before connecting; unknown/future versions degrade
          // to a readable BOT_VERSION_UNSUPPORTED error.
          await assert.rejects(
            botManager.join({
              host: '127.0.0.1',
              port: config.port,
              username: COMPAT_USERNAME,
              version: '0.0.1',
              timeoutMs: 60000
            }),
            (error) => {
              assert.match(error.message, /BOT_VERSION_UNSUPPORTED/);
              assert.equal(error.code, BOT_VERSION_UNSUPPORTED);
              assert.match(error.message, /no protocol entry/i);
              return true;
            }
          );
          assert.equal(botManager.state().connected, false);
        }
        assert.equal(joined.connected, true);
      } finally {
        if (server) stopResult = await time('stop', async () => stopCompatServer(server, config));
        await time('cleanup', async () => rmSync(workDir, { recursive: true, force: true }));
        t.diagnostic(`compat timings ${config.label}: ${JSON.stringify(timings)}`);
      }
      // Requirement: the test copy must be fully stopped afterwards, no listener left.
      assert.ok(stopResult, 'compat server must be stopped in the finally block');
      assert.equal(stopResult.exited, true, `${config.label}: server process must exit after stop`);
      assert.equal(stopResult.portClosed, true, `${config.label}: port ${config.port} must be released after stop`);
    });
  }
});

// ===========================================================================
// Suite 3: version compatibility matrix (1.7.10 -26.4 fixtures)
// ===========================================================================
// Vanilla server fixtures live in .tmp/ver-servers/<version>/ (downloaded by the
// Lead). Each test copies a fixture into .tmp, runs the bot against it, stops the
// server immediately (stdin "stop", taskkill fallback) and removes the copy.
// Unsupported versions must fail with a BOT_VERSION_UNSUPPORTED error (graceful
// degradation, e.g. quickcheck -> warning) instead of crashing the process.
// Servers are started strictly one at a time because the machine is memory bound.

const VERSION_FIXTURES_ROOT = 'D:\\Minecraft\\dsh-mc\\.tmp\\ver-servers';
const VERSION_MATRIX_WORK_ROOT = join(REPO_ROOT, '.tmp', 'bot-version-matrix');
const VERSION_WORLD_CACHE_ROOT = join(REPO_ROOT, '.tmp', 'bot-version-worlds');
const VERSION_BOT_NAME = 'MatrixBot';

const VERSION_MATRIX = [
  { version: '1.12.2', port: 25682, rconPort: 25702, supported: true },
  { version: '1.13.2', port: 25683, rconPort: 25703, supported: true },
  { version: '1.14.4', port: 25684, rconPort: 25704, supported: true },
  { version: '1.16.5', port: 25685, rconPort: 25705, supported: true },
  { version: '1.18.2', port: 25686, rconPort: 25706, supported: true },
  { version: '1.19.4', port: 25687, rconPort: 25707, supported: true }
];

function versionFixtureDir(version) {
  return join(VERSION_FIXTURES_ROOT, version);
}

function serverJarReady(jar) {
  // A fixture jar that is still being downloaded is locked/short: only treat it
  // as usable when it is a readable zip (PK header) of plausible size.
  try {
    const fd = openSync(jar, 'r');
    try {
      const size = fstatSync(fd).size;
      if (size < 1_000_000) return false;
      const header = Buffer.alloc(4);
      readSync(fd, header, 0, 4, 0);
      return header[0] === 0x50 && header[1] === 0x4b; // "PK" zip signature
    } finally {
      closeSync(fd);
    }
  } catch {
    return false;
  }
}

function versionFixtureSkipReason(config) {
  const dir = versionFixtureDir(config.version);
  if (!existsSync(dir)) return `version fixture missing: ${dir}`;
  const jar = join(dir, 'server.jar');
  if (!existsSync(jar)) return `server.jar missing in ${dir}`;
  if (!serverJarReady(jar)) return `server.jar in ${dir} is incomplete or still downloading`;
  return false;
}

function versionJavaSkipReason(config) {
  const pick = pickJavaForVersion(config.version);
  if (!pick?.path) return `no Java runtime found for Minecraft ${config.version}`;
  if (pick.path !== 'java' && !existsSync(pick.path)) return `Java runtime not found: ${pick.path}`;
  return false;
}

function versionMatrixSkipReason(config) {
  return versionFixtureSkipReason(config) || versionJavaSkipReason(config);
}

function versionServerProperties(config) {
  // Flat worlds start much faster and spawn deterministically, which keeps the
  // matrix suite short. 1.18+ wants a namespaced level type (escaped for .properties).
  const flatLevelType = compareVersions(config.version, '1.18') >= 0 ? 'minecraft\\:flat' : 'FLAT';
  const lines = [
    `server-port=${config.port}`,
    'server-ip=127.0.0.1',
    'online-mode=false',
    'enable-status=true',
    `motd=version matrix ${config.version}`,
    'level-name=world',
    `level-type=${flatLevelType}`,
    'generate-structures=false',
    'max-players=5',
    'spawn-protection=0',
    'view-distance=2',
    'difficulty=easy',
    'gamemode=survival',
    'pvp=true',
    'enable-rcon=true',
    `rcon.port=${config.rconPort}`,
    'rcon.password=verpass'
  ];
  if (compareVersions(config.version, '1.18') >= 0) lines.push('simulation-distance=2');
  lines.push('');
  return lines.join('\n');
}

function prepareVersionServer(config) {
  const sourceDir = versionFixtureDir(config.version);
  const workDir = join(VERSION_MATRIX_WORK_ROOT, config.version.replace(/[^0-9A-Za-z._-]+/g, '_'));
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(join(sourceDir, 'server.jar'), join(workDir, 'server.jar'));
  // Prefer a pre-generated world (fixture world, else our own cache) to avoid
  // regenerating a world on every test run.
  const fixtureWorld = join(sourceDir, 'world');
  const cachedWorld = join(VERSION_WORLD_CACHE_ROOT, config.version, 'world');
  if (existsSync(fixtureWorld)) cpSync(fixtureWorld, join(workDir, 'world'), { recursive: true });
  else if (existsSync(cachedWorld)) cpSync(cachedWorld, join(workDir, 'world'), { recursive: true });
  writeFileSync(join(workDir, 'eula.txt'), 'eula=true\n');
  writeFileSync(join(workDir, 'server.properties'), versionServerProperties(config));
  return workDir;
}

function startVersionServer(config, workDir, javaPath) {
  const heapMb = Number(config.heapMb) || 1024;
  const child = spawn(javaPath, [`-Xmx${heapMb}M`, '-jar', 'server.jar', 'nogui'], {
    cwd: workDir,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe']
  });
  let output = '';
  const collect = (chunk) => {
    output += chunk.toString('utf8');
    if (output.length > 400000) output = output.slice(-200000);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  return { child, getOutput: () => output };
}

async function waitVersionServerReady(server, config, timeoutMs = 180000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (/Done \(\s*\d+(?:\.\d+)?s\)!/.test(server.getOutput())) return;
    if (server.child.exitCode != null) {
      throw new Error(`${config.version} server exited during startup (code ${server.child.exitCode}):\n${tailText(server.getOutput())}`);
    }
    await sleep(200);
  }
  throw new Error(`${config.version} server startup timed out after ${timeoutMs}ms:\n${tailText(server.getOutput())}`);
}

async function stopVersionServer(server, config) {
  const child = server.child;
  if (child.exitCode != null) {
    return { exited: true, code: child.exitCode, portClosed: await waitPortClosed(config.port, 5000) };
  }
  try {
    child.stdin.write('stop\n');
  } catch {
    // fall through to the kill fallback
  }
  let exit = await waitChildExit(child, 30000);
  if (!exit.exited) {
    try {
      execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // ignore
    }
    exit = await waitChildExit(child, 10000);
  }
  const portClosed = await waitPortClosed(config.port, 10000);
  return { exited: exit.exited, code: exit.code ?? child.exitCode ?? null, portClosed };
}

function rememberGeneratedWorld(config, workDir) {
  const fixtureWorld = join(versionFixtureDir(config.version), 'world');
  const cachedWorld = join(VERSION_WORLD_CACHE_ROOT, config.version, 'world');
  if (existsSync(fixtureWorld) || existsSync(cachedWorld)) return;
  const generatedWorld = join(workDir, 'world');
  if (!existsSync(generatedWorld)) return;
  try {
    mkdirSync(join(VERSION_WORLD_CACHE_ROOT, config.version), { recursive: true });
    cpSync(generatedWorld, cachedWorld, { recursive: true });
  } catch {
    // world caching is an optimisation only
  }
}

describe('native version matrix (1.12.2-1.19.4 fixtures)', () => {
  test('botSupport: native versions report protocol + required Java', () => {
    for (const version of ['1.8.8', '1.12.2', '1.13.2', '1.14.4', '1.16.5', '1.18.2', '1.19.4', '1.20.1', '1.21.11', '26.1', '26.1.2']) {
      const support = botSupport(version);
      assert.equal(support.supported, true, `${version} should be supported: ${support.reason}`);
      assert.equal(support.mode, 'native', `${version}: expected native mode, got ${support.mode}: ${support.reason}`);
      assert.equal(support.resolvedVersion, version);
      assert.ok(Number.isInteger(support.protocolVersion) && support.protocolVersion > 0, `${version}: protocolVersion`);
      assert.ok(Number.isInteger(support.javaMajor) && support.javaMajor >= 8, `${version}: javaMajor`);
      assert.ok(support.reason.includes(version), `${version}: reason should name the version`);
    }
    const byProtocol = botSupport(340);
    assert.equal(byProtocol.supported, true);
    assert.equal(byProtocol.resolvedVersion, '1.12.2');
  });

  test('botSupport: unsupported versions give a readable degrade reason', () => {
    for (const version of ['1.6.4', '26.5', '', 'not-a-version']) {
      const support = botSupport(version);
      assert.equal(support.supported, false, `${version || '(empty)'} must be unsupported`);
      assert.equal(support.mode, 'unsupported', `${version || '(empty)'}: ${support.mode}`);
      assert.ok(typeof support.reason === 'string' && support.reason.length > 0);
    }
    assert.match(botSupport('26.5').reason, /future alias|newer than the bundled/i);
  });

  test('join: unsupported versions throw BOT_VERSION_UNSUPPORTED before connecting', async () => {
    for (const version of ['1.6.4', '26.5']) {
      await assert.rejects(
        botManager.join({ host: '127.0.0.1', port: 1, username: VERSION_BOT_NAME, version, timeoutMs: 3000 }),
        (error) => {
          assert.match(error.message, /BOT_VERSION_UNSUPPORTED/);
          assert.equal(error.code, BOT_VERSION_UNSUPPORTED);
          assert.equal(error.mode, 'unsupported');
          return true;
        }
      );
    }
    assert.equal(botManager.state().connected, false);
  });

  for (const config of VERSION_MATRIX) {
    const skip = versionMatrixSkipReason(config);
    if (config.supported) {
      test(`version ${config.version}: auto-detected join -> state -> chat -> leave`, { skip }, async (t) => {
        const java = pickJavaForVersion(config.version);
        const workDir = prepareVersionServer(config);
        const timings = {};
        let server = null;
        let stopResult = null;
        try {
          const startedAt = Date.now();
          server = startVersionServer(config, workDir, java.path);
          await waitVersionServerReady(server, config);
          timings.startupMs = Date.now() - startedAt;
          const joinStart = Date.now();
          const joined = await botManager.join({
            host: '127.0.0.1',
            port: config.port,
            username: VERSION_BOT_NAME,
            timeoutMs: 90000
          });
          timings.joinMs = Date.now() - joinStart;
          try {
            assert.equal(joined.connected, true);
            assert.equal(String(joined.version), config.version);
            assert.equal(joined.versionSource, 'auto-ping', 'join() must auto-detect the version via server ping');
            assert.equal(joined.mode, 'native', `native versions must join in native mode, got ${joined.mode}`);
            const support = botSupport(config.version);
            assert.equal(support.supported, true, support.reason);

            const state = botManager.state();
            assert.equal(state.connected, true);
            assert.equal(String(state.version), config.version);
            assert.ok(state.position && Number.isFinite(state.position.x) && Number.isFinite(state.position.y) && Number.isFinite(state.position.z));
            assert.ok(Number.isFinite(state.position.yaw) && Number.isFinite(state.position.pitch));
            assert.ok(typeof state.health === 'number' && state.health > 0, `${config.version}: health`);
            assert.ok(typeof state.food === 'number' && state.food >= 0, `${config.version}: food`);
            assert.ok(typeof state.dimension === 'string' && state.dimension.length > 0, `${config.version}: dimension`);
            assert.ok(typeof state.gameMode === 'string' && state.gameMode.length > 0, `${config.version}: gameMode`);
            assert.ok(Array.isArray(state.inventory));

            const marker = `matrix-${config.version}-${Date.now()}`;
            const sent = await botManager.action('chat', { message: marker });
            assert.equal(sent.sent, true);
            const history = await botManager.action('chat_history', { limit: 10 });
            assert.ok(
              history.messages.some((entry) => entry.message === marker),
              `${config.version}: own chat must be visible in chat_history`
            );
            const looked = await botManager.action('look', { yaw: 0, pitch: 0 });
            assert.ok(Number.isFinite(looked.yaw) && Number.isFinite(looked.pitch));
            const left = await botManager.leave();
            assert.equal(left.left, true);
          } finally {
            await botManager.leave().catch(() => {});
          }
        } finally {
          if (server) stopResult = await stopVersionServer(server, config);
          rememberGeneratedWorld(config, workDir);
          await sleep(100);
          rmSync(workDir, { recursive: true, force: true });
          t.diagnostic(`version ${config.version} timings: ${JSON.stringify(timings)}`);
        }
        assert.ok(stopResult, `${config.version}: server must be stopped`);
        assert.equal(stopResult.exited, true, `${config.version}: server process must exit`);
        assert.equal(stopResult.portClosed, true, `${config.version}: port ${config.port} must be released`);
      });
    } else {
      test(`version ${config.version}: unsupported -> BOT_VERSION_UNSUPPORTED degrade (RCON-only)`, { skip }, async () => {
        const support = botSupport(config.version);
        assert.equal(support.supported, false);
        assert.ok(support.reason.length > 0);
        const java = pickJavaForVersion(config.version);
        const workDir = prepareVersionServer(config);
        let server = null;
        let stopResult = null;
        try {
          server = startVersionServer(config, workDir, java.path);
          await waitVersionServerReady(server, config);
          // Explicit version: fails fast before any connection attempt.
          await assert.rejects(
            botManager.join({
              host: '127.0.0.1',
              port: config.port,
              username: VERSION_BOT_NAME,
              version: config.version,
              timeoutMs: 15000
            }),
            (error) => {
              assert.match(error.message, /BOT_VERSION_UNSUPPORTED/);
              assert.equal(error.code, BOT_VERSION_UNSUPPORTED);
              assert.ok(error.message.includes(config.version), `error should name ${config.version}: ${error.message}`);
              return true;
            }
          );
          // Auto-detect: the status ping detects the version and degrades cleanly
          // (no loader crash, no silent hang).
          await assert.rejects(
            botManager.join({ host: '127.0.0.1', port: config.port, username: VERSION_BOT_NAME, timeoutMs: 20000 }),
            (error) => {
              assert.match(error.message, /BOT_VERSION_UNSUPPORTED/);
              assert.equal(error.code, BOT_VERSION_UNSUPPORTED);
              return true;
            }
          );
          assert.equal(botManager.state().connected, false);
        } finally {
          if (server) stopResult = await stopVersionServer(server, config);
          rememberGeneratedWorld(config, workDir);
          await sleep(100);
          rmSync(workDir, { recursive: true, force: true });
        }
        assert.equal(stopResult?.exited, true, `${config.version}: server process must exit`);
        assert.equal(stopResult?.portClosed, true, `${config.version}: port ${config.port} must be released`);
      });
    }
  }
});

// ===========================================================================
// Suite 4: bot join modes (legacy 1.7.10 / emulated 26.3 / emulated-future 26.4)
// ===========================================================================
// task-14: BotManager dispatches to the built-in LegacyBot for 1.7.x, to the
// protocol-compat emulated stack for 26.2/26.3, and best-effort for 26.4.
// Real tests copy the Lead-provided fixtures into .tmp and use dedicated ports
// (25696/25697) so they never race the compat-dev / legacy-dev test servers.

const COMPAT_SERVERS_ROOT = 'D:\\Minecraft\\dsh-mc\\.tmp\\compat-servers';
const JOIN_MODE_WORK_ROOT = join(REPO_ROOT, '.tmp', 'bot-join-modes');

const JOIN_MODE_CASES = [
  { version: '1.7.10', mode: 'legacy', fixture: '1.7.10', port: 25697, rconPort: 25717, heapMb: 512, username: 'LegacyModeBot' },
  { version: '26.3', mode: 'emulated', fixture: '26.3', port: 25696, rconPort: 25716, heapMb: 1320, username: 'EmulatedModeBot' }
];

function joinModeFixtureDir(config) {
  return join(COMPAT_SERVERS_ROOT, config.fixture);
}

function joinModeSkipReason(config) {
  const dir = joinModeFixtureDir(config);
  if (!existsSync(dir)) return `compat server fixture missing: ${dir}`;
  const jar = join(dir, 'server.jar');
  if (!existsSync(jar) || !serverJarReady(jar)) return `server.jar in ${dir} is incomplete or still downloading`;
  const java = pickJavaForVersion(config.version);
  if (!java?.path || (java.path !== 'java' && !existsSync(java.path))) return `no Java runtime for Minecraft ${config.version}`;
  const support = botSupport(config.version);
  if (support.mode !== config.mode) {
    return `botSupport('${config.version}').mode='${support.mode}', expected '${config.mode}'`;
  }
  return false;
}

function joinModeServerProperties(config) {
  return [
    `server-port=${config.port}`,
    'server-ip=127.0.0.1',
    'online-mode=false',
    'enable-status=true',
    'level-name=world',
    'max-players=5',
    'spawn-protection=0',
    'view-distance=2',
    'difficulty=easy',
    'gamemode=survival',
    'pvp=true',
    'enable-rcon=true',
    `rcon.port=${config.rconPort}`,
    'rcon.password=verpass',
    'white-list=false',
    'enforce-whitelist=false',
    ''
  ].join('\n');
}

function prepareJoinModeServer(config) {
  const sourceDir = joinModeFixtureDir(config);
  const workDir = join(JOIN_MODE_WORK_ROOT, config.fixture.replace(/[^0-9A-Za-z._-]+/g, '_'));
  rmSync(workDir, { recursive: true, force: true });
  mkdirSync(workDir, { recursive: true });
  cpSync(join(sourceDir, 'server.jar'), join(workDir, 'server.jar'));
  const fixtureWorld = join(sourceDir, 'world');
  if (existsSync(fixtureWorld)) cpSync(fixtureWorld, join(workDir, 'world'), { recursive: true });
  // 26.3 ships as a bundler-style install: link the already extracted
  // libraries/versions (read-only) instead of copying ~150MB; 1.7.10 has neither.
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  for (const dir of ['libraries', 'versions']) {
    const source = join(sourceDir, dir);
    if (existsSync(source)) symlinkSync(source, join(workDir, dir), linkType);
  }
  writeFileSync(join(workDir, 'eula.txt'), 'eula=true\n');
  writeFileSync(join(workDir, 'server.properties'), joinModeServerProperties(config));
  return workDir;
}

describe('bot join modes (legacy / emulated / emulated-future)', () => {
  test('botSupport: mode dispatch table', () => {
    for (const version of ['1.8.8', '1.12.2', '1.20.1', '26.1', '26.1.2']) {
      const support = botSupport(version);
      assert.equal(support.mode, 'native', `${version}: ${support.reason}`);
      assert.equal(support.supported, true);
      assert.equal(support.highestSupported, '26.1.2');
    }
    const emulated = botSupport('26.3');
    assert.equal(emulated.mode, 'emulated', emulated.reason);
    assert.equal(emulated.supported, true);
    assert.match(emulated.reason, /compatibility layer/i);
    assert.deepEqual(emulated.emulatedVersions, ['26.2', '26.3']);

    const legacy = botSupport('1.7.10');
    assert.equal(legacy.mode, 'legacy', legacy.reason);
    assert.equal(legacy.supported, true);
    assert.match(legacy.reason, /LegacyBot/);
    assert.equal(legacy.protocolVersion, 5);

    const future = botSupport('26.4');
    assert.equal(future.mode, 'emulated-future', future.reason);
    assert.equal(future.supported, true);
    assert.match(future.reason, /best-effort/i);
    assert.deepEqual(future.futureVersions, ['26.4']);

    const unsupported = botSupport('26.5');
    assert.equal(unsupported.mode, 'unsupported');
    assert.equal(unsupported.supported, false);
    assert.equal(botSupport('1.6.4').mode, 'unsupported');
  });

  test('join: emulated-future without a reachable/known protocol degrades with BOT_VERSION_UNSUPPORTED', async () => {
    await assert.rejects(
      botManager.join({ host: '127.0.0.1', port: 1, username: 'FutureModeBot', version: '26.4', timeoutMs: 4000 }),
      (error) => {
        assert.match(error.message, /BOT_VERSION_UNSUPPORTED/);
        assert.equal(error.code, BOT_VERSION_UNSUPPORTED);
        assert.equal(error.mode, 'emulated-future');
        return true;
      }
    );
    assert.equal(botManager.state().connected, false);
  });

  for (const config of JOIN_MODE_CASES) {
    test(`join mode ${config.mode}: ${config.version} join -> state -> chat -> chatHistory -> quit`, { skip: joinModeSkipReason(config) }, async (t) => {
      const support = botSupport(config.version);
      assert.equal(support.mode, config.mode);
      assert.equal(support.supported, true);
      const java = pickJavaForVersion(config.version);
      const workDir = prepareJoinModeServer(config);
      const timings = {};
      let server = null;
      let stopResult = null;
      try {
        const startedAt = Date.now();
        server = startVersionServer(config, workDir, java.path);
        await waitVersionServerReady(server, config);
        timings.startupMs = Date.now() - startedAt;
        const joinStart = Date.now();
        const joined = await botManager.join({
          host: '127.0.0.1',
          port: config.port,
          username: config.username,
          timeoutMs: 90000
        });
        timings.joinMs = Date.now() - joinStart;
        try {
          assert.equal(joined.connected, true);
          assert.equal(String(joined.version), config.version);
          assert.equal(joined.mode, config.mode, `join result must expose mode='${config.mode}'`);
          assert.ok(joined.position && Number.isFinite(joined.position.x) && Number.isFinite(joined.position.y));

          const state = botManager.state();
          assert.equal(state.connected, true);
          assert.equal(state.mode, config.mode);
          assert.equal(String(state.version), config.version);
          assert.ok(state.position && Number.isFinite(state.position.x) && Number.isFinite(state.position.y) && Number.isFinite(state.position.z));
          assert.ok(Number.isFinite(state.health) && state.health > 0, `${config.version}: health`);
          assert.ok(Number.isFinite(state.food) && state.food >= 0, `${config.version}: food`);
          assert.ok(state.dimension !== undefined && state.dimension !== null, `${config.version}: dimension`);
          if (config.mode === 'legacy') {
            assert.ok(Number.isFinite(state.entities), 'legacy state.entities');
            assert.ok(Array.isArray(state.messages), 'legacy state.messages');
          }
          assert.equal(botManager.mode, config.mode);
          assert.ok(botManager.connected);

          const marker = `mode-${config.mode}-${Date.now()}`;
          const sent = await botManager.action('chat', { message: marker });
          assert.equal(sent.sent, true);
          await sleep(700);
          const history = await botManager.chatHistory(10);
          assert.ok(Array.isArray(history));
          assert.ok(
            history.some((line) => String(line).includes(marker)),
            `chatHistory should contain our message: ${JSON.stringify(history)}`
          );
          const historyAction = await botManager.action('chat_history', { limit: 10 });
          assert.ok(
            historyAction.messages.some((entry) =>
              String(entry && entry.message !== undefined ? entry.message : entry).includes(marker)
            ),
            `chat_history action should contain our message: ${JSON.stringify(historyAction.messages)}`
          );

          if (config.mode === 'legacy') {
            // LegacyBot rejects actions it cannot speak; BotManager must append the
            // mode hint so callers can tell why (task-14 requirement).
            await assert.rejects(botManager.action('inventory', { action: 'list' }), (error) => {
              assert.match(error.message, /LEGACY_ACTION_UNSUPPORTED/);
              assert.match(error.message, /mode:'legacy'/);
              return true;
            });
          }

          const waited = await botManager.action('wait', { ms: 100 });
          assert.equal(waited.waited, 100);
          const left = await botManager.leave();
          assert.equal(left.left, true);
          assert.equal(botManager.connected, false);
          assert.equal(botManager.state().connected, false);
          assert.equal(botManager.mode, null);

          // Best-effort emulated-future coverage: Minecraft 26.4 is unreleased, so
          // join the live 26.3 server through the 26.4 alias (protocol sync +
          // presentAs:'26.3'). This exercises the same code path a 26.4 server would.
          if (config.version === '26.3') {
            const future = await botManager.join({
              host: '127.0.0.1',
              port: config.port,
              username: config.username,
              version: '26.4',
              timeoutMs: 90000
            });
            try {
              assert.equal(future.connected, true);
              assert.equal(future.mode, 'emulated-future');
              // Proxy run: the live server is really 26.3, so the version reported by
              // the server ping (and therefore join()/state()) stays 26.3. Against a
              // real 26.4 server the same code path would report 26.4.
              assert.equal(String(future.version), '26.3');
              assert.equal(future.emulatedAs, '26.3');
              const futureState = botManager.state();
              assert.equal(futureState.connected, true);
              assert.equal(futureState.mode, 'emulated-future');
              assert.equal(String(futureState.version), '26.3');
              assert.ok(Array.isArray(await botManager.chatHistory(5)));
            } finally {
              await botManager.leave().catch(() => {});
            }
          }
        } finally {
          await botManager.leave().catch(() => {});
        }
      } finally {
        if (server) stopResult = await stopVersionServer(server, config);
        await sleep(100);
        rmSync(workDir, { recursive: true, force: true });
        t.diagnostic(`join mode ${config.version} timings: ${JSON.stringify(timings)}`);
      }
      assert.equal(stopResult?.exited, true, `${config.version}: server process must exit`);
      assert.equal(stopResult?.portClosed, true, `${config.version}: port ${config.port} must be released`);
    });
  }
});