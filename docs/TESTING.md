# 验证报告：minecraft-devtest v0.4（正式版 1.7.10 – 26.4 + Mineflayer 之外机器人兼容层）

日期：2026-11-14
验证环境：Windows 10/11 · DeepSeek Harness **0.2.2-rc.1** · Node **24.16.0** · 已装 JDK **8 / 11 / 17 / 20 / 21 / 25**（GraalVM 21/25、Zulu 8、HotSpot 11/17/20）
测试服来源：本机 `D:\Minecraft\数据包\_mw_server`（用户已搭好的测试服）+ 官方 piston-meta 下载的 1.7.10–26.3 代表性服务端（`.tmp/ver-servers`、`.tmp/compat-servers`）

## 1. 自动化测试（模块级）

```powershell
cd D:\Minecraft\dsh-mc\minecraft-devtest
# 批 1：不需要 25565 常驻服的模块（server/datapack/util/cards/init/guide/gradle/rcon/bridge/forge-bridge/protocol-compat/legacy-bot）
node --test --test-concurrency=1 test/server.test.mjs test/datapack.test.mjs test/util.test.mjs test/cards.test.mjs test/init.test.mjs test/guide.test.mjs test/gradle.test.mjs test/rcon.test.mjs test/bridge.test.mjs test/forge-bridge.test.mjs test/protocol-compat.test.mjs test/legacy-bot.test.mjs
# 批 2：bot 全文件（含 25565 主套件；需先起 .tmp/server-1.20.1）
node --test --test-concurrency=1 test/bot.test.mjs
```

结果：**tests 181 / pass 173 / fail 0 / skipped 8**（约 6.1 + 2.1 分钟；skipped 均为夹具已清理的真实版本矩阵用例，按设计 skip）。
批 1：151 tests / 149 pass / 0 fail / 2 skipped（364s）；批 2：30 tests / 24 pass / 0 fail / 6 skipped（124s）。

| 测试文件 | 数量 | 覆盖 |
|---|---|---|
| `test/server.test.mjs` | 17 | jar/fabric/script/gradle 启动；沿用既有 properties；外部 jar/同级 jar；旧 Forge 双 jar 优先级；**8 个正式版真实起停矩阵**；Java 8→17 自动重试；script 超时杀进程树；26.3 white-list 强制关闭 |
| `test/bot.test.mjs` | 30 | 原 17 项（玩家动作 + Fabric 1.20.1/1.21.1/1.21.11）+ `botSupport`/模式门禁 + 6 个正式版真实 join 矩阵 + **1.7.10 legacy / 26.3 emulated / 26.4 emulated-future 真实用例** |
| `test/datapack.test.mjs` + `test/util.test.mjs` | 22 + 18 | 76 个正式版 pack_format 逐条断言、真实 jar 的 `version.json` 校验、1.13 以下无数据包能力、1.21.9+ min/max_format、单/复数目录 |
| `test/cards.test.mjs` | 53 | YAML 解析、断言、兼容旧 mcdev 卡、suite、dryRun |
| `test/init.test.mjs` | 3 | 测试卡自动生成 |
| `test/guide.test.mjs` / `test/gradle.test.mjs` | 3 + 3 | 内置指南 / Gradle 摘要解析 |
| `test/rcon.test.mjs` | 10 | RCON 协议、认证、超时、分片 |
| `test/bridge.test.mjs` / `test/forge-bridge.test.mjs` | 4 + 5 | 内置 Forge 测试桥的检测/安装逻辑与 jar 完整性 |
| `test/protocol-compat.test.mjs` | 10 | 上游 26.3 兼容层安装幂等、26.2/26.3 数据与窗口、真实 26.3/26.2 join、26.4 alias |
| `test/legacy-bot.test.mjs` | 3 | 1.7.10 原生协议机器人 join/state/chat/look/dig/place/goto + 不支持动作抛错 |

## 2. 正式版 1.7.10 – 26.4 支持矩阵

### 2.1 版本注册表（`lib/versions.js`）

- 从 Mojang piston-meta 生成 **76 个正式版**（1.7.10 → 26.3，最新 release 26.3 / 2026-09-15）；快照/pre/rc 不纳入。
- 每个版本带 `javaMajor`（来自该版本 version JSON 的 `javaVersion.majorVersion`）与 `packFormat`。
- 26.4 尚未发布：按前瞻版本处理（Java 25、pack_format 运行时从 server jar 的 `version.json` 读取）。
- Java 需求分布：Java 8（1.7.10–1.16.5，42 个版本）、Java 16（1.17/1.17.1）、Java 17（1.18–1.20.4，13 个）、Java 21（1.20.5–1.21.11，14 个）、Java 25（26.1–26.3，5 个）。

