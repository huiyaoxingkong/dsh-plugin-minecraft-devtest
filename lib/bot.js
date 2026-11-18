// Mineflayer player bot for client-free Minecraft testing.
//
// Contract: docs/CONTRACTS.md -> `lib/bot.js`.
//
// This module is the "no game client needed" half of minecraft-devtest: a real
// Minecraft protocol client (mineflayer) that joins a dev server, exposes its
// state and executes a small deterministic action set. It never starts or stops
// a server itself; RCON/server lifecycle lives in lib/server.js.
//
// Everything returns plain JSON-serializable objects (camelCase). Failures that
// are programming/config errors (not connected, unknown action, missing item,
// missing materials, ...) throw `Error` with a readable English message; expected
// negative outcomes that a test card should be able to inspect (goto not reached,
// no target to attack, ...) are returned as `{ ok-ish field: false }` instead.

// IMPORTANT: protocol-compat must be imported before mineflayer is required so the
// vendored 26.2/26.3/26.4 payload is installed and the loader version window is
// widened before loader.js captures it. All mineflayer / minecraft-data /
// minecraft-protocol usage below goes through these exports.
import {
  mineflayer,
  minecraftData,
  minecraftProtocol,
  syncFutureVersionProtocol,
  EMULATED_VERSIONS,
  FUTURE_VERSIONS
} from './protocol-compat.js';
import pathfinderPackage from 'mineflayer-pathfinder';

import { RELEASES, compareVersions, javaMajorForVersion } from './versions.js';
import { shortError, sleep } from './util.js';

// mineflayer-pathfinder is CommonJS: default import gives module.exports.
const { pathfinder, Movements, goals } = pathfinderPackage;

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 25565;
const DEFAULT_USERNAME = 'DSH_Bot';
const DEFAULT_AUTH = 'offline';
const DEFAULT_JOIN_TIMEOUT_MS = 30000;
const MAX_JOIN_TIMEOUT_MS = 180000;

const DEFAULT_GOTO_TIMEOUT_MS = 30000;
const MAX_GOTO_TIMEOUT_MS = 60000;

const CHAT_BUFFER_LIMIT = 200;
const CHAT_STATE_LIMIT = 30;
const SENT_CHAT_DEDUPE_MS = 5000;

const LIVING_ENTITY_TYPES = new Set(['mob', 'animal', 'hostile', 'water_creature', 'ambient', 'passive', 'player']);

const ALWAYS_EDIBLE = new Set([
  'apple', 'baked_potato', 'beetroot', 'beetroot_soup', 'bread', 'carrot', 'cooked_beef',
  'cooked_chicken', 'cooked_cod', 'cooked_mutton', 'cooked_porkchop', 'cooked_rabbit',
  'cooked_salmon', 'cookie', 'dried_kelp', 'glow_berries', 'golden_apple', 'golden_carrot',
  'honey_bottle', 'melon_slice', 'mushroom_stew', 'poisonous_potato', 'potato', 'pumpkin_pie',
  'rabbit_stew', 'sweet_berries', 'suspicious_stew', 'tropical_fish'
]);

// Modded servers can expose block states / registry entries that the bundled
// minecraft-data version does not know about. Those client-side parse errors are
// degraded to warnings instead of failing the connection: join/state/chat must
// stay usable against a "mods + vanilla protocol" server.
const NON_FATAL_CLIENT_ERROR_PATTERN = /unknown block (?:state|id|type)|block state|chunk data|chunk pars|palette|registry data|prismarine-(?:block|chunk)/i;

// Errors that mean "the version negotiation/detection went wrong", where a second
// join attempt with a known version (explicit option or serverManager.status()) can help.
const VERSION_RELATED_ERROR_PATTERN = /unsupported (?:protocol )?version|no data for version|server version '.*' is not supported|unknown (?:minecraft )?version|oldest supported version|latest supported version|failed to (?:obtain|detect|get) (?:the )?server version|status (?:response|request)|ping/i;

// ---------------------------------------------------------------------------
// Protocol / version support matrix
// ---------------------------------------------------------------------------
// The bot can only join versions that BOTH have client protocol data bundled with
// minecraft-data AND fall inside mineflayer's own loader support window. The
// window is defined by mineflayer's oldest/latest supported versions; the newest
// minecraft-protocol supportedVersions entry caps what the loader accepts.
// Unsupported versions must degrade gracefully: join() throws an Error whose
// message contains BOT_VERSION_UNSUPPORTED (+ reason) so callers (quickcheck,
// cards) can downgrade the bot check to a warning instead of failing the run.
export const BOT_VERSION_UNSUPPORTED = 'BOT_VERSION_UNSUPPORTED';

const SUPPORT_CACHE = new Map();
let loaderSupportWindow = null;

/**
 * The four supported bot modes (plus unsupported):
 *   native          - official Mineflayer window (1.8.8 .. newest release before 26.2)
 *   emulated        - 26.2/26.3, joined through the vendored upstream PR payload
 *   legacy          - 1.7.x, joined through the built-in LegacyBot (native 1.7 protocol)
 *   emulated-future - 26.4+ best-effort future alias (unreleased data, protocol sync)
 *   unsupported     - everything else (e.g. 1.6.x, unknown/future versions without data)
 */
export const BOT_MODES = Object.freeze(['native', 'emulated', 'legacy', 'emulated-future', 'unsupported']);

const NATIVE_MIN_VERSION = '1.8.8';
const LEGACY_MIN_VERSION = '1.7';
const LEGACY_MAX_VERSION = '1.7.10';

function newestNativeMaxVersion() {
  const firstEmulated = EMULATED_VERSIONS[0] ?? '26.2';
  const newest = RELEASES
    .map((release) => release.id)
    .find((id) => compareVersions(id, firstEmulated) < 0);
  return newest ?? '26.1.2';
}

function supportWindow() {
  if (loaderSupportWindow) return loaderSupportWindow;
  const testedVersions = Array.isArray(mineflayer.testedVersions) ? mineflayer.testedVersions.map(String) : [];
  const protocolList = Array.isArray(minecraftProtocol?.supportedVersions)
    ? minecraftProtocol.supportedVersions.map(String)
    : [];
  loaderSupportWindow = {
    oldest: String(mineflayer.oldestSupportedVersion ?? NATIVE_MIN_VERSION),
    nativeMin: NATIVE_MIN_VERSION,
    nativeMax: newestNativeMaxVersion(),
    emulated: EMULATED_VERSIONS.slice(),
    future: FUTURE_VERSIONS.slice(),
    loaderLatest: String(mineflayer.latestSupportedVersion ?? '999.0'),
    testedVersions,
    supportedVersions: protocolList
  };
  return loaderSupportWindow;
}

function minecraftDataHasClientData(version) {
  try {
    const data = minecraftData(version);
    return Boolean(data && data.blocks && Object.keys(data.blocks).length > 0);
  } catch {
    return false;
  }
}

function resolveVersionEntry(input) {
  const raw = String(input ?? '').trim();
  if (!raw) return { raw, entry: null, resolvedVersion: null, protocolVersion: null };
  // A bare protocol number (e.g. 762) is accepted too; pick the newest release.
  if (/^\d+$/.test(raw)) {
    const protocol = Number(raw);
    const candidates = (minecraftData.versions?.pc ?? []).filter((entry) => Number(entry?.version) === protocol);
    const entry = candidates
      .slice()
      .sort((a, b) => Number(b.dataVersion ?? 0) - Number(a.dataVersion ?? 0))[0] ?? null;
    return { raw, entry, resolvedVersion: entry?.minecraftVersion ?? null, protocolVersion: protocol };
  }
  let entry = minecraftData.versionsByMinecraftVersion?.pc?.[raw] ?? null;
  if (!entry) {
    const pool = minecraftData.versions?.pc ?? [];
    entry = pool.find((candidate) => String(candidate?.minecraftVersion ?? '').toLowerCase() === raw.toLowerCase()) ?? null;
  }
  if (!entry) {
    const match = /(\d+\.\d+(?:\.\d+)?)/.exec(raw);
    if (match) entry = minecraftData.versionsByMinecraftVersion?.pc?.[match[1]] ?? null;
  }
  return { raw, entry, resolvedVersion: entry?.minecraftVersion ?? null, protocolVersion: entry?.version ?? null };
}

function buildSupportResult(resolved, { supported, mode, reason }) {
  const window_ = supportWindow();
  return {
    version: resolved.raw,
    resolvedVersion: resolved.resolvedVersion,
    protocolVersion: resolved.protocolVersion ?? null,
    supported,
    mode,
    reason,
    javaMajor: resolved.resolvedVersion ? javaMajorForVersion(resolved.resolvedVersion) : null,
    oldestSupported: window_.nativeMin,
    highestSupported: window_.nativeMax,
    loaderLatestSupported: window_.loaderLatest,
    emulatedVersions: window_.emulated.slice(),
    futureVersions: window_.future.slice(),
    tested: resolved.resolvedVersion ? window_.testedVersions.includes(resolved.resolvedVersion) : false
  };
}

