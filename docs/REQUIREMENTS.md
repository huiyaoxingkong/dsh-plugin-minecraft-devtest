# 需求与设计：minecraft-devtest

日期：2026-11-14
状态：v0.1 实现中/已交付（以最终验证报告为准）
目标用户：在 DSH 里开发 Minecraft 模组、数据包等内容的个人开发者（本机环境：Windows、DSH 0.2.2-rc.1、MC 1.20.1/1.21.1/1.21.11 工程）

## 1. 用户原话与拆解

> 我需要一个辅助开发测试我的世界模组、数据包等内容的插件，要求可以通过类似服务端+whale-craft离线模式的方式免客户端（重点免客户端测试）测试制作内容是否正常运行以及是否达到预期，并将部分内置到插件中已节省token花费

拆解为 5 条硬需求：

| # | 需求 | 对应实现 |
|---|---|---|
| R1 | 辅助开发测试**模组、数据包**等内容 | 数据包全链路（扫描/校验/部署/reload/datapack list/内容断言）；模组工程走 Gradle（build / runGameTestServer / runServer）+ 服务端断言；两者共用同一套测试卡 |
| R2 | **免客户端**：类似「服务端 + whale-craft 离线模式」 | `mcdt_server` 起无头服务器（jar 或 `gradlew runServer`）；`mcdt_bot` 用 Mineflayer 以离线玩家身份进服，代替客户端做玩家级操作与状态断言；全程不需要启动游戏客户端 |
| R3 | 测试内容**是否正常运行**（能起、能加载、无错误） | quickcheck：pack.mcmeta/JSON 校验、pack_format 与服务器版本比对、起服就绪、RCON 冒烟、deploy+reload+datapack list、日志错误扫描、机器人 join/chat 冒烟 |
| R4 | 测试内容**是否达到预期**（行为/数值/掉落/进度等） | 测试卡断言：RCON 命令输出（data get / execute if / scoreboard / loot / advancement）+ 机器人状态（位置/背包/血量/聊天/容器）+ 服务端状态快照；`assert` 支持 eq/contains/gt/… 与路径取值 |
| R5 | **部分内置到插件中，节省 token** | 插件内置确定性执行器与检查清单（quickcheck/suite）、内置指南（mcdt_guide）、日志筛选（mcdt_logs mode=errors）、测试卡自动生成（mcdt_init）；常用检查不经过模型推理，失败才回传细节 |
| R6 | **只能进入搭好的测试服务器**（精简掉「正式服/外部服」能力） | 移除外部 RCON 探测；`mcdt_command`/`mcdt_bot`/`mcdt_datapack deploy/reload/list`/`mcdt_logs` 只作用于本插件 `mcdt_server` 启动的那一个测试服；机器人不接受 host/port；测试卡同样拒绝非本地/非托管目标 |
| R7 | **适配更多版本（含模组加载器版本），重点模组聚集版本** | 服务端启动支持 jar/fabric/script/gradle 并沿用既有 server.properties；loader/version 探测；数据包 format 从服务器 version.json 读取并扩展版本表；Fabric 1.20.1/1.21.1/1.21.11 机器人直接可用；Forge 1.20.1 用**自行开发的专用测试桥 mod**（`vendor/forge-bridge/`，不沿用第三方 mod）放行原版协议机器人 |
| R8 | **正式版全范围 1.7.10 – 26.4（不含快照/pre/rc）** | `lib/versions.js` 内置 76 个正式版（1.7.10–26.3，26.4 前瞻）：Java 需求（8/16/17/21/25）、pack_format、版本比较/文件名推断；服务端按版本自动选 Java、自动推断版本、支持旧 Forge 可执行 jar；1.13 以下明确无数据包能力；机器人按 Mineflayer 协议能力自动判定，不支持时降级为 RCON-only |
| R9 | **参考 Mineflayer 但不局限于 Mineflayer，魔改适配更广版本（v0.4）** | 机器人统一入口按 `botSupport().mode` 分派：`legacy`（自研原生 1.7 协议，1.7.x）、`native`（Mineflayer 1.8.8–26.1）、`emulated`（内置上游 26.3 协议 PR 包 + minecraft-data 数据补丁，26.2/26.3）、`emulated-future`（26.4 best-effort）、`unsupported`（降级 warning）；兼容层全部内置 `vendor/upstream-26.3/`，不依赖第三方 mod；26.3 默认白名单由服务器启动补丁强制关闭 |

## 2. 非目标（v0.1 明确不做）

- 不测客户端渲染/贴图/粒子/音效/GUI 视觉（无客户端做不到；需要时人工或 GameTest 逻辑断言）；
- 不接管真实客户端（那是 minecraft-mod-dev / Minecraft 客户端桥插件的事）；
- 不提供模组 API 索引/脚手架（minecraft-dev 插件负责）；
- 不做多人/代理服务器兼容矩阵（Bungee/Velocity 等暂不考虑）；
- 不做远程 SSH/云服务器（本地进程为主）。

## 3. 关键设计决策

1. **两种开服模式**：`server.jar`（任意版本、数据包/服务端模组均可）与 `gradlew runServer`（开发工程，Fabric/Forge/NeoForge）。启动前自动写 EULA、离线模式、RCON、端口，保留其它配置并备份；日志 tee 到文件，内存环形缓冲供断言。
2. **RCON 而不是 probe mod**：不要求被测试项目安装任何测试专用 mod，纯服务端命令即可覆盖大部分内容（方块状态、NBT、配方、战利品、进度、分数板）。这使插件与 MC 版本、加载器解耦。
3. **Mineflayer 机器人 = 客户端替身**：覆盖「玩家进服之后会发生什么」，并且能读玩家状态（背包/位置/血量）作为断言来源；不实现客户端画面。
4. **卡片文件 = 可复跑的验收标准**：把「是否达到预期」固化到仓库里（`mc-tests/*.yml`），一次编写多次运行；CI 式回归。
5. **工具面尽量少**：10 个 `mcdt_*` 工具，一个 `mcdt_test` 覆盖卡片执行，避免模型逐条调用、上下文爆炸。
6. **失败信息紧凑**：默认只回 `ok/failedAt/error`；`verbose` 才带每步 data。