**服务端真实起停矩阵**（`node --test test/server.test.mjs`，每项 start→status→RCON list→stop，断言进程退出+端口释放）：

| 版本 | 自动选用 Java | 版本来源 | 结论 |
|---|---|---|---|
| 1.7.10 / 1.12.2 / 1.13.2 | Zulu **8** | 目录名/文件名（复跑 logs） | ✅ |
| 1.14.4 / 1.16.5 | Zulu **8** | jar 内 `version.json` | ✅ |
| 1.18.2 / 1.19.4 | JDK **17** | `version.json` | ✅ |
| 26.3 | GraalVM **25** | `version.json` | ✅ |

另验证：对 1.18.2 显式指定 Java 8 → `UnsupportedClassVersionError` → **自动换 Java 17 重试成功**；`status` 返回 `javaPath/javaMajor/versionSource`（Lead 工具实测：1.7.10 选 Zulu8、1.19.4 选 JDK17、1.20.1 选 JDK17、26.3 选 GraalVM25）。

### 2.2 机器人（Mineflayer）兼容矩阵

规则：minecraft-data 是否有该版本客户端数据 + mineflayer loader 窗口（最老 **1.8.8**，最高 26.1）取交集；不支持时 `join()` 抛 `BOT_VERSION_UNSUPPORTED`，quickcheck 自动降级为 RCON-only warning。

| 版本 | botSupport | 实测 |
|---|---|---|
| 1.7.10 | ❌（< 1.8.8） | 真实服启动 + join 拒绝 → RCON-only 降级 ✅ |
| 1.12.2 / 1.13.2 / 1.14.4 / 1.16.5 / 1.18.2 / 1.19.4 | ✅ | 自动 ping 探测 → join→state→chat→look→leave 全 OK |
| 1.20.1 / 1.21.1 / 1.21.11 | ✅ | 原有 Fabric 套件持续覆盖 |
| 26.2 / 26.3 | ✅ emulated | 插件内置上游 26.3 协议 PR 包（`vendor/upstream-26.3/`）；真实 26.2/26.3 服 join→state→chat→quit 全通过 |
| 26.4 | ✅ emulated-future（best-effort） | 26.3 数据别名 + `presentAs:'26.3'`；26.4 未发布，借用 26.3 服验证整条链路（真实 26.4 服待发布复验） |
| 26.5+ / 1.6.x | ❌ | `BOT_VERSION_UNSUPPORTED` → RCON-only 降级（quickcheck warning） |

> v0.4 起这些由插件内置兼容层处理（见 2.3），不再需要等 Mineflayer/minecraft-data 官方更新。

### 2.3 机器人兼容层实测（v0.4：参考 Mineflayer 但不局限 Mineflayer）

| 测试 | 结果 |
|---|---|
| 1.7.10 原生协议机器人（`lib/legacy-bot.js`，不依赖 Mineflayer） | ✅ 真实 1.7.10 服：join→state→chat→chatHistory→look→dig（RCON `testforblock air`）→place（`testforblock stone`）→goto `arrived:true`→quit；不支持动作抛 `LEGACY_ACTION_UNSUPPORTED` |
| 26.2/26.3 emulated（`lib/protocol-compat.js`） | ✅ 真实 26.2（protocol 776）/26.3（777）服：join→spawn→chat→state(health/food/dimension/entities/chunk)→quit；服务器日志有 join/chat/left |
| 26.4 emulated-future | ✅ 借用 26.3 服以 `syncFutureVersionProtocol('26.4', 777, {presentAs:'26.3'})` 走通全链路（真实 26.4 服未发布，无法更强验证） |
| 26.3 默认白名单 | ✅ 服务器启动补丁强制 `white-list=false`/`enforce-whitelist=false`；26.3 真机 start→stop 验证 |
| 兼容层幂等/性能 | ✅ marker 二次调用 skipped、文件 sha256 不变；marker 丢失后全新安装 **355ms**（vendor 13.7MB/200 文件），不对其它包做删除 |
| 插件工具级 | ✅ `mcdt_quickcheck(1.7.10)` → bot joined + chat（legacy）；`mcdt_quickcheck(26.3)` → bot joined + chat（emulated）+ 白名单关闭；`mcdt_quickcheck(1.20.1)` native 回归全绿 |