/**
 * Runtime support probe for the bot: which join mode does a Minecraft version use?
 * Returns { supported, mode, reason, resolvedVersion, protocolVersion, javaMajor,
 * oldestSupported, highestSupported, emulatedVersions, futureVersions, tested, version }.
 * mode is one of BOT_MODES. Accepts a version string ('1.12.2') or protocol number (340).
 */
export function botSupport(version) {
  const key = String(version ?? '').trim();
  if (SUPPORT_CACHE.has(key)) return SUPPORT_CACHE.get(key);
  const resolved = resolveVersionEntry(key);
  const window_ = supportWindow();
  const resolvedVersion = resolved.resolvedVersion;
  const futureLike = /^26\.\d+(?:\.\d+)?$/.test(key) && window_.future.length > 0
    ? { version: key, inFutures: window_.future.includes(key) }
    : null;
  let result;
  if (!resolvedVersion) {
    if (futureLike) {
      result = buildSupportResult({ ...resolved, resolvedVersion: futureLike.version }, {
        supported: futureLike.inFutures,
        mode: futureLike.inFutures ? 'emulated-future' : 'unsupported',
        reason: futureLike.inFutures
          ? `Minecraft ${futureLike.version} is not released yet: best-effort join through the compatibility layer ` +
            `(${(window_.future[window_.emulated.length - 1] ?? window_.emulated[window_.emulated.length - 1] ?? '26.3')} packet data + server protocol sync); ` +
            'may fail with BOT_VERSION_UNSUPPORTED if the wire protocol changed'
          : `Minecraft ${futureLike.version} is newer than the bundled future alias (${window_.future.join(', ')}); ` +
            'update the compatibility layer payload or join will fail with BOT_VERSION_UNSUPPORTED'
      });
    } else {
      result = buildSupportResult(resolved, {
        supported: false,
        mode: 'unsupported',
        reason:
          `minecraft-data has no protocol entry for '${key || '(empty)'}'; the bot supports 1.7.10-26.4 ` +
          `(native ${window_.nativeMin}-${window_.nativeMax}, emulated ${window_.emulated.join('/')}, ` +
          `future ${window_.future.join('/') || 'none'}, legacy 1.7.x)`
      });
    }
  } else if (window_.emulated.includes(resolvedVersion)) {
    result = buildSupportResult(resolved, {
      supported: true,
      mode: 'emulated',
      reason:
        `Minecraft ${resolvedVersion} is joined through the bundled upstream 26.3 compatibility layer ` +
        `(protocol-compat: vendored mineflayer/minecraft-protocol/minecraft-data payloads, emulated versions ${window_.emulated.join('/')})`
    });
  } else if (window_.future.includes(resolvedVersion)) {
    result = buildSupportResult(resolved, {
      supported: true,
      mode: 'emulated-future',
      reason:
        `Minecraft ${resolvedVersion} is not released yet; best-effort join through the compatibility layer ` +
        `(${(window_.emulated[window_.emulated.length - 1] ?? '26.3')} packet data + syncFutureVersionProtocol with the server-ping protocol); ` +
        'may fail with BOT_VERSION_UNSUPPORTED if the wire protocol changed'
    });
  } else if (!minecraftDataHasClientData(resolvedVersion)) {
    result = buildSupportResult(resolved, {
      supported: false,
      mode: 'unsupported',
      reason:
        `minecraft-data has no client data for Minecraft ${resolvedVersion} (protocol ${resolved.protocolVersion}); ` +
        'chunk/world parsing would fail - mineflayer/minecraft-data need an update for this version'
    });
  } else if (compareVersions(resolvedVersion, window_.nativeMin) < 0) {
    if (compareVersions(resolvedVersion, LEGACY_MIN_VERSION) >= 0) {
      result = buildSupportResult(resolved, {
        supported: true,
        mode: 'legacy',
        reason:
          `Minecraft ${resolvedVersion} is below Mineflayer's ${window_.nativeMin} floor; joined through the built-in ` +
          `LegacyBot (native 1.7.x protocol implementation, no mineflayer involved)`
      });
    } else {
      result = buildSupportResult(resolved, {
        supported: false,
        mode: 'unsupported',
        reason: `Minecraft ${resolvedVersion} is older than the legacy bot range (${LEGACY_MIN_VERSION}-${LEGACY_MAX_VERSION})`
      });
    }
  } else if (compareVersions(resolvedVersion, window_.nativeMax) <= 0) {
    result = buildSupportResult(resolved, {
      supported: true,
      mode: 'native',
      reason: `mineflayer supports Minecraft ${resolvedVersion} (protocol ${resolved.protocolVersion}) natively`
    });
  } else {
    result = buildSupportResult(resolved, {
      supported: false,
      mode: 'unsupported',
      reason:
        `Minecraft ${resolvedVersion} is outside the supported range ` +
        `(native ${window_.nativeMin}-${window_.nativeMax}, emulated ${window_.emulated.join('/')}, future ${window_.future.join('/') || 'none'})`
    });
  }
  SUPPORT_CACHE.set(key, result);
  return result;
}

function versionUnsupportedError(support, detail) {
  const shown = support.resolvedVersion ?? support.version ?? 'unknown';
  const mode = support.mode ?? 'unsupported';
  const error = new Error(
    `${BOT_VERSION_UNSUPPORTED}: Minecraft ${shown} cannot be joined by the bot (mode: ${mode}) — ${support.reason}` +
    (detail ? ` (${detail})` : '')
  );
  error.code = BOT_VERSION_UNSUPPORTED;
  error.version = shown;
  error.mode = mode;
  error.support = support;
  return error;
}

function inferVersionFromJoinError(error) {
  const message = String(error?.message ?? '');
  const serverVersion = /Server version '([^']+)'/i.exec(message);
  if (serverVersion) return { version: serverVersion[1], source: `loader: ${serverVersion[1]}` };
  const protocol = /unsupported protocol version:? '?(\d+)'?/i.exec(message);
  if (protocol) {
    const resolved = resolveVersionEntry(protocol[1]);
    return { version: resolved.resolvedVersion ?? protocol[1], source: `protocol ${protocol[1]}` };
  }
  return null;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round2(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  return Number(number.toFixed(2));
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function formatReason(reason) {
  if (reason == null) return 'no reason given';
  if (typeof reason === 'string') return reason;
  try {
    if (typeof reason.toString === 'function') {
      const text = reason.toString();
      if (text && text !== '[object Object]') return text;
    }
    const json = JSON.stringify(reason);
    if (json && json !== '{}') return json;
  } catch {
    // fall through
  }
  return String(reason);
}

function withTimeout(promise, ms, message) {
  let timer = null;
  const timeout = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(message)), Math.max(1, ms));
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// Minimal ChatMessage JSON -> plain text flattener. mineflayer gives us a
// prismarine-chat ChatMessage; `.json` is the raw component tree.
function flattenComponent(component) {
  if (component == null) return '';
  if (typeof component === 'string') return component;
  if (Array.isArray(component)) return component.map((entry) => flattenComponent(entry)).join('');
  if (typeof component !== 'object') return String(component);
  let out = '';
  if (typeof component.text === 'string') {
    out += component.text;
  } else if (typeof component.translate === 'string' && Array.isArray(component.with)) {
    out += component.with.map((entry) => flattenComponent(entry)).join('');
  }
  if (Array.isArray(component.extra)) out += component.extra.map((entry) => flattenComponent(entry)).join('');
  return out;
}

function parseChatMessage(jsonMsg) {
  const json = jsonMsg && typeof jsonMsg === 'object' ? (jsonMsg.json ?? {}) : {};
  let text = '';
  try {
    text = typeof jsonMsg?.toString === 'function' ? jsonMsg.toString() : flattenComponent(json);
  } catch {
    text = flattenComponent(json);
  }
  if (!text) text = flattenComponent(json);
  let username = '';
  let message = text;
  // Vanilla player chat is rendered through the `chat.type.text` chat type.
  if (json && json.translate === 'chat.type.text' && Array.isArray(json.with) && json.with.length >= 2) {
    username = flattenComponent(json.with[0]).trim();
    message = flattenComponent(json.with.slice(1));
  }
  if (!username) {
    const angle = /^<([^>\s]{1,40})>\s?([\s\S]*)$/.exec(text);
    if (angle) {
      username = angle[1];
      message = angle[2];
    } else {
      const arrow = /^([^\s»:]{1,40})\s+»\s+([\s\S]*)$/.exec(text);
      if (arrow) {
        username = arrow[1];
        message = arrow[2];
      }
    }
  }
  if (!message) message = text;
  return { username, message: String(message), at: Date.now() };
}

