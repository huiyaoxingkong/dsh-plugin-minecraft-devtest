# minecraft-devtest 模块契约（v0.1）

本文件是并行开发的唯一接口约定。各模块作者只写自己拥有的文件，不修改他人的文件；
`index.js`、`package.json`、`cordis.patch.yml`、`docs/`、`examples/`、`lib/util.js`、`lib/gradle.js`、`lib/quickcheck.js`、`lib/guide.js` 由 Lead 维护。

- 插件根目录：`D:\Minecraft\dsh-mc\minecraft-devtest`
- 运行环境：Node 24（ESM，`"type": "module"`），Windows，Java 17 在 PATH
- 代码风格：纯 ESM，`node:` 内置模块用 `node:` 前缀；不引入除 `mineflayer` / `mineflayer-pathfinder` 之外的运行时依赖
- 错误约定：模块内部失败时 `throw new Error('<可读原因>')`；工具层会 catch 并返回 `{ ok:false, error }`。不要在返回对象里塞 Error 实例。
- 返回值：所有 `async` 接口返回「可 JSON 序列化的普通对象」，字段用 camelCase。
- 日志：模块本身不要 `console.log` 刷屏；可接受传入的 `log(line)` 回调，默认丢弃。
- 测试：每个模块在 `test/<模块>.test.mjs` 写零依赖测试（`node --test test/xxx.test.mjs`），测试用临时目录，不污染仓库。
- 只写自己拥有的文件；发现契约需要变更，先在自己的实现里兼容，然后在完成汇报里说明。

## 共享工具 `lib/util.js`（Lead 提供，只读引用）

```js
export function nowIso()                                  // ISO 时间
export function sleep(ms)                                 // await sleep
export function ensureDir(dir)                            // 递归创建，返回 dir
export function readTextFile(path)                        // 读 UTF-8，抛错
export function writeTextFile(path, text)                 // 写 UTF-8，自动建父目录
export function readJsonFile(path)                        // 读+解析 JSON，失败抛错（错误信息带路径）
export function listFilesRecursive(dir, { filter } = {})  // 返回绝对路径数组；filter(path) => boolean
export function tailLines(text, n)                        // 文本按行切，取最后 n 行
export function tailFileLines(path, n)                    // 同上，从文件读；文件不存在返回 []
export function normalizeCmd(cmd)                         // 去掉前导 '/'，trim
export function shortError(err)                           // Error -> 单行字符串
export function isWindows
export function findJava()                                // 返回 java 可执行路径（JAVA_HOME/PATH 探测）
export function killProcessTree(pid)                      // 尽力杀整棵进程树，返回 { killed:boolean }
export function spawnCollect(cmd, args, { cwd, timeoutMs, env } = {})
                                                          // Promise<{ code:number|null, output:string, timedOut:boolean }>
export function parseMinecraftLog(text)                   // -> { version?, loader?, errors:[string], warnings:[string] }
export function parsePackFormatMap()                      // -> {'1.20.1':15,'1.21.1':48,...}（版本→data pack_format，未知版本缺省）
```

## `lib/rcon.js`（owner: server-dev）

```js
export class RconClient {
  constructor({ host = '127.0.0.1', port = 25575, password = 'dshmcdevtest', timeoutMs = 10000 })
  async connect()                     // 认证成功返回 this；失败 throw
  async command(cmd)                  // 发送命令（允许带 '/'），返回响应文本 string（可能为空串）；未连接 throw
  close()                             // 幂等
  get connected()                     // boolean
}
export async function rconCommand(opts, cmd)  // 一次性 connect/command/close，返回 string
```

实现要点：Minecraft RCON 协议（长度前缀 4B LE + requestId + type + payload + 2 个 NUL）。
type 3 认证、type 2 执行命令；校验 requestId；超时抛错。响应可能分多个包，累计到
「短时间无新数据」或收到含 requestId 的完整包为止（v1 实现单包 + 100ms 空闲判定即可）。

## `lib/server.js`（owner: server-dev）

```js
export class ServerManager {
  constructor()
  async start(options)   // -> runInfo，启动失败 throw（错误信息含日志尾部）
  async stop()           // -> { mode, pid, stopped:boolean, alreadyStopped?:boolean }
  status()               // -> { active:boolean, ready:boolean, pid?, mode?, dir?, port?, rconPort?, logPath?, startedAt?, version?, loader? }
  logTail(n = 100)       // -> string[] 最近 n 行（内存环形缓冲，上限 5000 行）
  async command(cmd)     // -> { command, response, ms }（RCON；未启动 throw）
  get active()           // runInfo | null
  get logPath()          // string | null
}
export const serverManager = new ServerManager()
```

