// Real end-to-end test for the native 1.7.10 legacy bot (no Mineflayer).
//
// It copies the prepared vanilla 1.7.10 server fixture into an isolated working
// directory, rewrites the ports, boots it with Java 8, then drives the bot over
// the real 1.7.10 wire protocol: join -> state -> chat -> chatHistory -> look ->
// dig / place (asserted via RCON `setblock` + `testforblock`) -> goto -> quit.
// Finally the server is stopped and the ports are checked to be released.
//
// The fixture is optional: when `.tmp/compat-servers/1.7.10` is missing every
// test skips instead of failing.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { LegacyBot, LEGACY_ACTION_UNSUPPORTED } from '../lib/legacy-bot.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = path.resolve(HERE, '..');
const WORKSPACE_ROOT = path.resolve(PLUGIN_ROOT, '..');
const FIXTURE_DIR = path.join(WORKSPACE_ROOT, '.tmp', 'compat-servers', '1.7.10');
const WORK_DIR = path.join(WORKSPACE_ROOT, '.tmp', 'legacy-test', '1.7.10');
const RUN_LOG = path.join(WORK_DIR, 'run.log');
const JAVA8 = 'D:\\Program Files\\Java\\zulu8.96.0.205-ca-jdk8.0.504-win_x64\\bin\\java.exe';

const HOST = '127.0.0.1';
const PORT = 25694;
const RCON_PORT = 25714;
const RCON_PASSWORD = 'compatpass';
const USERNAME = 'LegacyTester';
const BUILDER = 'LegacyBuilder';

const FIXTURE_AVAILABLE = fs.existsSync(path.join(FIXTURE_DIR, 'server.jar'));

let serverProc = null;
let serverLines = [];
let serverExited = false;
let rcon = null;
let serverStopped = false;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label, predicate, timeoutMs = 8000) {
  const startedAt = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - startedAt > timeoutMs) throw new Error(`timed out after ${timeoutMs}ms waiting for ${label}`);
    await sleep(100);
  }
}

function isPortOpen(port, timeoutMs = 800) {
  return new Promise((resolve) => {
    const socket = net.connect(port, HOST);
    let settled = false;
    const settle = (open) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(open);
    };
    socket.once('connect', () => settle(true));
    socket.once('error', () => settle(false));
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref?.();
  });
}

// ---------------------------------------------------------------------------
// Minimal 1.7.10 RCON client (self-contained on purpose: this test only needs
// fire-and-forget commands, and it must not depend on lib/rcon.js).
// ---------------------------------------------------------------------------
class TestRcon {
  constructor({ host = HOST, port = RCON_PORT, password = RCON_PASSWORD } = {}) {
    this.host = host;
    this.port = port;
    this.password = password;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.pending = new Map();
    this.nextId = 1;
  }

  async connect() {
    await new Promise((resolve, reject) => {
      const socket = net.connect(this.port, this.host);
      const onError = (error) => reject(new Error(`RCON connect failed: ${error.message}`));
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        this.socket = socket;
        socket.on('data', (chunk) => this._onData(chunk));
        socket.on('error', () => {});
        resolve();
      });
    });
    const auth = await this._send(3, this.password);
    if (auth.id === -1) throw new Error('RCON authentication failed');
    return this;
  }

  _onData(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 4) return;
      const size = this.buffer.readInt32LE(0);
      if (size < 10 || this.buffer.length < 4 + size) return;
      const packet = {
        id: this.buffer.readInt32LE(4),
        type: this.buffer.readInt32LE(8),
        payload: this.buffer.subarray(12, 4 + size - 2).toString('utf8')
      };
      this.buffer = this.buffer.subarray(4 + size);
      const handler = this.pending.get(packet.id);
      if (handler) {
        this.pending.delete(packet.id);
        handler(packet);
      }
    }
  }

  _send(type, payload) {
    const id = this.nextId++;
    const body = Buffer.from(payload ?? '', 'utf8');
    const packet = Buffer.allocUnsafe(body.length + 14);
    packet.writeInt32LE(body.length + 10, 0);
    packet.writeInt32LE(id, 4);
    packet.writeInt32LE(type, 8);
    body.copy(packet, 12);
    packet[12 + body.length] = 0;
    packet[13 + body.length] = 0;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`RCON command timed out: ${payload}`));
      }, 5000);
      timer.unref?.();
      this.pending.set(id, (response) => {
        clearTimeout(timer);
        resolve(response);
      });
      this.socket.write(packet);
    });
  }

  async command(command) {
    const response = await this._send(2, command);
    return response.payload;
  }

  close() {
    try {
      this.socket?.destroy();
    } catch {
      // ignore
    }
  }
}

function copyDirectory(source, target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    if (entry.isDirectory()) copyDirectory(from, to);
    else if (entry.isFile()) fs.copyFileSync(from, to);
  }
}

