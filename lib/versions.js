// Minecraft release-version registry for the test bench.
// Generated from Mojang piston-meta (release versions only; snapshots/pre/rc are ignored).
//   - `javaMajor`: javaVersion.majorVersion from the release's version JSON
//   - `packFormat`: DATA pack format (null = unknown / pre-data-pack release),
//     i.e. pack_version.data from the server jar's version.json (not the resource
//     value). Verified against real server jars for 1.14.4=4, 1.16.5=6,
//     1.18.2=9, 1.19.4=12, 1.20.x, 1.21.x, 26.3 and cross-checked with the
//     Minecraft Wiki pack format table; 1.13-1.14.4 jars predate version.json
//     (their format 4 is the initial data pack format).
// Regenerate with `node scripts/gen-versions.mjs` if a new release must be added.

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

export const isWindows = process.platform === 'win32';

export const LATEST_KNOWN_RELEASE = '26.3';
export const LATEST_RELEASE_DATE = '2026-09-15';
export const SUPPORTED_RANGE = {
  from: '1.7.10',
  to: '26.4',
  note: '26.4 尚未发布；按前瞻版本处理（Java 25，pack_format 运行时从 server jar 的 version.json 读取）',
};

/** Newest first, matching Mojang's manifest order. */
export const RELEASES = [
  { id: '26.3', javaMajor: 25, packFormat: 121 },
  { id: '26.2', javaMajor: 25, packFormat: 107 },
  { id: '26.1.2', javaMajor: 25, packFormat: 101 },
  { id: '26.1.1', javaMajor: 25, packFormat: 101 },
  { id: '26.1', javaMajor: 25, packFormat: 101 },
  { id: '1.21.11', javaMajor: 21, packFormat: 94 },
  { id: '1.21.10', javaMajor: 21, packFormat: 88 },
  { id: '1.21.9', javaMajor: 21, packFormat: 88 },
  { id: '1.21.8', javaMajor: 21, packFormat: 81 },
  { id: '1.21.7', javaMajor: 21, packFormat: 81 },
  { id: '1.21.6', javaMajor: 21, packFormat: 80 },
  { id: '1.21.5', javaMajor: 21, packFormat: 71 },
  { id: '1.21.4', javaMajor: 21, packFormat: 61 },
  { id: '1.21.3', javaMajor: 21, packFormat: 57 },
  { id: '1.21.2', javaMajor: 21, packFormat: 57 },
  { id: '1.21.1', javaMajor: 21, packFormat: 48 },
  { id: '1.21', javaMajor: 21, packFormat: 48 },
  { id: '1.20.6', javaMajor: 21, packFormat: 41 },
  { id: '1.20.5', javaMajor: 21, packFormat: 41 },
  { id: '1.20.4', javaMajor: 17, packFormat: 26 },
  { id: '1.20.3', javaMajor: 17, packFormat: 26 },
  { id: '1.20.2', javaMajor: 17, packFormat: 18 },
  { id: '1.20.1', javaMajor: 17, packFormat: 15 },
  { id: '1.20', javaMajor: 17, packFormat: 15 },
  { id: '1.19.4', javaMajor: 17, packFormat: 12 },
  { id: '1.19.3', javaMajor: 17, packFormat: 10 },
  { id: '1.19.2', javaMajor: 17, packFormat: 10 },
  { id: '1.19.1', javaMajor: 17, packFormat: 10 },
  { id: '1.19', javaMajor: 17, packFormat: 10 },
  { id: '1.18.2', javaMajor: 17, packFormat: 9 },
  { id: '1.18.1', javaMajor: 17, packFormat: 8 },
  { id: '1.18', javaMajor: 17, packFormat: 8 },
  { id: '1.17.1', javaMajor: 16, packFormat: 7 },
  { id: '1.17', javaMajor: 16, packFormat: 7 },
  { id: '1.16.5', javaMajor: 8, packFormat: 6 },
  { id: '1.16.4', javaMajor: 8, packFormat: 6 },
  { id: '1.16.3', javaMajor: 8, packFormat: 6 },
  { id: '1.16.2', javaMajor: 8, packFormat: 6 },
  { id: '1.16.1', javaMajor: 8, packFormat: 5 },
  { id: '1.16', javaMajor: 8, packFormat: 5 },
  { id: '1.15.2', javaMajor: 8, packFormat: 5 },
  { id: '1.15.1', javaMajor: 8, packFormat: 5 },
  { id: '1.15', javaMajor: 8, packFormat: 5 },
  { id: '1.14.4', javaMajor: 8, packFormat: 4 },
  { id: '1.14.3', javaMajor: 8, packFormat: 4 },
  { id: '1.14.2', javaMajor: 8, packFormat: 4 },
  { id: '1.14.1', javaMajor: 8, packFormat: 4 },
  { id: '1.14', javaMajor: 8, packFormat: 4 },
  { id: '1.13.2', javaMajor: 8, packFormat: 4 },
  { id: '1.13.1', javaMajor: 8, packFormat: 4 },
  { id: '1.13', javaMajor: 8, packFormat: 4 },
  { id: '1.12.2', javaMajor: 8, packFormat: null },
  { id: '1.12.1', javaMajor: 8, packFormat: null },
  { id: '1.12', javaMajor: 8, packFormat: null },
  { id: '1.11.2', javaMajor: 8, packFormat: null },
  { id: '1.11.1', javaMajor: 8, packFormat: null },
  { id: '1.11', javaMajor: 8, packFormat: null },
  { id: '1.10.2', javaMajor: 8, packFormat: null },
  { id: '1.10.1', javaMajor: 8, packFormat: null },
  { id: '1.10', javaMajor: 8, packFormat: null },
  { id: '1.9.4', javaMajor: 8, packFormat: null },
  { id: '1.9.3', javaMajor: 8, packFormat: null },
  { id: '1.9.2', javaMajor: 8, packFormat: null },
  { id: '1.9.1', javaMajor: 8, packFormat: null },
  { id: '1.9', javaMajor: 8, packFormat: null },
  { id: '1.8.9', javaMajor: 8, packFormat: null },
  { id: '1.8.8', javaMajor: 8, packFormat: null },
  { id: '1.8.7', javaMajor: 8, packFormat: null },
  { id: '1.8.6', javaMajor: 8, packFormat: null },
  { id: '1.8.5', javaMajor: 8, packFormat: null },
  { id: '1.8.4', javaMajor: 8, packFormat: null },
  { id: '1.8.3', javaMajor: 8, packFormat: null },
  { id: '1.8.2', javaMajor: 8, packFormat: null },
  { id: '1.8.1', javaMajor: 8, packFormat: null },
  { id: '1.8', javaMajor: 8, packFormat: null },
  { id: '1.7.10', javaMajor: 8, packFormat: null },
];

