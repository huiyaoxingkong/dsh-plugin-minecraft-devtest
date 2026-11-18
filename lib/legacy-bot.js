// Native-protocol legacy (1.7.10) player bot for client-free Minecraft testing.
//
// Mineflayer only supports 1.8.8+, so this module talks the 1.7.10 wire protocol
// directly through `minecraft-protocol` (no third-party mods, no Mineflayer).
// It is intentionally small: a raw protocol client with just enough state to be
// useful for dev-server checks (join / chat / look / goto / dig / place / use /
// attack / wait / stop). Complex inventory/container/crafting actions are not
// implemented and throw `LEGACY_ACTION_UNSUPPORTED`.
//
// ---------------------------------------------------------------------------
// 1.7.10 protocol quirks worth remembering (verified against a real 1.7.10
// vanilla server; field names below are from minecraft-data's
// `require('minecraft-data')('1.7.10').protocol` 鈥?do not "fix" them by memory):
//
// * Clientbound `position` (0x08) sends **feetY + 1.62** (the eye/stance height)
//   in its Y field, NOT the feet position. So: feetY = packet.y - 1.62.
// * Serverbound `position` / `position_look` have the wire order
//   `x, feetY, stance(height), z, ...` but minecraft-data names the 2nd field
//   `stance` and the 3rd field `y` 鈥?i.e. the object passed to `client.write`
//   must be `{ x, stance: feetY, y: feetY + 1.62, z, onGround }`.
//   Sending it the other way round makes the server log "moved wrongly" and
//   lag the player back (and breaks reach checks for block interactions).
// * After a clientbound `position` (join spawn / RCON `/tp` / lagback) the
//   client must echo the position back (vanilla client behaviour) or the
//   server keeps `hasMoved == false` and silently ignores block placement.
// * `block_dig` = { status: 0|1|2|3|4|5, location: {x, y, z}, face }.
// * `block_place` = { location, direction, heldItem, cursorX, cursorY, cursorZ };
//   direction 255 means "use item in air". The server places the item that is
//   in its own inventory slot, `heldItem` is only used for client resync.
// * Serverbound `look` = { yaw, pitch, onGround }.
// * 1.7.10 chat is a raw JSON string, not signed chat; translate it for humans.
// ---------------------------------------------------------------------------

import { EventEmitter } from 'node:events';

import minecraftProtocol from 'minecraft-protocol';

export const LEGACY_ACTION_UNSUPPORTED = 'LEGACY_ACTION_UNSUPPORTED';

export const LEGACY_DEFAULT_VERSION = '1.7.10';
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 25565;
const DEFAULT_USERNAME = 'DSH_LegacyBot';
const DEFAULT_TIMEOUT_MS = 30000;
const MAX_TIMEOUT_MS = 180000;

const EYE_HEIGHT = 1.62;
const CHAT_BUFFER_LIMIT = 200;
const STATE_CHAT_LIMIT = 30;

const GOTO_TIMEOUT_MS = 60000;
const GOTO_STEP = 0.1;
const GOTO_TICK_MS = 50;

// 1.7.10 face ids (same values used by block_place direction):
// 0 = -Y (down), 1 = +Y (up), 2 = -Z (north), 3 = +Z (south), 4 = -X (west), 5 = +X (east).
const FACE_BY_NAME = Object.freeze({
  down: 0,
  up: 1,
  north: 2,
  south: 3,
  west: 4,
  east: 5
});

const SUPPORTED_ACTIONS = Object.freeze([
  'chat', 'look', 'goto', 'dig', 'place', 'use_block', 'use_item', 'attack', 'wait', 'stop'
]);

function sleep(ms) {
  const delay = Number(ms);
  return new Promise((resolve) => setTimeout(resolve, Number.isFinite(delay) && delay > 0 ? delay : 0));
}

function clampNumber(value, fallback, min, max) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function round3(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.round(numeric * 1000) / 1000 : 0;
}

function asCoord(value, name) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`LegacyBot action needs a numeric ${name} (got ${JSON.stringify(value)})`);
  return numeric;
}

function asBlockCoord(value, name) {
  return Math.floor(asCoord(value, name));
}

function asFace(value, fallback = 1) {
  if (value == null) return fallback;
  if (typeof value === 'string') {
    const mapped = FACE_BY_NAME[value.toLowerCase()];
    if (mapped == null) throw new Error(`LegacyBot: unknown face "${value}" (use down/up/north/south/west/east or 0-5)`);
    return mapped;
  }
  const numeric = Number(value);
  if (!Number.isInteger(numeric) || numeric < 0 || numeric > 5) {
    throw new Error(`LegacyBot: face must be 0-5 or a direction name (got ${JSON.stringify(value)})`);
  }
  return numeric;
}

