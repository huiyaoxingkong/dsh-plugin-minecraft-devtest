/**
 * minecraft-devtest/lib/cards.js
 *
 * Deterministic YAML test cards: a tiny YAML-subset parser, a card compiler and a
 * sequential executor that turns a card into compressed pass/fail data.
 *
 * The YAML subset parser is adapted from the MIT-licensed minecraft-mod-dev plugin
 * (`D:\Minecraft\dsh-mc\minecraft-mod-dev\repo\plugin\minecraft-mod-dev\index.js`,
 * functions parseYaml / unquote / splitTopLevel / splitKeyValue / parseInlineValue).
 * It was rewritten here to support what test cards actually need:
 *   - multi-line mappings inside sequences (`- type: command` + following `cmd:` lines),
 *   - inline `{...}` / `[...]` collections,
 *   - single/double quoted scalars,
 *   - full-line and trailing comments,
 *   - `|` / `>` block scalars,
 *   - numbers / booleans / null (and `~`),
 *   - syntax errors with line numbers.
 *
 * Public API (see docs/CONTRACTS.md):
 *   parseYaml(text)
 *   parseCardFile(path)
 *   normalizeCard(raw)
 *   cardToSteps(card)
 *   runSteps(steps, api, { stopOnFail = true, dryRun = false, log } = {})
 *   runCardFile(path, api, opts)
 *   runSuite(dir, api, { stopOnFail = false, dryRun = false, filter } = {})
 *
 * `api` is supplied by the caller (lib/quickcheck.js / index.js). This module never
 * imports lib/server.js or lib/bot.js.
 */

import { basename, dirname, extname, relative, resolve } from 'node:path';

import { listFilesRecursive, readTextFile, shortError, sleep as utilSleep } from './util.js';

// ---------------------------------------------------------------------------
// YAML subset parser
// ---------------------------------------------------------------------------

const YAML_BOM = 0xfeff;

function yamlError(lineNo, message) {
  return new Error(`YAML syntax error at line ${lineNo}: ${message}`);
}

function clip(text, max = 120) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, max)}…`;
}

function isBlankLine(line) {
  return /^[ \t]*$/.test(line);
}

function countIndent(text) {
  let count = 0;
  while (count < text.length && text[count] === ' ') count += 1;
  return count;
}

/** Remove a YAML comment from a content line (quotes protect `#`). */
function stripComment(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote === '"') {
      if (ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === '"') quote = null;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") {
        if (text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '#' && (i === 0 || text[i - 1] === ' ' || text[i - 1] === '\t')) {
      return text.slice(0, i);
    }
  }
  return text;
}

/**
 * Split YAML text into content lines. Blank lines and full-line comments are dropped from
 * `entries` (block scalar content is read from `rawLines` directly, using rawIndex).
 */
function tokenizeYaml(text) {
  const rawLines = String(text ?? '').split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < rawLines.length; i += 1) {
    let raw = rawLines[i];
    if (i === 0 && raw.charCodeAt(0) === YAML_BOM) raw = raw.slice(1);
    if (isBlankLine(raw)) continue;

    const leading = raw.slice(0, countIndent(raw));
    const afterIndent = raw.slice(leading.length);
    // A tab anywhere in the indentation is reported when the parser reaches that line.
    if (afterIndent.startsWith('\t')) {
      entries.push({
        indent: leading.length,
        content: afterIndent.trim(),
        lineNo: i + 1,
        rawIndex: i,
        tab: true,
      });
      continue;
    }
    if (afterIndent.startsWith('#')) continue; // full-line comment
    if (/^---[ \t]*$/.test(afterIndent) || /^\.\.\.[ \t]*$/.test(afterIndent)) continue;
    const content = stripComment(afterIndent).replace(/[ \t]+$/, '');
    if (content === '') continue;
    entries.push({ indent: leading.length, content, lineNo: i + 1, rawIndex: i, tab: false });
  }
  return { rawLines, entries };
}

function ensureExpandable(entry) {
  if (entry?.tab) throw yamlError(entry.lineNo, 'tab characters are not allowed for indentation');
}

function isSequenceItem(content) {
  return content === '-' || /^-[ \t]/.test(content);
}

function looksLikeInline(text) {
  return text.startsWith('{') || text.startsWith('[');
}

/** True for `|`, `|-`, `|+`, `>`, `>-`, `>+` (block scalar headers). */
function isBlockScalarHeader(text) {
  return /^[|>](?:[+-])?\d*$/.test(text.trim());
}

function splitKeyValue(text, { requireSpace = true } = {}) {
  let depth = 0;
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === ':' && depth === 0) {
      if (!requireSpace || i === text.length - 1 || /[ \t]/.test(text[i + 1])) {
        return [text.slice(0, i), text.slice(i + 1)];
      }
    }
  }
  return null;
}

function splitTopLevel(text, separator, entry) {
  const parts = [];
  let depth = 0;
  let quote = null;
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (quote === '"' && ch === '\\') {
        i += 1;
        continue;
      }
      if (ch === quote) {
        if (quote === "'" && text[i + 1] === "'") {
          i += 1;
          continue;
        }
        quote = null;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (ch === '{' || ch === '[') depth += 1;
    else if (ch === '}' || ch === ']') depth -= 1;
    else if (ch === separator && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  if (quote) throw yamlError(entry.lineNo, 'unterminated quoted string in inline value');
  if (depth !== 0) throw yamlError(entry.lineNo, 'unbalanced brackets in inline value');
  parts.push(text.slice(start));
  return parts;
}

function unescapeDouble(text, entry) {
  let out = '';
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch !== '\\') {
      out += ch;
      continue;
    }
    i += 1;
    if (i >= text.length) throw yamlError(entry.lineNo, 'dangling escape in double-quoted string');
    const next = text[i];
    switch (next) {
      case 'n':
        out += '\n';
        break;
      case 't':
        out += '\t';
        break;
      case 'r':
        out += '\r';
        break;
      case 'b':
        out += '\b';
        break;
      case 'f':
        out += '\f';
        break;
      case '0':
        out += '\0';
        break;
      case '"':
        out += '"';
        break;
      case '\\':
        out += '\\';
        break;
      case '/':
        out += '/';
        break;
      case 'u': {
        const hex = text.slice(i + 1, i + 5);
        if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw yamlError(entry.lineNo, 'invalid \\u escape in double-quoted string');
        out += String.fromCharCode(parseInt(hex, 16));
        i += 4;
        break;
      }
      default:
        out += next;
        break;
    }
  }
  return out;
}