const BY_ID = new Map(RELEASES.map((release) => [release.id, release]));

export function isKnownRelease(id) {
  return BY_ID.has(String(id ?? '').trim());
}

export function getRelease(id) {
  return BY_ID.get(String(id ?? '').trim()) ?? null;
}

/** Numeric version compare (1.7.10 < 1.8 < 1.20.1 < 26.3). */
export function compareVersions(a, b) {
  const pa = String(a ?? '').split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const pb = String(b ?? '').split(/[.+-]/).map((part) => Number.parseInt(part, 10));
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i += 1) {
    const va = Number.isFinite(pa[i]) ? pa[i] : 0;
    const vb = Number.isFinite(pb[i]) ? pb[i] : 0;
    if (va !== vb) return va < vb ? -1 : 1;
  }
  return 0;
}

export function javaMajorForVersion(id) {
  const release = BY_ID.get(String(id ?? '').trim());
  if (release) return release.javaMajor;
  const text = String(id ?? '').trim();
  if (/^26\./.test(text)) return 25; // forward-compatible guess for post-26.3 releases
  return null;
}

export function requiredJavaMajor(id) {
  return javaMajorForVersion(id);
}

export function dataPackSupported(id) {
  return compareVersions(String(id ?? '').trim(), '1.13') >= 0;
}

export function packFormatForVersion(id) {
  const release = BY_ID.get(String(id ?? '').trim());
  return release ? release.packFormat : null;
}

export function listReleases({ from = '1.7.10', to = '26.4' } = {}) {
  return RELEASES
    .filter((release) => compareVersions(release.id, from) >= 0 && compareVersions(release.id, to) <= 0)
    .map((release) => release.id);
}

/** Parse common server jar file names for a Minecraft version. */
export function inferVersionFromFileName(fileName) {
  const name = String(fileName ?? '');
  const patterns = [
    /minecraft_server\.(\d+\.\d+(?:\.\d+)?)\.jar$/i,
    /server-(\d+\.\d+(?:\.\d+)?)\.jar$/i,
    /forge-(\d+\.\d+(?:\.\d+)?)-[0-9]+\.[0-9][^\\/]*\.jar$/i,
    /paper-(\d+\.\d+(?:\.\d+)?)-[^\\/]*\.jar$/i,
    /purpur-(\d+\.\d+(?:\.\d+)?)-[^\\/]*\.jar$/i,
    /spigot-(\d+\.\d+(?:\.\d+)?)\.jar$/i,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    if (match) return match[1];
  }
  return null;
}

