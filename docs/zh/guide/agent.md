# 生存智能体

`@bedboo/agent` 是一个基于 bedboo 的脚本化（不使用 LLM）生存智能体。它在基岩版专用服务器上正常地玩生存模式：木头 → 石质工具
→ 铁 → 钻石，按照蓝图建造房屋，开采主世界的每一种矿石，同时还会与攻击它的生物战斗、进食，并从岩浆和水中脱身。一切都通过公开的
mineflayer API 和生态插件（mineflayer-pathfinder、-collectblock、-tool、-armor-manager、-auto-eat、-pvp）完成，因此同样的
代码也能驱动 Java 版机器人。它同时也是 bedboo 实际应用的一个大型示例。

## 快速开始 {#quick-start}

```js
const { Agent } = require('@bedboo/agent')

const agent = await Agent.create({ host: '127.0.0.1', port: 19132, username: 'Agent', log: console.log })
await agent.run('obtain', { item: 'iron_pickaxe' }) // 木头、石头、熔炉、铁……需要什么就做什么
await agent.run('build', { blueprint: 'house5x5' }) // 获取材料，逐个方块验证
await agent.run('mine', { all: [{ item: 'diamond' }, { item: 'emerald' }] })
agent.writeReport('report.json') // 任务、耗时、死亡、战斗、事件日志
await agent.stop()
```

智能体以普通离线玩家的身份加入：没有管理员权限，不使用命令。

## 选项与任务 {#options}

`Agent.create(opts)` 的选项：`host`、`port`、`username`（默认 `Agent`）、`bot`（使用一个已经生成的机器人）、
`botOptions`、`safety`（`true` / 选项对象 / `false`）、`autoEat`、`keepFed`（任务间隙饥饿时去寻找食物）、
`recoverItems`（死亡后回去捡掉落物）、`log`（日志行输出）、`skills`（技能注册表）。

`agent.run(skill, args, { timeout, retries })` 将一个技能作为任务运行；`agent.runScenario({ name, steps, timeout,
verify })` 按顺序运行各个步骤（在第一次失败时停止）并返回报告；`agent.on('event', e)` 以流的形式推送
`{ t, type, … }` 事件（`task-start`、`mine`、`craft`、`smelt`、`place`、`safety`、`death`、`log`……）。

## 技能 {#skills}

技能是一个 `async (bot, args) => result` 函数（`args.signal` 是运行器的 AbortSignal）；技能从不发送命令。

| 技能 | 作用 |
|---|---|
| `obtain` | 不择手段获得 `count` × `item`：合成、冶炼、开采、采集或狩猎，递归进行，按代价规划 |
| `mine` | 矿石和石头：向下挖竖井到达深层矿石，没有加载到合适的生物群系时会朝它探索 |
| `gather` | 地表方块：原木（`item: 'log'` = 任意原木）、沙子、沙砾…… |
| `craft` | `bot.recipesFor` / `bot.craft`，2×2 或工作台（放下后再收回） |
| `smelt` | `bot.openFurnace`；熔炉放下后再收回 |
| `build` | 在机器人附近按蓝图建造，逐个方块验证并修复错误之处 |
| `navigate` | 带重新规划的 pathfinder，远距离目标分段前进，并处理卡住的情况 |
| `explore` | 螺旋行走，直到加载到某个方块或生物群系 |
| `surface`、`descend`、`escape` | 离开矿井、沿安全竖井向下、最后手段的脱困 |
| `food`、`hunt`、`fish` | 保持饱食：狩猎被动生物并烹饪肉类，或钓鱼 |
| `rest` | 用随身携带的床睡过夜晚，或者躲进庇护所 |
| `combat`、`portal`、`nether`、`end` | 战斗、传送门以及其他维度 |

任务运行期间，后台的安全行为会与敌对生物战斗或逃离、从岩浆中脱身、游上水面换气、进食（通过 mineflayer-auto-eat），并在死亡后
恢复。技能、obtain 规划器、安全行为和蓝图格式的完整说明见该包的
[README](https://github.com/LiteLDev/bedboo/tree/main/packages/agent#readme)。