function unquoteScalar(text, entry) {
  const value = text.trim();
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) {
      throw yamlError(entry.lineNo, 'unterminated double-quoted string');
    }
    return unescapeDouble(value.slice(1, -1), entry);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) {
      throw yamlError(entry.lineNo, 'unterminated single-quoted string');
    }
    return value.slice(1, -1).replace(/''/g, "'");
  }
  return value;
}

function parseScalarText(text) {
  const value = text.trim();
  if (value === '') return null;
  if (value === 'true' || value === 'True' || value === 'TRUE') return true;
  if (value === 'false' || value === 'False' || value === 'FALSE') return false;
  if (value === 'null' || value === 'Null' || value === 'NULL' || value === '~') return null;
  if (/^[+-]?\d+$/.test(value)) {
    const num = Number(value);
    if (Number.isSafeInteger(num)) return num;
  }
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number(value);
  if (/^[+-]?\d+[eE][+-]?\d+$/.test(value)) return Number(value);
  return value;
}

/** Parse an inline value: flow map / flow list / quoted scalar / plain scalar. */
function parseInlineValue(state, text, entry) {
  const value = String(text).trim();
  if (value === '') return null;
  if (value.startsWith('{')) {
    if (!value.endsWith('}')) throw yamlError(entry.lineNo, 'unterminated inline object (expected "}")');
    const inner = value.slice(1, -1).trim();
    const object = {};
    if (inner === '') return object;
    for (const part of splitTopLevel(inner, ',', entry)) {
      const trimmed = part.trim();
      if (trimmed === '') continue;
      const pair = splitKeyValue(trimmed, { requireSpace: false });
      if (!pair || pair[0].trim() === '') {
        throw yamlError(entry.lineNo, `invalid inline object entry "${clip(trimmed, 60)}"`);
      }
      object[unquoteScalar(pair[0].trim(), entry)] = parseInlineValue(state, pair[1], entry);
    }
    return object;
  }
  if (value.startsWith('[')) {
    if (!value.endsWith(']')) throw yamlError(entry.lineNo, 'unterminated inline list (expected "]")');
    const inner = value.slice(1, -1).trim();
    if (inner === '') return [];
    return splitTopLevel(inner, ',', entry)
      .map((item) => item.trim())
      .filter((item) => item !== '')
      .map((item) => parseInlineValue(state, item, entry));
  }
  if (value.startsWith('"')) {
    if (value.length < 2 || !value.endsWith('"')) throw yamlError(entry.lineNo, 'unterminated double-quoted string');
    return unescapeDouble(value.slice(1, -1), entry);
  }
  if (value.startsWith("'")) {
    if (value.length < 2 || !value.endsWith("'")) throw yamlError(entry.lineNo, 'unterminated single-quoted string');
    return value.slice(1, -1).replace(/''/g, "'");
  }
  if (value.startsWith('}') || value.startsWith(']')) {
    throw yamlError(entry.lineNo, `unexpected closing bracket in "${clip(value, 60)}"`);
  }
  return parseScalarText(value);
}

/**
 * Read a `|` / `>` block scalar starting after `headerEntry`.
 * Updates `state.index` so the parser skips the consumed raw lines.
 */
function readBlockScalar(state, headerEntry, parentIndent, headerText) {
  const header = headerText.trim();
  const folded = header.startsWith('>');
  const stripped = header.includes('-');
  const rawLines = state.rawLines;
  const collected = [];
  let cursor = headerEntry.rawIndex + 1;
  let lastConsumed = headerEntry.rawIndex;
  let contentIndent = -1;
  while (cursor < rawLines.length) {
    const line = rawLines[cursor];
    if (line.trim() === '') {
      collected.push('');
      cursor += 1;
      continue;
    }
    const indent = countIndent(line);
    if (contentIndent < 0) {
      // The block scalar's indentation is detected from its first non-empty line.
      if (indent <= parentIndent) break;
      contentIndent = indent;
    }
    // Lines indented less than the detected content indentation end the scalar. This is
    // what lets `- text: |` be followed by sibling keys like `  type: note`.
    if (indent < contentIndent) break;
    collected.push(line);
    lastConsumed = cursor;
    cursor += 1;
  }
  while (collected.length > 0 && collected[collected.length - 1].trim() === '') collected.pop();
  if (contentIndent < 0) contentIndent = 0;
  const dedented = collected.map((line) => (line.trim() === '' ? '' : line.slice(contentIndent).replace(/[ \t]+$/, '')));
  let textValue = '';
  if (folded) {
    for (let i = 0; i < dedented.length; i += 1) {
      const line = dedented[i];
      if (line === '') {
        textValue += '\n';
        continue;
      }
      textValue += line;
      if (i < dedented.length - 1 && dedented[i + 1] !== '') textValue += ' ';
    }
  } else {
    textValue = dedented.join('\n');
  }
  if (!stripped && textValue !== '') textValue += '\n';
  while (state.index < state.entries.length && state.entries[state.index].rawIndex <= lastConsumed) {
    state.index += 1;
  }
  return textValue;
}

function parseNode(state, indent) {
  if (state.index >= state.entries.length) return null;
  const entry = state.entries[state.index];
  ensureExpandable(entry);
  if (entry.indent < indent) return null;
  if (isSequenceItem(entry.content)) return parseSequence(state, entry.indent);
  if (splitKeyValue(entry.content)) return parseMapping(state, entry.indent);
  state.index += 1;
  return parseInlineValue(state, entry.content, entry);
}

