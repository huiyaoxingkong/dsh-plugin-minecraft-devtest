# upstream-26.3 — 26.2/26.3 protocol compatibility payload

Runtime payload for `lib/protocol-compat.js`. It contains **unmodified upstream
PrismarineJS pull-request sources** (no third-party mods, no local patches) plus
the `minecraft-data` files that the published npm releases do not ship yet.

The plugin's public `mineflayer` 4.39.0 release only declares
`1.8.8 … 26.1` as tested. The material below is the open upstream work that
extends it to **26.2** and **26.3**; `lib/protocol-compat.js` installs it into
`node_modules/` idempotently at require time (before any package is loaded by
`mineflayer` / `minecraft-protocol`) and widens the runtime version window.

Every file in this directory is byte-identical to the upstream commit named in
`manifest.json` (only documentation/test/`.github` directories were pruned to
keep the payload small; `manifest.json` records per-package tree hashes).

## Contents

| Path | Upstream package | Version | License |
| --- | --- | --- | --- |
| `minecraft-protocol/` | `minecraft-protocol` (`src/` only) | 1.68.0 | BSD-3-Clause |
| `mineflayer/` | `mineflayer` (`index.js` + `lib/`) | 4.39.0 | MIT |
| `prismarine-chunk/` | `prismarine-chunk` (`index.js` + `src/`) | 1.41.0 | MIT |
| `prismarine-physics/` | `prismarine-physics` (`index.js` + `lib/`) | 1.11.1 | MIT |
| `minecraft-data-extra/pc/26.2/` | `minecraft-data` data | 3.119.0 | MIT |
| `minecraft-data-extra/pc/26.3/` | `minecraft-data` data | 3.119.0 | MIT |
| `minecraft-data-extra/features.json` | `minecraft-data` `data/pc/common/features.json` | 3.119.0 | MIT |
| `minecraft-data-extra/dataPaths.json` | `minecraft-data` `dataPaths.json` (26.2/26.3 entries) | 3.119.0 | MIT |

`dataPaths.json` is the PR branch's own getter→directory table. It says, for
example, that 26.2 reuses `pc/26.1/effects.json`, `pc/26.1/enchantments.json`
and `pc/26.1/instruments.json` (that is why `pc/26.2/` has only 19 files), and
both 26.2/26.3 reuse `mapIcons`/`windows` from older versions. A few mapped
directories were de-duplicated away from the published `minecraft-data`
package (the only `windows.json` in the package lives in `pc/1.16.1`); the
installer resolves those at install time against the files that actually exist,
preferring `pc/1.16.1` for `windows` and `pc/1.20.2` for `mapIcons`.

`protodef` is **not** vendored: the already-installed `protodef` 1.19.0 works
unchanged with these PR packages.

## Sources

All sources are open pull requests against the official PrismarineJS
repositories (fetched 2026-11-14, branch head commits as uncompressed from the
GitHub archive endpoints):

* **minecraft-protocol** — https://github.com/suisarbre/node-minecraft-protocol
  branch `port-26.3`, commit `3473413d32ee09af55aa77579000391be3bb9753`,
  PR https://github.com/PrismarineJS/node-minecraft-protocol/pull/1553
  (adds the `entityDelta` packet used by 26.2/26.3).
* **mineflayer** — https://github.com/suisarbre/mineflayer
  branch `port-26.3`, commit `ad4af12611fd55309bb387b2b416212bffb0eddf`,
  PR https://github.com/PrismarineJS/mineflayer/pull/4206
* **prismarine-chunk** — https://github.com/suisarbre/prismarine-chunk
  branch `port-26.3`, commit `a96fd7050163b5ae3cbce240deab453a03cd3bc2`,
  PR https://github.com/PrismarineJS/prismarine-chunk/pull/347
* **prismarine-physics** — https://github.com/DallasCarraher/prismarine-physics
  branch `fix-liquid-gravity-26`, commit
  `b928638645a56a110a51da1f2080c6455b27984a`,
  PR https://github.com/PrismarineJS/prismarine-physics/pull/145
  (fixes liquid gravity for 26.x; the 26.3 PR stack depends on it).
