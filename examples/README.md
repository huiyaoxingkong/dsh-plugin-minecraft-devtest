# 示例

## `datapacks/hello_mcdevtest`

一个最小但完整的 MC **1.20.1** 数据包（pack_format 15），包含：

- `load` 函数（由 `#minecraft:load` 标签在 /reload 时自动执行）→ 设置记分板 `#loaded mcdevtest = 1`
- `hello` / `ping` 函数
- 一个进度（advancement）、一个配方（recipe）、一个战利品表（loot_table）

用 `mcdt_quickcheck(projectDir="examples/datapacks/hello_mcdevtest", serverDir="...")` 可一键体检；
用 `mcdt_datapack(action=scan/validate, dir="...")` 可只做静态校验。

## `cards/`

三张可直接跑的测试卡：

| 卡 | 检查内容 | 需要 |
|---|---|---|
| `S-001-datapack-smoke.yml` | 部署 → /reload → datapack list → load 函数记分板 → 战利品表 → 清点物品 | 运行中的 1.20.1 服务器 + serverDir 参数 |
| `S-002-bot-player.yml` | 机器人进服 → 聊天 → 状态（位置/血量/聊天）→ 离开 | 运行中的服务器（离线模式） |
| `S-003-server-commands.yml` | 纯 RCON：gamerule / time 命令与响应断言 | 运行中的服务器 |

运行方式（示例路径按本机修改）：

```text
mcdt_test(card="D:\\Minecraft\\dsh-mc\\minecraft-devtest\\examples\\cards\\S-001-datapack-smoke.yml",
          serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\server-1.20.1")
mcdt_suite(dir="D:\\Minecraft\\dsh-mc\\minecraft-devtest\\examples\\cards",
           serverDir="D:\\Minecraft\\dsh-mc\\.tmp\\server-1.20.1")
```

卡片里的 `dir: "../datapacks/hello_mcdevtest"` 是相对于**卡片文件**的路径，由卡片执行器解析；
这样示例可以整个目录搬走，不写死机器路径。
