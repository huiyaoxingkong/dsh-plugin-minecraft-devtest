// Zero-dependency tests for lib/datapack.js (contract: docs/CONTRACTS.md).
// Run with: node --test test/datapack.test.mjs
//
// Every fixture is created under the OS temp directory; deploy tests use a fake
// serverDir only. Nothing here touches a running Minecraft server.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import test, { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  dataPackSupported,
  deployPack,
  findPacks,
  listDeployed,
  readServerPackVersion,
  scanPack,
  validatePack,
} from '../lib/datapack.js';
import { dataPackFormatForVersion } from '../lib/util.js';

const pluginRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const scratch = mkdtempSync(join(tmpdir(), 'dsh-mcdt-datapack-'));

// User's real multi-version test environment (all tests using it are skipped
// when it is absent). Read-only: nothing here writes into these directories.
const MW_SERVER_DIR = process.env.DSH_MW_SERVER_DIR || 'D:\\Minecraft\\数据包\\_mw_server';
const MW_VERSIONS = ['1.20.1', '1.20.6', '1.21.1', '1.21.11'];
const MW_RESOURCE_FORMATS = { '1.20.1': 15, '1.20.6': 32, '1.21.1': 34, '1.21.11': 75 };
// Vanilla server jars downloaded for version-table verification (1.13-26.3).
const VER_SERVERS_DIR = process.env.DSH_VER_SERVERS_DIR || 'D:\\Minecraft\\dsh-mc\\.tmp\\ver-servers';

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

// --- fixture helpers -------------------------------------------------------

function makeDir(prefix) {
  return mkdtempSync(join(scratch, `${String(prefix || 'case').replace(/[^\w.-]+/g, '_')}-`));
}

function writeFile(file, text) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, text, 'utf8');
  return file;
}

function writeJson(file, value) {
  return writeFile(file, JSON.stringify(value, null, 2));
}

function writePackMeta(dir, packFormat, description = 'Fixture pack') {
  return writeJson(join(dir, 'pack.mcmeta'), { pack: { pack_format: packFormat, description } });
}

// A realistic 1.20.1 multi-namespace pack (plural content folders, .mcfunction
// functions, .nbt structure). Counts: functions 3, recipes 2, lootTables 1,
// advancements 1, tags 1, jsonFiles 7.
function makeValidPack(prefix = 'valid') {
  const root = makeDir(prefix);
  writePackMeta(root, 15);
  const alpha = join(root, 'data', 'alpha');
  writeFile(join(alpha, 'functions', 'hello.mcfunction'), 'say hello\n');
  writeFile(join(alpha, 'functions', 'sub', 'nested.mcfunction'), 'say nested\n');
  writeJson(join(alpha, 'recipes', 'stick.json'), { type: 'minecraft:crafting_shaped' });
  writeJson(join(alpha, 'loot_tables', 'empty.json'), { pools: [] });
  writeJson(join(alpha, 'advancements', 'root.json'), { criteria: {} });
  writeJson(join(alpha, 'tags', 'blocks', 'dirt.json'), { values: ['minecraft:dirt'] });
  writeJson(join(alpha, 'predicates', 'always.json'), { condition: 'minecraft:value_check' });
  writeJson(join(alpha, 'item_modifiers', 'set_count.json'), { function: 'minecraft:set_count' });
  writeFile(join(alpha, 'structures', 'house.nbt'), 'not-really-nbt');
  const beta = join(root, 'data', 'beta');
  writeFile(join(beta, 'functions', 'welcome.mcfunction'), 'say welcome\n');
  writeJson(join(beta, 'recipes', 'torch.json'), { type: 'minecraft:crafting_shapeless' });
  return root;
}

// --- scanPack --------------------------------------------------------------

test('scanPack scans a valid multi-namespace 1.20.1 pack', () => {
  const root = makeValidPack('valid');
  const result = scanPack(root);

  assert.equal(result.ok, true);
  assert.equal(result.dir, resolve(root));
  assert.equal(result.name, basename(root));
  assert.equal(result.packFormat, 15);
  assert.equal(result.description, 'Fixture pack');
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(
    result.namespaces.map((namespace) => namespace.ns),
    ['alpha', 'beta'],
  );

  const alpha = result.namespaces[0];
  assert.deepEqual(alpha.functions, [
    'data/alpha/functions/hello.mcfunction',
    'data/alpha/functions/sub/nested.mcfunction',
  ]);
  assert.deepEqual(alpha.recipes, ['data/alpha/recipes/stick.json']);
  assert.deepEqual(alpha.lootTables, ['data/alpha/loot_tables/empty.json']);
  assert.deepEqual(alpha.advancements, ['data/alpha/advancements/root.json']);
  assert.deepEqual(alpha.tags, ['data/alpha/tags/blocks/dirt.json']);
  assert.deepEqual(alpha.predicates, ['data/alpha/predicates/always.json']);
  assert.deepEqual(alpha.itemModifiers, ['data/alpha/item_modifiers/set_count.json']);
  assert.deepEqual(alpha.structures, ['data/alpha/structures/house.nbt']);
  assert.deepEqual(alpha.dimensions, []);

  const beta = result.namespaces[1];
  assert.deepEqual(beta.functions, ['data/beta/functions/welcome.mcfunction']);
  assert.deepEqual(beta.recipes, ['data/beta/recipes/torch.json']);

  assert.deepEqual(result.counts, {
    functions: 3,
    recipes: 2,
    lootTables: 1,
    advancements: 1,
    tags: 1,
    jsonFiles: 7,
  });
});