function errorMessage(error) {
  if (!error) return 'unknown error';
  if (typeof error === 'string') return error;
  return error.message ? String(error.message) : String(error);
}

// Flatten a 1.7.10 chat JSON component into plain text.
function flattenChatComponent(node) {
  if (node == null) return '';
  if (typeof node === 'string') return node;
  if (typeof node === 'number' || typeof node === 'boolean') return String(node);
  if (Array.isArray(node)) return node.map(flattenChatComponent).join('');
  let text = '';
  if (typeof node.text === 'string') text += node.text;
  if (typeof node.translate === 'string') {
    const args = Array.isArray(node.with) ? node.with.map(flattenChatComponent) : [];
    if (node.translate === 'chat.type.text') text += `${args[0] ?? ''}: ${args[1] ?? ''}`;
    else if (node.translate === 'chat.type.announcement') text += `[${args[0] ?? 'Server'}] ${args[1] ?? ''}`;
    else text += args.length > 0 ? args.join(' ') : node.translate;
  }
  if (Array.isArray(node.extra)) text += node.extra.map(flattenChatComponent).join('');
  return text;
}

function chatText(raw) {
  if (typeof raw !== 'string') return '';
  const trimmed = raw.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return raw;
  try {
    return flattenChatComponent(JSON.parse(raw));
  } catch {
    return raw;
  }
}

/**
 * Native 1.7.10 protocol bot (no Mineflayer).
 *
 * The connection is opened by the constructor (`createClient` runs immediately);
 * `join()` waits for the classic login + first server position handshake.
 */
export class LegacyBot extends EventEmitter {
  constructor({ host = DEFAULT_HOST, port = DEFAULT_PORT, username = DEFAULT_USERNAME, version = LEGACY_DEFAULT_VERSION, auth = 'offline', timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    super();
    this.host = String(host || DEFAULT_HOST);
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
      throw new Error(`LegacyBot: invalid port ${JSON.stringify(port)}`);
    }
    if (!username || typeof username !== 'string') throw new Error('LegacyBot: username is required');
    this.port = numericPort;
    this._version = String(version || LEGACY_DEFAULT_VERSION);
    this._username = username;
    this.timeoutMs = clampNumber(timeoutMs, DEFAULT_TIMEOUT_MS, 1000, MAX_TIMEOUT_MS);
    if (auth !== 'offline') throw new Error(`LegacyBot only supports auth "offline" (got ${JSON.stringify(auth)})`);

    this._ended = false;
    this._connected = false;
    this._joined = false;
    this._quit = false;
    this._endReason = null;
    this._lastError = null;
    this._kickReason = null;
    this._entityId = null;
    this._position = null;
    this._health = 20;
    this._food = 20;
    this._gameMode = 0;
    this._dimension = 0;
    this._entities = new Map();
    this._messages = [];
    this._hotbar = new Array(9).fill(null);
    this._selectedSlot = 0;
    this._lastDig = null;
    this._joinTimer = null;
    this._joinWaiters = null;
    this._quitWaiters = null;

    this._client = this._createClient();
  }

  // -------------------------------------------------------------------------
  // Public interface
  // -------------------------------------------------------------------------

  /** Raw minecraft-protocol client (escape hatch for tests / advanced setup). */
  get client() {
    return this._client;
  }

  get connected() {
    return this._connected && !this._ended;
  }

  get version() {
    return this._version;
  }

  get username() {
    return this._username;
  }

  /** Wait for login + the first server position packet. */
  async join() {
    if (this._joined) return this._joinResult();
    if (this._ended) {
      throw new Error(`LegacyBot join failed: connection already ended (${this._endReason || 'no reason'})`);
    }
    if (this._joinWaiters) return this._joinWaiters.promise;

    let resolveJoin;
    let rejectJoin;
    const promise = new Promise((resolve, reject) => {
      resolveJoin = resolve;
      rejectJoin = reject;
    });
    this._joinWaiters = { promise, resolve: resolveJoin, reject: rejectJoin };
    this._joinTimer = setTimeout(() => {
      this._settleJoin(new Error(`LegacyBot join timed out after ${this.timeoutMs}ms (host ${this.host}:${this.port}, version ${this.version})`));
    }, this.timeoutMs);
    this._joinTimer.unref?.();
    return promise;
  }

