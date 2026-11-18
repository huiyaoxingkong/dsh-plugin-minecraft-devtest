import { execFileSync, spawn } from 'node:child_process';
import { copyFileSync, createWriteStream, existsSync, readdirSync } from 'node:fs';
import { connect } from 'node:net';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

import { RconClient } from './rcon.js';
import {
  compareVersions,
  inferVersionFromFileName,
  pickJavaForVersion,
  requiredJavaMajor,
  scanInstalledJavas,
} from './versions.js';
import {
  ensureDir,
  findJava,
  isWindows,
  killProcessTree,
  normalizeCmd,
  nowIso,
  parseMinecraftLog,
  readTextFile,
  shortError,
  sleep,
  writeTextFile,
} from './util.js';

const MAX_LOG_LINES = 5000;
const RCON_RETRY_MS = 20000;
const STOP_WAIT_MS = 15000;
const KILL_WAIT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 180000;

const SUPPORTED_MODES = ['auto', 'jar', 'fabric', 'script', 'gradle'];
const VERSION_PATTERN = /(\d+\.\d+(?:\.\d+)?)/;

/** True when the string is a plain Minecraft release version (e.g. "1.7.10", "26.3"). */
function isValidMcVersion(value) {
  return /^\d+\.\d+(?:\.\d+)?$/.test(String(value ?? '').trim());
}

/** server.properties keys managed by dsh mode, in the order we append them. */
const MANAGED_PROPERTY_ORDER = [
  'online-mode',
  'white-list',
  'enforce-whitelist',
  'enable-rcon',
  'rcon.port',
  'rcon.password',
  'server-port',
  'level-name',
];

// Jars that are launchers/installers, never the executable server jar.
const JAR_EXCLUDE_PATTERN = /(?:installer|fabric-server-launch|quilt-server-launch)/i;

/** Fabric-family launchers (Fabric / Quilt): both run as `java -jar <launcher> nogui`. */
function detectLauncherJar(serverDir) {
  const fabric = join(serverDir, 'fabric-server-launch.jar');
  if (existsSync(fabric)) return { path: fabric, loader: 'fabric' };
  const quilt = join(serverDir, 'quilt-server-launch.jar');
  if (existsSync(quilt)) return { path: quilt, loader: 'quilt' };
  return null;
}

function pad2(value) {
  return String(value).padStart(2, '0');
}

function formatLogTimestamp(date = new Date()) {
  return `${date.getFullYear()}${pad2(date.getMonth() + 1)}${pad2(date.getDate())}-${pad2(date.getHours())}${pad2(date.getMinutes())}${pad2(date.getSeconds())}`;
}

function stripAnsi(text) {
  return String(text ?? '').replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '');
}

function isReadyLine(line) {
  return /\bDone\s*\(/i.test(line) || /\bDone in\b/i.test(line);
}

/** Best-effort quoting for extra program arguments passed through cmd.exe. */
function quoteCmdArgument(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function createDeferred() {
  let resolveDeferred;
  let rejectDeferred;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolveDeferred = resolvePromise;
    rejectDeferred = rejectPromise;
  });
  const handle = {
    promise,
    settled: false,
    resolve(value) {
      if (handle.settled) return;
      handle.settled = true;
      resolveDeferred(value);
    },
    reject(error) {
      if (handle.settled) return;
      handle.settled = true;
      rejectDeferred(error);
    },
  };
  return handle;
}

function waitForExit(run, timeoutMs) {
  if (run.exited) return Promise.resolve(true);
  if (!run.exitPromise) return Promise.resolve(false);
  return new Promise((resolveWait) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveWait(value);
    };
    const timer = setTimeout(() => finish(false), Math.max(100, Number(timeoutMs) || KILL_WAIT_MS));
    run.exitPromise.then(() => finish(true));
  });
}

// ---------------------------------------------------------------------------
// Version inference
// ---------------------------------------------------------------------------

const jarVersionCache = new Map();

/** Read version.json out of a server jar (bundled 1.14+ releases). Returns {version, packFormat} or null. */
function readJarVersionInfo(jarPath) {
  if (!jarPath || !existsSync(jarPath)) return null;
  const cacheKey = String(jarPath).toLowerCase();
  if (jarVersionCache.has(cacheKey)) return jarVersionCache.get(cacheKey);
  let info = null;
  try {
    // bsdtar (shipped with Windows 10+) can extract a single member from a zip/jar.
    const json = execFileSync('tar', ['-xOf', jarPath, 'version.json'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 8000,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    const parsed = JSON.parse(json);
    const rawId = typeof parsed?.id === 'string' ? parsed.id : null;
    let version = null;
    if (rawId && isValidMcVersion(rawId)) {
      version = rawId;
    } else if (typeof parsed?.inheritsFrom === 'string' && isValidMcVersion(parsed.inheritsFrom)) {
      // Forge 1.7.10-1.12.2 jars ship a launcher-profile version.json whose id is
      // e.g. "1.7.10-Forge10.13.4.1614-1.7.10" but inheritsFrom holds the MC version.
      version = parsed.inheritsFrom;
    } else if (typeof parsed?.assets === 'string' && isValidMcVersion(parsed.assets)) {
      version = parsed.assets;
    } else if (rawId) {
      const token = VERSION_PATTERN.exec(rawId);
      if (token && isValidMcVersion(token[1])) version = token[1];
    }
    const packVersion = parsed?.pack_version;
    const packFormat =
      typeof packVersion === 'number'
        ? packVersion
        : packVersion && typeof packVersion === 'object'
          ? (packVersion.data ?? packVersion.resource ?? null)
          : null;
    if (version) info = { version, packFormat };
  } catch {
    info = null;
  }
  jarVersionCache.set(cacheKey, info);
  return info;
}

/** Infer MC version from the newest log line in <runDir>/logs/latest.log. */
function inferVersionFromLatestLog(runDir) {
  let text = null;
  for (const candidate of [join(runDir, 'logs', 'latest.log'), join(runDir, 'logs', 'debug.log')]) {
    try {
      text = readTextFile(candidate);
    } catch {
      text = null;
    }
    if (!text) continue;
    const match = /Starting minecraft server version\s+([0-9][^\s)]*)/i.exec(text);
    if (match) return { version: match[1], source: 'logs' };
    const fabric = /Loading Minecraft\s+([0-9][^\s]*)\s+with\s+Fabric Loader/i.exec(text);
    if (fabric) return { version: fabric[1], source: 'logs' };
    if (text.length > 0) break; // newest existing log wins even without a match
  }
  return null;
}

/** Forge / NeoForge keep the MC version in their library directory name. */
function inferVersionFromForgeLibraries(serverDir) {
  const libraryRoots = [
    ['net', 'minecraftforge', 'forge'],
    ['net', 'neoforged', 'forge'],
    ['net', 'neoforged', 'neoforge'],
    ['net', 'neoforged', 'neoforge-loader'],
  ];
  for (const parts of libraryRoots) {
    const dir = join(serverDir, 'libraries', ...parts);
    if (!existsSync(dir)) continue;
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
    } catch {
      continue;
    }
    for (const name of entries) {
      // NeoForge 1.21+ versions itself as <mc-minor>.<mc-patch>.<build>:
      // 21.1.266 -> MC 1.21.1, 20.4.237 -> MC 1.20.4. Map it back to the MC version.
      if (parts[1] === 'neoforged' && parts[2] === 'neoforge') {
        const neoforge = /^(\d+)\.(\d+)\.\d+/.exec(name);
        if (neoforge) return { version: `1.${neoforge[1]}.${neoforge[2]}`, source: 'forge-library' };
      }
      const match = VERSION_PATTERN.exec(name);
      if (match) return { version: match[1], source: 'forge-library' };
    }
  }
  return null;
}

