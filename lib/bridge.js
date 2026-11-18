import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BRIDGE_ROOT = join(PLUGIN_ROOT, 'vendor', 'forge-bridge');
const BRIDGE_PREFIX = 'dsh-test-bridge-';

function listDirs(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch {
    return [];
  }
}

function firstVersion(text) {
  const match = /(\d+\.\d+(?:\.\d+)?)/.exec(String(text ?? ''));
  return match ? match[1] : null;
}

function readForgeVersion(serverDir) {
  const base = join(serverDir, 'libraries', 'net', 'minecraftforge', 'forge');
  for (const name of listDirs(base)) {
    const match = /^(\d+\.\d+(?:\.\d+)?)-(.+)$/.exec(name);
    if (match) return { mcVersion: match[1], forgeVersion: match[2], dirName: name };
  }
  return null;
}

function readNeoForgeVersion(serverDir) {
  const base = join(serverDir, 'libraries', 'net', 'neoforged', 'neoforge');
  for (const name of listDirs(base)) {
    const parsed = firstVersion(name);
    if (parsed) return { mcVersion: parsed, neoforgeVersion: name };
  }
  return null;
}

/**
 * Detect the server loader and Minecraft version from an installed server directory,
 * without starting the server. Purely file based; returns nulls when unknown.
 */
export function detectLoader(serverDir) {
  const dir = resolve(String(serverDir ?? '.'));
  if (!existsSync(dir)) return { loader: null, mcVersion: null, detail: 'server directory does not exist' };
  if (existsSync(join(dir, 'fabric-server-launch.jar'))) {
    return { loader: 'fabric', mcVersion: null, detail: 'fabric-server-launch.jar' };
  }
  if (existsSync(join(dir, 'libraries', 'net', 'neoforged'))) {
    const neoforge = readNeoForgeVersion(dir);
    return { loader: 'neoforge', mcVersion: neoforge?.mcVersion ?? null, detail: 'libraries/net/neoforged' };
  }
  if (existsSync(join(dir, 'libraries', 'net', 'minecraftforge'))) {
    const forge = readForgeVersion(dir);
    return {
      loader: 'forge',
      mcVersion: forge?.mcVersion ?? null,
      forgeVersion: forge?.forgeVersion ?? null,
      detail: 'libraries/net/minecraftforge',
    };
  }
  if (existsSync(join(dir, 'run.bat')) || existsSync(join(dir, 'run.sh'))) {
    return { loader: null, mcVersion: null, detail: 'run script without loader libraries' };
  }
  if (existsSync(join(dir, 'server.properties')) || existsSync(join(dir, 'server.jar'))) {
    return { loader: 'vanilla', mcVersion: null, detail: 'server.properties/server.jar' };
  }
  return { loader: null, mcVersion: null, detail: 'unrecognized server directory' };
}

function bundledJarFor(loader, mcVersion) {
  if (!loader || !mcVersion) return null;
  const candidates = [
    join(BRIDGE_ROOT, `${mcVersion}`),
    join(BRIDGE_ROOT, `${loader}-${mcVersion}`),
    join(BRIDGE_ROOT, loader, mcVersion),
    join(BRIDGE_ROOT, loader),
  ];
  for (const dir of candidates) {
    if (!existsSync(dir)) continue;
    let names = [];
    try {
      names = readdirSync(dir).filter((name) => name.startsWith(BRIDGE_PREFIX) && name.endsWith('.jar'));
    } catch {
      continue;
    }
    if (names.length > 0) return join(dir, names[0]);
  }
  return null;
}

function bridgeSupported(loader, mcVersion) {
  return loader === 'forge' && String(mcVersion ?? '').startsWith('1.20.1');
}

function installedBridge(serverDir) {
  const modsDir = join(serverDir, 'mods');
  try {
    const names = readdirSync(modsDir).filter((name) => name.startsWith(BRIDGE_PREFIX) && name.endsWith('.jar'));
    return names.length > 0 ? join(modsDir, names[0]) : null;
  } catch {
    return null;
  }
}

/**
 * Report whether the bundled test bridge can / is installed for this server directory.
 */
export function bridgeStatus({ serverDir } = {}) {
  const dir = resolve(String(serverDir ?? '.'));
  const detected = detectLoader(dir);
  const supported = bridgeSupported(detected.loader, detected.mcVersion);
  const bundledJar = supported ? bundledJarFor(detected.loader, detected.mcVersion) : null;
  const installed = installedBridge(dir);
  let reason = null;
  if (!supported) {
    reason =
      detected.loader === 'fabric'
        ? 'Fabric servers accept the vanilla-protocol bot directly; no bridge mod needed'
        : detected.loader === 'forge' || detected.loader === 'neoforge'
          ? `bundled bridge currently supports Forge 1.20.1 only (detected ${detected.loader} ${detected.mcVersion ?? 'unknown'})`
          : 'loader not recognized';
  } else if (!bundledJar) {
    reason = `bundled bridge jar for Forge ${detected.mcVersion} is missing from vendor/forge-bridge`;
  }
  return {
    serverDir: dir,
    loader: detected.loader,
    mcVersion: detected.mcVersion,
    detail: detected.detail,
    supported,
    bundledJar,
    installed: !!installed,
    installedPath: installed,
    note: reason,
  };
}

/**
 * Copy the bundled bridge jar into <serverDir>/mods. A different existing bridge jar is
 * backed up first. Only Forge 1.20.1 is supported; other loaders return an error object.
 */
export function installBridge({ serverDir } = {}) {
  const status = bridgeStatus({ serverDir });
  if (!status.supported) throw new Error(`test bridge not supported for this server: ${status.note}`);
  if (!status.bundledJar) throw new Error(`test bridge jar missing: ${status.note}`);
  const modsDir = join(status.serverDir, 'mods');
  mkdirSync(modsDir, { recursive: true });
  const targetName = status.bundledJar.split(/[\\/]/).pop();
  const target = join(modsDir, targetName);
  let backup = null;
  if (existsSync(target)) {
    const same = statSync(target).size === statSync(status.bundledJar).size;
    if (same) return { ...status, installed: true, installedPath: target, changed: false };
    backup = `${target}.bak-${Date.now()}`;
    renameSync(target, backup);
  }
  copyFileSync(status.bundledJar, target);
  return { ...bridgeStatus({ serverDir: status.serverDir }), installed: true, installedPath: target, changed: true, backup };
}

/**
 * Remove only bridge jars previously installed by this plugin (prefix dsh-test-bridge-).
 */
export function removeBridge({ serverDir } = {}) {
  const dir = resolve(String(serverDir ?? '.'));
  const installed = installedBridge(dir);
  if (!installed) return { removed: false, installedPath: null };
  rmSync(installed, { force: true });
  return { removed: true, installedPath: installed };
}