## 4. 验收标准（v0.3）

- [x] 插件可被 DSH 0.2.2-rc.1 安装并激活，12 个 `mcdt_*` 工具出现在工具目录。
- [x] 安全收紧：`mcdt_bot`/`mcdt_command`/`mcdt_datapack deploy` 在未通过 `mcdt_server` 启动测试服时明确拒绝；`mcdt_bot` 不接受 host/port；移除外部 RCON 探测。
- [x] 多加载器启动：fabric / script（Forge run.bat）/ jar（含目录外 jar、同级 `server-<版本>.jar`）/ gradle；启动前 TCP 端口预检；沿用既有 server.properties 端口/密码。
- [x] 多版本（v0.2）：Fabric 1.20.1/1.21.1/1.21.11 机器人 join；Vanilla 1.20.6 + 数据包 41；1.21.11 数据包 94；pack_format 从服务器 jar 的 version.json 读取。
- [x] 正式版全范围（v0.3）：76 个正式版 1.7.10–26.3（26.4 前瞻）的 Java 需求表；**真实起停验证** 1.7.10/1.12.2/1.13.2（Java 8）、1.14.4/1.16.5（Java 8）、1.18.2/1.19.4（Java 17）、26.3（Java 25），含 Java 不匹配自动换 Java 重试。
- [x] 版本推断与旧 Forge：version.json / jar 文件名 / Forge 库目录 / Fabric cache / 日志 / 目录名；1.7.10/1.12.2 的 `minecraft_server.*.jar` + `forge-*-universal.jar` 选择；paper/spigot 优先。
- [x] 数据包格式全表：真实 jar 实测 1.14.4=4、1.16.5=6、1.18.2=9、1.19.4=12、1.20.1=15、1.20.6=41、1.21.1=48、1.21.11=94、26.3=121；1.13.2 无 version.json 用版本表兜底；1.13 以下明确提示不支持并跳过部署/重载。
- [x] 机器人矩阵：Mineflayer 最低 1.8.8；1.7.10 等不支持版本返回 `BOT_VERSION_UNSUPPORTED`，quickcheck 自动降级为 warning（RCON-only）。
- [x] **机器人兼容层（v0.4）**：`botSupport().mode` 分派 native/legacy/emulated/emulated-future/unsupported；**1.7.10 legacy 真机** join/state/chat/quit + dig/place 通过；**26.3 emulated 真机** join/state/chat 通过；26.2 真机（protocol 776）通过；26.4 别名代理链路通过（真实 26.4 服待发布复验）；26.5+/1.6.x 正确降级。
- [x] **兼容层内置**：`vendor/upstream-26.3/`（4 个 PrismarineJS PR 包 + 26.2/26.3 数据，13.7MB，manifest 记录来源/commit/SHA256），首次加载幂等安装（约 0.4s），不依赖第三方 mod；mineflayer 版本窗口放宽到合成上限。
- [x] **26.3 白名单**：服务器启动补丁强制 `white-list=false`/`enforce-whitelist=false`（26.3 起默认开白名单），真机 start→stop 验证通过。
- [x] Forge 1.20.1：自研专用测试桥 mod（`vendor/forge-bridge/`，非第三方）自动安装后，vanilla 协议机器人 join 模组测试服成功。
- [x] 真实数据包：monster_war 多版本包在 1.20.1/1.20.6/1.21.11 环境中部署/reload/list 通过，并检出 1.20.1 包的真实错误（armadillo 引用）。
- [x] 示例卡片：`mcdt_test` / `mcdt_suite` 全绿；失败卡返回 `failedAt` 与原因。
- [x] 文档：README、CONTRACTS、REQUIREMENTS、TESTING（多版本实测证据）、示例、内置 Forge 桥 README。
- [ ] NeoForge / 其它 Forge 版本的测试桥（后续项）。

## 5. 风险与缓解

| 风险 | 缓解 |
|---|---|
| Mineflayer 版本/协议兼容 | 允许显式传 version；报错给出可读原因；文档写明 Forge 握手限制 |
| 起服慢/端口冲突 | 启动超时 + 错误带日志尾部；端口可配置；stop 兜底杀进程树 |
| 机器人行为不稳定（战斗/寻路） | 测试卡默认用确定性动作（chat/state/place/dig/craft），寻路有超时且返回 arrived:false 不抛错 |
| 数据包格式随版本变化 | pack_format 从服务器 jar 的 version.json 动态读取，内置表只作兜底，未知版本不误报 |
| 测试破坏正式存档 | 文档要求使用专用测试服务器目录；离线模式默认；插件不主动碰用户世界之外的文件 |

## 6. 后续路线（非 v0.1）

- Carpet / fake player 支持（Fabric 服务端玩家模拟）；
- Forge GameTest 一键流程（发现 GameTest 任务 + 解析报告 + 失败截图不可用时给日志定位）；
- 客户端可选项：复用客户端桥插件做画面断言（把「免客户端」改为「可无客户端」）；
- 卡片录制：从一次手动 RCON/机器人操作自动生成卡片骨架。
