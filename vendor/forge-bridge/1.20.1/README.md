# DSH Test Bridge — Forge 1.20.1 (`dsh_test_bridge` 0.1.0)

A tiny, **server-side-only** Forge 1.20.1 mod used by the DSH
`dsh-plugin-minecraft-devtest` plugin. It lets a **vanilla-protocol client** — such as a
Mineflayer test bot — complete the login and join a **modded Forge 1.20.1 test
server**, so player-level tests can run against a Forge server without a real
Forge client.

> **Test-only.** Do not install this on a public/production server. It disables
> the Forge gate that normally keeps unmodded clients out; modded blocks,
> items, entities, GUIs and network channels still do **not** exist for a
> vanilla client, and mods with their own vanilla-client checks may still
> refuse the connection.

## Files

```
1.20.1/
├── dsh-test-bridge-0.1.0.jar     # prebuilt, bundled with the plugin
├── build.ps1                     # reproducible build (javac + jar, no Gradle/MDK)
├── README.md                     # this file
└── src/main/
    ├── java/dev/dsh/bridge/
    │   ├── DshTestBridgeMod.java             # minimal @Mod entry point
    │   └── mixin/NetworkRegistryMixin.java   # the actual bridge
    └── resources/
        ├── META-INF/mods.toml                # modLoader=javafml, modId=dsh_test_bridge
        └── dsh-test-bridge.mixins.json       # Mixin config (JAVA_17, remap=false)
```

## How it works

Forge 1.20.1 rejects vanilla clients during login in
`net.minecraftforge.server.ServerLifecycleHooks`:

```java
if (type == ConnectionType.VANILLA && !NetworkRegistry.acceptsVanillaClientConnections()) {
    // disconnect: "This server has mods that require Forge to be installed on the client..."
}
```

`NetworkRegistry.acceptsVanillaClientConnections()` returns whether every
registered network channel accepts vanilla clients; with any normal Forge mod
installed it returns `false`.

The bridge is a Mixin that injects at the `HEAD` of that static method and
forces the return value to `true`:

```java
@Mixin(value = NetworkRegistry.class, remap = false)
public class NetworkRegistryMixin {
    @Inject(method = "acceptsVanillaClientConnections",
            at = @At("HEAD"), cancellable = true, remap = false)
    private static void dshTestBridge$forceAcceptVanillaClientConnections(
            CallbackInfoReturnable<Boolean> cir) {
        cir.setReturnValue(Boolean.TRUE);
    }
}
```

Both annotations use `remap = false` because `net.minecraftforge.network.
NetworkRegistry` is a Forge class in the production (SRG) environment; its
names are not obfuscated and must not be remapped. For the same reason no
refmap is generated or required.

The mixin is discovered through the jar manifest attribute
`MixinConfigs: dsh-test-bridge.mixins.json`; `META-INF/mods.toml` plus the empty
`DshTestBridgeMod` class make it a normal `javafml` Forge mod (so FML has a real
mod class and the jar is a proper mod file, not an orphan jar).

## Build

No Gradle, no MDK, no third-party mod jars are used — only the JDK and the
libraries of an already-installed Forge 1.20.1 server.

Requirements: JDK 17, and a Forge 1.20.1 server directory containing
`libraries/` (e.g. `D:\Minecraft\数据包\_mw_server\forge-1.20.1`).

```powershell
cd D:\Minecraft\dsh-mc\minecraft-devtest\vendor\forge-bridge\1.20.1
powershell -ExecutionPolicy Bypass -File .\build.ps1
# or with explicit locations:
powershell -ExecutionPolicy Bypass -File .\build.ps1 `
  -ForgeServerDir 'D:\Minecraft\数据包\_mw_server\forge-1.20.1' `
  -JavaHome 'D:\Program Files\Java\jdk-17'
```

Environment overrides: `DSH_FORGE_SERVER_DIR` (Forge server dir) and
`JAVA_HOME` (JDK 17). The script compiles all `.java` files with
`--release 17` against every jar in `<forge-server>/libraries` (recursively),
copies resources, writes `META-INF/MANIFEST.MF` with the `MixinConfigs`
attribute, packages `dsh-test-bridge-0.1.0.jar` next to the script, verifies the
expected entries/manifest, then removes its temporary `build/` folder.

