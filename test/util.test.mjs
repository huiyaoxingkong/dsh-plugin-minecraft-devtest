// Zero-dependency tests for lib/util.js (contract: docs/CONTRACTS.md).
// Run with: node --test test/util.test.mjs
//
// Real-log tests use the user's multi-version test environment when present and
// are skipped otherwise; nothing here writes to the file system.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { dataPackFormatForVersion, parseMinecraftLog, parsePackFormatMap } from '../lib/util.js';
import { RELEASES } from '../lib/versions.js';

const MW_SERVER_DIR = process.env.DSH_MW_SERVER_DIR || 'D:\\Minecraft\\数据包\\_mw_server';

function readLogIfPresent(path) {
  if (!existsSync(path)) return null;
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

// --- parseMinecraftLog: version + loader -----------------------------------

test('parseMinecraftLog detects the vanilla start line', () => {
  const parsed = parseMinecraftLog('[00:26:41] [Server thread/INFO]: Starting minecraft server version 1.20.1');
  assert.equal(parsed.version, '1.20.1');
  assert.equal(parsed.loader, 'vanilla');
});

test('parseMinecraftLog detects Fabric from the Loading Minecraft line', () => {
  const parsed = parseMinecraftLog(
    '[18:26:06] [main/INFO]: Loading Minecraft 1.20.1 with Fabric Loader 0.19.5\n' +
      '[18:26:06] [main/INFO]: Loading 45 mods: fabric-api 0.92.12',
  );
  assert.equal(parsed.version, '1.20.1');
  assert.equal(parsed.loader, 'fabric');
});

test('parseMinecraftLog detects Forge from MinecraftForge markers', () => {
  const parsed = parseMinecraftLog(
    'ModLauncher running: args [--launchTarget, forgeserver, --fml.mcVersion, 1.20.1]\n' +
      'net.minecraftforge.fml.loading.FMLLoader\n' +
      '[18:36:50] [Server thread/INFO] [minecraft/DedicatedServer]: Starting minecraft server version 1.20.1',
  );
  assert.equal(parsed.version, '1.20.1');
  assert.equal(parsed.loader, 'forge');
});

test('parseMinecraftLog prefers NeoForge over Forge', () => {
  const parsed = parseMinecraftLog(
    'NeoForge version 21.1.66 for Minecraft 1.21.1\n' +
      'net.neoforged.neoforge.common.NeoForge\n' +
      'Compatibility shim for MinecraftForge mods enabled\n' +
      'Starting minecraft server version 1.21.1',
  );
  assert.equal(parsed.version, '1.21.1');
  assert.equal(parsed.loader, 'neoforge');
});

test('parseMinecraftLog prefers Purpur over Paper', () => {
  const parsed = parseMinecraftLog(
    'This server is running Purpur version git-Purpur-2062 (MC: 1.20.1) (Implementing API version 1.20.1-R0.1-SNAPSHOT)\n' +
      'This server is running Paper version 1.20.1\n' +
      'Starting minecraft server version 1.20.1',
  );
  assert.equal(parsed.version, '1.20.1');
  assert.equal(parsed.loader, 'purpur');
});

test('parseMinecraftLog detects Paper', () => {
  const parsed = parseMinecraftLog(
    'This server is running Paper version 1.21.1-local-SNAPSHOT (Implementing API version 1.21.1-R0.1-SNAPSHOT)\n' +
      'Starting minecraft server version 1.21.1',
  );
  assert.equal(parsed.version, '1.21.1');
  assert.equal(parsed.loader, 'paper');
});

test('parseMinecraftLog prefers Quilt over Fabric Loader mentions', () => {
  const parsed = parseMinecraftLog(
    '[main/INFO]: Loading Minecraft 1.21.1 with Quilt Loader 0.27.0\n' +
      '[main/INFO]: Quilt is compatible with Fabric Loader mods',
  );
  assert.equal(parsed.version, '1.21.1');
  assert.equal(parsed.loader, 'quilt');
});

test('parseMinecraftLog does not invent a loader from unrelated mod names or chat', () => {
  const parsed = parseMinecraftLog('mods list: fabric-api, fabric-carpet\n[Server thread/INFO]: Done (3.2s)!');
  assert.equal(parsed.version, null);
  assert.equal(parsed.loader, null);

  const chatty = parseMinecraftLog(
    'Starting minecraft server version 1.20.1\n' +
      '[Server thread/INFO]: <Steve> did you update forge and paper yesterday?\n' +
      '[Server thread/INFO]: <Alex> quilt is nice too',
  );
  assert.equal(chatty.version, '1.20.1');
  assert.equal(chatty.loader, 'vanilla');
});

test('parseMinecraftLog keeps error/warning extraction', () => {
  const parsed = parseMinecraftLog(
    'Starting minecraft server version 1.20.1\n' +
      '[Server thread/ERROR]: Failed to load datapack file\n' +
      '[Server thread/WARN]: something odd happened',
  );
  assert.equal(parsed.errors.length, 1);
  assert.match(parsed.errors[0], /Failed to load datapack/);
  assert.equal(parsed.warnings.length, 1);
  assert.match(parsed.warnings[0], /something odd/);
});

test('parseMinecraftLog detects real user logs when available', (t) => {
  const vanillaLog = readLogIfPresent(join(MW_SERVER_DIR, '1.20.1', 'stdout.txt'));
  const fabricLog = readLogIfPresent(join(MW_SERVER_DIR, 'fp-1.20.1', 'stdout.txt'));
  const forgeLog = readLogIfPresent(join(MW_SERVER_DIR, 'forge-1.20.1', 'console-out.txt'));
  if (!vanillaLog && !fabricLog && !forgeLog) {
    t.skip('user server logs are not available');
    return;
  }
  if (vanillaLog) {
    const parsed = parseMinecraftLog(vanillaLog);
    assert.equal(parsed.version, '1.20.1');
    assert.equal(parsed.loader, 'vanilla');
  }
  if (fabricLog) {
    const parsed = parseMinecraftLog(fabricLog);
    assert.equal(parsed.version, '1.20.1');
    assert.equal(parsed.loader, 'fabric');
  }
  if (forgeLog) {
    const parsed = parseMinecraftLog(forgeLog);
    assert.equal(parsed.version, '1.20.1');
    assert.equal(parsed.loader, 'forge');
  }
});

// --- data pack format table (lib/versions.js is the single source of truth) ---

test('dataPackFormatForVersion maps 1.13-1.21.11 and the 2026 releases', () => {
  const expected = {
    // Data packs were introduced in 1.13.
    '1.13': 4,
    '1.13.1': 4,
    '1.13.2': 4,
    '1.14': 4,
    '1.14.4': 4,
    '1.15': 5,
    '1.15.2': 5,
    '1.16': 5,
    '1.16.1': 5,
    '1.16.2': 6,
    '1.16.5': 6,
    '1.17': 7,
    '1.17.1': 7,
    '1.18': 8,
    '1.18.1': 8,
    '1.18.2': 9,
    '1.19': 10,
    '1.19.1': 10,
    '1.19.2': 10,
    '1.19.3': 10,
    '1.19.4': 12,
    '1.20': 15,
    '1.20.1': 15,
    '1.20.2': 18,
    '1.20.3': 26,
    '1.20.4': 26,
    '1.20.5': 41,
    '1.20.6': 41,
    '1.21': 48,
    '1.21.1': 48,
    '1.21.2': 57,
    '1.21.3': 57,
    '1.21.4': 61,
    '1.21.5': 71,
    '1.21.6': 80,
    '1.21.7': 81,
    '1.21.8': 81,
    '1.21.9': 88,
    '1.21.10': 88,
    '1.21.11': 94,
    '26.1': 101,
    '26.1.1': 101,
    '26.1.2': 101,
    '26.2': 107,
    '26.3': 121,
  };
  for (const [version, format] of Object.entries(expected)) {
    assert.equal(dataPackFormatForVersion(version), format, version);
  }
});

test('dataPackFormatForVersion is single-sourced from lib/versions.js', () => {
  assert.ok(RELEASES.length >= 70, `expected 76 releases, got ${RELEASES.length}`);
  for (const release of RELEASES) {
    assert.equal(dataPackFormatForVersion(release.id), release.packFormat, release.id);
  }
  // Every release with a format appears in parsePackFormatMap; pre-1.13 do not.
  const map = parsePackFormatMap();
  for (const release of RELEASES) {
    if (release.packFormat === null) {
      assert.equal(Object.hasOwn(map, release.id), false, release.id);
    } else {
      assert.equal(map[release.id], release.packFormat, release.id);
    }
  }
  // 26.4 is announced but not released yet, so it stays unmapped.
  assert.equal(dataPackFormatForVersion('26.4'), null);
});

test('dataPackFormatForVersion handles pre-1.13, snapshots and build metadata', () => {
  // Known pre-1.13 releases: data packs did not exist yet.
  assert.equal(dataPackFormatForVersion('1.12.2'), null);
  assert.equal(dataPackFormatForVersion('1.7.10'), null);
  // Snapshots and pre-releases may use a different format, so they stay unmapped.
  assert.equal(dataPackFormatForVersion('1.21.5-pre1'), null);
  assert.equal(dataPackFormatForVersion('1.21.11-rc1'), null);
  assert.equal(dataPackFormatForVersion('24w14a'), null);
  assert.equal(dataPackFormatForVersion('1.6.4'), null);
  assert.equal(dataPackFormatForVersion('nonsense'), null);
  assert.equal(dataPackFormatForVersion(''), null);
  assert.equal(dataPackFormatForVersion('   '), null);
  assert.equal(dataPackFormatForVersion(null), null);
  assert.equal(dataPackFormatForVersion(undefined), null);
  // Whitespace / build metadata tolerance.
  assert.equal(dataPackFormatForVersion(' 1.21.11 '), 94);
  assert.equal(dataPackFormatForVersion('1.20.1+build.7'), 15);
});

test('parsePackFormatMap returns a defensive copy with all data-pack releases', () => {
  const map = parsePackFormatMap();
  assert.equal(map['1.13'], 4);
  assert.equal(map['1.18.2'], 9);
  assert.equal(map['1.19.3'], 10);
  assert.equal(map['1.19.4'], 12);
  assert.equal(map['1.21.11'], 94);
  assert.equal(Object.hasOwn(map, '1.12.2'), false);
  map['1.21.11'] = 1;
  map['1.20.1'] = 999;
  assert.equal(dataPackFormatForVersion('1.21.11'), 94);
  assert.equal(dataPackFormatForVersion('1.20.1'), 15);
});
