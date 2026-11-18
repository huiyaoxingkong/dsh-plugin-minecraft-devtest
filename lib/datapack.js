// Data pack tooling: discovery, scanning/validation, deployment and server.jar
// pack-version detection. Contract: docs/CONTRACTS.md `lib/datapack.js`.
//
// Everything here is client-free: scanning works on the file system, deployment
// copies into a server world folder, and version detection unpacks `version.json`
// from a server jar with the JDK `jar` tool (falling back to Windows `tar`).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { findJava, listFilesRecursive, parsePackFormatMap, readTextFile, shortError, spawnCollect } from './util.js';
import { dataPackSupported } from './versions.js';

// `< 1.13` releases have no data packs; re-exported here so datapack tooling can
// gate its advice without importing lib/versions.js directly.
export { dataPackSupported };

const SKIP_DIRS = new Set(['node_modules', '.git']);

// Content kinds a namespace may contain. `extensions` describes what is treated
// as content: real 1.20.1+ packs use `.mcfunction` for functions and `.nbt` for
// structures, everything else is JSON. Only `.json` files are JSON-validated.
const CONTENT_KINDS = [
  { key: 'functions', dirs: ['function', 'functions'], extensions: ['.mcfunction', '.json'] },
  { key: 'recipes', dirs: ['recipe', 'recipes'], extensions: ['.json'] },
  { key: 'lootTables', dirs: ['loot_table', 'loot_tables'], extensions: ['.json'] },
  { key: 'advancements', dirs: ['advancement', 'advancements'], extensions: ['.json'] },
  { key: 'tags', dirs: ['tags'], extensions: ['.json'] },
  { key: 'predicates', dirs: ['predicate', 'predicates'], extensions: ['.json'] },
  { key: 'itemModifiers', dirs: ['item_modifier', 'item_modifiers'], extensions: ['.json'] },
  { key: 'structures', dirs: ['structure', 'structures'], extensions: ['.nbt', '.json'] },
  { key: 'dimensions', dirs: ['dimension', 'dimensions'], extensions: ['.json'] },
];

