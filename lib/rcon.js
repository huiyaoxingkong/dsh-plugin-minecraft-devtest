import { connect } from 'node:net';

import { normalizeCmd, shortError } from './util.js';

// Minecraft RCON packet types (see https://wiki.vg/RCON).
const TYPE_RESPONSE_VALUE = 0;
const TYPE_EXEC_COMMAND = 2;
const TYPE_AUTH_RESPONSE = 2;
const TYPE_AUTH = 3;

// Command output may arrive in several packets; wait this long for silence
// before treating the response as complete (v1 strategy from docs/CONTRACTS.md).
const RESPONSE_IDLE_MS = 100;

// A sane upper bound so a corrupt stream cannot make us allocate forever.
const MAX_PACKET_BYTES = 4 * 1024 * 1024;

function encodePacket(requestId, type, payload = '') {
  const body = Buffer.from(String(payload ?? ''), 'utf8');
  // int32 length = requestId(4) + type(4) + payload(N) + 2 null terminators.
  const packet = Buffer.allocUnsafe(body.length + 14);
  packet.writeInt32LE(body.length + 10, 0);
  packet.writeInt32LE(requestId, 4);
  packet.writeInt32LE(type, 8);
  body.copy(packet, 12);
  packet[12 + body.length] = 0;
  packet[13 + body.length] = 0;
  return packet;
}

/**
 * Minimal Minecraft RCON client.
 *
 * One command is allowed in flight at a time; ~100 ms of socket silence marks
 * the end of a multi-packet response. All timers are cleared when a request
 * settles so the client never keeps the event loop alive.
 */
export class RconClient {
  constructor({ host = '127.0.0.1', port = 25575, password = 'dshmcdevtest', timeoutMs = 10000 } = {}) {
    this.host = String(host || '127.0.0.1');
    const numericPort = Number(port);
    this.port = Number.isInteger(numericPort) && numericPort > 0 && numericPort < 65536 ? numericPort : 25575;
    this.password = String(password ?? '');
    const numericTimeout = Number(timeoutMs);
    this.timeoutMs = Number.isFinite(numericTimeout) && numericTimeout > 0 ? Math.max(500, numericTimeout) : 10000;

    this._socket = null;
    this._connectPromise = null;
    this._auth = null;
    this._authRequestId = 0;
    this._authenticated = false;
    this._pending = null;
    this._buffer = Buffer.alloc(0);
    this._requestId = 0;
    this._socketError = null;
  }

  /** True once authentication succeeded and the socket is still open. */
  get connected() {
    return Boolean(this._socket && this._authenticated && !this._socket.destroyed);
  }

  /** Authenticate against the server. Resolves with `this`, throws on failure. */
  async connect() {
    if (this.connected) return this;
    if (!this._connectPromise) {
      const promise = this._doConnect();
      this._connectPromise = promise;
      // Prevent an unhandled rejection warning when the caller awaits later.
      promise
        .finally(() => {
          if (this._connectPromise === promise) this._connectPromise = null;
        })
        .catch(() => {});
    }
    return this._connectPromise;
  }

  /** Send one command (leading `/` is stripped) and resolve with its output. */
  async command(cmd) {
    const normalized = normalizeCmd(cmd);
    if (!normalized) throw new Error('RCON command is empty');
    if (!this.connected) throw new Error('RCON client is not connected');
    if (this._pending) throw new Error('RCON client is busy with a previous command');

    const requestId = this._nextRequestId();
    const response = new Promise((resolve, reject) => {
      const pending = { requestId, chunks: [], settled: false, resolve, reject, timer: null, idleTimer: null };
      this._pending = pending;
      pending.timer = setTimeout(() => {
        this._settlePending(new Error(`RCON command timed out after ${this.timeoutMs}ms: ${normalized}`));
      }, this.timeoutMs);
    });

    try {
      this._socket.write(encodePacket(requestId, TYPE_EXEC_COMMAND, normalized));
    } catch (error) {
      this._settlePending(new Error(`failed to send RCON command: ${shortError(error)}`));
    }
    return response;
  }

  /** Close the socket. Idempotent; safe before connect and after failures. */
  close() {
    this._authenticated = false;
    this._settleAuth(new Error(`RCON connection to ${this.host}:${this.port} closed`));
    this._settlePending(new Error('RCON connection closed before the command response completed'));
    const socket = this._socket;
    this._socket = null;
    this._buffer = Buffer.alloc(0);
    if (socket) {
      try {
        socket.removeAllListeners();
        socket.destroy();
      } catch {
        // best effort only
      }
    }
  }

  _nextRequestId() {
    this._requestId = (this._requestId % 2147483646) + 1;
    return this._requestId;
  }

