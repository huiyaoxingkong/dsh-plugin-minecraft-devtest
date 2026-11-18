# 加载器（Mod Loader）启动支持矩阵

> 结论先说：**能启动**——只要用官方安装器把加载器服务端装到一个目录里，`mcdt_server(serverDir=...)` 会自动识别并启动；插件不负责安装加载器（安装器是一次性准备）。
> "全加载器"只包括**有服务端形态**的加载器：Forge、NeoForge、Fabric、Quilt。LiteLoader / Rift / Risugami's ModLoader 是**客户端加载器**，没有服务端启动形态，不能作为测试服启动。Paper/Purpur/Spigot 是服务端平台（插件），不是模组加载器，但插件同样能启动。

## 1. 加载器 × MC 版本覆盖（正式版 1.7.10 – 26.3）

依据：Forge maven-metadata（5106 条）、Fabric meta（stable game list）、Quilt meta（stable game list）、NeoForge maven-metadata（1859 条）。

| 加载器 | 覆盖的 MC 正式版 | 覆盖数 | 说明 |
|---|---|---|---|
| **Forge** | 1.7.10 – 26.3（有 20 个"跳版"没有 Forge 构建） | 56 / 76 | 可用 Forge 的版本直接装；跳版用最近的受支持补丁版（下表） |
| **Fabric** | 1.14 – 26.3（全部 48 个正式版） | 48 / 76 | 1.13.2 及以下官方 Fabric Loader 不支持（Legacy Fabric 是第三方，未纳入） |
| **NeoForge** | 1.20.2 – 26.3 | 1.20.2+ 全部 | NeoForge 是 1.20.2 起的 Forge 分支；1.20.1 及以下没有 NeoForge |
| **Quilt** | 1.14.4 – 26.3（元数据 stable 44 个） | 44 / 76 | 实际 Quilt 模组生态以 1.18.2+ 为主；能否装成功以 quilt installer 的 game 列表为准 |

### Forge 跳版 → 建议替代

以下 MC 正式版没有 Forge 构建，测试时改用括号内的最近补丁版：

| 无 Forge 的版本 | 建议 |
|---|---|
| 1.8.1–1.8.7 | 1.8.9 |
| 1.9.1–1.9.3 | 1.9.4 |
| 1.10.1 | 1.10.2 |
| 1.11.1 | 1.11.2 |
| 1.13 / 1.13.1 | 1.13.2 |
| 1.14 / 1.14.1 | 1.14.4 |
| 1.16 | 1.16.5 |
| 1.17 | 1.17.1 |
| 1.20.5 | 1.20.6 |
| 1.21.2 | 1.21.3 |

> 其余 56 个正式版都有官方 Forge 构建（含 1.7.10、1.12.2、1.16.5、1.18.2、1.19.4、1.20.1、1.21.1、1.21.11、26.3 等）。

## 2. 插件如何启动各种加载器（自动识别，无需指定）

| 加载器 / 安装形态 | 目录特征 | 插件启动方式 |
|---|---|---|
| Fabric（官方安装器） | `fabric-server-launch.jar` + `libraries/` | `java -jar fabric-server-launch.jar nogui`（fabric 模式） |
| Quilt（官方安装器） | `quilt-server-launch.jar` + `libraries/` | `java -jar quilt-server-launch.jar nogui`（fabric 模式，loader 显示 quilt） |
| Forge 1.7.10–1.16.5（旧安装器） | `minecraft_server.<ver>.jar` + `forge-<ver>-...-universal.jar` / `forge-<ver>-....jar` + `libraries/` | 自动选 Forge 可执行 jar（jar 模式） |
| Forge 1.17+ / NeoForge 1.20.2+（新安装器） | `run.bat` / `run.sh` + `libraries/` + `user_jvm_args.txt` | `cmd /c run.bat nogui`（script 模式，进程树可杀干净） |
| 开发工程（Fabric/Forge/NeoForge） | `gradlew` | `gradlew runServer`（gradle 模式） |
| Paper / Purpur / Spigot（服务端平台，非加载器） | `paper-*.jar` / `purpur-*.jar` / `spigot-*.jar` | java -jar（jar 模式） |

Java 仍按 MC 版本自动选择（1.7.10–1.16.5→8、1.17→16/17、1.18–1.20.4→17、1.20.5–1.21.11→21、26.x→25；安装器也用它）。

## 3. 真实安装 + 插件启动验证（2026-11-14/15）