/** Fabric/Quilt keep a remapped MC jar name like minecraft-1.20.1-0.19.5 in <loaderDir>/remappedJars. */
function inferVersionFromFabricCache(serverDir) {
  for (const [cacheDir, source] of [
    ['.fabric', 'fabric-cache'],
    ['.quilt', 'quilt-cache'],
  ]) {
    const remapped = join(serverDir, cacheDir, 'remappedJars');
    if (!existsSync(remapped)) continue;
    try {
      const names = readdirSync(remapped, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .reverse();
      for (const name of names) {
        const match = /^minecraft-(\d+\.\d+(?:\.\d+)?)-/i.exec(name);
        if (match) return { version: match[1], source };
      }
    } catch {
      // ignore
    }
  }
  return null;
}

/**
 * Infer the Minecraft version for a server directory, in decreasing confidence:
 * explicit option > jar version.json > forge-library dir > jar file name >
 * fabric cache > existing logs > directory name.
 */
function inferMcVersion({ explicitVersion = null, serverDir = null, runDir = null, jarPath = null } = {}) {
  const accept = (version, source, extra = {}) => (isValidMcVersion(version) ? { version, source, ...extra } : null);

  if (explicitVersion) {
    const hit = accept(String(explicitVersion).trim(), 'option');
    if (hit) return hit;
  }

  const jarCandidates = [];
  if (jarPath) jarCandidates.push(jarPath);
  if (serverDir) {
    const serverJar = join(serverDir, 'server.jar');
    if (existsSync(serverJar)) jarCandidates.push(serverJar);
    // multi-version layout: sibling server-<version>.jar
    if (jarCandidates.length === 0) {
      const sibling = detectParentServerJar(serverDir);
      if (sibling) jarCandidates.push(sibling);
    }
  }
  for (const candidate of jarCandidates) {
    const info = readJarVersionInfo(candidate);
    if (info?.version) {
      const hit = accept(info.version, 'version.json', { packFormat: info.packFormat });
      if (hit) return hit;
    }
  }

  if (serverDir) {
    const forge = inferVersionFromForgeLibraries(serverDir);
    const hit = forge ? accept(forge.version, forge.source) : null;
    if (hit) return hit;
  }

  for (const candidate of jarCandidates) {
    const fromName = inferVersionFromFileName(basename(candidate));
    const hit = fromName ? accept(fromName, 'filename') : null;
    if (hit) return hit;
  }
  if (jarPath) {
    const fromName = inferVersionFromFileName(basename(jarPath));
    const hit = fromName ? accept(fromName, 'filename') : null;
    if (hit) return hit;
  }

  if (serverDir) {
    const fabric = inferVersionFromFabricCache(serverDir);
    const hit = fabric ? accept(fabric.version, fabric.source) : null;
    if (hit) return hit;
  }

  if (runDir) {
    const fromLogs = inferVersionFromLatestLog(runDir);
    const hit = fromLogs ? accept(fromLogs.version, fromLogs.source) : null;
    if (hit) return hit;
  }

  if (serverDir) {
    const match = VERSION_PATTERN.exec(basename(serverDir));
    const hit = match ? accept(match[1], 'dirname') : null;
    if (hit) return hit;
  }
  return { version: null, source: null };
}

// ---------------------------------------------------------------------------
// Jar discovery
// ---------------------------------------------------------------------------

function listJarFiles(serverDir) {
  try {
    return readdirSync(serverDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.jar'))
      .map((entry) => join(serverDir, entry.name));
  } catch {
    return [];
  }
}

/**
 * Older Forge installs ship `minecraft_server.1.7.10.jar` next to
 * `forge-1.7.10-...-universal.jar`; the Forge jar is the executable one.
 * Paper/Purpur shards beat plain vanilla jars as well.
 */
function rankJarBasename(name) {
  const lower = String(name).toLowerCase();
  if (JAR_EXCLUDE_PATTERN.test(lower)) return 0;
  if (/^(paper|purpur|spigot)(?:-|\.)/.test(lower)) return 90;
  if (/^(?:neoforge|forge)-.*(?:server|universal)\.jar$/.test(lower)) return 80;
  if (/^(?:neoforge|forge)-.*\.jar$/.test(lower)) return 75;
  if (/^minecraft_server\..*\.jar$/.test(lower)) return 60;
  if (lower === 'server.jar') return 55;
  if (/(?:^|[-_.])server(?:[-_.]|$)/.test(lower)) return 30;
  return 10;
}

/** Pick a server jar inside a directory without throwing (used by inference). */
function detectJarInDir(serverDir) {
  const jars = listJarFiles(serverDir);
  if (jars.length === 0) return null;
  const ranked = jars
    .map((path) => ({ path, rank: rankJarBasename(basename(path)) }))
    .filter((entry) => entry.rank > 0)
    .sort((a, b) => b.rank - a.rank || b.path.localeCompare(a.path));
  if (ranked.length === 0) return null;
  if (ranked.length === 1) return ranked[0].path;
  if (ranked[0].rank > 10) return ranked[0].path;
  return null; // no meaningful signal -> caller reports ambiguity
}

/**
 * Multi-version layouts keep the jars next to the run dir, e.g.
 * `_mw_server\1.20.6` + `_mw_server\server-1.20.6.jar`. Prefer a sibling whose
 * jar version matches the directory name; otherwise only accept a single
 * unambiguous server jar.
 */
function detectParentServerJar(serverDir) {
  const parent = dirname(serverDir);
  const dirName = basename(serverDir);
  let siblings = [];
  try {
    siblings = readdirSync(parent, { withFileTypes: true })
      .filter(
        (entry) => entry.isFile() && /^(?:server[-_.]|minecraft_server\.).*\.jar$/i.test(entry.name),
      )
      .map((entry) => join(parent, entry.name));
  } catch {
    return null;
  }
  if (siblings.length === 0) return null;
  const dirVersion = VERSION_PATTERN.exec(dirName)?.[1] ?? null;
  if (dirVersion) {
    const matches = siblings.filter((jar) => inferVersionFromFileName(basename(jar)) === dirVersion);
    return matches.length === 1 ? matches[0] : null;
  }
  return siblings.length === 1 ? siblings[0] : null;
}

function resolveJarCandidate(serverDir, jarOption) {
  const candidate = isAbsolute(String(jarOption)) ? resolve(String(jarOption)) : resolve(serverDir, String(jarOption));
  if (!existsSync(candidate)) throw new Error(`server jar not found: ${candidate}`);
  return candidate;
}

/** Strict jar resolution for start(): explicit path, ranked jar inside, or sibling version jar. */
function findServerJar(serverDir, jarOption) {
  if (jarOption !== undefined && jarOption !== null && jarOption !== '') {
    return resolveJarCandidate(serverDir, jarOption);
  }
  const detected = detectJarInDir(serverDir);
  if (detected) return detected;
  const sibling = detectParentServerJar(serverDir);
  if (sibling) return sibling;
  const jars = listJarFiles(serverDir);
  if (jars.length > 1) {
    throw new Error(
      `multiple jars found in ${serverDir}: ${jars.map((jar) => basename(jar)).join(', ')}; pass options.jar to choose one`,
    );
  }
  throw new Error(
    `no server jar found in ${serverDir} (expected server.jar, a sibling server-<version>.jar, or pass options.jar)`,
  );
}

// ---------------------------------------------------------------------------
// Java selection
// ---------------------------------------------------------------------------

function inferJavaMajorFromPath(javaPath) {
  const text = String(javaPath ?? '');
  if (!text) return null;
  try {
    const installed = scanInstalledJavas();
    const lower = text.toLowerCase();
    const byPath = installed.find((entry) => entry.path.toLowerCase() === lower);
    if (byPath) return byPath.major;
    const home = dirname(dirname(text)).toLowerCase();
    const byHome = installed.find((entry) => entry.home.toLowerCase() === home);
    if (byHome) return byHome.major;
  } catch {
    // ignore scan problems
  }
  const releaseText = (() => {
    try {
      return readTextFile(join(dirname(dirname(text)), 'release'));
    } catch {
      return null;
    }
  })();
  if (releaseText) {
    const match = /JAVA_VERSION="(?:1\.)?(\d+)/.exec(releaseText);
    if (match) return Number.parseInt(match[1], 10);
  }
  const match = /(?:jdk|jre|zulu|graalvm|temurin|openjdk)[-_. ]?(\d+)/i.exec(text);
  if (match) {
    const value = Number.parseInt(match[1], 10);
    return value === 1 ? 8 : value;
  }
  return null;
}

/**
 * Pick the Java executable for a server:
 * - explicit options.javaPath wins (major detected for status),
 * - known MC version uses versions.pickJavaForVersion (exact / smallest >= required),
 * - unknown version falls back to JAVA_HOME / PATH java.
 */
function selectJava({ explicitPath = null, version = null } = {}) {
  const required = version ? requiredJavaMajor(version) : null;
  if (explicitPath) {
    const path = String(explicitPath);
    return { path, major: inferJavaMajorFromPath(path), required, reason: 'explicit javaPath' };
  }
  if (version && required != null) {
    const picked = pickJavaForVersion(version);
    const major = picked.major != null ? picked.major : inferJavaMajorFromPath(picked.path);
    return { path: picked.path, major, required: picked.required ?? required, reason: picked.reason };
  }
  // Unknown / unsupported version string: do not jump to the newest JDK (legacy
  // Forge breaks on Java 9+); prefer JAVA_HOME / PATH like the pre-version-matrix behavior.
  const path = findJava();
  return { path, major: inferJavaMajorFromPath(path), required, reason: 'unknown MC version; JAVA_HOME/PATH java' };
}

function describeJavaFailure(version, selection) {
  let installed = [];
  try {
    installed = scanInstalledJavas().map((entry) => entry.major);
  } catch {
    installed = [];
  }
  const required = requiredJavaMajor(version);
  return [
    '[hint] Java version mismatch detected',
    `MC version: ${version ?? 'unknown'}`,
    `required Java major: ${required ?? 'unknown'}`,
    `selected java: ${selection?.path ?? 'unknown'}${selection?.major != null ? ` (major ${selection.major})` : ''}`,
    `installed Java majors: ${installed.length ? installed.join(', ') : 'none detected'}`,
  ].join('\n');
}

/** Is this failure caused by running on the wrong Java major? */
function isJavaVersionFailure(text) {
  const value = String(text ?? '');
  return (
    /UnsupportedClassVersionError/i.test(value) ||
    /has been compiled by a more recent version of the Java Runtime/i.test(value) ||
    /class file version \d+/i.test(value) ||
    /requires Java(?:SE)?\s*(?:version\s*)?\d+/i.test(value) ||
    /Java\s+\d+(?:\.\d+)?\s+or\s+(?:later|newer|higher)/i.test(value) ||
    /Unsupported class file major version/i.test(value)
  );
}

// ---------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------

function findGradleWrapper(projectDir) {
  const candidates = isWindows
    ? [join(projectDir, 'gradlew.bat'), join(projectDir, 'gradlew')]
    : [join(projectDir, 'gradlew')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Find the installer-generated launch script (Forge/NeoForge run.bat / run.sh). */
function findRunScript(serverDir) {
  const names = isWindows ? ['run.bat', 'run.cmd'] : ['run.sh', 'run'];
  for (const name of names) {
    const candidate = join(serverDir, name);
    if (!existsSync(candidate)) continue;
    return { path: candidate, kind: name.endsWith('.bat') || name.endsWith('.cmd') ? 'bat' : 'sh' };
  }
  return null;
}

/**
 * Resolve where the Gradle runServer process will keep its working data.
 * Prefers an existing run dir / server.properties, else `projectDir/run`
 * (the ForgeGradle default). Does not create directories.
 */
function resolveRunDir(projectDir, runDirOption) {
  if (runDirOption) {
    return isAbsolute(String(runDirOption)) ? resolve(String(runDirOption)) : resolve(projectDir, String(runDirOption));
  }
  const candidates = ['run', join('runs', 'server'), join('run', 'server'), '.'].map((rel) => resolve(projectDir, rel));
  for (const candidate of candidates) {
    if (existsSync(join(candidate, 'server.properties'))) return candidate;
    if (existsSync(join(candidate, 'eula.txt'))) return candidate;
  }
  return resolve(projectDir, 'run');
}

/** Infer the mod loader from directory features (before the server has been started). */
function inferLoaderFromDir(serverDir, { jarPath = null } = {}) {
  if (existsSync(join(serverDir, 'quilt-server-launch.jar'))) return 'quilt';
  if (existsSync(join(serverDir, 'fabric-server-launch.jar'))) return 'fabric';
  if (existsSync(join(serverDir, 'libraries', 'net', 'neoforged'))) return 'neoforge';
  if (existsSync(join(serverDir, 'libraries', 'net', 'minecraftforge'))) return 'forge';
  if (existsSync(join(serverDir, 'libraries', 'io', 'papermc'))) return 'paper';
  const jarName = jarPath ? basename(jarPath).toLowerCase() : '';
  if (jarName) {
    if (/quilt/.test(jarName)) return 'quilt';
    if (/neoforge/.test(jarName)) return 'neoforge';
    if (/forge/.test(jarName)) return 'forge';
    if (/fabric/.test(jarName)) return 'fabric';
    if (/purpur/.test(jarName)) return 'purpur';
    if (/paper/.test(jarName)) return 'paper';
  }
  if (existsSync(join(serverDir, 'libraries', 'com', 'mojang'))) return 'vanilla';
  return null;
}

/**
 * Infer start mode, loader and version purely from directory layout.
 *
 * Priority inside serverDir: explicit jar > fabric-server-launch.jar >
 * run.bat/run.sh > executable server jar (Forge universal > paper > vanilla).
 * Falls back to a Gradle project when no server directory features match.
 *
 * Exported so tools can inspect a directory before starting anything.
 */
export function inferServerProfile(options = {}) {
  const serverDir = options.serverDir ? resolve(String(options.serverDir)) : null;
  const projectDir = options.projectDir ? resolve(String(options.projectDir)) : null;
  const profile = {
    mode: null,
    loader: null,
    version: null,
    versionSource: null,
    packFormat: null,
    jarPath: null,
    scriptPath: null,
    scriptKind: null,
    wrapperPath: null,
    runDir: null,
    serverDir,
    projectDir,
  };

  if (serverDir && existsSync(serverDir)) {
    let jarPath = null;
    if (options.jar !== undefined && options.jar !== null && options.jar !== '') {
      try {
        jarPath = resolveJarCandidate(serverDir, options.jar);
      } catch {
        jarPath = null;
      }
    }
    const launcher = detectLauncherJar(serverDir);
    const script = findRunScript(serverDir);
    if (jarPath) {
      profile.mode = 'jar';
    } else if (launcher) {
      profile.mode = 'fabric';
      jarPath = launcher.path;
    } else if (script) {
      profile.mode = 'script';
    } else {
      const detected = detectJarInDir(serverDir) ?? detectParentServerJar(serverDir);
      if (detected) {
        profile.mode = 'jar';
        jarPath = detected;
      }
    }
    if (profile.mode) {
      profile.jarPath = jarPath;
      profile.runDir = serverDir;
      if (script) {
        profile.scriptPath = script.path;
        profile.scriptKind = script.kind;
      }
      profile.loader = inferLoaderFromDir(serverDir, { jarPath });
      const versionInfo = inferMcVersion({
        explicitVersion: options.version ?? null,
        serverDir,
        runDir: serverDir,
        jarPath,
      });
      profile.version = versionInfo.version;
      profile.versionSource = versionInfo.source;
      profile.packFormat = versionInfo.packFormat ?? null;
    }
  }

  if (!profile.mode && projectDir && existsSync(projectDir)) {
    const wrapperPath = findGradleWrapper(projectDir);
    if (wrapperPath) {
      profile.mode = 'gradle';
      profile.wrapperPath = wrapperPath;
      profile.runDir = resolveRunDir(projectDir, options.runDir);
      const versionInfo = inferMcVersion({
        explicitVersion: options.version ?? null,
        serverDir: null,
        runDir: profile.runDir,
        jarPath: null,
      });
      profile.version = versionInfo.version;
      profile.versionSource = versionInfo.source;
    }
  }

  return profile;
}

function writeEulaFile(dir) {
  return writeTextFile(join(dir, 'eula.txt'), 'eula=true\n');
}

/** Read server.properties into a Map without touching the file. */
function readServerProperties(file) {
  if (!existsSync(file)) return { path: file, exists: false, values: new Map() };
  const text = readTextFile(file);
  const values = new Map();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith('!')) continue;
    const separator = line.indexOf('=');
    if (separator < 0) continue;
    const key = line.slice(0, separator).trim();
    if (!key) continue;
    values.set(key, line.slice(separator + 1).trim());
  }
  return { path: file, exists: true, values };
}

function textProperty(properties, key, fallback) {
  const raw = properties.values.get(key);
  const value = raw === undefined ? '' : String(raw).trim();
  return value === '' ? fallback : value;
}

function portProperty(properties, key, fallback) {
  const raw = properties.values.get(key);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`invalid ${key} in ${properties.path}: "${raw}" (expected an integer port 1-65535)`);
  }
  return value;
}

