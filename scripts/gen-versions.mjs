// Regenerate the RELEASES table in lib/versions.js from Mojang's piston-meta.
//
//   node scripts/gen-versions.mjs            # use live manifest (needs network)
//   node scripts/gen-versions.mjs --check    # validate current table, do not write
//
// Rules:
//   - release versions only (snapshots / pre / rc are ignored), 1.7.10 .. newest release
//   - `javaMajor` is refreshed from each release's version JSON (javaVersion.majorVersion)
//   - `packFormat` values are curated in versions.js; they are preserved by id.
//     Only the two verified-by-jar values (1.18.2=9, 1.19.3=10) matter; the rest come
//     from the Minecraft Wiki data-pack format table.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const VERSIONS_FILE = fileURLToPath(new URL('../lib/versions.js', import.meta.url));
const MANIFEST_URL = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
const FROM_VERSION = '1.7.10';

async function loadJson(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${url} -> HTTP ${response.status}`);
  return response.json();
}

const source = readFileSync(VERSIONS_FILE, 'utf8');
const packFormats = new Map();
for (const match of source.matchAll(/\{ id: '([^']+)', javaMajor: (?:null|\d+), packFormat: (null|\d+) \}/g)) {
  packFormats.set(match[1], match[2] === 'null' ? null : Number(match[2]));
}
if (packFormats.size === 0) throw new Error('could not parse the existing RELEASES table');

const manifest = await loadJson(MANIFEST_URL);
const releases = manifest.versions.filter((entry) => entry.type === 'release');
const start = releases.findIndex((entry) => entry.id === FROM_VERSION);
if (start < 0) throw new Error(`release ${FROM_VERSION} not found in manifest`);
const selected = releases.slice(0, start + 1);

const rows = [];
for (const entry of selected) {
  const versionJson = await loadJson(entry.url);
  rows.push({
    id: entry.id,
    javaMajor: versionJson.javaVersion?.majorVersion ?? null,
    packFormat: packFormats.has(entry.id) ? packFormats.get(entry.id) : null,
  });
}

const lines = rows
  .map((row) => `  { id: '${row.id}', javaMajor: ${row.javaMajor ?? 'null'}, packFormat: ${row.packFormat ?? 'null'} },`)
  .join('\n');
const table = `export const RELEASES = [\n${lines}\n];`;
const updated = source.replace(/export const RELEASES = \[\n[\s\S]*?\n\];/, table);
if (updated === source) {
  console.log('versions.js already up to date');
} else if (process.argv.includes('--check')) {
  console.log('versions.js differs from the live manifest (run without --check to write)');
  process.exitCode = 1;
} else {
  writeFileSync(VERSIONS_FILE, updated);
  const latest = rows[0];
  console.log(`versions.js updated: ${rows.length} releases, newest ${latest.id} (Java ${latest.javaMajor})`);
}