  /** Disconnect from the server. Idempotent; resolves once the socket is closed. */
  async quit() {
    this._quit = true;
    if (this._ended) return;
    if (!this._client) return;
    const ended = new Promise((resolve) => {
      const timer = setTimeout(resolve, 2000);
      timer.unref?.();
      this._quitWaiters = () => {
        clearTimeout(timer);
        resolve();
      };
      this._client.once('end', () => {
        clearTimeout(timer);
        resolve();
      });
    });
    try {
      this._client.end('LegacyBot quit');
    } catch {
      // Socket may already be gone; the 'end' handler still settles the promise.
    }
    await ended;
  }

  /** Plain JSON snapshot of the client-side state. */
  state() {
    const position = this._position
      ? {
          x: round3(this._position.x),
          y: round3(this._position.y),
          z: round3(this._position.z),
          yaw: round3(this._position.yaw ?? 0),
          pitch: round3(this._position.pitch ?? 0)
        }
      : { x: 0, y: 0, z: 0, yaw: 0, pitch: 0 };
    return {
      username: this.username,
      version: this.version,
      connected: this.connected,
      position,
      health: this._health,
      food: this._food,
      gameMode: this._gameMode,
      dimension: this._dimension,
      entities: this._entities.size,
      messages: this.chatHistory(STATE_CHAT_LIMIT)
    };
  }

  /** Most recent chat lines, oldest first. */
  chatHistory(limit = STATE_CHAT_LIMIT) {
    const count = clampNumber(limit, STATE_CHAT_LIMIT, 1, CHAT_BUFFER_LIMIT);
    return this._messages.slice(-Math.floor(count)).map((entry) => entry.text);
  }

  /**
   * Execute one supported action. Resolves with a plain JSON-serializable result.
   * Unsupported actions throw an Error containing `LEGACY_ACTION_UNSUPPORTED`.
   */
  async action(name, params = {}) {
    const action = String(name ?? '').trim().toLowerCase();
    if (!SUPPORTED_ACTIONS.includes(action)) {
      throw new Error(
        `${LEGACY_ACTION_UNSUPPORTED}: action "${name}" is not implemented by the 1.7.10 legacy bot; ` +
        `supported actions: ${SUPPORTED_ACTIONS.join(', ')}`
      );
    }
    if (!this.connected) {
      throw new Error(`LegacyBot action "${action}" failed: not connected (join the server first)`);
    }
    switch (action) {
      case 'chat':
        return this._actionChat(params);
      case 'look':
        return this._actionLook(params);
      case 'goto':
        return this._actionGoto(params);
      case 'dig':
        return this._actionDig(params);
      case 'place':
      case 'use_block':
        return this._actionPlace(params);
      case 'use_item':
        return this._actionUseItem(params);
      case 'attack':
        return this._actionAttack(params);
      case 'wait':
        return this._actionWait(params);
      case 'stop':
        return this._actionStop(params);
      default:
        // Defensive: SUPPORTED_ACTIONS and the switch must stay in sync.
        throw new Error(`${LEGACY_ACTION_UNSUPPORTED}: action "${name}" is not implemented by the 1.7.10 legacy bot`);
    }
  }

  // -------------------------------------------------------------------------
  // Client wiring
  // -------------------------------------------------------------------------

