import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { test } from 'node:test';

import { RconClient, rconCommand } from '../lib/rcon.js';

// Packet types from https://wiki.vg/RCON (the fake server below speaks the wire protocol).
const TYPE_RESPONSE_VALUE = 0;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_EXEC_COMMAND = 2;
const TYPE_AUTH = 3;

function encodePacket(requestId, type, payload = '') {
  const body = Buffer.from(String(payload ?? ''), 'utf8');
  const frame = Buffer.allocUnsafe(body.length + 14);
  frame.writeInt32LE(body.length + 10, 0);
  frame.writeInt32LE(requestId, 4);
  frame.writeInt32LE(type, 8);
  body.copy(frame, 12);
  frame[12 + body.length] = 0;
  frame[13 + body.length] = 0;
  return frame;
}

/**
 * Minimal fake Minecraft RCON server. `onCommand` receives
 * `{ socket, requestId, payload, respond }`; return a string to auto-respond,
 * return false when the callback wrote/closed everything itself, or return
 * undefined to stay silent.
 */
async function startFakeServer({ password = 'secret', onCommand } = {}) {
  const sockets = new Set();
  const requests = [];
  const server = createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => {});
    let buffer = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        if (buffer.length < 4) return;
        const length = buffer.readInt32LE(0);
        if (buffer.length < 4 + length) return;
        const requestId = buffer.readInt32LE(4);
        const type = buffer.readInt32LE(8);
        const payload = buffer.subarray(12, 4 + length - 2).toString('utf8');
        buffer = buffer.subarray(4 + length);
        requests.push({ requestId, type, payload });

        if (type === TYPE_AUTH) {
          socket.write(encodePacket(payload === password ? requestId : -1, TYPE_AUTH_RESPONSE, ''));
          continue;
        }
        if (type !== TYPE_EXEC_COMMAND) continue;

        const respond = (text, id = requestId) => socket.write(encodePacket(id, TYPE_RESPONSE_VALUE, text));
        if (!onCommand) {
          respond(`ok:${payload}`);
          continue;
        }
        const result = onCommand({ socket, requestId, payload, respond });
        if (typeof result === 'string') respond(result);
        if (result === false) return;
      }
    });
  });

  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });

  let closed = false;
  return {
    port: server.address().port,
    requests,
    get openSockets() {
      return sockets.size;
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const socket of sockets) socket.destroy();
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function waitFor(predicate, timeoutMs = 2000, intervalMs = 25) {
  return new Promise((resolveWait) => {
    const deadline = Date.now() + timeoutMs;
    const tick = () => {
      if (predicate()) {
        resolveWait(true);
        return;
      }
      if (Date.now() > deadline) {
        resolveWait(false);
        return;
      }
      setTimeout(tick, intervalMs);
    };
    tick();
  });
}

function trackClient(t, client) {
  t.after(() => client.close());
  return client;
}

test('authenticates and runs commands (leading slash stripped)', async (t) => {
  const fake = await startFakeServer({ password: 'secret', onCommand: ({ payload }) => `echo:${payload}` });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 2000 }));
  await client.connect();
  assert.equal(client.connected, true);

  assert.equal(await client.command('list'), 'echo:list');
  assert.equal(await client.command('/time query gametime'), 'echo:time query gametime');

  assert.equal(fake.requests[0].type, TYPE_AUTH);
  assert.equal(fake.requests[0].payload, 'secret');
  const commandRequests = fake.requests.filter((request) => request.type === TYPE_EXEC_COMMAND);
  assert.equal(commandRequests.length, 2);
  // The auth request id and command ids must be non-negative and increasing.
  assert.ok(commandRequests[0].requestId > fake.requests[0].requestId);
  assert.ok(commandRequests[1].requestId > commandRequests[0].requestId);
});

test('rejects a wrong RCON password', async (t) => {
  const fake = await startFakeServer({ password: 'right-password' });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'wrong-password', timeoutMs: 2000 }));
  await assert.rejects(client.connect(), /authentication failed/i);
  assert.equal(client.connected, false);
});

test('reports an unreachable server', async () => {
  const fake = await startFakeServer({});
  const port = fake.port;
  await fake.close();

  const client = new RconClient({ port, password: 'secret', timeoutMs: 1500 });
  try {
    await assert.rejects(client.connect(), /RCON connection|ECONNREFUSED|closed/i);
    assert.equal(client.connected, false);
  } finally {
    client.close();
  }
});

test('command() requires a connection; close() is idempotent', async () => {
  const client = new RconClient({ port: 1, password: 'secret', timeoutMs: 1000 });
  await assert.rejects(client.command('list'), /not connected/i);
  assert.equal(client.connected, false);

  client.close();
  client.close(); // must not throw
  await assert.rejects(client.command('list'), /not connected/i);
});

test('accumulates a response split over several packets', async (t) => {
  const fake = await startFakeServer({
    onCommand: ({ respond }) => {
      respond('first-');
      respond('second');
      respond('third');
      return false;
    },
  });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 2000 }));
  await client.connect();
  assert.equal(await client.command('say hi'), 'first-secondthird');
});

test('ignores responses whose requestId does not match', async (t) => {
  const fake = await startFakeServer({
    onCommand: ({ respond, requestId }) => {
      respond('NOISE-FROM-A-STALE-REQUEST', requestId + 500);
      respond('real-answer', requestId);
      return false;
    },
  });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 2000 }));
  await client.connect();
  const response = await client.command('list');
  assert.equal(response, 'real-answer');
});

test('rejects when the server closes the connection mid-command', async (t) => {
  const fake = await startFakeServer({
    onCommand: ({ socket }) => {
      setTimeout(() => socket.destroy(), 20);
      return undefined;
    },
  });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 2000 }));
  await client.connect();
  await assert.rejects(client.command('list'), /closed/i);
  await waitFor(() => client.connected === false);
  assert.equal(client.connected, false);
});

test('times out when the server never answers', async (t) => {
  const fake = await startFakeServer({ onCommand: () => undefined });
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 500 }));
  await client.connect();
  const startedAt = Date.now();
  await assert.rejects(client.command('list'), /timed out/i);
  assert.ok(Date.now() - startedAt >= 400, 'timeout should be honoured');
  // A timeout is per-command only: the connection itself stays usable.
  assert.equal(client.connected, true);
});

test('rejects an empty command', async (t) => {
  const fake = await startFakeServer({});
  t.after(() => fake.close());

  const client = trackClient(t, new RconClient({ port: fake.port, password: 'secret', timeoutMs: 2000 }));
  await client.connect();
  await assert.rejects(client.command('   '), /empty/i);
});

test('rconCommand() is a one-shot connect/command/close helper', async (t) => {
  const fake = await startFakeServer({ password: 'secret', onCommand: ({ payload }) => `once:${payload}` });
  t.after(() => fake.close());

  const response = await rconCommand({ port: fake.port, password: 'secret', timeoutMs: 2000 }, 'say hello');
  assert.equal(response, 'once:say hello');

  // The helper must close its socket when done.
  assert.equal(await waitFor(() => fake.openSockets === 0), true, 'rconCommand should close the connection');
});