function readTextFile(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function stripJavaHome(path) {
  return String(path ?? '').replace(/[\\/]bin[\\/]java(?:\.exe)?$/i, '');
}

function parseJavaVersion(text) {
  const value = String(text ?? '').trim();
  const legacy = /^1\.(\d+)/.exec(value);
  if (legacy) return Number.parseInt(legacy[1], 10);
  const match = /^(\d+)/.exec(value);
  return match ? Number.parseInt(match[1], 10) : null;
}

/** Scan installed JVMs from JAVA_HOME and the usual JDK install roots (cheap, no child processes). */
export function scanInstalledJavas(extraRoots = []) {
  const roots = new Set();
  if (process.env.JAVA_HOME) roots.add(stripJavaHome(process.env.JAVA_HOME));
  for (const root of [
    'D:\\Program Files\\Java',
    'C:\\Program Files\\Java',
    'C:\\Program Files\\Eclipse Adoptium',
    'C:\\Program Files\\Zulu',
    'C:\\Program Files\\BellSoft',
    'C:\\Program Files\\Microsoft',
    'C:\\Program Files\\Amazon Corretto',
    ...extraRoots,
  ]) {
    roots.add(root);
  }
  const found = [];
  for (const root of roots) {
    let entries = [];
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const home = join(root, entry.name);
      const exe = isWindows ? join(home, 'bin', 'java.exe') : join(home, 'bin', 'java');
      if (!existsSync(exe)) continue;
      let major = null;
      const releaseText = readTextFile(join(home, 'release'));
      if (releaseText) {
        const match = /JAVA_VERSION="([^"]+)"/.exec(releaseText);
        if (match) major = parseJavaVersion(match[1]);
      }
      if (major == null) {
        const match = /(?:jdk|jre|zulu|graalvm|openjdk|temurin)[-_ ]?(\d+)/i.exec(entry.name);
        if (match) {
          const raw = Number.parseInt(match[1], 10);
          major = raw === 1 ? 8 : raw;
        }
      }
      if (major == null) continue;
      found.push({ path: exe, home, major, label: entry.name, source: root });
    }
  }
  try {
    const lookup = execFileSync(isWindows ? 'where' : 'which', isWindows ? ['java'] : ['java'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    for (const line of String(lookup).split(/\r?\n/)) {
      const path = line.trim();
      if (!path) continue;
      if (found.some((entry) => entry.path.toLowerCase() === path.toLowerCase())) continue;
      const home = stripJavaHome(path);
      let major = null;
      const releaseText = readTextFile(join(home, 'release'));
      if (releaseText) {
        const match = /JAVA_VERSION="([^"]+)"/.exec(releaseText);
        if (match) major = parseJavaVersion(match[1]);
      }
      found.push({ path, home, major, label: 'PATH', source: 'PATH' });
    }
  } catch {
    // PATH lookup is optional.
  }
  return found.filter((entry) => entry.major != null).sort((a, b) => a.major - b.major);
}

/**
 * Pick a Java executable for a Minecraft release:
 * explicit path wins; otherwise exact required major, else the smallest installed major >= required,
 * else the newest installed major.
 */
export function pickJavaForVersion(version, { explicitPath, extraRoots = [] } = {}) {
  const required = requiredJavaMajor(version);
  if (explicitPath) return { path: explicitPath, major: null, required, reason: 'explicit javaPath' };
  const javas = scanInstalledJavas(extraRoots);
  if (javas.length === 0) {
    return { path: 'java', major: null, required, reason: 'no installed JDK detected; using PATH java' };
  }
  const exact = javas.find((entry) => entry.major === required);
  if (exact) return { path: exact.path, major: exact.major, required, reason: 'exact Java major match' };
  const capable = required == null ? [] : javas.filter((entry) => entry.major >= required);
  if (capable.length > 0) {
    return { path: capable[0].path, major: capable[0].major, required, reason: 'smallest installed Java >= required' };
  }
  const fallback = javas[javas.length - 1];
  return {
    path: fallback.path,
    major: fallback.major,
    required,
    reason: required == null ? 'unknown version; newest installed Java' : 'no installed Java meets requirement; newest installed Java',
  };
}

/** Human-readable support matrix row for a version. */
export function versionSupportSummary(id) {
  const release = getRelease(id);
  const text = String(id ?? '').trim();
  const known = !!release || /^26\./.test(text);
  return {
    version: text,
    knownRelease: !!release,
    future: !release && /^26\./.test(text),
    javaMajor: release ? release.javaMajor : /^26\./.test(text) ? 25 : null,
    packFormat: release ? release.packFormat : null,
    dataPack: dataPackSupported(text),
  };
}