  _createClient() {
    const client = minecraftProtocol.createClient({
      host: this.host,
      port: this.port,
      username: this.username,
      version: this.version,
      auth: 'offline',
      keepAlive: true,
      hideErrors: true
    });

    client.on('connect', () => {
      this._connected = true;
    });
    client.on('login', (packet) => {
      // First PLAY-state packet: join game.
      this._entityId = packet.entityId ?? null;
      if (Number.isFinite(packet.gameMode)) this._gameMode = packet.gameMode;
      if (Number.isFinite(packet.dimension)) this._dimension = packet.dimension;
      this._entities.clear();
      this._connected = true;
      this._sendClientSettings();
      this.emit('login', this.state());
    });
    client.on('position', (packet) => this._onServerPosition(packet));
    client.on('update_health', (packet) => {
      if (Number.isFinite(packet.health)) this._health = packet.health;
      if (Number.isFinite(packet.food)) this._food = packet.food;
    });
    client.on('game_state_change', (packet) => {
      if (packet.reason === 'change_game_mode' && Number.isFinite(packet.gameMode)) this._gameMode = packet.gameMode;
    });
    client.on('respawn', (packet) => {
      if (Number.isFinite(packet.dimension)) this._dimension = packet.dimension;
      if (Number.isFinite(packet.gamemode)) this._gameMode = packet.gamemode;
      this._entities.clear();
      this._position = null;
    });
    client.on('held_item_slot', (packet) => {
      if (Number.isInteger(packet.slot) && packet.slot >= 0 && packet.slot < 9) this._selectedSlot = packet.slot;
    });
    client.on('set_slot', (packet) => this._trackSlot(packet));
    client.on('window_items', (packet) => this._trackWindowItems(packet));

    for (const eventName of ['named_entity_spawn', 'spawn_entity', 'spawn_entity_living', 'spawn_entity_painting', 'spawn_entity_experience_orb', 'spawn_entity_weather']) {
      client.on(eventName, (packet) => {
        if (!packet || packet.entityId == null) return;
        // 1.7.10 spawn packets encode entity position as fixed-point (x32) ints.
        const entity = { id: packet.entityId, kind: eventName };
        for (const axis of ['x', 'y', 'z']) {
          if (Number.isFinite(packet[axis])) entity[axis] = packet[axis] / 32;
        }
        this._entities.set(packet.entityId, entity);
      });
    }
    client.on('entity_destroy', (packet) => {
      for (const id of packet.entityIds ?? []) this._entities.delete(id);
    });

    client.on('chat', (packet) => {
      const text = chatText(packet?.message);
      if (!text) return;
      this._pushMessage(text, packet?.message);
    });

    client.on('kick_disconnect', (packet) => this._onKicked(packet?.reason, 'kicked by server'));
    client.on('disconnect', (packet) => this._onKicked(packet?.reason, 'disconnected during login'));

    client.on('error', (error) => {
      this._lastError = error;
      if (this._joinWaiters) {
        this._settleJoin(new Error(`LegacyBot join failed: ${errorMessage(error)}`));
      }
      this._emitSafe('error', error);
    });
    client.on('end', (reason) => {
      this._onEnd(reason);
    });
    return client;
  }

  _sendClientSettings() {
    try {
      this._client.write('settings', {
        locale: 'en_US',
        viewDistance: 10,
        chatFlags: 0,
        chatColors: true,
        difficulty: 1,
        showCape: true
      });
    } catch {
      // Settings are cosmetic for a headless bot; ignore serialization differences.
    }
  }

  // Clientbound `position` sends eye height in the Y field; feetY = y - 1.62.
  _onServerPosition(packet) {
    const feetY = Number(packet.y) - EYE_HEIGHT;
    this._position = {
      x: Number(packet.x),
      y: feetY,
      z: Number(packet.z),
      yaw: Number(packet.yaw) || 0,
      pitch: Number(packet.pitch) || 0
    };
    // Echo the teleport back like the vanilla client does. Without this the
    // 1.7.10 server keeps hasMoved=false and ignores block placement.
    this._writePosition(this._position.y, this._position.yaw, this._position.pitch);
    if (!this._joined) {
      this._settleJoin(null);
    }
    this.emit('position', this.state().position);
  }

  _settleJoin(error) {
    if (!this._joinWaiters) return;
    const waiters = this._joinWaiters;
    this._joinWaiters = null;
    if (this._joinTimer) {
      clearTimeout(this._joinTimer);
      this._joinTimer = null;
    }
    if (error) {
      waiters.reject(error);
      return;
    }
    this._joined = true;
    this.emit('spawn', this.state());
    waiters.resolve(this._joinResult());
  }

  _joinResult() {
    const position = this.state().position;
    return { username: this.username, version: this.version, position, connected: this.connected };
  }

  _onKicked(reason, fallback) {
    this._kickReason = chatText(reason) || reason || fallback;
    const message = `LegacyBot ${fallback}: ${this._kickReason}`;
    if (this._joinWaiters) {
      this._settleJoin(new Error(`LegacyBot join failed: ${message}`));
    }
    this._emitSafe('kicked', { reason: this._kickReason });
    this._emitSafe('error', new Error(message));
  }

  _onEnd(reason) {
    if (this._ended) return;
    this._ended = true;
    this._connected = false;
    this._endReason = reason || this._kickReason || 'connection closed';
    if (this._joinWaiters) {
      const suffix = this._kickReason ? ` (${this._kickReason})` : ` (${this._endReason})`;
      this._settleJoin(new Error(`LegacyBot join failed${suffix}`));
    }
    if (this._quitWaiters) {
      const waiter = this._quitWaiters;
      this._quitWaiters = null;
      waiter();
    }
    this.emit('end', this._endReason);
  }

