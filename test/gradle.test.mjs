import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runGradle, summarizeGameTest } from '../lib/gradle.js';

test('summarizeGameTest parses pass/fail/build summaries', () => {
  assert.equal(summarizeGameTest('All 12 required tests passed'), 'All 12 required tests passed');
  assert.equal(summarizeGameTest('3 required tests failed'), '3 required tests failed');
  assert.equal(summarizeGameTest('BUILD SUCCESSFUL in 3s'), 'BUILD SUCCESSFUL');
  assert.equal(summarizeGameTest('BUILD FAILED in 1s'), 'BUILD FAILED');
  assert.equal(summarizeGameTest('nothing here'), 'no summary');
});

test('runGradle throws when the project has no wrapper', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-gradle-missing-'));
  await assert.rejects(() => runGradle(dir, 'build'), /no gradlew/);
});

test('runGradle runs the wrapper and returns exit code and summary', async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-mcdevtest-gradle-'));
  const windows = process.platform === 'win32';
  const wrapper = join(dir, windows ? 'gradlew.bat' : 'gradlew');
  const script = windows
    ? ['@echo off', 'echo All 2 required tests passed', 'exit /b 0'].join('\r\n')
    : ['#!/bin/sh', 'echo "All 2 required tests passed"', 'exit 0'].join('\n');
  writeFileSync(wrapper, script);
  if (!windows) chmodSync(wrapper, 0o755);
  const result = await runGradle(dir, 'runGameTestServer', { timeoutMs: 30000 });
  assert.equal(result.task, 'runGameTestServer');
  assert.equal(result.exitCode, 0);
  assert.equal(result.summary, 'All 2 required tests passed');
  assert.match(result.output, /required tests passed/);
  assert.match(result.tail, /required tests passed/);
});
