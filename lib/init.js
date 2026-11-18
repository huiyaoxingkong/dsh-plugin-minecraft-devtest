import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import * as datapack from './datapack.js';
import { shortError } from './util.js';

function toPosix(path) {
  return String(path).split(sep).join('/');
}

function relativeFrom(baseDir, target) {
  const rel = toPosix(relative(baseDir, target));
  return rel.startsWith('.') ? rel : `./${rel}`;
}

function idFromFile(file) {
  const match = /^data\/([^/]+)\/(functions?|recipes?|loot_tables?|advancements?|predicates?|item_modifiers?)\/(.+)\.(json|mcfunction|nbt)$/.exec(
    toPosix(file),
  );
  if (!match) return null;
  const [, namespace, folder, rest] = match;
  const kind = folder.replace(/s$/, '');
  const path = rest;
  if (kind === 'function') return `${namespace}:${path}`;
  if (kind === 'recipe') return `${namespace}:${path}`;
  if (kind === 'loot_table') return `${namespace}:${path}`;
  if (kind === 'advancement') return `${namespace}:${path}`;
  return `${namespace}:${path}`;
}

function yamlQuote(text) {
  return JSON.stringify(String(text));
}

function buildDatapackCard({ pack, packDir, cardsDir, username }) {
  const rel = relativeFrom(cardsDir, packDir);
  const lines = [];
  lines.push('id: S-100');
  lines.push(`title: 自动生成冒烟卡（${pack.name}）`);
  lines.push('description: 由 mcdt_init 生成：先跑静态校验/部署/重载，再做安全的配方与战利品表存在性检查；probe 专用或可能产生副作用的行为请手动补断言。');
  lines.push('steps:');
  lines.push('  - type: datapack');
  lines.push('    action: deploy');
  lines.push(`    dir: ${yamlQuote(rel)}`);
  lines.push('  - type: datapack');
  lines.push('    action: reload');
  lines.push('  - type: wait');
  lines.push('    ms: 1200');
  lines.push('  - type: command');
  lines.push(`    cmd: "datapack list"`);
  lines.push('    expect: { contains: ' + yamlQuote(pack.name) + ' }');
  lines.push('  - type: bot');
  lines.push('    action: join');
  lines.push('    params: { username: ' + yamlQuote(username) + ' }');

  const recipes = [];
  const lootTables = [];
  const functions = [];
  for (const namespace of pack.namespaces ?? []) {
    for (const file of namespace.recipes ?? []) {
      const id = idFromFile(file);
      if (id) recipes.push(id);
    }
    for (const file of namespace.lootTables ?? []) {
      const id = idFromFile(file);
      if (id) lootTables.push(id);
    }
    for (const file of namespace.functions ?? []) {
      const id = idFromFile(file);
      if (id) functions.push(id);
    }
  }

  for (const recipe of recipes.slice(0, 40)) {
    lines.push('  - type: command');
    lines.push(`    cmd: ${yamlQuote(`recipe give ${username} ${recipe}`)}`);
    lines.push(`    expect: { contains: "recipe" }`);
  }
  for (const table of lootTables.filter((id) => /:(blocks?|chests?|entities?|gameplay)\//.test(id)).slice(0, 20)) {
    lines.push('  - type: command');
    lines.push(`    cmd: ${yamlQuote(`loot give ${username} loot ${table}`)}`);
    lines.push(`    expect: { contains: "Dropped" }`);
  }
  lines.push('  - type: bot');
  lines.push('    action: state');
  lines.push('  - type: assert');
  lines.push('    path: position');
  lines.push('    op: exists');
  lines.push('  - type: bot');
  lines.push('    action: leave');
  if (functions.length > 0) {
    lines.push('  - type: note');
    lines.push(
      `    text: ${yamlQuote(`以下函数未被自动执行（可能有副作用，请按需补 command 步骤）：${functions.slice(0, 30).join(', ')}`)}`,
    );
  }
  return {
    content: `${lines.join('\n')}\n`,
    counts: { recipes: recipes.length, lootTables: lootTables.length, functions: functions.length },
  };
}

function buildModCard({ projectDir, cardsDir, username }) {
  const lines = [];
  void projectDir;
  void cardsDir;
  void username;
  lines.push('id: S-100');
  lines.push('title: 自动生成冒烟卡（模组工程）');
  lines.push('description: 由 mcdt_init 生成：先跑 gradlew build；服务器/机器人行为断言请在 mcdt_server start 之后补 command/bot 步骤。');
  lines.push('steps:');
  lines.push('  - type: gradle');
  lines.push('    task: build');
  lines.push('  - type: note');
  lines.push(
    '    text: ' +
      yamlQuote(
        '接下来可用 mcdt_server start（gradle 模式 runServer）后，用 mcdt_test 追加 command/bot 断言；Forge/NeoForge 服务端不能用机器人，请用 mcdt_gradle task=runGameTestServer。',
      ),
  );
  return { content: `${lines.join('\n')}\n`, counts: {} };
}

export function initProject(options = {}) {
  const projectDir = resolve(String(options.projectDir ?? '.'));
  const outDirOption = options.outDir ? resolve(String(options.outDir)) : join(projectDir, 'mc-tests');
  const username = String(options.username ?? 'CardBot');
  if (!existsSync(projectDir)) throw new Error(`projectDir does not exist: ${projectDir}`);
  const packs = datapack.findPacks(projectDir);
  const isDatapack = packs.length > 0;
  mkdirSync(outDirOption, { recursive: true });

  const written = [];
  const summary = {};
  if (isDatapack) {
    const packDir = packs[0].dir;
    const scan = datapack.scanPack(packDir);
    const card = buildDatapackCard({
      pack: { ...scan, name: scan.name ?? basename(packDir) },
      packDir,
      cardsDir: outDirOption,
      username,
    });
    const fileName = 'S-100-generated-smoke.yml';
    const target = join(outDirOption, fileName);
    if (existsSync(target) && options.overwrite !== true) {
      throw new Error(`card already exists: ${target} (pass overwrite=true to replace)`);
    }
    writeFileSync(target, card.content, 'utf8');
    written.push(target);
    summary.pack = { dir: packDir, name: scan.name, packFormat: scan.packFormat, counts: scan.counts };
    summary.generated = card.counts;
  } else {
    const card = buildModCard({ projectDir, cardsDir: outDirOption, username });
    const fileName = 'S-100-generated-smoke.yml';
    const target = join(outDirOption, fileName);
    if (existsSync(target) && options.overwrite !== true) {
      throw new Error(`card already exists: ${target} (pass overwrite=true to replace)`);
    }
    writeFileSync(target, card.content, 'utf8');
    written.push(target);
    summary.projectType = 'gradle';
    summary.generated = card.counts;
  }

  const readme = join(outDirOption, 'README.md');
  if (!existsSync(readme) || options.overwrite === true) {
    writeFileSync(
      readme,
      [
        '# mc-tests',
        '',
        '由 `mcdt_init` 生成的免客户端测试卡目录。运行方式：',
        '',
        '```text',
        'mcdt_suite(dir="' + toPosix(outDirOption) + '", serverDir="<测试服目录>")',
        '```',
        '',
        '- 生成的卡片只包含安全、可重复的检查（部署/重载/配方/战利品/机器人进出服）。',
        '- 会修改世界的操作（setblock、summon、kill @e 等）请写进 `setup.commands` 并放在专用测试服。',
        '- 卡内断言失败时 `failedAt` 指向步骤序号，可用 `mcdt_test(verbose=true)` 看每步 data。',
      ].join('\n') + '\n',
      'utf8',
    );
    written.push(readme);
  }

  return {
    ok: true,
    outDir: outDirOption,
    files: written,
    projectType: isDatapack ? 'datapack' : 'gradle',
    summary,
    next: isDatapack
      ? 'run mcdt_suite(dir=...) with a serverDir to execute the generated cards'
      : 'run mcdt_gradle (build/GameTest) or start a server, then extend this card',
  };
}

export function safeInit(options) {
  try {
    return initProject(options);
  } catch (error) {
    return { ok: false, error: shortError(error) };
  }
}