/** The address the server should bind to, used for port preflight and RCON. */
function resolveBindHost(properties) {
  const serverIp = textProperty(properties, 'server-ip', '');
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(serverIp) && serverIp !== '0.0.0.0') return serverIp;
  return '127.0.0.1';
}

/**
 * Merge dsh keys into server.properties, keeping all other lines/order/keys.
 * The first time we touch an existing file we keep a `.dsh-backup` copy.
 */
function patchPropertiesFile(file, values) {
  const hadOriginal = existsSync(file);
  const original = hadOriginal ? readTextFile(file) : null;
  const backupPath = `${file}.dsh-backup`;
  if (hadOriginal && !existsSync(backupPath)) {
    copyFileSync(file, backupPath);
  }

  let lines = original === null ? [] : original.split(/\r?\n/);
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const seen = new Set();
  const output = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return line;
    const separator = trimmed.indexOf('=');
    if (separator < 0) return line;
    const key = trimmed.slice(0, separator).trim();
    if (!(key in values)) return line;
    seen.add(key);
    return `${key}=${values[key]}`;
  });
  for (const key of MANAGED_PROPERTY_ORDER) {
    if (key in values && !seen.has(key)) output.push(`${key}=${values[key]}`);
  }

  const text = `${output.join('\n')}\n`;
  const patched = original !== text;
  if (patched) writeTextFile(file, text);
  return { path: file, backupPath: hadOriginal ? backupPath : null, patched };
}