  _doConnect() {
    return new Promise((resolve, reject) => {
      const socket = connect({ host: this.host, port: this.port });
      this._socket = socket;
      this._authenticated = false;
      this._socketError = null;
      this._buffer = Buffer.alloc(0);
      this._auth = { settled: false, timer: null, resolve, reject, requestId: 0 };

      this._auth.timer = setTimeout(() => {
        this._settleAuth(new Error(`RCON authentication to ${this.host}:${this.port} timed out after ${this.timeoutMs}ms`));
        this.close();
      }, this.timeoutMs);

      socket.setNoDelay(true);

      socket.once('connect', () => {
        if (this._socket !== socket) return;
        this._authRequestId = this._nextRequestId();
        if (this._auth) this._auth.requestId = this._authRequestId;
        try {
          socket.write(encodePacket(this._authRequestId, TYPE_AUTH, this.password));
        } catch (error) {
          this._socketError = error;
          this._settleAuth(new Error(`failed to send RCON authentication: ${shortError(error)}`));
          this.close();
        }
      });

      socket.on('data', (chunk) => {
        if (this._socket !== socket) return;
        this._onData(chunk);
      });

      socket.once('error', (error) => {
        this._socketError = error;
      });

      socket.once('close', () => this._onSocketClose(socket));
    });
  }

  _onData(chunk) {
    this._buffer = this._buffer.length === 0 ? Buffer.from(chunk) : Buffer.concat([this._buffer, chunk]);

    for (;;) {
      if (this._buffer.length < 4) return;
      const length = this._buffer.readInt32LE(0);
      if (length < 10 || length > MAX_PACKET_BYTES) {
        const error = new Error(`malformed RCON packet (length=${length})`);
        this._socketError = error;
        this._settleAuth(error);
        this._settlePending(error);
        this.close();
        return;
      }
      if (this._buffer.length < 4 + length) return;

      const packet = this._buffer.subarray(4, 4 + length);
      this._buffer = this._buffer.subarray(4 + length);

      const requestId = packet.readInt32LE(0);
      const type = packet.readInt32LE(4);
      const payload = packet.subarray(8, length - 2).toString('utf8');
      this._handlePacket(requestId, type, payload);
    }
  }

  _handlePacket(requestId, type, payload) {
    // Authentication phase: ignore stray RESPONSE_VALUE packets some servers send.
    if (this._auth) {
      if (type !== TYPE_AUTH_RESPONSE) return;
      if (requestId === -1 || requestId !== this._authRequestId) {
        this._settleAuth(new Error(`RCON authentication failed for ${this.host}:${this.port} (check rcon.password)`));
        this.close();
        return;
      }
      this._authenticated = true;
      this._settleAuth(null, this);
      return;
    }

    const pending = this._pending;
    if (!pending || pending.settled) return; // unsolicited packet
    if (requestId !== pending.requestId) return; // stale response from a timed-out command
    if (type !== TYPE_RESPONSE_VALUE) return;

    pending.chunks.push(payload);
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    pending.idleTimer = setTimeout(() => this._settlePending(), RESPONSE_IDLE_MS);
    if (typeof pending.idleTimer.unref === 'function') pending.idleTimer.unref();
  }

  _onSocketClose(socket) {
    if (this._socket !== socket) return; // another connection replaced this one
    this._socket = null;
    this._authenticated = false;
    this._buffer = Buffer.alloc(0);

    const detail = this._socketError ? shortError(this._socketError) : 'connection closed';
    const message = `RCON connection to ${this.host}:${this.port} closed: ${detail}`;
    this._settleAuth(new Error(message));

    const pending = this._pending;
    if (pending && pending.chunks.length > 0) {
      // The whole response arrived just before the server hung up.
      this._settlePending();
    } else {
      this._settlePending(new Error(`${message} while waiting for a command response`));
    }
  }

  _settleAuth(error, value) {
    const auth = this._auth;
    if (!auth || auth.settled) return;
    auth.settled = true;
    this._auth = null;
    if (auth.timer) clearTimeout(auth.timer);
    if (error) auth.reject(error);
    else auth.resolve(value);
  }

  _settlePending(error) {
    const pending = this._pending;
    if (!pending || pending.settled) return;
    pending.settled = true;
    this._pending = null;
    if (pending.timer) clearTimeout(pending.timer);
    if (pending.idleTimer) clearTimeout(pending.idleTimer);
    if (error) pending.reject(error);
    else pending.resolve(pending.chunks.join(''));
  }
}

/**
 * One-shot helper: connect, run one command, always close.
 * Resolves with the raw response text.
 */
export async function rconCommand(opts, cmd) {
  const client = new RconClient(opts ?? {});
  try {
    await client.connect();
    return await client.command(cmd);
  } finally {
    client.close();
  }
}