function parseSequence(state, indent) {
  const result = [];
  while (state.index < state.entries.length) {
    const entry = state.entries[state.index];
    ensureExpandable(entry);
    if (entry.indent !== indent || !isSequenceItem(entry.content)) break;

    const afterDash = entry.content === '-' ? '' : entry.content.slice(1).trimStart();
    state.index += 1;

    if (afterDash === '') {
      const next = state.entries[state.index];
      if (next && next.indent > indent) {
        ensureExpandable(next);
        result.push(parseNode(state, next.indent));
      } else {
        result.push(null);
      }
      continue;
    }

    if (isBlockScalarHeader(afterDash)) {
      result.push(readBlockScalar(state, entry, indent, afterDash));
      continue;
    }

    const pair = looksLikeInline(afterDash) ? null : splitKeyValue(afterDash);
    if (pair) {
      // Mapping item whose first key lives on the dash line; continuation lines are
      // indented deeper than the dash and belong to the same mapping item.
      const object = {};
      assignMappingEntry(state, object, pair, indent, entry);
      const next = state.entries[state.index];
      if (next && next.indent > indent) {
        ensureExpandable(next);
        Object.assign(object, parseMapping(state, next.indent));
      }
      result.push(object);
      continue;
    }

    result.push(parseInlineValue(state, afterDash, entry));
  }
  return result;
}

function parseMapping(state, indent) {
  const result = {};
  while (state.index < state.entries.length) {
    const entry = state.entries[state.index];
    ensureExpandable(entry);
    if (entry.indent !== indent) break;
    if (isSequenceItem(entry.content)) break;
    const pair = splitKeyValue(entry.content);
    if (!pair) {
      throw yamlError(entry.lineNo, `expected "key: value", got "${clip(entry.content, 60)}"`);
    }
    state.index += 1;
    assignMappingEntry(state, result, pair, indent, entry);
  }
  return result;
}

function assignMappingEntry(state, target, pair, ownerIndent, entry) {
  const key = unquoteScalar(pair[0].trim(), entry);
  if (key === '') throw yamlError(entry.lineNo, 'empty mapping key is not supported');
  const rest = pair[1].trim();
  if (rest === '') {
    const next = state.entries[state.index];
    if (next && next.indent > ownerIndent) {
      ensureExpandable(next);
      target[key] = parseNode(state, next.indent);
    } else {
      target[key] = null;
    }
    return;
  }
  if (isBlockScalarHeader(rest)) {
    target[key] = readBlockScalar(state, entry, ownerIndent, rest);
    return;
  }
  target[key] = parseInlineValue(state, rest, entry);
}

/**
 * Parse the minimal YAML subset used by test cards. Returns a plain JSON-compatible value.
 * Empty documents return `{}`. Syntax errors throw `Error('YAML syntax error at line N: ...')`.
 */
export function parseYaml(text) {
  const { rawLines, entries } = tokenizeYaml(text);
  if (entries.length === 0) return {};
  const state = { entries, rawLines, index: 0 };
  const value = parseNode(state, entries[0].indent);
  if (state.index < entries.length) {
    const leftover = entries[state.index];
    throw yamlError(leftover.lineNo, `unexpected content "${clip(leftover.content, 60)}" (bad indentation?)`);
  }
  return value;
}

// ---------------------------------------------------------------------------
// Card files
// ---------------------------------------------------------------------------

function parseJsonCardText(text, file) {
  try {
    return JSON.parse(text);
  } catch (error) {
    const message = String(error?.message ?? error);
    const positionMatch = /position (\d+)/i.exec(message);
    let where = '';
    if (positionMatch) {
      const offset = Number(positionMatch[1]);
      const before = text.slice(0, offset);
      const line = before.split('\n').length;
      const column = offset - before.lastIndexOf('\n');
      where = ` (line ${line}, column ${column})`;
    }
    throw new Error(`invalid JSON in ${file}${where}: ${message}`);
  }
}

/**
 * Read a card file and parse it. `.json` files are parsed as JSON, everything else with
 * the YAML subset parser. File-read and syntax errors throw (with the file path).
 */
export function parseCardFile(path) {
  const file = resolve(String(path));
  const text = readTextFile(file);
  if (extname(file).toLowerCase() === '.json') return parseJsonCardText(text, file);
  try {
    return parseYaml(text);
  } catch (error) {
    throw new Error(`${file}: ${shortError(error)}`);
  }
}

// ---------------------------------------------------------------------------
// Card compiler (normalizeCard / cardToSteps)
// ---------------------------------------------------------------------------

const NORMALIZED = Symbol('minecraft-devtest.normalizedCard');

const STEP_TYPES = new Set(['command', 'bot', 'datapack', 'gradle', 'server', 'assert', 'wait', 'note', 'snapshot']);

const PROBE_ONLY_ACTIONS = new Set([
  'give',
  'select_item',
  'use_on',
  'use_item_on',
  'block_entity_nbt',
  'comparator',
  'craft',
  'mine',
  'client_mine',
  'close_ui',
  'ui',
  'block',
  'break',
  'items',
  'recipe',
  'loot',
  'item',
]);

function cleanText(value) {
  if (value === null || value === undefined) return '';
  return String(value).trim();
}

function normalizeSetupCommands(setup, warnings) {
  const commands = [];
  if (setup === null || setup === undefined) return commands;
  if (typeof setup === 'string') {
    const command = cleanText(setup);
    if (command) commands.push(command);
    return commands;
  }
  if (typeof setup !== 'object' || Array.isArray(setup)) {
    warnings.push('setup must be an object like { commands: [...] }; ignored');
    return commands;
  }
  const rawCommands = setup.commands;
  if (rawCommands === null || rawCommands === undefined) return commands;
  const items = Array.isArray(rawCommands) ? rawCommands : [rawCommands];
  items.forEach((item, index) => {
    const where = `setup.commands[${index}]`;
    if (typeof item === 'string') {
      const command = cleanText(item);
      if (command) commands.push(command);
      else warnings.push(`${where}: empty command skipped`);
      return;
    }
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const command = cleanText(item.cmd ?? item.command);
      if (command) commands.push(command);
      else warnings.push(`${where}: missing "cmd" skipped`);
      return;
    }
    warnings.push(`${where}: command must be a string, skipped`);
  });
  return commands;
}