### 2.4 数据包格式（真实 server jar 校验）

| 版本 | data pack_format | 校验来源 |
|---|---|---|
| 1.13 / 1.13.1 / 1.13.2 | 4 | 版本表（jar 无 version.json） |
| 1.14.4 | 4 | jar `pack_version=4` |
| 1.16.5 | 6 | jar `pack_version=6` |
| 1.18.2 | **9**（resource=8） | jar `pack_version={resource:8,data:9}` |
| 1.19.3 | **10**（resource=12） | jar `pack_version={resource:12,data:10}`（官方 1.19.3 jar 实测） |
| 1.19.4 | 12（resource=13） | jar 实测 |
| 1.20.1 / 1.20.6 | 15 / 41 | jar 实测（用户服务端） |
| 1.21.1 / 1.21.11 | 48 / 94(minor1) | jar 实测 |
| 26.3 | 121（resource 97.1） | jar `data_major=121` 实测 |

- 1.13–1.14.4=4、1.15–1.16.1=5、1.16.2–1.16.5=6、1.17=7、1.18/1.18.1=8、1.18.2=9、1.19–1.19.3=10、1.19.4=12、1.20/1.20.1=15、1.20.2=18、1.20.3/4=26、1.20.5/6=41、1.21/1.21.1=48、1.21.2/3=57、1.21.4=61、1.21.5=71、1.21.6=80、1.21.7/8=81、1.21.9/10=88、1.21.11=94、26.1–26.1.2=101、26.2=107、26.3=121。
- **1.7.10–1.12.2 没有数据包功能**：`mcdt_datapack(deploy/reload/list)` 会明确报错；quickcheck 自动跳过相关检查并给 warning。
- 首次运行仍会从 server jar 的 `version.json` 动态读取（优先于版本表），未知/快照版本不猜测。

### 2.5 工具级实测（插件工具，非 mock）

| 场景 | 结果 |
|---|---|
| `mcdt_quickcheck(serverDir=1.7.10)` | ✅ 起服（Java 8 自动）、RCON、日志无错、**机器人 join（legacy 模式）+ 聊天**、停服 |
| `mcdt_quickcheck(serverDir=1.18.2)` | ✅ 8/8 全绿，机器人 join + 聊天 |
| `mcdt_quickcheck(serverDir=26.3)` | ✅ 起服（Java 25 自动，白名单强制关闭）、RCON、日志无错、**机器人 join（emulated）+ 聊天**、停服 |
| `mcdt_server(status)` 1.7.10 / 1.19.4 / 1.20.1 / 26.3 | ✅ 返回 `version/versionSource/javaPath/javaMajor`（Zulu8 / JDK17 / JDK17 / GraalVM25） |
| `mcdt_datapack(deploy)` on 1.7.10 | ❌ 明确报错「数据包从 1.13 开始支持」（预期行为） |
| `mcdt_datapack(validate)` on 1.19.4（示例包 format 15） | `expectedFormat=12` + 明确错误（15 不匹配 1.19.4 的 12）——多版本格式识别正确 |

### 2.6 加载器（Mod Loader）启动实测（v0.4，详见 [`LOADERS.md`](./LOADERS.md)）

| 加载器 + MC | 安装方式 | 插件识别 | 结论 |
|---|---|---|---|
| Forge 1.7.10 | 官方 installer `--installServer`（Java 8） | jar / forge / 1.7.10 / version.json(inheritsFrom) / Zulu 8 | ✅ 启动+RCON+优雅停服 |
| Forge 1.12.2 | 官方 installer `--installServer`（Java 8） | jar / forge / 1.12.2 / forge-library / Zulu 8 | ✅ |
| NeoForge 1.21.1 | 官方 installer `--installServer`（Java 21；本机 maven 被墙，用 BMCLAPI 镜像 patch） | **script(run.bat)** / neoforge / 1.21.1 / forge-library / GraalVM 21 | ✅ |
| Fabric 1.21.1 | fabric-installer `server -mcversion 1.21.1` | fabric / fabric / 1.21.1 / version.json / GraalVM 21 | ✅ |
| Quilt 1.21.1 | quilt-installer `install server 1.21.1` | **fabric(quilt launcher)** / quilt / 1.21.1 / version.json / GraalVM 21 | ✅ |