function createLogFile(runDir) {
  const logsDir = ensureDir(join(runDir, 'logs'));
  const stem = `dsh-devtest-${formatLogTimestamp()}`;
  let candidate = join(logsDir, `${stem}.log`);
  let index = 1;
  while (existsSync(candidate)) {
    candidate = join(logsDir, `${stem}-${index}.log`);
    index += 1;
  }
  return candidate;
}

function isPortInUse(host, port, timeoutMs = 800) {
  return new Promise((resolveInUse) => {
    const numericPort = Number(port);
    if (!Number.isInteger(numericPort) || numericPort <= 0 || numericPort > 65535) {
      resolveInUse(false);
      return;
    }
    const socket = connect({ host, port: numericPort });
    let settled = false;
    const finish = (inUse) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        // best effort
      }
      resolveInUse(inUse);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function assertPortAvailable(host, port, label) {
  if (await isPortInUse(host, port)) {
    throw new Error(
      `${label} ${port} is already in use on ${host}; refusing to start to avoid clashing with another server (change the port in server.properties or pass options.port / options.rconPort)`,
    );
  }
}

/**
 * Parse version/loader from captured log lines. Log data is authoritative, but
 * the pre-start directory inference is used as a fallback when a line is absent.
 */
function detectVersionLoader(text, fallback = {}) {
  const parsed = parseMinecraftLog(text);
  let version = parsed.version ?? null;
  if (!version) version = /Loading Minecraft\s+([0-9][^\s]*)/i.exec(text)?.[1] ?? null;
  if (!version) version = /Minecraft Version:\s*([0-9][^\s]*)/i.exec(text)?.[1] ?? null;

  let loader = null;
  if (/neoforge/i.test(text)) loader = 'neoforge';
  else if (/quilt/i.test(text)) loader = 'quilt';
  if (!loader) loader = parsed.loader ?? null;
  if (!loader) {
    if (/fabric loader|fabric/i.test(text)) loader = 'fabric';
    else if (/purpur/i.test(text)) loader = 'purpur';
    else if (/paper/i.test(text)) loader = 'paper';
  }

  return {
    version: isValidMcVersion(version)
      ? version
      : isValidMcVersion(fallback.version)
        ? fallback.version
        : null,
    loader: loader ?? (fallback.loader ?? null),
  };
}

/**
 * For launcher-driven modes (script/gradle) the runner resolves `java` from PATH,
 * so prepend the selected JDK (and set JAVA_HOME) to make the Java selection effective.
 */
function buildSpawnEnvironment(baseEnv, javaSelection, mode) {
  const env = { ...process.env, ...(baseEnv ?? {}) };
  if ((mode === 'script' || mode === 'gradle') && javaSelection?.path && /[\\/]/.test(String(javaSelection.path))) {
    const javaDir = dirname(String(javaSelection.path));
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path') delete env[key];
    }
    env.PATH = `${javaDir}${isWindows ? ';' : ':'}${process.env.PATH ?? process.env.Path ?? ''}`;
    env.JAVA_HOME = dirname(javaDir);
  }
  return env;
}

/** Spawn the actual server process for the resolved launch mode. */
function spawnServerProcess({
  mode,
  cwd,
  javaPath,
  memoryMb,
  extraArgs,
  jarPath,
  scriptPath,
  wrapperPath,
  task,
  env,
}) {
  const spawnOptions = {
    cwd,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, ...(env ?? {}) },
  };

  if (mode === 'jar' || mode === 'fabric') {
    const args = [`-Xmx${memoryMb}M`, ...extraArgs, '-jar', jarPath, 'nogui'];
    return {
      child: spawn(javaPath, args, spawnOptions),
      commandLine: `${javaPath} ${args.join(' ')}`,
    };
  }
  if (mode === 'script' && isWindows) {
    // cmd.exe /d /s /c needs the whole command double-wrapped when the script
    // path contains spaces; windowsVerbatimArguments stops Node from escaping
    // the inner quotes (verified on Windows / Node 24).
    const extra = extraArgs.length > 0 ? ` ${extraArgs.map(quoteCmdArgument).join(' ')}` : '';
    const command = `""${scriptPath}" nogui${extra}"`;
    return {
      child: spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
        ...spawnOptions,
        windowsVerbatimArguments: true,
      }),
      commandLine: `${process.env.ComSpec || 'cmd.exe'} /d /s /c ${command}`,
    };
  }
  if (mode === 'script') {
    const shell = existsSync('/bin/bash') ? '/bin/bash' : 'sh';
    const args = [scriptPath, 'nogui', ...extraArgs];
    return {
      child: spawn(shell, args, spawnOptions),
      commandLine: `${shell} ${args.join(' ')}`,
    };
  }
  if (isWindows) {
    const extra = extraArgs.length > 0 ? ` ${extraArgs.map(quoteCmdArgument).join(' ')}` : '';
    const command = `""${wrapperPath}" ${task}${extra}"`;
    return {
      child: spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command], {
        ...spawnOptions,
        windowsVerbatimArguments: true,
      }),
      commandLine: `${process.env.ComSpec || 'cmd.exe'} /d /s /c ${command}`,
    };
  }
  return {
    child: spawn(wrapperPath, [task, ...extraArgs], spawnOptions),
    commandLine: `${wrapperPath} ${task}`,
  };
}