function normalizeStepEntry(step, warnings, where) {
  if (typeof step === 'string') {
    const command = cleanText(step);
    if (!command) {
      warnings.push(`${where}: empty command step skipped`);
      return null;
    }
    return { type: 'command', cmd: command };
  }
  if (!step || typeof step !== 'object' || Array.isArray(step)) {
    warnings.push(`${where}: step must be an object, skipped`);
    return null;
  }
  const type = cleanText(step.type).toLowerCase();
  if (!type) {
    warnings.push(`${where}: step is missing "type", skipped`);
    return null;
  }
  if (!STEP_TYPES.has(type)) {
    warnings.push(`${where}: unsupported step type "${type}", skipped`);
    return null;
  }
  const out = { ...step, type };
  switch (type) {
    case 'command': {
      out.cmd = cleanText(step.cmd ?? step.command);
      if (step.command !== undefined) delete out.command;
      if (!out.cmd) warnings.push(`${where}: command step is missing "cmd" and will fail`);
      break;
    }
    case 'bot': {
      if (step.action !== undefined) out.action = cleanText(step.action);
      else delete out.action; // action may live in params: { params: { action: join } }
      const paramAction =
        step.params && typeof step.params === 'object' && !Array.isArray(step.params) ? cleanText(step.params.action) : '';
      if (!cleanText(step.action) && !paramAction) warnings.push(`${where}: bot step is missing "action" and will fail`);
      if (step.params !== undefined && (step.params === null || typeof step.params !== 'object' || Array.isArray(step.params))) {
        warnings.push(`${where}: "params" must be an object; using {}`);
        out.params = {};
      }
      break;
    }
    case 'datapack': {
      if (step.action !== undefined) out.action = cleanText(step.action);
      else delete out.action; // action may live in params: { params: { action: reload } }
      const paramAction =
        step.params && typeof step.params === 'object' && !Array.isArray(step.params) ? cleanText(step.params.action) : '';
      if (!cleanText(step.action) && !paramAction) warnings.push(`${where}: datapack step is missing "action" and will fail`);
      break;
    }
    case 'gradle': {
      out.task = cleanText(step.task);
      if (!out.task) warnings.push(`${where}: gradle step is missing "task" and will fail`);
      break;
    }
    case 'wait': {
      const ms = Number(step.ms ?? step.wait ?? 0);
      out.ms = Number.isFinite(ms) && ms > 0 ? ms : 0;
      delete out.wait;
      break;
    }
    case 'note': {
      out.text = cleanText(step.text ?? step.message ?? step.note);
      delete out.note;
      break;
    }
    case 'assert': {
      if (step.step !== undefined && step.step !== null) out.step = Number(step.step);
      if (step.path !== undefined) out.path = String(step.path);
      break;
    }
    default:
      break;
  }
  return out;
}

function translateLegacyAction(action, warnings, index) {
  const where = `actions[${index}]`;
  if (typeof action === 'string') {
    const command = cleanText(action);
    if (!command) {
      warnings.push(`${where}: empty command action skipped`);
      return null;
    }
    return { type: 'command', cmd: command };
  }
  if (!action || typeof action !== 'object' || Array.isArray(action)) {
    warnings.push(`${where}: action must be an object or command string, skipped`);
    return null;
  }
  const type = cleanText(action.type).toLowerCase();
  if (type && STEP_TYPES.has(type)) return normalizeStepEntry(action, warnings, where);
  if (typeof action.command === 'string') {
    const command = cleanText(action.command);
    if (command) return { type: 'command', cmd: command };
  }
  if (typeof action.cmd === 'string') {
    const command = cleanText(action.cmd);
    if (command) return { type: 'command', cmd: command };
  }
  if (typeof action.wait === 'number' && Number.isFinite(action.wait)) {
    return { type: 'wait', ms: Math.max(0, action.wait) };
  }
  const keys = Object.keys(action);
  const probeKey = keys.find((key) => PROBE_ONLY_ACTIONS.has(key));
  if (probeKey) warnings.push(`${where}: unsupported legacy action "${probeKey}" (probe-only; skipped)`);
  else warnings.push(`${where}: unsupported legacy action "${keys[0] ?? 'unknown'}" (skipped)`);
  return null;
}

function translateLegacyAssert(check, warnings, index) {
  const where = `assert[${index}]`;
  if (typeof check === 'string') {
    warnings.push(`${where}: legacy assert must be a mapping with "path", skipped`);
    return null;
  }
  if (!check || typeof check !== 'object' || Array.isArray(check)) {
    warnings.push(`${where}: invalid legacy assert, skipped`);
    return null;
  }
  const type = cleanText(check.type).toLowerCase();
  if (type === 'assert') return normalizeStepEntry(check, warnings, where);
  if (typeof check.path === 'string') {
    const step = { type: 'assert', path: check.path };
    if (check.step !== undefined) step.step = Number(check.step);
    if (check.op !== undefined || check.operator !== undefined) step.op = cleanText(check.op ?? check.operator);
    else if (check.value !== undefined) step.op = 'eq';
    else step.op = 'exists';
    if (check.value !== undefined) step.value = check.value;
    return step;
  }
  const keys = Object.keys(check);
  warnings.push(`${where}: unsupported legacy assert "${keys[0] ?? 'unknown'}" (skipped)`);
  return null;
}

function translateCard(raw) {
  const warnings = [];
  const setupCommands = normalizeSetupCommands(raw?.setup, warnings);
  const steps = setupCommands.map((cmd) => ({ type: 'command', cmd }));

  const rawSteps = Array.isArray(raw?.steps) ? raw.steps : raw?.steps !== null && raw?.steps !== undefined ? [raw.steps] : [];
  rawSteps.forEach((step, index) => {
    const normalized = normalizeStepEntry(step, warnings, `steps[${index}]`);
    if (normalized) steps.push(normalized);
  });

  const actions = Array.isArray(raw?.actions) ? raw.actions : raw?.actions !== null && raw?.actions !== undefined ? [raw.actions] : [];
  actions.forEach((action, index) => {
    const translated = translateLegacyAction(action, warnings, index);
    if (translated) steps.push(translated);
  });

  const asserts = Array.isArray(raw?.assert) ? raw.assert : raw?.assert !== null && raw?.assert !== undefined ? [raw.assert] : [];
  asserts.forEach((check, index) => {
    const translated = translateLegacyAssert(check, warnings, index);
    if (translated) steps.push(translated);
  });

  return { setupCommands, steps, warnings };
}

/**
 * Normalize a raw card object. The returned `steps` are already executable and include
 * the `setup.commands` steps at the front. An internal symbol marks the result so that
 * `cardToSteps(normalizeCard(raw))` does not translate (and duplicate) anything again.
 */