test('scanPack understands singular 1.21-style content folders and merges both layouts', () => {
  const root = makeDir('singular');
  writePackMeta(root, 48);
  const namespace = join(root, 'data', 'demo');
  writeFile(join(namespace, 'function', 'main.mcfunction'), 'say main\n');
  writeFile(join(namespace, 'functions', 'legacy.mcfunction'), 'say legacy\n');
  writeJson(join(namespace, 'recipe', 'r.json'), { type: 'minecraft:crafting_shapeless' });
  writeJson(join(namespace, 'loot_table', 'l.json'), { pools: [] });
  writeJson(join(namespace, 'advancement', 'a.json'), { criteria: {} });
  writeJson(join(namespace, 'predicate', 'p.json'), { condition: 'minecraft:value_check' });
  writeJson(join(namespace, 'item_modifier', 'm.json'), { function: 'minecraft:set_count' });
  writeJson(join(namespace, 'dimension', 'd.json'), { type: 'minecraft:overworld' });
  writeFile(join(namespace, 'structure', 's.nbt'), 'not-really-nbt');

  const result = scanPack(root);
  assert.equal(result.ok, true);
  assert.equal(result.packFormat, 48);
  assert.deepEqual(result.namespaces[0].functions, [
    'data/demo/function/main.mcfunction',
    'data/demo/functions/legacy.mcfunction',
  ]);
  assert.equal(result.counts.functions, 2);
  assert.equal(result.counts.recipes, 1);
  assert.equal(result.counts.lootTables, 1);
  assert.equal(result.counts.advancements, 1);
  assert.equal(result.counts.tags, 0);
  assert.equal(result.counts.jsonFiles, 6);
});

test('scanPack reports a missing pack.mcmeta as an error but still scans data/', () => {
  const root = makeDir('nometa');
  writeFile(join(root, 'data', 'demo', 'functions', 'x.mcfunction'), 'say x\n');

  const result = scanPack(root);
  assert.equal(result.ok, false);
  assert.equal(result.packFormat, null);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0].file, /pack\.mcmeta$/i);
  assert.match(result.errors[0].message, /missing pack\.mcmeta/i);
  // data/ is still scanned so the report stays useful.
  assert.equal(result.namespaces.length, 1);
  assert.deepEqual(result.namespaces[0].functions, ['data/demo/functions/x.mcfunction']);
});

test('scanPack warns about a missing data/ directory (resource-pack style)', () => {
  const root = makeDir('resourceish');
  writePackMeta(root, 15);
  writeJson(join(root, 'assets', 'demo', 'lang', 'en_us.json'), {});

  const result = scanPack(root);
  assert.equal(result.ok, true);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0].message, /data\//);
  assert.deepEqual(result.namespaces, []);

  const validation = validatePack(root);
  assert.equal(validation.ok, true);
  assert.equal(validation.warnings.length, 1);
});

test('invalid JSON is an error that carries the offending file path', () => {
  const badMeta = makeDir('badmeta');
  writeFile(join(badMeta, 'pack.mcmeta'), '{ this is not json');
  writeFile(join(badMeta, 'data', 'demo', 'functions', 'x.mcfunction'), 'say x\n');
  const metaScan = scanPack(badMeta);
  assert.equal(metaScan.ok, false);
  assert.equal(metaScan.packFormat, null);
  assert.match(metaScan.errors[0].file, /pack\.mcmeta$/i);
  assert.match(metaScan.errors[0].message, /invalid JSON/i);

  const pack = makeValidPack('badcontent');
  const brokenFile = join(pack, 'data', 'alpha', 'recipes', 'broken.json');
  writeFile(brokenFile, '{ "type": "minecraft:crafting_shaped", ');
  const contentScan = scanPack(pack);
  assert.equal(contentScan.ok, false);
  assert.equal(contentScan.errors.length, 1);
  assert.equal(contentScan.errors[0].file, brokenFile);
  assert.match(contentScan.errors[0].message, /invalid JSON/i);

  // strictJson:false downgrades content JSON syntax errors to warnings.
  const lenient = validatePack(pack, { strictJson: false });
  assert.equal(lenient.ok, true);
  assert.equal(lenient.errors.length, 0);
  assert.ok(
    lenient.warnings.some((warning) => warning.file === brokenFile && /invalid JSON/i.test(warning.message)),
  );

  // Parseable JSON whose top level is not an object is only a warning.
  const loose = makeValidPack('loose');
  writeFile(join(loose, 'data', 'alpha', 'recipes', 'array.json'), '[]');
  const looseScan = scanPack(loose);
  assert.equal(looseScan.ok, true);
  assert.ok(
    looseScan.warnings.some(
      (warning) => warning.file.endsWith('array.json') && /not an object/i.test(warning.message),
    ),
  );
});