`options`（`start`）：

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| mode | `'auto'\|'jar'\|'gradle'` | `'auto'` | auto：有 serverDir+jar 走 jar，否则 projectDir 走 gradle |
| serverDir | string | — | 含 `server.jar`（或 options.jar）的服务器目录 |
| projectDir | string | — | 含 `gradlew.bat` 的 Gradle 项目目录 |
| runDir | string | 自动探测 | gradle 模式下 server.properties 所在运行目录 |
| task | string | `'runServer'` | gradle 任务名 |
| jar | string | 自动探测 `server.jar` / 唯一 `*.jar` | jar 模式服务器 jar |
| port | number | 25565 | server-port |
| rconPort | number | 25575 | rcon.port |
| rconPassword | string | `'dshmcdevtest'` | rcon.password |
| javaPath | string | 自动探测 | java 可执行文件 |
| memoryMb | number | 1320 | `-Xmx` |
| timeoutMs | number | 180000 | 等待 `Done (...)!` 的超时 |
| levelName | string | `'world'` | level-name（写 properties） |
| args | string[] | [] | 额外 JVM/程序参数（gradle 模式追加到 task 后） |
| patchProperties | boolean | true | 启动前改 server.properties（保留其它键，先备份 `.dsh-backup`） |

`start` 行为：
1. 选择模式、解析目录、`eula.txt` 写 `eula=true`；
2. `patchProperties`：`online-mode=false`、`enable-rcon=true`、`rcon.port`、`rcon.password`、`server-port`、`level-name`；保留用户其它配置；首次备份 `server.properties.dsh-backup`；
3. spawn（jar：`java -Xmx..M -jar <jar> nogui`；gradle：Windows 用 `cmd.exe /d /s /c "gradlew.bat <task>"`，cwd=projectDir，runDir 用于 properties/eula）；
4. stdout/stderr 逐行写入 `<dir>/logs/dsh-devtest-<yyyyMMdd-HHmmss>.log` 并维护内存环形缓冲；
5. 等待日志出现 `Done (` 或 `Done in`（超时 kill 进程树后抛错，错误含最后 30 行）；
6. 解析 `Starting minecraft server version X` 与 loader（Forge/Fabric/Paper）；
7. RCON connect 重试（最多 ~20s）；
8. 返回 `runInfo`：`{ pid, mode, dir, port, rconPort, logPath, startedAt, ready:true, version, loader }`。

`stop`：先 RCON `stop` 等待进程退出（最多 15s），否则/超时 `killProcessTree`；幂等。
注意：Windows 下 gradle 包装进程与子 java 都要杀掉（taskkill /T /F）。

## `lib/bot.js`（owner: bot-dev）

```js
export class BotManager {
  constructor()
  async join({ host='127.0.0.1', port=25565, username='DSH_Bot', version, auth='offline', timeoutMs=30000 })
      // -> { connected:true, username, version, position:{x,y,z}, health, food, dimension, gameMode }
      // 失败 throw（错误信息清楚：connect timeout / kicked reason / unsupported version）
  async leave()                       // -> { connected:false, left:boolean }
  state()                             // -> 见下（未连接返回 { connected:false }）
  async action(name, params = {})     // -> 可 JSON 序列化对象；未知 action / 未连接 throw
}
export const botManager = new BotManager()
```

`state()`（连接时）：
```js
{
  connected: true,
  username, version,
  position: { x, y, z, yaw, pitch },        // 保留 2 位小数
  health, food, saturation, gameMode,        // gameMode 数字或字符串均可
  dimension,
  heldItem: string|null,
  inventory: [{ slot, name, count }],        // 槽位 0..44（9-35 主背包、36-44 快捷栏）
  players: [string],                         // 附近玩家名
  chat: [{ username, message, at }],         // 最近 30 条，at 为毫秒时间戳
}
```

`action` 名称与参数（全部返回普通对象，`message`/失败原因要可读）：

