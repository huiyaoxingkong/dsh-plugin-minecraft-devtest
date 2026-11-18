import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { isWindows, spawnCollect, summarizeTail } from './util.js';

const MAX_TAIL = 12000;

function findWrapper(projectDir) {
  const candidates = isWindows
    ? [join(projectDir, 'gradlew.bat'), join(projectDir, 'gradlew')]
    : [join(projectDir, 'gradlew')];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

function quoteArg(value) {
  const text = String(value);
  return /[\s"]/.test(text) ? `"${text.replace(/"/g, '\\"')}"` : text;
}

export function summarizeGameTest(output) {
  const text = String(output ?? '');
  const passed = /All (\d+) required tests passed/i.exec(text);
  if (passed) return `All ${passed[1]} required tests passed`;
  const failed = /(\d+) required tests failed/i.exec(text);
  if (failed) return `${failed[1]} required tests failed`;
  const success = /BUILD SUCCESSFUL/i.test(text);
  const failure = /BUILD FAILED/i.test(text);
  if (success) return 'BUILD SUCCESSFUL';
  if (failure) return 'BUILD FAILED';
  return 'no summary';
}

export async function runGradle(projectDir, task, { timeoutMs = 900000, args = [], env = {} } = {}) {
  const wrapper = findWrapper(projectDir);
  if (!wrapper) throw new Error(`no gradlew / gradlew.bat found in ${projectDir}`);
  const requested = String(task ?? 'build').trim() || 'build';
  const extra = Array.isArray(args) ? args.map(String) : [];
  let result;
  if (isWindows) {
    const command = [quoteArg(wrapper), quoteArg(requested), ...extra.map(quoteArg)].join(' ');
    result = await spawnCollect(command, [], { cwd: projectDir, timeoutMs, env, shell: true });
  } else {
    result = await spawnCollect(wrapper, [requested, ...extra], { cwd: projectDir, timeoutMs, env });
  }
  const summary = summarizeGameTest(result.output);
  return {
    task: requested,
    exitCode: result.code,
    timedOut: result.timedOut,
    summary,
    output: result.output,
    tail: summarizeTail(result.output, MAX_TAIL),
  };
}

export { summarizeTail };
