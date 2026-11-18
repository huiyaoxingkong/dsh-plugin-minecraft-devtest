import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { initProject } from '../lib/init.js';

function makeDatapack(root) {
  mkdirSync(join(root, 'data', 'demo', 'recipes'), { recursive: true });
  mkdirSync(join(root, 'data', 'demo', 'loot_tables', 'blocks'), { recursive: true });
  mkdirSync(join(root, 'data', 'demo', 'functions'), { recursive: true });
  writeFileSync(join(root, 'pack.mcmeta'), JSON.stringify({ pack: { pack_format: 15, description: 'fixture' } }));
  writeFileSync(
    join(root, 'data', 'demo', 'recipes', 'stone.json'),
    JSON.stringify({ type: 'minecraft:crafting_shapeless', ingredients: [{ item: 'minecraft:stone' }], result: { item: 'minecraft:stone_button' } }),
  );
  writeFileSync(
    join(root, 'data', 'demo', 'loot_tables', 'blocks', 'demo_block.json'),
    JSON.stringify({ type: 'minecraft:block', pools: [] }),
  );
  writeFileSync(join(root, 'data', 'demo', 'functions', 'hello.mcfunction'), 'say hi\n');
}

test('initProject writes a generated datapack card with safe checks', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-init-'));
  const packDir = join(root, 'my-pack');
  mkdirSync(packDir, { recursive: true });
  makeDatapack(packDir);
  const result = initProject({ projectDir: packDir, username: 'InitBot' });
  assert.equal(result.ok, true);
  assert.equal(result.projectType, 'datapack');
  const cardPath = result.files.find((file) => file.endsWith('S-100-generated-smoke.yml'));
  assert.ok(cardPath);
  const card = readFileSync(cardPath, 'utf8');
  assert.match(card, /id: S-100/);
  assert.match(card, /type: datapack/);
  assert.match(card, /dir: "\.\."/);
  assert.match(card, /recipe give InitBot demo:stone/);
  assert.match(card, /loot give InitBot loot demo:blocks\/demo_block/);
  assert.match(card, /type: bot/);
  const readme = result.files.find((file) => file.endsWith('README.md'));
  assert.ok(existsSync(readme));
});

test('initProject refuses to overwrite an existing card unless overwrite=true', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-init2-'));
  const packDir = join(root, 'pack');
  mkdirSync(packDir, { recursive: true });
  makeDatapack(packDir);
  const first = initProject({ projectDir: packDir });
  assert.equal(first.ok, true);
  assert.throws(() => initProject({ projectDir: packDir }), /already exists/);
  const second = initProject({ projectDir: packDir, overwrite: true });
  assert.equal(second.ok, true);
});

test('initProject generates a build-only card for a gradle project', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-init3-'));
  const projectDir = join(root, 'mod');
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, 'build.gradle'), 'plugins { id "java" }\n');
  writeFileSync(join(projectDir, 'settings.gradle'), 'rootProject.name = "mod"\n');
  const result = initProject({ projectDir });
  assert.equal(result.ok, true);
  assert.equal(result.projectType, 'gradle');
  const card = readFileSync(result.files.find((file) => file.endsWith('S-100-generated-smoke.yml')), 'utf8');
  assert.match(card, /type: gradle/);
  assert.match(card, /task: build/);
});