| action | params | 返回要点 |
|---|---|---|
| `chat` | `{ message }` | `{ sent:true, message }` |
| `goto` | `{ x,y,z }` 或 `{ player }` 或 `{ x,z }` | `{ arrived:boolean, position }`；用 mineflayer-pathfinder，超时 ≤60s，未到达返回 `arrived:false`（不要 throw） |
| `look` | `{ x,y,z }` 或 `{ yaw,pitch }` | `{ yaw,pitch }` |
| `dig` | `{ x,y,z }` | `{ dug:boolean, block }`；不可挖/太远时 throw 说明原因 |
| `place` | `{ x,y,z, item? }` | `{ placed:boolean }`；先装备 item（无则用当前手持），找相邻可附着面放置 |
| `use_block` | `{ x,y,z, face='up' }` | `{ used:boolean }`（右键方块，开箱子/按钮等） |
| `use_item` | `{}` | `{ used:boolean }`（右键空气） |
| `inventory` | `{ action='list' }` | `{ slots }`；`action:'drop'` 配 `{ name?, slot?, count? }` |
| `equip` | `{ name }` | `{ heldItem }` |
| `craft` | `{ name, count=1, tableX?,tableY?,tableZ? }` | `{ crafted:boolean, item, count }`；无配方/材料不足 throw 说明缺什么 |
| `open_container` | `{ x,y,z }` | `{ opened:true, windowTitle, slots:[{index,name,count}] }` |
| `container_move` | `{ from, to, count=1 }` | `{ moved:true }`（对当前窗口 shift-click/逐格移动，防复制丢失） |
| `close_container` | `{}` | `{ closed }` |
| `attack` | `{ player? }` 或 `{}`（最近生物） | `{ attacked:boolean, target }` |
| `eat` | `{ item? }` | `{ ate:boolean, item }` |
| `drop` | `{ name?, slot?, count=1 }` | `{ dropped:number }` |
| `wait` | `{ ms }` | `{ waited:ms, tick }` |
| `chat_history` | `{ limit=20 }` | `{ messages }` |

实现要点：
- `import mineflayer from 'mineflayer'`（CJS 默认互操作）；`import { pathfinder, goals } from 'mineflayer-pathfinder'` 后 `bot.loadPlugin(pathfinder)`。
- 每个 action 前断言已连接；join 成功以 `spawn` 事件为准；监听 `kicked`/`error`/`end` 给出可读错误。
- chat 环形缓冲来自 `bot.on('message', json => ...)`，用 `json.toString()` 取纯文本。
- 离线模式 `auth:'offline'`；`version` 不传时让 mineflayer 自动探测（ping），失败时错误里提示可显式传版本。
- 单人玩家名默认 `DSH_Bot`；重复 join 前先 leave。

## `lib/cards.js`（owner: cards-dev）

```js
export function parseYaml(text)                    // 极简 YAML 子集（参考 minecraft-mod-dev 的 parseYaml，支持对象/数组/引用/行内 {}/[]、多行块）
export function parseCardFile(path)                // 读文件+parseYaml，返回原始对象；语法错误 throw（带行号）
export function normalizeCard(raw)                 // -> { id, title, description, setup:{commands:[]}, steps:[], warnings:[] }
export function cardToSteps(card)                  // -> { steps:[], warnings:[] }（兼容层：把 setup/actions/assert 翻译成 steps）
export async function runSteps(steps, api, { stopOnFail=true, dryRun=false, log } = {})
                                                   // -> { ok, failedAt, steps:[{ index, type, ok, ms, data?, error? }], warnings }
export async function runCardFile(path, api, opts)
                                                   // -> { ok, id, title, failedAt, steps, warnings }
export async function runSuite(dir, api, { stopOnFail=false, dryRun=false, filter } = {})
                                                   // -> { ok, total, passed, failed, cards:[{ id, file, ok, failedAt, error?, ms }], warnings }
```

`api` 由 `lib/quickcheck.js`/`index.js` 组装（cards 模块不直接 import server/bot）：
```js
{
  command(cmd) -> Promise<{ response, ms }>,
  bot(action, params) -> Promise<object>,
  botState() -> object,
  datapack(action, params) -> Promise<object>,
  gradle(task, opts) -> Promise<{ exitCode, output, summary }>,
  serverStatus() -> object,
  sleep(ms) -> Promise<void>,
  log(line) -> void,
}
```