/**
 * Headless Minecraft server lifecycle manager.
 *
 * Supports jar / fabric / script (Forge+NeoForge installer run scripts) /
 * gradle launch modes across MC 1.7.10-26.x, picks the required Java
 * automatically, respects the existing server.properties (ports, RCON
 * password, level-name) unless a matching start option is explicitly passed,
 * and automatically retries once with a newer Java on a Java version failure.
 */
export class ServerManager {
  constructor() {
    this._run = null;
    this._starting = false;
    this._lines = [];
    this._lastLogPath = null;
    this._lastMode = null;
    this._lastInfo = null;
  }

  /** Current run info object, or null when no server is managed. */
  get active() {
    return this._run ? { ...this._run.info } : null;
  }

  /** Path of the current (or most recent) tee'd log file. */
  get logPath() {
    return this._run?.info.logPath ?? this._lastLogPath ?? null;
  }

  /**
   * Start a headless Minecraft server and wait until it is joinable.
   * Throws with the last 30 log lines on failure (and kills the process tree).
   */
  async start(options = {}) {
    if (this._starting) throw new Error('server is already starting');
    if (this._run) throw new Error(`server is already running (pid ${this._run.info.pid ?? 'unknown'})`);
    this._starting = true;
    try {
      return await this._start(options ?? {});
    } finally {
      this._starting = false;
    }
  }

  async _start(options) {
    const pick = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value);
    const explicitPort = options.port !== undefined && options.port !== null && options.port !== '';
    const explicitRconPort = options.rconPort !== undefined && options.rconPort !== null && options.rconPort !== '';
    const explicitRconPassword =
      options.rconPassword !== undefined && options.rconPassword !== null && options.rconPassword !== '';
    const explicitLevelName = options.levelName !== undefined && options.levelName !== null && options.levelName !== '';

    const memoryMb = Math.max(256, Number(pick(options.memoryMb, 1320)) || 1320);
    const timeoutMs = Math.max(1000, Number(pick(options.timeoutMs, DEFAULT_TIMEOUT_MS)) || DEFAULT_TIMEOUT_MS);
    const patchProperties = options.patchProperties !== false;
    const extraArgs = Array.isArray(options.args) ? options.args.map(String) : [];
    const logFn = typeof options.log === 'function' ? options.log : null;

    const serverDir = options.serverDir ? resolve(String(options.serverDir)) : null;
    const projectDir = options.projectDir ? resolve(String(options.projectDir)) : null;

    let mode = String(options.mode ?? 'auto').trim().toLowerCase() || 'auto';
    if (!SUPPORTED_MODES.includes(mode)) {
      throw new Error(`unknown server mode "${options.mode}" (expected one of: ${SUPPORTED_MODES.join(', ')})`);
    }

