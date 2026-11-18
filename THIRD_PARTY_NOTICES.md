# Third-party notices / 开源声明

`dsh-plugin-minecraft-devtest` itself is licensed under the **MIT License** (see `LICENSE`).
The plugin is an independent project. This file lists every open-source
component that is redistributed with it, plus attribution for referenced work.

## 1. Redistributed open-source packages (bundled in `vendor/`)

`vendor/upstream-26.3/` contains **unmodified upstream sources** from open
PrismarineJS pull-request branches, used by `lib/protocol-compat.js` to add
Minecraft 26.2 / 26.3 (and best-effort 26.4) protocol support that the released
npm versions do not provide yet. Per-package LICENSE files are kept inside each
package directory; the exact commit / PR / tree hash is recorded in
`vendor/upstream-26.3/manifest.json`.

| Bundled package | Version | License | Upstream source |
| --- | --- | --- | --- |
| `minecraft-protocol` | 1.68.0 | **BSD-3-Clause** | https://github.com/PrismarineJS/node-minecraft-protocol (PR #1553, fork `suisarbre/node-minecraft-protocol`, branch `port-26.3`, commit `3473413d32ee09af55aa77579000391be3bb9753`) |
| `mineflayer` | 4.39.0 | MIT | https://github.com/PrismarineJS/mineflayer (PR #4206, fork `suisarbre/mineflayer`, branch `port-26.3`, commit `ad4af12611fd55309bb387b2b416212bffb0eddf`) |
| `prismarine-chunk` | 1.41.0 | MIT | https://github.com/PrismarineJS/prismarine-chunk (PR #347, fork `suisarbre/prismarine-chunk`, commit `a96fd7050163b5ae3cbce240deab453a03cd3bc2`) |
| `prismarine-physics` | 1.11.1 | MIT | https://github.com/PrismarineJS/prismarine-physics (PR #145, fork `DallasCarraher/prismarine-physics`, commit `b928638645a56a110a51da1f2080c6455b27984a`) |
| `minecraft-data` extra data (`pc/26.2`, `pc/26.3`, `features.json`, `dataPaths.json`) | 3.119.0 data | MIT | https://github.com/PrismarineJS/minecraft-data (PR #1345 / #1301, fork `suisarbre/minecraft-data`, branch `port-26.3`) |

The vendored packages are installed at runtime into `node_modules/` (an
existing installation is backed up once under `.dsh-upstream-bak-*`). They are
not forks of the plugin and receive no local patches.

## 2. Runtime npm dependencies (not vendored; installed by npm)

| Package | License |
| --- | --- |
| `mineflayer` | MIT |
| `mineflayer-pathfinder` | MIT |
| `minecraft-data` | MIT (game data derived from Minecraft; see notice below) |
| `minecraft-protocol` | BSD-3-Clause |
| `prismarine-chunk` | MIT |
| `prismarine-physics` | MIT |
| `prismarine-registry` | MIT |
| `protodef` (transitive) | MIT |

Their LICENSE files are shipped by npm inside `node_modules/`. The plugin also
lists `@deepseek-ai/dsh-tools` as a **peer dependency** because it is provided
by the running DeepSeek Harness installation; it is not bundled here.

## 3. Minecraft / Mojang notice

Minecraft content, game data and trademarks are the property of Mojang Studios
/ Microsoft. This project is **not affiliated with, endorsed by or sponsored by
Mojang Studios or Microsoft**. The protocol data bundled in
`vendor/upstream-26.3/minecraft-data-extra/` is the MIT-licensed
PrismarineJS `minecraft-data` packaging of registry/protocol numbers, included
solely so that the test bot can speak the corresponding network protocol; no
game client binaries, assets, textures, sounds or server software are
redistributed. You must obtain your own Minecraft server jars and comply with
the Minecraft EULA when using this tool.

## 4. Forge test bridge (`vendor/forge-bridge/`)

The Forge 1.20.1 bridge mod (`dsh-test-bridge-0.1.0.jar`) is **our own code**,
released under the MIT license. It is compiled against Forge/Minecraft classes
provided by the user's local Forge server installation, but **no Forge or
Minecraft binaries are redistributed**. It is a test-only shim that must not be
used on production servers. "Forge" and "Minecraft" are trademarks of their
respective owners.

## 5. Referenced work

- The minimal YAML subset parser and some card/tool patterns were inspired by
  [minecraft-mod-dev](https://github.com/yan-mc/minecraft-mod-dev) (MIT); see the
  file headers for details.
- The plugin's DSH bundle/patch pattern follows the DeepSeek Harness plugin
  conventions (`@deepseek-ai/dsh-tools`, MIT-licensed DeepSeek Harness).
- Documentation was generated/maintained by this project's authors with
  AI-assisted tooling; all bundled component attribution above remains in
  effect.

## 6. Documentation

`docs/API.md` is generated from `index.js` via `npm run gen:docs`. `docs/`
contains engineering notes, requirements and a verification report; they are
provided under the same MIT license as the project.