卡片格式（v1，`examples/cards` 有样例）：
```yaml
id: S-001
title: 数据包冒烟
setup:
  commands: [ "gamerule doDaylightCycle false" ]
steps:
  - type: command            # RCON 命令
    cmd: "setblock 0 64 0 minecraft:stone"
    expect: { contains: "Block placed" }   # 可选内联断言
  - type: bot
    action: join
    params: { username: Tester }
  - type: bot
    action: chat
    params: { message: hello }
  - type: assert
    step: 1                  # 断言第 1 步（从 0 计）的 data；省略=最近一个产生 data 的步骤
    path: response           # data 内的点路径，支持 a.b[0].c
    op: contains             # eq|ne|contains|not_contains|matches|exists|gt|gte|lt|lte
    value: "hello"
  - type: wait
    ms: 500
  - type: datapack
    action: reload
  - type: note
    text: 人工检查点
```
其它 step 类型：`command`、`bot`、`datapack`、`gradle`（`{task}`）、`server`（`{action:'status'}`）、
`assert`、`wait`、`note`、`snapshot`（把当前 serverStatus+botState 收进 data，供断言）。
兼容：`setup.commands` 逐条当作 command step；`actions` 中不认识的动作（如 mcdev probe 的
`give`/`use_item_on`/`craft` 旧格式）警告并跳过，不阻断其他步骤。`assert` 列表在 `actions/steps`
之后追加（旧卡片格式兼容），其中不认识的断言类型同样警告跳过。
断言路径解析：`path` 相对「该 steps 的 data」；`data` 缺失时断言失败并说明。

## `lib/datapack.js`（owner: datapack-dev）

```js
export function findPacks(rootDir, { maxDepth = 4 } = {})
    // -> [{ dir, name, packFormat }]（含 pack.mcmeta 或 data/ 的候选目录）
export function scanPack(packDir)
    // -> { ok, dir, name, packFormat, description,
    //      namespaces: [{ ns, functions[], recipes[], lootTables[], advancements[], tags[], predicates[], itemModifiers[], structures[], dimensions[] }],
    //      counts: { functions, recipes, lootTables, advancements, tags, jsonFiles },
    //      errors: [{ file, message }], warnings: [] }
export function validatePack(packDir, { expectedFormat, strictJson = true } = {})
    // -> { ok, errors:[{file,message}], warnings:[], packFormat, expectedFormat, counts }
export function readServerPackVersion(serverDirOrJarOrProjectDir)
    // -> Promise<{ version?, dataFormat?, resourceFormat? }|null>
    // 从 server.jar 内 version.json 读取（用 java 的 jar 工具解包到临时目录；找不到返回 null）
export function deployPack(serverDir, packDir, { levelName = 'world' } = {})
    // -> Promise<{ deployed:true, target:absolutePath, packDir }>
    // 复制到 <serverDir>/<levelName>/datapacks/<name>（已存在先删旧副本）
export function listDeployed(serverDir, { levelName = 'world' } = {})
    // -> [{ name, path }]
```

校验规则（v1，宁可漏报不要误报）：
- 缺 `pack.mcmeta` → error；JSON 非法 → error（带文件名）；`pack.pack_format` 缺失或类型不对 → error；
- `data/` 不存在 → warning（资源包式结构）；
- 已知目录（`function`/`functions`、`recipe`/`recipes`、`loot_table`/`loot_tables`、
  `advancement`/`advancements`、`tags`、`predicate`/`predicates`、`item_modifier`）下的 `.json`
  逐个 JSON.parse，失败 → error；能解析但顶层不是对象 → warning；
- `expectedFormat` 提供且与 `pack_format` 不一致 → error（信息里写清两边数值与版本）；
- 版本→data format 对照表：1.20.1=15、1.21.1=48；其余未知版本不比对，交给运行期 `/datapack list` 与日志。
- 支持 `pack.mcmeta` 的 `pack_format` 为对象（`{ "resource":.., "data":.. }`，1.21.9+ 形态）时取 `data` 字段。

## `lib/quickcheck.js`（owner: Lead）

对外只暴露：
```js
export async function quickcheck(options)   // 见 index.js 工具 mcdt_quickcheck
export async function runSuiteForDir(dir, opts)
export function buildApi()                  // 组装 cards api（Lead 实现，cards-dev 不依赖）
```

## `lib/versions.js`（owner: Lead，datapack-dev 校验 packFormat）

正式版版本注册表与 Java 选择（v0.3 新增，被 server/bot/datapack/util/quickcheck/index 引用）：

```js
export const LATEST_KNOWN_RELEASE          // '26.3'
export const SUPPORTED_RANGE               // { from: '1.7.10', to: '26.4', note }
export const RELEASES                      // [{ id, javaMajor, packFormat }]（新→旧，76 个正式版）
export function isKnownRelease(id)
export function getRelease(id)
export function compareVersions(a, b)      // 1.7.10 < 1.8 < 1.20.1 < 26.3
export function javaMajorForVersion(id)    // 8/16/17/21/25；26.4 前瞻=25；未知=null
export function requiredJavaMajor(id)
export function dataPackSupported(id)      // >= 1.13
export function packFormatForVersion(id)   // data pack_format；未知/1.13 以下=null
export function listReleases({ from, to })
export function inferVersionFromFileName(fileName) // server-1.20.1.jar / minecraft_server.1.7.10.jar / forge-1.12.2-... 等
export function scanInstalledJavas(extraRoots = []) // 扫描 JAVA_HOME + 常见 JDK 根目录，读 release 文件得 major
export function pickJavaForVersion(version, { explicitPath, extraRoots } = {}) // { path, major, required, reason }
export function versionSupportSummary(id)  // { version, knownRelease, future, javaMajor, packFormat, dataPack }
```

