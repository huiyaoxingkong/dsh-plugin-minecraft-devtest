<p align="center">
  <img src="./icon.svg" width="72" alt="dsh-plugin-minecraft-devtest">
</p>

# dsh-plugin-minecraft-devtest

[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![GitHub](https://img.shields.io/badge/github-huiyaoxingkong%2Fdsh--plugin--minecraft--devtest-181717?logo=github)](https://github.com/huiyaoxingkong/dsh-plugin-minecraft-devtest)

**免游戏客户端**的 Minecraft 模组 / 数据包开发测试台，以 DeepSeek Harness（DSH）插件形式运行。

> Client-free Minecraft mod / datapack development harness for DeepSeek Harness (DSH):
> headless server control (1.7.10–26.4), RCON assertions, deterministic YAML test cards,
> Mineflayer + built-in legacy/26.x protocol bots, one-call quick checks.

它解决的是「AI 改完代码/数据包，怎么在**不开游戏客户端**的情况下知道它真的能跑、且符合预期」：

- **无头服务器**：从你已经搭好的测试服目录启动（`server.jar` / `fabric-server-launch.jar` / Forge/NeoForge 的 `run.bat` / 项目的 `gradlew runServer`），自动写 EULA、离线模式，**沿用该服务器已有的端口/RCON 密码**，等 `Done (...)` 后返回；
- **RCON 命令层**：`mcdt_command` 执行服务端控制台命令并拿回文本，做 `/data get`、`/execute if`、`/scoreboard`、`/datapack list`、`/reload` 断言；
- **Mineflayer 玩家机器人**：代替客户端进服，做玩家会做的事——聊天、走位、挖掘、放置、合成、开箱子、打怪、看背包/血量；
- **专用 Forge 测试桥 mod（内置）**：插件自带一个我们自己写的极小 Forge 1.20.1 服务端 mod（`vendor/forge-bridge/`，不依赖第三方 mod），让原版协议的测试机器人能进入带模组的 Forge 测试服；
- **测试卡**：把一组检查写成 YAML 卡片（命令 + 机器人动作 + 断言），插件本地顺序执行，只把 **pass/fail 摘要** 交回模型，一批检查只花一次工具调用；
- **一键体检**：`mcdt_quickcheck` 自动识别数据包 / 模组工程 / 测试服，跑「校验 + 起服 + RCON + 部署重载 + 日志扫描 + 机器人冒烟」并返回紧凑清单；
- **内置知识**：`mcdt_guide` 内置格式表、报错含义、卡片语法，减少模型上网/翻文档的 token。

## 多版本支持（正式版 1.7.10 – 26.4）

覆盖 **76 个正式版（1.7.10 – 26.3）**，26.4 发布前按前瞻处理（Java 25、pack_format 运行时从 server jar 读取）。快照/pre/rc 不纳入支持矩阵。

| 维度 | 支持情况 |
|---|---|
| 服务端启动 | 任意版本的 `server.jar`（含目录外/同级 `server-<版本>.jar`）、Fabric 启动 jar、Forge/NeoForge 安装器目录（`run.bat` 或旧版可执行 Forge jar）、Paper/Spigot/Purpur、Gradle 工程 |
| 加载器启动 | **Forge / Fabric / NeoForge / Quilt 服务端均可启动**（先用官方安装器装一次，插件自动识别启动形态：Fabric/Quilt launch jar、旧 Forge 可执行 jar、新 Forge/NeoForge `run.bat`、gradle）。已真实验证：Forge 1.7.10、Forge 1.12.2、Forge 1.20.1、Fabric 1.21.1、Quilt 1.21.1、NeoForge 1.21.1。版本覆盖取决于加载器本身：Forge 1.7.10–26.3（20 个跳版）、Fabric 1.14–26.3、NeoForge 1.20.2–26.3、Quilt 1.14.4–26.3（元数据）；LiteLoader/Rift/ModLoader 是客户端加载器，无服务端形态。详见 [`docs/LOADERS.md`](./docs/LOADERS.md) |
| Java 选择 | 自动按版本选已装 JDK：1.7.10–1.16.5→**8**、1.17→16（无 16 用 17）、1.18–1.20.4→**17**、1.20.5–1.21.11→**21**、26.x→**25**；Java 版本不匹配时自动换 Java 重试一次（`javaPath` 可手动覆盖） |
| 版本探测 | server jar 的 `version.json`、jar 文件名、Forge/NeoForge libraries、Fabric cache、`logs/latest.log`、目录名；`mcdt_server` 的 `status` 返回 `version/loader/versionSource/javaPath/javaMajor` |
| 数据包 | **1.13 起**支持；pack_format 数据来自 `lib/versions.js`（用真实 server jar 校验：1.18.2=9、1.19.3=10、1.19.4=12、1.20.1=15、1.20.6=41、1.21.1=48、1.21.11=94、26.3=121 …），首次运行还会从 jar 的 `version.json` 动态读取；1.7.10–1.12.2 无数据包，插件会明确提示并跳过相关检查 |
| 机器人 | **1.7.10–26.4 全覆盖（26.4 best-effort）**：1.7.x 走插件自研「原生 1.7 协议机器人」；1.8.8–26.1 走 Mineflayer 官方；**26.2/26.3 走插件内置的上游 26.3 协议 PR 包**（`vendor/upstream-26.3/`，首次加载自动安装到 node_modules）；26.4 未发布按 emulated-future 尽力处理；其它版本自动降级 RCON-only warning。Forge 1.20.1 装内置测试桥后也可 join |

## 原版服务器 / 数据包（核心用途）

原版（vanilla）服务端是数据包测试的主场景，插件不依赖任何 mod/插件，只用服务端 jar + RCON + 可选机器人：

- **启动**：任意版本 `server.jar`（目录内、目录外、同级 `server-<版本>.jar` 均可），自动按 MC 版本选 JDK，自动离线/RCON/白名单配置；
- **数据包能力**：**1.13 起**；1.7.10–1.12.2 没有数据包，`deploy/reload` 会明确报错；
- **全链路**：`validate`（对照该版本 server jar 的 `version.json`）→ `deploy` 到 `world/datapacks` → `/reload` → `/datapack list` → RCON 行为断言 / 机器人 join/chat；
- **已实测**：
  - **Vanilla 26.3（Java 25）**：pack_format 121（`min_format`/`max_format` 写法）validate/deploy/reload/list 全通过；load function 执行后 RCON `scoreboard players get #loaded dsh_probe` = **1**；机器人（emulated 模式）join/state/chat 正常；
  - **Vanilla 1.20.1（format 15）**：示例数据包 + 3 张测试卡全绿；
  - **Vanilla 1.20.6（format 41）**：monster_war 真实数据包部署/reload/list + 机器人全绿；
  - **Fabric 1.21.11（format 94）**：数据包逻辑与 vanilla 相同，已验证。
- **1.21.9+ 注意**：`pack_format > 81` 的包必须同时声明 `min_format`/`max_format`（数字或 `[major,minor]`），否则服务端报 `Pack declares support for version newer than 81, but is missing mandatory fields min_format and max_format` 并拒绝；插件的 validate/quickcheck 会给出 warning/失败提示。

## 机器人版本兼容层（不局限于 Mineflayer）

Mineflayer 官方只支持 1.8.8 以上、且协议数据通常滞后最新正式版。本插件在 `mcdt_bot` 内部按 `botSupport(version).mode` 自动分派，**同一个 `mcdt_bot` 接口覆盖 1.7.10–26.4**：

| mode | 版本 | 实现 | 动作范围 |
|---|---|---|---|
| `legacy` | 1.7.x（1.7.10 起） | 自研 `lib/legacy-bot.js`，直接使用原生 1.7 协议（不依赖 Mineflayer） | chat / look / goto / dig / place / use_block / use_item / attack / wait / stop；inventory/equip/craft/容器等不可用 |
| `native` | 1.8.8–26.1 | Mineflayer + minecraft-data（官方窗口） | 全部玩家动作 |
| `emulated` | 26.2 / 26.3 | `lib/protocol-compat.js`：内置上游 PrismarineJS 26.3 协议 PR 包（nmp/mineflayer/prismarine-chunk/prismarine-physics）+ 26.2/26.3 minecraft-data 数据补丁，首次加载自动安装（幂等，约 0.4s） | 同 native |
| `emulated-future` | 26.4（未发布） | 26.3 数据别名 + 服务端 protocol 同步，best-effort | 同 native（协议变更时 join 会降级报错） |
| `unsupported` | 26.5+ / 1.6.x 等 | — | join 抛 `BOT_VERSION_UNSUPPORTED`，quickcheck 自动 RCON-only warning |

> 机器人兼容层全部内置在 `vendor/upstream-26.3/`（约 13.7 MB，含来源 URL/PR/commit 与 SHA256 manifest，不依赖第三方 mod）；只在 `mcdt_bot`/quickcheck 首次加机器人时激活，纯 RCON/数据包测试不需要。
>
> 内存提示（16GB 机器实测）：插件的 quickcheck/测试一次只管理一个测试服；多版本验证请逐个 start/stop，**不要同时手工再起第二个 MC 服**（两个 Java 服各约 1.3GB，叠加 DSH 宿主后系统可用内存会吃紧）。

## 「只进入搭好的测试服务器」

这个插件的定位是**测试台**，不是远程控制工具：

- `mcdt_command` / `mcdt_bot` / 测试卡里的命令和机器人**只作用于本插件用 `mcdt_server` 启动的那一个测试服务器**（端口/RCON 全部取自它）；工具层不接受任意 host/port，也不连接外部已运行的服务器；
- 需要测试的服请先自己搭好目录（安装好 Forge/NeoForge/Fabric/vanilla 服务端），再用 `mcdt_server(start, serverDir=...)` 拉起来；
- 启动时会强制 `online-mode=false`、补齐 RCON 配置，并保留其它 `server.properties` 键（首次备份 `.dsh-backup`）；
- **不要**把插件指向正式服/朋友服：它会把该服改成离线验证并接管 RCON。

数据包格式（pack_format）会优先从服务器 jar 的 `version.json` 读取并与 `lib/versions.js` 版本表比对，未知版本不误报。

> **实测状态（2026-11-14）**：模块测试 200+ 通过；1.7.10/1.12.2/1.13.2/1.14.4/1.16.5/1.18.2/1.19.4/26.2/26.3 真实服务端均能由插件启动（自动 Java 选择）并通过 RCON；机器人真机验证：1.7.10（legacy）、1.8.8–26.1（native）、26.2/26.3（emulated）均 join→state→chat→quit 通过；Fabric 1.20.1/1.21.11、Forge 1.20.1（内置测试桥）、Vanilla 1.20.6 的完整「起服 → RCON → 数据包部署/重载 → 机器人 join/chat → 停服」链路已通过，并检出用户数据包的真实错误。证据见 [`docs/TESTING.md`](./docs/TESTING.md)。

## 它不能做什么

- 没有游戏画面：**渲染、贴图、粒子、音效、GUI 视觉效果**无法断言（需要客户端或人工看）；
- 机器人是「原版协议客户端」：能加入 Fabric/vanilla 服；Forge 服需要内置测试桥，且**看不懂模组方块/物品的注册名**（1.20.1 协议不发送注册表），模组内容的断言请走 RCON（`/data`、`/execute`、KubeJS 暴露的命令等）；
- 1.7.x 的 legacy 机器人只覆盖基础动作（chat/look/goto/dig/place/use/attack/wait），**没有背包/合成/容器**，`state()` 的 dimension/gameMode 是 1.7 数字形态；
- 26.2/26.3 的 emulated 依赖内置的上游协议 PR 包；26.4 未发布，emulated-future 为 best-effort，协议变更时机器人会失败并明确降级（RCON 断言不受影响）；
- 机器人 `goto` 是**纯走路**（不挖方块、不搭桥/搭塔），跨坑目标返回 `arrived:false`；不做自动重连；
- `mcdt_bot eat` 的正常进食路径代码已实现，但集成测试目前只覆盖错误路径；
- 测试桥只对 **Forge 1.20.1** 构建；NeoForge/其它版本请等待后续版本或改用 GameTest/RCON。

## 工具一览

| 工具 | 作用 |
|---|---|
| `mcdt_server` | 启/停/状态/日志：从已搭好的测试服目录启动（auto/jar/fabric/script/gradle） |
| `mcdt_command` | 在**本插件启动的测试服**上执行 RCON 命令，返回响应文本 |
| `mcdt_bot` | 玩家机器人（1.7.10–26.4，自动选择 native/emulated/legacy 模式）；join 只能连本插件启动的测试服 |
| `mcdt_bridge` | 内置专用 Forge 1.20.1 测试桥：status / install / remove（`<serverDir>/mods`） |
| `mcdt_datapack` | 扫描/校验/查找/部署/重载/列出数据包，自动核对 pack_format |
| `mcdt_test` | 执行一张 YAML/JSON 测试卡（或内联 steps），返回紧凑步骤结果 |
| `mcdt_suite` | 跑一个目录下所有测试卡，只回汇总与失败项 |
| `mcdt_quickcheck` | 一键体检（静态校验 + 起服 + 数据包热载 + 日志 + 机器人冒烟；Forge 会自动安装测试桥） |
| `mcdt_init` | 扫描工程，生成一份可直接跑的测试卡骨架 + README（默认 `<projectDir>/mc-tests`） |
| `mcdt_gradle` | 跑任意 Gradle 任务（build / runGameTestServer / runServer / genSources） |
| `mcdt_logs` | 只读尾部或只回解析后的错误/数据包加载问题，避免日志刷屏 |
| `mcdt_guide` | 内置指南（概览/卡片/数据包/机器人/服务器/报错/版本） |

## 安装

### 方式一：作为 DSH 插件（推荐）

在 DSH 插件管理器中安装（`target` 可以是本地目录，也可以是 npm 包名/`github:` 地址）：

```text
plugin_manager action=install_bundle target=D:\path\to\dsh-plugin-minecraft-devtest
plugin_manager action=install_bundle target=dsh-plugin-minecraft-devtest  # 发布到 npm 之后
```

安装后插件会注册 12 个 `mcdt_*` 工具。已在 **DSH 0.2.2-rc.5** 上验证；`peerDependencies` 为
`@deepseek-ai/dsh-tools: ^0.2.2-rc.1`（兼容 rc.1–rc.5，后续 DSH 升级一般无需改代码）。
机器人相关依赖（mineflayer 等）由插件管理器用 pnpm 安装到插件目录。

### 方式二：本地开发 / 从源码

```bash
git clone https://github.com/huiyaoxingkong/dsh-plugin-minecraft-devtest.git
cd dsh-plugin-minecraft-devtest
npm install          # 安装 mineflayer 等运行时依赖（首次约 1–2 分钟）
npm run check        # 语法检查
npm run test:unit    # 不需要 Minecraft 服务端的离线单测
```

把该目录作为 DSH bundle（`target=D:\path\to\dsh-plugin-minecraft-devtest`）安装即可。

### 方式三：不需要 npm 账号（GitHub Release tarball / git）

npm 账号注册若被人机验证卡住，可直接用 GitHub 分发：

```text
# A. 下载 Release 的 npm tarball（含 SHA256 校验文件）
https://github.com/huiyaoxingkong/dsh-plugin-minecraft-devtest/releases/download/v0.4.0/dsh-plugin-minecraft-devtest-0.4.0.tgz

# 本地安装 tarball（DSH CLI）
dsh plugin --profile desktop add ./dsh-plugin-minecraft-devtest-0.4.0.tgz
# 或在插件管理器里把该 .tgz 作为 target 安装
plugin_manager action=install_bundle target=D:\path\dsh-plugin-minecraft-devtest-0.4.0.tgz
```

```text
# B. 直接从 GitHub git 安装（本包是纯 JS，没有 build 脚本，无需 allowBuilds）
dsh plugin --profile desktop add github:huiyaoxingkong/dsh-plugin-minecraft-devtest
```

> tarball 由 `npm pack` 生成（与将来 npm 上的内容一致）：1.1MB / 解包 14.9MB / 253 文件；
> SHA256 见 Release 附件 `.tgz.sha256`（`0ba70ebeb2a386d8427d787486568d05b8b5f51c6c44d321e5274487beb12d02`）。

### 方式四：npm 包（包名已就绪，待发布）

```bash
npm install dsh-plugin-minecraft-devtest
```

> **发布状态**：npm 账号注册/人机验证尚未完成，包尚未发布；请先用方式一/二/三（本地目录、GitHub 源码、Release tarball）。
> 维护者发布：本机 `npm login` 后执行 `npm publish`（包已通过 `npm pack --dry-run` 校验：`dsh-plugin-minecraft-devtest@0.4.0`，tarball 1.1MB）。
> 如果 npm 注册一直被 CAPTCHA 拦住：可换用手机蜂窝网络/无痕窗口、关闭广告拦截/VPN，或尝试 npm 登录页的 GitHub 登录；实在不行就保持 GitHub tarball/git 分发（功能完全一致，DSH 能从 tarball/git 安装）。

npm 包面向两类用户：DSH 插件（`dsh.bundle.patch` 已包含）和希望在 Node 里直接复用
`lib/` 模块的开发者。运行游戏/服务端相关能力仍需本机安装 Java 与测试服 jar。

### 发布 / 打包

```bash
npm pack --dry-run   # 检查 npm 包内容（含内置 vendor，约 14 MB）
npm publish          # 需要 npm 账号：先 npm login，或设置 NPM_TOKEN
```

## 快速开始

把下面路径换成你自己的测试服目录即可（示例使用 Windows 路径）：

```text
# 原版 1.20.1 数据包 + 测试服：一键体检（校验/部署/reload/日志/机器人）
mcdt_quickcheck(projectDir="D:\\path\\my-datapack", serverDir="D:\\path\\vanilla-1.20.1")

# 最新版原版服（26.3，Java 25 自动选择）
mcdt_quickcheck(projectDir="D:\\path\\my-datapack-26.3", serverDir="D:\\path\\vanilla-26.3")

# 正式版全范围：Java 自动选择（1.7.10→8、1.18.2→17、26.3→25）
mcdt_quickcheck(serverDir="D:\\path\\1.7.10-server")   # 机器人走 legacy 模式（原生 1.7 协议）
mcdt_quickcheck(serverDir="D:\\path\\1.18.2-server")   # 机器人 native 模式
mcdt_quickcheck(serverDir="D:\\path\\26.3-server")     # Java 25；机器人走 emulated 模式

# 加载器服务端（先用官方安装器装好一次，插件自动识别启动形态）
mcdt_quickcheck(serverDir="D:\\path\\fabric-1.21.1")    # fabric-server-launch.jar
mcdt_quickcheck(serverDir="D:\\path\\quilt-1.21.1")     # quilt-server-launch.jar
mcdt_quickcheck(serverDir="D:\\path\\forge-1.12.2")     # 旧版 Forge 可执行 jar
mcdt_quickcheck(serverDir="D:\\path\\neoforge-1.21.1")  # 新版 run.bat（script 模式）

# Forge 1.20.1 模组服：quickcheck 会自动把内置测试桥装进 mods/ 再起服（首次会慢一点）
mcdt_quickcheck(serverDir="D:\\path\\forge-1.20.1")

# 手动流程
mcdt_server(action="start", serverDir="D:\\path\\test-server")
mcdt_datapack(action="deploy", dir="D:\\path\\my-datapack")
mcdt_datapack(action="reload")
mcdt_command(cmd="datapack list")
mcdt_bot(action="join", username="Tester")
mcdt_bot(action="chat", message="hello")
mcdt_bot(action="state")
mcdt_test(card="D:\\path\\mc-tests\\S-001-datapack-smoke.yml", serverDir="D:\\path\\test-server")
mcdt_suite(dir="D:\\path\\mc-tests")
mcdt_server(action="stop")
```

示例见 [`examples/`](./examples/)：一个可部署的数据包 + 三张测试卡；`docs/TESTING.md` 记录了多版本实测证据。

## 测试卡格式

```yaml
id: S-001
title: 数据包冒烟
setup:
  commands:
    - "gamerule doDaylightCycle false"
steps:
  - type: command
    cmd: "setblock 0 64 0 minecraft:stone"
    expect: { contains: "Changed the block" }
  - type: bot
    action: join
    params: { username: Tester }
  - type: bot
    action: chat
    params: { message: "hello" }
  - type: assert
    step: 1
    path: response
    op: contains
    value: hello
  - type: datapack
    action: reload
  - type: wait
    ms: 500
```

- step 类型：`command` / `bot` / `datapack` / `gradle` / `server` / `assert` / `wait` / `note` / `snapshot`；
- 断言 op：`eq` `ne` `contains` `not_contains` `matches` `exists` `gt` `gte` `lt` `lte`；`path` 支持 `a.b[0].c`；
- 默认遇到第一个失败就停；`mcdt_test(verbose=true)` 可拿每步返回值；
- 卡片的 `bot` 步骤同样只能连本插件启动的测试服（不接受 host/port 覆盖）。

## 省 token 的设计

1. **确定性执行器**：`mcdt_test` / `mcdt_suite` / `mcdt_quickcheck` 都在插件内跑完再压缩结果，模型只看 `ok/failedAt/error`；
2. **内置检查**：数据包 JSON 全量校验、pack_format 与服务器版本比对、RCON 冒烟、日志错误扫描、机器人 join/chat 冒烟都不需要模型给步骤；
3. **内置知识**：`mcdt_guide` + README 覆盖格式表与常见报错；
4. **自动生成测试卡**：`mcdt_init` 扫描数据包/模组工程，直接生成可执行卡骨架；
5. **日志筛选**：`mcdt_logs mode=errors` 只回错误与数据包加载问题。

## 目录结构

```
minecraft-devtest/
  index.js                # 工具注册（12 个 mcdt_*）
  lib/server.js           # 无头服务器生命周期（jar/fabric/script/gradle，尊重既有 properties）
  lib/rcon.js             # RCON 客户端
  lib/bot.js              # 机器人统一入口（native / emulated / legacy / emulated-future 模式分派）
  lib/protocol-compat.js  # 26.2/26.3/26.4 协议兼容层（内置上游 PR 包与 minecraft-data 数据补丁，自动安装）
  lib/legacy-bot.js       # 自研原生 1.7 协议机器人（不依赖 Mineflayer）
  lib/bridge.js           # 内置 Forge 测试桥的检测/安装
  lib/datapack.js         # 数据包扫描/校验/部署/版本探测
  lib/cards.js            # YAML 测试卡解析与执行
  lib/quickcheck.js       # 一键体检 + cards api 组装
  lib/gradle.js           # Gradle 任务执行（build / GameTest）
  lib/guide.js            # 内置指南
  lib/util.js             # 公共工具（版本表/日志解析）
  lib/versions.js         # 1.7.10–26.4 版本注册表 / Java 矩阵 / pack_format / 版本比较
  vendor/upstream-26.3/   # 内置上游 26.3 协议 PR 包 + 26.2/26.3 minecraft-data 数据（约 13.7MB）
  vendor/forge-bridge/    # 专用 Forge 1.20.1 测试桥 mod（源码 + 构建脚本 + 预编译 jar）
  scripts/gen-versions.mjs# 从 Mojang manifest 重新生成版本表
  scripts/gen-api-docs.mjs# 从 index.js 生成 docs/API.md（工具清单）
  examples/               # 示例数据包与测试卡
  docs/                   # API / LOADERS / TESTING / CONTRACTS / REQUIREMENTS
```

## 文档

| 文档 | 内容 |
| --- | --- |
| [`docs/API.md`](./docs/API.md) | **自动生成**的 12 个工具清单 + 模块职责（`npm run gen:docs`） |
| [`docs/LOADERS.md`](./docs/LOADERS.md) | Forge/Fabric/NeoForge/Quilt 的版本覆盖与真实启动验证 |
| [`docs/TESTING.md`](./docs/TESTING.md) | 验证报告：自动化测试、多版本矩阵、原版服数据包、崩溃调查 |
| [`docs/REQUIREMENTS.md`](./docs/REQUIREMENTS.md) | 需求拆解与验收标准 |
| [`docs/CONTRACTS.md`](./docs/CONTRACTS.md) | 内部模块契约（库 API 与字段约定） |
| [`CHANGELOG.md`](./CHANGELOG.md) | 版本变更记录（Keep a Changelog） |
| [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md) | 开源组件与 Minecraft/Mojang 声明 |
| [`examples/`](./examples/) | 可部署数据包 + 三张 YAML 测试卡 |

## 测试桥 mod（Forge 1.20.1）

Forge 服务端会因为模组注册的自定义通道拒绝原版客户端（日志：`Disconnecting VANILLA connection attempt: This server has mods that require Forge to be installed on the client`）。我们在 `vendor/forge-bridge/1.20.1/` 内置了一个**自己实现的极小 Mixin mod**（不引用任何第三方 mod）：

- 原理：把 Forge 的 `NetworkRegistry.acceptsVanillaClientConnections()` 固定为 true，让 Forge 接受原版协议连接；
- 安装：`mcdt_bridge(action="install", serverDir="...")`（服务器需停止），或用 `mcdt_quickcheck` 自动安装；
- 限制：机器人仍看不懂模组方块/物品（1.20.1 协议限制），模组内容断言请用 RCON/命令；个别模组会向无 mod 的客户端发包并打日志错误，但不影响机器人基本操作；
- 构建：`vendor/forge-bridge/1.20.1/build.ps1` 可复现（javac 直接对着本机 Forge 服务器 libraries 编译，不需要 Gradle/MDK）。

## 许可与致谢（License & Notices）

- **本插件代码：MIT**（见 [`LICENSE`](./LICENSE)）；内置 Forge 测试桥 mod（`vendor/forge-bridge/`）同为 MIT，由本项目自行实现。
- **内置的上游协议兼容层**：`vendor/upstream-26.3/` 内为**未修改**的 PrismarineJS 官方仓库 PR 分支源码——
  `mineflayer`（MIT）、`prismarine-chunk`（MIT）、`prismarine-physics`（MIT）、`minecraft-protocol`（**BSD-3-Clause**），
  以及 `minecraft-data` 的 26.2/26.3 数据（MIT 打包）。每个包目录保留上游 LICENSE，来源 URL/PR/commit/SHA256 记录在
  [`vendor/upstream-26.3/manifest.json`](./vendor/upstream-26.3/manifest.json) 与 [`vendor/upstream-26.3/README.md`](./vendor/upstream-26.3/README.md)。
- **Minecraft / Mojang 声明**：本项目与 Mojang Studios / Microsoft 无关联。Minecraft 游戏内容、数据与商标归其所有者；
  本工具不附带游戏客户端/服务端二进制，测试服 jar 需你自行合法获取并遵守 Minecraft EULA。
- **其他**：YAML 子集解析器与部分工具模式参考 [minecraft-mod-dev](https://github.com/yan-mc/minecraft-mod-dev)（MIT），见文件头注释；
  Mineflayer / mineflayer-pathfinder 等 npm 依赖在安装时按各自许可证分发（见 [`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)）。
- 完整第三方声明：**[`THIRD_PARTY_NOTICES.md`](./THIRD_PARTY_NOTICES.md)**。