* **minecraft-data** — https://github.com/suisarbre/minecraft-data
  branch `port-26.3`, PR https://github.com/PrismarineJS/minecraft-data/pull/1345
  (stacked on https://github.com/PrismarineJS/minecraft-data/pull/1301):
  `data/pc/26.2/*`, `data/pc/26.3/*`, `data/pc/common/features.json`.

The upstream `mineflayer` 4.39.0 PR branch itself already declares
`minecraft-protocol: github:PrismarineJS/node-minecraft-protocol#pc26_3`, i.e.
the same stacked upstream work; we pin the exact commits above.

## Protocol / data versions

| MC version | protocol | dataVersion | notes |
| --- | --- | --- | --- |
| 26.2 | 776 | 4903 | real release data |
| 26.3 | 777 | 5023 | real release data |
| 26.4 | 777 (placeholder) | 9000000 | **not released** — best-effort alias, see below |

## 26.4 future alias (risk notice)

26.4 does not exist as a release yet (latest release at packaging time: 26.3;
26.4 exists only as snapshots). Because the plugin's advertised version range
ends at 26.4, `lib/protocol-compat.js` optionally installs a **synthetic 26.4
alias**: it copies the 26.3 data to `data/pc/26.4`, rewrites its `version.json`
to `{"version":777,"minecraftVersion":"26.4","majorVersion":"26.3"}`, adds a
`data.js` entry and a `protocolVersions` entry (`dataVersion` 9 000 000).

Before a 26.4 bot connects, call
`syncFutureVersionProtocol('26.4', <protocol from server ping>)` so the
handshake uses the real protocol number while packet schemas still come from
the 26.3 data. If real 26.4 data ever lands in `minecraft-data`, the installer
detects it and leaves it untouched instead of writing the alias.

**Risk:** this only works when the real 26.4 wire format is close enough to
26.3. It will break as soon as 26.4 changes packet ids/schemas. It is *never*
counted as "supported" by `upstreamCompatStatus()` (`futureTested: false`).
The synthetic upper-bound entry (`999.0`, see below) is what actually lets
`mineflayer` accept the alias without being blocked by its
`latestSupportedVersion` gate.

**Known upstream limitation (measured):** the vendored mineflayer 4.39.0 PR
contains hardcoded `bot.version === '26.3'` checks in
`lib/plugins/physics.js` (26.3 teleport-confirm semantics). With the plain
alias (`minecraftVersion: '26.4'`) a 26.3 server logs
`Invalid move player packet received` and drops the bot about a second after
spawn; join/spawn/state/chat still work. The escape hatch is
`syncFutureVersionProtocol('26.4', protocol, { presentAs: '26.3' })`: the data
key and handshake protocol stay 26.4 / real, but the client identifies as the
emulated release, so physics takes the 26.3 path and the bot stays online
(verified in `test/protocol-compat.test.mjs`). Once a real 26.4 protocol lands,
the upstream stack needs a new port instead of this alias.

## What lib/protocol-compat.js does with this payload

1. Copies each package into `<plugin>/node_modules/<pkg>` when the installed
   copy differs from this payload. Original packages are backed up once to
   `node_modules/.dsh-upstream-bak-<pkg>` (never deleted outright).
2. Copies `minecraft-data-extra/pc/26.2|26.3` into
   `node_modules/minecraft-data/minecraft-data/data/pc/`, installs the
   `features.json`, and (re)writes the 26.2/26.3/26.4 `data.js` object literals
   from `dataPaths.json` plus the 26.2/26.3/26.4 version lists
   (`data/pc/common/{versions,protocolVersions}.json`).
3. Patches the `mineflayer` version window in memory: adds `26.2`, `26.3` and
   the synthetic `999.0` entry to `testedVersions`, sets
   `latestSupportedVersion = '999.0'` (oldest stays `1.8.8`) and registers
   `minecraftData.versionsByMinecraftVersion.pc['999.0']`
   (`{version: 777, dataVersion: 1000000000}`), so no real/future server version
   can be rejected by the "latest supported" gate. (`version` must be truthy:
   mineflayer's loader throws on a falsy `latestSupportedProtocolVersion`, so
   the synthetic entry carries 777 instead of 0.)
4. Writes `node_modules/.dsh-upstream-compat.json` as an idempotency marker;
   re-running `installUpstreamCompat()` is a no-op and does not touch any file.

Generated `manifest.json` (next to this README) records the source commits,
per-package file counts and tree SHA-256 values used for provenance checks.
