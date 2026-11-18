import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { bridgeStatus, detectLoader, installBridge, removeBridge } from '../lib/bridge.js';

function makeServer(root, loader) {
  mkdirSync(join(root, 'mods'), { recursive: true });
  writeFileSync(join(root, 'eula.txt'), 'eula=true\n');
  writeFileSync(join(root, 'server.properties'), 'online-mode=false\n');
  if (loader === 'fabric') {
    writeFileSync(join(root, 'fabric-server-launch.jar'), 'fake');
  } else if (loader === 'forge') {
    mkdirSync(join(root, 'libraries', 'net', 'minecraftforge', 'forge', '1.20.1-47.4.28'), { recursive: true });
  } else if (loader === 'neoforge') {
    mkdirSync(join(root, 'libraries', 'net', 'neoforged', 'neoforge', '21.1.0'), { recursive: true });
  } else if (loader === 'script') {
    writeFileSync(join(root, 'run.bat'), '@echo off\n');
  }
}

test('detectLoader recognizes fabric, forge, neoforge, script and vanilla', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-bridge-'));
  for (const loader of ['fabric', 'forge', 'neoforge', 'script', 'server']) {
    const dir = join(base, loader);
    mkdirSync(dir, { recursive: true });
    makeServer(dir, loader);
    const detected = detectLoader(dir);
    if (loader === 'script') {
      assert.equal(detected.loader, null, 'run script without loader libraries');
    } else {
      assert.equal(detected.loader, loader === 'server' ? 'vanilla' : loader);
    }
  }
  const forge = detectLoader(join(base, 'forge'));
  assert.equal(forge.mcVersion, '1.20.1');
});

test('bridgeStatus reports unsupported for Fabric and missing for unknown directories', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-bridge2-'));
  const fabric = join(base, 'fabric');
  mkdirSync(fabric, { recursive: true });
  makeServer(fabric, 'fabric');
  const status = bridgeStatus({ serverDir: fabric });
  assert.equal(status.loader, 'fabric');
  assert.equal(status.supported, false);
  assert.match(String(status.note), /Fabric/);

  const missing = join(base, 'missing');
  const missingStatus = bridgeStatus({ serverDir: missing });
  assert.equal(missingStatus.supported, false);
});

test('installBridge refuses unsupported servers and does not modify their mods', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-bridge3-'));
  const fabric = join(base, 'fabric');
  mkdirSync(fabric, { recursive: true });
  makeServer(fabric, 'fabric');
  assert.throws(() => installBridge({ serverDir: fabric }), /not supported/);
  assert.deepEqual(removeBridge({ serverDir: fabric }), { removed: false, installedPath: null });
});

test('bridgeStatus for a Forge 1.20.1 directory mentions the bundled jar state', () => {
  const base = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-bridge4-'));
  const forge = join(base, 'forge');
  mkdirSync(forge, { recursive: true });
  makeServer(forge, 'forge');
  const status = bridgeStatus({ serverDir: forge });
  assert.equal(status.loader, 'forge');
  assert.equal(status.supported, true);
  // The bundled jar may or may not exist while the repository is being built.
  assert.equal(typeof status.bundledJar === 'string' || status.bundledJar === null, true);
  assert.equal(status.installed, false);
});
