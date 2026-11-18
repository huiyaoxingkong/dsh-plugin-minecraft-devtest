# Contributing

Thanks for your interest in `minecraft-devtest`! This is a **test-only** harness;
please never point it at production servers.

## Development setup

```bash
git clone https://github.com/huiyaoxingkong/minecraft-devtest.git
cd minecraft-devtest
npm install
npm run check        # syntax check of the main modules
npm run test:unit    # offline unit tests (no Minecraft server required)
npm run gen:docs     # regenerate docs/API.md after changing tool definitions
```

Heavy integration tests (`test/server.test.mjs`, `test/bot.test.mjs`,
`test/protocol-compat.test.mjs`, `test/legacy-bot.test.mjs`, `test/datapack.test.mjs`,
`test/util.test.mjs`) start real Minecraft servers and need local fixtures
(server jars / JDKs) — see `docs/TESTING.md` for the environment and commands.
They skip gracefully when fixtures are missing.

## Pull requests

1. Keep the **safety boundary**: the plugin may only control the test server it
   starts itself; never add arbitrary host/port or external-server control.
2. Update docs when behavior changes (`README.md`, `docs/*`, built-in guide in
   `lib/guide.js`) and regenerate `docs/API.md`.
3. Run `npm run check` and `npm run test:unit` at minimum; describe any
   integration verification you ran.
4. Do not commit `node_modules/`, `.tmp/`, server worlds/logs, or credentials.
5. New bundled third-party code must be recorded in
   `THIRD_PARTY_NOTICES.md` (license, version, commit) and in
   `vendor/upstream-26.3/manifest.json` if it extends the protocol layer.

## Release checklist (maintainers)

```bash
npm run gen:docs
npm run check
npm run test:unit
npm pack --dry-run
npm publish            # needs npm authentication
git tag vX.Y.Z && git push --tags
```

## License

By contributing you agree that your contributions are licensed under the MIT
License (see `LICENSE`). Vendored upstream components keep their own licenses.
