const GUIDE = {
  overview: `# minecraft-devtest 是什么

免游戏客户端的 Minecraft 开发测试台：从你**已经搭好的测试服目录**启动无头服务器
（server.jar / fabric-server-launch.jar / Forge 的 run.bat / gradlew runServer），
用 RCON 发命令、用 Mineflayer 机器人扮演玩家，再用「测试卡片」把检查写成文件由插件本地执行，
只把压缩后的 pass/fail 结果交回模型——这是省 token 的关键。

安全边界：**本插件只操作它自己用 mcdt_server 启动的那一个测试服务器**。
mcdt_command / mcdt_bot / 测试卡都不接受任意 host/port，也不会去连接已经在跑的外部服务器。
不要把它指向正式服/朋友服（启动时会强制 offline-mode 并接管 RCON）。

工作流（推荐）：
1. mcdt_quickcheck(serverDir=...) 先跑一键体检，拿到 ok/失败项；Forge 1.20.1 会自动安装内置测试桥 mod。
2. 失败项再拆成 mcdt_test 的卡片，定位问题。
3. 修改后只重跑 mcdt_suite(dir=./mc-tests)，看一张汇总表。

能力边界（重要）：
- 无客户端 = 没有渲染/贴图/粒子/音效/GUI 画面断言；这些只能靠 GameTest 逻辑断言或人工看。
- 机器人走原版协议：vanilla / Paper / Fabric 服务端直接可进；Forge 1.20.1 需要内置测试桥
  （mcdt_bridge install，或用 quickcheck 自动安装）才能作为原版客户端加入；
  NeoForge/其它 Forge 版本暂无桥，请用 mcdt_gradle task=runGameTestServer 或 RCON 断言。
- 破坏性测试请用专用测试服务器目录，别指向正式存档。`,

  cards: `# 测试卡（mcdt_test / mcdt_suite）

文件是 YAML，放在任意目录（推荐 ./mc-tests/），由插件执行：

\`\`\`yaml
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
  - type: wait
    ms: 500
  - type: datapack
    action: reload
  - type: note
    text: 人工检查点
\`\`\`

step 类型：command（RCON）、bot（action+params）、datapack（scan/validate/deploy/reload/list）、
gradle（{task}）、server（{action:status}）、assert、wait、note、snapshot。
assert 的 op：eq/ne/contains/not_contains/matches/exists/gt/gte/lt/lte；path 支持 a.b[0].c；
step 省略时断言最近一个产生 data 的步骤。
setup.commands 会先执行；旧 mcdev 卡片里 probe 专用的动作（give/use_item_on/block_entity_nbt）
会变成 warnings 跳过，不影响其它步骤。

省 token 提示：卡片里一次写 10 条断言，比让模型逐条发命令便宜得多；mcdt_suite 一次跑整个目录。`,

  datapack: `# 数据包测试要点

- 原版服务器（vanilla）从 1.13 起支持数据包；1.7.10–1.12.2 没有数据包功能（deploy/reload 会明确报错）。
- pack_format：1.20.1=15、1.20.6=41、1.21.1=48、1.21.11=94、26.3=121 …；插件会从服务器 jar 的
  version.json 读取后比对（mcdt_datapack validate / quickcheck 自动做），未知版本不猜。
- **1.21.9+（含 26.x）注意**：pack_format > 81 的包必须同时声明 min_format / max_format
  （数字或 [major,minor]），否则服务端会报
  "Pack declares support for version newer than 81, but is missing mandatory fields min_format and max_format"
  并拒绝该包；插件 validate 会对这种写法给 warning。
- 数据包目录形态：1.21+ 用单数（function/recipe/loot_table/advancement/tags），1.13–1.20.6 用复数
  （functions/recipes/...）；插件两种都识别，但服务端只认对应版本的那一种。
- 部署：mcdt_datapack(action=deploy, packDir=...) 会复制到当前托管测试服的 world/datapacks/<包名>，
  随后 mcdt_datapack(action=reload) 让服务器 /reload；用 datapack list 确认 file/<包名> 已启用。
- 常见错误字符串（reload 后看 mcdt_logs mode=errors）：
  - "Failed to load function" / "Couldn't parse element" → mcfunction/JSON 语法错误
  - "Unknown recipe category" / "Failed to parse recipe" → recipe JSON 结构或版本不符
  - "Missing pack format" / "pack.mcmeta" → 缺 pack.mcmeta 或 format 不对
  - "Pack declares support for version newer than 81" → 1.21.9+ 缺 min_format/max_format
  - "Registry entry not registered" → 引用了不存在的注册名
  - "Couldn't load tag ... missing following references" → 引用了该版本不存在的注册项
- 行为断言推荐：/data get storage、/scoreboard players get（配合 load/ping function 里 set）、
  /loot ... give 后查背包、/advancement ... 输出、/execute if block 后接 /say 标记；原版服不需要
  任何 mod/插件，RCON + 机器人即可完成。
- 内容自检（不跑游戏）：mcdt_datapack(action=scan, packDir=...) 统计各命名空间并逐个 JSON 解析。`,

  bot: `# 机器人用法（Mineflayer + 自研兼容层）

- 加入：mcdt_bot(action=join, username=DSH_Bot)。只能加入本插件用 mcdt_server 启动的那个测试服
  （端口/版本自动取自它；不接受 host/port）。
- 常用动作：chat / goto {x,y,z} / look / dig / place / use_block / use_item / equip /
  craft / open_container / container_move / attack / eat / drop / wait / inventory / state。
- 版本支持（运行时由 botSupport 判断，join 返回/state 里带 mode）：
  - native：Mineflayer 官方窗口 1.8.8–26.1（动作最全）
  - legacy：1.7.x（内置原生 1.7 协议机器人，不依赖 Mineflayer）——支持 chat/look/goto/dig/place/
    use_block/use_item/attack/wait/stop；inventory/equip/craft/容器/eat/drop 不可用
  - emulated：26.2 / 26.3（插件内置上游协议 PR 包 + minecraft-data 数据补丁，首次加载自动安装）
  - emulated-future：26.4（未发布，best-effort；协议变化时 join 会降级并报 BOT_VERSION_UNSUPPORTED）
  - unsupported：其它版本（如 26.5+、1.6.x）→ join 抛含 BOT_VERSION_UNSUPPORTED 的可读错误，
    quickcheck 自动降级为 RCON-only warning
- 断言玩法：state 返回位置/血量/背包/聊天/entities；卡片里 assert path=position.y op=gte value=64。
- Forge 1.20.1：先 mcdt_bridge(action="install", serverDir=...)（服务器停止时），再 mcdt_server start，
  机器人就能作为原版客户端加入；Forge/NeoForge 其他版本暂无桥。
- 机器人不能：操作游戏 GUI、看贴图、测客户端渲染；看不懂模组方块/物品注册名（1.20.1 协议限制），
  模组内容断言请用 RCON（/data get、/execute if、KubeJS 命令等）。
- 机器人是「另一个玩家」：会给服务器真实玩家事件（join/chat/advancement/进度），适合测
  「玩家进服后会发生什么」；不适合测「当前这个玩家客户端里看起来怎样」。`,

  server: `# 服务器控制

- 从已搭好的测试服目录启动，自动识别：fabric-server-launch.jar（Fabric）、quilt-server-launch.jar（Quilt）、
  run.bat/run.sh（Forge 1.17+/NeoForge 安装器）、server.jar / minecraft_server.<版本>.jar / paper-*.jar /
  旧版可执行 Forge jar（1.7.10–1.16.5 的 forge-*-universal.jar）、gradlew（开发工程）。
- 加载器服务端需要先用官方安装器装一次（Fabric/Quilt installer、Forge/NeoForge --installServer）；
  插件不自动安装加载器。加载器版本覆盖见 mcdt_guide versions / docs/LOADERS.md：
  Forge 1.7.10–26.3（20 个跳版）、Fabric 1.14–26.3、NeoForge 1.20.2–26.3、Quilt 1.14.4–26.3（元数据）。
  LiteLoader/Rift/ModLoader 是客户端加载器，无服务端启动形态。
- 机器人进不去 Forge/NeoForge 服（FML 握手；仅 Forge 1.20.1 有内置测试桥），这类加载器用 RCON/GameTest 断言。
- jar 可以在 serverDir 之外：例如 _mw_server/1.20.1 目录本身没有 jar，插件会自动找同级 server-1.20.1.jar。
- **Java 自动选择**：按 MC 版本选已装 JDK（1.7.10–1.16.5→8、1.17→16/17、1.18–1.20.4→17、1.20.5–1.21.11→21、26.x→25）；
  Java 不匹配会自动换 Java 重试一次；可在 mcdt_server / mcdt_quickcheck 传 javaPath 手动指定。
- **版本探测**：server jar 的 version.json、jar 文件名、Forge/NeoForge libraries、Fabric cache、logs/latest.log、目录名；
  status 返回 version/loader/versionSource/javaPath/javaMajor。
- **沿用既有 server.properties**：server-port / rcon.port / rcon.password / level-name / enable-rcon 从文件读取；
  只有显式传参才覆盖；online-mode 强制 false；white-list/enforce-whitelist 强制 false；enable-rcon=false 会补成 true；
  其它键保留，首次备份 .dsh-backup。
- 就绪判定：日志出现 "Done (...)"; 随后自动 RCON 连接。失败时错误信息带最后 30 行日志。
- mcdt_server(action=stop) 先 RCON stop，再兜底杀进程树；测试结束记得停服。
- Forge/NeoForge 服务器：RCON 断言可用；Forge 1.20.1 装内置测试桥后机器人也可用。`,

  errors: `# 常见问题排查

- "bot not connected" → 先 mcdt_bot(action=join)，或服务器没起来。
- "mcdt_command/mcdt_bot only talks to the test server started by mcdt_server" → 本插件只操作自己启动的
  测试服；先 mcdt_server action=start serverDir=...，不要指望连外部已运行的服。
- "unsupported version" → 显式在 mcdt_server 里给出正确版本，或让机器人 ping 自动探测；代理服可能不兼容。
  机器人版本矩阵见 mcdt_guide topic=versions / bot：1.7.x=legacy、1.8.8–26.1=native、26.2/26.3=emulated、
  26.4=emulated-future、其它=unsupported（quickcheck 会降级 RCON-only）。
- "Invalid move player packet received" / 1.7 机器人位置异常 → 1.7.x 用内置 LegacyBot（会自动回显 position），
  不要用 Mineflayer；26.x 出现该错误通常是 26.2/26.3 兼容层未加载（检查 vendor 安装或插件版本）。
- 26.3 服务器机器人被踢 "not whitelisted" → 插件启动补丁已强制 white-list=false/enforce-whitelist=false；
  若仍出现，检查是否用了外部脚本启动而非 mcdt_server。
- Forge 服机器人被踢 "This server has mods that require Forge to be installed on the client" →
  用 mcdt_bridge(action="install", serverDir=...) 安装内置测试桥（服务器停止时），再起服；
  只支持 Forge 1.20.1，NeoForge/其它版本请用 RCON/GameTest。
- "server start timeout" → 看 mcdt_logs；常见：EULA、端口占用、Java 版本不符、模组崩溃。
- RCON 认证失败 → 插件会沿用 server.properties 的 rcon.password；如果你显式传了不同密码会被覆盖，
  两端不一致时改回文件里的值并重启。
- 端口冲突 → 本插件启动前会预检端口；同一时间只启动一个测试服。多版本测试请逐个 start/stop。
- 数据包不生效 → 确认 /datapack list 里有 "file/<name>"；Fabric/Forge 的全局数据包目录
  与 world/datapacks 不同时需手动指定。`,

  versions: `# 版本支持（正式版 1.7.10 – 26.4）

- 覆盖 76 个正式版 1.7.10–26.3；26.4 未发布，按前瞻处理（Java 25，pack_format 运行时从 jar 读取）。
  快照/pre/rc 不在支持矩阵内。
- Java 需求（按 Mojang version JSON）：1.7.10–1.16.5=Java 8；1.17=Java 16（本机无 16 时用 17）；
  1.18–1.20.4=Java 17；1.20.5–1.21.11=Java 21；26.x=Java 25。插件自动选已装 JDK，不匹配会换 Java 重试一次。
- 数据包：1.13 起支持；1.7.10–1.12.2 没有数据包，mcdt_datapack deploy/reload 会明确报错。
  实测/内置 pack_format：1.13–1.14.4=4、1.15–1.16.1=5、1.16.2–1.16.5=6、1.17=7、1.18/1.18.1=8、
  1.18.2=9、1.19–1.19.3=10、1.19.4=12、1.20/1.20.1=15、1.20.2=18、1.20.3/4=26、1.20.5/6=41、
  1.21/1.21.1=48、1.21.2/3=57、1.21.4=61、1.21.5=71、1.21.6=80、1.21.7/8=81、1.21.9/10=88、1.21.11=94、
  26.1–26.1.2=101、26.2=107、26.3=121。
- 数据包目录形态：1.21+ 单数（function/recipe/loot_table/advancement/tags），1.13–1.20.6 复数（functions/recipes/...），
  插件两种都识别；1.21.9+ 的 min_format/max_format 区间也支持。
- 机器人：**1.7.10–26.4 全覆盖（尽力而为）**。1.7.x 走内置原生 1.7 协议机器人（LegacyBot）；
  1.8.8–26.1 走 Mineflayer 官方；26.2/26.3 走插件内置的上游协议 PR 包（vendor/upstream-26.3，
  首次加载自动安装到 node_modules）；26.4 未发布，emulated-future best-effort。26.5+/1.6.x 不支持。
  Forge/NeoForge 机器人另见 Forge 1.20.1 测试桥。
- 代理服（BungeeCord/Velocity 等）可能改协议，不在保证范围。`,
};

export function guide(topic = 'overview') {
  const key = String(topic ?? 'overview').trim().toLowerCase();
  return GUIDE[key] ?? GUIDE.overview;
}

export function guideTopics() {
  return Object.keys(GUIDE);
}
