# Changelog

All notable changes to this project are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
versions follow [Semantic Versioning](https://semver.org/).

## [0.4.0] - 2026-11-18

### Added
- Loader launch support verified end-to-end: Forge 1.7.10 / 1.12.2 / 1.20.1,
  Fabric 1.21.1, Quilt 1.21.1, NeoForge 1.21.1 (official installers), with
  automatic launch-form detection and Java selection.
- Quilt launch support (`quilt-server-launch.jar`).
- Bot compatibility layer beyond Mineflayer: `legacy` 1.7.x bot
  (`lib/legacy-bot.js`), `emulated` 26.2/26.3 (`lib/protocol-compat.js` +
  `vendor/upstream-26.3/`), `emulated-future` 26.4 best effort.
- Vanilla server/datapack compatibility test for Minecraft 26.3 including
  1.21.9+ `min_format`/`max_format` requirement detection.
- `docs/LOADERS.md`, `docs/API.md` (generated), public npm/GitHub metadata,
  LICENSE and THIRD_PARTY_NOTICES.

### Fixed
- Old Forge universal jars' launcher-profile `version.json` misdetection that
  selected the wrong Java and crashed.
- NeoForge library directory → Minecraft version mapping.
- `script`/`gradle` launch modes now inject the selected JDK into the child
  process `PATH` / `JAVA_HOME`.
- 26.3 servers default `white-list=true`; startup patch now forces
  `white-list=false` / `enforce-whitelist=false`.
- `pack.mcmeta` with `pack_format > 81` but without `min_format`/`max_format`
  is now flagged by `mcdt_datapack validate` and quickcheck log scanning.
- `peerDependencies` range widened from exact `0.2.2-rc.1` to
  `^0.2.2-rc.1` so the plugin keeps loading after DSH upgrades (tested with
  0.2.2-rc.5).

## [0.3.0] - 2026-11-14

### Added
- `lib/versions.js`: release registry for 76 official releases 1.7.10–26.3
  (26.4 forward-compatible), Java requirements, data pack formats, version
  comparison, server-jar name inference, installed-JDK scanning and
  version-aware Java selection.
- Server start: automatic Java selection, version inference from
  version.json / jar names / Forge libraries / Fabric cache / logs / dir names,
  legacy Forge executable-jar priority, Java retry on
  `UnsupportedClassVersionError`.
- Data pack formats for all releases 1.13–26.3 verified against real server
  jars; pre-1.13 servers clearly report "no datapack support".
- `scripts/gen-versions.mjs` to refresh the version table from Mojang
  piston-meta.

## [0.2.0] - 2026-11-14

### Added
- Forge 1.20.1 dedicated test bridge mod (own Mixin implementation,
  `vendor/forge-bridge/`), auto-installed by `mcdt_bridge` / quickcheck.
- Multi-loader server launch: `jar | fabric | script | gradle`, respecting
  existing `server.properties` (ports, RCON password, level name).
- Safety hardening: the plugin only controls the test server it starts itself;
  bots/commands/datapack actions accept no arbitrary host/port; external RCON
  probing removed.
- Deterministic `mcdt_quickcheck` / `mcdt_test` / `mcdt_suite` flows and
  built-in guides to save tokens.

## [0.1.0] - 2026-11-14

### Added
- Initial release: 12 `mcdt_*` DSH tools, headless Minecraft server lifecycle,
  RCON client, Mineflayer player bot, datapack scan/validate/deploy/reload,
  YAML test cards, suite runner, quick check, guide, logs, init and Gradle
  helpers.
- End-to-end verification on vanilla/fabric servers and example datapacks.

[0.4.0]: https://github.com/huiyaoxingkong/minecraft-devtest/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/huiyaoxingkong/minecraft-devtest/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/huiyaoxingkong/minecraft-devtest/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/huiyaoxingkong/minecraft-devtest/releases/tag/v0.1.0