> 旧 Forge universal jar 的 `version.json` 是 launcher profile（`id` 含 `1.7.10-Forge...`），插件现在取 `inheritsFrom`/合法 MC token 并做 `isValidMcVersion` 校验，避免选错 Java；NeoForge 从 `libraries/net/neoforged/neoforge/21.1.266` 反推 MC 1.21.1；script/gradle 模式把选中 JDK 注入 `PATH`/`JAVA_HOME` 后再跑 `run.bat`/gradlew。

### 2.7 原版服务器（数据包）兼容性验证（2026-11-18，DSH 0.2.2-rc.5）

原版服务端是数据包测试的主场景；插件不装 mod/插件，只用 server jar + RCON +（可选）机器人：

| 组合 | 验证内容 | 结果 |
|---|---|---|
| **Vanilla 26.3**（Java 25，pack_format 121，`min_format`/`max_format`） | `mcdt_quickcheck`：scan/validate/deploy/reload/`datapack list`/日志/机器人 join/chat | ✅ 全绿 |
| Vanilla 26.3 行为断言 | RCON `scoreboard objectives add` + `function dshprobe:load` + `scoreboard players get #loaded dsh_probe` | ✅ `#loaded has 1`；日志出现 `[dsh] vanilla 26.3 datapack load function ran`（登录载入 + 手动 reload） |
| Vanilla 26.3 玩家级 | `mcdt_bot` join/state/chat/leave（emulated）+ RCON `list` | ✅ `There are 1 of a max of 5 players online: VanillaBot` |
| Vanilla 1.20.1（format 15） | 示例数据包 + `mcdt_suite`（3 张卡） | ✅ 3/3 |
| Vanilla 1.20.6（format 41） | monster_war 真实数据包 deploy/reload/list + 机器人 | ✅ |
| Vanilla 1.7.10（无数据包） | `mcdt_datapack deploy` | ✅ 预期拒绝：`Minecraft 1.7.10 没有数据包功能…`；validate 仅结构校验、不误报 |

**1.21.9+ pack.mcmeta 新规则（本次实测发现）**：`pack_format > 81` 的包若缺 `min_format`/`max_format`，26.x/1.21.9+ 服务端会抛
`JsonParseException: Pack declares support for version newer than 81, but is missing mandatory fields min_format and max_format` 并拒绝该包。
插件已处理：validate 对「format>81 且无 min/max」给 warning；quickcheck 日志扫描新增这两个错误模式（坏包判失败而不是静默通过）；`mcdt_guide datapack` 记录规则与正确写法（数字或 `[major,minor]`）。

> 结论：**原版服务器（数据包）完全兼容**——1.13+ 全链路（校验/部署/重载/列表/行为断言/机器人）可用，1.7.10–1.12.2 明确无数据包能力；版本差异（pack_format、单/复数目录、min/max_format）由插件自动检测/提示。

## 3. 「只进入搭好的测试服务器」安全验证

未启动托管服务器时：

| 调用 | 结果 |
|---|---|
| `mcdt_bot(action="join")` | ❌ `mcdt_bot joins only the test server started by mcdt_server in this session...` |
| `mcdt_command(cmd="list")` | ❌ `mcdt_command only talks to the test server started by mcdt_server in this session...` |
| `mcdt_datapack(action="deploy")` | ❌ `deploy/reload/list only work on the test server started by mcdt_server...` |
| `mcdt_test` 卡片里伪造 host 的 bot 步骤 | ❌ `cards may only join the local test server (host must be 127.0.0.1/localhost)` |

配置层面：无外部 RCON 探测；`mcdt_bot` 不接受 host/port；`mcdt_logs` 不读任意路径；deploy/reload/list 只作用于托管服；启动强制 `online-mode=false` 并接管 RCON（其它 properties 键保留、首次备份 `.dsh-backup`）。

## 4. 端到端实测（模组聚集版本 + 数据包）

### 4.1 Fabric 1.21.11 + 数据包（format 94）✅

用户测试服 `_mw_server\fp-1.21.11`（Fabric + fabric-api + carpet + monster-war，GraalVM JDK21）：`mcdt_server` 启动 → 端口沿用 25588/RCON 25589、`version=1.21.11/loader=fabric`；`mcdt_quickcheck(projectDir=zz_verify)` 12/12 通过：format 94 校验/部署/reload/list、日志无错、机器人 join + 聊天（messages=5）。

