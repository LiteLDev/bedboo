# 生态插件

为 mineflayer 编写的插件可以通过 `bot.loadPlugin()` 原样加载。常用插件已在 bedboo 工作区中固定版本，它们少数几处基于
Java 版的假设（Java 的 `entity_status` 数据包、Java 的附魔 NBT……）由 `patches/mineflayer-*.patch` 中的小型 pnpm 补丁修复。
只使用 mineflayer 公开 API 的插件不需要任何处理。

`pnpm-workspace.yaml` 中的 `overrides` 固定了打过补丁的版本，因此每个包（包括插件之间的相互依赖）加载的都是同一份打过补丁的副本。
在工作区之外请应用相同的补丁（`pnpm patch` / `patch-package`）：不打补丁时，auto-eat 会一直等待一个永远不会到来的 Java
`entity_status`，pathfinder 会挖穿门，还会因为重新居中而与服务器来回拉扯。每个补丁改了什么、为什么改：
[生态插件补丁](../reference/differences/plugins.md)。

| 插件 | 版本 | 在 BDS 1.26.51.1 上验证过的内容 |
|---|---|---|
| mineflayer-pathfinder | 2.4.5 | 山丘、湖泊、120 格的 GoalXZ、GoalY、梯子、跑酷、垫高、搭桥、挖穿墙壁、门和栅栏门、GoalFollow、搭方块 |
| mineflayer-collectblock | 1.6.0 | 从树上采集原木、煤矿和铁矿、背包满时存入箱子 |
| mineflayer-tool | 1.2.0 | 最佳工具、附魔、空手兜底 / `NoItem` |
| mineflayer-armor-manager | 2.0.1 | 拾取时自动穿戴、升级装备、`equipAll()` |
| mineflayer-auto-eat | 5.0.3（ESM） | `eat()`、`enableAuto()` |
| mineflayer-pvp | 1.3.2 | 僵尸、持盾僵尸、持盾时对抗苦力怕、骷髅 |

## 加载 {#loading}

```js
const bedboo = require('bedboo')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = bedboo.createBot({ host, port, username })
bot.loadPlugin(pathfinder)
bot.loadPlugin(require('mineflayer-pvp').plugin) // 需要先加载 pathfinder
bot.loadPlugin(require('mineflayer-collectblock').plugin) // 会在下一 tick 自行加载 pathfinder 和 tool
bot.loadPlugin(require('mineflayer-armor-manager'))
const { loader: autoEat } = await import('mineflayer-auto-eat') // 仅支持 ESM
bot.loadPlugin(autoEat)
```

移植到基岩版的 mineflayer 示例位于库的 `examples/` 目录中（插件示例：`pathfinder/gps.js`、`collectblock.js`、
`guard.js`、`auto-eat.js`）。

## mineflayer-pathfinder {#pathfinder}

基岩版上推荐的 `Movements` 设置：

```js
const moves = new Movements(bot)
moves.canOpenDoors = true // 木门（所有木材、铜门）和栅栏门会被打开而不是挖掉（已打补丁）
moves.allowSprinting = true // 默认值
moves.allowParkour = true // 默认值：1–3 格的间隙（已验证 2 格间隙）
moves.allow1by1towers = true // 默认值：用搭建用方块垫高（泥土、圆石；可在
// moves.scafoldingBlocks 中添加更多 ID，例如 bot.registry.itemsByName.netherrack.id）
moves.canDig = true // 默认值；挖掘代价按基岩版挖掘速度计算（状态效果、附魔）
bot.pathfinder.setMovements(moves)
bot.pathfinder.thinkTimeout = 20000 // 推荐值（上游为 5000 ms）：见下文
```

- `thinkTimeout`：主世界区块的高度范围是 y -64..319，在自然地形上搜索会访问大量节点；在负载较高的主机上，几格之外的简单目标
  也可能超过默认的 5 秒，此时 `goto` 会以 `Timeout: Took to long to decide path to goal!` 拒绝。搜索很快时，调大它没有任何代价。
