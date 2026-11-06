# 生态插件补丁

mineflayer 生态插件在 bedboo 上无需修改即可运行，只有 `patches/` 中的少量 `pnpm patch`（`patches/mineflayer-*.patch`）
例外。本页说明每个补丁改了什么、为什么改，并记录这些插件在 Bedrock 上与 Java 表现不同之处（以及有用的变通做法）。推荐用法见
[插件](../../guide/plugins.md)。观测环境为 BDS 1.26.51.1（协议 2193）。

## mineflayer-pathfinder 2.4.5 补丁  {#pathfinder}

- **影响：** `Movements`、`bot.pathfinder.bestHarvestTool`、`goto`、`stop`、路径执行器（`monitorMovement`、`fullStop`、
  `postProcessPath`）；以及基于它构建的一切（mineflayer-collectblock、mineflayer-pvp、mineflayer-tool 的箱子取工具）
- **Java：** 方块名集合使用 Java 名称；门会被挖穿（只有栅栏门能打开，上游默认关闭 `canOpenDoors`）；`fullStop()` 通过移动
  `bot.entity.position` 让 bot 重新居中（“服务器察觉不到差别”）；挖掘成本来自 prismarine-block 的 `block.digTime`，使用
  工具简化后的 NBT。
- **Bedrock：** 方块名称不同（`flowing_water` / `flowing_lava` 是独立的方块，`web`、`wooden_door`、`fence_gate`、
  `standing_sign`、`lit_furnace`……——`lib/interactable.json` 只认识 Java 名称）；服务器权威的移动会纠正客户端对位置的任何
  改动（重新居中会使每次搭桥产生 3–4 次 0.16–0.64 格的纠正，见 [搭路](digging.md#scaffolding)）；Bedrock 物品把附魔保存在
  `ench` 中（数字 id），且 BDS 使用 Bedrock 的急迫 / 挖掘疲劳系数（[挖掘速度](digging.md#dig-speed)）。
- **bedboo（补丁，新文件 `lib/bedrock.js` + 若干修改）：**
  - 名称：`flowing_water` / `flowing_lava` 加入 `liquids` 和 `replaceables`，`flowing_lava` 加入 `blocksToAvoid`；
    充满水的方块（`seagrass`、`kelp`、`bubble_column`……）和含水方块算作液体，后处理的路径会在其中居中（反向移植上游
    master #384）；`interactable.json` 加入 156 个可交互方块的 Bedrock 名称（与 `lib/bedrock/placement.js` 同一集合），
    因此 pathfinder 对着它们放置前也会潜行（[潜行放置](digging.md#sneak-placing)）；
  - 门和栅栏门：`openable` 除栅栏门外还包含可徒手打开的门（`wooden_door`、`spruce_door`……、铜门；铁门除外）；启用
    `canOpenDoors` 时，关着的门会变成一次 `useOne` 点击（门的上半部分不会被挖掉），开着的门 / 栅栏门（`open_bit`，Java
    中为 `open`）可以通过，且不会再被点击；门口节点取地面中心，`useOne` 节点不再中止路径后处理（反向移植 master #372）；
    点击后执行器继续行走（上游会让 `placing` 保持置位，随后读取 undefined 的 `placingBlock.y`，或因缺少搭路方块而重置路径）。
    BDS 只打开门的下半部分（上半部分的 `open_bit` 保持为 0）：上半部分由 bedboo 的 `blockAt()` 赋予打开门板的形状
    （[门的两半](world.md#door-halves)），因此 bot 能穿过自己打开的门走回来，而不是找不到路径或把门挖掉；
  - `fullStop()` 保留上游清零水平速度的做法，但当 bot 有 `bot._bedrock.physics`（服务器权威移动）时跳过重新居中的瞬移。
    实测：pathfinder 搭桥 0 次纠正（原为 3–4 次）；偶尔在 BDS 不接受清零速度时最多出现一次约 0.24 格的纠正（只松开按键
    会让 bot 漂出目标方块）；
  - 挖掘成本（`bestHarvestTool`、`safeOrBreak`）：使用 `item.enchants`（Java 的 `Enchantments` 和 Bedrock 的 `ench`
    都适用；简化后的 NBT 中是 `id`，prismarine-block 从未匹配上），以及存在时使用 `bot._bedrock.digging.blockDigTime`
    （Bedrock 效果系数；否则使用 prismarine-block 的 `digTime`）；
  - 反向移植 master #375：空闲时调用 `stop()` 不再被锁存（以前它会停掉下一个目标），`goto` 在搜索失败且结果为空时以
    `NoPath` reject，而不是 resolve。mineflayer-collectblock 的 `cancelTask()` 依赖这个锁存（它在挖掘期间 pathfinder 空闲时
    调用 `stop()`）：它的补丁现在自己处理取消（[mineflayer-collectblock](#collectblock)）；
  - `lib/passableEntities.json` 也列出了可穿过实体的 Bedrock 名称（`xp_orb`、`xp_bottle`、`splash_potion`、
    `lingering_potion`、`fireworks_rocket`、`thrown_trident`、`fishing_hook`、`evocation_fang`、`wind_charge_projectile`、
    `breeze_wind_charge_projectile`、`ender_crystal`、`eye_of_ender_signal`、`ominous_item_spawner`、
    `wither_skull_dangerous`）：只有 Java 名称时，经验球和弹射物被当成障碍物（产生实体成本，经验球所在处不会垫高或搭路）；
  - `detectDiggingStopped` 只移除它自己的监听器（`removeAllListeners(event, fn)` 会忽略 `fn`，把 bot 上所有其他
    `diggingCompleted` / `diggingAborted` 监听器都删掉）；
  - 当 bot 被推离其已完成路径的计算起点超过一格时，动态目标（`GoalFollow`）会重新规划（骷髅的箭把一个 mineflayer-pvp bot
    永久推出了攻击范围：目标本身移动的距离还不足以让 `hasChanged()` 成立）；
  - 放置失败不再让路径卡死（上游 2.4.5 和 master d773d15 都会卡死——master 中未合并的 PR #365 只是移动了无效判断；任何
    服务器都一样，包括 Java）：
    - 上游：搭路方块的 `bot.equip` 被拒绝后，`lockEquipItem` 永远不会释放，执行器在每个 tick 都在无效判断之前提前返回，
      再也恢复不了；被拒绝的放置会把路径重置到同一个放置上，无限循环；`stop()` 等待一个永远不会到来的节点或重置；
    - 现在装备锁从装备开始一直持有到放置结束，并在任何结果下都会释放；
    - 失败的装备 / 放置 / 开门点击（`equip_error`、`place_error`、`use_error`），或耗时超过 `placeTimeout`（10 s，
      `place_timeout`）的操作，会计入对应格子：失败次数超过 `maxPlaceRetries`（1）的格子会加入
      `bot.pathfinder.refusedPlacements`，在当前目标下 `Movements#getNeighbors` 不会再在这些格子上规划放置（再次设置同一个
      目标对象——即调用方的重试——会保留它们；设置其他目标或 `stop()` 会清空）；
    - 连续 `maxPlaceFailures`（6）次失败则放弃目标（`path_update` 'noPath'，`goto` 以 `NoPath` "… placements failed in a
      row" reject；除非是动态目标，否则该目标会被丢弃，之后的重置也不会让它复活）；
    - 放置过程中的 `stop()` 在下一个 tick 结束；被 stop / 重置 / 新目标放弃的放置即使迟迟结束也不会改变任何东西（也不会
      释放更新的放置所持有的锁）；放置后走回 `returnPos` 的过程与走向节点一样有时限；
    - 失败后 bot 会退回到它探出身子时所站的方块上；当 bot 向下取整后的位置位于空隙上方时，搜索从 bot 所站的方块开始（上游从
      空隙上方的格子开始，并计划对着其下方的空气放置——在桥边停下后，下一次 `goto` 会在这上面耗费 2 × 10 s）。

## 长距离搜索与部分路径  {#pathfinder-long}

- **影响：** mineflayer-pathfinder 对 100 格以外、跨越山丘的目标执行 `goto()`（Java 上相同）
- **Java / Bedrock：** 上游行为相同：`goto(GoalLookAtBlock(<90 格外的矿石>))` 以 "Took to long to decide path to goal!"
  reject——`goto` 在搜索状态为 `timeout` 时就 reject，而不是沿最佳部分路径行进；尽管 pathfinder 随后确实会走这条部分路径，
  但走到尽头后不会重新规划。
- **bedboo：** 库和补丁都未做改动。变通做法（仓库自带的 agent `packages/agent` 即如此）：把远距离目标拆成每段 32 格分段行走
  （`GoalNearXZ` 路点，某段失败时改走侧向 16 格的一段），`thinkTimeout` 设为 10 s；超时后等待部分路径走完，再从那里重新搜索；
  bot 30 s 没有移动就放弃。1×1 垫高需要 bot 在所在列中居中（碰撞箱与相邻列重叠时，跳跃会碰到那一列的天花板）：每次跳跃前
  先让 bot 居中。

## 穿过刚放置的门出去时找不到路径  {#own-door}

- **影响：** bot 放置一扇木门且保持连接后，紧接着使用的 mineflayer-pathfinder（已打补丁，`canOpenDoors`）
- **Java：** 未观察到。
- **Bedrock（已观察到，原因不明）：** 一个从屋内放置了房门的 bot 对屋外的所有目标都得到 `NoPath`；重新加入后，pathfinder
  打开了同一扇门并走了出去。bot 看到的门方块状态是正确的（下半部分的 `open_bit`、上半部分的 `upper_block_bit`，重新加入后
  也一样），所以原因不在世界模型；未进一步调查。
- **bedboo：** 未修复。变通做法：从建筑占地范围之外放置门，并显式地穿过门离开已完成的建筑（`activateBlock` + 行走）；被卡住
  时，打开相邻的关着的门并穿过去。

## mineflayer-pathfinder 掉进岩浆  {#pathfinder-lava-drop}

- **影响：** 在下界使用 mineflayer-pathfinder 默认设置的任何人
- **Java / Bedrock：** 上游行为相同：`Movements.infiniteLiquidDropdownDistance`（默认 true）允许路径从任意高度落入
  “液体”，而 pathfinder 的液体包括岩浆——一条下界路径让 bot 掉进了岩浆海（实测：在 y 26 探索时出现
  "\<bot> tried to swim in lava"）。
- **bedboo：** 库和补丁都未做改动。变通做法：设置 `infiniteLiquidDropdownDistance = false`（下落限制为 `maxDropDown` 3），
  并把传送门、火、岩浆块、浆果丛……加入 `blocksToAvoid`。

## 在天花板下垫高（1×1 塔）  {#towers}

- **影响：** mineflayer-pathfinder 的 `allow1by1towers`
- **Java：** pathfinder 跳起并在脚下放置方块；它只清除脚上方两格的方块。只要客户端声称自己升起了，Java 服务器就接受放置；
  客户端会自己在柱子上重新居中。
- **Bedrock：** BDS 拒绝与玩家服务器端碰撞箱重叠的任何方块（[搭路](digging.md#scaffolding)），而打过补丁的 pathfinder 不再
  让 bot 重新居中（那会导致纠正）。偏离中心的碰撞箱会跨到相邻的列；那里脚上方两三格的方块（例如末地岛屿在其抵达平台上方的
  底面）会截断跳跃，每次放置都会被拒绝（实测：连续 204 次 `place_error` 路径重置，bot 卡在 3 格高的柱子上）。
- **bedboo：** 库未做改动。变通做法：在天花板很近的地方，去掉那些九列中任意一列在脚上方 2–3 格有方块的垫高步骤，让
  pathfinder 改为挖出阶梯（末地平台 → 岛顶约 25 s）。其他地方垫高正常（把自己挖进 1×1 竖井的 bot 会居中，能正常垫高出来）。

## 在下界岩浆海上搭桥  {#nether-bridges}

- **影响：** 下界中 mineflayer-pathfinder 的搭路
- **Java / Bedrock：** 相同：岩浆海上的桥很危险（疣猪兽的顶撞或弩箭会把 bot 打进岩浆）。
- **bedboo：** 库未做改动。变通做法：在下界，不在落差超过 4 格的地方放置搭路方块；让 pathfinder 改为挖穿岩石。

## mineflayer-tool 1.2.0 补丁  {#tool}

- **影响：** `bot.tool.getDigTime`、`equipForBlock`、`retrieveTools` 的成本排序
- **Java：** `block.digTime(type, …, nbt.simplify(item.nbt).Enchantments, effects)`。
- **Bedrock：** 附魔是带数字 id 的 `ench` NBT；使用 Bedrock 效果系数（[挖掘速度](digging.md#dig-speed)）。
- **bedboo（补丁）：** 使用 `item.enchants` + `bot._bedrock.digging.blockDigTime`（否则使用 prismarine-block）——估算值等于
  手持该工具时的 `bot.digTime`，因此效率附魔会让带附魔的工具被选中。
  - 修复的上游 bug（与 Bedrock 无关）：物品栏中没有可采集工具时，`equipForBlock(block, { requireHarvest, getFromChest })`
    会调用 `retrieveTools()`，而它在没有箱子（或没有箱子里有工具）时不报错直接返回，随后 `equipForBlock` 再次调用自己——
    无限循环。没有箱子时这是一条无尽的微任务链：事件循环被冻结，进程在约 25 s 内因内存耗尽而崩溃（例如没有镐时用
    mineflayer-collectblock 的 `collect()` 采集煤矿石；它的选项是 `{ requireHarvest: true, getFromChest: true,
    maxTools: 2 }`）。补丁只在有箱子时才搜索箱子，且只搜索一轮；否则（或仍然没有工具时）调用以 `NoItem` reject，与不带
    `getFromChest` 时一样。

## mineflayer-collectblock 1.6.0 补丁  {#collectblock}

- **影响：** `bot.collectBlock.collect(target, [options], cb)`（回调形式）、它拾取的掉落物、`cancelTask()`
- **Java / Bedrock：** 两边存在相同的上游 bug：
  - `callbackify(this.collect)` 丢失了 `this`，因此回调形式（mineflayer 的 `examples/collectblock.js`）总是以
    "Cannot read properties of undefined (reading 'bot')" 失败；
  - 被挖方块的掉落物生成在每个轴上距方块 0.25–0.75 的随机位置（再减去物品高度的一半）：距方块中心最远约 0.52 格（BDS 上
    实测：0.17–0.52）。collectblock 只把距中心 0.5 以内的掉落物作为目标，因此偶尔会漏掉一个掉落物（Java 的分布相同）；
  - 轮到某个目标方块时它已经不存在了（mineflayer-pathfinder 会挖掉挡路的东西，例如在跟随某根原木的掉落物时挖掉了它上方的
    原木），这时会得到一个指向空气的 `GoalLookAtBlock`，它永远不会结束：搜索会跑到 5 s 超时，`collect()` reject（实测：采集
    5 根原木的 4 次运行中有 2 次）；
  - `cancelTask()` 调用 `bot.pathfinder.stop()` 并等待任务结束。在 pathfinder 2.4.5 中，pathfinder 空闲时（挖掘期间、等待
    拾取时）的 stop 会被锁存，因此任务的下一次 `goto` 以 `PathStopped` reject，而 `collect()` 会吞掉这个错误。打过补丁的
    pathfinder 不再锁存（[mineflayer-pathfinder](#pathfinder)）：取消因此丢失，`cancelTask()` 要等整个任务做完（实测：4 根
    原木 17 s）。
- **bedboo（补丁）：** `callbackify(this.collect).call(this, …)`；采集距被挖方块中心 0.75 以内的掉落物；在寻路前丢弃已经变化的
  方块目标；`cancelTask()` 还会给正在运行的任务设置标志，任务在每一步（`goto`、挖掘、等待拾取、清空物品栏）之后检查该标志，
  并像以前一样以 `PathStopped` 结束——在当前步骤完成之后，与 pathfinder 2.4.5 时一样——等待拾取则会立即结束。其他部分未打
  补丁：挖掘等待服务器（[完成](digging.md#completion)），掉落物来自 `itemDrop` → `GoalFollow` → `playerCollect` /
  `entityGone`，箱子流程照常使用 `openChest` / `deposit`。

## 矿石搜索使用区块数据  {#ore-search}

- **影响：** 用 `bot.findBlocks` 查找矿石（mineflayer-collectblock 的示例也是这样做的）
- **Java / Bedrock：** 相同——服务器发送完整区块，bot 用 `bot.findBlocks` 定位方块。
- **bedboo：** 无需改动。在下界采矿时值得了解的事实：
  - 远古残骸的 y 8–22 区间（大矿脉，约在 y 15）大多位于岩浆海（y ≤ 31）之下：那里的目标常常处在开阔洞穴之下，
    mineflayer-pathfinder 会搭桥、垫高穿过虚空去够它们，或者 bot 掉进岩浆。更好的做法是先在岩浆海之上搜索（y ≥ 32，小矿脉
    所在处），要求残骸被岩石包裹到 bot 所在高度（上方没有开阔洞穴或岩浆），再退而求其次搜索 8–22 区间或挖一条直的分支矿道；
  - 寻路去矿石时，绝不破坏与液体相邻的方块；
  - 开采下界金矿会激怒看到这一幕的猪灵，无论是否穿着金甲（之后持弩的猪灵会一直射击 bot）：最后再开采，且绝不在距猪灵 20 格
    以内开采。

## mineflayer-armor-manager 2.0.1 补丁  {#armor-manager}

- **影响：** `playerCollect` 时的自动装备
- **Java：** 每件拾取的盔甲在 100 ms 后开始 `equipItem`；由于 Java 的窗口点击是即时的，这些装备操作很少重叠。
- **Bedrock：** 每次点击都要等待服务器的物品堆叠响应，因此一起拾取的多件盔甲会同时装备；它们的点击通过共享的光标交错进行，
  把盔甲互相换来换去（实测：5 件中只有 1 件最终被装备上）。
- **bedboo（补丁）：** 装备操作依次执行（一个 promise 队列）。`getDroppedItem()` 以及 Java 的盔甲槽 5–8 / 副手 45 可直接
  使用；`supportFeature('doesntHaveOffHandSlot')` 为 false。

## mineflayer-auto-eat 5.0.3 补丁  {#auto-eat}

- **影响：** `bot.autoEat.eat()`、`enableAuto()`
- **Java：** 一次进食以 `bot._client` 上的 `entity_status` 9 结束。
- **Bedrock：** 没有 `entity_status` 数据包；BDS 向进食者发送 `completed_using_item`（也就是 `bot.consume` 等待的东西）。
- **bedboo（补丁）：** 进食监听器在收到 `completed_using_item` 时也会完成。该插件只提供 ESM（用
  `await import('mineflayer-auto-eat')` 加载）；`registry.foods` / `foodsByName` 来自 bedrock-data；它的 GPL-3.0 依赖
  `@nxg-org/mineflayer-util-plugin` 原样使用（它需要 Java 版本比较（[版本比较](data.md#version-comparisons)）、
  `bot.version.split('.')`、`clickWindow`、`inventory.selectedItem`、`firstEmptyInventorySlot`）。只有在简单或更高难度下
  饥饿值才会下降（和平模式下 Bedrock 永远不会让饥饿值下降）。
  - 修复的上游 bug（与 Bedrock 无关）：
    1. `eat()` 在装备食物之前就设置进食标志，而只在进食开始之后的路径上清除它：装备失败（`customEquip` → false，例如同时
       有窗口打开或正在换手）会让 `isEating` 永远为 true——之后每次 `eat()` 都抛出 `Already eating!`，自动模式再也不会进食
       （[详情](#auto-eat-stuck)）。现在进食开始前的任何失败（没有食物、装备、激活物品）都会清除该标志；这样的失败仍然不触发
       任何事件（进食并未开始），与上游一致。
    2. 启用 `strictErrors`（默认）时，失败的进食（超时、物品被换走、`cancelEat()`）会在触发 `eatFail` 之前就抛出，因此默认
       选项下从不会触发失败事件；现在先触发 `eatFail`（然后 `eatFinish`，然后 reject），与 `strictErrors: false` 时一样。
       每次失败只触发一次 `eatFail`：自己用 `eat()` 抛出的错误触发它的代码（针对缺失事件的变通做法）不会把一次失败报告两次。
  - 对无法开始的进食，自动模式在 2 s 后重试（否则失败的装备会在每个 tick 重复），对已失败的进食则立即重试，与上游一致；
    直接调用的 `eat()` 永远不会被延后。抛出异常的 `eatStart` 监听器也不会再让标志保持置位（该事件在进食的 `try` 中触发）。

## mineflayer-auto-eat 在生命值 \< 14 时总是进食  {#auto-eat-health}

- **影响：** mineflayer-auto-eat 5.0.3 的 `minHealth`（默认 14），Java 和 Bedrock 都一样
- **Java：** 同样的选项；对普通食物而言，饱食度满时因低生命值触发的进食同样是徒劳的循环。
- **Bedrock：** 饱食度满的玩家无法进食（BDS 拒绝这次进食），因此仅由低生命值触发的自动进食会每个 tick 开始一次永远完成不了的
  进食（每次 3 s 超时）。
- **bedboo：** 未打补丁。推荐选项：`minHealth: 0`、`minHunger: 16`（只按饥饿值进食）。

## mineflayer-auto-eat 在装备被拒后停止进食  {#auto-eat-stuck}

- **影响：** mineflayer-auto-eat 5.0.3 的 `eat()` / 其自动模式（Java 上代码相同）
- **Java / Bedrock：** 相同的上游 bug：`eat()` 在装备食物之前设置“正在进食”标志，只在进食开始之后的路径上清除它；装备抛出
  异常（其他代码或战斗同时在换手、有窗口打开）会让标志保持置位，自动模式（`physicsTick` → `if (!_eating) eat()`）再也不会
  重试（观察到：一个 bot 在饥饿值 5、物品栏里有 5 份熟食的情况下持续了好几分钟都没进食）。
- **bedboo：** 已在 [mineflayer-auto-eat 补丁](#auto-eat) 中修复：进食开始前的失败会清除该标志。作为最后手段，把“进行中”
  超过 15 s 的进食重置掉仍是一个合理的安全网。

## mineflayer-auto-eat 与 pathfinder 争夺手持物品  {#auto-eat-livelock}

- **影响：** 启用 mineflayer-auto-eat、在饥饿时挖掘或放置的 bot
- **Java / Bedrock：** 上游行为相同。只要饥饿值低于 `minHunger` 且携带可食用物品，auto-eat 就会在任意物理 tick 开始进食
  （装备食物并按住“使用”）；手持物品一变，它就以 "Item switched early" 放弃这次进食。mineflayer-pathfinder 挖掘时装备工具、
  放置时装备方块——下一个 tick auto-eat 又装备回食物。路径需要挖掘或放置方块的饥饿 bot 两样都做不成（实测：一个 bot 在岩浆池
  旁站了 12 分钟，饥饿值 4，携带九块腐肉，每次行走都超时）。
- **bedboo：** 未打补丁。变通做法：在需要挖掘或放置的任务之前，先停下来进食（pathfinder 停止时调用 auto-eat 自己的
  `eat()`）；不要把正在进行的进食当作中断而无限重试；给重试和搜索加上时间上限。

## mineflayer-pvp 1.3.2 补丁、盾牌与攻击时机  {#pvp}

- **影响：** `bot.pvp`（对苦力怕举盾、盾牌使用、攻击时机、`followRange`）
- **Java：** 正在引爆的苦力怕是元数据索引 16 = 1；用 `activateItem(true)` 举盾；攻击频率遵循 Java 的武器冷却。
- **Bedrock：** 正在引爆的苦力怕带有 `ignited` 实体标志；举盾靠潜行（没有使用动作，见
  [物品使用、进食与盾牌](inventory.md#item-use)）；没有攻击冷却。
- **bedboo（补丁）：** `checkExplosion` 也会读取 `metadata.flags.ignited`（实测：该标志会被设置，pvp 会举盾）。未打补丁的
  部分：
  - `activateItem(true)` / `deactivateItem()` 按住 / 松开潜行，因此持盾时 bot 在两次攻击之间以潜行速度移动；这个潜行属于
    盾牌本身，所以 pathfinder 的 `clearControlStates()`（每次追击结束时、挖掘或放置前、`stop()` 时）不会把盾放下；
  - Java 的冷却时机只是让攻击比 Bedrock 允许的略慢一点；
  - 默认 `followRange` 为 2 时，边射击边后退的骷髅会保持在 4 格之外（`GoalFollow` 只在目标移动超过该范围时才重新规划；Java
    上也一样）：对付远程生物请使用 `bot.pvp.followRange = 1`；
  - pvp 监听的是 `physicTick`（mineflayer 会打印其弃用警告，与 Java 上一样）。

## 运行插件时发现的核心修复  {#core-fixes}

- **影响：** `bot.stopDigging`、`bot.creative.flyTo`、`bot.waitForChunksToLoad`
- **Java：** 不适用（插件所依赖的库行为）。
- **Bedrock：** 插件触及了基本 API 调用不会触及的时序。
- **bedboo：**
  - `lib/plugins/digging.js`：`blockUpdate` 监听器先于挖掘自己的按位置监听器运行；mineflayer-pathfinder 在路径附近有任何变化
    时都会停止挖掘，因此 pathfinder 的每次挖掘都以 `diggingAborted`（"Digging aborted"）结束，尽管方块其实已被破坏。现在在
    方块已被破坏时调用 `stopDigging` 会像上游一样完成这次挖掘（上游的 `finishDigging` 在本地更新之前就清除了
    `targetDigBlock`）。新增 `bot._bedrock.digging.blockDigTime(block, type, creative, inWater, notOnGround, enchantments,
    effects)`（prismarine-block 的签名，Bedrock 系数），供插件做成本估算。
  - `lib/plugins/physics.js`：创造模式 `flyTo` 规划器在松开前进键后 10 tick 内绝不再次按下（BDS 在双击前进后会冲刺飞行），
    在连续的 `flyTo` 调用之间保留跳跃保护，并且当目的地高于落点时绝不会提前落地（玩家一接触地面 BDS 就停止飞行）；见
    [飞行](movement.md#flight)。
  - `waitForChunksToLoad`：在瞬移后立即于 "loaded" 时调用会超时，因为 BDS 在加入时发送的区块列（超出其公布的 publisher
    半径的部分）被卸载后再也不会重发；`lib/plugins/blocks.js` 现在会保留它们。

## 移植的 mineflayer 示例  {#examples}

- **影响：** 库的 `examples/` 目录
- **Java：** mineflayer 4.39.0 的 `examples/`（`require('mineflayer')`）。
- **bedboo：** 移植了 51 个示例文件，改为 `require('bedboo')`，其余完全相同（其中硬编码的 Java 物品 / 方块名称保持不变：例如
  fisherman 的 `fish`、graffiti 的 `sign` 都不是 Bedrock 名称——也不是新版 Java 名称）。`auto-eat.js` 改用固定版本的
  mineflayer-auto-eat 5 API（ESM `import()`、`setOpts`、`enableAuto` / `disableAuto`、`eatStart` / `eatFinish`），上游的示例
  早于该 API。未移植：`session.js`（Java 启动器配置文件认证）、`discord.js` / `telegram.js`（第三方机器人，没有 Bedrock 特有
  内容）、`perfectShotBow.js`（minecrafthawkeye，Java）、`viewer/`、`screenshot-with-node-canvas-webgl/`
  （prismarine-viewer：Java 区块）、`anvil_saver/`（Java Anvil 世界文件）、`python/`。需要 Bedrock 行为的示例：
  - BDS 拒绝玩家执行 `/op`；请通过服务器控制台授予 op（[op 命令](chat.md#op-command)）；
  - `bee.js`（创造模式 `flyTo`）在 Bedrock 上是真正在飞：它的 11 段短距离飞行耗时约 15.5 s，而不是约 3 s
    （[飞行](movement.md#flight)）；
  - `inventory.js`：`equip off-hand` 只接受副手物品（例如箭），不接受泥土（[副手](inventory.md#offhand)）。