  // Emitting 'error' with no listener would throw; only forward when observed.
  _emitSafe(event, payload) {
    if (event === 'error' && this.listenerCount('error') === 0) return;
    this.emit(event, payload);
  }

  _pushMessage(text, raw) {
    this._messages.push({ text, raw });
    if (this._messages.length > CHAT_BUFFER_LIMIT) this._messages.splice(0, this._messages.length - CHAT_BUFFER_LIMIT);
    this._emitSafe('chat', { text, raw });
  }

  // Player inventory container: window 0, slot 36..44 = hotbar 0..8.
  _trackSlot(packet) {
    if (!packet) return;
    const windowId = Number(packet.windowId);
    const slot = Number(packet.slot);
    if (windowId !== 0 || !Number.isInteger(slot) || slot < 36 || slot > 44) return;
    this._hotbar[slot - 36] = packet.item && packet.item.blockId >= 0 ? packet.item : null;
  }

  _trackWindowItems(packet) {
    if (!packet || Number(packet.windowId) !== 0 || !Array.isArray(packet.items)) return;
    for (let i = 0; i < 9; i++) {
      const item = packet.items[36 + i];
      this._hotbar[i] = item && item.blockId >= 0 ? item : null;
    }
  }

  _currentItem() {
    return this._hotbar[this._selectedSlot] ?? null;
  }

  _heldItemPayload() {
    const item = this._currentItem();
    if (!item) return { blockId: -1 };
    return { blockId: item.blockId, itemCount: item.itemCount ?? 1, itemDamage: item.itemDamage ?? 0 };
  }

  // Writes a serverbound position_look packet with the correct 1.7.10 field
  // mapping: wire order is x, feetY, stance(height), z, so minecraft-data's
  // `stance` field carries feetY and its `y` field carries feetY + 1.62.
  _writePositionAt(x, feetY, z, yaw = 0, pitch = 0) {
    this._client.write('position_look', {
      x,
      stance: feetY,
      y: feetY + EYE_HEIGHT,
      z,
      yaw,
      pitch,
      onGround: true
    });
  }

  _writePosition(feetY, yaw = 0, pitch = 0) {
    if (!this._position) return;
    this._writePositionAt(this._position.x, feetY, this._position.z, yaw, pitch);
  }

  // -------------------------------------------------------------------------
  // Actions
  // -------------------------------------------------------------------------

  async _actionChat(params) {
    const message = params?.message;
    if (typeof message !== 'string' || message.length === 0) {
      throw new Error('LegacyBot action "chat" needs a non-empty string parameter "message"');
    }
    if (message.length > 100) {
      throw new Error('LegacyBot action "chat": message is longer than the vanilla 1.7.10 chat limit (100)');
    }
    this._client.write('chat', { message });
    return { sent: true, message };
  }

  async _actionLook(params) {
    const yaw = params?.yaw == null ? (this._position?.yaw ?? 0) : asCoord(params.yaw, 'yaw');
    const pitch = params?.pitch == null ? (this._position?.pitch ?? 0) : asCoord(params.pitch, 'pitch');
    if (this._position) {
      this._position.yaw = yaw;
      this._position.pitch = pitch;
    }
    this._client.write('look', { yaw, pitch, onGround: true });
    return { yaw, pitch };
  }

