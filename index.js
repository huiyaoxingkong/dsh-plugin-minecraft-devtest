import { defineTool } from '@deepseek-ai/dsh-tools';
import { resolve } from 'node:path';
import { serverManager } from './lib/server.js';
import { botManager } from './lib/bot.js';
import * as datapack from './lib/datapack.js';
import { runCardFile, runSteps, runSuite } from './lib/cards.js';
import { buildApi, quickcheck, collectLogProblems } from './lib/quickcheck.js';
import { initProject } from './lib/init.js';
import { runGradle } from './lib/gradle.js';
import { guide, guideTopics } from './lib/guide.js';
import { bridgeStatus, installBridge, removeBridge } from './lib/bridge.js';
import { dataPackSupported } from './lib/versions.js';
import { normalizeCmd, shortError, summarizeTail, tailFileLines } from './lib/util.js';

export const name = 'minecraft-devtest';
export const inject = ['tools'];

function resultTool(name, description, parameters, handler) {
  return defineTool({
    name,
    description,
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args) {
      try {
        const data = await handler(args ?? {});
        return { text: JSON.stringify(data) };
      } catch (error) {
        return { text: JSON.stringify({ ok: false, error: shortError(error) }) };
      }
    },
  });
}

const FACE = { type: 'string', enum: ['up', 'down', 'north', 'south', 'east', 'west'] };

function botParams(args) {
  const out = {};
  for (const key of ['x', 'y', 'z', 'player', 'message', 'item', 'count', 'slot', 'from', 'to', 'face', 'ms', 'limit', 'name', 'target']) {
    if (args[key] !== undefined) out[key] = args[key];
  }
  return out;
}