> 验证方式：官方安装器装到 `.tmp/loaders/<loader>-<mc>/`，用 `serverManager.start()` 启动 → `status` → RCON `list` → `stop`；全部断言 **started + RCON 可用 + 优雅停止（无 forced kill）**。

| 加载器 + MC | 安装方式 | 插件识别（status） | 启动耗时 | RCON | 停止 |
|---|---|---|---|---|---|
| **Forge 1.7.10** | Forge 官方 installer `--installServer`（Java 8） | `mode=jar`、`loader=forge`、`version=1.7.10`、`versionSource=version.json`、`javaMajor=8` | 10.5s | ✅ `There are 0/5 players online:` | ✅ clean |
| **Forge 1.12.2** | Forge 官方 installer `--installServer`（Java 8） | `mode=jar`、`loader=forge`、`version=1.12.2`、`versionSource=forge-library`、`javaMajor=8` | 11.8s | ✅ | ✅ clean |
| **Fabric 1.21.1** | Fabric 官方 installer `server -mcversion 1.21.1` | `mode=fabric`、`loader=fabric`、`version=1.21.1`、`versionSource=version.json`、`javaMajor=21` | 19.8s | ✅ | ✅ clean |
| **Quilt 1.21.1** | Quilt 官方 installer `install server 1.21.1` | `mode=fabric`、`loader=quilt`、`version=1.21.1`、`versionSource=version.json`、`javaMajor=21` | 22.9s | ✅ | ✅ clean |
| **NeoForge 1.21.1** | NeoForge 官方 installer `--installServer`（Java 21） | `mode=script`、`loader=neoforge`、`version=1.21.1`、`versionSource=forge-library`、`javaMajor=21` | 17.4s | ✅ | ✅ clean |

补充证据（此前轮次）：
- **Forge 1.20.1**：`run.bat` script 模式启动 + 内置测试桥，Mineflayer 机器人可 join（10 个模组的真实整合服）。
- **Fabric 1.20.1 / 1.21.1 / 1.21.11**：用户 `_mw_server/fp-*` 真实测试服，插件启动 + 机器人 join/聊天通过。
- **插件工具级复验（2026-11-15）**：`mcdt_server(start)` 直接启动 Quilt 1.21.1（`mode=fabric/loader=quilt/javaMajor=21`）、Forge 1.12.2（`jar/forge/Java8`）、NeoForge 1.21.1（`script/neoforge/Java21`）均 `ready:true` 并可优雅 stop；`mcdt_quickcheck(fabric-1.21.1)` 全绿（起服 + RCON + **机器人 join/chat** + 停服）。
- **Paper/Purpur/Spigot**：插件按 jar 模式启动（选择优先级 paper/purpur/spigot > forge > vanilla），无第三方实测服（Paper API 当前 410/403 不可下载）。

> 本机 `maven.neoforged.net` 当前被 DNS 污染/TCP 阻断；NeoForge 安装器用 BMCLAPI 镜像并重写 installer 内 51 处 URL 完成（patched jar 保留在 `.tmp/loaders/_installers/neoforge-21.1.266-installer-bmcl.jar`）。网络正常时直接用官方 installer 即可。

结论：**Forge（旧版可执行 jar / 新版 run 脚本）、Fabric、NeoForge、Quilt 的服务端都能被插件自动识别并启动/停服**；覆盖哪些 MC 版本取决于加载器自身（见第 1 节），不是插件限制。

## 4. 机器人能否进加载器服

| 加载器 | mcdt_bot 直接 join | 说明 |
|---|---|---|
| Fabric / Quilt / Paper / Purpur / vanilla | ✅ | 原版协议可进 |
| Forge 1.20.1 | ✅（安装内置 `dsh_test_bridge` 后） | 专用测试桥放行登录 |
| Forge 其它版本 / NeoForge | ❌ | FML 握手拒绝 vanilla 协议；请用 RCON 断言（`/data`、`/execute`、`/loot`、KubeJS 命令等） |

## 5. 限制与下一步

- 插件**不自动安装加载器**：请先用官方安装器装一次（Fabric/Quilt installer、Forge/NeoForge `--installServer`），之后 `mcdt_server` 一键启动。若需要"插件内自动装加载器"，可再加 `mcdt_loader` 工具（封装四个官方 installer）。
- 加载器本身的版本覆盖限制如上：Forge 有 20 个跳版、Fabric 只 1.14+、NeoForge 只 1.20.2+、Quilt 以元数据为准——**不是插件能力问题**。
- 同一时间只跑一个测试服（见 TESTING 第 6 节内存说明）。