function normalizeItemName(name) {
  return String(name ?? '').trim().replace(/^minecraft:/, '');
}

export class BotManager {
  constructor() {
    this._bot = null;
    this._connected = false;
    this._lastError = null;
    this._joinedAt = null;
    this._chat = [];
    this._sentChats = [];
    this._window = null;
    this._warnings = [];
    // Join-mode dispatch state: 'native' | 'emulated' | 'legacy' | 'emulated-future'.
    this._mode = null;
    this._legacy = null;
    this._versionOverride = null;
    this._emulatedAs = null;
  }

  /** True when a bot is spawned (native/emulated) or the legacy bot is connected. */
  get connected() {
    if (this._mode === 'legacy') return Boolean(this._legacy?.connected);
    return Boolean(this._connected && this._bot && this._bot.entity);
  }

  /** The underlying mineflayer bot (native/emulated modes only; debugging helper). */
  get bot() {
    return this._bot;
  }

  /** The LegacyBot instance when joined in 'legacy' mode (1.7.x). */
  get legacy() {
    return this._legacy;
  }

  /** Current join mode for the live connection (null when disconnected). */
  get mode() {
    return this._mode;
  }

  // ---------------------------------------------------------------- lifecycle

  async join(options = {}) {
    const config = {
      host: String(options.host || DEFAULT_HOST),
      port: Number(options.port ?? DEFAULT_PORT),
      username: String(options.username || DEFAULT_USERNAME).trim(),
      version: options.version != null && String(options.version).trim() !== '' ? String(options.version).trim() : null,
      auth: String(options.auth || DEFAULT_AUTH),
      timeoutMs: clamp(Math.floor(Number(options.timeoutMs) || DEFAULT_JOIN_TIMEOUT_MS), 1000, MAX_JOIN_TIMEOUT_MS)
    };
    if (!Number.isFinite(config.port) || config.port < 1 || config.port > 65535) {
      throw new Error(`join failed: invalid port '${options.port}'`);
    }
    if (!config.username) throw new Error('join failed: username must not be empty');
    if (config.username.length > 16) {
      throw new Error(`join failed: username '${config.username}' is longer than the 16 character Minecraft limit`);
    }

    // Explicit version: resolve the bot mode and fail fast with
    // BOT_VERSION_UNSUPPORTED before touching any connection, so callers
    // (quickcheck, test cards) can degrade to a warning.
    let explicitSupport = null;
    if (config.version) {
      explicitSupport = botSupport(config.version);
      if (!explicitSupport.supported) throw versionUnsupportedError(explicitSupport);
      config.version = explicitSupport.resolvedVersion ?? config.version;
    }

    // Contract: leave an existing connection before joining again.
    if (this._bot || this._legacy) await this.leave().catch(() => {});

    this._warnings = [];
    this._mode = null;
    this._versionOverride = null;
    this._emulatedAs = null;

    // Resolve the join mode. With an explicit version the mode is known up front;
    // otherwise a server-list ping auto-detects the version (and its protocol,
    // which future-version emulation needs).
    let initialAttempt;
    let detection = null;
    if (config.version) {
      initialAttempt = { version: config.version, kind: 'explicit', mode: explicitSupport.mode };
      if (explicitSupport.mode === 'emulated-future') {
        detection = await this._detectServerVersion(config.host, config.port, Math.min(config.timeoutMs, 8000));
      }
    } else {
      detection = await this._detectServerVersion(config.host, config.port, Math.min(config.timeoutMs, 8000));
      if (detection?.version) {
        const support = botSupport(detection.version);
        if (!support.supported) {
          throw versionUnsupportedError(support, `server ping reported ${detection.rawVersionName ?? detection.version}`);
        }
        initialAttempt = { version: support.resolvedVersion ?? detection.version, kind: 'auto-ping', mode: support.mode };
      } else {
        initialAttempt = { version: null, kind: 'auto', mode: 'native' };
      }
    }

    // Legacy (1.7.x): the built-in LegacyBot speaks the classic protocol directly.
    if (initialAttempt.mode === 'legacy') {
      return this._joinLegacy(config, initialAttempt);
    }

    // Emulated-future (26.4+): sync the server-reported protocol into the emulated
    // data alias before mineflayer connects (best effort; may be unsupported).
    if (initialAttempt.mode === 'emulated-future') {
      const futureVersion = initialAttempt.version;
      const reportedVersion = detection?.version ?? futureVersion;
      const support = botSupport(reportedVersion);
      if (!support.supported) throw versionUnsupportedError(support, 'future version alias is not available');
      const protocol = detection?.protocolVersion ?? null;
      if (!Number.isInteger(protocol) || protocol <= 0) {
        throw versionUnsupportedError(support, 'could not detect the server protocol needed for future-version emulation');
      }
      let sync;
      try {
        sync = syncFutureVersionProtocol(futureVersion, protocol, {
          presentAs: EMULATED_VERSIONS[EMULATED_VERSIONS.length - 1]
        });
      } catch (error) {
        throw versionUnsupportedError(support, `protocol-compat sync failed: ${shortError(error)}`);
      }
      this._emulatedAs = sync?.presentAs ?? null;
      this._versionOverride = reportedVersion;
      this._recordWarning(
        `joined unreleased Minecraft ${reportedVersion} best-effort through the ${this._emulatedAs ?? 'emulated'} compatibility layer ` +
        `(server protocol ${protocol}); wire-format changes may break it`
      );
    }

    const attempted = [];
    const tried = new Set();
    const mark = (versionValue) => (versionValue ? String(versionValue) : 'auto-detect');
    let attempt = initialAttempt;
    tried.add(mark(attempt.version));
    let lastFailure = null;
    for (;;) {
      attempted.push(`${attempt.kind}:${mark(attempt.version)}`);
      try {
        const result = await this._joinOnce(config, attempt);
        result.mode = attempt.mode ?? this._mode ?? 'native';
        if (result.mode === 'emulated') {
          this._recordWarning(
            `joined Minecraft ${result.version} through the emulated upstream compatibility layer (protocol-compat)`
          );
        }
        if (attempted.length > 1) {
          this._recordWarning(`join succeeded with version '${mark(attempt.version)}' after attempt(s): ${attempted.join(' -> ')}`);
        }
        if (this._versionOverride) result.version = this._versionOverride;
        this._mode = result.mode;
        result.emulatedAs = this._emulatedAs ?? null;
        result.warnings = this._warnings.slice();
        return result;
      } catch (error) {
        lastFailure = error;
        // If the loader rejected the server version, surface the graceful
        // BOT_VERSION_UNSUPPORTED error (the support matrix explains why).
        const inferred = inferVersionFromJoinError(error);
        if (inferred) {
          const support = botSupport(inferred.version);
          if (!support.supported) throw versionUnsupportedError(support, `detected from ${inferred.source}`);
        }
        // Version fallback: when the version negotiation/detection fails, retry
        // once with the other strategy — explicit option first, else
        // serverManager.status().version (requirement: ping first, then the
        // server manager's known version).
        if (!VERSION_RELATED_ERROR_PATTERN.test(String(error?.message ?? ''))) throw error;
        let next = null;
        if (attempt.version) {
          if (!tried.has('auto-detect')) next = { version: null, kind: 'auto', mode: attempt.mode ?? 'native' };
        } else {
          const fallbackVersion = config.version ?? (await this._serverManagerVersion());
          if (fallbackVersion && !tried.has(mark(fallbackVersion))) {
            const fallbackSupport = botSupport(fallbackVersion);
            if (!fallbackSupport.supported) throw versionUnsupportedError(fallbackSupport, 'serverManager.status().version');
            next = {
              version: fallbackSupport.resolvedVersion ?? fallbackVersion,
              kind: config.version ? 'explicit' : 'server-manager',
              mode: fallbackSupport.mode
            };
          }
        }
        if (!next) {
          if (attempted.length <= 1) throw error;
          throw new Error(`${shortError(error)} (version attempts: ${attempted.join(' -> ')})`);
        }
        if (next.mode === 'legacy') return this._joinLegacy(config, next);
        tried.add(mark(next.version));
        attempt = next;
      }
    }
  }