### 4.2 Forge 1.20.1 模组服 + 专用测试桥 ✅

Forge 1.20.1 服务完整副本（tacz / monster-war-forge / kubejs / geckolib / gunsmithlib / aaa_particles / lrh / architectury / cloth-config / rhino）：quickcheck 自动检测 Forge 1.20.1 → **自动安装内置测试桥** → `run.bat` 启动（端口 25630/RCON 25631）→ 机器人以 vanilla 协议 join + 聊天 → 优雅停服；旧拒绝消息 0 次，证明「专用 Mod 放行后无客户端可进真实模组 Forge 服」。

### 4.3 Vanilla 1.20.6 + 多版本数据包（format 41）✅

`_mw_server\1.20.6`（jar 在目录外，自动发现同级 `server-1.20.6.jar`）：端口 25591、`enable-rcon=false` 自动补 true；`mcdt_quickcheck(monster_war_1.20.5-1.20.6)` 13/13 通过（format 41 校验/部署/reload/list + 机器人 join/chat）。

### 4.4 Fabric 1.20.1 + 真实 monster_war 数据包（检出真实问题）⚠️

`.tmp/mvtest\fabric-1.20.1`（monster-war + fabric-api + carpet 副本）：全流程可跑（179 个函数、format 15、部署/reload/list、机器人 join/chat）；**检出数据包真实错误**：1.20.1 包引用了 1.20.5+ 实体 `minecraft:armadillo`（`Couldn't load tag monster_war:friendly_targets ... minecraft:armadillo`），quickcheck 正确判失败。

### 4.5 1.20.1 托管服 + 示例数据包/测试卡 ✅

`mcdt_suite(examples/cards)` → 3/3 卡通过；`mcdt_datapack(validate, examples/datapacks/hello_mcdevtest)` → 自动读到 `expectedFormat=15` 并校验通过。

## 5. 专用 Forge 测试桥 mod（自行开发，内置）

- 源码/构建/预编译 jar：`vendor/forge-bridge/1.20.1/`（**不引用任何第三方 mod**）；Mixin 在 `NetworkRegistry.acceptsVanillaClientConnections()` HEAD 强制返回 true，绕过 Forge 对原版客户端的 login 拒绝。
- 构建：`build.ps1`（javac 17 直接对着本机 Forge 服务器 `libraries` 编译，无需 Gradle/MDK）。
- 真实证据：`docs/evidence/forge-bridge-join.log`（BridgeBot logged in / joined / 双向聊天 / 旧拒绝消息 0 次）。
- 限制：仅 Forge **1.20.1**（47.x）；只放行 login gate——模组方块/物品/实体对原版协议客户端不可见/不可用，模组内容断言请走 RCON。

## 6. 验证期间的一次宿主进程重启调查（2026-11-14 19:28）

首次验证 26.3 `mcdt_quickcheck` 时，工具调用在「机器人已 join + 聊天」后**没有返回任何结果**，会话恢复后显示该调用被中断（宿主进程在 19:28 左右退出，DSH 于 21:27 重启；机器未重启）。

调查结论：

- **没有** Windows 应用崩溃事件（Application Error/WER 1000/1026 在该时段为空）、无 `hs_err_pid`/崩溃转储；Windows Event Log 无重启记录；Java 26.3 服务端与当时手工启动的 25565 服务端日志都在 19:28:15 附近**直接截断**（无 stop/shutdown 行）——符合「宿主进程退出时其子进程被一起终止」。
- 会话记录：19:28:00 记录 `tool/call mcdt_quickcheck(26.3)`，随后该 turn 以 `interrupted` 结束，21:28 才有新事件——宿主进程在 bot 阶段（19:28:14 join / 19:28:15 chat）退出，**不是插件抛错或测试失败**（若插件抛错会正常落 tool/result）。
- **未复现**：会话恢复后（同一台机器、同一插件代码）重新执行同一条 `mcdt_quickcheck(26.3)` → **全绿**（31.8s，bot join+chat）；另用独立 Node 进程复跑 26.3 emulated join→state→chat→leave→stop → 全绿（33s）；协议编译内存实测仅 +32–47MB（26.1/26.3），不是显存/堆爆炸。
- 当时机器同时运行了 **两个 Minecraft 服务端**（手工启动的 25565 + quickcheck 启动的 26.3，各约 1.3GB），而本机 16GB 内存在 19:11 时已只剩约 2.8GB 空闲；宿主进程退出最可能是**系统内存压力/宿主自身原因**，而非 26.3 兼容层逻辑错误（隔离复现 + 工具复跑都通过）。
- 使用建议：插件一次只管理一个测试服；在这台 16GB 机器上做多版本验证时，**不要同时手工再起第二个 MC 服**，并留意系统可用内存。

