import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import * as datapack from './datapack.js';
import { serverManager } from './server.js';
import { botManager } from './bot.js';
import { bridgeStatus, installBridge, detectLoader } from './bridge.js';
import { runGradle } from './gradle.js';
import { dataPackSupported, packFormatForVersion } from './versions.js';
import {
  dataPackFormatForVersion,
  findJava,
  parseMinecraftLog,
  shortError,
  sleep,
  summarizeTail,
} from './util.js';

const DATAPACK_LOG_PATTERNS = [
  /Failed to load function/i,
  /Couldn't parse element/i,
  /Failed to parse recipe/i,
  /Unknown recipe/i,
  /Error while reloading data packs/i,
  /Whilst parsing command/i,
  /Failed to load datapack/i,
  /Invalid pack format/i,
  /Registry entry not registered/i,
  /Missing pack format/i,
  /Couldn't load tag/i,
  /missing following references/i,
  /Failed to load tag/i,
  /Pack declares support for version newer/i,
  /missing mandatory fields min_format/i,
];

function exists(path) {
  return !!path && existsSync(path);
}

function detectMode({ projectDir, serverDir, mode }) {
  if (mode && mode !== 'auto') return mode;
  if (projectDir && (exists(join(projectDir, 'pack.mcmeta')) || exists(join(projectDir, 'data')) || exists(join(projectDir, 'datapacks')))) return 'datapack';
  if (projectDir && (exists(join(projectDir, 'gradlew.bat')) || exists(join(projectDir, 'gradlew')) || exists(join(projectDir, 'build.gradle')) || exists(join(projectDir, 'build.gradle.kts')))) return 'mod';
  if (serverDir && (exists(join(serverDir, 'server.jar')) || exists(join(serverDir, 'eula.txt')) || exists(join(serverDir, 'server.properties')) || exists(join(serverDir, 'fabric-server-launch.jar')) || exists(join(serverDir, 'run.bat')))) return 'server';
  return 'server';
}

export function collectLogProblems(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const datapackProblems = lines.filter((line) => DATAPACK_LOG_PATTERNS.some((pattern) => pattern.test(line))).slice(-10);
  const parsed = parseMinecraftLog(text);
  return { datapackProblems, parsed };
}

function runDirsOf(projectDir) {
  if (!projectDir) return [];
  const candidates = [join(projectDir, 'run'), join(projectDir, 'runs', 'server'), join(projectDir, 'runs', 'client')];
  return candidates.filter((dir) => exists(join(dir, 'server.properties')) || exists(join(dir, 'eula.txt')));
}

function isLoopbackHost(host) {
  return /^(127\.0\.0\.1|localhost|::1)$/i.test(String(host ?? '127.0.0.1'));
}

export function buildApi({ serverDir, projectDir, levelName = 'world', command } = {}) {
  const runCommand = command ?? ((cmd) => serverManager.command(cmd));
  return {
    command: (cmd) => runCommand(cmd),
    bot: async (action, params = {}) => {
      const name = String(action ?? '');
      if (name === 'join') {
        const status = serverManager.status();
        if (!status.active) {
          throw new Error('cards may only join the test server started by mcdt_server in this session; start it first');
        }
        if (params.host !== undefined && !isLoopbackHost(params.host)) {
          throw new Error('cards may only join the local test server (host must be 127.0.0.1/localhost)');
        }
        return botManager.join({
          host: '127.0.0.1',
          port: status.port,
          username: params.username ?? 'CardBot',
          version: params.version ?? status.version ?? undefined,
          timeoutMs: params.timeoutMs,
        });
      }
      if (name === 'leave') return botManager.leave();
      if (name === 'state') return botManager.state();
      return botManager.action(name, params);
    },
    botState: () => botManager.state(),
    datapack: async (action, params = {}) => {
      const dir = params.dir ?? params.packDir;
      const targetServerDir = params.serverDir ?? serverDir ?? serverManager.status().dir;
      const targetLevel = params.levelName ?? levelName;
      switch (String(action ?? '')) {
        case 'scan':
          return datapack.scanPack(resolve(dir));
        case 'find':
          return { packs: datapack.findPacks(resolve(dir ?? projectDir ?? '.')) };
        case 'validate': {
          const expectedFormat = params.expectedFormat ?? (await datapack.readServerPackVersion(targetServerDir))?.dataFormat ?? null;
          return datapack.validatePack(resolve(dir), { expectedFormat });
        }
        case 'deploy':
          return datapack.deployPack(targetServerDir, resolve(dir), { levelName: targetLevel });
        case 'reload':
          return { response: (await runCommand('reload')).response };
        case 'list':
          return { response: (await runCommand('datapack list')).response };
        default:
          throw new Error(`unknown datapack action: ${String(action)}`);
      }
    },
    gradle: (task, opts = {}) => runGradle(opts.projectDir ?? projectDir, task ?? 'build', opts),
    serverStatus: () => serverManager.status(),
    sleep,
    log: () => {},
  };
}