- 放置失败永远不会让路径卡住（已打补丁；上游 2.4.5 在以下每种情况下都会卡住）：
  - 搭建方块的 `bot.equip` 被拒绝时，会释放 pathfinder 的装备锁；
  - 被拒绝的放置会重试一次，之后在针对当前目标的后续搜索中避开该格（`bot.pathfinder.refusedPlacements`，
    `maxPlaceRetries` = 1）：路径会绕道，或者目标无路可达；连续 `maxPlaceFailures`（6）次放置失败后，`goto` 以 `NoPath`
    拒绝（"… placements failed in a row"）。用同一个目标对象重试会保留被拒绝的格子；新目标则重新开始；
  - 放置或点击门耗时超过 `bot.pathfinder.placeTimeout`（10 秒）视为失败；
  - 放置尚未完成时调用 `stop()`，会在下一 tick 结束（其迟到的结果会被忽略）；
  - 失败后机器人会从探身出去的边缘退回，而从边缘开始的搜索会以机器人脚下的方块为起点。

  `path_reset` 的原因：`equip_error`、`place_error`、`use_error`、`place_timeout`、`stop`。
- 名称使用基岩版名称；流动的水 / 岩浆、含水的植物和含水方块都视为液体。
- 执行器的 `fullStop()` 不再在客户端重新居中机器人（BDS 会把它纠正回去）；机器人停下时，最多偶尔出现约 0.24 格的服务端纠正。
- 未处理（与上游相同）：活板门、铁门（`canDig` 时会被挖掉）、藤蔓（不可攀爬）、基岩版的脚手架方块、真正意义上的游泳
  （机器人通过跳跃漂浮来渡水）。
- 空闲时调用 `bot.pathfinder.stop()` 不做任何事，目标不可达时 `goto()` 以 `NoPath` 拒绝（从上游 master 回移）。
  `GoalFollow` 在机器人被击退时会重新规划。
- 门：BDS 只打开门的下半部分；bedboo 让上半部分采用打开后门扇的形状，因此机器人能从它打开的门原路走回
  （[门的上下两半](../reference/differences/world.md#door-halves)）。
- 在基岩版上，只要按住 `forward`，疾跑就会持续：pathfinder 松开疾跑控制并不会让机器人减速，直到它停下为止
  （[粘滞疾跑](../reference/differences/movement.md#sticky-sprint)）。
- 经验球、投掷出的药水、三叉戟、烟花火箭和其他弹射物均可穿过。

## mineflayer-pvp {#pvp}

- 盾牌：在基岩版上 `activateItem(true)` 通过潜行举起盾牌，因此持盾时机器人在两次攻击之间以潜行速度移动；pathfinder 的
  `clearControlStates()` 不会放下盾牌（只有 `deactivateItem()` 会）；正在点燃的苦力怕（基岩版的 `ignited` 标志）会让 pvp
  举起盾牌（已打补丁）。
- 远程生物（骷髅、流浪者、掠夺者）会后退：请设置 `bot.pvp.followRange = 1`，否则机器人可能停在 4 格之外，超出 3.5 格的攻击距离
  （这也是上游在 Java 版上的行为）。
- 基岩版没有攻击冷却；pvp 按 Java 版冷却计时，只是攻击得比实际可能的略慢一些。

## mineflayer-auto-eat {#auto-eat}

ESM：`const { loader } = await import('mineflayer-auto-eat')`。通过 `bot.autoEat.setOpts({ minHunger,
priority, bannedFood })`、`enableAuto()` / `disableAuto()` 配置，`bot.autoEat` 上有 `eatStart` / `eatFinish` / `eatFail`
事件。进食在基岩版的 `completed_using_item` 时完成（已打补丁）。和平难度下饥饿值永远不会下降。修复了上游的两个 bug：装备失败
不再让插件永远处于“进食中”状态；在 `strictErrors`（默认）下，`eat()` 拒绝之前也会发出 `eatFail`。

## mineflayer-collectblock、-tool、-armor-manager {#collectblock}

- collectblock：在背包中有工具和搭建用方块的情况下调用 `collect(blocks)`；背包满时会使用 `chestLocations`（箱子方块的
  Vec3）。回调形式 `collect(target, cb)` 可用（已打补丁）；`cancelTask()` 会在当前步骤完成后结束任务（已打补丁）。
- tool：没有任何物品能采集该方块时，`equipForBlock(block, { requireHarvest })` 以 `NoItem` 拒绝；使用 `getFromChest`
  但没有箱子时同样如此（已打补丁：上游会无限递归直至内存耗尽）。
- armor-manager：拾取的盔甲、盾牌和不死图腾会逐件穿戴（已打补丁）；`equipAll()`。