    const profile = inferServerProfile({
      serverDir,
      projectDir,
      jar: options.jar,
      runDir: options.runDir,
      version: options.version,
    });
    if (mode === 'auto') {
      if (profile.mode) mode = profile.mode;
      else if (projectDir) mode = 'gradle';
      else if (serverDir) mode = 'jar';
      else throw new Error('start requires serverDir (jar/fabric/script) or projectDir (gradle)');
    }

    // ---- resolve launch layout per mode ----
    let runDir;
    let jarPath = null;
    let scriptPath = null;
    let scriptKind = null;
    let wrapperPath = null;
    let task = null;
    let cwd = null;

    if (mode === 'jar' || mode === 'fabric') {
      if (!serverDir) throw new Error(`serverDir is required for ${mode} mode`);
      if (!existsSync(serverDir)) throw new Error(`serverDir not found: ${serverDir}`);
      runDir = serverDir;
      cwd = serverDir;
      if (mode === 'fabric') {
        const launcher = detectLauncherJar(serverDir);
        if (!launcher) {
          throw new Error(
            `no fabric-server-launch.jar or quilt-server-launch.jar found in ${serverDir} (fabric mode)`,
          );
        }
        jarPath = launcher.path;
      } else {
        jarPath = findServerJar(serverDir, options.jar);
      }
    } else if (mode === 'script') {
      if (!serverDir) throw new Error('serverDir is required for script mode');
      if (!existsSync(serverDir)) throw new Error(`serverDir not found: ${serverDir}`);
      const script = findRunScript(serverDir);
      if (!script) throw new Error(`no run.bat/run.sh found in ${serverDir} (script mode)`);
      runDir = serverDir;
      cwd = serverDir;
      scriptPath = script.path;
      scriptKind = script.kind;
    } else {
      if (!projectDir) throw new Error('projectDir is required for gradle mode');
      if (!existsSync(projectDir)) throw new Error(`projectDir not found: ${projectDir}`);
      wrapperPath = findGradleWrapper(projectDir);
      if (!wrapperPath) throw new Error(`no gradlew.bat found in ${projectDir}`);
      task = String(pick(options.task, 'runServer')).trim() || 'runServer';
      runDir = resolveRunDir(projectDir, options.runDir);
      cwd = projectDir;
    }

    ensureDir(runDir);

    // ---- version / loader inference (corrected from the log after startup) ----
    const versionInfo = inferMcVersion({
      explicitVersion: options.version ?? null,
      serverDir,
      runDir,
      jarPath,
    });
    const mcVersion = isValidMcVersion(versionInfo.version) ? versionInfo.version : null;
    const versionSource = mcVersion ? versionInfo.source : null;
    const inferredLoader = inferLoaderFromDir(runDir, { jarPath });

    // ---- respect the existing server.properties ----
    const propertiesPath = join(runDir, 'server.properties');
    const properties = readServerProperties(propertiesPath);
    const onDiskPort = portProperty(properties, 'server-port', 25565);
    const onDiskRconPort = portProperty(properties, 'rcon.port', 25575);
    const config = {
      port: explicitPort ? Number(options.port) : onDiskPort,
      rconPort: explicitRconPort ? Number(options.rconPort) : onDiskRconPort,
      rconPassword: explicitRconPassword
        ? String(options.rconPassword)
        : textProperty(properties, 'rcon.password', 'dshmcdevtest'),
      levelName: explicitLevelName ? String(options.levelName) : textProperty(properties, 'level-name', 'world'),
    };
    for (const [key, value] of Object.entries({ port: config.port, rconPort: config.rconPort })) {
      if (!Number.isInteger(value) || value <= 0 || value > 65535) {
        throw new Error(`invalid ${key} "${value}" (expected an integer port 1-65535)`);
      }
    }
    if (config.port === config.rconPort) {
      throw new Error(`port and rconPort must differ (both are ${config.port})`);
    }
    const bindHost = resolveBindHost(properties);

    if (!patchProperties && properties.exists) {
      const rconEnabled = (properties.values.get('enable-rcon') ?? '').toLowerCase();
      if (rconEnabled === 'false') {
        throw new Error(
          `RCON is disabled in ${propertiesPath} and patchProperties=false; enable-rcon=true or allow patching`,
        );
      }
    }

    // Preflight before writing anything, using the effective (possibly on-disk) ports.
    await assertPortAvailable(bindHost, config.port, 'port');
    await assertPortAvailable(bindHost, config.rconPort, 'rcon.port');

    // ---- eula + properties patch ----
    writeEulaFile(runDir);
    const patchValues = {};
    if (patchProperties) {
      if (explicitPort || !properties.values.has('server-port')) patchValues['server-port'] = String(config.port);
      if (explicitRconPort || !properties.values.has('rcon.port')) patchValues['rcon.port'] = String(config.rconPort);
      if (explicitRconPassword || !textProperty(properties, 'rcon.password', '')) {
        patchValues['rcon.password'] = config.rconPassword;
      }
      if (explicitLevelName || !textProperty(properties, 'level-name', '')) {
        patchValues['level-name'] = config.levelName;
      }
      if ((properties.values.get('enable-rcon') ?? '').toLowerCase() !== 'true') patchValues['enable-rcon'] = 'true';
      if ((properties.values.get('online-mode') ?? '').toLowerCase() !== 'false') patchValues['online-mode'] = 'false';
      // Vanilla 26.3+ ships white-list=true by default, which kicks test bots with
      // "You are not whitelisted on this server!"; always force it off for dev servers.
      if ((properties.values.get('white-list') ?? '').toLowerCase() !== 'false') patchValues['white-list'] = 'false';
      if ((properties.values.get('enforce-whitelist') ?? '').toLowerCase() !== 'false') {
        patchValues['enforce-whitelist'] = 'false';
      }
      patchPropertiesFile(propertiesPath, patchValues);
    }

    // ---- java selection ----
    let javaSelection = selectJava({ explicitPath: options.javaPath, version: mcVersion });
    // jar/fabric spawn java directly; script/gradle launchers use `java` from PATH,
    // so we report (and inject) the selected java for them too when the MC version is known.
    const reportsJava = mode === 'jar' || mode === 'fabric' || Boolean(mcVersion);

    // ---- log file / in-memory tail ----
    const logPath = createLogFile(runDir);
    const logStream = createWriteStream(logPath, { flags: 'a' });
    logStream.on('error', () => {});
    logStream.write(
      `# dsh-devtest server log\n# startedAt=${nowIso()} mode=${mode} runDir=${runDir}\n` +
        `# mcVersion=${mcVersion ?? '?'} versionSource=${versionSource ?? '?'} loader~${inferredLoader ?? '?'}\n` +
        `# java=${javaSelection.path} javaMajor=${javaSelection.major ?? '?'} required=${javaSelection.required ?? '?'} reason=${javaSelection.reason}\n` +
        `# port=${config.port} rconPort=${config.rconPort} rconHost=${bindHost}\n`,
    );
    this._lines = [];