export function apply(ctx) {
  if (typeof ctx.effect === 'function') {
    try {
      ctx.effect(() => () => {
        try {
          botManager.leave().catch(() => {});
        } catch {
          // ignore
        }
        try {
          serverManager.stop().catch(() => {});
        } catch {
          // ignore
        }
      });
    } catch {
      // effect unavailable
    }
  }

  ctx.tools.register(resultTool(
    'mcdt_server',
    'Start, stop, inspect or read logs of a headless Minecraft server (no game client needed). Jar mode runs "java -jar server.jar nogui"; gradle mode runs "gradlew.bat runServer" (or a custom task). Before start it writes eula.txt and patches server.properties (offline mode, RCON, port), keeping other keys and a backup.',
    {
      action: { type: 'string', required: true, enum: ['start', 'stop', 'status', 'logs'], description: 'start | stop | status | logs' },
      mode: { type: 'string', enum: ['auto', 'jar', 'fabric', 'script', 'gradle'], description: 'auto: explicit jar > fabric-server-launch.jar > run script > server.jar > sibling server-<version>.jar; gradle needs projectDir' },
      serverDir: { type: 'string', description: 'Absolute server directory (server.jar / fabric-server-launch.jar / run.bat / server.properties)' },
      projectDir: { type: 'string', description: 'Absolute Gradle project directory containing gradlew.bat' },
      runDir: { type: 'string', description: 'Gradle mode: run directory holding server.properties (auto-detected)' },
      task: { type: 'string', description: 'Gradle task, default runServer' },
      jar: { type: 'string', description: 'Explicit server jar path (may live outside serverDir, e.g. a sibling server-1.20.1.jar)' },
      port: { type: 'integer', description: 'Override server-port; default: reuse the value in server.properties' },
      rconPort: { type: 'integer', description: 'Override rcon.port; default: reuse the value in server.properties' },
      rconPassword: { type: 'string', description: 'Override rcon.password; default: reuse the value in server.properties' },
      javaPath: { type: 'string', description: 'Java executable path (auto-detected)' },
      memoryMb: { type: 'integer', description: 'JVM -Xmx in MB, default 1320' },
      timeoutMs: { type: 'integer', description: 'Startup timeout in ms, default 180000' },
      levelName: { type: 'string', description: 'level-name written to server.properties, default world' },
      lines: { type: 'integer', description: 'logs action: number of tail lines, default 100' },
    },
    async (args) => {
      const action = String(args.action ?? 'status');
      if (action === 'start') {
        const run = await serverManager.start({
          mode: args.mode,
          serverDir: args.serverDir,
          projectDir: args.projectDir,
          runDir: args.runDir,
          task: args.task,
          jar: args.jar,
          port: args.port,
          rconPort: args.rconPort,
          rconPassword: args.rconPassword,
          javaPath: args.javaPath,
          memoryMb: args.memoryMb,
          timeoutMs: args.timeoutMs,
          levelName: args.levelName,
        });
        return { ok: true, run };
      }
      if (action === 'stop') {
        return { ok: true, ...(await serverManager.stop()) };
      }
      if (action === 'logs') {
        return { ok: true, lines: serverManager.logTail(args.lines ?? 100), logPath: serverManager.logPath };
      }
      return { ok: true, ...serverManager.status() };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_command',
    'Run a Minecraft server console command over RCON and return the server response text. Use for assertions such as "data get block", "execute if block", "scoreboard players get", "datapack list", "time query gametime".',
    {
      cmd: { type: 'string', required: true, description: 'Command without or with a leading slash, e.g. "time query gametime"' },
    },
    async (args) => {
      if (!serverManager.status().active) {
        throw new Error('mcdt_command only talks to the test server started by mcdt_server in this session. Start it first: mcdt_server action=start serverDir=...');
      }
      const result = await serverManager.command(normalizeCmd(args.cmd));
      return { ok: true, command: result.command, response: result.response, ms: result.ms };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_bot',
    'A Mineflayer player bot that replaces the game client for client-free player-level tests: chat, walk, dig, place, craft, use blocks and items, open containers, fight and inspect state. It can only join the test server started by mcdt_server in this session (no arbitrary host/port). Fabric/vanilla/Paper servers accept it directly; modded Forge 1.20.1 test servers need the bundled dedicated bridge mod (mcdt_bridge install).',
    {
      action: {
        type: 'string',
        required: true,
        enum: [
          'join', 'leave', 'state', 'chat', 'goto', 'look', 'dig', 'place', 'use_block', 'use_item',
          'inventory', 'equip', 'craft', 'open_container', 'container_move', 'close_container',
          'attack', 'eat', 'drop', 'wait', 'chat_history',
        ],
        description: 'Bot action',
      },
      username: { type: 'string', description: 'join: bot username, default DSH_Bot' },
      timeoutMs: { type: 'integer', description: 'join: timeout in ms, default 30000' },
      x: { type: 'integer', description: 'target block/position X' },
      y: { type: 'integer', description: 'target block/position Y' },
      z: { type: 'integer', description: 'target block/position Z' },
      player: { type: 'string', description: 'goto/attack: player name' },
      message: { type: 'string', description: 'chat: text to send' },
      item: { type: 'string', description: 'item name such as minecraft:dirt' },
      count: { type: 'integer', description: 'count for craft/drop/container_move, default 1' },
      slot: { type: 'integer', description: 'inventory/container slot index' },
      from: { type: 'integer', description: 'container_move: source window slot index' },
      to: { type: 'integer', description: 'container_move: destination window slot index' },
      face: FACE,
      ms: { type: 'integer', description: 'wait: milliseconds' },
      limit: { type: 'integer', description: 'chat_history: number of messages, default 20' },
      name: { type: 'string', description: 'craft/equip/drop: item name' },
    },
    async (args) => {
      const action = String(args.action ?? 'state');
      if (action === 'join') {
        const status = serverManager.status();
        if (!status.active) {
          throw new Error('mcdt_bot joins only the test server started by mcdt_server in this session. Start it first: mcdt_server action=start serverDir=...');
        }
        const joined = await botManager.join({
          host: '127.0.0.1',
          port: status.port,
          username: args.username ?? 'DSH_Bot',
          version: status.version ?? undefined,
          timeoutMs: args.timeoutMs,
        });
        return { ok: true, ...joined };
      }
      if (action === 'leave') {
        return { ok: true, ...(await botManager.leave()) };
      }
      if (action === 'state') {
        return { ok: true, state: botManager.state() };
      }
      if (action === 'chat_history') {
        const state = botManager.state();
        return { ok: true, messages: (state.chat ?? []).slice(-(args.limit ?? 20)) };
      }
      const result = await botManager.action(action, botParams(args));
      return { ok: true, action, result };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_datapack',
    'Inspect, validate, deploy and reload Minecraft datapacks without a game client. scan/find/validate a pack structure against the expected pack format; deploy copies a pack into the test server world datapacks and reload/list run /reload and /datapack list over RCON. deploy/reload/list only work on the test server started by mcdt_server in this session.',
    {
      action: { type: 'string', required: true, enum: ['scan', 'find', 'validate', 'deploy', 'reload', 'list'], description: 'Datapack action' },
      dir: { type: 'string', description: 'Datapack directory (pack root with pack.mcmeta) or project root for find' },
      packDir: { type: 'string', description: 'Alias of dir' },
      levelName: { type: 'string', description: 'World level name, defaults to the running test server' },
      expectedFormat: { type: 'integer', description: 'Expected data pack_format; defaults to the running server version' },
    },
    async (args) => {
      const targetDir = args.dir ?? args.packDir;
      const action = String(args.action ?? 'scan');
      const active = serverManager.status();
      const serverDir = active.runDir ?? active.dir;
      const levelName = args.levelName ?? active.levelName ?? 'world';
      if (action === 'find') {
        if (!targetDir) throw new Error('find needs dir (project root)');
        return { ok: true, packs: datapack.findPacks(resolve(targetDir)) };
      }
      if (action === 'scan') {
        if (!targetDir) throw new Error('scan needs dir (pack root)');
        return { ok: true, ...datapack.scanPack(resolve(targetDir)) };
      }
      if (action === 'validate') {
        if (!targetDir) throw new Error('validate needs dir (pack root)');
        const expectedFormat = args.expectedFormat ?? (await datapack.readServerPackVersion(serverDir ?? targetDir))?.dataFormat ?? null;
        const result = datapack.validatePack(resolve(targetDir), { expectedFormat });
        return { ok: result.ok, ...result };
      }
      if (!active.active) {
        throw new Error('deploy/reload/list only work on the test server started by mcdt_server in this session; start it first');
      }
      if (active.version && !dataPackSupported(active.version)) {
        throw new Error(`Minecraft ${active.version} 没有数据包（datapack）功能：数据包从 1.13 开始支持；请改用 RCON 命令/GameTest 断言`);
      }
      if (action === 'deploy') {
        if (!targetDir) throw new Error('deploy needs dir (pack root)');
        return { ok: true, ...(await datapack.deployPack(serverDir, resolve(targetDir), { levelName })) };
      }
      if (action === 'reload') {
        const result = await serverManager.command('reload');
        return { ok: true, response: result.response };
      }
      if (action === 'list') {
        const result = await serverManager.command('datapack list');
        return { ok: true, response: result.response };
      }
      throw new Error(`unknown datapack action: ${action}`);
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_bridge',
    'Manage the dedicated test bridge mod that lets the vanilla-protocol player bot join a modded Forge 1.20.1 test server. The bridge is written for this plugin (no third-party mods) and shipped in vendor/. status scans the server loader/version and reports whether the bridge is installed; install copies the bundled jar into <serverDir>/mods (server must be stopped, restart to load); remove deletes only bridge jars installed by this plugin.',
    {
      action: { type: 'string', required: true, enum: ['status', 'install', 'remove'], description: 'Bridge action' },
      serverDir: { type: 'string', description: 'Server directory; defaults to the server started by mcdt_server' },
    },
    async (args) => {
      const running = serverManager.status();
      const serverDir = args.serverDir ? resolve(String(args.serverDir)) : running.dir ?? null;
      if (!serverDir) throw new Error('mcdt_bridge needs serverDir (or a test server started by mcdt_server)');
      const action = String(args.action ?? 'status');
      if (action === 'status') {
        return { ok: true, ...bridgeStatus({ serverDir }) };
      }
      if (running.active && resolve(String(running.dir ?? '')) === serverDir) {
        throw new Error('stop the test server before changing its mods (mcdt_server action=stop), then install/remove the bridge and start it again');
      }
      if (action === 'install') {
        const result = installBridge({ serverDir });
        return { ok: true, ...result, note: result.installed ? 'bridge installed; start the test server to load it' : result.note };
      }
      if (action === 'remove') {
        return { ok: true, ...removeBridge({ serverDir }) };
      }
      throw new Error(`unknown bridge action: ${action}`);
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_test',
    'Run a deterministic YAML test card (or inline steps) against the headless server and player bot, and return a compact pass/fail report. This is the token-saving path: write many assertions into one card, the plugin executes them locally. Steps: command, bot, datapack, gradle, server, assert, wait, note, snapshot. Stops at the first failure by default.',
    {
      card: { type: 'string', description: 'Absolute path to a YAML/JSON test card' },
      steps: { type: 'array', items: { type: 'object', additionalProperties: true }, description: 'Inline steps (when card is omitted)' },
      dryRun: { type: 'boolean', description: 'Translate the card and validate steps without executing them' },
      stopOnFail: { type: 'boolean', description: 'Stop at the first failed step, default true' },
      verbose: { type: 'boolean', description: 'Include per-step return data in the report' },
      serverDir: { type: 'string', description: 'Default server directory for datapack steps' },
      projectDir: { type: 'string', description: 'Default project directory for gradle steps' },
      levelName: { type: 'string', description: 'Default world level name, default world' },
    },
    async (args) => {
      const api = buildApi({ serverDir: args.serverDir, projectDir: args.projectDir, levelName: args.levelName });
      const options = { dryRun: args.dryRun === true, stopOnFail: args.stopOnFail !== false };
      let result;
      if (args.card) result = await runCardFile(args.card, api, options);
      else if (Array.isArray(args.steps)) result = await runSteps(args.steps, api, options);
      else throw new Error('mcdt_test needs card or steps');
      const steps = (result.steps ?? []).map((step, index) => {
        const entry = { i: index, type: step.type, ok: step.ok === true };
        if (step.ms !== undefined) entry.ms = step.ms;
        if (step.ok !== true) entry.error = step.error;
        if (args.verbose === true) entry.data = step.data;
        return entry;
      });
      return {
        ok: result.ok === true,
        id: result.id ?? null,
        failedAt: result.failedAt ?? null,
        warnings: result.warnings ?? [],
        steps,
      };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_suite',
    'Run every YAML test card in a directory and return one compact summary (failures only by default). Use this after edits to re-verify a whole test set without spending tokens per case.',
    {
      dir: { type: 'string', required: true, description: 'Directory containing *.yml / *.yaml / *.json cards' },
      dryRun: { type: 'boolean', description: 'Translate cards only' },
      stopOnFail: { type: 'boolean', description: 'Stop the whole suite at the first failing card, default false' },
      filter: { type: 'string', description: 'Only run card files whose name/path contains this substring' },
      serverDir: { type: 'string', description: 'Default server directory for datapack steps' },
      projectDir: { type: 'string', description: 'Default project directory for gradle steps' },
      levelName: { type: 'string', description: 'Default world level name' },
      verbose: { type: 'boolean', description: 'Include per-card step reports' },
    },
    async (args) => {
      const api = buildApi({ serverDir: args.serverDir, projectDir: args.projectDir, levelName: args.levelName });
      const result = await runSuite(resolve(args.dir), api, {
        dryRun: args.dryRun === true,
        stopOnFail: args.stopOnFail === true,
        filter: args.filter,
      });
      return {
        ok: result.ok === true,
        total: result.total,
        passed: result.passed,
        failed: result.failed,
        warnings: result.warnings ?? [],
        cards: (result.cards ?? []).map((card) => {
          const entry = { id: card.id, file: card.file, ok: card.ok === true };
          if (card.ms !== undefined) entry.ms = card.ms;
          if (card.ok !== true) {
            entry.failedAt = card.failedAt;
            entry.error = card.error;
            if (args.verbose === true) entry.steps = card.steps;
          }
          return entry;
        }),
      };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_quickcheck',
    'One-call deterministic health check for a Minecraft datapack / mod project / server directory: static validation, headless server start, RCON smoke, datapack deploy + reload + datapack list, log error scan, and a player-bot join/chat smoke test. Returns a compact check list so common checks do not need any model round-trips.',
    {
      projectDir: { type: 'string', description: 'Datapack project root or Gradle mod project root' },
      serverDir: { type: 'string', description: 'Server directory used to run the checks' },
      mode: { type: 'string', enum: ['auto', 'datapack', 'mod', 'server'], description: 'What to check, default auto-detect' },
      startServer: { type: 'boolean', description: 'Start the server when it is not running, default true' },
      build: { type: 'boolean', description: 'Mod mode: also run gradlew build (slow)' },
      buildTask: { type: 'string', description: 'Mod mode build task, default build' },
      useBot: { type: 'boolean', description: 'Run the player-bot smoke test, default true' },
      username: { type: 'string', description: 'Bot username, default DSH_Bot' },
      launchMode: { type: 'string', enum: ['auto', 'jar', 'fabric', 'script', 'gradle'], description: 'How to launch the test server; default auto-detect' },
      jar: { type: 'string', description: 'Explicit server jar path (jar mode), may live outside serverDir' },
      installBridge: { type: 'boolean', description: 'Forge/NeoForge test servers: install the bundled dedicated bridge mod before starting, default true' },
      javaPath: { type: 'string', description: 'Java executable path (needed for 1.20.5+ servers, e.g. a JDK 21)' },
      memoryMb: { type: 'integer', description: 'JVM -Xmx in MB, default 1320' },
      port: { type: 'integer', description: 'Server port override (otherwise server.properties wins)' },
      rconPort: { type: 'integer', description: 'RCON port override (otherwise server.properties wins)' },
      rconPassword: { type: 'string', description: 'RCON password override (otherwise server.properties wins)' },
      levelName: { type: 'string', description: 'World level name, default world' },
      expectedFormat: { type: 'integer', description: 'Expected data pack_format override' },
      keepServer: { type: 'boolean', description: 'Keep the server running after the checks' },
      timeoutMs: { type: 'integer', description: 'Server startup timeout, default 180000' },
    },
    async (args) => quickcheck({ ...args }),
  ));

  ctx.tools.register(resultTool(
    'mcdt_gradle',
    'Run any Gradle task in a Minecraft project (build, runGameTestServer, runServer, genSources, ...). Returns exit code, a parsed GameTest/BUILD summary and a trimmed log tail. runGameTestServer is the client-free way to verify Forge/NeoForge mod logic.',
    {
      projectDir: { type: 'string', required: true, description: 'Absolute Gradle project directory containing gradlew.bat' },
      task: { type: 'string', description: 'Gradle task, default build' },
      timeoutMs: { type: 'integer', description: 'Timeout in ms, default 900000' },
      args: { type: 'array', items: { type: 'string' }, description: 'Extra Gradle arguments' },
      tailChars: { type: 'integer', description: 'Log tail characters to return, default 4000' },
    },
    async (args) => {
      const result = await runGradle(resolve(args.projectDir), args.task ?? 'build', {
        timeoutMs: args.timeoutMs ?? 900000,
        args: args.args ?? [],
      });
      return {
        ok: result.exitCode === 0,
        task: result.task,
        exitCode: result.exitCode,
        timedOut: result.timedOut,
        summary: result.summary,
        tail: summarizeTail(result.tail, args.tailChars ?? 4000),
      };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_init',
    'Generate a starter test-card directory (default <projectDir>/mc-tests) for a datapack or Gradle mod project. The generated card contains only safe, repeatable checks (deploy, reload, datapack list, recipe existence, block loot tables, bot join/state/leave) and TODO notes for behavior that needs hand-written assertions. Pass overwrite=true to replace an existing card.',
    {
      projectDir: { type: 'string', required: true, description: 'Datapack project root or Gradle mod project root' },
      outDir: { type: 'string', description: 'Output directory for cards, default <projectDir>/mc-tests' },
      username: { type: 'string', description: 'Bot username used in generated assertions, default CardBot' },
      overwrite: { type: 'boolean', description: 'Replace an existing generated card and README' },
    },
    async (args) => initProject({ ...args }),
  ));

  ctx.tools.register(resultTool(
    'mcdt_logs',
    'Read or summarize the log of the test server started by mcdt_server in this session (no arbitrary files): mode=tail returns recent lines, mode=errors returns parsed ERROR/exception lines plus datapack-load problems, version and loader.',
    {
      mode: { type: 'string', enum: ['tail', 'errors'], description: 'tail or errors, default tail' },
      lines: { type: 'integer', description: 'tail line count, default 100' },
    },
    async (args) => {
      const mode = String(args.mode ?? 'tail');
      if (!serverManager.status().active && !serverManager.logPath) {
        throw new Error('mcdt_logs reads only the log of the test server started by mcdt_server in this session; start it first');
      }
      const logPath = serverManager.logPath;
      if (mode === 'errors') {
        const text = logPath ? tailFileLines(logPath, 4000).join('\n') : serverManager.logTail(4000).join('\n');
        const problems = collectLogProblems(text);
        return {
          ok: true,
          source: logPath ?? 'memory',
          version: problems.parsed.version,
          loader: problems.parsed.loader,
          errors: problems.parsed.errors.slice(0, args.lines ?? 20),
          warnings: problems.parsed.warnings.slice(0, 10),
          datapackProblems: problems.datapackProblems,
        };
      }
      const lines = logPath ? tailFileLines(logPath, args.lines ?? 100) : serverManager.logTail(args.lines ?? 100);
      return { ok: true, source: logPath ?? 'memory', lines };
    },
  ));

  ctx.tools.register(resultTool(
    'mcdt_guide',
    'Built-in guidance to save round-trips and web research: server setup, datapack format/checks, player-bot usage, test-card syntax, version tables and common error meanings.',
    {
      topic: { type: 'string', enum: guideTopics(), description: 'Guide topic, default overview' },
    },
    async (args) => ({ ok: true, topic: args.topic ?? 'overview', text: guide(args.topic) }),
  ));
}