export function normalizeCard(raw) {
  if (raw && typeof raw === 'object' && raw[NORMALIZED]) return raw;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('test card must be a YAML/JSON object');
  }
  const { setupCommands, steps, warnings } = translateCard(raw);
  const card = {
    id: cleanText(raw.id ?? raw.name),
    title: cleanText(raw.title),
    description: cleanText(raw.description),
    setup: { commands: setupCommands },
    steps,
    warnings,
  };
  Object.defineProperty(card, NORMALIZED, { value: true, enumerable: false });
  return card;
}

/**
 * Compatibility layer: translate setup/actions/assert (and pass through v1 `steps`) into
 * a flat executable step list. Never throws for recognizable-but-unsupported items; those
 * become warnings so one odd legacy action cannot block the rest of the card.
 */
export function cardToSteps(card) {
  if (!card || typeof card !== 'object' || Array.isArray(card)) {
    throw new Error('cardToSteps expects a card object');
  }
  if (card[NORMALIZED]) {
    return {
      steps: card.steps.map((step) => ({ ...step })),
      warnings: [...card.warnings],
    };
  }
  const { steps, warnings } = translateCard(card);
  return { steps, warnings };
}

// ---------------------------------------------------------------------------
// Assertions
// ---------------------------------------------------------------------------

const OP_ALIASES = {
  '==': 'eq',
  '=': 'eq',
  eq: 'eq',
  equals: 'eq',
  '!=': 'ne',
  '<>': 'ne',
  ne: 'ne',
  not_equals: 'ne',
  contains: 'contains',
  includes: 'contains',
  not_contains: 'not_contains',
  '!contains': 'not_contains',
  excludes: 'not_contains',
  matches: 'matches',
  match: 'matches',
  regex: 'matches',
  exists: 'exists',
  is_set: 'exists',
  '>': 'gt',
  gt: 'gt',
  '>=': 'gte',
  gte: 'gte',
  '<': 'lt',
  lt: 'lt',
  '<=': 'lte',
  lte: 'lte',
};
const ASSERT_OPS = new Set(['eq', 'ne', 'contains', 'not_contains', 'matches', 'exists', 'gt', 'gte', 'lt', 'lte']);

function mapCardOp(op) {
  const key = cleanText(op ?? 'eq').toLowerCase();
  return OP_ALIASES[key] ?? key;
}