  /**
   * Join through the built-in LegacyBot (1.7.x only). Mineflayer's loader starts at
   * 1.8.8, so 1.7.x is handled by the native-protocol LegacyBot from legacy-bot.js.
   */
  async _joinLegacy(config, attempt) {
    let LegacyBot;
    try {
      ({ LegacyBot } = await import('./legacy-bot.js'));
    } catch (error) {
      throw new Error(`join failed: legacy bot module is unavailable: ${shortError(error)}`);
    }
    const legacyVersion = attempt.version ?? LEGACY_MAX_VERSION;
    const legacy = new LegacyBot({
      host: config.host,
      port: config.port,
      username: config.username,
      version: legacyVersion,
      auth: config.auth,
      timeoutMs: config.timeoutMs
    });
    this._legacy = legacy;
    this._mode = 'legacy';
    this._versionOverride = legacyVersion;
    try {
      await withTimeout(Promise.resolve(legacy.join()), config.timeoutMs, `legacy join timed out after ${config.timeoutMs}ms`);
    } catch (error) {
      this._legacy = null;
      this._mode = null;
      this._versionOverride = null;
      try {
        await legacy.quit();
      } catch {
        // ignore: the connection may already be gone
      }
      throw new Error(`join failed: ${shortError(error)}`);
    }
    let state = {};
    try {
      state = legacy.state() ?? {};
    } catch {
      state = {};
    }
    this._recordWarning(
      `joined Minecraft ${legacyVersion} through the built-in LegacyBot (Mineflayer only supports ${NATIVE_MIN_VERSION}+)`
    );
    return {
      connected: true,
      username: legacy.username ?? config.username,
      version: legacy.version ?? legacyVersion,
      position: state.position ?? null,
      health: numberOrNull(state.health),
      food: numberOrNull(state.food),
      dimension: state.dimension ?? null,
      gameMode: state.gameMode ?? null,
      mode: 'legacy',
      requestedVersion: legacyVersion,
      versionSource: attempt.kind,
      emulatedAs: null,
      warnings: this._warnings.slice()
    };
  }

  /** LegacyBot.state() reshaped to the BotManager.state() contract (+ legacy extras). */
  _legacyState() {
    const legacy = this._legacy;
    let raw = {};
    try {
      raw = legacy.state() ?? {};
    } catch (error) {
      this._lastError = `legacy state error: ${shortError(error)}`;
    }
    const position = raw.position ?? null;
    const messages = Array.isArray(raw.messages) ? raw.messages.map((entry) => String(entry)) : this._legacyChatHistory(30);
    const now = Date.now();
    return {
      connected: Boolean(legacy.connected),
      mode: 'legacy',
      username: raw.username ?? legacy.username ?? null,
      version: raw.version ?? legacy.version ?? null,
      position: position
        ? {
            x: round2(position.x),
            y: round2(position.y),
            z: round2(position.z),
            yaw: round2(position.yaw ?? 0),
            pitch: round2(position.pitch ?? 0)
          }
        : null,
      health: numberOrNull(raw.health),
      food: numberOrNull(raw.food),
      saturation: null,
      gameMode: raw.gameMode ?? null,
      dimension: raw.dimension ?? null,
      heldItem: null,
      inventory: [],
      players: [],
      entities: numberOrNull(raw.entities),
      messages: messages.slice(-CHAT_STATE_LIMIT),
      chat: messages.slice(-CHAT_STATE_LIMIT).map((message, index, list) => ({
        username: '',
        message,
        at: now - (list.length - 1 - index)
      }))
    };
  }

  /** Recent chat as plain strings (legacy dispatch or native ring buffer). */
  _legacyChatHistory(limit = 30) {
    const count = clamp(Math.floor(Number(limit) || 30), 1, CHAT_BUFFER_LIMIT);
    if (!this._legacy) return [];
    try {
      const history = this._legacy.chatHistory(count);
      return Array.isArray(history) ? history.map((line) => String(line)).slice(-count) : [];
    } catch {
      return [];
    }
  }

  /**
   * Recent chat messages (oldest first). Mirrors LegacyBot.chatHistory(): returns
   * plain strings for both modes so callers have one stable shape.
   */
  chatHistory(limit = 30) {
    const count = clamp(Math.floor(Number(limit) || 30), 1, CHAT_BUFFER_LIMIT);
    if (this._mode === 'legacy') return this._legacyChatHistory(count);
    return this._chatSorted().slice(-count).map((entry) => String(entry.message ?? ''));
  }

  /**
   * Status-ping the server to auto-detect its Minecraft version.
   * Returns { version, rawVersionName, protocolVersion, latency } or null when the
   * server has status disabled / cannot be reached; the caller then lets
   * mineflayer try its own auto-detection and the existing fallbacks still apply.
   */
  async _detectServerVersion(host, port, timeoutMs) {
    const pingTimeoutMs = Math.max(1500, Math.min(5000, Number(timeoutMs) || 5000));
    const attempts = [{ options: {} }, { options: { version: '1.8.8' } }];
    let lastError = null;
    for (const attempt of attempts) {
      try {
        const response = await withTimeout(
          minecraftProtocol.ping({
            host,
            port,
            ...attempt.options,
            closeTimeout: pingTimeoutMs,
            noPongTimeout: Math.min(4000, pingTimeoutMs)
          }),
          pingTimeoutMs + 1000,
          `server status ping timed out after ${pingTimeoutMs}ms`
        );
        const rawVersionName = response?.version?.name != null ? String(response.version.name) : null;
        const protocolNumber = Number(response?.version?.protocol);
        const byName = rawVersionName ? resolveVersionEntry(rawVersionName) : null;
        const byProtocol = Number.isFinite(protocolNumber) ? resolveVersionEntry(String(protocolNumber)) : null;
        const nameMatch = rawVersionName ? /(\d+\.\d+(?:\.\d+)?)/.exec(rawVersionName) : null;
        const version = byName?.resolvedVersion ?? byProtocol?.resolvedVersion ?? (nameMatch ? nameMatch[1] : null);
        if (!version) return null;
        return {
          version,
          rawVersionName,
          protocolVersion: Number.isFinite(protocolNumber) ? protocolNumber : null,
          latency: numberOrNull(response?.latency)
        };
      } catch (error) {
        lastError = error;
      }
    }
    if (lastError) {
      this._recordWarning(`server status ping failed, falling back to mineflayer version detection: ${shortError(lastError)}`);
    }
    return null;
  }