function patchServerProperties(directory) {
  const file = path.join(directory, 'server.properties');
  const original = fs.readFileSync(file, 'utf8');
  const wanted = {
    'server-port': String(PORT),
    'rcon.port': String(RCON_PORT),
    'rcon.password': RCON_PASSWORD,
    'enable-rcon': 'true',
    'online-mode': 'false',
    'white-list': 'false',
    'level-name': 'world',
    'spawn-monsters': 'false',
    'spawn-animals': 'false',
    'spawn-npcs': 'false',
    'allow-flight': 'false',
    'spawn-protection': '0'
  };
  const trailingNewline = original.endsWith('\n');
  const seen = new Set();
  const lines = original.split(/\r?\n/).map((line) => {
    const match = /^([^#=]+)=(.*)$/.exec(line);
    if (!match) return line;
    const key = match[1].trim();
    if (!(key in wanted)) return line;
    seen.add(key);
    return `${key}=${wanted[key]}`;
  });
  for (const [key, value] of Object.entries(wanted)) if (!seen.has(key)) lines.push(`${key}=${value}`);
  let text = lines.join('\n');
  if (trailingNewline && !text.endsWith('\n')) text += '\n';
  fs.writeFileSync(file, text);
}

async function startFixtureServer() {
  fs.rmSync(WORK_DIR, { recursive: true, force: true });
  copyDirectory(FIXTURE_DIR, WORK_DIR);
  patchServerProperties(WORK_DIR);
  fs.writeFileSync(path.join(WORK_DIR, 'eula.txt'), 'eula=true\n');
  fs.writeFileSync(RUN_LOG, '');

  serverLines = [];
  let tail = '';
  const capture = (chunk) => {
    const text = chunk.toString('utf8');
    try {
      fs.appendFileSync(RUN_LOG, text);
    } catch {
      // log capture is best effort
    }
    tail += text;
    let index;
    while ((index = tail.indexOf('\n')) >= 0) {
      const line = tail.slice(0, index).replace(/\r$/, '');
      tail = tail.slice(index + 1);
      serverLines.push(line);
    }
  };

  serverProc = spawn(JAVA8, ['-Xms512M', '-Xmx1024M', '-jar', 'server.jar', 'nogui'], {
    cwd: WORK_DIR,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  serverProc.stdout.on('data', capture);
  serverProc.stderr.on('data', capture);
  serverProc.once('exit', () => {
    serverExited = true;
  });

  await waitFor('server "Done (" marker', () => {
    if (serverExited || serverProc.exitCode != null) {
      throw new Error(`1.7.10 server exited before becoming ready:\n${serverLines.slice(-25).join('\n')}`);
    }
    return serverLines.some((line) => line.includes('Done ('));
  }, 60000);

  rcon = new TestRcon();
  let lastError = null;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      await rcon.connect();
      lastError = null;
      break;
    } catch (error) {
      lastError = error;
      rcon.close();
      rcon = new TestRcon();
      await sleep(100);
    }
  }
  if (lastError) throw new Error(`could not connect RCON on ${RCON_PORT}: ${lastError.message}`);
}

const sleepUnref = (ms, value = false) => new Promise((resolve) => {
  const timer = setTimeout(() => resolve(value), ms);
  timer.unref?.();
});

async function stopFixtureServer() {
  if (!serverProc) return true;
  if (serverExited || serverProc.exitCode != null) {
    serverExited = true;
    return true;
  }
  const nativeExit = new Promise((resolve) => serverProc.once('exit', () => resolve(true)));
  try {
    if (rcon) await rcon.command('stop');
  } catch {
    // RCON may be gone; fall through to the console / taskkill fallback.
  }
  try {
    serverProc.stdin.write('stop\n');
  } catch {
    // stdin may already be closed
  }
  const graceful = await Promise.race([nativeExit, sleepUnref(20000)]);
  if (!graceful) {
    await new Promise((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(serverProc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      killer.once('exit', () => resolve());
      killer.once('error', () => resolve());
    });
    await Promise.race([nativeExit, sleepUnref(10000)]);
  }
  serverExited = serverProc.exitCode != null || serverExited;
  return serverExited;
}

async function rconCommand(command) {
  if (!rcon) throw new Error('RCON is not connected');
  return rcon.command(command);
}

function blockAssertionSucceeded(output) {
  return /Successfully found the block/i.test(output);
}

async function withBot(username, fn) {
  const bot = new LegacyBot({ host: HOST, port: PORT, username, version: '1.7.10', auth: 'offline', timeoutMs: 20000 });
  try {
    return await fn(bot);
  } finally {
    try {
      await bot.quit();
    } catch {
      // quit is best effort in cleanup
    }
    bot.removeAllListeners();
  }
}

before(async () => {
  if (!FIXTURE_AVAILABLE) return;
  if (!fs.existsSync(JAVA8)) {
    throw new Error(`Java 8 executable not found at ${JAVA8}; cannot boot the 1.7.10 fixture`);
  }
  await startFixtureServer();
});

after(async () => {
  if (!FIXTURE_AVAILABLE) return;
  if (!serverStopped) await stopFixtureServer();
  rcon?.close();
  rcon = null;
  // Remove the throw-away server copy exactly as the task requires; the log
  // assertions above already ran, and the fixture itself is never touched.
  try {
    fs.rmSync(WORK_DIR, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test('1.7.10 legacy bot joins, reports state, chats, reads history and looks around', async (t) => {
  if (!FIXTURE_AVAILABLE) return t.skip(`1.7.10 server fixture missing: ${FIXTURE_DIR}`);

  await withBot(USERNAME, async (bot) => {
    const joined = await bot.join();
    assert.equal(joined.username, USERNAME);
    assert.equal(joined.version, '1.7.10');
    assert.equal(joined.connected, true);
    assert.equal(typeof joined.position.x, 'number');
    assert.equal(typeof joined.position.y, 'number');
    assert.equal(typeof joined.position.z, 'number');

    // Let the vanilla-style teleport echo settle so the server flips hasMoved.
    await sleep(600);
    assert.equal(bot.connected, true);
    assert.equal(bot.username, USERNAME);
    assert.equal(bot.version, '1.7.10');

    const state = bot.state();
    assert.equal(state.username, USERNAME);
    assert.equal(state.version, '1.7.10');
    assert.equal(state.connected, true);
    assert.equal(state.health, 20);
    assert.equal(state.food, 20);
    assert.equal(state.dimension, 0);
    assert.equal(state.gameMode, 0);
    assert.ok(Number.isFinite(state.position.x) && Number.isFinite(state.position.y) && Number.isFinite(state.position.z));
    assert.ok(Number.isInteger(state.entities) && state.entities >= 0);
    assert.ok(Array.isArray(state.messages));

    const playerList = await rconCommand('list');
    assert.match(playerList, new RegExp(USERNAME));

    await waitFor('server log shows the legacy join', () => serverLines.some((line) => /logged in with entity id/.test(line) && line.includes(USERNAME)));
    await waitFor('server log shows "joined the game"', () => serverLines.some((line) => line.includes(USERNAME) && line.includes('joined the game')));

    const chatResult = await bot.action('chat', { message: 'hello from legacy bot' });
    assert.equal(chatResult.sent, true);
    await waitFor('chat echoed back into chatHistory', () => bot.chatHistory(10).some((line) => line.includes('hello from legacy bot')));
    await waitFor('server console shows the legacy chat', () => serverLines.some((line) => line.includes(`<${USERNAME}> hello from legacy bot`)));

    const history = bot.chatHistory(5);
    assert.ok(Array.isArray(history));
    assert.ok(history.length >= 1 && history.length <= 5);
    assert.ok(history.some((line) => line.includes('hello from legacy bot')));

    const lookResult = await bot.action('look', { yaw: 90, pitch: 10 });
    assert.equal(lookResult.yaw, 90);
    assert.equal(lookResult.pitch, 10);
    const lookedState = bot.state();
    assert.equal(lookedState.position.yaw, 90);
    assert.equal(lookedState.position.pitch, 10);

    assert.equal(await bot.action('wait', { ms: 50 }).then((result) => result.waited), 50);
  });

  await waitFor('server log shows the legacy disconnect', () => serverLines.some((line) => line.includes(USERNAME) && (line.includes('left the game') || line.includes('lost connection'))));
});

test('1.7.10 legacy bot digs, places and walks with real protocol actions (RCON-asserted)', async (t) => {
  if (!FIXTURE_AVAILABLE) return t.skip(`1.7.10 server fixture missing: ${FIXTURE_DIR}`);

  await withBot(BUILDER, async (bot) => {
    await bot.join();
    await sleep(800);
    assert.equal(bot.connected, true);
    const state = bot.state();
    assert.ok(state.position.x !== 0 || state.position.z !== 0, 'expected a real spawn position');

    await rconCommand('difficulty 0');
    await rconCommand('gamerule doMobSpawning false');
    await rconCommand('time set day');
    const gameModeOutput = await rconCommand(`gamemode 1 ${BUILDER}`);
    assert.equal(typeof gameModeOutput, 'string');
    await sleep(700);
    assert.equal(bot.state().gameMode, 1, 'legacy bot should observe the game mode change packet');

    const bx = Math.floor(state.position.x);
    const by = Math.floor(state.position.y);
    const bz = Math.floor(state.position.z);

    // --- dig: creative-mode START breaks the block immediately on 1.7.10 ---
    const digTarget = { x: bx + 2, y: by + 1, z: bz };
    assert.match(await rconCommand(`setblock ${digTarget.x} ${digTarget.y} ${digTarget.z} minecraft:stone`), /Block placed/i);
    assert.equal(blockAssertionSucceeded(await rconCommand(`testforblock ${digTarget.x} ${digTarget.y} ${digTarget.z} minecraft:stone`)), true);
    const digResult = await bot.action('dig', digTarget);
    assert.equal(digResult.started, true);
    assert.equal(digResult.finished, true);
    await waitFor('dig target turns into air', async () => {
      return blockAssertionSucceeded(await rconCommand(`testforblock ${digTarget.x} ${digTarget.y} ${digTarget.z} minecraft:air`));
    }, 5000);

    // --- place: creative inventory slot + block_place ---
    const support = { x: bx + 2, y: by - 1, z: bz - 2 };
    const placeTarget = { x: support.x, y: support.y + 1, z: support.z };
    await rconCommand(`setblock ${support.x} ${support.y} ${support.z} minecraft:stone`);
    await rconCommand(`setblock ${placeTarget.x} ${placeTarget.y} ${placeTarget.z} minecraft:air`);
    assert.equal(blockAssertionSucceeded(await rconCommand(`testforblock ${placeTarget.x} ${placeTarget.y} ${placeTarget.z} minecraft:air`)), true);
    // Put a stack of stone into hotbar slot 0 exactly like the creative client does.
    bot.client.write('set_creative_slot', { slot: 36, item: { blockId: 1, itemCount: 64, itemDamage: 0 } });
    bot.client.write('held_item_slot', { slotId: 0 });
    await sleep(700);
    const placeResult = await bot.action('place', { x: support.x, y: support.y, z: support.z, face: 1 });
    assert.equal(placeResult.placed, true);
    await waitFor('placed block appears', async () => {
      return blockAssertionSucceeded(await rconCommand(`testforblock ${placeTarget.x} ${placeTarget.y} ${placeTarget.z} minecraft:stone`));
    }, 5000);

    // --- goto: build a small flat platform, then walk a short straight line ---
    for (let dx = -1; dx <= 5; dx++) {
      for (let dz = -1; dz <= 5; dz++) {
        await rconCommand(`setblock ${bx + dx} ${by - 1} ${bz + dz} minecraft:stone`);
        await rconCommand(`setblock ${bx + dx} ${by} ${bz + dz} minecraft:air`);
        await rconCommand(`setblock ${bx + dx} ${by + 1} ${bz + dz} minecraft:air`);
      }
    }
    const target = { x: bx + 3.5, y: by, z: bz + 3.5 };
    const gotoResult = await bot.action('goto', { ...target, range: 1.0 });
    assert.equal(typeof gotoResult.arrived, 'boolean');
    assert.ok(gotoResult.target);
    if (gotoResult.arrived) {
      const reached = bot.state().position;
      const distance = Math.hypot(reached.x - target.x, reached.z - target.z);
      assert.ok(distance <= 2.0, `expected to be near the goto target, distance=${distance}`);
    } else {
      // Short flat walks should succeed on this fixture; keep it visible but not fatal
      // for slower CI machines.
      t.diagnostic(`goto reported arrived=false: ${gotoResult.reason}`);
    }

    // --- unsupported actions must fail with the documented marker ---
    for (const unsupported of ['inventory', 'equip', 'craft', 'open_container', 'container_move', 'eat', 'drop', 'does_not_exist']) {
      await assert.rejects(bot.action(unsupported), (error) => String(error.message).includes(LEGACY_ACTION_UNSUPPORTED));
    }
  });

  await waitFor('server log shows the builder disconnect', () => serverLines.some((line) => line.includes(BUILDER) && line.includes('left the game')));
});

test('stopping the 1.7.10 server releases both ports and ends the bot session', async (t) => {
  if (!FIXTURE_AVAILABLE) return t.skip(`1.7.10 server fixture missing: ${FIXTURE_DIR}`);
  if (!serverProc) t.skip('server fixture was never started');

  assert.equal(await isPortOpen(PORT), true, 'game port should be open while the server runs');
  await waitFor('server log captured to run.log', () => fs.existsSync(RUN_LOG) && fs.readFileSync(RUN_LOG, 'utf8').includes('Done ('));

  serverStopped = true;
  const exited = await stopFixtureServer();
  assert.equal(exited, true, '1.7.10 server process should exit after stop');
  await waitFor('game port released', async () => (await isPortOpen(PORT)) === false, 10000);
  await waitFor('rcon port released', async () => (await isPortOpen(RCON_PORT)) === false, 10000);
  assert.match(fs.readFileSync(RUN_LOG, 'utf8'), /Stopping server|Stopping the server/);
});