/** Resolve `a.b[0].c` against a JSON-ish value. */
function resolvePath(root, path) {
  const text = cleanText(path);
  if (text === '') return { found: true, value: root };
  const normalized = text.replace(/\[\s*(['"]?)([^\]'"]+)\1\s*\]/g, '.$2');
  const tokens = normalized.split('.').filter((token) => token !== '');
  let current = root;
  for (const token of tokens) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (typeof current !== 'object') return { found: false, value: undefined };
    const key = Array.isArray(current) && /^\d+$/.test(token) ? Number(token) : token;
    if (!(key in current)) return { found: false, value: undefined };
    current = current[key];
  }
  return { found: true, value: current };
}

function deepEqualValue(a, b) {
  if (Object.is(a, b)) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqualValue(item, b[index]));
  }
  if (a && b && typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    return keysA.every((key) => Object.hasOwn(b, key) && deepEqualValue(a[key], b[key]));
  }
  if (a && typeof a === 'object') return false;
  if (b && typeof b === 'object') return false;
  return String(a) === String(b);
}

function valuesEqual(a, b) {
  if (Object.is(a, b)) return true;
  if (a !== null && b !== null && a !== undefined && b !== undefined && typeof a === 'object' && typeof b === 'object') {
    return deepEqualValue(a, b);
  }
  if (a === null || b === null || a === undefined || b === undefined) return false;
  // Quoted YAML scalars are common in cards (`value: "1"` vs actual number 1).
  return String(a) === String(b);
}

function renderText(value) {
  if (typeof value === 'string') return value;
  if (value === undefined) return '';
  if (value === null) return 'null';
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

function formatValue(value) {
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return JSON.stringify(clip(value, 200));
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : clip(text, 240);
  } catch {
    return clip(String(value), 240);
  }
}

function containsValue(actual, expected) {
  if (actual === null || actual === undefined) return false;
  // Arrays/objects are compared as JSON text (per contract supplement): this makes
  // `contains` usable against bot state / snapshot data without extra path plumbing.
  if (typeof actual === 'object') return renderText(actual).includes(String(expected));
  return String(actual).includes(String(expected));
}

function numericPair(op, actual, expected) {
  const left = Number(actual);
  const right = Number(expected);
  if (Number.isNaN(left) || Number.isNaN(right)) {
    throw new Error(`op "${op}" requires numeric values (actual ${formatValue(actual)}, expected ${formatValue(expected)})`);
  }
  return [left, right];
}

function evaluateAssert(op, actual, expected) {
  switch (op) {
    case 'eq':
      return valuesEqual(actual, expected);
    case 'ne':
      return !valuesEqual(actual, expected);
    case 'contains':
      return containsValue(actual, expected);
    case 'not_contains':
      return !containsValue(actual, expected);
    case 'matches': {
      let regex;
      try {
        regex = new RegExp(String(expected));
      } catch (error) {
        throw new Error(`invalid regex ${formatValue(expected)}: ${shortError(error)}`);
      }
      return regex.test(renderText(actual));
    }
    case 'exists':
      return actual !== undefined && actual !== null;
    case 'gt': {
      const [left, right] = numericPair(op, actual, expected);
      return left > right;
    }
    case 'gte': {
      const [left, right] = numericPair(op, actual, expected);
      return left >= right;
    }
    case 'lt': {
      const [left, right] = numericPair(op, actual, expected);
      return left < right;
    }
    case 'lte': {
      const [left, right] = numericPair(op, actual, expected);
      return left <= right;
    }
    default:
      throw new Error(`unsupported assert op "${op}"`);
  }
}

function describeDataKeys(data) {
  if (!data || typeof data !== 'object') return typeof data;
  const keys = Object.keys(data);
  if (keys.length === 0) return 'none';
  return keys.slice(0, 10).join(', ') + (keys.length > 10 ? ', …' : '');
}

/** Inline `expect: { contains: '...' }` on a data step. Compares against `data.response` when present. */
function applyInlineExpect(expect, data, index, type) {
  if (typeof expect !== 'object' || expect === null || Array.isArray(expect)) {
    throw new Error(`step ${index} (${type}): "expect" must be a mapping like { contains: "..." }`);
  }
  const target = data && typeof data === 'object' && !Array.isArray(data) && Object.hasOwn(data, 'response') ? data.response : data;
  for (const [rawOp, expected] of Object.entries(expect)) {
    const op = mapCardOp(rawOp);
    if (!ASSERT_OPS.has(op)) {
      throw new Error(`step ${index} (${type}): unsupported expect op "${rawOp}"`);
    }
    if (!evaluateAssert(op, target, expected)) {
      throw new Error(
        `step ${index} (${type}): expect ${rawOp} ${formatValue(expected)} failed (actual ${formatValue(target)})`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Step executor
// ---------------------------------------------------------------------------

function apiFunction(api, name, index) {
  const fn = api?.[name];
  if (typeof fn !== 'function') throw new Error(`step ${index}: api.${name} is not available`);
  return fn.bind(api);
}

/**
 * Merge a step's explicit `params` with flat step fields (e.g. `{ type: datapack, action: deploy, dir: ".." }`).
 * `type` / `action` / `params` / `expect` stay step-level; everything else is forwarded as params.
 */
function mergeStepParams(step) {
  const flat = {};
  for (const [key, value] of Object.entries(step)) {
    if (key === 'type' || key === 'action' || key === 'params' || key === 'expect') continue;
    flat[key] = value;
  }
  const explicit =
    step.params && typeof step.params === 'object' && !Array.isArray(step.params) ? step.params : {};
  const params = { ...flat, ...explicit };
  delete params.action;
  return { action: cleanText(step.action ?? explicit.action), params };
}

/** Execute one non-assert step; returns its `data` (or undefined for wait/note). */
async function executeStepData(step, type, api, index) {
  switch (type) {
    case 'command': {
      const cmd = cleanText(step.cmd ?? step.command);
      if (!cmd) throw new Error(`command step ${index} requires "cmd"`);
      const command = apiFunction(api, 'command', index);
      const result = await command(cmd);
      if (typeof result === 'string') return { response: result };
      return result ?? {};
    }
    case 'bot': {
      const { action, params } = mergeStepParams(step);
      if (!action) throw new Error(`bot step ${index} requires "action"`);
      const bot = apiFunction(api, 'bot', index);
      const result = await bot(action, params);
      return result ?? {};
    }
    case 'datapack': {
      const { action, params } = mergeStepParams(step);
      if (!action) throw new Error(`datapack step ${index} requires "action"`);
      const datapack = apiFunction(api, 'datapack', index);
      const result = await datapack(action, params);
      return result ?? {};
    }
    case 'gradle': {
      const task = cleanText(step.task);
      if (!task) throw new Error(`gradle step ${index} requires "task"`);
      const gradle = apiFunction(api, 'gradle', index);
      // Forward flat step options (projectDir/args/timeoutMs/env/...) plus an explicit `opts` map,
      // because api.gradle(task, opts) resolves projectDir from opts.
      const opts = {};
      for (const [key, value] of Object.entries(step)) {
        if (key === 'type' || key === 'task' || key === 'opts' || key === 'expect') continue;
        opts[key] = value;
      }
      if (step.opts && typeof step.opts === 'object' && !Array.isArray(step.opts)) Object.assign(opts, step.opts);
      const result = (await gradle(task, opts)) ?? {};
      if (result.timedOut) {
        throw new Error(`gradle ${task} timed out${result.summary ? `: ${clip(result.summary, 200)}` : ''}`);
      }
      if (typeof result.exitCode === 'number' && result.exitCode !== 0) {
        throw new Error(
          `gradle ${task} failed with exit code ${result.exitCode}${result.summary ? `: ${clip(result.summary, 200)}` : ''}`,
        );
      }
      if (result.exitCode === null) throw new Error(`gradle ${task} was terminated before completing`);
      return result;
    }
    case 'server': {
      const action = cleanText(step.action ?? 'status').toLowerCase() || 'status';
      if (action === 'status') {
        const serverStatus = apiFunction(api, 'serverStatus', index);
        return (await serverStatus()) ?? {};
      }
      if (action === 'command') {
        const cmd = cleanText(step.cmd ?? step.command);
        if (!cmd) throw new Error(`server command step ${index} requires "cmd"`);
        const command = apiFunction(api, 'command', index);
        return (await command(cmd)) ?? {};
      }
      throw new Error(`server step ${index}: unsupported action "${action}" (expected "status" or "command")`);
    }
    case 'snapshot': {
      const hasServer = typeof api?.serverStatus === 'function';
      const hasBot = typeof api?.botState === 'function';
      if (!hasServer && !hasBot) throw new Error(`step ${index}: snapshot requires api.serverStatus or api.botState`);
      const serverStatus = hasServer ? ((await api.serverStatus()) ?? null) : null;
      const botState = hasBot ? ((await api.botState()) ?? null) : null;
      return { serverStatus, botState };
    }
    case 'wait': {
      const rawMs = Number(step.ms ?? step.wait ?? 0);
      const ms = Number.isFinite(rawMs) && rawMs > 0 ? rawMs : 0;
      const sleeper = typeof api?.sleep === 'function' ? api.sleep.bind(api) : utilSleep;
      await sleeper(ms);
      // `wait` deliberately produces no data: it must not become the implicit assert target.
      return undefined;
    }
    case 'note': {
      const text = cleanText(step.text ?? step.message ?? step.note);
      if (text && typeof api?.log === 'function') {
        try {
          api.log(`note: ${text}`);
        } catch {
          // A logging callback must never fail a card.
        }
      }
      return undefined;
    }
    default:
      throw new Error(`unsupported step type "${type}"`);
  }
}

/**
 * Execute steps sequentially against a caller-supplied api.
 * Step/assert/api failures are captured in the result (never thrown); a YAML/card compile
 * problem is handled earlier by runCardFile/runSuite.
 */
export async function runSteps(steps, api, options = {}) {
  if (!Array.isArray(steps)) throw new Error('runSteps expects an array of steps');
  if (api === null || typeof api !== 'object') throw new Error('runSteps expects an api object');
  const opts = options && typeof options === 'object' ? options : {};
  const stopOnFail = opts.stopOnFail !== false;
  const dryRun = opts.dryRun === true;
  const logger = typeof opts.log === 'function' ? opts.log : () => {};

  const results = [];
  const warnings = [];
  const dataByIndex = new Map();
  let lastDataIndex = -1;
  let firstFailure = null;

  const assertStep = (step, index) => {
    let targetIndex;
    if (step.step !== undefined && step.step !== null) {
      const reference = Number(step.step);
      if (!Number.isInteger(reference) || reference < 0 || reference >= index) {
        throw new Error(
          `assert step ${index}: invalid "step" reference ${formatValue(step.step)} (must be a previous step index)`,
        );
      }
      if (!dataByIndex.has(reference)) {
        throw new Error(`assert step ${index}: step ${reference} did not produce data`);
      }
      targetIndex = reference;
    } else {
      if (lastDataIndex < 0) {
        throw new Error(
          `assert step ${index}: no previous step produced data; add a command/bot/datapack/snapshot step first or set "step"`,
        );
      }
      targetIndex = lastDataIndex;
    }
    const targetData = dataByIndex.get(targetIndex);
    const pathText = cleanText(step.path);
    let resolved = resolvePath(targetData, pathText);
    // Legacy mcdev cards used `data.xxx` paths against the step data; accept both forms.
    if (!resolved.found && pathText.startsWith('data.')) resolved = resolvePath(targetData, pathText.slice(5));
    if (!resolved.found && pathText.startsWith('$.')) resolved = resolvePath(targetData, pathText.slice(2));

    const op = mapCardOp(step.op ?? (step.value !== undefined ? 'eq' : 'exists'));
    if (!ASSERT_OPS.has(op)) {
      throw new Error(`assert step ${index}: unsupported op ${formatValue(step.op)}`);
    }
    const expected = step.value;
    if (!resolved.found && op !== 'exists') {
      throw new Error(
        `assert failed at step ${index}: path "${pathText}" not found in steps[${targetIndex}] data (keys: ${describeDataKeys(
          targetData,
        )})`,
      );
    }
    let passed;
    try {
      passed = evaluateAssert(op, resolved.found ? resolved.value : undefined, expected);
    } catch (error) {
      throw new Error(`assert step ${index}: ${shortError(error)}`);
    }
    if (!passed) {
      if (op === 'exists') {
        throw new Error(
          `assert failed at step ${index}: path "${pathText}" does not exist in steps[${targetIndex}] data (keys: ${describeDataKeys(
            targetData,
          )})`,
        );
      }
      throw new Error(
        `assert failed at step ${index}: steps[${targetIndex}]${pathText ? `.${pathText}` : ''} ${op} ${formatValue(
          expected,
        )} (actual ${formatValue(resolved.value)})`,
      );
    }
  };

  for (let index = 0; index < steps.length; index += 1) {
    const step = steps[index];
    const started = Date.now();
    let type = '';

    if (dryRun) {
      type = step && typeof step === 'object' && !Array.isArray(step) ? cleanText(step.type).toLowerCase() : '';
      results.push({ index, type, ok: true, ms: 0, dryRun: true });
      logger(`[dryRun] step ${index} ${type}`);
      continue;
    }

    try {
      if (!step || typeof step !== 'object' || Array.isArray(step)) {
        throw new Error(`step ${index} is not an object`);
      }
      type = cleanText(step.type).toLowerCase();
      if (!type) throw new Error(`step ${index} is missing "type"`);

      if (type === 'assert') {
        assertStep(step, index);
        const ms = Date.now() - started;
        results.push({ index, type, ok: true, ms });
        logger(`step ${index} ${type}: ok (${ms}ms)`);
        continue;
      }
      if (!STEP_TYPES.has(type)) {
        warnings.push(`step ${index}: unsupported step type "${type}" (skipped)`);
        results.push({ index, type, ok: true, ms: 0, skipped: true });
        logger(`step ${index} ${type}: skipped (unsupported)`);
        continue;
      }

      const data = await executeStepData(step, type, api, index);
      if (data !== undefined && step.expect !== undefined) applyInlineExpect(step.expect, data, index, type);

      const ms = Date.now() - started;
      const entry = { index, type, ok: true, ms };
      if (data !== undefined) entry.data = data;
      results.push(entry);
      if (data !== undefined) {
        dataByIndex.set(index, data);
        lastDataIndex = index;
      }
      logger(`step ${index} ${type}: ok (${ms}ms)`);
    } catch (error) {
      const ms = Date.now() - started;
      const message = shortError(error);
      results.push({ index, type, ok: false, ms, error: message });
      logger(`step ${index} ${type}: FAIL ${message}`);
      if (firstFailure === null) firstFailure = index;
      if (stopOnFail) return { ok: false, failedAt: index, steps: results, warnings };
    }
  }

  return { ok: firstFailure === null, failedAt: firstFailure, steps: results, warnings };
}

// ---------------------------------------------------------------------------
// Card / suite runners
// ---------------------------------------------------------------------------

function uniqueWarnings(list) {
  const seen = new Set();
  const out = [];
  for (const item of list) {
    const text = cleanText(item);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
  }
  return out;
}

function fallbackIdForFile(file) {
  const name = basename(String(file ?? ''));
  return name.replace(/\.(ya?ml|json)$/i, '') || 'card';
}

// Card files may reference files relative to themselves, e.g.
//   - type: datapack
//     action: deploy
//     dir: "../datapacks/hello_mcdevtest"
// Only these keys are treated as paths, and only values starting with "./" or "../" are
// rewritten; absolute paths and plain names are left untouched. `assert` steps are skipped
// because their `path` is a data path (`a.b[0].c`), not a file path.
const RELATIVE_PATH_KEYS = new Set(['dir', 'packDir', 'path', 'card', 'serverDir', 'projectDir']);

function isRelativeFileSpec(value) {
  return typeof value === 'string' && /^\.\.?[\\/]/.test(value);
}

function resolveRelativePathsDeep(value, baseDir) {
  if (Array.isArray(value)) return value.map((item) => resolveRelativePathsDeep(item, baseDir));
  if (!value || typeof value !== 'object') return value;
  const out = {};
  for (const [key, raw] of Object.entries(value)) {
    if (RELATIVE_PATH_KEYS.has(key) && isRelativeFileSpec(raw)) out[key] = resolve(baseDir, raw);
    else out[key] = resolveRelativePathsDeep(raw, baseDir);
  }
  return out;
}

function resolveStepPaths(step, baseDir) {
  if (!baseDir || !step || typeof step !== 'object' || Array.isArray(step)) return step;
  if (cleanText(step.type).toLowerCase() === 'assert') return { ...step };
  return resolveRelativePathsDeep(step, baseDir);
}

async function runNormalizedCard(card, fallbackId, api, options = {}) {
  const translated = cardToSteps(card);
  const warnings = uniqueWarnings([...card.warnings, ...translated.warnings]);
  const baseDir = options.baseDir ? resolve(String(options.baseDir)) : '';
  const steps = translated.steps.map((step) => resolveStepPaths(step, baseDir));
  const runOptions = { stopOnFail: options.stopOnFail !== false, dryRun: options.dryRun === true };
  if (typeof options.log === 'function') runOptions.log = options.log;

  try {
    const result = await runSteps(steps, api, runOptions);
    const output = {
      ok: result.ok,
      id: card.id || fallbackId,
      title: card.title || card.id || fallbackId,
      failedAt: result.failedAt,
      steps: result.steps,
      warnings: uniqueWarnings([...warnings, ...result.warnings]),
    };
    if (!result.ok) {
      const failedStep = result.steps.find((entry) => !entry.ok);
      output.error = failedStep?.error ?? `card failed at step ${result.failedAt}`;
    }
    return output;
  } catch (error) {
    return {
      ok: false,
      id: card.id || fallbackId,
      title: card.title || card.id || fallbackId,
      failedAt: null,
      steps: [],
      warnings,
      error: shortError(error),
    };
  }
}

/**
 * Parse + normalize + execute one card file. File-read/YAML-syntax errors throw; everything
 * else (invalid card shape, failing step, failing api) is reported in the result.
 */
export async function runCardFile(path, api, options = {}) {
  const file = resolve(String(path));
  const raw = parseCardFile(file); // throws on read/YAML syntax errors, per contract
  const fallbackId = fallbackIdForFile(file);
  let card;
  try {
    card = normalizeCard(raw);
  } catch (error) {
    return { ok: false, id: fallbackId, title: fallbackId, failedAt: null, steps: [], warnings: [], error: shortError(error) };
  }
  const opts = options && typeof options === 'object' ? { ...options } : {};
  opts.baseDir = dirname(file);
  return runNormalizedCard(card, fallbackId, api, opts);
}

function matchFilter(filter, relPath, id) {
  if (filter === null || filter === undefined || filter === '') return true;
  if (typeof filter === 'function') {
    try {
      return Boolean(filter(relPath, id));
    } catch {
      return false;
    }
  }
  const matchers = Array.isArray(filter) ? filter : [filter];
  return matchers.some((matcher) => {
    if (matcher instanceof RegExp) {
      const pattern = new RegExp(matcher.source, matcher.flags.replace(/g/g, ''));
      return pattern.test(relPath) || pattern.test(id);
    }
    const text = cleanText(matcher);
    if (!text) return true;
    if (/[*?]/.test(text)) {
      const escaped = text.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
      const pattern = new RegExp(`^(?:${escaped})$`, 'i');
      return pattern.test(relPath) || pattern.test(id) || pattern.test(basename(relPath));
    }
    const lower = text.toLowerCase();
    return relPath.toLowerCase().includes(lower) || id.toLowerCase().includes(lower);
  });
}

/**
 * Scan a directory (recursively) for `*.yml` / `*.yaml` / `*.json` cards and run them all.
 * A broken card or failing card is recorded and the suite keeps going unless
 * `stopOnFail: true` is passed (stop running further cards after the first failure).
 */
export async function runSuite(dir, api, options = {}) {
  const opts = options && typeof options === 'object' ? options : {};
  const stopOnFail = opts.stopOnFail === true;
  const dryRun = opts.dryRun === true;
  const root = resolve(String(dir));
  const files = listFilesRecursive(root, { filter: (filePath) => /\.(ya?ml|json)$/i.test(filePath) }).sort((a, b) =>
    a.localeCompare(b),
  );

  const cards = [];
  const warnings = [];

  for (const file of files) {
    if (cards.length > 0 && stopOnFail && cards[cards.length - 1].ok === false) break;
    const rel = relative(root, file) || basename(file);
    const fallbackId = fallbackIdForFile(rel);

    let raw;
    try {
      raw = parseCardFile(file);
    } catch (error) {
      if (!matchFilter(opts.filter, rel, fallbackId)) continue;
      cards.push({ id: fallbackId, file: rel, ok: false, failedAt: null, error: shortError(error), ms: 0 });
      continue;
    }

    let card;
    try {
      card = normalizeCard(raw);
    } catch (error) {
      if (!matchFilter(opts.filter, rel, fallbackId)) continue;
      cards.push({ id: fallbackId, file: rel, ok: false, failedAt: null, error: shortError(error), ms: 0 });
      continue;
    }

    const id = card.id || fallbackId;
    if (!matchFilter(opts.filter, rel, id)) continue;

    const started = Date.now();
    const result = await runNormalizedCard(card, fallbackId, api, {
      stopOnFail: true,
      dryRun,
      log: opts.log,
      baseDir: dirname(file),
    });
    const ms = Date.now() - started;
    const entry = { id: result.id || id, file: rel, ok: result.ok, failedAt: result.failedAt, ms, steps: result.steps };
    if (!result.ok) entry.error = result.error ?? `card failed at step ${result.failedAt}`;
    cards.push(entry);
    for (const warning of result.warnings) warnings.push(`${rel}: ${warning}`);
  }

  const passed = cards.filter((card) => card.ok).length;
  const failed = cards.length - passed;
  return {
    ok: failed === 0,
    total: cards.length,
    passed,
    failed,
    cards,
    warnings: uniqueWarnings(warnings),
  };
}