  async _actionGoto(params) {
    if (!this._position) throw new Error('LegacyBot action "goto" failed: no server position yet');
    const target = {
      x: asCoord(params?.x, 'x'),
      y: params?.y == null ? this._position.y : asCoord(params.y, 'y'),
      z: asCoord(params?.z, 'z')
    };
    const range = clampNumber(params?.range, 1.0, 0.05, 16);
    const timeoutMs = clampNumber(params?.timeoutMs, GOTO_TIMEOUT_MS, 1000, GOTO_TIMEOUT_MS);
    const startedAt = Date.now();
    let lastDistance = Infinity;
    for (;;) {
      const position = this._position;
      if (!position) {
        return { arrived: false, position: this.state().position, target, reason: 'server position was lost (respawn or disconnect)' };
      }
      const dx = target.x - position.x;
      const dy = target.y - position.y;
      const dz = target.z - position.z;
      const distance = Math.sqrt(dx * dx + dy * dy + dz * dz);
      lastDistance = distance;
      if (distance <= range) {
        return { arrived: true, position: this.state().position, target, distance: round3(distance) };
      }
      if (Date.now() - startedAt > timeoutMs) {
        return {
          arrived: false,
          position: this.state().position,
          target,
          reason: `timeout after ${timeoutMs}ms (distance ${round3(distance)})`,
          distance: round3(distance)
        };
      }
      const horizontal = Math.hypot(dx, dz);
      const step = Math.min(GOTO_STEP, horizontal, Math.max(0.01, distance));
      const yaw = horizontal > 1e-6 ? (Math.atan2(-dx, dz) * 180) / Math.PI : (position.yaw ?? 0);
      this._position.x += horizontal > 1e-6 ? (dx / horizontal) * step : 0;
      // Do not simulate gravity/collision; keep the feet height we were on.
      this._position.z += horizontal > 1e-6 ? (dz / horizontal) * step : 0;
      this._writePositionAt(this._position.x, this._position.y, this._position.z, yaw, 0);
      await sleep(GOTO_TICK_MS);
    }
    // Note: unreachable, kept for clarity that the loop always returns.
    return { arrived: false, position: this.state().position, target, reason: `stopped at distance ${round3(lastDistance)}` };
  }

  async _actionDig(params) {
    const location = {
      x: asBlockCoord(params?.x, 'x'),
      y: asBlockCoord(params?.y, 'y'),
      z: asBlockCoord(params?.z, 'z')
    };
    const face = asFace(params?.face, 1);
    const breakMs = clampNumber(params?.breakMs, 250, 0, 120000);
    this._client.write('block_dig', { status: 0, location, face });
    this._lastDig = { location, face };
    if (breakMs > 0) await sleep(breakMs);
    this._client.write('block_dig', { status: 2, location, face });
    return { started: true, finished: true, location, face };
  }

  async _actionPlace(params) {
    const location = {
      x: asBlockCoord(params?.x, 'x'),
      y: asBlockCoord(params?.y, 'y'),
      z: asBlockCoord(params?.z, 'z')
    };
    const direction = asFace(params?.face, 1);
    this._client.write('block_place', {
      location,
      direction,
      heldItem: this._heldItemPayload(),
      cursorX: clampNumber(params?.cursorX, 8, 0, 16),
      cursorY: clampNumber(params?.cursorY, 8, 0, 16),
      cursorZ: clampNumber(params?.cursorZ, 8, 0, 16)
    });
    return { placed: true, location, face: direction, heldItem: this._heldItemPayload() };
  }

  async _actionUseItem(params) {
    // 1.7.10 "use item in air": block_place with direction 255 and location (-1,-1,-1).
    this._client.write('block_place', {
      location: { x: -1, y: -1, z: -1 },
      direction: 255,
      heldItem: this._heldItemPayload(),
      cursorX: 0,
      cursorY: 0,
      cursorZ: 0
    });
    return { used: true, heldItem: this._heldItemPayload() };
  }

  async _actionAttack(params) {
    let entityId = params?.entityId;
    if (entityId == null) {
      // Pick the nearest tracked entity that is not the bot itself.
      let best = null;
      let bestDistance = Infinity;
      const position = this._position ?? { x: 0, y: 0, z: 0 };
      for (const [id, entity] of this._entities) {
        if (id === this._entityId) continue;
        const dx = (entity.x ?? position.x) - position.x;
        const dz = (entity.z ?? position.z) - position.z;
        const distance = dx * dx + dz * dz;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = id;
        }
      }
      entityId = best;
    }
    if (entityId == null) {
      throw new Error('LegacyBot action "attack" failed: no entityId given and no nearby entity is known from spawn packets');
    }
    entityId = Math.trunc(asCoord(entityId, 'entityId'));
    this._client.write('use_entity', { target: entityId, mouse: 1 });
    return { attacked: true, entityId };
  }

  async _actionWait(params) {
    const ms = clampNumber(params?.ms, 1000, 0, 60000);
    await sleep(ms);
    return { waited: ms };
  }

  async _actionStop() {
    if (this._lastDig) {
      try {
        this._client.write('block_dig', { status: 1, location: this._lastDig.location, face: this._lastDig.face });
      } catch {
        // Abort is best effort.
      }
      this._lastDig = null;
    }
    if (this._position) this._writePosition(this._position.y, this._position.yaw ?? 0, this._position.pitch ?? 0);
    return { stopped: true };
  }
}

export default LegacyBot;