    const baseInfo = {
      pid: null,
      mode,
      dir: runDir,
      runDir,
      worldDir: join(runDir, config.levelName),
      levelName: config.levelName,
      port: config.port,
      rconPort: config.rconPort,
      logPath,
      startedAt: nowIso(),
      ready: false,
      version: mcVersion,
      versionSource,
      loader: inferredLoader,
      javaPath: reportsJava ? javaSelection.path : null,
      javaMajor: reportsJava ? javaSelection.major : null,
    };
    const layout = {
      jarPath,
      scriptPath,
      scriptKind,
      wrapperPath,
      task,
      cwd,
      serverDir,
      projectDir,
      runDir,
      propertiesPath,
    };

    let successRun = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      if (attempt > 1) {
        const marker = `[dsh-devtest] retrying startup with Java ${javaSelection.major ?? '?'} (${javaSelection.path}) after a Java version failure`;
        this._lines.push(marker);
        logStream.write(`${marker}\n`);
        if (logFn) logFn(marker);
      }

      const info = {
        ...baseInfo,
        pid: null,
        startedAt: nowIso(),
        javaPath: reportsJava ? javaSelection.path : null,
        javaMajor: reportsJava ? javaSelection.major : null,
      };
      let spawned;
      try {
        spawned = spawnServerProcess({
          mode,
          cwd,
          javaPath: javaSelection.path,
          memoryMb,
          extraArgs,
          jarPath,
          scriptPath,
          wrapperPath,
          task,
          env: buildSpawnEnvironment(options.env, javaSelection, mode),
        });
      } catch (error) {
        logStream.end();
        throw new Error(`failed to spawn server process (${mode}): ${shortError(error)}`);
      }
      info.pid = spawned.child.pid ?? null;
      logStream.write(`# command=${spawned.commandLine}\n`);

      const run = this._createRun({ info, child: spawned.child, commandLine: spawned.commandLine, layout, logStream, logFn, rconHost: bindHost, rconPassword: config.rconPassword });
      this._run = run;
      if (logFn) {
        logFn(
          `[dsh-devtest] starting ${mode} server (pid ${info.pid ?? '?'}, dir ${runDir}, ${mcVersion ?? '?'} on Java ${javaSelection.major ?? '?'})`,
        );
      }
      this._attachRunHandlers(run);

      try {
        await this._waitReady(run, timeoutMs);
      } catch (error) {
        await this._abortAttempt(run);
        const canRetry = attempt === 1 && Boolean(mcVersion) && isJavaVersionFailure(`${error.message}\n${this._lines.slice(-80).join('\n')}`);
        if (canRetry) {
          const retrySelection = selectJava({ version: mcVersion });
          if (retrySelection.path.toLowerCase() !== javaSelection.path.toLowerCase()) {
            javaSelection = retrySelection;
            continue;
          }
        }
        const annotated = isJavaVersionFailure(error.message)
          ? new Error(`${error.message}\n${describeJavaFailure(mcVersion, javaSelection)}`)
          : error;
        this._finalizeRun(run);
        throw annotated;
      }

