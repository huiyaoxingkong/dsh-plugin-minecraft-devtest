import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RELEASES, packFormatForVersion } from './versions.js';

export function nowIso() {
  return new Date().toISOString();
}

export function sleep(ms) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, Number(ms) || 0)));
}

export function ensureDir(dir) {
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function readTextFile(path) {
  return readFileSync(path, 'utf8');
}

export function writeTextFile(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, 'utf8');
  return path;
}

export function readJsonFile(path) {
  let text;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    throw new Error(`cannot read ${path}: ${shortError(error)}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`invalid JSON in ${path}: ${shortError(error)}`);
  }
}

export function listFilesRecursive(dir, { filter } = {}) {
  const out = [];
  const root = resolve(dir);
  if (!existsSync(root)) return out;
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else if (entry.isFile()) {
        if (!filter || filter(full)) out.push(full);
      }
    }
  };
  walk(root);
  return out;
}

export function tailLines(text, n) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const count = Math.max(0, Number(n) || 0);
  return count === 0 ? [] : lines.slice(-count);
}

export function tailFileLines(path, n) {
  try {
    return tailLines(readFileSync(path, 'utf8'), n);
  } catch {
    return [];
  }
}

export function normalizeCmd(cmd) {
  return String(cmd ?? '').trim().replace(/^\//, '');
}

export function shortError(error) {
  const text = String(error?.message ?? error ?? 'unknown error');
  return text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

export const isWindows = process.platform === 'win32';

export function findJava() {
  const home = process.env.JAVA_HOME;
  if (home) {
    const candidates = isWindows ? [join(home, 'bin', 'java.exe'), join(home, 'bin', 'java')] : [join(home, 'bin', 'java')];
    for (const candidate of candidates) if (existsSync(candidate)) return candidate;
  }
  return 'java';
}

export function killProcessTree(pid) {
  const value = Number(pid);
  if (!Number.isFinite(value) || value <= 0) return { killed: false };
  try {
    if (isWindows) {
      execFileSync('taskkill', ['/PID', String(value), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 15000 });
    } else {
      process.kill(-value, 'SIGTERM');
    }
    return { killed: true };
  } catch (error) {
    try {
      process.kill(value, 'SIGKILL');
      return { killed: true };
    } catch {
      return { killed: false, error: shortError(error) };
    }
  }
}

export function spawnCollect(cmd, args, { cwd, timeoutMs = 900000, env, shell = false } = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd, args, {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      windowsHide: true,
      shell,
    });
    let output = '';
    let settled = false;
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child.pid);
    }, Math.max(1000, Number(timeoutMs) || 900000));
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveRun({ code: typeof code === 'number' ? code : null, output, timedOut });
    };
    child.stdout?.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_500_000);
    });
    child.stderr?.on('data', (chunk) => {
      output += chunk.toString('utf8');
      if (output.length > 2_000_000) output = output.slice(-1_500_000);
    });
    child.on('error', (error) => {
      output += `\n[spawn error] ${shortError(error)}`;
      finish(-1);
    });
    child.on('close', (code) => finish(code));
  });
}

export function parseMinecraftLog(text) {
  const source = String(text ?? '');
  // Vanilla/Paper/Purpur/Forge/NeoForge print the vanilla start line; Fabric and
  // Quilt print "Loading Minecraft <version> with <Loader> Loader".
  const version =
    /Starting minecraft server version\s+([0-9][^\s)]*)/i.exec(source)?.[1] ??
    /Loading Minecraft\s+([0-9][^\s]*)\s+with\s+Fabric\s+Loader/i.exec(source)?.[1] ??
    /Loading Minecraft\s+([0-9][^\s]*)/i.exec(source)?.[1] ??
    null;
  let loader = null;
  // Loader banners (not arbitrary text) so player chat mentioning a loader name
  // cannot change the detected loader. NeoForge is checked before Forge (it is a
  // Forge fork and its logs still mention Forge classes), Purpur before Paper and
  // Quilt before Fabric for the same fork/compatibility reasons.
  if (/neoforge/i.test(source)) loader = 'neoforge';
  else if (/MinecraftForge|Forge Mod Loader|forgeVersion|\bForge version\b/i.test(source)) loader = 'forge';
  else if (/This server is running Purpur|Purpur version/i.test(source)) loader = 'purpur';
  else if (/This server is running Paper|Paper version/i.test(source)) loader = 'paper';
  else if (/Quilt Loader|QuiltMC/i.test(source)) loader = 'quilt';
  else if (/Fabric Loader/i.test(source)) loader = 'fabric';
  else if (version) loader = 'vanilla';
  const lines = source.split(/\r?\n/);
  const errors = lines
    .filter((line) => /\b(ERROR|FATAL)\b|Exception|Caused by:/i.test(line))
    .filter((line) => !/Ignoring advancement|Caught exception in .* thread|WARN/i.test(line))
    .slice(-40);
  const warnings = lines.filter((line) => /\bWARN\b/i.test(line)).slice(-20);
  return { version, loader, errors, warnings };
}

// Data pack formats are owned by lib/versions.js (single source of truth, 76
// releases 1.7.10-26.3, verified against real server jars where available).
// This module only keeps the historical helper names/signatures stable.

/** Version -> data pack format map (releases with data pack support only). */
export function parsePackFormatMap() {
  const map = {};
  for (const release of RELEASES) {
    if (release.packFormat !== null && release.packFormat !== undefined) map[release.id] = release.packFormat;
  }
  return map;
}

/**
 * Data pack format for a Minecraft version id (e.g. "1.20.1" -> 15).
 * Returns null for pre-data-pack releases (< 1.13), snapshots/pre-releases and
 * unknown versions. Build metadata suffixes are tolerated ("1.20.1+build.1").
 */
export function dataPackFormatForVersion(version) {
  if (version === undefined || version === null || version === '') return null;
  const key = String(version).trim().toLowerCase();
  if (!key) return null;
  const direct = packFormatForVersion(key);
  if (direct !== null) return direct;
  // Only build metadata is tolerated. Snapshots and pre-releases may use a
  // different format, so they intentionally stay unmapped instead of reporting a
  // possibly wrong number.
  const base = /^(\d+\.\d+(?:\.\d+)?)\+[0-9a-z.-]+$/.exec(key)?.[1];
  if (base !== undefined) {
    const viaBase = packFormatForVersion(base);
    if (viaBase !== null) return viaBase;
  }
  return null;
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

export function statSafe(path) {
  try {
    return statSync(path);
  } catch {
    return null;
  }
}

export function summarizeTail(text, maxChars = 12000) {
  const value = String(text ?? '');
  if (value.length <= maxChars) return value;
  return `…[trimmed ${value.length - maxChars} chars]…\n${value.slice(-maxChars)}`;
}