test('pack_format accepts a number or { resource, data } and rejects invalid values', () => {
  const cases = [
    { name: 'missing', pack: { description: 'x' }, pattern: /pack\.pack_format/i },
    { name: 'string', pack: { pack_format: '15' }, pattern: /must be a number/i },
    { name: 'object-without-data', pack: { pack_format: { resource: 34 } }, pattern: /"data"/ },
    { name: 'zero', pack: { pack_format: 0 }, pattern: /positive integer/i },
    { name: 'negative', pack: { pack_format: -3 }, pattern: /positive integer/i },
    { name: 'float', pack: { pack_format: 15.5 }, pattern: /positive integer/i },
    { name: 'array', pack: { pack_format: [15] }, pattern: /must be a number/i },
  ];
  for (const testCase of cases) {
    const root = makeDir(`format-${testCase.name}`);
    writeJson(join(root, 'pack.mcmeta'), { pack: testCase.pack });
    writeFile(join(root, 'data', 'demo', 'functions', 'x.mcfunction'), 'say x\n');
    const result = scanPack(root);
    assert.equal(result.ok, false, testCase.name);
    assert.equal(result.packFormat, null, testCase.name);
    assert.ok(
      result.errors.some((error) => testCase.pattern.test(error.message)),
      `${testCase.name}: ${JSON.stringify(result.errors)}`,
    );
  }

  const noPackObject = makeDir('no-pack-object');
  writeJson(join(noPackObject, 'pack.mcmeta'), { not_pack: true });
  const noPackScan = scanPack(noPackObject);
  assert.equal(noPackScan.ok, false);
  assert.ok(noPackScan.errors.some((error) => /"pack"/.test(error.message)));

  // 1.21.9+ object form: the data field is the data pack format.
  const modern = makeDir('format-object');
  writeJson(join(modern, 'pack.mcmeta'), {
    pack: { pack_format: { resource: 34, data: 48 }, description: { text: 'new style' } },
  });
  writeFile(join(modern, 'data', 'demo', 'functions', 'x.mcfunction'), 'say x\n');
  const modernScan = scanPack(modern);
  assert.equal(modernScan.ok, true);
  assert.equal(modernScan.packFormat, 48);
  assert.equal(modernScan.description, 'new style');
});

test('scanPack throws for a missing pack directory', () => {
  assert.throws(() => scanPack(join(scratch, 'does-not-exist')), /not found/i);
  assert.throws(() => validatePack(join(scratch, 'does-not-exist')), /not found/i);
});

// --- validatePack ----------------------------------------------------------

test('validatePack checks expectedFormat and explains both values and versions', () => {
  const root = makeValidPack('expected');

  const matched = validatePack(root, { expectedFormat: 15 });
  assert.equal(matched.ok, true);
  assert.equal(matched.packFormat, 15);
  assert.equal(matched.expectedFormat, 15);
  assert.equal(matched.counts.functions, 3);

  const mismatch = validatePack(root, { expectedFormat: 48 });
  assert.equal(mismatch.ok, false);
  const message = mismatch.errors.map((error) => error.message).join('\n');
  assert.match(message, /15\b/);
  assert.match(message, /48\b/);
  assert.match(message, /1\.21/); // 48 is the 1.21/1.21.1 data pack format
  assert.match(message, /1\.20/); // 15 is the 1.20/1.20.1 data pack format

  // Numeric strings are tolerated; unknown formats still compare numerically.
  assert.equal(validatePack(root, { expectedFormat: '15' }).ok, true);
  assert.equal(validatePack(root, { expectedFormat: 99 }).ok, false);
  assert.equal(validatePack(root).ok, true);
});

// --- findPacks -------------------------------------------------------------