function isDir(path) {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isFile(path) {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function sortedDirEntries(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function samePath(left, right) {
  const a = resolve(left);
  const b = resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

// True when `child` is strictly inside `parent` (both normalized absolute paths).
function isWithin(parent, child) {
  const rel = relative(resolve(parent), resolve(child));
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

function posixPath(absolutePath, baseDir) {
  return relative(baseDir, absolutePath).split(sep).join('/');
}

function integerOrNull(value) {
  return typeof value === 'number' && Number.isInteger(value) ? value : null;
}

function normalizeDescription(description) {
  if (typeof description === 'string') return description;
  if (description && typeof description === 'object' && !Array.isArray(description)) {
    if (typeof description.text === 'string') return description.text;
  }
  return null;
}

// Normalizes a single format token into { major, minor } or null. Tokens are
// positive integers or [major, minor] pairs (1.21.9+ max_format shape).
function formatTokenToNumber(raw) {
  if (typeof raw === 'number' && Number.isInteger(raw) && raw >= 1) return { major: raw, minor: null };
  if (Array.isArray(raw) && raw.length >= 1 && raw.length <= 2) {
    const major = integerOrNull(raw[0]);
    const minor = raw.length > 1 ? integerOrNull(raw[1]) : null;
    if (major === null || major < 1) return null;
    return { major, minor };
  }
  return null;
}

// Returns { packFormat, minFormat, maxFormat } on success or { error }.
// Handles the legacy `pack_format` (number or { resource, data } object) and the
// 1.21.9+ `min_format` / `max_format` form (number or [major, minor]).
function normalizePackVersion(pack) {
  const hasLegacy = pack.pack_format !== undefined;
  const hasRange = pack.min_format !== undefined || pack.max_format !== undefined;

  let packFormat = null;
  if (hasLegacy) {
    const raw = pack.pack_format;
    if (typeof raw === 'number') {
      if (!Number.isInteger(raw) || raw < 1) {
        return { error: `pack.pack_format must be a positive integer (got ${JSON.stringify(raw)})` };
      }
      packFormat = raw;
    } else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const dataFormat = integerOrNull(raw.data);
      if (dataFormat === null || dataFormat < 1) {
        return {
          error: 'pack.pack_format object is missing a valid "data" field (expected { "resource": .., "data": .. })',
        };
      }
      packFormat = dataFormat;
    } else {
      return {
        error: `pack.pack_format must be a number or { "resource": .., "data": .. } object (got ${typeof raw})`,
      };
    }
  }

  let minFormat = null;
  let maxFormat = null;
  if (hasRange) {
    const minToken = pack.min_format === undefined ? null : formatTokenToNumber(pack.min_format);
    const maxToken = pack.max_format === undefined ? null : formatTokenToNumber(pack.max_format);
    if (pack.min_format !== undefined && minToken === null) {
      return { error: 'pack.min_format must be a positive integer or [major, minor] array' };
    }
    if (pack.max_format !== undefined && maxToken === null) {
      return { error: 'pack.max_format must be a positive integer or [major, minor] array' };
    }
    minFormat = minToken?.major ?? null;
    maxFormat = maxToken?.major ?? null;
    if (minFormat !== null && maxFormat !== null && minFormat > maxFormat) {
      return { error: `pack.min_format (${minFormat}) is greater than pack.max_format (${maxFormat})` };
    }
  }

  if (packFormat === null) packFormat = maxFormat ?? minFormat;
  if (packFormat === null) {
    return { error: 'pack.pack_format is missing (1.21.9+ packs may declare min_format / max_format instead)' };
  }
  return { packFormat, minFormat, maxFormat };
}

// Parses <packDir>/pack.mcmeta. Never throws; problems land in `errors`.
function readPackMeta(packDir) {
  const file = join(packDir, 'pack.mcmeta');
  const result = {
    file,
    exists: false,
    packFormat: null,
    packFormatRange: null,
    description: null,
    errors: [],
  };
  if (!isFile(file)) {
    result.errors.push({ file, message: 'missing pack.mcmeta' });
    return result;
  }
  result.exists = true;
  let parsed;
  try {
    parsed = JSON.parse(readTextFile(file));
  } catch (error) {
    result.errors.push({ file, message: `invalid JSON: ${shortError(error)}` });
    return result;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    result.errors.push({ file, message: 'pack.mcmeta must contain a JSON object' });
    return result;
  }
  const pack = parsed.pack;
  if (!pack || typeof pack !== 'object' || Array.isArray(pack)) {
    result.errors.push({ file, message: 'pack.mcmeta is missing the "pack" object' });
    return result;
  }
  const version = normalizePackVersion(pack);
  if (version.error) {
    result.errors.push({ file, message: `invalid pack version: ${version.error}` });
  } else {
    result.packFormat = version.packFormat;
    if (version.minFormat !== null || version.maxFormat !== null) {
      result.packFormatRange = {
        min: version.minFormat ?? version.packFormat,
        max: version.maxFormat ?? version.packFormat,
      };
    }
  }
  result.description = normalizeDescription(pack.description);
  return result;
}

// Best-effort `pack_format` for findPacks(): null when absent or unreadable.
function readPackFormatQuiet(packDir) {
  try {
    return readPackMeta(packDir).packFormat;
  } catch {
    return null;
  }
}

function listContentFiles(absoluteDir, extensions) {
  const lowered = extensions.map((extension) => extension.toLowerCase());
  const files = listFilesRecursive(absoluteDir, {
    filter: (file) => lowered.some((extension) => file.toLowerCase().endsWith(extension)),
  });
  return files.sort((left, right) => left.localeCompare(right));
}

function pushProblem(errors, warnings, strictJson, problem) {
  if (strictJson) errors.push(problem);
  else warnings.push(problem);
}

// Validates one known-directory JSON file. `.mcfunction`/`.nbt` files are not
// JSON and are only listed, never parsed.
function validateContentFile(absoluteFile, errors, warnings, strictJson) {
  if (!absoluteFile.toLowerCase().endsWith('.json')) return;
  let parsed;
  try {
    parsed = JSON.parse(readTextFile(absoluteFile));
  } catch (error) {
    pushProblem(errors, warnings, strictJson, { file: absoluteFile, message: `invalid JSON: ${shortError(error)}` });
    return;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    warnings.push({ file: absoluteFile, message: 'top-level JSON value is not an object' });
  }
}

function scanNamespace(packDir, dataDir, namespace, { strictJson, errors, warnings, counts }) {
  const namespaceDir = join(dataDir, namespace);
  const record = {
    ns: namespace,
    functions: [],
    recipes: [],
    lootTables: [],
    advancements: [],
    tags: [],
    predicates: [],
    itemModifiers: [],
    structures: [],
    dimensions: [],
  };
  for (const kind of CONTENT_KINDS) {
    const files = [];
    for (const subDir of kind.dirs) {
      const candidate = join(namespaceDir, subDir);
      if (isDir(candidate)) files.push(...listContentFiles(candidate, kind.extensions));
    }
    if (files.length === 0) continue;
    files.sort((left, right) => left.localeCompare(right));
    record[kind.key] = files.map((file) => posixPath(file, packDir));
    if (Object.hasOwn(counts, kind.key)) counts[kind.key] += files.length;
    for (const file of files) validateContentFile(file, errors, warnings, strictJson);
  }
  return record;
}

function scanPackInternal(packDir, { strictJson = true, version = null } = {}) {
  const dir = resolve(String(packDir ?? ''));
  if (!existsSync(dir) || !isDir(dir)) throw new Error(`pack directory not found: ${dir}`);
  const targetVersion = version === undefined || version === null || version === '' ? null : String(version).trim();
  const supported = targetVersion === null ? null : dataPackSupported(targetVersion);
  const errors = [];
  const warnings = [];
  if (supported === false) {
    warnings.push({
      file: dir,
      message:
        `Minecraft ${targetVersion} has no data pack support (data packs were introduced in Minecraft 1.13); ` +
        'this directory cannot be loaded as a data pack',
    });
  }
  const meta = readPackMeta(dir);
  // A pre-1.13 directory cannot have a pack.mcmeta, so a missing one is expected
  // there instead of a validation error.
  if (!(supported === false && !meta.exists)) errors.push(...meta.errors);

  const dataDir = join(dir, 'data');
  const hasData = isDir(dataDir);
  if (!hasData) {
    warnings.push({
      file: dataDir,
      message: 'data/ directory is missing; this looks like a resource pack, a data pack would not load anything',
    });
  }

  const counts = { functions: 0, recipes: 0, lootTables: 0, advancements: 0, tags: 0, jsonFiles: 0 };
  const namespaces = [];
  if (hasData) {
    for (const entry of sortedDirEntries(dataDir)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      namespaces.push(scanNamespace(dir, dataDir, entry.name, { strictJson, errors, warnings, counts }));
    }
    counts.jsonFiles = listFilesRecursive(dataDir, { filter: (file) => file.toLowerCase().endsWith('.json') }).length;
  }

  return {
    ok: errors.length === 0,
    dir,
    name: basename(dir),
    version: targetVersion,
    dataPackSupported: supported,
    packFormat: meta.packFormat,
    packFormatRange: meta.packFormatRange,
    description: meta.description,
    namespaces,
    counts,
    errors,
    warnings,
  };
}

/**
 * Recursively find candidate data pack directories (containing pack.mcmeta or data/).
 * A candidate is not descended into, so nested content folders are never reported.
 */
export function findPacks(rootDir, { maxDepth = 4 } = {}) {
  const root = resolve(String(rootDir ?? ''));
  if (!existsSync(root) || !isDir(root)) throw new Error(`root directory not found: ${root}`);
  const requestedDepth = Number(maxDepth);
  const limit = Number.isFinite(requestedDepth) && requestedDepth >= 0 ? Math.floor(requestedDepth) : 4;
  const found = [];
  const walk = (current, depth) => {
    if (depth > limit) return;
    const isCandidate = isFile(join(current, 'pack.mcmeta')) || isDir(join(current, 'data'));
    if (isCandidate) {
      found.push({ dir: current, name: basename(current), packFormat: readPackFormatQuiet(current) });
      return;
    }
    if (depth === limit) return;
    for (const entry of sortedDirEntries(current)) {
      if (!entry.isDirectory() || SKIP_DIRS.has(entry.name)) continue;
      walk(join(current, entry.name), depth + 1);
    }
  };
  walk(root, 0);
  return found;
}

/**
 * Scan one pack: structure, namespace listings, counts, errors and warnings.
 * Pass `{ version }` when the target Minecraft version is known so pre-1.13
 * targets are flagged as unsupported instead of looking like broken packs.
 */
export function scanPack(packDir, options = {}) {
  return scanPackInternal(packDir, { ...(options ?? {}), strictJson: true });
}

function formatVersionHint(format) {
  if (!Number.isInteger(format)) return '';
  const versions = Object.entries(parsePackFormatMap())
    .filter(([, value]) => Number(value) === format)
    .map(([version]) => version);
  if (versions.length === 0) return '';
  const shown = versions.length > 4 ? `${versions.slice(0, 3).join('/')}/…` : versions.join('/');
  return ` (Minecraft ${shown})`;
}

/**
 * Validate a pack against the v1 rules and optionally a known data pack format.
 * `strictJson: false` downgrades invalid content JSON from errors to warnings.
 * Pass `{ version }` (target Minecraft version) to surface pre-1.13 data pack
 * unsupported warnings instead of misjudging the directory.
 */
export function validatePack(packDir, { expectedFormat, strictJson = true, version } = {}) {
  const scan = scanPackInternal(packDir, { strictJson: strictJson !== false, version });
  const errors = [...scan.errors];
  const warnings = [...scan.warnings];
  const unsupported = scan.dataPackSupported === false;

  let expected = null;
  if (expectedFormat !== undefined && expectedFormat !== null && expectedFormat !== '') {
    if (typeof expectedFormat === 'number' && Number.isInteger(expectedFormat)) {
      expected = expectedFormat;
    } else if (typeof expectedFormat === 'string' && /^\d+$/.test(expectedFormat.trim())) {
      expected = Number(expectedFormat.trim());
    } else {
      warnings.push({
        file: scan.dir,
        message: `expectedFormat ignored because it is not an integer (got ${JSON.stringify(expectedFormat)})`,
      });
    }
  }
  if (unsupported && expected !== null) {
    warnings.push({
      file: scan.dir,
      message: `expectedFormat ${expected} ignored: Minecraft ${scan.version} has no data pack support`,
    });
  } else if (expected !== null && scan.packFormat !== null) {
    // Exact comparison for classic packs, range comparison when the pack declares
    // 1.21.9+ min_format / max_format (a format inside the range is compatible).
    const range = scan.packFormatRange ?? { min: scan.packFormat, max: scan.packFormat };
    if (expected < range.min || expected > range.max) {
      const message =
        range.min === range.max
          ? `pack_format ${scan.packFormat}${formatVersionHint(scan.packFormat)} does not match ` +
            `expected data pack format ${expected}${formatVersionHint(expected)}`
          : `pack_format range ${range.min}${formatVersionHint(range.min)} - ` +
            `${range.max}${formatVersionHint(range.max)} does not include ` +
            `expected data pack format ${expected}${formatVersionHint(expected)}`;
      errors.push({ file: join(scan.dir, 'pack.mcmeta'), message });
    }
  }

  // 1.21.9+ pack parser: a pack declaring a format newer than 81 MUST also declare
  // min_format / max_format, otherwise the server logs
  //   JsonParseException: Pack declares support for version newer than 81,
  //   but is missing mandatory fields min_format and max_format
  // and refuses the pack on /reload.
  if (scan.packFormat !== null && scan.packFormat > 81 && scan.packFormatRange === null) {
    warnings.push({
      file: join(scan.dir, 'pack.mcmeta'),
      message:
        `pack_format ${scan.packFormat} 但未声明 min_format/max_format：1.21.9+（含 26.x）服务端会报 ` +
        '"Pack declares support for version newer than 81, but is missing mandatory fields min_format and max_format" ' +
        '并拒绝该数据包；请改用/补充 "min_format"/"max_format"（数字或 [major,minor]）',
    });
  }

  return {
    ok: errors.length === 0,
    dir: scan.dir,
    name: scan.name,
    version: scan.version,
    dataPackSupported: scan.dataPackSupported,
    packFormat: scan.packFormat,
    packFormatRange: scan.packFormatRange,
    expectedFormat: expected,
    counts: scan.counts,
    errors,
    warnings,
  };
}

// ---------------------------------------------------------------------------
// server.jar version.json detection
// ---------------------------------------------------------------------------

function jarsIn(dir) {
  try {
    return readdirSync(dir)
      .filter((name) => /\.jar$/i.test(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

// Vanilla server install dirs unpack the bundled server jar to
// versions/<version>/server-<version>.jar (and keep libraries/ next to it).
function findJarUnderVersions(dir) {
  const versionsDir = join(dir, 'versions');
  if (!isDir(versionsDir)) return null;
  const versionDirs = sortedDirEntries(versionsDir).filter((entry) => entry.isDirectory());
  const candidates = [];
  for (const versionDir of versionDirs) {
    for (const file of jarsIn(join(versionsDir, versionDir.name))) {
      if (/^server.*\.jar$/i.test(basename(file))) candidates.push(file);
    }
  }
  if (candidates.length === 1) return candidates[0];
  if (candidates.length > 1) {
    const dirName = basename(dir).toLowerCase();
    const matching = candidates.filter(
      (file) =>
        basename(dirname(file)).toLowerCase() === dirName ||
        basename(file).toLowerCase().includes(`-${dirName}.jar`),
    );
    return matching.length === 1 ? matching[0] : null;
  }
  // No server-*.jar: accept the single jar of a single installed version dir.
  if (versionDirs.length === 1) {
    const only = jarsIn(join(versionsDir, versionDirs[0].name));
    if (only.length === 1) return only[0];
  }
  return null;
}

// Some vanilla installs keep the launch jar next to (not inside) the run
// directory, e.g. ...\_mw_server\1.20.1 + ...\_mw_server\server-1.20.1.jar.
function findJarInParent(dir) {
  const parent = dirname(dir);
  if (!parent || samePath(parent, dir)) return null;
  const exact = join(parent, `server-${basename(dir)}.jar`);
  if (isFile(exact)) return exact;
  const serverJars = jarsIn(parent).filter((file) => /^server.*\.jar$/i.test(basename(file)));
  return serverJars.length === 1 ? serverJars[0] : null;
}

function resolveServerJar(input, explicitJarPath = null) {
  // An explicitly passed jar is authoritative: if it is not a readable .jar the
  // caller gets null instead of an unrelated jar being guessed.
  if (explicitJarPath !== null && explicitJarPath !== undefined && explicitJarPath !== '') {
    const explicit = resolve(String(explicitJarPath));
    return isFile(explicit) && /\.jar$/i.test(explicit) ? explicit : null;
  }
  if (input === undefined || input === null || input === '') return null;
  const value = resolve(String(input));
  if (!existsSync(value)) return null;
  if (isFile(value)) return /\.jar$/i.test(value) ? value : null;
  if (!isDir(value)) return null;

  const candidates = [
    join(value, 'server.jar'),
    join(value, 'run', 'server.jar'),
    join(value, 'server', 'server.jar'),
    join(value, 'minecraft_server.jar'),
  ];
  for (const candidate of candidates) if (isFile(candidate)) return candidate;

  const versionJar = findJarUnderVersions(value);
  if (versionJar) return versionJar;

  const direct = jarsIn(value);
  if (direct.length === 1) return direct[0];
  const runDir = join(value, 'run');
  if (isDir(runDir)) {
    const runJars = jarsIn(runDir);
    if (runJars.length === 1) return runJars[0];
  }
  return findJarInParent(value);
}

// Finds the JDK `jar` executable: JAVA_HOME/bin, sibling of `java` from PATH, or bare `jar`.
function findJarTool() {
  const exeName = process.platform === 'win32' ? 'jar.exe' : 'jar';
  const java = findJava();
  if (java && isFile(java)) {
    const sibling = join(dirname(java), exeName);
    if (isFile(sibling)) return sibling;
  }
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const candidate = join(javaHome, 'bin', exeName);
    if (isFile(candidate)) return candidate;
  }
  return 'jar';
}

function packVersionResult(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const version =
    typeof parsed.id === 'string' ? parsed.id : typeof parsed.name === 'string' ? parsed.name : null;
  const packVersion = parsed.pack_version;
  let dataFormat = null;
  let resourceFormat = null;
  let dataFormatMinor = null;
  let resourceFormatMinor = null;
  if (typeof packVersion === 'number' && Number.isFinite(packVersion)) {
    dataFormat = packVersion;
    resourceFormat = packVersion;
  } else if (packVersion && typeof packVersion === 'object' && !Array.isArray(packVersion)) {
    dataFormat = integerOrNull(packVersion.data);
    resourceFormat = integerOrNull(packVersion.resource);
    dataFormatMinor = integerOrNull(packVersion.data_minor);
    resourceFormatMinor = integerOrNull(packVersion.resource_minor);
    // 1.21.9+ (e.g. 1.21.11) splits the format into major/minor fields:
    // { resource_major, resource_minor, data_major, data_minor }.
    if (dataFormat === null) dataFormat = integerOrNull(packVersion.data_major);
    if (resourceFormat === null) resourceFormat = integerOrNull(packVersion.resource_major);
  }
  // Pre-1.14 jars may carry a version.json without any pack_version information
  // (or a field shape we do not understand): report "unknown" instead of a
  // half-filled object so callers fall back to the version table.
  if (dataFormat === null && resourceFormat === null && dataFormatMinor === null && resourceFormatMinor === null) {
    return null;
  }
  return { version, dataFormat, resourceFormat, dataFormatMinor, resourceFormatMinor };
}

function explicitJarArgument(options) {
  if (!options) return null;
  if (typeof options === 'string') return options;
  if (typeof options === 'object' && typeof options.jar === 'string') return options.jar;
  return null;
}

/**
 * Reads `version.json` from a server jar (or a directory containing one, such as a
 * server dir, a vanilla install dir with versions/, or a Gradle run dir) and
 * reports the pack formats it declares.
 *
 * @param {string} serverDirOrJarOrProjectDir jar file, server/install dir, or project dir
 * @param {{ jar?: string }|string} [options] explicit jar path override
 * @returns {Promise<{version: string|null, dataFormat: number|null, resourceFormat: number|null,
 *   dataFormatMinor: number|null, resourceFormatMinor: number|null}|null>}
 *   null when no usable version.json can be found; never throws (best effort).
 */
export async function readServerPackVersion(serverDirOrJarOrProjectDir, options = null) {
  try {
    const jarPath = resolveServerJar(serverDirOrJarOrProjectDir, explicitJarArgument(options));
    if (!jarPath) return null;
    const tempDir = mkdtempSync(join(tmpdir(), 'dsh-mcdt-packver-'));
    try {
      const extracted = join(tempDir, 'version.json');
      // Preferred: JDK jar tool, extracting only the one entry.
      const jarTool = findJarTool();
      if (jarTool) {
        await spawnCollect(jarTool, ['xf', jarPath, 'version.json'], { cwd: tempDir, timeoutMs: 120000 });
      }
      // Fallback: Windows bsdtar / GNU tar variants that can read zip archives.
      if (!existsSync(extracted)) {
        await spawnCollect('tar', ['-xf', jarPath, 'version.json'], { cwd: tempDir, timeoutMs: 120000 });
      }
      if (!existsSync(extracted)) return null;
      let parsed;
      try {
        parsed = JSON.parse(readTextFile(extracted));
      } catch {
        return null;
      }
      return packVersionResult(parsed);
    } finally {
      try {
        rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // temp cleanup is best effort
      }
    }
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Deployment
// ---------------------------------------------------------------------------

function copyDirRecursive(source, target) {
  mkdirSync(target, { recursive: true });
  for (const entry of sortedDirEntries(source)) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const from = join(source, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(from, to);
      continue;
    }
    let stats;
    try {
      stats = statSync(from);
    } catch {
      continue;
    }
    if (stats.isFile()) copyFileSync(from, to);
  }
}

/**
 * Copies a pack into <serverDir>/<levelName>/datapacks/<name>, replacing any old
 * copy. Refuses to copy a pack into itself, and skips .git/node_modules inside it.
 */
export async function deployPack(serverDir, packDir, { levelName = 'world' } = {}) {
  const serverRoot = resolve(String(serverDir ?? ''));
  const source = resolve(String(packDir ?? ''));
  if (!isDir(source)) throw new Error(`datapack directory not found: ${source}`);
  const level = String(levelName ?? '').trim() || 'world';
  const name = basename(source);
  if (!name) throw new Error(`cannot determine datapack name from ${source}`);
  const target = join(serverRoot, level, 'datapacks', name);
  if (samePath(source, target) || isWithin(source, target) || isWithin(target, source)) {
    throw new Error(`refusing to deploy: source and target overlap (source: ${source}, target: ${target})`);
  }
  if (existsSync(target)) rmSync(target, { recursive: true, force: true });
  copyDirRecursive(source, target);
  if (!existsSync(target)) throw new Error(`deploy failed: ${target} was not created`);
  const sourceMeta = join(source, 'pack.mcmeta');
  if (isFile(sourceMeta) && !isFile(join(target, 'pack.mcmeta'))) {
    throw new Error(`deploy failed: pack.mcmeta was not copied to ${target}`);
  }
  return { deployed: true, target, packDir: source, name };
}

/** Lists datapack folders (and legacy .zip packs) deployed in a world. */
export function listDeployed(serverDir, { levelName = 'world' } = {}) {
  const level = String(levelName ?? '').trim() || 'world';
  const datapacksDir = join(resolve(String(serverDir ?? '')), level, 'datapacks');
  if (!isDir(datapacksDir)) return [];
  const out = [];
  for (const entry of sortedDirEntries(datapacksDir)) {
    const path = join(datapacksDir, entry.name);
    if (entry.isDirectory() || (entry.isFile() && /\.zip$/i.test(entry.name))) {
      out.push({ name: entry.name, path });
    }
  }
  return out;
}