## 7. 省 token 效果

| 场景 | 传统做法 | 本插件 | 输出 |
|---|---|---|---|
| 数据包全链路体检 | 模型逐步发 RCON/机器人调用 | 1 次 `mcdt_quickcheck` | JSON ≈ 1.5–2 KB |
| 3 张测试卡回归 | 20+ 次调用 | 1 次 `mcdt_suite` | JSON ≈ 0.25 KB |
| 失败定位 | 多轮对比 | `failedAt + error(actual)` | ≈ 0.3–0.5 KB |
| 日志排查 | 几千行日志进上下文 | `mcdt_logs mode=errors` | 通常 < 1 KB |
| 版本/Java 适配 | 查 wiki/试错 | `lib/versions.js` + 自动 Java + `mcdt_guide versions` | 0 次外部查询 |

## 8. 已知限制

1. 无客户端 = 无渲染/贴图/GUI 视觉断言；仅能 GameTest 逻辑断言或人工。
2. 原版协议机器人不能识别模组方块/物品（1.20.1 协议不发送注册表）；模组内容断言请用 RCON。
3. 内置测试桥仅 Forge 1.20.1；NeoForge/其它 Forge 版本暂不支持机器人，请用 GameTest/RCON。
4. 机器人：1.7.x 走 legacy（基础动作，无背包/合成/容器）；26.2/26.3 走内置上游兼容层（依赖 vendor 的 PR 包，上游数据更新后需重新生成 vendor）；26.4 未发布仅 best-effort；26.5+/1.6.x 不支持（降级 RCON-only）。
5. 插件同一时间管理**一个**托管测试服务器；多版本测试请逐个 start/stop。16GB 内存机器上不要同时手工再起第二个 MC 服（见第 6 节调查）。
6. `goto` 纯走路不搭桥；`eat` 正常进食路径未做稳定集成用例。
7. script/gradle 模式现在会把按版本选出的 JDK 注入子进程 `PATH`/`JAVA_HOME`（run.bat 里的 `java` 会用对版本），status 在版本已知时也报告 `javaPath/javaMajor`；Java 版本自动重试仍只对 jar/fabric 模式生效。
8. 旧 Forge/Paper 的真实起停只做了选择/推断单测与部分版本验证；代理服（Bungee/Velocity）不在保证范围。
9. 兼容层通过运行时覆盖 `node_modules` 的 4 个协议包实现（原包备份到 `.dsh-upstream-bak-*`）；重新安装插件依赖后会自动重新安装兼容层。

## 9. 复现

```text
# 1.7.10（自动选 Zulu 8；机器人走 legacy 模式，可 join/chat）
mcdt_quickcheck(serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\compat-servers\\1.7.10")

# 1.18.2（自动选 JDK 17，机器人 native 可 join）
mcdt_quickcheck(serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\ver-servers\\1.18.2")

# 26.3（自动选 GraalVM 25；机器人走 emulated 模式，可 join/chat）
mcdt_quickcheck(serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\compat-servers\\26.3")

# 数据包格式校验（1.19.4 服务器 → expectedFormat=12）
mcdt_server(action="start", serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\ver-servers\\1.19.4")
mcdt_datapack(action="validate", dir="D:\\Minecraft\\dsh-mc\\minecraft-devtest\\examples\\datapacks\\hello_mcdevtest")
mcdt_server(action="stop")

# 测试（批 1 不需 25565；批 2 bot 需要先起 .tmp/server-1.20.1）
node --test --test-concurrency=1 test/server.test.mjs test/datapack.test.mjs test/util.test.mjs test/cards.test.mjs test/init.test.mjs test/guide.test.mjs test/gradle.test.mjs test/rcon.test.mjs test/bridge.test.mjs test/forge-bridge.test.mjs test/protocol-compat.test.mjs test/legacy-bot.test.mjs
node --test --test-concurrency=1 test/bot.test.mjs
```