test('findPacks finds outermost packs, respects maxDepth and skips node_modules/.git', () => {
  const root = makeDir('find');
  writePackMeta(join(root, 'packRoot'), 15);
  writeFile(join(root, 'group', 'packTwo', 'data', 'demo', 'functions', 'x.mcfunction'), 'say x\n');
  writePackMeta(join(root, 'level1', 'level2', 'level3', 'packThree'), 15);
  writePackMeta(join(root, 'level1', 'level2', 'level3', 'level4', 'packFour'), 15);
  writePackMeta(join(root, 'node_modules', 'skipPack'), 15);
  writePackMeta(join(root, '.git', 'skipGitPack'), 15);

  // Outer pack with data/ but no pack.mcmeta wins over a nested pack.mcmeta.
  const outer = join(root, 'outer');
  writeFile(join(outer, 'data', 'demo', 'functions', 'main.mcfunction'), 'say main\n');
  writePackMeta(join(outer, 'vendor', 'inner'), 15);
  // Regular outer pack with a nested pack.mcmeta must also only yield the outer dir.
  const outerNested = join(root, 'outer_nested');
  writePackMeta(outerNested, 15);
  writeFile(join(outerNested, 'data', 'demo', 'functions', 'main.mcfunction'), 'say main\n');
  writePackMeta(join(outerNested, 'nested_inner'), 15);

  const allNames = findPacks(root)
    .map((pack) => pack.name)
    .sort();
  assert.deepEqual(allNames, ['outer', 'outer_nested', 'packRoot', 'packThree', 'packTwo']);
  assert.ok(!allNames.includes('skipPack'));
  assert.ok(!allNames.includes('skipGitPack'));
  assert.ok(!allNames.some((name) => name.includes('inner')));

  const found = findPacks(root);
  assert.equal(found.find((pack) => pack.name === 'packRoot').packFormat, 15);
  assert.equal(found.find((pack) => pack.name === 'packTwo').packFormat, null);
  for (const pack of found) assert.ok(isAbsolute(pack.dir));

  assert.deepEqual(
    findPacks(root, { maxDepth: 1 })
      .map((pack) => pack.name)
      .sort(),
    ['outer', 'outer_nested', 'packRoot'],
  );
  assert.deepEqual(
    findPacks(root, { maxDepth: 2 })
      .map((pack) => pack.name)
      .sort(),
    ['outer', 'outer_nested', 'packRoot', 'packTwo'],
  );
  assert.ok(
    findPacks(root, { maxDepth: 5 })
      .map((pack) => pack.name)
      .includes('packFour'),
  );

  // The root itself can be a pack.
  const self = findPacks(join(root, 'packRoot'));
  assert.equal(self.length, 1);
  assert.equal(self[0].dir, resolve(join(root, 'packRoot')));
  assert.equal(self[0].packFormat, 15);

  assert.throws(() => findPacks(join(scratch, 'missing-root')), /not found/i);
});

test('findPacks tolerates an unreadable pack.mcmeta (packFormat null)', () => {
  const root = makeDir('find-badmeta');
  writeFile(join(root, 'broken', 'pack.mcmeta'), '{ nope');
  const found = findPacks(root);
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'broken');
  assert.equal(found[0].packFormat, null);
});

test('findPacks locates the bundled example pack under examples/datapacks', (t) => {
  const examplesDatapacks = join(pluginRoot, 'examples', 'datapacks');
  if (!existsSync(examplesDatapacks)) {
    t.skip('examples/datapacks is not present');
    return;
  }
  const found = findPacks(examplesDatapacks);
  const example = found.find((pack) => pack.name === 'hello_mcdevtest');
  assert.ok(example, JSON.stringify(found.map((pack) => pack.name)));
  assert.equal(example.packFormat, 15);
});

test('scanPack/validatePack accept the bundled 1.20.1 example pack', (t) => {
  const examplePack = join(pluginRoot, 'examples', 'datapacks', 'hello_mcdevtest');
  if (!existsSync(examplePack)) {
    t.skip('example pack is not present');
    return;
  }
  const scan = scanPack(examplePack);
  assert.equal(scan.ok, true, JSON.stringify(scan.errors));
  assert.equal(scan.packFormat, 15);
  assert.deepEqual(
    scan.namespaces.map((namespace) => namespace.ns).sort(),
    ['mcdevtest', 'minecraft'],
  );
  assert.equal(scan.counts.functions, 3);
  const validation = validatePack(examplePack, { expectedFormat: 15 });
  assert.equal(validation.ok, true);
});

// --- deployPack / listDeployed --------------------------------------------

test('deployPack copies into a fake server world and listDeployed sees it', async () => {
  const serverDir = makeDir('server');
  const source = makeValidPack('deploy-src');
  writeFile(join(source, '.git', 'config'), 'junk');
  writeFile(join(source, 'README.md'), 'copied as-is');

  const deployed = await deployPack(serverDir, source);
  const target = join(resolve(serverDir), 'world', 'datapacks', basename(source));
  assert.equal(deployed.deployed, true);
  assert.equal(deployed.target, target);
  assert.ok(isAbsolute(deployed.target));
  assert.equal(deployed.packDir, resolve(source));
  assert.ok(existsSync(join(target, 'pack.mcmeta')));
  assert.ok(existsSync(join(target, 'data', 'alpha', 'functions', 'hello.mcfunction')));
  assert.ok(existsSync(join(target, 'README.md')));
  assert.ok(!existsSync(join(target, '.git')), '.git must not be copied');
  assert.deepEqual(listDeployed(serverDir), [{ name: basename(source), path: target }]);

  // Redeploying replaces the old copy (stale files disappear).
  writeFile(join(target, 'stale.txt'), 'old');
  await deployPack(serverDir, source);
  assert.ok(!existsSync(join(target, 'stale.txt')));

  // Legacy zipped packs are listed too, in name order.
  writeFile(join(serverDir, 'world', 'datapacks', 'legacy.zip'), 'PK');
  assert.deepEqual(
    listDeployed(serverDir).map((entry) => entry.name),
    [basename(source), 'legacy.zip'].sort(),
  );

  // Custom level names are honoured.
  const custom = await deployPack(serverDir, source, { levelName: 'creative' });
  assert.equal(custom.target, join(resolve(serverDir), 'creative', 'datapacks', basename(source)));
  assert.ok(existsSync(join(custom.target, 'pack.mcmeta')));
  assert.deepEqual(listDeployed(serverDir, { levelName: 'creative' }), [
    { name: basename(source), path: custom.target },
  ]);

  // A server dir without a world returns an empty list instead of throwing.
  assert.deepEqual(listDeployed(makeDir('empty-server')), []);
});