- 数据来源：Mojang piston-meta（release only），生成脚本 `scripts/gen-versions.mjs`（`--check` 只校验不写）。
- `packFormat` 是 **data pack format**（不是 resource）；已用真实 server jar 的 `version.json` 校验关键值（1.18.2=9、1.19.3=10、1.19.4=12、26.3=121 等）。
- 运行时优先使用 server jar 的 `version.json`；versions.js 只做兜底与 Java/能力判断。

## `lib/protocol-compat.js`（owner: compat-dev，v0.4 新增）

机器人协议兼容层：在 `require('mineflayer')` **之前** 幂等安装内置的上游 26.3 PR 包与 minecraft-data 数据补丁，并放宽 Mineflayer 版本窗口。

```js
export const mineflayer            // 已安装兼容层后的 mineflayer 实例
export const minecraftData
export const minecraftProtocol
export const EMULATED_VERSIONS     // ['26.2','26.3']
export const FUTURE_VERSIONS       // ['26.4']
export const SYNTHETIC_UPPER_BOUND // '999.0'（放宽 loader 上限的合成版本）
export function installUpstreamCompat({ force = false } = {})
export function upstreamCompatStatus() // { installed, emulated, future, packages, ... }
export function syncFutureVersionProtocol(version, protocol, { presentAs } = {})
```

- 安装物：`vendor/upstream-26.3/`（nmp / mineflayer / prismarine-chunk / prismarine-physics 的 PR 分支源码 + 26.2/26.3 minecraft-data 数据 + features + manifest）。
- 幂等：marker `node_modules/.dsh-upstream-compat.json`；原包备份到 `node_modules/.dsh-upstream-bak-<pkg>`。
- 26.4 未发布：`syncFutureVersionProtocol('26.4', protocol, { presentAs:'26.3' })` best-effort；失败由 bot 层转 `BOT_VERSION_UNSUPPORTED`。

## `lib/legacy-bot.js`（owner: legacy-dev，v0.4 新增）

自研原生 1.7 协议机器人（Mineflayer 最低 1.8.8，因此 1.7.x 走这里）。

```js
export class LegacyBot {
  constructor({ host, port, username, version = '1.7.10', auth = 'offline', timeoutMs = 30000 })
  async join()            // 等 login+position -> { username, version, position, connected }
  async quit()            // 幂等
  state()                 // { username, version, connected, position, health, food, gameMode, dimension, entities, messages }
  async action(name, params = {}) // chat/look/goto/dig/place/use_block/use_item/attack/wait/stop
  chatHistory(limit = 30)
  on(event, listener) / removeAllListeners(event)
  get connected / version / username / client
}
export const LEGACY_ACTION_UNSUPPORTED // 不支持动作的错误前缀
```

- `goto` 为等高度直线小步移动（无碰撞/重力模拟）；`dig/place` 需服务器端有对应方块/物品，创世模式最稳定。
- 协议注意（实现已处理）：1.7 下行 position 的 y=feet+1.62；上行 position 字段线上顺序 `x, feetY, stanceY, z`；收到下行 position 必须回显，否则 place 被忽略。

## `lib/gradle.js`（owner: Lead）

```js
export async function runGradle(projectDir, task, { timeoutMs = 900000, args = [], env = {} } = {})
  // -> { task, exitCode, output, summary, timedOut }
export function summarizeGameTest(output)   // -> string（如 "All 12 required tests passed"）
```

## 进度与回报

- 每完成一个模块：用自己的 `node --test test/<模块>.test.mjs` 跑通，然后向 Lead 发一条消息：
  1) 改了哪些文件；2) 导出的函数/行为与契约是否一致（差异要说明）；3) 测试命令与结果；4) 未完成/风险。
- 不要安装/卸载 DSH 插件，不要改 profile、`index.js`、`package.json`、`docs/`、`examples/`。
- Lead 负责最终 `index.js` 接线、真实服务器 E2E、插件安装与交付。