  async _joinOnce(config, attempt) {
    const createOptions = {
      host: config.host,
      port: config.port,
      username: config.username,
      auth: config.auth,
      hideErrors: true,
      logErrors: false
    };
    if (attempt.version) createOptions.version = String(attempt.version);

    let bot;
    try {
      bot = mineflayer.createBot(createOptions);
    } catch (error) {
      throw new Error(`join failed: ${shortError(error)}${versionHint(attempt.version)}`);
    }
    this._bot = bot;
    this._connected = false;
    this._lastError = null;
    this._joinedAt = null;
    this._chat = [];
    this._sentChats = [];
    this._window = null;
    this._wirePersistentHandlers(bot);

    try {
      bot.loadPlugin(pathfinder);
    } catch (error) {
      this._clearConnection();
      try {
        bot.end();
      } catch {
        // ignore
      }
      throw new Error(`join failed: could not load mineflayer-pathfinder: ${shortError(error)}`);
    }

    try {
      await new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          clearTimeout(timer);
          bot.off('spawn', onSpawn);
          bot.off('kicked', onKicked);
          bot.off('error', onError);
          bot.off('end', onEnd);
        };
        const succeed = () => {
          if (settled) return;
          settled = true;
          cleanup();
          this._connected = true;
          this._joinedAt = Date.now();
          resolve();
        };
        const fail = (message) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(new Error(message));
        };
        const onSpawn = () => succeed();
        const onKicked = (reason) => fail(`join failed: kicked by server: ${formatReason(reason)}${versionHint(attempt.version)}`);
        const onError = (error) => {
          const message = shortError(error);
          // Non-fatal client-side parse problem (e.g. unknown block state on a
          // modded server): record it and keep waiting for spawn instead of
          // failing the join outright.
          if (NON_FATAL_CLIENT_ERROR_PATTERN.test(message)) {
            this._recordWarning(`client warning during join: ${message}`);
            return;
          }
          fail(`join failed: ${message}${versionHint(attempt.version)}`);
        };
        const onEnd = (reason) => fail(`join failed: connection ended before spawn${reason ? ` (${formatReason(reason)})` : ''}${versionHint(attempt.version)}`);
        const timer = setTimeout(
          () => fail(
            `join failed: timeout after ${config.timeoutMs}ms connecting to ${config.host}:${config.port} as '${config.username}'. ` +
            'Check the server is running and reachable; Forge servers cannot be joined by Mineflayer because of the FML handshake — use a vanilla/Fabric/Paper server. ' +
            'If the server has server-list ping disabled, pass an explicit {version} (e.g. \'1.20.1\').'
          ),
          config.timeoutMs
        );
        timer.unref?.();
        bot.once('spawn', onSpawn);
        bot.once('kicked', onKicked);
        bot.on('error', onError);
        bot.once('end', onEnd);
      });
    } catch (error) {
      this._clearConnection();
      try {
        bot.end();
      } catch {
        // ignore
      }
      throw error;
    }

    // Best effort: make sure the chunks around the spawn point are usable before
    // the first action, otherwise blockAt() can return null for a moment.
    try {
      const chunks = bot.waitForChunksToLoad?.();
      if (chunks) await withTimeout(chunks, 15000, 'chunk load timeout');
    } catch {
      // not fatal: join succeeded via spawn, actions can still work once loaded
    }

    // Configure pathfinder movements once. A test bot must be non-destructive:
    // default movements allow digging and 1x1 tower/pillar moves that place
    // scaffolding blocks (dirt/cobblestone) from the inventory, which can leave
    // the bot suffocating inside a self-placed block. Keep pathing pure walking.
    try {
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      movements.scafoldingBlocks = [];
      bot.pathfinder.setMovements(movements);
    } catch (error) {
      this._lastError = `pathfinder setup warning: ${shortError(error)}`;
    }

    const summary = this._joinSummary();
    summary.requestedVersion = attempt.version ? String(attempt.version) : 'auto';
    summary.versionSource = attempt.kind;
    summary.warnings = this._warnings.slice();
    return summary;
  }

  /** serverManager.version if the plugin's managed server module is available. */
  async _serverManagerVersion() {
    try {
      const serverModule = await import('./server.js');
      const version = serverModule?.serverManager?.status?.()?.version;
      return version ? String(version) : null;
    } catch {
      return null;
    }
  }

  _recordWarning(message) {
    const text = shortError(message);
    if (!text) return;
    this._warnings.push({ at: Date.now(), message: text });
    if (this._warnings.length > 50) this._warnings.splice(0, this._warnings.length - 50);
  }

  async leave() {
    // Legacy (1.7.x) connections are owned by the LegacyBot instance.
    if (this._mode === 'legacy') {
      const legacy = this._legacy;
      if (!legacy) return { connected: false, left: false };
      try {
        await Promise.resolve(legacy.quit());
      } catch {
        // ignore: quit() is idempotent and the socket may already be gone
      }
      this._clearConnection();
      this._lastError = null;
      return { connected: false, left: true };
    }
    const bot = this._bot;
    if (!bot) return { connected: false, left: false };
    const wasLive = this._connected;
    if (!wasLive) {
      try {
        bot.end();
      } catch {
        // ignore
      }
      this._clearConnection();
      return { connected: false, left: false };
    }
    await new Promise((resolve) => {
      let finished = false;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        try {
          bot.end();
        } catch {
          // ignore
        }
        finish();
      }, 3000);
      timer.unref?.();
      bot.once('end', finish);
      try {
        bot.quit('dsh-leave');
      } catch {
        try {
          bot.end();
        } catch {
          // ignore
        }
        finish();
      }
    });
    this._clearConnection();
    this._lastError = null;
    return { connected: false, left: true };
  }

  // -------------------------------------------------------------------- state

  state() {
    // Legacy (1.7.x) mode: LegacyBot.state() reshaped to the same field contract.
    if (this._mode === 'legacy') {
      if (!this._legacy || !this._legacy.connected) {
        const state = { connected: false, mode: 'legacy' };
        if (this._lastError) state.error = this._lastError;
        return state;
      }
      return this._legacyState();
    }
    const bot = this._bot;
    if (!bot || !this._connected || !bot.entity) {
      const state = { connected: false };
      if (this._mode) state.mode = this._mode;
      if (this._lastError) state.error = this._lastError;
      return state;
    }
    const position = bot.entity.position;
    return {
      connected: true,
      mode: this._mode ?? 'native',
      username: bot.username,
      version: this._versionOverride ?? bot.version,
      position: {
        x: round2(position.x),
        y: round2(position.y),
        z: round2(position.z),
        yaw: round2(bot.entity.yaw),
        pitch: round2(bot.entity.pitch)
      },
      health: numberOrNull(bot.health),
      food: numberOrNull(bot.food),
      saturation: numberOrNull(bot.foodSaturation),
      gameMode: bot.game?.gameMode ?? null,
      dimension: bot.game?.dimension ?? null,
      heldItem: bot.heldItem?.name ?? null,
      inventory: this._inventorySlots(),
      players: this._nearbyPlayers(),
      entities: bot.entities ? Object.keys(bot.entities).length : 0,
      chat: this._chatSorted().slice(-CHAT_STATE_LIMIT),
      ...(this._emulatedAs ? { emulatedAs: this._emulatedAs } : {}),
      ...(this._warnings.length > 0 ? { warnings: this._warnings.slice(-10) } : {})
    };
  }

  // ------------------------------------------------------------------- action

  async action(name, params = {}) {
    const actionName = String(name ?? '').trim();
    if (!actionName) throw new Error('action name is required');
    const actionParams = params && typeof params === 'object' ? params : {};
    // Legacy (1.7.x) mode: dispatch to LegacyBot; unsupported actions bubble up
    // with its readable LEGACY_ACTION_UNSUPPORTED error plus a mode hint.
    if (this._mode === 'legacy') {
      this._requireConnected(actionName);
      if (actionName === 'chat_history') {
        return { messages: this.chatHistory(actionParams.limit ?? 20) };
      }
      try {
        return await this._legacy.action(actionName, actionParams);
      } catch (error) {
        throw new Error(`${shortError(error)} (mode:'legacy')`);
      }
    }
    const handlers = {
      chat: this._actionChat,
      goto: this._actionGoto,
      look: this._actionLook,
      dig: this._actionDig,
      place: this._actionPlace,
      use_block: this._actionUseBlock,
      use_item: this._actionUseItem,
      inventory: this._actionInventory,
      equip: this._actionEquip,
      craft: this._actionCraft,
      open_container: this._actionOpenContainer,
      container_move: this._actionContainerMove,
      close_container: this._actionCloseContainer,
      attack: this._actionAttack,
      eat: this._actionEat,
      drop: this._actionDrop,
      wait: this._actionWait,
      chat_history: this._actionChatHistory
    };
    const handler = handlers[actionName];
    if (!handler) {
      throw new Error(`unknown action '${actionName}' (supported: ${Object.keys(handlers).join(', ')})`);
    }
    this._requireConnected(actionName);
    return handler.call(this, params && typeof params === 'object' ? params : {});
  }

  // ---------------------------------------------------------------- internals

  _clearConnection() {
    this._bot = null;
    this._connected = false;
    this._window = null;
    this._chat = [];
    this._sentChats = [];
    this._legacy = null;
    this._mode = null;
    this._versionOverride = null;
    this._emulatedAs = null;
  }

  _requireConnected(actionName) {
    if (this._mode === 'legacy') {
      if (this._legacy && this._legacy.connected) return;
      const suffix = this._lastError ? ` (last connection error: ${this._lastError})` : '';
      throw new Error(`bot is not connected (mode:'legacy'): call join() before action '${actionName}'${suffix}`);
    }
    if (!this._bot || !this._connected || !this._bot.entity) {
      const suffix = this._lastError ? ` (last connection error: ${this._lastError})` : '';
      throw new Error(`bot is not connected: call join() before action '${actionName}'${suffix}`);
    }
  }

  _wirePersistentHandlers(bot) {
    const isCurrent = () => this._bot === bot;
    bot.on('message', (jsonMsg, position) => {
      if (!isCurrent()) return;
      if (position === 'game_info') return; // action bar spam, not chat history
      try {
        this._recordIncomingChat(parseChatMessage(jsonMsg));
      } catch {
        // never let chat parsing take the connection down
      }
    });
    bot.on('kicked', (reason) => {
      if (!isCurrent()) return;
      this._connected = false;
      this._lastError = `kicked by server: ${formatReason(reason)}`;
    });
    bot.on('error', (error) => {
      if (!isCurrent()) return;
      const message = shortError(error);
      // Modded servers may send block states/registry data unknown to the bundled
      // minecraft-data; those client-side parse errors must not be treated as a
      // dead connection (state()/chat must keep working).
      if (NON_FATAL_CLIENT_ERROR_PATTERN.test(message)) {
        this._recordWarning(`client warning: ${message}`);
        return;
      }
      this._lastError = `connection error: ${message}`;
    });
    bot.on('end', (reason) => {
      if (!isCurrent()) return;
      this._connected = false;
      if (!this._lastError) this._lastError = `connection ended${reason ? `: ${formatReason(reason)}` : ''}`;
      this._window = null;
    });
    bot.on('windowOpen', (window) => {
      if (!isCurrent()) return;
      this._window = window;
    });
    bot.on('windowClose', () => {
      if (!isCurrent()) return;
      this._window = null;
    });
  }

  _joinSummary() {
    const bot = this._bot;
    return {
      connected: true,
      username: bot.username,
      version: bot.version,
      position: this._position(),
      health: numberOrNull(bot.health),
      food: numberOrNull(bot.food),
      dimension: bot.game?.dimension ?? null,
      gameMode: bot.game?.gameMode ?? null
    };
  }

  _position() {
    const bot = this._bot;
    if (!bot?.entity) return null;
    const position = bot.entity.position;
    return {
      x: round2(position.x),
      y: round2(position.y),
      z: round2(position.z),
      yaw: round2(bot.entity.yaw),
      pitch: round2(bot.entity.pitch)
    };
  }

  _chatSorted() {
    return this._chat.slice().sort((a, b) => a.at - b.at);
  }

  _appendChat(entry) {
    this._chat.push(entry);
    if (this._chat.length > CHAT_BUFFER_LIMIT) this._chat.splice(0, this._chat.length - CHAT_BUFFER_LIMIT);
  }

  _recordIncomingChat(entry) {
    const self = this._bot?.username;
    if (self && entry.username && entry.username === self) {
      const index = this._sentChats.findIndex(
        (sent) => sent.message === entry.message && entry.at - sent.at >= 0 && entry.at - sent.at < SENT_CHAT_DEDUPE_MS
      );
      if (index >= 0) {
        this._sentChats.splice(index, 1);
        return; // already recorded locally by the chat action
      }
    }
    this._appendChat(entry);
  }

  _inventorySlots() {
    const bot = this._bot;
    if (!bot?.inventory) return [];
    const slots = bot.inventory.slots ?? [];
    const out = [];
    for (let index = 0; index <= 44; index += 1) {
      const item = slots[index];
      if (item) out.push({ slot: index, name: item.name, count: item.count });
    }
    return out;
  }

  _inventoryItems() {
    const bot = this._bot;
    if (!bot?.inventory) return [];
    const slots = bot.inventory.slots ?? [];
    const out = [];
    for (let index = 9; index <= 44; index += 1) {
      if (slots[index]) out.push(slots[index]);
    }
    return out;
  }

  _inventorySummary() {
    const items = this._inventoryItems();
    if (items.length === 0) return 'empty';
    return items.slice(0, 8).map((item) => `${item.name} x${item.count}`).join(', ');
  }

  _nearbyPlayers() {
    const bot = this._bot;
    if (!bot?.players) return [];
    return Object.keys(bot.players)
      .filter((name) => name !== bot.username)
      .slice(0, 50);
  }

  _findInventoryItem(name) {
    const wanted = normalizeItemName(name);
    if (!wanted) return null;
    return this._inventoryItems().find((item) => item.name === wanted) ?? null;
  }

  _findItemBySlot(slot) {
    const bot = this._bot;
    const index = Math.floor(Number(slot));
    if (!Number.isFinite(index) || index < 0 || index > 44) {
      throw new Error(`invalid inventory slot '${slot}' (expected 0..44)`);
    }
    return bot.inventory.slots?.[index] ?? null;
  }

  _blockPosition(x, y, z, actionName) {
    const bot = this._bot;
    const toInt = (value) => {
      const number = Math.floor(Number(value));
      if (!Number.isFinite(number)) throw new Error(`${actionName}: x, y and z must be numbers`);
      return number;
    };
    const position = bot.entity.position.clone();
    position.set(toInt(x), toInt(y), toInt(z));
    return position;
  }

  _vec3(x, y, z) {
    const position = this._bot.entity.position.clone();
    position.set(Number(x), Number(y), Number(z));
    return position;
  }

  _windowTitle() {
    const window = this._window ?? this._bot?.currentWindow ?? null;
    if (!window) return null;
    const title = window.title;
    if (title == null) return null;
    if (typeof title === 'string') return title;
    if (typeof title === 'object' && typeof title.text === 'string') return title.text;
    try {
      if (typeof title.toString === 'function') {
        const text = title.toString();
        if (text && text !== '[object Object]') return text;
      }
    } catch {
      // ignore
    }
    return null;
  }

  async _waitFor(predicate, timeoutMs, message) {
    const deadline = Date.now() + Math.max(1, timeoutMs);
    let last;
    while (Date.now() < deadline) {
      last = predicate();
      if (last) return last;
      await sleep(75);
    }
    throw new Error(message);
  }

  _missingMaterials(recipe, crafts) {
    const bot = this._bot;
    const missing = [];
    for (const delta of recipe.delta ?? []) {
      if (!delta || typeof delta.count !== 'number' || delta.count >= 0) continue;
      const need = -delta.count * crafts;
      const have = bot.inventory.count(delta.id, delta.metadata ?? null);
      if (have < need) {
        const name = bot.registry?.items?.[delta.id]?.name ?? String(delta.id);
        missing.push(`${name} x${need} (have ${have})`);
      }
    }
    return missing;
  }

  _isFood(name) {
    const registry = this._bot?.registry ?? {};
    if (registry.foodsByName && registry.foodsByName[name]) return true;
    if (Array.isArray(registry.foods) && registry.foods.some((food) => food && food.name === name)) return true;
    return ALWAYS_EDIBLE.has(name);
  }

  // ------------------------------------------------------------------ actions

  async _actionChat({ message } = {}) {
    const bot = this._bot;
    const text = message == null ? '' : String(message);
    if (!text) throw new Error('chat action requires a non-empty { message }');
    if (text.length > 256) throw new Error(`chat message is too long (${text.length} > 256 characters)`);
    bot.chat(text);
    const at = Date.now();
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
    // Record locally immediately so a route that does not echo our own chat back
    // (or echoes it with a delay) still shows up in state().chat. Mineflayer
    // sends one chat packet per line, so record per line for echo de-duplication.
    for (const line of lines) {
      const entry = { username: bot.username || DEFAULT_USERNAME, message: line, at };
      this._appendChat(entry);
      this._sentChats.push(entry);
    }
    if (this._sentChats.length > 30) this._sentChats.splice(0, this._sentChats.length - 30);
    return { sent: true, message: text, at };
  }

  async _actionChatHistory({ limit = 20 } = {}) {
    const count = clamp(Math.floor(Number(limit) || 20), 1, CHAT_BUFFER_LIMIT);
    return { messages: this._chatSorted().slice(-count) };
  }

  async _actionWait({ ms = 0 } = {}) {
    const waited = clamp(Math.floor(Number(ms) || 0), 0, 60000);
    await sleep(waited);
    return { waited, tick: numberOrNull(this._bot.time?.age) };
  }

  async _actionLook(params = {}) {
    const bot = this._bot;
    if (params.yaw != null && params.pitch != null) {
      const yaw = Number(params.yaw);
      const pitch = Number(params.pitch);
      if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) throw new Error('look: { yaw, pitch } must be numbers');
      await bot.look(yaw, clamp(pitch, -Math.PI / 2, Math.PI / 2), true);
    } else if (params.x != null && params.y != null && params.z != null) {
      await bot.lookAt(this._vec3(params.x, params.y, params.z), true);
    } else {
      throw new Error('look requires either { x, y, z } or { yaw, pitch }');
    }
    return { yaw: round2(bot.entity.yaw), pitch: round2(bot.entity.pitch) };
  }

  async _actionGoto(params = {}) {
    const bot = this._bot;
    if (!bot.pathfinder) throw new Error('goto: mineflayer-pathfinder is not loaded on this bot');
    const timeoutMs = clamp(Math.floor(Number(params.timeoutMs) || DEFAULT_GOTO_TIMEOUT_MS), 1000, MAX_GOTO_TIMEOUT_MS);

    let goal;
    let description;
    if (params.player != null) {
      const playerName = String(params.player);
      const entity = bot.players?.[playerName]?.entity ?? null;
      if (!entity) throw new Error(`goto: player '${playerName}' is not visible to the bot`);
      const range = Math.max(1, Math.floor(Number(params.range) || 2));
      goal = new goals.GoalFollow(entity, range);
      description = `player ${playerName} (range ${range})`;
    } else if (params.x != null && params.z != null) {
      const x = Math.floor(Number(params.x));
      const z = Math.floor(Number(params.z));
      if (!Number.isFinite(x) || !Number.isFinite(z)) throw new Error('goto: x and z must be numbers');
      if (params.y != null) {
        const y = Math.floor(Number(params.y));
        if (!Number.isFinite(y)) throw new Error('goto: y must be a number');
        goal = new goals.GoalBlock(x, y, z);
        description = `${x},${y},${z}`;
      } else {
        const range = Math.max(0, Math.floor(Number(params.range) || 1));
        goal = new goals.GoalNearXZ(x, z, range);
        description = `near ${x},?,${z} (range ${range})`;
      }
    } else {
      throw new Error('goto requires { x, y, z }, { x, z } or { player }');
    }

    let arrived = false;
    let reason = null;
    try {
      await withTimeout(bot.pathfinder.goto(goal), timeoutMs, `goto timed out after ${timeoutMs}ms (goal: ${description})`);
      // mineflayer-pathfinder resolves goto() both when the goal is reached and
      // when it gives up with an empty path, so verify the goal is actually met.
      const feet = bot.entity.position.floored();
      arrived = Boolean(goal.isEnd(feet) || goal.isEnd(feet.offset(0, 1, 0)));
      if (!arrived) reason = 'pathfinder finished without reaching the goal (no path or goal unreachable)';
    } catch (error) {
      reason = shortError(error);
    }
    if (!arrived) {
      // Contract: not reaching the goal is a normal result, not throw. Stop
      // whatever the pathfinder is still doing so the bot does not wander off.
      try {
        bot.pathfinder.setGoal(null);
      } catch {
        // ignore
      }
      try {
        bot.clearControlStates();
      } catch {
        // ignore
      }
    }
    const result = { arrived, position: this._position(), goal: description, timeoutMs };
    if (!arrived && reason) result.reason = reason;
    return result;
  }

  async _actionDig(params = {}) {
    const bot = this._bot;
    const target = this._blockPosition(params.x, params.y, params.z, 'dig');
    const label = `${target.x},${target.y},${target.z}`;
    const block = bot.blockAt(target);
    if (!block) throw new Error(`dig: block at ${label} is not loaded (chunks may still be loading, or the position is outside the loaded world)`);
    if (block.name === 'air' || block.boundingBox === 'empty') {
      throw new Error(`dig: there is no block at ${label} (found ${block.name})`);
    }
    if (!bot.canDigBlock(block)) {
      const eye = bot.entity.position.offset(0, 1.62, 0);
      const distance = eye.distanceTo(block.position.offset(0.5, 0.5, 0.5));
      const why = block.diggable
        ? `block is too far (${distance.toFixed(2)} blocks, max reach ~5.1)`
        : 'block is not diggable (unbreakable or a liquid)';
      throw new Error(`dig: cannot dig ${block.name} at ${label}: ${why}`);
    }
    const blockName = block.name;
    try {
      await withTimeout(bot.dig(block, true), 30000, `dig timed out after 30000ms for ${blockName} at ${label}`);
    } catch (error) {
      throw new Error(`dig failed for ${blockName} at ${label}: ${shortError(error)}`);
    }
    return { dug: true, block: blockName, position: { x: target.x, y: target.y, z: target.z } };
  }

  async _actionPlace(params = {}) {
    const bot = this._bot;
    const target = this._blockPosition(params.x, params.y, params.z, 'place');
    const label = `${target.x},${target.y},${target.z}`;
    const existing = bot.blockAt(target);
    if (!existing) throw new Error(`place: block position ${label} is not loaded (chunks may still be loading)`);
    if (existing.name !== 'air' && existing.boundingBox !== 'empty') {
      throw new Error(`place: cannot place at ${label}: block '${existing.name}' already occupies it`);
    }

    let item;
    if (params.item != null) {
      item = this._findInventoryItem(params.item);
      if (!item) throw new Error(`place: item '${normalizeItemName(params.item)}' is not in the bot inventory (have: ${this._inventorySummary()})`);
    } else {
      item = bot.heldItem;
      if (!item) throw new Error('place: no item is held; pass { item } or equip an item first');
    }
    await bot.equip(item, 'hand');
    const itemName = item.name;

    const eye = bot.entity.position.offset(0, 1.62, 0);
    const directions = [
      [0, -1, 0], // reference below -> place on top (most common)
      [0, 1, 0], // reference above -> place underneath
      [0, 0, -1],
      [0, 0, 1],
      [-1, 0, 0],
      [1, 0, 0]
    ];
    const problems = [];
    for (const [dx, dy, dz] of directions) {
      const referencePosition = target.clone().offset(dx, dy, dz);
      const referenceBlock = bot.blockAt(referencePosition);
      if (!referenceBlock || referenceBlock.boundingBox !== 'block') continue;
      const referenceLabel = `${referencePosition.x},${referencePosition.y},${referencePosition.z}`;
      const referenceCenter = referencePosition.clone().offset(0.5, 0.5, 0.5);
      if (eye.distanceTo(referenceCenter) > 4.75) {
        problems.push(`reference block ${referenceBlock.name} at ${referenceLabel} is out of reach`);
        continue;
      }
      try {
        const faceVector = target.clone().subtract(referencePosition);
        await withTimeout(bot.placeBlock(referenceBlock, faceVector), 8000, 'placeBlock timed out after 8000ms');
        const placedBlock = await this._waitFor(
          () => {
            const block = bot.blockAt(target);
            return block && block.name !== 'air' && block.boundingBox !== 'empty' ? block : null;
          },
          2500,
          'block did not appear'
        ).catch(() => null);
        if (placedBlock) {
          return { placed: true, item: itemName, block: placedBlock.name, position: { x: target.x, y: target.y, z: target.z } };
        }
        problems.push(`no block appeared after placing against ${referenceBlock.name} at ${referenceLabel}`);
      } catch (error) {
        problems.push(`placing against ${referenceBlock.name} at ${referenceLabel} failed: ${shortError(error)}`);
      }
    }
    const detail = problems.length ? `: ${problems[problems.length - 1]}` : ': no adjacent solid block to place against';
    throw new Error(`place: could not place '${itemName}' at ${label}${detail}`);
  }

  async _actionUseBlock(params = {}) {
    const bot = this._bot;
    const target = this._blockPosition(params.x, params.y, params.z, 'use_block');
    const label = `${target.x},${target.y},${target.z}`;
    const block = bot.blockAt(target);
    if (!block) throw new Error(`use_block: block at ${label} is not loaded (chunks may still be loading)`);
    if (block.name === 'air' || block.boundingBox === 'empty') {
      throw new Error(`use_block: there is no block at ${label} (found ${block.name})`);
    }
    const face = String(params.face ?? 'up');
    try {
      await Promise.resolve(bot.activateBlock(block));
    } catch (error) {
      throw new Error(`use_block failed for ${block.name} at ${label}: ${shortError(error)}`);
    }
    await sleep(150);
    return { used: true, block: block.name, face, windowTitle: this._windowTitle() };
  }

  async _actionUseItem() {
    const bot = this._bot;
    const item = bot.heldItem?.name ?? null;
    bot.activateItem();
    await sleep(100);
    return { used: true, item };
  }

  async _actionInventory(params = {}) {
    const action = String(params.action ?? 'list');
    if (action === 'list') return { slots: this._inventorySlots() };
    if (action === 'drop') return this._actionDrop(params);
    throw new Error(`unknown inventory action '${action}' (supported: list, drop)`);
  }

  async _actionEquip(params = {}) {
    const bot = this._bot;
    let item = null;
    if (params.slot != null) {
      item = this._findItemBySlot(params.slot);
      if (!item) throw new Error(`equip: inventory slot ${params.slot} is empty`);
    } else if (params.name != null) {
      item = this._findInventoryItem(params.name);
      if (!item) throw new Error(`equip: item '${normalizeItemName(params.name)}' is not in the bot inventory (have: ${this._inventorySummary()})`);
    } else {
      throw new Error('equip requires { name } or { slot }');
    }
    await bot.equip(item, 'hand');
    return { heldItem: bot.heldItem?.name ?? null };
  }

  async _actionDrop(params = {}) {
    const bot = this._bot;
    let item = null;
    if (params.slot != null) {
      item = this._findItemBySlot(params.slot);
      if (!item) throw new Error(`drop: inventory slot ${params.slot} is empty`);
    } else if (params.name != null) {
      item = this._findInventoryItem(params.name);
      if (!item) throw new Error(`drop: item '${normalizeItemName(params.name)}' is not in the bot inventory (have: ${this._inventorySummary()})`);
    } else {
      item = bot.heldItem;
      if (!item) throw new Error('drop: no item is held; pass { name } or { slot }');
    }
    const requested = Math.max(1, Math.floor(Number(params.count) || 1));
    const count = Math.min(requested, item.count);
    await bot.toss(item.type, item.metadata ?? null, count);
    return { dropped: count, item: item.name };
  }

  async _actionCraft(params = {}) {
    const bot = this._bot;
    const itemName = normalizeItemName(params.name);
    if (!itemName) throw new Error('craft requires { name }');
    const itemEntry = bot.registry?.itemsByName?.[itemName] ?? null;
    if (!itemEntry) throw new Error(`craft: unknown item '${itemName}'`);
    let count = Math.floor(Number(params.count ?? 1));
    if (!Number.isFinite(count) || count < 1) count = 1;
    if (count > 2304) throw new Error(`craft: refusing to craft ${count} items at once (max 2304)`);

    let tableBlock = null;
    if (params.tableX != null || params.tableY != null || params.tableZ != null) {
      if (params.tableX == null || params.tableY == null || params.tableZ == null) {
        throw new Error('craft: tableX, tableY and tableZ must be provided together');
      }
      const tablePosition = this._blockPosition(params.tableX, params.tableY, params.tableZ, 'craft');
      tableBlock = bot.blockAt(tablePosition);
      if (!tableBlock) throw new Error(`craft: crafting table block at ${tablePosition.x},${tablePosition.y},${tablePosition.z} is not loaded`);
      if (!String(tableBlock.name).includes('crafting_table')) {
        throw new Error(`craft: block at ${tablePosition.x},${tablePosition.y},${tablePosition.z} is '${tableBlock.name}', not a crafting table`);
      }
    }

    let recipes = bot.recipesFor(itemEntry.id, null, count, tableBlock);
    if (recipes.length === 0) {
      const allRecipes = bot.recipesAll(itemEntry.id, null, true);
      if (allRecipes.length === 0) throw new Error(`craft: no crafting recipe for '${itemName}'`);
      if (!tableBlock && allRecipes.every((recipe) => recipe.requiresTable)) {
        throw new Error(`craft: '${itemName}' requires a crafting table; pass { tableX, tableY, tableZ }`);
      }
      const recipe = allRecipes.find((candidate) => !candidate.requiresTable) ?? allRecipes[0];
      const craftsNeeded = Math.ceil(count / Math.max(1, recipe.result.count));
      const missing = this._missingMaterials(recipe, craftsNeeded);
      if (missing.length > 0) {
        throw new Error(`craft: not enough materials to craft ${count}x ${itemName}: missing ${missing.join(', ')}`);
      }
      throw new Error(`craft: no usable recipe for '${itemName}' right now (crafting table may be required, or the inventory is full)`);
    }

    const recipe = recipes[0];
    const crafts = Math.ceil(count / Math.max(1, recipe.result.count));
    const produced = crafts * recipe.result.count;
    const before = bot.inventory.count(itemEntry.id, null);
    try {
      await withTimeout(bot.craft(recipe, crafts, tableBlock), 45000, `craft timed out after 45000ms for '${itemName}'`);
    } catch (error) {
      throw new Error(`craft failed for '${itemName}': ${shortError(error)}`);
    }
    const after = await this._waitFor(
      () => {
        const current = bot.inventory.count(itemEntry.id, null);
        return current > before ? current : null;
      },
      3000,
      `craft: expected ${produced}x ${itemName} in the inventory, but it did not appear`
    ).catch(() => bot.inventory.count(itemEntry.id, null));
    return {
      crafted: after > before,
      item: itemName,
      count: Math.max(0, after - before),
      requested: count,
      crafts,
      resultCount: recipe.result.count
    };
  }

  async _actionOpenContainer(params = {}) {
    const bot = this._bot;
    const target = this._blockPosition(params.x, params.y, params.z, 'open_container');
    const label = `${target.x},${target.y},${target.z}`;
    const block = bot.blockAt(target);
    if (!block) throw new Error(`open_container: block at ${label} is not loaded (chunks may still be loading)`);
    if (block.name === 'air' || block.boundingBox === 'empty') {
      throw new Error(`open_container: there is no block at ${label} (found ${block.name})`);
    }
    if (bot.currentWindow) {
      try {
        await Promise.resolve(bot.closeWindow(bot.currentWindow));
      } catch {
        // ignore, we are about to open a new one
      }
      this._window = null;
    }
    let window;
    try {
      window = await withTimeout(
        Promise.resolve(bot.openBlock(block)),
        10000,
        `open_container: timed out opening ${block.name} at ${label} (not a container, or out of reach)`
      );
    } catch (error) {
      throw new Error(`open_container failed for ${block.name} at ${label}: ${shortError(error)}`);
    }
    this._window = window ?? bot.currentWindow ?? null;
    const slots = [];
    const windowSlots = this._window?.slots ?? [];
    for (let index = 0; index < windowSlots.length; index += 1) {
      const item = windowSlots[index];
      if (item) slots.push({ index, name: item.name, count: item.count });
    }
    return {
      opened: true,
      windowTitle: this._windowTitle() ?? block.name,
      block: block.name,
      slots
    };
  }

  async _actionContainerMove(params = {}) {
    const bot = this._bot;
    const window = bot.currentWindow;
    if (!window) throw new Error('container_move: no container window is open; call open_container first');
    const from = Math.floor(Number(params.from));
    const to = Math.floor(Number(params.to));
    if (!Number.isFinite(from) || from < 0 || from >= window.slots.length) {
      throw new Error(`container_move: invalid source slot '${params.from}'`);
    }
    if (!Number.isFinite(to) || to < 0 || to >= window.slots.length) {
      throw new Error(`container_move: invalid destination slot '${params.to}'`);
    }
    if (from === to) throw new Error('container_move: source and destination slots are the same');
    const sourceItem = window.slots[from];
    if (!sourceItem) throw new Error(`container_move: source slot ${from} is empty`);
    const destinationItem = window.slots[to];
    if (destinationItem && destinationItem.name !== sourceItem.name) {
      throw new Error(`container_move: cannot move ${sourceItem.name} into slot ${to} which holds ${destinationItem.name}`);
    }
    const requested = Math.max(1, Math.floor(Number(params.count) || 1));
    const stackSize = Number(sourceItem.stackSize) || 64;
    const space = destinationItem ? Math.max(0, stackSize - destinationItem.count) : stackSize;
    const moveCount = Math.min(requested, sourceItem.count, space);
    if (moveCount <= 0) throw new Error(`container_move: destination slot ${to} cannot hold any more ${sourceItem.name}`);

    const beforeDestination = destinationItem ? destinationItem.count : 0;
    const beforeSource = sourceItem.count;
    const itemName = sourceItem.name;

    try {
      if (moveCount === beforeSource) {
        // Whole stack: pick it up, drop it onto the exact destination slot.
        await bot.clickWindow(from, 0, 0);
        await bot.clickWindow(to, 0, 0);
      } else {
        // Partial stack: pick up, right click (one item each) onto the destination,
        // then put the remainder back where it came from.
        await bot.clickWindow(from, 0, 0);
        for (let index = 0; index < moveCount; index += 1) await bot.clickWindow(to, 1, 0);
      }
      // Never leave items stuck on the cursor.
      let guard = 0;
      while (window.selectedItem && guard < 4) {
        await bot.clickWindow(from, 0, 0);
        guard += 1;
      }
    } catch (error) {
      throw new Error(`container_move failed: ${shortError(error)}`);
    }
    await sleep(100);
    const afterSource = window.slots[from]?.count ?? 0;
    const afterDestination = window.slots[to]?.count ?? 0;
    const moved = afterDestination - beforeDestination;
    if (moved <= 0 && afterSource >= beforeSource) {
      throw new Error(`container_move: the server did not move ${itemName} from slot ${from} to slot ${to}`);
    }
    return { moved: true, from, to, item: itemName, count: moved > 0 ? moved : Math.max(0, beforeSource - afterSource), requested };
  }

  async _actionCloseContainer() {
    const bot = this._bot;
    const window = bot.currentWindow;
    if (!window) {
      this._window = null;
      return { closed: false, message: 'no container window is open' };
    }
    const windowTitle = this._windowTitle();
    try {
      await Promise.resolve(bot.closeWindow(window));
    } catch (error) {
      throw new Error(`close_container failed: ${shortError(error)}`);
    }
    this._window = null;
    return { closed: true, windowTitle };
  }

  async _actionAttack(params = {}) {
    const bot = this._bot;
    let target = null;
    let targetName = null;
    if (params.player != null) {
      const playerName = String(params.player);
      target = bot.players?.[playerName]?.entity ?? null;
      targetName = playerName;
      if (!target) throw new Error(`attack: player '${playerName}' is not visible to the bot`);
    } else {
      target = bot.nearestEntity((entity) => {
        if (!entity || entity === bot.entity) return false;
        if (entity.type === 'player') return Boolean(entity.username);
        return LIVING_ENTITY_TYPES.has(entity.type);
      }) ?? null;
      if (target) {
        targetName = target.username ?? target.name ?? target.displayName?.toString?.() ?? target.type ?? 'unknown';
      }
    }
    if (!target) {
      return { attacked: false, target: null, message: 'no nearby living entity to attack' };
    }
    await Promise.resolve(bot.attack(target));
    await sleep(100);
    return { attacked: true, target: String(targetName ?? 'unknown') };
  }

  async _actionEat(params = {}) {
    const bot = this._bot;
    let item = null;
    if (params.item != null) {
      item = this._findInventoryItem(params.item);
      if (!item) throw new Error(`eat: item '${normalizeItemName(params.item)}' is not in the bot inventory (have: ${this._inventorySummary()})`);
    } else {
      item = this._inventoryItems().find((candidate) => this._isFood(candidate.name)) ?? null;
      if (!item) throw new Error('eat: no food found in the bot inventory');
    }
    await bot.equip(item, 'hand');
    try {
      await withTimeout(bot.consume(), 12000, 'eat timed out after 12000ms (the bot may already be full, or the item is not edible)');
    } catch (error) {
      throw new Error(`eat failed for '${item.name}': ${shortError(error)}`);
    }
    return { ate: true, item: item.name };
  }
}

function versionHint(version) {
  if (version != null && version !== '') return '';
  return ' (hint: pass an explicit { version } such as \'1.20.1\')';
}

export const botManager = new BotManager();