test('deployPack rejects missing sources and overlapping targets', async () => {
  const serverDir = makeDir('server-guard');
  const source = makeValidPack('deploy-guard');
  const deployed = await deployPack(serverDir, source);

  await assert.rejects(() => deployPack(serverDir, deployed.target), /overlap/i);
  await assert.rejects(() => deployPack(serverDir, join(scratch, 'missing-pack')), /not found/i);
});

// --- readServerPackVersion -------------------------------------------------

function findJarExe() {
  const exe = process.platform === 'win32' ? 'jar.exe' : 'jar';
  const javaHome = process.env.JAVA_HOME;
  if (javaHome) {
    const candidate = join(javaHome, 'bin', exe);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Builds a tiny real jar with the given { memberPath: textContent } entries.
// Returns { jar, dir } where dir contains only that jar, or null without a JDK.
function makeJar(files, { jarName = 'server.jar' } = {}) {
  const exe = findJarExe();
  if (!exe) return null;
  const work = makeDir('jar-build');
  const stage = join(work, 'stage');
  for (const [name, content] of Object.entries(files)) writeFile(join(stage, name), content);
  const outDir = join(work, 'out');
  mkdirSync(outDir, { recursive: true });
  const jarPath = join(outDir, jarName);
  try {
    execFileSync(exe, ['cf', jarPath, '-C', stage, ...Object.keys(files)], { stdio: 'ignore' });
  } catch {
    return null;
  }
  return { jar: jarPath, dir: outDir };
}

test('readServerPackVersion reads version.json from synthetic jars and server dirs', async (t) => {
  const fixture = makeJar({
    'version.json': JSON.stringify({ id: '24w99a', name: 'synthetic', pack_version: { resource: 5, data: 9 } }),
  });
  if (!fixture) {
    t.skip('JDK jar tool is not available');
    return;
  }
  const expected = {
    version: '24w99a',
    dataFormat: 9,
    resourceFormat: 5,
    dataFormatMinor: null,
    resourceFormatMinor: null,
  };
  assert.deepEqual(await readServerPackVersion(fixture.jar), expected);
  // A server directory (or project run dir) resolves to its server.jar.
  assert.deepEqual(await readServerPackVersion(fixture.dir), expected);

  // Legacy shape: pack_version may be a plain number.
  const legacy = makeJar({ 'version.json': JSON.stringify({ id: '1.20.1', pack_version: 15 }) });
  assert.ok(legacy);
  assert.deepEqual(await readServerPackVersion(legacy.jar), {
    version: '1.20.1',
    dataFormat: 15,
    resourceFormat: 15,
    dataFormatMinor: null,
    resourceFormatMinor: null,
  });

  // 1.21.9+ shape: separate major/minor fields for data and resource formats.
  const modern = makeJar({
    'version.json': JSON.stringify({
      id: '1.21.11',
      pack_version: { resource_major: 75, resource_minor: 0, data_major: 94, data_minor: 1 },
    }),
  });
  assert.ok(modern);
  assert.deepEqual(await readServerPackVersion(modern.jar), {
    version: '1.21.11',
    dataFormat: 94,
    resourceFormat: 75,
    dataFormatMinor: 1,
    resourceFormatMinor: 0,
  });

  // Valid jar without version.json => null.
  const plain = makeJar({ 'hello.txt': 'hello' }, { jarName: 'plain.jar' });
  assert.ok(plain);
  assert.equal(await readServerPackVersion(plain.jar), null);

  // Ambiguous directory (more than one jar) => null rather than guessing.
  const ambiguous = makeDir('two-jars');
  copyFileSync(fixture.jar, join(ambiguous, 'a.jar'));
  copyFileSync(plain.jar, join(ambiguous, 'b.jar'));
  assert.equal(await readServerPackVersion(ambiguous), null);
});

test('readServerPackVersion returns null for unusable inputs', async () => {
  assert.equal(await readServerPackVersion(undefined), null);
  assert.equal(await readServerPackVersion(join(scratch, 'missing-jar')), null);
  const notAJar = writeFile(join(scratch, 'not-a-jar.jar'), 'this is not a zip archive');
  assert.equal(await readServerPackVersion(notAJar), null);
  assert.equal(await readServerPackVersion(join(scratch, 'not-a-jar.jar.txt')), null);
});

test('readServerPackVersion detects the real 1.20.1 server jar', async (t) => {
  const realJar = resolve(pluginRoot, '..', '.tmp', 'server-1.20.1', 'server.jar');
  if (!existsSync(realJar)) {
    t.skip('local 1.20.1 server.jar is not available');
    return;
  }
  const info = await readServerPackVersion(realJar);
  assert.ok(info, 'version.json should be readable from the real server jar');
  assert.equal(info.version, '1.20.1');
  assert.equal(info.dataFormat, 15);
  assert.equal(info.resourceFormat, 15);

  const fromServerDir = await readServerPackVersion(dirname(realJar));
  assert.ok(fromServerDir);
  assert.equal(fromServerDir.version, '1.20.1');
  assert.equal(fromServerDir.dataFormat, 15);
});

// --- multi-version detection (real user jars + fixtures) --------------------

test('readServerPackVersion matches dataPackFormatForVersion for the 4 real server jars', async (t) => {
  const missing = MW_VERSIONS.filter((version) => !existsSync(join(MW_SERVER_DIR, `server-${version}.jar`)));
  if (missing.length > 0) {
    t.skip(`user server jars not available: ${missing.join(', ')}`);
    return;
  }
  for (const version of MW_VERSIONS) {
    const info = await readServerPackVersion(join(MW_SERVER_DIR, `server-${version}.jar`));
    assert.ok(info, version);
    assert.equal(info.version, version);
    assert.equal(info.resourceFormat, MW_RESOURCE_FORMATS[version], version);
    assert.equal(info.dataFormat, dataPackFormatForVersion(version), `${version}: table must match version.json`);
    if (version === '1.21.11') {
      // 1.21.9+ version.json reports major/minor fields instead of data/resource.
      assert.equal(info.dataFormatMinor, 1);
      assert.equal(info.resourceFormatMinor, 0);
    } else {
      assert.equal(info.dataFormatMinor, null);
      assert.equal(info.resourceFormatMinor, null);
    }
  }
});

test('readServerPackVersion resolves vanilla install dirs and explicit jar overrides', async (t) => {
  const installs = MW_VERSIONS.filter(
    (version) => existsSync(join(MW_SERVER_DIR, version, 'versions')) && dataPackFormatForVersion(version) !== null,
  );
  if (installs.length === 0) {
    t.skip('user server install directories are not available');
    return;
  }
  for (const version of installs) {
    const installDir = join(MW_SERVER_DIR, version);
    const info = await readServerPackVersion(installDir);
    assert.ok(info, `${version}: install dir should resolve to versions/${version}/server-${version}.jar`);
    assert.equal(info.version, version);
    assert.equal(info.dataFormat, dataPackFormatForVersion(version));
    // The parent-directory jar (…\_mw_server\server-<version>.jar) can be passed explicitly.
    const parentJar = join(MW_SERVER_DIR, `server-${version}.jar`);
    if (existsSync(parentJar)) {
      const explicit = await readServerPackVersion(installDir, { jar: parentJar });
      assert.ok(explicit, version);
      assert.equal(explicit.dataFormat, dataPackFormatForVersion(version));
    }
  }
});

test('readServerPackVersion supports jar-outside-dir layouts and explicit jars (fixtures)', async (t) => {
  const fixture = makeJar(
    { 'version.json': JSON.stringify({ id: '1.20.1', pack_version: { resource: 15, data: 15 } }) },
    { jarName: 'server-1.20.1.jar' },
  );
  if (!fixture) {
    t.skip('JDK jar tool is not available');
    return;
  }
  const expected = {
    version: '1.20.1',
    dataFormat: 15,
    resourceFormat: 15,
    dataFormatMinor: null,
    resourceFormatMinor: null,
  };

  // Vanilla shape: install/1.20.1 only has libraries/ + versions/ (empty), while
  // the launch jar sits next to the install directory.
  const installParent = makeDir('vanilla-install');
  const installRoot = join(installParent, 'install');
  const runDir = join(installRoot, '1.20.1');
  mkdirSync(join(runDir, 'libraries'), { recursive: true });
  mkdirSync(join(runDir, 'versions'), { recursive: true });
  copyFileSync(fixture.jar, join(installRoot, 'server-1.20.1.jar'));
  assert.deepEqual(await readServerPackVersion(runDir), expected); // parent-dir jar detected
  assert.deepEqual(await readServerPackVersion(runDir, { jar: fixture.jar }), expected); // explicit jar option
  assert.deepEqual(await readServerPackVersion(runDir, fixture.jar), expected); // explicit jar as 2nd arg
  assert.equal(await readServerPackVersion(join(runDir, 'libraries')), null); // dir without jars
  assert.equal(await readServerPackVersion(runDir, { jar: join(scratch, 'missing.jar') }), null);

  // Unpacked vanilla install shape: versions/<version>/server-<version>.jar.
  const versionsInstall = join(makeDir('vanilla-versions'), '1.20.1');
  const versionJarDir = join(versionsInstall, 'versions', '1.20.1');
  mkdirSync(versionJarDir, { recursive: true });
  copyFileSync(fixture.jar, join(versionJarDir, 'server-1.20.1.jar'));
  assert.deepEqual(await readServerPackVersion(versionsInstall), expected);
});

test('scanPack/validatePack understand 1.21.9+ min_format / max_format pack.mcmeta', () => {
  const modern = makeDir('modern-format');
  writeJson(join(modern, 'pack.mcmeta'), { pack: { description: 'modern', min_format: 71, max_format: [94, 1] } });
  writeFile(join(modern, 'data', 'demo', 'functions', 'main.mcfunction'), 'say hi\n');
  const scan = scanPack(modern);
  assert.equal(scan.ok, true, JSON.stringify(scan.errors));
  assert.equal(scan.packFormat, 94);
  assert.deepEqual(scan.packFormatRange, { min: 71, max: 94 });
  assert.equal(validatePack(modern, { expectedFormat: 94 }).ok, true);
  assert.equal(validatePack(modern, { expectedFormat: 71 }).ok, true);
  const mismatch = validatePack(modern, { expectedFormat: 48 });
  assert.equal(mismatch.ok, false);
  const message = mismatch.errors.map((error) => error.message).join('\n');
  assert.match(message, /48/);
  assert.match(message, /71/);
  assert.match(message, /94/);
  assert.match(message, /1\.21\.5/);
  assert.match(message, /1\.21\.11/);

  // pack_format plus min/max: the declared range is authoritative for expectedFormat.
  const both = makeDir('modern-format-both');
  writeJson(join(both, 'pack.mcmeta'), {
    pack: { pack_format: 94, min_format: 71, max_format: [94, 1], description: 'both' },
  });
  writeFile(join(both, 'data', 'demo', 'functions', 'main.mcfunction'), 'say hi\n');
  assert.equal(scanPack(both).packFormat, 94);
  assert.equal(validatePack(both, { expectedFormat: 71 }).ok, true);
  assert.equal(validatePack(both, { expectedFormat: 48 }).ok, false);

  // Number-only min/max form (minor 0 omitted).
  const numbers = makeDir('modern-format-numbers');
  writeJson(join(numbers, 'pack.mcmeta'), { pack: { min_format: 88, max_format: 94 } });
  writeFile(join(numbers, 'data', 'demo', 'functions', 'main.mcfunction'), 'say hi\n');
  const numberScan = scanPack(numbers);
  assert.equal(numberScan.ok, true);
  assert.equal(numberScan.packFormat, 94);
  assert.deepEqual(numberScan.packFormatRange, { min: 88, max: 94 });

  // Invalid tokens / reversed range are errors.
  const invalid = makeDir('modern-format-invalid');
  writeJson(join(invalid, 'pack.mcmeta'), { pack: { min_format: '71', max_format: [94] } });
  writeFile(join(invalid, 'data', 'demo', 'functions', 'main.mcfunction'), 'say hi\n');
  const invalidScan = scanPack(invalid);
  assert.equal(invalidScan.ok, false);
  assert.ok(invalidScan.errors.some((error) => /min_format/.test(error.message)));
  const reversed = makeDir('modern-format-reversed');
  writeJson(join(reversed, 'pack.mcmeta'), { pack: { min_format: 94, max_format: 71 } });
  const reversedScan = scanPack(reversed);
  assert.equal(reversedScan.ok, false);
  assert.ok(reversedScan.errors.some((error) => /greater than/.test(error.message)));
});

test('scanPack/validatePack handle the user multi-version zz_verify packs', (t) => {
  const available = MW_VERSIONS.filter(
    (version) => dataPackFormatForVersion(version) !== null && existsSync(join(MW_SERVER_DIR, version, 'world', 'datapacks', 'zz_verify')),
  );
  if (available.length === 0) {
    t.skip('user datapacks are not available');
    return;
  }
  for (const version of available) {
    const dir = join(MW_SERVER_DIR, version, 'world', 'datapacks', 'zz_verify');
    const scan = scanPack(dir);
    assert.equal(scan.ok, true, `${version}: ${JSON.stringify(scan.errors)}`);
    assert.equal(scan.packFormat, dataPackFormatForVersion(version), version);
    assert.ok(
      scan.namespaces.some((namespace) => namespace.ns === 'zz_verify' && namespace.functions.length > 0),
      version,
    );
    const validation = validatePack(dir, { expectedFormat: dataPackFormatForVersion(version) });
    assert.equal(validation.ok, true, `${version}: ${JSON.stringify(validation.errors)}`);
  }
});

// --- pre-1.13 data packs + real 1.13-26.3 version jars ----------------------

test('dataPackSupported is exposed and knows the 1.13 data pack boundary', () => {
  assert.equal(dataPackSupported('1.13'), true);
  assert.equal(dataPackSupported('1.13.2'), true);
  assert.equal(dataPackSupported('1.18.2'), true);
  assert.equal(dataPackSupported('26.3'), true);
  assert.equal(dataPackSupported('1.12.2'), false);
  assert.equal(dataPackSupported('1.7.10'), false);
  assert.equal(dataPackSupported(''), false);
  assert.equal(dataPackSupported(undefined), false);
});

test('scanPack/validatePack flag pre-1.13 targets as unsupported instead of broken', () => {
  const dir = makeDir('pre-113');
  writeFile(join(dir, 'data', 'demo', 'functions', 'main.mcfunction'), 'say hi\n');

  // Without a target version this still looks like a broken data pack.
  const blind = scanPack(dir);
  assert.equal(blind.ok, false);
  assert.equal(blind.dataPackSupported, null);
  assert.ok(blind.errors.some((error) => /missing pack\.mcmeta/i.test(error.message)));

  // With Minecraft 1.12.2 the directory is simply a pre-data-pack tree.
  const legacy = scanPack(dir, { version: '1.12.2' });
  assert.equal(legacy.ok, true, JSON.stringify(legacy.errors));
  assert.equal(legacy.version, '1.12.2');
  assert.equal(legacy.dataPackSupported, false);
  assert.ok(legacy.warnings.some((warning) => /no data pack support/i.test(warning.message)));
  assert.ok(!legacy.errors.some((error) => /missing pack\.mcmeta/i.test(error.message)));

  // validatePack: no format-mismatch error against an unsupported target.
  const validation = validatePack(dir, { version: '1.12.2', expectedFormat: 15 });
  assert.equal(validation.ok, true);
  assert.equal(validation.dataPackSupported, false);
  assert.equal(validation.packFormat, null);
  assert.ok(validation.warnings.some((warning) => /no data pack support/i.test(warning.message)));
  assert.ok(validation.warnings.some((warning) => /expectedFormat 15 ignored/i.test(warning.message)));

  // A supported target keeps the normal behaviour: missing pack.mcmeta is an error.
  const modern = validatePack(dir, { version: '1.20.1' });
  assert.equal(modern.dataPackSupported, true);
  assert.equal(modern.ok, false);
  assert.ok(modern.errors.some((error) => /missing pack\.mcmeta/i.test(error.message)));
});

test('readServerPackVersion returns null for a version.json without pack_version', async (t) => {
  const fixture = makeJar({ 'version.json': JSON.stringify({ id: '1.12.2', name: '1.12.2' }) });
  if (!fixture) {
    t.skip('JDK jar tool is not available');
    return;
  }
  assert.equal(await readServerPackVersion(fixture.jar), null);
});

// Returns true/false when the jar is readable, null when the JDK jar tool is missing.
function jarHasEntry(jarPath, entryName) {
  const exe = findJarExe();
  if (!exe) return null;
  try {
    const listing = execFileSync(exe, ['tf', jarPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    });
    return String(listing)
      .split(/\r?\n/)
      .some((line) => line.trim() === entryName);
  } catch {
    return null; // unreadable/partial jar
  }
}

test('real version jars in .tmp/ver-servers match lib/versions.js pack formats', async (t) => {
  if (!existsSync(VER_SERVERS_DIR)) {
    t.skip(`version server jars are not downloaded (${VER_SERVERS_DIR})`);
    return;
  }
  const versionsAvailable = readdirSync(VER_SERVERS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((version) => existsSync(join(VER_SERVERS_DIR, version, 'server.jar')))
    .sort((left, right) => left.localeCompare(right));
  if (versionsAvailable.length === 0) {
    t.skip('no version server jars downloaded');
    return;
  }
  const checked = [];
  for (const version of versionsAvailable) {
    const jarPath = join(VER_SERVERS_DIR, version, 'server.jar');
    const hasVersionJson = jarHasEntry(jarPath, 'version.json');
    if (hasVersionJson === null) continue; // missing JDK / partial jar
    const info = await readServerPackVersion(jarPath);
    if (!hasVersionJson) {
      // 1.7.10/1.12.2/1.13.2 jars predate version.json: return null, do not guess.
      assert.equal(info, null, `${version}: jar without version.json must yield null`);
      checked.push(`${version}:old-jar-null`);
      continue;
    }
    assert.ok(info, `${version}: version.json should be readable`);
    assert.equal(info.version, version);
    const tableFormat = dataPackFormatForVersion(version);
    assert.notEqual(tableFormat, null, `${version}: lib/versions.js should know this release`);
    assert.equal(
      info.dataFormat,
      tableFormat,
      `${version}: version.json pack_version must match lib/versions.js`,
    );
    checked.push(`${version}:${info.dataFormat}`);
  }
  if (checked.length === 0) {
    t.skip('no readable version server jars (JDK jar tool missing or downloads unfinished)');
    return;
  }
  assert.ok(checked.length >= 1, `expected at least one readable version jar, checked ${checked.join(', ')}`);
});