## Install

Copy the jar into the Forge test server's `mods/` folder and restart:

```
<forge-1.20.1-server>/mods/dsh-test-bridge-0.1.0.jar
```

The server log should contain a line like:

```
[modloading-worker-0/] ... DSH Test Bridge (Forge 1.20.1) ...
```

and **must not** contain "This server has mods that require Forge to be
installed on the client" when a vanilla client connects.

## Verification (real Forge server, vanilla Mineflayer client)

Verified on 2026-11-14 against a **copy** of the local modded Forge 1.20.1
server (the original installation was never modified): Forge 47.4.28,
MC 1.20.1, `libraries` junctioned, all 10 user mods copied (tacz, monster-war,
kubejs, geckolib, architectury, cloth-config, ...), plus this bridge jar.
Test copy config: offline mode, port 25630, RCON 25631, flat `world_bridge`,
Java 17.0.9, 1.5 GB heap, Mineflayer 4.39.0.

Evidence from that run:

- FML loaded the mod (log names the jar as a mod file):
  `[main/WARN] [net.minecraft.server.packs.repository.Pack/]: Missing metadata in pack mod:dsh_test_bridge`
  — the only two lines it produces, and they are harmless (the bridge has no
  data pack).
- Vanilla client login was **accepted**; the old rejection message
  `This server has mods that require Forge to be installed on the client` does
  **not** appear anywhere in `latest.log`.
- Vanilla Mineflayer bot (protocol 763 / MC 1.20.1, offline user `BridgeBot`):
  ```
  [Server thread/INFO]: BridgeBot[/127.0.0.1:39403] logged in with entity id 1 at (-2.5, -60.0, -1.5)
  [Server thread/INFO]: BridgeBot joined the game
  ```
  bot state: `health=20 food=20 dimension=overworld gameMode=creative`,
  position `(-2.5, -60, -1.5)`.
- Two-way chat verified: server `say` reached the bot
  (`[Rcon] BRIDGE_RCON_OK`), and bot chat reached the server:
  `[Server thread/INFO]: [Not Secure] <BridgeBot> hello from vanilla mineflayer`.
- `rcon list` → `There are 1 of a max of 20 players online: BridgeBot`.
- Graceful stop via RCON: bot got
  `multiplayer.disconnect.server_shutdown`, server logged `Stopping server`,
  ports 25630/25631 released, no Java process left.
- No new `ERROR`/`FATAL` lines were introduced by the bridge; the only
  pre-existing noise was Forge's own Mixin `org.jetbrains.annotations` warnings
  and a `No key layers in MapLike[{}]` line caused by the test copy's
  `generator-settings={}`.
- Distribution checks: `node --test test/forge-bridge.test.mjs` in the plugin
  root (5/5 pass, jar tool skipped automatically when no JDK is found).

Known cosmetic behaviour with heavily modded servers: mods may still send large
custom payloads at join (e.g. TaCZ gun/attachment data). Mineflayer ignores
them; the bot stays connected, as observed here.

## Limitations / known risks

- Only makes the **login gate** permissive. A vanilla client still receives the
  modded world's vanilla-visible parts only: modded blocks are sent as registry
  ids the client does not know (Mineflayer usually logs "unknown block state"
  and falls back), modded items/entities are invisible/unusable, and modded
  GUIs/custom payload flows are ignored.
- Mods that enforce their own vanilla-client rejection (e.g. by checking the
  connection type themselves or rejecting login packets) can still refuse the
  connection. Watch the server log for the mod id then.
- Some mods send large custom payloads on join; the bot may log unknown
  channels but should keep the connection. If the bot disconnects right after
  join, capture the server log and the exact client error.
- Mixin `@Inject` has `require = 1` (default `defaultRequire`), so if the target
  method is missing (different Forge/MC version) the server fails fast instead
  of silently doing nothing. This jar targets **Forge 1.20.1 / 47.x only**.
- Only the server side is affected; the mod is not meant for clients.