      successRun = run;
      break;
    }
    if (!successRun) throw new Error('server failed to start (no launch attempt succeeded)');
    const run = successRun;

    const detected = detectVersionLoader(this._lines.join('\n'), {
      version: run.info.version,
      loader: run.info.loader,
    });
    if (detected.version && detected.version !== run.info.version) {
      run.info.version = detected.version;
      run.info.versionSource = 'logs';
    }
    if (detected.loader) run.info.loader = detected.loader;

    try {
      run.rcon = await this._connectRcon(run);
    } catch (error) {
      await this._abortRun(run);
      throw error;
    }

    run.info.ready = true;
    if (logFn) {
      logFn(
        `[dsh-devtest] server ready (pid ${run.info.pid}, ${run.info.version ?? '?'} ${run.info.loader ?? '?'}, Java ${run.info.javaMajor ?? '?'})`,
      );
    }
    return { ...run.info };
  }

  _createRun({ info, child, commandLine, layout, logStream, logFn, rconHost, rconPassword }) {
    return {
      info,
      child,
      commandLine,
      jarPath: layout.jarPath,
      scriptPath: layout.scriptPath,
      scriptKind: layout.scriptKind,
      wrapperPath: layout.wrapperPath,
      task: layout.task,
      cwd: layout.cwd,
      serverDir: layout.serverDir,
      projectDir: layout.projectDir,
      runDir: layout.runDir,
      levelName: info.levelName,
      propertiesPath: layout.propertiesPath,
      logStream,
      logFn,
      rcon: null,
      rconHost,
      rconPassword,
      exitPromise: null,
      exitInfo: null,
      exited: false,
      stopping: false,
      readyCalled: false,
      partial: '',
      startup: createDeferred(),
    };
  }

  _attachRunHandlers(run) {
    const child = run.child;
    run.exitPromise = new Promise((resolveExit) => {
      child.once('close', (code, signal) => {
        run.exited = true;
        run.exitInfo = { code, signal };
        if (run.partial.trim()) {
          this._appendLine(run, stripAnsi(run.partial.trim()));
          run.partial = '';
        }
        if (!run.readyCalled && !run.stopping) {
          run.startup.reject(
            new Error(
              `server process exited before it became ready (code=${code ?? 'null'}${signal ? `, signal=${signal}` : ''})\n${this._tailText(30)}`,
            ),
          );
        }
        if (run.info.ready && !run.stopping && this._run === run) {
          this._handleUnexpectedExit(run);
        }
        resolveExit(run.exitInfo);
      });
      child.once('error', (error) => {
        run.spawnError = error;
        if (!run.readyCalled) {
          run.startup.reject(
            new Error(`failed to spawn server process (${run.commandLine ?? run.info.mode}): ${shortError(error)}`),
          );
        }
      });
    });
    this._attachLogPipes(run);
  }

  async _waitReady(run, timeoutMs) {
    let timeoutHandle = null;
    const timeoutPromise = new Promise((resolveTimeout) => {
      timeoutHandle = setTimeout(() => resolveTimeout('timeout'), timeoutMs);
    });
    try {
      const outcome = await Promise.race([run.startup.promise, timeoutPromise]);
      if (outcome === 'timeout') {
        throw new Error(
          `server did not become ready within ${timeoutMs}ms (pid ${run.info.pid ?? 'unknown'})\n${this._tailText(30)}`,
        );
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle);
    }
  }

  /**
   * Stop the managed server: RCON `stop` first, then fall back to killing the
   * process tree (Windows: taskkill /T /F). Idempotent.
   */
  async stop() {
    const run = this._run;
    if (!run) {
      return { mode: this._lastMode ?? null, pid: null, stopped: false, alreadyStopped: true };
    }
    run.stopping = true;
    const mode = run.info.mode;
    const pid = run.info.pid ?? null;
    let method = 'none';

    if (run.info.ready && run.rcon?.connected) {
      method = 'rcon';
      try {
        await run.rcon.command('stop');
      } catch {
        // Servers commonly drop the RCON socket right after acknowledging stop.
      }
    }
    try {
      run.rcon?.close();
    } catch {
      // best effort
    }
    run.rcon = null;

    let exited = await waitForExit(run, STOP_WAIT_MS);
    if (!exited) {
      method = 'kill';
      killProcessTree(run.child?.pid ?? pid);
      exited = await waitForExit(run, KILL_WAIT_MS);
      if (!exited) {
        killProcessTree(run.child?.pid ?? pid);
        exited = await waitForExit(run, 3000);
      }
    }

    this._finalizeRun(run);
    return { mode, pid, stopped: exited, alreadyStopped: false, forced: method === 'kill' };
  }

  /** Current status as a JSON-serialisable object. */
  status() {
    const run = this._run;
    if (!run) {
      const status = { active: false, ready: false };
      const last = this._lastInfo;
      if (last) {
        status.mode = last.mode;
        status.loader = last.loader ?? undefined;
        status.version = last.version ?? undefined;
        status.versionSource = last.versionSource ?? undefined;
        status.port = last.port;
        status.rconPort = last.rconPort;
        status.runDir = last.runDir;
        status.worldDir = last.worldDir;
        status.levelName = last.levelName;
        status.logPath = last.logPath;
        status.startedAt = last.startedAt;
        status.javaPath = last.javaPath ?? undefined;
        status.javaMajor = last.javaMajor ?? undefined;
      } else if (this._lastLogPath) {
        status.logPath = this._lastLogPath;
      }
      return status;
    }
    const info = run.info;
    return {
      active: true,
      ready: info.ready === true,
      pid: info.pid ?? undefined,
      mode: info.mode,
      dir: info.dir,
      runDir: info.runDir,
      worldDir: info.worldDir,
      levelName: info.levelName,
      port: info.port,
      rconPort: info.rconPort,
      logPath: info.logPath,
      startedAt: info.startedAt,
      version: info.version ?? undefined,
      versionSource: info.versionSource ?? undefined,
      loader: info.loader ?? undefined,
      javaPath: info.javaPath ?? undefined,
      javaMajor: info.javaMajor ?? undefined,
    };
  }

  /** Last `n` lines of the in-memory tail (max 5000 lines kept). */
  logTail(n = 100) {
    const numeric = Number(n);
    const want = Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : 100;
    if (want === 0) return [];
    return this._lines.slice(-want);
  }

  /** Run one command over RCON; returns { command, response, ms }. */
  async command(cmd) {
    const run = this._run;
    if (!run) throw new Error('server is not running (start it first)');
    if (!run.info.ready || !run.rcon?.connected) throw new Error('server is not ready (RCON is not connected yet)');
    const normalized = normalizeCmd(cmd);
    if (!normalized) throw new Error('command is empty');
    const startedMs = Date.now();
    const response = await run.rcon.command(normalized);
    return { command: normalized, response, ms: Date.now() - startedMs };
  }

  _attachLogPipes(run) {
    const onData = (chunk) => {
      run.partial += chunk.toString('utf8');
      if (run.partial.length > 1024 * 1024) {
        this._appendLine(run, stripAnsi(run.partial));
        run.partial = '';
        return;
      }
      let newlineIndex;
      while ((newlineIndex = run.partial.indexOf('\n')) >= 0) {
        const raw = run.partial.slice(0, newlineIndex);
        run.partial = run.partial.slice(newlineIndex + 1);
        this._appendLine(run, stripAnsi(raw.replace(/\r$/, '')));
      }
    };
    run.child.stdout?.on('data', onData);
    run.child.stderr?.on('data', onData);
  }

  _appendLine(run, line) {
    const text = String(line ?? '');
    this._lines.push(text);
    if (this._lines.length > MAX_LOG_LINES) {
      this._lines.splice(0, this._lines.length - MAX_LOG_LINES);
    }
    if (run.logStream) {
      try {
        run.logStream.write(`${text}\n`);
      } catch {
        // logging must never break the lifecycle
      }
    }
    if (run.logFn) {
      try {
        run.logFn(text);
      } catch {
        // user callback failures are not fatal
      }
    }
    if (!run.readyCalled && isReadyLine(text)) {
      run.readyCalled = true;
      run.startup.resolve('ready');
    }
  }

  async _connectRcon(run) {
    const deadline = Date.now() + RCON_RETRY_MS;
    let lastError = null;
    while (Date.now() < deadline) {
      if (run.exited) {
        throw new Error(
          `server process exited before RCON became available (code=${run.exitInfo?.code ?? 'null'})\n${this._tailText(30)}`,
        );
      }
      const client = new RconClient({
        host: run.rconHost,
        port: run.info.rconPort,
        password: run.rconPassword,
        timeoutMs: 3000,
      });
      try {
        await client.connect();
        return client;
      } catch (error) {
        lastError = error;
        client.close();
        if (/authentication failed/i.test(error.message)) {
          throw new Error(
            `RCON authentication failed on ${run.rconHost}:${run.info.rconPort}: ${shortError(error)}\n${this._tailText(30)}`,
          );
        }
        if (run.exited) break;
        await sleep(400);
      }
    }
    throw new Error(
      `RCON not reachable on ${run.rconHost}:${run.info.rconPort} within ${RCON_RETRY_MS}ms${lastError ? `: ${shortError(lastError)}` : ''}\n${this._tailText(30)}`,
    );
  }

  _handleUnexpectedExit(run) {
    run.info.ready = false;
    this._appendLine(run, `[dsh-devtest] server process exited unexpectedly (code=${run.exitInfo?.code ?? 'null'})`);
    try {
      run.rcon?.close();
    } catch {
      // best effort
    }
    run.rcon = null;
    this._finalizeRun(run);
  }

  async _abortAttempt(run) {
    run.stopping = true;
    try {
      run.rcon?.close();
    } catch {
      // best effort
    }
    run.rcon = null;
    if (!run.exited) {
      killProcessTree(run.child?.pid ?? run.info.pid);
      await waitForExit(run, KILL_WAIT_MS);
      if (!run.exited) {
        killProcessTree(run.child?.pid ?? run.info.pid);
        await waitForExit(run, 3000);
      }
    }
    if (this._run === run) this._run = null;
  }

  async _abortRun(run) {
    await this._abortAttempt(run);
    this._finalizeRun(run);
  }

  _finalizeRun(run) {
    if (this._run === run) this._run = null;
    try {
      run.rcon?.close();
    } catch {
      // best effort
    }
    run.rcon = null;
    const stream = run.logStream;
    run.logStream = null;
    if (stream) {
      try {
        stream.end();
      } catch {
        // best effort
      }
    }
    this._lastLogPath = run.info.logPath ?? this._lastLogPath;
    this._lastMode = run.info.mode ?? this._lastMode;
    this._lastInfo = { ...run.info, ready: false };
  }

  _tailText(n = 30) {
    const numeric = Number(n);
    const want = Number.isFinite(numeric) && numeric > 0 ? Math.floor(numeric) : 30;
    return ['--- last log lines ---', ...this._lines.slice(-want)].join('\n');
  }
}

export const serverManager = new ServerManager();