/**
 * One-call deterministic health check for a test server / datapack project / mod project.
 * It can only use the server it starts itself through mcdt_server (no arbitrary RCON targets).
 */
export async function quickcheck(options = {}) {
  const startTime = Date.now();
  const checks = [];
  const warnings = [];
  const errors = [];
  const projectDir = options.projectDir ? resolve(String(options.projectDir)) : null;
  const serverDir = options.serverDir ? resolve(String(options.serverDir)) : null;
  const levelName = options.levelName ?? 'world';
  const mode = detectMode({ projectDir, serverDir, mode: options.mode });
  const check = (name, ok, detail) => {
    const entry = { name, ok: ok === true };
    if (detail !== undefined && detail !== null && detail !== '') entry.detail = String(detail).slice(0, 600);
    checks.push(entry);
    return entry.ok;
  };

  let startedInfo = null;
  let stopped = false;
  let botJoined = false;
  let serverVersion = null;
  let status = serverManager.status();

  // 0. Prepare the bundled dedicated Forge test bridge while the server is stopped.
  let bridgeReport = null;
  if (serverDir && options.useBot !== false && options.installBridge !== false && !status.active) {
    try {
      const detected = detectLoader(serverDir);
      if (detected.loader === 'forge' || detected.loader === 'neoforge') {
        const current = bridgeStatus({ serverDir });
        bridgeReport = current;
        if (current.supported && !current.installed) {
          bridgeReport = installBridge({ serverDir });
          warnings.push('installed the bundled dedicated Forge test bridge into the test server mods/ (vanilla-protocol bot can join)');
        }
      }
    } catch (error) {
      warnings.push(`forge test bridge preparation skipped: ${shortError(error)}`);
    }
  }

  try {
    // 1. static project checks
    if (mode === 'datapack') {
      check('datapack project detected', !!projectDir && (exists(join(projectDir, 'pack.mcmeta')) || exists(join(projectDir, 'data'))), projectDir ?? undefined);
    } else if (mode === 'mod') {
      check('gradle project detected', !!projectDir && (exists(join(projectDir, 'gradlew.bat')) || exists(join(projectDir, 'gradlew'))), projectDir ?? undefined);
      check('java available', !!findJava(), findJava());
      const dirs = runDirsOf(projectDir);
      check('run directory found', dirs.length > 0, dirs.join(', ') || 'no run/server.properties found');
    } else {
      check('server directory found', !!serverDir, serverDir ?? 'pass serverDir');
    }

    // 2. datapack static validation & version detection
    let pack = null;
    let expectedFormat = options.expectedFormat ?? null;
    let packsSupported = true;
    if (mode === 'datapack') {
      const packs = projectDir ? datapack.findPacks(projectDir) : [];
      check('datapack found', packs.length > 0, packs.map((entry) => entry.dir).join(', ') || undefined);
      pack = packs[0] ?? null;
      if (pack) {
        const probe = await datapack.readServerPackVersion(serverDir ?? projectDir ?? pack.dir).catch(() => null);
        serverVersion = probe?.version ?? null;
        const detected = probe?.dataFormat ?? dataPackFormatForVersion(serverVersion) ?? packFormatForVersion(serverVersion);
        if (expectedFormat == null && detected != null) expectedFormat = detected;
        packsSupported = !serverVersion || dataPackSupported(serverVersion);
        if (!packsSupported) {
          warnings.push(`Minecraft ${serverVersion} 没有数据包（datapack）功能：数据包从 1.13 开始支持，跳过部署/重载检查`);
        }
        const scan = datapack.scanPack(pack.dir);
        check('datapack scanned', scan.ok, `functions=${scan.counts?.functions ?? 0} recipes=${scan.counts?.recipes ?? 0} loot=${scan.counts?.lootTables ?? 0} advancements=${scan.counts?.advancements ?? 0}`);
        const validation = datapack.validatePack(pack.dir, { expectedFormat });
        check('datapack validates', validation.ok, validation.errors.slice(0, 6).map((entry) => `${entry.file}: ${entry.message}`).join(' | ') || undefined);
        for (const warning of validation.warnings ?? []) {
          const text = warning && typeof warning === 'object' ? warning.message ?? JSON.stringify(warning) : String(warning);
          warnings.push(text);
        }
        if (scan.errors?.length) errors.push(...scan.errors.map((entry) => `${entry.file}: ${entry.message}`));
      }
    }

    // 3. optional gradle build for mod projects
    if (mode === 'mod' && options.build === true) {
      const result = await runGradle(projectDir, options.buildTask ?? 'build', {
        timeoutMs: options.gradleTimeoutMs ?? 900000,
      });
      check('gradlew build', result.exitCode === 0, summarizeTail(result.tail, 1200));
    }

    // 4. start the managed test server when needed
    const needServer = mode === 'datapack' || mode === 'server' || (mode === 'mod' && options.startServer !== false);
    status = serverManager.status();
    if (needServer && !status.active) {
      if (options.startServer === false) {
        warnings.push('server is not running and startServer=false; server-side checks skipped');
      } else {
        try {
          startedInfo = await serverManager.start({
            mode: options.launchMode ?? 'auto',
            serverDir: serverDir ?? undefined,
            projectDir: projectDir ?? undefined,
            runDir: options.runDir,
            task: options.task ?? 'runServer',
            jar: options.jar,
            port: options.port,
            rconPort: options.rconPort,
            rconPassword: options.rconPassword,
            javaPath: options.javaPath,
            memoryMb: options.memoryMb,
            timeoutMs: options.timeoutMs ?? 180000,
            levelName,
          });
          status = serverManager.status();
          serverVersion = status.version ?? serverVersion;
          check('server started', true, `${startedInfo.mode} port=${startedInfo.port} log=${startedInfo.logPath}`);
        } catch (error) {
          check('server started', false, shortError(error));
          return finish();
        }
      }
    } else if (status.active) {
      check('server already running', true, `port=${status.port} rcon=${status.rconPort}`);
    }

    // 5. server-side checks
    if (serverManager.status().active) {
      const active = serverManager.status();
      try {
        const list = await serverManager.command('list');
        check('rcon responsive', true, list.response.slice(0, 300));
      } catch (error) {
        check('rcon responsive', false, shortError(error));
      }
      const logText = serverManager.logTail(500).join('\n');
      const { datapackProblems, parsed } = collectLogProblems(logText);
      check('log has no errors', parsed.errors.length === 0, parsed.errors.slice(0, 5).join(' | ') || undefined);
      if (datapackProblems.length > 0) check('no datapack load errors', false, datapackProblems.join(' | '));
      else check('no datapack load errors', true);

      // 6. datapack live checks
      const livePacksSupported = !active.version || dataPackSupported(active.version);
      if (mode === 'datapack' && pack && livePacksSupported) {
        const dir = serverDir ?? active.runDir ?? active.dir;
        try {
          if (!dir) throw new Error('datapack deploy needs serverDir');
          const deployed = await datapack.deployPack(dir, pack.dir, { levelName });
          check('datapack deployed', !!deployed.deployed, deployed.target);
          await serverManager.command('reload');
          await sleep(900);
          const listed = await serverManager.command('datapack list');
          check('datapack listed', listed.response.includes(pack.name), listed.response.slice(0, 400));
          const after = collectLogProblems(serverManager.logTail(400).join('\n'));
          check('reload clean', after.datapackProblems.length === 0, after.datapackProblems.join(' | ') || undefined);
          if (after.parsed.errors.length > 0) errors.push(...after.parsed.errors.slice(0, 10));
        } catch (error) {
          check('datapack live check', false, shortError(error));
        }
      }

      // 7. bot smoke (client-free player simulation)
      const loader = active.loader;
      if (options.useBot !== false) {
        const forgeLike = loader === 'forge' || loader === 'neoforge';
        if (forgeLike) {
          const bridge = serverDir ? bridgeStatus({ serverDir }) : null;
          bridgeReport = bridge ?? bridgeReport;
          if (!bridge?.installed) {
            warnings.push('bot smoke skipped: Forge/NeoForge server without the bundled bridge mod; run mcdt_bridge action=install serverDir=... then restart the server');
          }
        }
        if (!forgeLike || bridgeReport?.installed) {
          try {
            const joined = await botManager.join({
              host: '127.0.0.1',
              port: active.port,
              username: options.username ?? 'DSH_Bot',
              version: active.version ?? undefined,
              timeoutMs: options.botTimeoutMs ?? 30000,
            });
            botJoined = true;
            check('bot joined', true, `pos=(${joined.position?.x},${joined.position?.y},${joined.position?.z})`);
            await botManager.action('chat', { message: 'dsh-devtest quickcheck' });
            await sleep(600);
            const chat = botManager.state().chat ?? [];
            check('bot chat observed', chat.some((entry) => String(entry.message ?? '').includes('quickcheck')), `messages=${chat.length}`);
          } catch (error) {
            const message = String(error?.message ?? '');
            const futureMode = error?.support?.mode === 'emulated-future';
            if (message.includes('BOT_VERSION_UNSUPPORTED') || futureMode) {
              warnings.push(`bot smoke skipped: 当前版本机器人不可用（MC ${active.version}，RCON 断言仍可用）：${shortError(error)}`);
            } else {
              check('bot smoke', false, shortError(error));
            }
          }
        }
      }
    }

    // 8. mod project server note
    if (mode === 'mod' && !serverManager.status().active && options.startServer === false) {
      warnings.push('mod server checks skipped (startServer=false)');
    }
  } finally {
    if (botJoined) {
      try {
        await botManager.leave();
      } catch (error) {
        warnings.push(`bot leave failed: ${shortError(error)}`);
      }
    }
    if (startedInfo && options.keepServer !== true) {
      try {
        await serverManager.stop();
        stopped = true;
        check('server stopped', true);
      } catch (error) {
        check('server stopped', false, shortError(error));
      }
    }
  }

  return finish();

  function finish() {
    const ok = checks.every((entry) => entry.ok);
    const statusNow = serverManager.status();
    return {
      ok,
      mode,
      started: !!startedInfo,
      stopped,
      elapsedMs: Date.now() - startTime,
      checks,
      warnings,
      errors: errors.slice(0, 20),
      server: {
        running: !!statusNow.active,
        version: statusNow.version ?? serverVersion,
        loader: statusNow.loader ?? null,
        port: statusNow.port ?? null,
        rconPort: statusNow.rconPort ?? null,
        logPath: statusNow.logPath ?? null,
      },
      bridge: bridgeReport
        ? {
            loader: bridgeReport.loader,
            mcVersion: bridgeReport.mcVersion,
            supported: bridgeReport.supported,
            installed: bridgeReport.installed,
            path: bridgeReport.installedPath ?? null,
            note: bridgeReport.note ?? null,
          }
        : null,
      next: ok
        ? 'quickcheck passed; add project-specific assertions with mcdt_test / mcdt_suite'
        : 'inspect failed checks, then re-run the same quickcheck or a targeted mcdt_test card',
    };
  }
}
