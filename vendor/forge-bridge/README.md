# forge-bridge — bundled Minecraft test-server bridges

Server-side helper mods bundled with the `minecraft-devtest` plugin. They exist
so **vanilla-protocol test clients** (Mineflayer bots) can join **modded
servers** that would otherwise require a matching modded client.

| Target | Mod | Jar | Status |
| --- | --- | --- | --- |
| Forge 1.20.1 (47.x) | `dsh_test_bridge` 0.1.0 | [`1.20.1/dsh-test-bridge-0.1.0.jar`](1.20.1/dsh-test-bridge-0.1.0.jar) | built + verified against Forge 47.4.28 |

Everything is built from source in this folder — no third-party bridge mods are
vendored or required. See [`1.20.1/README.md`](1.20.1/README.md) for the mod's
design, the build command (`1.20.1/build.ps1`, plain `javac` + `jar`, no
Gradle/MDK) and the full limitations.

Quick install for a Forge 1.20.1 test server:

```
copy 1.20.1\dsh-test-bridge-0.1.0.jar  <forge-server>\mods\
```

Then restart the server; a vanilla Mineflayer bot (MC 1.20.1, offline mode) can
join and the log must no longer contain *"This server has mods that require
Forge to be installed on the client"*.
