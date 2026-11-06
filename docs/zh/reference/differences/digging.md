# 挖掘与放置

本页说明 `bot.dig`、`bot.placeBlock`、`bot.placeEntity` 以及对方块使用物品在 Bedrock 上如何工作——在 Bedrock 上，
方块的破坏和放置都由服务器自己完成。观测环境为 BDS 1.26.51.1（协议 2193，bedrock-protocol 3.60.1）。

## 服务器权威的方块破坏  {#protocol}

- **影响：** `bot.dig`、`bot.stopDigging`、`diggingCompleted`、`diggingAborted`、`bot.targetDigBlock`
- **Java：** 客户端发送 `block_dig` 开始（status 0），自己等待 `digTime` 毫秒，发送完成（status 2）并在本地把方块设为空气；
  取消 = status 1。
- **Bedrock：** BDS 上 `start_game.server_authoritative_block_breaking` 为 true。方块操作随
  `player_auth_input.block_action` 发送（每 tick 一个输入）。实测行为：
  - `start_break` = 在方块上按下鼠标。从这个输入开始，BDS 每 tick 自己累加破坏进度——**开始的那个 tick 也算**——使用的是
    它自己那份手持物品、状态效果、是否着地和眼睛是否在水中的状态；只要**保持破坏状态**，它就会在进度达到 1 的那个输入中
    破坏方块（含开始输入在内的第 `ceil(1/speed)` 个输入），不需要任何其他操作。它会向所有观察者报告速度（先
    `level_event block_start_break`，然后每 tick 一个 `block_break_speed`，data = 每 tick 进度 × 65535，向下取整），
    以 `update_block`（空气）+ `particle_destroy` 报告破坏，随后是掉落物（`add_item_entity`）。
  - `predict_break`（客户端的“已经破坏”）从同一个输入起才被接受；早一个输入发送时，BDS 会回一个恢复该方块的
    `update_block`（而若破坏仍在保持，它仍会在下一 tick 破坏方块）。
  - `continue_break` 会让 BDS 重新开始破坏：每发送一次，它都会向所有观察者发送 `block_stop_break` + `block_start_break`
    （其他玩家看到的裂纹动画和 mineflayer 的 `blockBreakProgressObserved` 每 tick 都会重新开始）。`crack_break`
    被接受，但不改变任何东西。
  - `abort_break` 结束破坏。`stop_break` **不会**：一次破坏完成后，BDS 会继续“按住”该位置，并自行破坏随后放到那里的下一个
    方块（即使是 `/setblock` 放置的）。
  - 面和视线方向都不被校验（任意面、看向别处、距离最远约 7 格，都能破坏）。
  - 创造模式：仅 `start_break` 就会瞬间破坏（无掉落物）；仅发送 `player_action creative_player_destroy_block` 没有任何
    效果。
- **bedboo：** 在转向之后的输入中发送 `start_break`，保持破坏期间不发送任何东西；当 BDS 自己每 tick 的进度报告
  （`block_break_speed`）显示还差一个 tick 就完成时发送 `predict_break`——也就是在客户端和服务器同步运行时，恰好在 BDS
  完成破坏的那个输入中（实测为 BDS 接受的最早输入）；服务器落后时会更晚，但绝不提前。纯客户端的 tick 计数不够：在负载较高
  的主机上，BDS 会落后于客户端的输入计数并恢复方块。BDS 不发送进度报告时，bedboo 使用自己的计数并留一个 tick 的余量。
  - 以服务器的 `update_block`（空气；含水方块 / 冰则为液体）作为完成标志，随后发送 `abort_break` 释放破坏状态；携带它的输入
    发出后（≤ 1 tick）`dig` 才结束，因此调用方接下来做的任何事——在该位置放置方块、继续挖掘——都会在释放之后才到达 BDS
    （实测：否则在 update 之后立即执行的 `/setblock` 会再次被 BDS 破坏）。
  - 创造模式和瞬间破坏（第一个 tick 进度 ≥ 1）：`start_break` + `predict_break` 放在同一个输入中。
  - `stopDigging` / 新的挖掘 / 死亡 / 切换维度：`abort_break`。
  - 当 BDS 报告的被挖方块速度与本地估算不同时，以前者替换后者，因此不一致永远不会导致客户端提前预测。
  - 保留上游每 350 ms 挥一次手（`animate`）的行为。
  - 旧式（非服务器权威）服务器：发送 `start_break`，每 tick 发送 `crack_break`，在 `digTime` 之后发送 `stop_break` + 一个
    `inventory_transaction` `break_block`，并像上游一样在本地预测方块被破坏。BDS 始终是服务器权威的，因此无法用它测试这条路径。

