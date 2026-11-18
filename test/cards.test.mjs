/**
 * Tests for lib/cards.js — deterministic YAML test cards.
 *
 * Zero external dependencies; everything runs against a mock api (no real Minecraft
 * server, no mineflayer). Run with:
 *   cd minecraft-devtest && node --test test/cards.test.mjs
 */

import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, describe, it } from 'node:test';

import {
  cardToSteps,
  normalizeCard,
  parseCardFile,
  parseYaml,
  runCardFile,
  runSteps,
  runSuite,
} from '../lib/cards.js';

const TEST_DIR = import.meta.dirname;
const EXAMPLES_DIR = resolve(TEST_DIR, '..', 'examples', 'cards');

const tempDirs = [];

function makeTempDir(label = 'cards') {
  const dir = mkdtempSync(join(tmpdir(), `mcdt-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeText(dir, name, text) {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, text, 'utf8');
  return file;
}

after(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Mock api
// ---------------------------------------------------------------------------

const DEFAULT_HANDLERS = {
  command: (cmd) => ({ response: `OK: ${cmd}`, ms: 1 }),
  bot: (action, params = {}) => ({ action, params }),
  datapack: (action, params = {}) => ({ action, params }),
  gradle: (task) => ({ task, exitCode: 0, summary: 'BUILD SUCCESSFUL' }),
  serverStatus: () => ({ active: true, ready: true }),
  botState: () => ({ connected: true }),
  sleep: () => undefined,
};

function createApi(handlers = {}) {
  const calls = [];
  const make = (type) => async (...args) => {
    calls.push({ type, args });
    const handler = Object.hasOwn(handlers, type) ? handlers[type] : DEFAULT_HANDLERS[type];
    return handler ? handler(...args) : {};
  };
  return {
    calls,
    command: make('command'),
    bot: make('bot'),
    datapack: make('datapack'),
    gradle: make('gradle'),
    serverStatus: make('serverStatus'),
    botState: make('botState'),
    sleep: make('sleep'),
    log: (...args) => calls.push({ type: 'log', args }),
  };
}

function callsOf(api, type) {
  return api.calls.filter((call) => call.type === type);
}

/** normalize + compile + execute a raw card object (the way runCardFile does it). */
async function runCard(raw, api, options) {
  const card = normalizeCard(raw);
  const { steps, warnings } = cardToSteps(card);
  const result = await runSteps(steps, api, options);
  return { ...result, translationWarnings: warnings };
}

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

describe('parseYaml', () => {
  it('parses nested maps, sequences, inline collections and scalars', () => {
    const text = [
      '# full-line comment',
      'id: S-900',
      'title: "smoke: card"',
      "description: 'it''s quoted'",
      'setup:',
      '  commands:',
      '    - gamerule doDaylightCycle false',
      '    - "time set 1000"',
      'nested:',
      '  map:',
      '    a: 1',
      '  list:',
      '    - one',
      '    - two',
      '    - name: item',
      '      count: 2',
      'inline:',
      '  obj: { a: 1, b: "two", c: [1, 2, 3], d: { e: null } }',
      '  arr: [ { x: 1 }, [2, 3], "quoted" ]',
      'scalars:',
      '  int: -5',
      '  float: 3.14',
      '  exp: 1e3',
      '  yes: true',
      '  no: false',
      '  nul: null',
      '  tilde: ~',
      '  hash: a#b',
      '  trailing: value # trailing comment',
      '  hashInQuote: "a # b"',
      'literal: |',
      '  line one',
      '  line two',
      'literalStrip: |-',
      '  only',
      'folded: >-',
      '  fold',
      '  me',
    ].join('\n');

    const doc = parseYaml(text);
    assert.equal(doc.id, 'S-900');
    assert.equal(doc.title, 'smoke: card');
    assert.equal(doc.description, "it's quoted");
    assert.deepEqual(doc.setup.commands, ['gamerule doDaylightCycle false', 'time set 1000']);
    assert.deepEqual(doc.nested.map, { a: 1 });
    assert.deepEqual(doc.nested.list, ['one', 'two', { name: 'item', count: 2 }]);
    assert.deepEqual(doc.inline.obj, { a: 1, b: 'two', c: [1, 2, 3], d: { e: null } });
    assert.deepEqual(doc.inline.arr, [{ x: 1 }, [2, 3], 'quoted']);
    assert.equal(doc.scalars.int, -5);
    assert.equal(doc.scalars.float, 3.14);
    assert.equal(doc.scalars.exp, 1000);
    assert.equal(doc.scalars.yes, true);
    assert.equal(doc.scalars.no, false);
    assert.equal(doc.scalars.nul, null);
    assert.equal(doc.scalars.tilde, null);
    assert.equal(doc.scalars.hash, 'a#b');
    assert.equal(doc.scalars.trailing, 'value');
    assert.equal(doc.scalars.hashInQuote, 'a # b');
    assert.equal(doc.literal, 'line one\nline two\n');
    assert.equal(doc.literalStrip, 'only');
    assert.equal(doc.folded, 'fold me');
  });

  it('parses the contract-style card with multi-line sequence mappings', () => {
    const text = [
      'id: S-001',
      'steps:',
      '  - type: command',
      '    cmd: "setblock 0 64 0 minecraft:stone"',
      '    expect: { contains: "Block placed" }',
      '  - type: bot',
      '    action: join',
      '    params:',
      '      username: Tester',
      '  - type: assert',
      '    step: 1',
      '    path: response',
      '    op: contains',
      '    value: "hello"',
      '  - type: quote',
      '    cmd: "say done"',
    ].join('\n');

    const doc = parseYaml(text);
    assert.equal(doc.steps.length, 4);
    assert.deepEqual(doc.steps[0], {
      type: 'command',
      cmd: 'setblock 0 64 0 minecraft:stone',
      expect: { contains: 'Block placed' },
    });
    assert.deepEqual(doc.steps[1], { type: 'bot', action: 'join', params: { username: 'Tester' } });
    assert.deepEqual(doc.steps[2], { type: 'assert', step: 1, path: 'response', op: 'contains', value: 'hello' });
    assert.deepEqual(doc.steps[3], { type: 'quote', cmd: 'say done' });
  });

  it('parses quoted keys, empty values and flow-only values', () => {
    const doc = parseYaml(['"a b": 1', 'emptyList: []', 'emptyMap: {}', 'emptyValue:', 'falsy: false'].join('\n'));
    assert.equal(doc['a b'], 1);
    assert.deepEqual(doc.emptyList, []);
    assert.deepEqual(doc.emptyMap, {});
    assert.equal(doc.emptyValue, null);
    assert.equal(doc.falsy, false);
  });

  it('supports block scalars inside sequence item mappings', () => {
    const doc = parseYaml(['- text: |', '    hello', '    world', '  type: note', '- plain'].join('\n'));
    assert.deepEqual(doc, [{ text: 'hello\nworld\n', type: 'note' }, 'plain']);
  });

  it('supports quoted scalars that contain "key: value" patterns', () => {
    const doc = parseYaml(['a: "x: y"', "b: 'c: d'", 'c: http://example.test/x', 'd: "say: hello"'].join('\n'));
    assert.equal(doc.a, 'x: y');
    assert.equal(doc.b, 'c: d');
    assert.equal(doc.c, 'http://example.test/x');
    assert.equal(doc.d, 'say: hello');
  });

  it('returns {} for empty documents and comment-only documents', () => {
    assert.deepEqual(parseYaml(''), {});
    assert.deepEqual(parseYaml('   \n\t\n'), {});
    assert.deepEqual(parseYaml('# only comments\n   # more\n'), {});
  });

  it('throws syntax errors with a line number', () => {
    assert.throws(() => parseYaml('title: "oops'), /YAML syntax error at line 1/);
    assert.throws(() => parseYaml('a: 1\n  b: 2'), /YAML syntax error at line 2/);
    assert.throws(() => parseYaml('a: 1\n\tb: 2'), /YAML syntax error at line 2/);
    assert.throws(() => parseYaml('x: {a: 1'), /YAML syntax error at line 1/);
    assert.throws(() => parseYaml('x: [1, 2'), /YAML syntax error at line 1/);
    assert.throws(() => parseYaml("x: 'oops"), /YAML syntax error at line 1/);
  });
});

// ---------------------------------------------------------------------------
// parseCardFile
// ---------------------------------------------------------------------------

describe('parseCardFile', () => {
  it('reads YAML and JSON card files', () => {
    const dir = makeTempDir();
    const yamlFile = writeText(dir, 'card.yml', 'id: T-1\nsteps:\n  - type: wait\n    ms: 1\n');
    const jsonFile = writeText(dir, 'card.json', JSON.stringify({ id: 'T-2', steps: [{ type: 'wait', ms: 1 }] }));

    assert.equal(parseCardFile(yamlFile).id, 'T-1');
    assert.equal(parseCardFile(jsonFile).id, 'T-2');
  });

  it('throws for missing files', () => {
    const dir = makeTempDir();
    assert.throws(() => parseCardFile(join(dir, 'does-not-exist.yml')), /ENOENT|no such file/i);
  });

  it('throws YAML syntax errors with the file path and line number', () => {
    const dir = makeTempDir();
    const file = writeText(dir, 'broken.yml', 'id: BAD\n  bad: indent\n');
    assert.throws(() => parseCardFile(file), (error) => {
      assert.match(error.message, /broken\.yml/);
      assert.match(error.message, /YAML syntax error at line 2/);
      return true;
    });
  });

  it('throws readable errors for invalid JSON cards', () => {
    const dir = makeTempDir();
    const file = writeText(dir, 'broken.json', '{ "id": "X", }');
    assert.throws(() => parseCardFile(file), /invalid JSON in .*broken\.json/);
  });
});

// ---------------------------------------------------------------------------
// normalizeCard / cardToSteps
// ---------------------------------------------------------------------------

describe('normalizeCard', () => {
  it('fills contract defaults', () => {
    const card = normalizeCard({});
    assert.equal(card.id, '');
    assert.equal(card.title, '');
    assert.equal(card.description, '');
    assert.deepEqual(card.setup, { commands: [] });
    assert.deepEqual(card.steps, []);
    assert.deepEqual(card.warnings, []);
  });

  it('puts setup.commands first and keeps v1 steps', () => {
    const card = normalizeCard({
      id: 'T-1',
      title: 'title',
      description: 'desc',
      setup: { commands: ['gamerule doDaylightCycle false'] },
      steps: [{ type: 'wait', ms: 5 }],
    });
    assert.equal(card.id, 'T-1');
    assert.equal(card.title, 'title');
    assert.equal(card.description, 'desc');
    assert.deepEqual(card.setup.commands, ['gamerule doDaylightCycle false']);
    assert.deepEqual(card.steps, [
      { type: 'command', cmd: 'gamerule doDaylightCycle false' },
      { type: 'wait', ms: 5 },
    ]);
    assert.deepEqual(card.warnings, []);
  });

  it('translates legacy actions/assert and skips probe-only entries with warnings', () => {
    const raw = {
      id: 'L-1',
      setup: { commands: ['time set day'] },
      actions: [
        'say string-action',
        { command: 'say command-action' },
        { wait: 10 },
        { give: { player: 'Dev', item: 'minecraft:dirt', count: 1 } },
        { use_item_on: { x: 0, y: 64, z: 0 } },
        { block_entity_nbt: { pos: [0, 64, 0], path: 'Energy' } },
      ],
      assert: [
        { path: 'response', op: 'contains', value: 'say' },
        { screen_title: 'Crafting' },
        { block_entity_nbt: { pos: [0, 64, 0] } },
      ],
    };

    const { steps, warnings } = cardToSteps(raw);
    assert.deepEqual(steps.map((step) => step.type), ['command', 'command', 'command', 'wait', 'assert']);
    assert.equal(warnings.length, 5);
    assert.ok(warnings.some((warning) => /unsupported legacy action "give"/.test(warning)));
    assert.ok(warnings.some((warning) => /unsupported legacy action "use_item_on"/.test(warning)));
    assert.ok(warnings.some((warning) => /unsupported legacy action "block_entity_nbt"/.test(warning)));
    assert.ok(warnings.some((warning) => /unsupported legacy assert "screen_title"/.test(warning)));
    assert.ok(warnings.some((warning) => /unsupported legacy assert "block_entity_nbt"/.test(warning)));

    const card = normalizeCard(raw);
    assert.equal(card.steps.length, 5);
    assert.equal(card.warnings.length, 5);
  });

  it('is idempotent and cardToSteps does not duplicate setup commands', () => {
    const raw = {
      setup: { commands: ['say setup'] },
      steps: [{ type: 'command', cmd: 'say step' }],
    };
    const once = normalizeCard(raw);
    const twice = normalizeCard(once);
    assert.equal(twice, once);
    assert.equal(cardToSteps(once).steps.length, 2);
    assert.equal(cardToSteps(once).steps.filter((step) => step.cmd === 'say setup').length, 1);
    assert.deepEqual(cardToSteps(raw).steps, once.steps);
  });

  it('accepts a setup string and warns about malformed steps', () => {
    const card = normalizeCard({
      setup: 'say hi',
      steps: [{ type: 'teleport', to: 'x' }, 42, { type: 'command' }, { type: 'wait', ms: 1 }],
    });
    assert.deepEqual(card.setup.commands, ['say hi']);
    assert.deepEqual(card.steps.map((step) => step.type), ['command', 'command', 'wait']);
    assert.ok(card.warnings.some((warning) => /unsupported step type "teleport"/.test(warning)));
    assert.ok(card.warnings.some((warning) => /steps\[1\]: step must be an object/.test(warning)));
    assert.ok(card.warnings.some((warning) => /missing "cmd"/.test(warning)));
  });

  it('throws for non-object cards', () => {
    assert.throws(() => normalizeCard(null), /must be a YAML\/JSON object/);
    assert.throws(() => normalizeCard('nope'), /must be a YAML\/JSON object/);
    assert.throws(() => normalizeCard([]), /must be a YAML\/JSON object/);
    assert.throws(() => cardToSteps(null), /expects a card object/);
  });
});

// ---------------------------------------------------------------------------
// runSteps
// ---------------------------------------------------------------------------

describe('runSteps', () => {
  it('runs setup commands first, then steps in order', async () => {
    const api = createApi();
    const result = await runCard(
      {
        setup: { commands: ['gamerule a false'] },
        steps: [
          { type: 'command', cmd: 'time set 1000' },
          { type: 'command', cmd: 'say hi', expect: { contains: 'OK: say hi' } },
          { type: 'wait', ms: 1 },
        ],
      },
      api,
    );

    assert.equal(result.ok, true);
    assert.equal(result.failedAt, null);
    assert.equal(result.steps.length, 4);
    assert.deepEqual(api.calls.map((call) => call.type), ['command', 'command', 'command', 'sleep']);
    assert.equal(api.calls[0].args[0], 'gamerule a false');
    assert.deepEqual(result.steps[0].data, { response: 'OK: gamerule a false', ms: 1 });
    assert.equal(result.steps[3].data, undefined);
  });

  it('records data={response} even when api.command returns a plain string', async () => {
    const api = createApi({ command: (cmd) => `plain ${cmd}` });
    const result = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'x' },
          { type: 'assert', step: 0, path: 'response', op: 'eq', value: 'plain x' },
        ],
      },
      api,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(result.steps[0].data, { response: 'plain x' });
  });

  it('stops at the failing assert by default', async () => {
    const api = createApi();
    const raw = {
      steps: [
        { type: 'command', cmd: 'one' },
        { type: 'command', cmd: 'two' },
        { type: 'assert', step: 0, path: 'response', op: 'eq', value: 'nope' },
        { type: 'command', cmd: 'three' },
      ],
    };
    const result = await runCard(raw, api);

    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 2);
    assert.equal(result.steps.length, 3);
    assert.equal(result.steps[2].ok, false);
    assert.match(result.steps[2].error, /assert failed/);
    assert.deepEqual(callsOf(api, 'command').map((call) => call.args[0]), ['one', 'two']);
  });

  it('keeps running after failures when stopOnFail is false', async () => {
    const api = createApi();
    const raw = {
      steps: [
        { type: 'command', cmd: 'one' },
        { type: 'command', cmd: 'two' },
        { type: 'assert', step: 0, path: 'response', op: 'eq', value: 'nope' },
        { type: 'command', cmd: 'three' },
      ],
    };
    const result = await runCard(raw, api, { stopOnFail: false });

    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 2);
    assert.equal(result.steps.length, 4);
    assert.deepEqual(callsOf(api, 'command').map((call) => call.args[0]), ['one', 'two', 'three']);
  });

  it('implicit assert target is the latest data step (wait does not count)', async () => {
    const result = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'alpha' },
          { type: 'command', cmd: 'beta' },
          { type: 'wait', ms: 1 },
          { type: 'assert', path: 'response', op: 'contains', value: 'beta' },
          { type: 'assert', path: 'response', op: 'not_contains', value: 'alpha' },
        ],
      },
      createApi(),
    );
    assert.equal(result.ok, true);
    assert.equal(result.failedAt, null);
  });

  it('fails the producing step when inline expect fails', async () => {
    const result = await runCard({ steps: [{ type: 'command', cmd: 'x', expect: { contains: 'NOPE' } }] }, createApi());
    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 0);
    assert.match(result.steps[0].error, /expect contains "NOPE" failed/);
  });

  it('captures api errors as step failures (does not throw)', async () => {
    const api = createApi({
      command: () => {
        throw new Error('rcon is down');
      },
    });
    const result = await runCard({ steps: [{ type: 'command', cmd: 'list' }] }, api);
    assert.equal(result.ok, false);
    assert.equal(result.failedAt, 0);
    assert.match(result.steps[0].error, /rcon is down/);
  });

  it('reports missing data / bad step reference / unknown op', async () => {
    const noData = await runCard({ steps: [{ type: 'assert', path: 'response' }] }, createApi());
    assert.equal(noData.ok, false);
    assert.match(noData.steps[0].error, /no previous step produced data/);

    const badRef = await runCard(
      { steps: [{ type: 'command', cmd: 'x' }, { type: 'assert', step: 5, path: 'response' }] },
      createApi(),
    );
    assert.equal(badRef.ok, false);
    assert.match(badRef.steps[1].error, /invalid "step" reference/);

    const badOp = await runCard(
      { steps: [{ type: 'command', cmd: 'x' }, { type: 'assert', step: 0, path: 'response', op: 'approximately' }] },
      createApi(),
    );
    assert.equal(badOp.ok, false);
    assert.match(badOp.steps[1].error, /unsupported op/);
  });

  it('supports every assert op and bracket paths', async () => {
    const data = {
      response: 'hello world',
      value: 10,
      list: [1, 2, 3],
      nested: { items: [{ name: 'dirt' }] },
      flag: true,
      obj: { name: 'dirt' },
    };
    const api = createApi({ command: () => data });
    const result = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'rich' },
          { type: 'assert', step: 0, path: 'value', op: 'eq', value: '10' },
          { type: 'assert', step: 0, path: 'value', op: 'ne', value: 11 },
          { type: 'assert', step: 0, path: 'response', op: 'contains', value: 'lo wo' },
          { type: 'assert', step: 0, path: 'response', op: 'not_contains', value: 'zzz' },
          { type: 'assert', step: 0, path: 'response', op: 'matches', value: '^he.*d$' },
          { type: 'assert', step: 0, path: 'flag', op: 'exists' },
          { type: 'assert', step: 0, path: 'value', op: 'gt', value: 9 },
          { type: 'assert', step: 0, path: 'value', op: 'gte', value: 10 },
          { type: 'assert', step: 0, path: 'value', op: 'lt', value: 11 },
          { type: 'assert', step: 0, path: 'value', op: 'lte', value: 10 },
          { type: 'assert', step: 0, path: 'nested.items[0].name', op: 'eq', value: 'dirt' },
          { type: 'assert', step: 0, path: 'list', op: 'contains', value: 2 },
          { type: 'assert', step: 0, path: 'obj', op: 'contains', value: 'dirt' },
        ],
      },
      api,
    );
    assert.equal(result.ok, true);
    assert.equal(result.failedAt, null);
    assert.equal(result.steps.length, 14);
  });

  it('fails exists on null and gt on non-numeric values', async () => {
    const api = createApi({ command: () => ({ response: 'abc', empty: null }) });
    const existsNull = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'x' },
          { type: 'assert', step: 0, path: 'empty', op: 'exists' },
        ],
      },
      api,
    );
    assert.equal(existsNull.ok, false);
    assert.match(existsNull.steps[1].error, /does not exist/);

    const numeric = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'x' },
          { type: 'assert', step: 0, path: 'response', op: 'gt', value: 1 },
        ],
      },
      api,
    );
    assert.equal(numeric.ok, false);
    assert.match(numeric.steps[1].error, /requires numeric values/);
  });

  it('reports a not-found assert path with available keys', async () => {
    const result = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'x' },
          { type: 'assert', step: 0, path: 'missing.deep', op: 'eq', value: 1 },
        ],
      },
      createApi(),
    );
    assert.equal(result.ok, false);
    assert.match(result.steps[1].error, /path "missing\.deep" not found/);
    assert.match(result.steps[1].error, /keys: response, ms/);
  });

  it('supports the legacy "data." assert path prefix', async () => {
    const result = await runCard(
      {
        steps: [
          { type: 'command', cmd: 'x' },
          { type: 'assert', step: 0, path: 'data.response', op: 'eq', value: 'OK: x' },
        ],
      },
      createApi(),
    );
    assert.equal(result.ok, true);
  });

  it('executes bot / datapack / server / snapshot / note steps', async () => {
    const api = createApi({
      bot: (action, params = {}) => {
        if (action === 'join') return { connected: true, username: params.username };
        if (action === 'state') return { connected: true, position: { x: 1, y: 2, z: 3 }, health: 20 };
        if (action === 'chat') return { sent: true, message: params.message };
        return { action };
      },
      datapack: (action, params = {}) => ({ action, params }),
    });
    const result = await runCard(
      {
        steps: [
          { type: 'bot', action: 'join', params: { username: 'CardBot' } },
          { type: 'assert', step: 0, path: 'connected', op: 'eq', value: true },
          { type: 'bot', action: 'state' },
          { type: 'assert', path: 'position.x', op: 'eq', value: 1 },
          { type: 'assert', path: 'health', op: 'gt', value: 0 },
          { type: 'bot', action: 'chat', params: { message: 'hi' } },
          { type: 'assert', path: 'sent', op: 'eq', value: true },
          { type: 'datapack', action: 'reload' },
          { type: 'assert', step: 7, path: 'action', op: 'eq', value: 'reload' },
          { type: 'server', action: 'status' },
          { type: 'assert', path: 'active', op: 'eq', value: true },
          { type: 'snapshot' },
          { type: 'assert', path: 'serverStatus.ready', op: 'eq', value: true },
          { type: 'assert', path: 'botState.connected', op: 'eq', value: true },
          { type: 'note', text: 'checkpoint' },
        ],
      },
      api,
    );
    assert.equal(result.ok, true);
    assert.equal(result.failedAt, null);
    const noteLogs = callsOf(api, 'log');
    assert.equal(noteLogs.length, 1);
    assert.match(noteLogs[0].args[0], /checkpoint/);
  });

  it('accepts datapack/bot action from params and merges flat fields into params', async () => {
    const api = createApi({
      datapack: (action, params = {}) => ({ action, params }),
      bot: (action, params = {}) => ({ action, params }),
    });
    const result = await runCard(
      {
        steps: [
          { type: 'datapack', action: 'deploy', dir: '/abs/pack' },
          { type: 'datapack', params: { action: 'reload' } },
          { type: 'datapack', action: 'list', params: { name: 'x' } },
          { type: 'bot', params: { action: 'join', username: 'X' } },
          { type: 'assert', step: 0, path: 'params.dir', op: 'eq', value: '/abs/pack' },
          { type: 'assert', step: 2, path: 'params.name', op: 'eq', value: 'x' },
          { type: 'assert', step: 3, path: 'params.username', op: 'eq', value: 'X' },
          { type: 'assert', step: 3, path: 'action', op: 'eq', value: 'join' },
        ],
      },
      api,
    );
    assert.equal(result.ok, true);
    assert.deepEqual(callsOf(api, 'datapack').map((call) => call.args), [
      ['deploy', { dir: '/abs/pack' }],
      ['reload', {}],
      ['list', { name: 'x' }],
    ]);
    assert.deepEqual(callsOf(api, 'bot').map((call) => call.args), [['join', { username: 'X' }]]);
  });

  it('fails gradle steps on non-zero exit / timeout', async () => {
    const okApi = createApi();
    const pass = await runCard({ steps: [{ type: 'gradle', task: 'build' }] }, okApi);
    assert.equal(pass.ok, true);
    assert.deepEqual(callsOf(okApi, 'gradle')[0].args, ['build', {}]);

    // Flat gradle fields are forwarded as opts (buildApi resolves opts.projectDir).
    const flatApi = createApi();
    await runCard(
      { steps: [{ type: 'gradle', task: 'build', projectDir: '/proj', args: ['-x', 'test'] }] },
      flatApi,
    );
    assert.deepEqual(callsOf(flatApi, 'gradle')[0].args, ['build', { projectDir: '/proj', args: ['-x', 'test'] }]);

    const failing = createApi({ gradle: (task) => ({ task, exitCode: 1, summary: 'FAILED' }) });
    const fail = await runCard({ steps: [{ type: 'gradle', task: 'build' }] }, failing);
    assert.equal(fail.ok, false);
    assert.match(fail.steps[0].error, /exit code 1: FAILED/);

    const timedOut = createApi({ gradle: (task) => ({ task, exitCode: null, timedOut: true }) });
    const timeout = await runCard({ steps: [{ type: 'gradle', task: 'runGameTestServer' }] }, timedOut);
    assert.equal(timeout.ok, false);
    assert.match(timeout.steps[0].error, /timed out/);
  });

  it('fails steps whose api method is missing', async () => {
    const result = await runSteps([{ type: 'command', cmd: 'list' }], {}, {});
    assert.equal(result.ok, false);
    assert.match(result.steps[0].error, /api\.command is not available/);
  });

  it('skips unknown step types with a warning', async () => {
    const api = createApi();
    const result = await runSteps([{ type: 'teleport' }, { type: 'command', cmd: 'x' }], api, {});
    assert.equal(result.ok, true);
    assert.ok(result.warnings.some((warning) => /unsupported step type "teleport"/.test(warning)));
    assert.equal(result.steps[0].skipped, true);
    assert.deepEqual(callsOf(api, 'command').map((call) => call.args[0]), ['x']);
  });

  it('does not call the api in dryRun mode', async () => {
    const api = createApi({
      command: () => {
        throw new Error('should not be called');
      },
      sleep: () => {
        throw new Error('should not be called');
      },
    });
    const result = await runSteps(
      [{ type: 'command', cmd: 'x' }, { type: 'wait', ms: 5 }, { type: 'assert', path: 'x' }, { type: 'weird' }],
      api,
      { dryRun: true },
    );
    assert.equal(result.ok, true);
    assert.equal(result.failedAt, null);
    assert.equal(api.calls.length, 0);
    assert.ok(result.steps.every((step) => step.ok === true && step.dryRun === true));
  });

  it('falls back to a real timer when api.sleep is absent', async () => {
    const api = createApi();
    delete api.sleep;
    const started = Date.now();
    const result = await runSteps([{ type: 'wait', ms: 5 }], api, {});
    assert.equal(result.ok, true);
    assert.ok(Date.now() - started >= 0);
  });

  it('fails snapshot without serverStatus/botState and server with unknown action', async () => {
    const noSnapshot = await runSteps([{ type: 'snapshot' }], {}, {});
    assert.equal(noSnapshot.ok, false);
    assert.match(noSnapshot.steps[0].error, /snapshot requires api\.serverStatus or api\.botState/);

    const api = createApi();
    const badServer = await runSteps([{ type: 'server', action: 'explode' }], api, {});
    assert.equal(badServer.ok, false);
    assert.match(badServer.steps[0].error, /unsupported action "explode"/);
  });

  it('throws for invalid runSteps arguments', async () => {
    await assert.rejects(runSteps('nope', {}), /expects an array of steps/);
    await assert.rejects(runSteps([], null), /expects an api object/);
  });
});

// ---------------------------------------------------------------------------
// runCardFile
// ---------------------------------------------------------------------------

describe('runCardFile', () => {
  it('runs a passing card and reports id/title/steps', async () => {
    const dir = makeTempDir();
    const file = writeText(
      dir,
      'pass.yml',
      [
        'id: T-100',
        'title: 冒烟卡',
        'setup:',
        '  commands: ["gamerule doDaylightCycle false"]',
        'steps:',
        '  - type: command',
        '    cmd: "time set 1000"',
        '    expect: { contains: "OK: time set 1000" }',
        '  - type: command',
        '    cmd: "time query daytime"',
        '  - type: assert',
        '    step: 2',
        '    path: response',
        '    op: contains',
        '    value: "time query"',
      ].join('\n'),
    );

    const api = createApi();
    const result = await runCardFile(file, api);

    assert.equal(result.ok, true);
    assert.equal(result.id, 'T-100');
    assert.equal(result.title, '冒烟卡');
    assert.equal(result.failedAt, null);
    assert.equal(result.error, undefined);
    assert.deepEqual(result.warnings, []);
    assert.equal(result.steps.length, 4);
    assert.deepEqual(callsOf(api, 'command').map((call) => call.args[0]), [
      'gamerule doDaylightCycle false',
      'time set 1000',
      'time query daytime',
    ]);
  });

  it('returns ok:false (does not throw) for failing cards', async () => {
    const dir = makeTempDir();
    const file = writeText(
      dir,
      'fail.yml',
      ['id: T-101', 'steps:', '  - type: command', '    cmd: "say hi"', '  - type: assert', '    step: 0', '    path: response', '    op: eq', '    value: "nope"'].join('\n'),
    );
    const result = await runCardFile(file, createApi());
    assert.equal(result.ok, false);
    assert.equal(result.id, 'T-101');
    assert.equal(result.failedAt, 1);
    assert.match(result.error, /assert failed/);
  });

  it('falls back to the file name when id/title are missing', async () => {
    const dir = makeTempDir();
    const file = writeText(dir, 'no-id.yml', 'steps:\n  - type: command\n    cmd: "say x"\n');
    const result = await runCardFile(file, createApi());
    assert.equal(result.id, 'no-id');
    assert.equal(result.title, 'no-id');
  });

  it('throws for file-read and YAML syntax errors', async () => {
    const dir = makeTempDir();
    const broken = writeText(dir, 'broken.yml', 'id: BAD\n  bad: indent\n');
    await assert.rejects(runCardFile(broken, createApi()), /YAML syntax error at line 2/);
    await assert.rejects(runCardFile(join(dir, 'missing.yml'), createApi()), /ENOENT|no such file/i);
  });

  it('reports a non-object card document as ok:false', async () => {
    const dir = makeTempDir();
    const file = writeText(dir, 'list.yml', '- one\n- two\n');
    const result = await runCardFile(file, createApi());
    assert.equal(result.ok, false);
    assert.match(result.error, /must be a YAML\/JSON object/);
  });

  it('resolves "./" and "../" path fields relative to the card file', async () => {
    const root = makeTempDir();
    mkdirSync(join(root, 'cards'), { recursive: true });
    mkdirSync(join(root, 'datapacks', 'demo'), { recursive: true });
    const file = writeText(
      join(root, 'cards'),
      'relative.yml',
      [
        'id: REL-1',
        'steps:',
        '  - type: datapack',
        '    action: deploy',
        '    dir: "../datapacks/demo"',
        '  - type: datapack',
        '    params: { action: deploy, packDir: "../datapacks/demo" }',
        '  - type: assert',
        '    step: 0',
        '    path: params.dir',
        '    op: matches',
        '    value: "datapacks"',
      ].join('\n'),
    );

    const api = createApi({
      datapack: (action, params = {}) => ({ action, params }),
    });
    const result = await runCardFile(file, api);
    assert.equal(result.ok, true);

    const expected = resolve(root, 'datapacks', 'demo');
    assert.equal(callsOf(api, 'datapack')[0].args[1].dir, expected);
    assert.equal(callsOf(api, 'datapack')[1].args[1].packDir, expected);
  });

  it('runs legacy mcdev cards with probe-only actions skipped as warnings', async () => {
    const dir = makeTempDir();
    const file = writeText(
      dir,
      'legacy.yml',
      [
        'id: LEG-1',
        'setup:',
        '  commands: ["say setup"]',
        'actions:',
        '  - "say string-action"',
        '  - command: "say object-action"',
        '  - wait: 1',
        '  - give:',
        '      player: Dev',
        '      item: minecraft:dirt',
        'assert:',
        '  - path: response',
        '    op: contains',
        '    value: "OK: say object-action"',
      ].join('\n'),
    );
    const api = createApi();
    const result = await runCardFile(file, api);
    assert.equal(result.ok, true);
    assert.deepEqual(
      callsOf(api, 'command').map((call) => call.args[0]),
      ['say setup', 'say string-action', 'say object-action'],
    );
    assert.ok(result.warnings.some((warning) => /unsupported legacy action "give"/.test(warning)));
  });

  it('does not call the api in dryRun mode', async () => {
    const dir = makeTempDir();
    const file = writeText(
      dir,
      'dry.yml',
      ['id: DRY-1', 'steps:', '  - type: command', '    cmd: "say x"', '  - type: assert', '    path: response', '    op: eq', '    value: "x"'].join('\n'),
    );
    const api = createApi();
    const result = await runCardFile(file, api, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(api.calls.length, 0);
    assert.ok(result.steps.every((step) => step.dryRun === true));
  });
});

// ---------------------------------------------------------------------------
// runSuite
// ---------------------------------------------------------------------------

describe('runSuite', () => {
  function buildSuiteDir() {
    const dir = makeTempDir('suite');
    writeText(dir, '00-json.json', JSON.stringify({ id: 'J-1', steps: [{ type: 'command', cmd: 'json cmd' }] }));
    writeText(
      dir,
      '01-pass.yml',
      ['id: S-001', 'steps:', '  - type: command', '    cmd: "say one"', '    expect: { contains: "OK: say one" }'].join('\n'),
    );
    writeText(dir, '02-pass.yaml', ['id: S-002', 'steps:', '  - type: command', '    cmd: "say two"'].join('\n'));
    writeText(
      dir,
      '03-fail.yml',
      ['id: S-003', 'steps:', '  - type: command', '    cmd: "say three"', '  - type: assert', '    step: 0', '    path: response', '    op: eq', '    value: "nope"'].join('\n'),
    );
    writeText(
      dir,
      '04-legacy.yml',
      ['id: LEG-1', 'actions:', '  - give: { player: Dev, item: minecraft:dirt }', '  - command: "say legacy"', 'assert:', '  - path: response', '    op: contains', '    value: "OK: say legacy"'].join('\n'),
    );
    writeText(dir, '05-broken.yml', 'id: BAD\ntitle: "unterminated\n');
    writeText(dir, 'notes.txt', 'not a card');
    return dir;
  }

  it('runs every card, keeps going after failures and summarizes', async () => {
    const dir = buildSuiteDir();
    const api = createApi();
    const result = await runSuite(dir, api);

    assert.equal(result.ok, false);
    assert.equal(result.total, 6);
    assert.equal(result.passed, 4);
    assert.equal(result.failed, 2);
    assert.equal(result.cards.length, 6);

    assert.deepEqual(result.cards.map((card) => card.id), ['J-1', 'S-001', 'S-002', 'S-003', 'LEG-1', '05-broken']);
    const failing = result.cards.find((card) => card.id === 'S-003');
    assert.equal(failing.ok, false);
    assert.equal(failing.failedAt, 1);
    assert.equal(failing.file, '03-fail.yml');
    assert.match(failing.error, /assert failed/);
    assert.equal(typeof failing.ms, 'number');

    const broken = result.cards.find((card) => card.id === '05-broken');
    assert.equal(broken.ok, false);
    assert.match(broken.error, /YAML syntax error/);

    const legacy = result.cards.find((card) => card.id === 'LEG-1');
    assert.equal(legacy.ok, true);
    assert.ok(result.warnings.some((warning) => /^04-legacy\.yml: .*give/.test(warning)));

    // Per-card step reports are kept for verbose consumers (index.js mcdt_suite verbose).
    assert.ok(Array.isArray(failing.steps));
    assert.equal(failing.steps.length, 2);
    assert.ok(Array.isArray(result.cards[0].steps));
  });

  it('stops after the first failing card when stopOnFail is true', async () => {
    const dir = makeTempDir('suite-stop');
    writeText(dir, '01-pass.yml', ['id: A', 'steps:', '  - type: command', '    cmd: "first"'].join('\n'));
    writeText(
      dir,
      '02-fail.yml',
      ['id: B', 'steps:', '  - type: command', '    cmd: "second"', '  - type: assert', '    step: 0', '    path: response', '    op: eq', '    value: "nope"'].join('\n'),
    );
    writeText(dir, '03-pass.yml', ['id: C', 'steps:', '  - type: command', '    cmd: "third"'].join('\n'));

    const api = createApi();
    const result = await runSuite(dir, api, { stopOnFail: true });

    assert.equal(result.ok, false);
    assert.equal(result.total, 2);
    assert.deepEqual(result.cards.map((card) => card.id), ['A', 'B']);
    assert.deepEqual(callsOf(api, 'command').map((call) => call.args[0]), ['first', 'second']);
  });

  it('filters cards by file path, id, wildcard or predicate', async () => {
    const dir = buildSuiteDir();
    const byPath = await runSuite(dir, createApi(), { filter: '01-pass' });
    assert.equal(byPath.total, 1);
    assert.deepEqual(byPath.cards.map((card) => card.id), ['S-001']);

    const byId = await runSuite(dir, createApi(), { filter: 'S-003' });
    assert.equal(byId.total, 1);
    assert.deepEqual(byId.cards.map((card) => card.id), ['S-003']);

    const byWildcard = await runSuite(dir, createApi(), { filter: '*.json' });
    assert.equal(byWildcard.total, 1);
    assert.deepEqual(byWildcard.cards.map((card) => card.id), ['J-1']);

    const byPredicate = await runSuite(dir, createApi(), { filter: (file, id) => id === 'S-002' });
    assert.equal(byPredicate.total, 1);
    assert.deepEqual(byPredicate.cards.map((card) => card.id), ['S-002']);
  });

  it('does not call the api in dryRun mode', async () => {
    const dir = makeTempDir('suite-dry');
    writeText(dir, '01.yml', ['id: A', 'steps:', '  - type: command', '    cmd: "x"', '  - type: assert', '    path: response', '    op: eq', '    value: "nope"'].join('\n'));
    writeText(dir, '02.yml', ['id: B', 'steps:', '  - type: command', '    cmd: "y"'].join('\n'));

    const api = createApi();
    const result = await runSuite(dir, api, { dryRun: true });
    assert.equal(result.ok, true);
    assert.equal(result.total, 2);
    assert.equal(result.passed, 2);
    assert.equal(api.calls.length, 0);
  });

  it('returns an empty summary for empty or missing directories', async () => {
    const empty = makeTempDir('suite-empty');
    const emptyResult = await runSuite(empty, createApi());
    assert.deepEqual(
      { ok: emptyResult.ok, total: emptyResult.total, passed: emptyResult.passed, failed: emptyResult.failed },
      { ok: true, total: 0, passed: 0, failed: 0 },
    );
    assert.deepEqual(emptyResult.cards, []);
    assert.deepEqual(emptyResult.warnings, []);

    const missingResult = await runSuite(join(empty, 'nope'), createApi());
    assert.equal(missingResult.total, 0);
    assert.equal(missingResult.ok, true);
  });
});

// ---------------------------------------------------------------------------
// Compatibility with the checked-in example cards (read-only)
// ---------------------------------------------------------------------------

describe('examples/cards compatibility', () => {
  function exampleFiles() {
    if (!existsSync(EXAMPLES_DIR)) return [];
    return readdirSync(EXAMPLES_DIR)
      .filter((name) => /\.(ya?ml|json)$/i.test(name))
      .sort()
      .map((name) => join(EXAMPLES_DIR, name));
  }

  it('parses and normalizes every example card', () => {
    const files = exampleFiles();
    assert.ok(files.length >= 3, `expected example cards in ${EXAMPLES_DIR}`);
    for (const file of files) {
      const card = normalizeCard(parseCardFile(file));
      assert.ok(card.id, `card in ${file} has an id`);
      assert.ok(card.steps.length > 0, `card in ${file} has steps`);
      assert.deepEqual(cardToSteps(card).steps, card.steps);
    }
  });

  it('runs the example cards against a mock api', async () => {
    // Mimics vanilla 1.20.1 server replies (the real E2E must see the same substrings).
    const server = { daylightCycle: true, time: 0 };
    const commandResponses = (cmd) => {
      if (cmd === 'gamerule doDaylightCycle false') {
        server.daylightCycle = false;
        return 'Gamerule doDaylightCycle is now set to: false';
      }
      if (cmd === 'gamerule doDaylightCycle') {
        return `Gamerule doDaylightCycle is currently set to: ${server.daylightCycle}`;
      }
      if (cmd.startsWith('time set')) {
        server.time = Number(cmd.split(' ').pop());
        return `Set the time to ${server.time}`;
      }
      if (cmd.startsWith('time query')) return `The time is ${server.time}`;
      if (cmd.startsWith('datapack list')) return 'There are 2 data packs: ["vanilla", "file/hello_mcdevtest"]';
      if (cmd.startsWith('scoreboard players get')) return '#loaded has 1 [mcdevtest]';
      if (cmd.startsWith('loot give')) return 'Dropped 1 item(s) on the ground';
      if (cmd.startsWith('recipe give')) return 'Unlocked 1 recipe(s)';
      if (cmd.startsWith('clear ')) return 'Found 1 matching item(s) on player CardBot';
      return 'ok';
    };
    const api = createApi({
      command: (cmd) => ({ response: commandResponses(cmd), ms: 1 }),
      bot: (action, params = {}) => {
        if (action === 'join') return { connected: true, username: params.username };
        if (action === 'leave') return { connected: false, left: true };
        if (action === 'state') return { connected: true, position: { x: 0, y: 64, z: 0 }, health: 20 };
        if (action === 'chat') return { sent: true, message: params.message };
        if (action === 'chat_history') return { messages: [{ username: 'a', message: 'b' }] };
        return { action };
      },
      datapack: (action, params = {}) => ({ action, deployed: true, target: params.dir, reloaded: true }),
    });

    const expectedDir = resolve(EXAMPLES_DIR, '..', 'datapacks', 'hello_mcdevtest');
    const results = [];
    for (const file of exampleFiles()) {
      const result = await runCardFile(file, api);
      results.push(result);
      assert.equal(result.ok, true, `${file} failed: ${result.error ?? ''} ${JSON.stringify(result.warnings)}`);
    }
    const ids = results.map((result) => result.id);
    for (const expectedId of ['S-001', 'S-002', 'S-003']) assert.ok(ids.includes(expectedId), `expected card ${expectedId}`);

    const deploy = callsOf(api, 'datapack').find((call) => call.args[0] === 'deploy');
    assert.ok(deploy, 'S-001 should deploy a datapack');
    assert.equal(deploy.args[1].dir, expectedDir);
    assert.ok(existsSync(expectedDir), 'resolved example datapack dir should exist');
  });
});