## dig() 在服务器确认后完成  {#completion}

- **影响：** `bot.dig`（promise 何时结束）、`diggingCompleted`、`bot.lastDigTime`
- **Java：** 客户端自己的 `digTime` 计时器触发时 promise resolve（方块在本地设为空气）。
- **Bedrock：** 方块由服务器破坏；客户端自行设为空气只是一种猜测，服务器可能会推翻它。
- **bedboo：** `dig` 在服务器的 `update_block` 之后 resolve（并以空气方块触发 `diggingCompleted`）：它在开始输入之后
  `digTime` − 1 tick + 往返延迟到达（在本地 BDS 上对 848 次计时挖掘的实测：相对 `digTime` 中位数 −21 ms，范围
  −75…+44 ms），挖掘随释放输入最多晚一个 tick 结束（见 [服务器权威的方块破坏](#protocol)）。
  - BDS 会在大约一个 tick 内多次发送被破坏方块的 `update_block`（破坏本身，以及对 `predict_break` / `abort_break` 的应答）：
    等待该位置“下一次更新”的代码应先让这些更新过去。
  - “已破坏” = 空气、液体（含水方块、海带、珊瑚扇和冰会留下水；灵魂沙 / 岩浆块上方的气泡柱），或少了一个蛋的海龟蛋。
  - 如果在 `predict_break` 之后 40 tick 内服务器都没有任何破坏该方块的迹象（没有更新、没有速度报告——仍在破坏时 BDS 每
    tick 都会报告速度；例如冒险模式、受保护的方块或教育版方块），则像 `stopDigging` 一样中止挖掘（`diggingAborted`，
    reject 信息为 `Digging aborted: the server did not break <name> at <pos>`）；上游无论如何都会 resolve。
  - 断开连接也会 reject 正在进行的挖掘（`Digging aborted: the connection ended`；上游的计时器会让它 resolve）。
  - `bot._bedrock.digging`（内部）保存最近几次挖掘的诊断信息（开始 / 结束时间、tick 数、BDS 报告的速度、恢复次数）。

## 挖掘速度：Bedrock 的状态效果系数  {#dig-speed}

- **影响：** `bot.digTime`，以及被 mineflayer-pathfinder / mineflayer-tool 直接调用的 `block.digTime(...)`
  （prismarine-block）
- **Java：** 急迫和潮涌能量把速度乘以 `1 + 0.2 × level`；挖掘疲劳乘以 0.3 / 0.09 / 0.0027 / 0.00081（等级 1–4+）。
- **Bedrock（实测，`level_event` 数据）：** 急迫 / 潮涌能量（取较高等级）乘以 `(1 + 0.2 × level) × 1.2^level`
  （I 1.44、II 2.016、III 2.7648、V 4.9766）；挖掘疲劳乘以 `0.21^level`（= 0.3^level × 0.7^level：I 0.21、
  II 0.0441、III 0.0093、IV 0.0019、V 0.0004）。其余部分都与 Java 公式相同，并已在 BDS 上验证：各材质的工具倍率（来自
  Bedrock 数据，包括金 12 和铜 5）、不能采集的工具其等级仍会提速（木镐挖铁矿石）、效率 `level² + 1` 仅在工具倍率大于 1 时
  生效、头盔上的水下速掘、眼睛在水中 ÷5、不在地面 ÷5（两者同时：÷25）、`canHarvest ? 30 : 100`、硬度 0 = 瞬间破坏
  （BDS 报告 65535 = 1.0）、`ceil(1/speed)` 个 tick。
- **bedboo：** `bot.digTime` 使用 `lib/bedrock/dig_speed.js`（结构与 prismarine-block 的 `digTime` 相同，但使用 Bedrock
  的效果系数；没有这些效果时，对每种方块 × 工具 × 水中 / 空中 / 附魔组合，结果都与 prismarine-block 相同）。
  prismarine-block 自己的 `block.digTime` 保留 Java 的效果系数（未打补丁）：在急迫或挖掘疲劳下调用它的插件成本估算会偏差
  这些系数（挖掘本身是正确的，因为它等待服务器）。打过补丁的 mineflayer-pathfinder 和 mineflayer-tool 改用
  `bot._bedrock.digging.blockDigTime`（见 [mineflayer-pathfinder](plugins.md#pathfinder)、
  [mineflayer-tool](plugins.md#tool)）。对每种可挖掘方块，BDS 报告的速度都等于 `bot.digTime`。

## 创造模式：剑、三叉戟和重锤不能破坏方块  {#creative-weapons}

- **影响：** 创造模式下的 `bot.digTime`、`bot.dig`
- **Java：** 创造模式下所有方块的 `digTime` 都为 0（Java 创造模式玩家同样不能用剑破坏方块；上游忽略这一点，服务器会恢复
  方块）。
- **Bedrock（实测）：** 创造模式玩家手持任意剑、三叉戟或重锤破坏方块时，BDS 会恢复方块；长矛、工具、其他物品和空手都能
  瞬间破坏。
- **bedboo：** 在创造模式下手持这些物品时 `digTime` 为 `Infinity`，因此 `dig` 会立即以上游的
  `dig time for <name> is Infinity` reject，而不是等待服务器。

## 眼部水体包括含水方块  {#eye-water}

- **影响：** `bot.digTime`、`bot._getBlockAtEyeLevel`（未改动）
- **Java：** 当眼部方块是 `water` / `flowing_water` 时，上游认为眼睛在水下。
- **Bedrock：** 水也可能是方块的第二层（含水方块、海带、海草）。
- **bedboo：** 眼部方块为 `water`、`flowing_water`，或第 1 层为水的方块（`block.isWaterlogged`）时眼睛在水下。不使用
  `bot.entity.isInWater`（与上游相同）。眼睛在水下时挖掘耗时为 5 倍，BDS 的结果与此一致。

## 'auto' 挖掘面  {#dig-face}

- **影响：** `bot.targetDigFace`、方块操作所带的面
- **Java：** `dig(block)` 在 `digFace` 为 'auto' 时看向方块中心并发送面 1（顶面）。
- **Bedrock：** BDS 不校验面，但原版客户端发送的是准星下的面，而且这个面决定了其他玩家看到的敲击粒子。
- **bedboo：** 'auto'（带转向）使用从眼睛到方块中心的视线进入方块时穿过的那个面（例如 bot 与方块同高且位于其西侧时为
  4 = 西）。面向量、'raycast' 和 `forceLook: 'ignore'`（面 1）沿用上游。

## 工具耐久  {#durability}

- **影响：** 挖掘后 `bot.heldItem` 的耐久、`heldItemChanged`
- **Java：** 服务器扣减工具耐久并发送 `set_slot`。
- **Bedrock：** 原版客户端会在 `predict_break` 中附带一个 `item_stack_request` `mine_block` { 快捷栏槽位、预测耐久、
  stack id }；BDS 只在破坏完成的那个输入中接受它（晚一个输入就回复 `status: error`），然后在响应的
  `durability_correction` 中报告耐久，而不是发送槽位。没有这个请求时，BDS 自己扣减工具耐久，并发送带新 `Damage` 的
  `inventory_slot`。
- **bedboo：** 不发送 `mine_block` 请求（只有在服务器同步运行时，预测才会落在完成的那个输入中，见
  [服务器权威的方块破坏](#protocol)）；物品栏模型应用服务器的 `inventory_slot`（每个方块 Damage +1，耗尽时工具消失，
  `heldItemChanged` 与 Java 的 `set_slot` 一致）。

## 挖掘空气  {#dig-air}

- **影响：** `bot.dig(air)`、`bot.digTime(air)`、`registry.blocksByName.air.hardness`
- **Java：** 空气硬度为 0：`digTime` 为 0，`dig` 立即 resolve 并触发 `diggingCompleted`。
- **Bedrock：** minecraft-data PR #1335 和 BDS 自己导出的方块数据都把空气硬度设为 -1（不可破坏）。
- **bedboo：** 数据覆盖层把空气硬度设为 0（`packages/bedrock-data/scripts/tables.js` `BLOCK_FIXES`），因此
  `digTime(air)` 与上游一样为 0。对世界中为空气的方块执行 `bot.dig`（包括一个已不存在的方块的过期 Block 对象——例如门的
  另一半）会立即以 `diggingCompleted(air)` 完成，不发送任何东西（BDS 从不报告破坏空气）。若过期的空气 Block 所在位置现在
  已有方块，则正常挖掘。

## 无法布置或挖掘的方块  {#dig-everything}

- **影响：** 整个方块注册表范围内的 `bot.dig`、`bot.digTime`
- **Java：** 每种可挖掘的 Java 方块都可以放置并挖掘（少数除外）。
- **Bedrock：** 注册表中有 1,442 种可挖掘方块。在 BDS 1.26.51.1 上，其中约 230 种无法放进生存模式的测试世界，或永远不会被
  破坏：
  - `/setblock` 拒绝的 id：教育版的 `element_*`、化合物和硬化玻璃，`unknown` / `info_update` / `reserved6` 等内部 id，
    以及 BDS 1.26.51.1 不认识的 `*_concrete_double_slab` / `*_wool_double_slab` 状态；
  - 设置后无法留在原处的方块（珊瑚壁扇、绊线钩、灵魂火、气泡柱……）；
  - `frosted_ice`（挖掘过程中会融化）；
  - 教育版的 `allow` / `deny` / `border_block`（BDS 在生存模式下从不破坏它们）。

  默认朝下的附着类方块（按钮、物品展示框、旗帜、拉杆）只有设置在地面上（`facing_direction` 1）或墙上时才能留下。挖掘后
  “消失” = 空气或液体（冰、海带、海草、珊瑚扇和海泡菜会留下水）。
- **bedboo：** 其余每种方块都在生存模式下用下列工具中最快的一种挖掘过：下界合金镐 / 斧 / 锹 / 锄和剪刀（效率 V）、下界合金剑
  以及空手：BDS 报告的速度均等于 `bot.digTime`，且 BDS 从未恢复过被挖掘的方块。

## 瞬间破坏之后的进度报告  {#instant-break-report}

- **影响：** `bot._bedrock.digging.last.serverSpeedData`（诊断信息）
- **Java：** 无对应情况（客户端自己为挖掘计时）。
- **Bedrock：** 瞬间破坏之后，BDS 可能会报告取代该方块之物的破坏进度（水源中的植物被破坏后留下的水，例如
  `short_dry_grass`）——有时出现在破坏的 `update_block` 之前的那一批数据包中。
- **bedboo：** 瞬间破坏（开始和预测在同一个输入中）只把瞬间级别的报告（每 tick ≥ 1：被挖方块自己的报告）作为服务器速度；
  更慢的报告只算作服务器活动。

## 放置协议：用 start/stop_item_use_on 包裹的 click_block  {#placement-protocol}

- **影响：** `bot._genericPlace`、`bot.placeBlock`、`bot._placeBlockWithOptions`、`bot.placeEntity`、`blockPlaced`
- **Java：** `block_place`（位置、方向、手、光标位置）；无论是否放置了东西，服务器都会先为被点击的方块、再为面对面的方块
  回复 `block_change`。
- **Bedrock：** 与原版客户端一样，点击方块的一个面依次为 `player_action start_item_use_on`（被点击方块、被点击方块 + 面、
  面）→ `inventory_transaction item_use click_block`（手持物品在服务器上的精确副本，包括其 stack id、被点击方块的
  runtime id、面上的点击点、面、快捷栏槽位、手、位于眼睛高度的玩家位置、预测 `success`）→ 150 ms 后的
  `player_action stop_item_use_on`（被点击方块 + 面）。实测应答（本地约 80–120 ms）：先是物品栏（所有窗口的
  `inventory_content`：使用后的数量、耐久或新的 stack id），然后是一串 `update_block`——被点击方块、面对面的方块、被点击方块
  的下方邻居、再次是面对面的方块、它的上方邻居、再次是被点击方块——约 20 ms 后目标位置再更新一次，并带有 `place` 音效。
  被拒绝时（有实体挡路、玩家自己的碰撞箱、物品不是方块、超出世界）收到同样的一串更新，但目标位置不变（外加一个
  `set_entity_data` 重同步），物品栏也不变。
- **bedboo：** `bot.placeBlock` / `bot._placeBlockWithOptions` 是上游代码（原样内置）；`bot._genericPlace` /
  `bot.placeEntity` 保留上游的检查、选项、转向和事件。应答的形式与 Java 相同（先是参考方块，再是目标位置），因此上游的
  `place_block.js` 及其错误信息都无需修改（`Server refused to place <item> at <pos>: the block is still <name>`、
  `Server did not answer the placement at …`、`must be holding an item to place`）。点击一进入队列 `_genericPlace` 就
  resolve（上游：紧接在 `block_place` 之后）；一次点击的 stop 会在下一次点击的 start 之前发送（成对的操作不会交错）。
  与上游一样，客户端不预测放置：方块随服务器的更新出现。

## 对可交互方块潜行放置  {#sneak-placing}

- **影响：** `bot._genericPlace` 以及基于它的一切（`placeBlock`、`placeEntity`；mineflayer-pathfinder）
- **Java：** mineflayer 不会告诉服务器自己在潜行（`generic_place.js` 中的 “TODO”）；mineflayer-pathfinder 会针对它的
  `interactable.json`（Java 名称）自己按下潜行。
- **Bedrock：** 除非玩家在潜行，否则 BDS 会执行被点击方块的使用动作（打开箱子 / 工作台 / 熔炉、开关门、打开告示牌编辑器……）
  而不是放置；潜行按键随 `player_auth_input` 发送，服务器必须在处理点击之前已处理该输入（提前一个输入就足够；
  `set_entity_data` 的 `sneaking` 即为确认）。飞行中的玩家永远不会进入 `sneaking` 状态，但输入中的原始潜行按键仍然有效。
- **bedboo：** 当参考方块可交互时（`lib/bedrock/placement.js` 的 `isInteractive`，Bedrock 名称：容器、工作站、除铁质外的
  门 / 活板门 / 栅栏门、按钮、拉杆、中继器、比较器、告示牌、床、蛋糕、物品展示框……），`_genericPlace` 会按住潜行控制，
  等它随一个输入发出（有 `bot._bedrock.physics.controlsSent()` 时用它，否则等下一个发出的输入）并得到服务器确认（飞行时
  不等确认），然后点击，再松开它自己按下的潜行（调用方按住的潜行会保留，例如 mineflayer-pathfinder 的）。骑乘时不按任何键
  （在 Bedrock 上潜行会下坐骑）。飞行时 bot 可能在那个 tick 内略微下降（潜行 = 下降）。这样在生存模式下可以放置到箱子、
  工作台、熔炉、木门、站立告示牌或木桶的上面，在创造飞行中也可以对着箱子放置。

## 放置会等待服务器对上一次点击的应答  {#placement-serialization}

- **影响：** `bot.placeBlock`、`bot._placeBlockWithOptions`、`bot.placeEntity`，以及使用桶和船的 `bot.activateItem`——
  多个同时进行或紧挨着执行时
- **Java：** `block_place` 不携带物品：进行中的放置不会相互失效。
- **Bedrock：** 每次点击都携带手持物品在服务器上的精确副本；每次使用后 BDS 都会给该堆叠分配新的 stack id（在它的
  `update_block` 应答之前的 `inventory_content` 中），并拒绝带旧 id 的点击（实测：两次放置相隔 0–30 ms → 第二次被拒绝）。
- **bedboo：** 点击在放置器中串行化（`lib/bedrock/placement.js`）：下一次点击要等手持物品已更新、被点击方块已得到应答，或
  500 ms 之后才发出。依次 await 的放置（例如 mineflayer-pathfinder）从不需要等待；对多个放置使用 `Promise.all` 会把它们
  全部放下。在某次放置尚未得到应答时发起的桶 / 船使用（`activateItem` → 所看向的方块）会保留其目标和快捷栏槽位，并在其后
  发出。其他物品使用（`activateBlock`、`activateItem` 的 `click_air`）不串行化：在放置后不 await 就立即发起时，它们仍可能
  携带旧的 stack id。

## 带有过期方块状态的点击会重试  {#stale-click}

- **影响：** 对服务器刚刚改变过的方块执行 `bot.placeBlock` / `_placeBlockWithOptions`
- **Java：** `block_place` 不携带方块状态。
- **Bedrock：** 点击携带被点击方块的 runtime id，BDS 会拒绝 id 与它自己对该方块的状态不一致的点击。某些方块会在相邻方块
  更新后一个 tick 才被 BDS 改变（耕地和土径在其上放置方块后会变成泥土，发生在放置应答之后 50–90 ms），因此紧接着对它们的
  下一次点击会被拒绝。
- **bedboo：** 点击的应答会透露服务器上被点击方块的状态；若被拒绝的点击携带的是另一个状态，就用方块当前的状态重试一次
  （`generic_place.js` 中对内置 `place_block.js` 的包装）。其他拒绝与上游一样 reject。改变了被点击方块本身的点击绝不会被
  当作过期点击：对着可替换方块（`snow_layer`、`short_grass`、`fern`、`vine`、`seagrass`……）或手持物品可以合并进去的方块
  （同种半砖 → 双层半砖，再加一根蜡烛 / 一个海泡菜 / 一层雪 / 一片花瓣，蜡烛插到蛋糕上）点击时，BDS 会把方块放到被点击的
  位置，面对面的方块保持不变——与 Java 完全相同，因此调用在一次点击后就以上游的 `Server refused` reject（而不是再点一次、
  在其上方放下第二个方块）；用掉了物品的点击也同样不会被当作过期点击。

## 手持堆叠在服务器上已变化的点击会重试  {#stale-held}

- **影响：** 在拾取物品、被给予物品（`/give`）或手持堆叠以其他方式增加期间执行的 `bot.placeBlock` /
  `_placeBlockWithOptions`（先挖后放的循环、mineflayer-pathfinder 的搭路）
- **Java：** `block_place` 不携带物品。
- **Bedrock：** 点击携带手持物品在服务器上的精确副本（其 stack id）。若在点击发出到被处理之间有拾取合并进手持堆叠，该堆叠会
  先得到新的 stack id（`inventory_transaction` normal，然后 `inventory_content`），BDS 会拒绝这次点击（实测：先挖后放的
  循环中 180 次放置有 4 次；在点击前刚执行 `/give`：每次都会）。
- **bedboo：** 放置器会记录点击与其应答之间手持槽位在服务器端的变化（该槽位的 `inventory_transaction`，或堆叠变多）；
  这样的拒绝会用服务器的副本重试一次（此时客户端已拿到该副本）。其他拒绝与上游一样 reject。

## 垫高与搭桥（mineflayer-pathfinder 搭路）  {#scaffolding}

- **影响：** `bot._genericPlace`（跳跃放置）、mineflayer-pathfinder 的 `allow1by1towers` 和搭桥
- **Java：** pathfinder 跳起，脚一离地就在脚下调用 `placeBlock`；点击被拒绝会重置路径（`place_error`）并重试。
- **Bedrock：** BDS 会拒绝与玩家服务器端碰撞箱相交的任何方块（实测：重叠 0.01 格也会被拒绝；不会有方块被放进玩家体内，
  因此也没有推出）。它在处理点击之前先处理此前发出的玩家输入，所以点击必须跟在一个碰撞箱已离开目标位置的输入之后。
- **bedboo：** 当 bot 正从目标方块中升起，或一直在跳（按住跳跃控制）时，点击会等待（≤ 20 个输入）第一个碰撞箱已离开该方块
  的输入，并紧随其后发出；不会离开的 bot 会立即点击，并像上游一样收到服务器的拒绝。实测（生存模式、有重力、本地 BDS）：
  - 手动垫高 ×4（脚一离地就放置）：0 次拒绝，0 次纠正；
  - pathfinder 垫高 ×5：0 次 `place_error`，0 次纠正（每格约 0.45 s，点击在脚离地后 2 tick 发出）；
  - 手动搭桥 ×4（潜行后退到边缘，对着下方方块的侧面放置）：0 次纠正；
  - pathfinder 搭桥 ×5–6：未打补丁时有 3–4 次 0.16–0.64 格的纠正，全部来自 pathfinder 自己的 `fullStop()`，它在客户端把
    `bot.entity.position` 移到方块中心（在 Java 上“服务器察觉不到差别”；服务器权威的 BDS 会察觉：它把 bot 纠正回去，然后
    bot 继续走）。打过补丁的 pathfinder 会跳过这次居中：0 次纠正（见 [mineflayer-pathfinder](plugins.md#pathfinder)）。

  在天花板下垫高另有限制：见 [1×1 塔](plugins.md#towers)。

## 不能从副手放置  {#offhand-placing}

- **影响：** `bot._genericPlace` / `bot._placeBlockWithOptions` / `bot._placeEntityWithOptions` 的 `offhand` 选项
- **Java：** `hand: 1` 放置副手物品。
- **Bedrock：** 副手只能放少数物品（盾牌、图腾、箭、烟花火箭、地图……，见 [副手](inventory.md#offhand)），玩家也从不对方块
  使用副手；用 `hand: off_hand` 和副手物品（或主手物品）点击什么都不会放置（实测，用 `/replaceitem` 强行把方块放进副手）。
- **bedboo：** 按原版客户端的方式发送点击（手为 `off_hand`，带副手的线上物品），服务器拒绝，`placeBlock` 以上游的拒绝信息
  reject；保留上游对空副手的检查。

## placeEntity  {#place-entity}

- **影响：** `bot.placeEntity`、`bot._placeEntityWithOptions`、`entityPlaced`
- **Java：** 点击方块（`block_place`）；船还额外发送 `use_item`（服务器沿视线做射线检测）；在目标位置 2 格（船为 3 格）内按
  名称查找实体（`EnderCrystal` / `end_crystal`、`boat`、`armor_stand`、刷怪蛋对应的生物）；不支持矿车（断言
  'Unimplemented'）。
- **Bedrock：** 一切都是对方块的点击：盔甲架、末影水晶（黑曜石 / 基岩）、刷怪蛋、矿车（放在铁轨上）和船（BDS 忽略船的
  `click_air`；原版客户端点击它所瞄准的水；船也可以放在陆地上）。实体名称：`ender_crystal`、`boat` / `chest_boat`
  （运输船、竹筏）、`armor_stand`、`minecart` / `chest_minecart` / ……，刷怪蛋 `villager` → `villager_v2`、
  `zombie_villager` → `zombie_villager_v2`、`evoker` → `evocation_illager`、`tropical_fish` → `tropicalfish`。和平模式下
  敌对生物的刷怪蛋什么也不会生成（蛋仍会被消耗）。
- **bedboo：** 使用上游代码，另外：
  - 参考方块为液体时，船会点击液体的顶面（无论给出的是哪个面，船都会在其上居中生成；视线方向无关紧要，所以船永远不会落在
    bot 身上）；
  - 接受矿车（放在铁轨上），运输船也可以放在陆地上；
  - 使用上述 Bedrock 名称；
  - 上游在第一个 `entitySpawn` 之后就停止监听，即使那是另一个实体（之后总是在 5 s 后超时）；这里的监听会一直保留，直到所
    放置的实体生成或超时（'Failed to place entity'，未改动）。

## 对方块使用物品：桶、打火石、骨粉、烟花  {#item-use-on-blocks}

- **影响：** 使用这些物品时的 `bot.placeBlock` / `bot.activateBlock` / `bot.activateItem`
- **Java：** `activateItem`（`use_item`）对玩家看向的方块使用桶或船（服务器射线检测）；手持桶、打火石或骨粉的
  `placeBlock` / `activateBlock` 作用于被点击的方块。
- **Bedrock：** BDS 会忽略桶和船的 `click_air`（实测：什么也不发生）；原版客户端点击所看向的方块（`click_block`：空桶点击
  液体源本身，装满的桶点击液体后面的实心方块，液体出现在面的另一侧）。用打火石 `click_block` 会点火（黑曜石框架变成
  `portal` 方块），骨粉催熟被点击的植物，对方块使用烟花火箭会发射它；与 Java 一样，未滑翔时在空中使用火箭没有效果。
- **bedboo：** 手持水桶 / 岩浆桶的 `placeBlock` 以 `blockPlaced(air, water|lava)` resolve，手持打火石时以
  `blockPlaced(air, fire|portal)` resolve；手持空桶执行 `activateBlock(<液体源>)` 会装满它。手持桶或船的 `bot.activateItem`
  会调用 `bot._bedrock.placement.useOnLookedAtBlock(item, offHand)`，即这种使用在 Bedrock 上的形式：沿视线做射线检测
  （在物品可作用的地方包括液体），然后点击。其他物品使用见 [物品使用、进食与盾牌](inventory.md#item-use)。
