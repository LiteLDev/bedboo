# 世界与方块

bedboo 如何让世界模型（`bot.blockAt`、`blockUpdate`）与 Bedrock 的方块层和方块更新保持同步，以及世界状态（时间、天气、
游戏规则）、告示牌、命令方块、方块动作和传送门有哪些不同。观察环境为 BDS 1.26.51.1（protocol 2193）。

## 含水方块（方块层 1）  {#waterlogging}

- **影响：** `bot.blockAt`、`blockUpdate`、`bot.world`。
- **Java：** `waterlogged=true` 方块状态。
- **Bedrock：** 第二个方块存储层：层 0 是方块，层 1 是液体（`update_block.layer`、`update_subchunk_blocks.extra`、双层子区块）。
- **bedboo：** `blockAt()` 返回层 0 的方块；当层 1 中有水时，它带有 `block.superimposed`（层 1 的 Block）、
  `block.computedStates.waterlogged = true` 和 `block.isWaterlogged = true`（prismarine-chunk 的 Bedrock 表示方式；bedboo 的
  补丁只叠加非空气的层 1 条目）。层 1 的更新与层 0 一样触发 `blockUpdate`。当一个方块替换水或含水方块时，BDS 只发送层 0：
  此时液体层遵循 Bedrock 的规则（[液体层](#liquid-layer)）。

## 被替换方块的液体层  {#liquid-layer}

- **影响：** `bot.blockAt(…).isWaterlogged` / `.superimposed` / `.computedStates.waterlogged`、`blockUpdate`、物理引擎中的水
  （它读取 `isWaterlogged`）。
- **Java：** `waterlogged` 是方块状态：每次方块更新都携带它。
- **Bedrock：** 含水是方块层 1，当一个方块替换水源或含水方块时，BDS 只发送层 0 的变化（`update_block` 层 0，或 `extra` 为空的
  `update_subchunk_blocks`）；液体层规则由客户端自行应用。在线观察（以重新加入后的结果为准）：放入水源中的栅栏、梯子、台阶、
  地毯或墙会含水；含水栅栏被台阶 / 地毯 / 墙替换后仍含水，被石头 / 玻璃替换后变干，被空气或水替换后就是普通的水；流动的水
  （非水源）和岩浆永远不会进入层 1。Bedrock 的"可容纳液体"方块集合与 Java 的 `waterlogged` 方块不同（地毯可以含水），且没有
  客户端数据列出这个集合。
- **bedboo：** 层 0 更新后的新方块若为空气或液体，则清除层 1；同一方块变为另一状态（活板门开关、海带生长）则保留其液体层；
  这两种情况是确定的。其他任何方块替换水源或含水方块时，先做预测（完整方块为干，其他方块保留 / 吸收水；一次 `blockUpdate`
  同时包含两层），再进行确认：机器人重新请求该子区块（每个子区块同一时间只有一个 `subchunk_request`，5 s 无应答则重发，最多
  3 次），并对这些方块应用服务器的层 1（预测错误的位置再触发一次 `blockUpdate`；在此期间层 0 又发生变化的方块交给它自己的更新
  处理，请求发出期间发生变化的方块会再次请求）。

## 下落的方块（`update_block_synced`）  {#falling-blocks}

- **影响：** `bot.blockAt`、`blockUpdate` / `blockUpdate:(x, y, z)`、`bot.world`，以及所有读取它们的代码（物理、挖掘、
  mineflayer-pathfinder）。
- **Java：** 方块开始下落时，`block_update` 把它变为空气（下落中的方块是一个实体），落地时再设置到落点。
- **Bedrock：** 沙砾、沙子、混凝土粉末、铁砧等开始下落和落地都只通过 `update_block_synced` 发送，从不使用 `update_block`：
  起始位置以 `transition_type: 'create'` 变为空气（随后是 `add_entity minecraft:falling_block`），落点以 `'destroy'` 变为该方块
  （约 150 ms 后是下落方块的 `remove_entity`）。悬空放置的方块（`/setblock`、放置操作）先以 `update_block` 到达，约 100 ms 后
  开始下落。`entity_unique_id` 是下落方块的 unique id，按无符号 varint64 写入（bedrock-protocol 按 zigzag64 读取：-4294967288
  会读成 9223372034707292164）。忽略这些数据包的客户端会让已下落的方块留在空中、看不到落地的方块，结果服务器让机器人在一个
  客户端显示为空气的方块里窒息。
- **bedboo：** `update_block_synced` 与 `update_block` 同样处理（层、runtime id → state id、[液体层规则](#liquid-layer)、方块
  实体），并触发 `blockUpdate` 事件：pathfinder 会重新规划，对已落走的方块的挖掘会完成（与 Java 上方块变为空气时一致）。

## 燃烧中的熔炉等"点亮"方块是独立的方块  {#block-variants}

- **影响：** 对熔炉、高炉、烟熏炉、红石矿石、红石灯、红石火把、中继器、比较器、阳光探测器使用 `bot.findBlock` /
  `bot.findBlocks` / `bot.blockAt`；`bot.openFurnace`。
- **Java：** 一个方块带 `lit` / `powered` / `inverted` 状态（`furnace[lit=true]`）：按方块 id 匹配可以找到它的所有状态。
- **Bedrock：** 两个方块，各有自己的 id：`furnace` / `lit_furnace`、`blast_furnace` / `lit_blast_furnace`、
  `smoker` / `lit_smoker`、`redstone_ore` / `lit_redstone_ore`、`deepslate_redstone_ore` / `lit_deepslate_redstone_ore`、
  `redstone_lamp` / `lit_redstone_lamp`、`redstone_torch` / `unlit_redstone_torch`、`unpowered_repeater` /
  `powered_repeater`、`unpowered_comparator` / `powered_comparator`、`daylight_detector` / `daylight_detector_inverted`。
  正在燃烧的熔炉在熄灭前一直是 `lit_furnace`。
- **bedboo：** registry 保留 Bedrock 的方块（`bot.findBlock({ matching: furnace.id })` 找不到燃烧中的熔炉）。
  `bot.bedrock.blockVariants(nameOrId)` 返回该组的 id（`blockVariants('furnace')` → `[furnace, lit_furnace]`；其他方块 →
  `[id]`），可用于 `matching`（见 [Bedrock 扩展](../api.md#bedrock-extras)）。`openFurnace` 接受点亮的方块（窗口类型和总烧炼
  时间取未点亮方块的）；方块点亮或熄灭时，熔炉窗口保持打开。

## 门的上半部分取下半部分的形状  {#door-halves}

- **影响：** `bot.blockAt(<门的上半部分>).shapes`、门口处的物理碰撞、mineflayer-pathfinder 穿门。
- **Java：** 上下两半都带有 `open`、`facing` 和 `hinge`。
- **Bedrock：** 开关状态和朝向在下半部分，铰链在上半部分：BDS 从不设置上半部分的 `open_bit`（在 1.26.51.1 上测得，也用
  `testforblock` 核对过），原版客户端根据两者绘制两半。因此按状态取形状会让打开的门的上半部分仍是关闭的门板：机器人在门口撞头
  （服务器修正），mineflayer-pathfinder 找不到穿过自己打开的门返回的路（NoPath，或在 `canDig` 下把门挖掉）。
- **bedboo：** `bot.blockAt()`（`lib/plugins/blocks.js`）让门的每一半都使用组合状态的形状（下半部分的开关状态和朝向，上半部分
  的铰链）；`stateId` 和 `getProperties()` 保持服务器的值（上半部分的 `open_bit` 仍为 0：请读取下半部分）。

## 世界时间  {#world-time}

- **影响：** `bot.time.*`、`time` 事件。
- **Java：** 每 20 tick 一次 `update_time`（世界年龄 + 一天中的时间；26.1：按维度的时钟）。
- **Bedrock：** 完全没有 set_time 数据包：使用 `sync_world_clocks` 中的 `minecraft:overworld` 世界时钟（`initialize_registry`
  带时间标记，`/time set|add` 时以及偶尔发送 `sync_state`）；昼夜循环由 `doDayLightCycle` 游戏规则决定；没有世界年龄。
- **bedboo：** `bot.time.time` = 世界时钟（绝对的一天中时间，所有维度通用），派生字段与上游相同；`doDaylightCycle` 来自游戏规则
  （变化时触发 `time`）；`bigAge` / `age` = 服务器 tick（`start_game.current_tick` + 已过去的 tick）。两次同步之间时钟在本地
  运行（在循环开启且时钟未暂停时），并且像 Java 的广播一样每 20 个物理 tick 触发一次 `time`。`bot.time.clocks` 以名字为键保存
  Bedrock 时钟（`overworld`）：上游的 `{ id, totalTicks, partialTick, rate }` + `name`、`paused`、`timeMarkers`。

## 天气等级  {#weather}

- **影响：** `bot.rainState`、`bot.thunderState`、`weatherUpdate`。
- **Java：** `game_state_change` 开始 / 停止下雨，以及服务器渐变期间的雨 / 雷暴等级变化。
- **Bedrock：** `level_event` start_rain / stop_rain / start_thunder / stop_thunder，携带*目标*等级 × 65535；由客户端在本地渐变。
  加入时，`start_game.rain_level` / `lightning_level` 携带当前（渐变中的）等级，之后不再有 level_event。
- **bedboo：** `isRaining` / `rain` 与上游完全一致（过零判断，每次变化一个事件）；`rainState` / `thunderState` 是 level event 的
  目标等级（BDS 上为 0 或 1），加入时取 start_game 的等级；每个 level event 触发一次 `weatherUpdate`。

## 游戏规则  {#game-rules}

- **影响：** `bot.bedrock.gameRules`（一项 [Bedrock 扩展](../api.md#bedrock-extras)）、`bot.game.enableRespawnScreen`。
- **Java：** 客户端没有游戏规则状态（只有通过 game event 传递的 reducedDebugInfo / 立即重生）。
- **Bedrock：** 所有游戏规则都通过 `start_game.gamerules` 和 `game_rules_changed` 发送。
- **bedboo：** `bot.bedrock.gameRules`（`{ [Bedrock name]: boolean | number }`，例如 `doDayLightCycle`、`keepInventory`）；
  `bot.game.enableRespawnScreen` 在加入时取自 `doImmediateRespawn`，与上游的 login 字段一致。

## 告示牌  {#signs}

- **影响：** `bot.updateSign`、`signOpen`、`block.signText`。
- **Java：** `open_sign_entity`；`update_sign` 带四行文本；服务器回显 `tile_entity_data`。
- **Bedrock：** `open_sign { position, is_front }`，在玩家放置告示牌或与未涂蜡的告示牌交互时发送；每次打开只能编辑一次。编辑是一个
  携带完整告示牌复合标签的 `block_entity_data`：`FrontText` / `BackText` 复合标签，各含一个 `Text` 字符串（各行以 `\n` 连接）
  和样式字段。
- **bedboo：** `updateSign(block, text, back)` 保留上游的校验（4 行，45 个字符），发送该方块当前的告示牌复合标签并替换对应面的
  `Text`。prismarine-block 的 Bedrock 告示牌辅助函数已打补丁，改为读写 FrontText / BackText（`getSignText()` → `[front, back]`，
  与 Java 的双面告示牌一致；上游读取顶层 `Text` 并抛出异常）。

## 命令方块  {#command-block}

- **影响：** `bot.setCommandBlock`。
- **Java：** `update_command_block`（模式、标志）；服务器回应 `advMode.setCommand.success`。
- **Bedrock：** `command_block_update`，使用模式名（`impulse` / `repeat` / `chain`；模式即方块本身：
  `repeating_command_block`、`chain_command_block`）、`needs_redstone`、`conditional`、`should_track_output`。BDS 不发送消息：
  返回的是更新后的方块实体（`Command`、`auto`、`conditionalMode`、`TrackOutput`）。它会忽略超出玩家触及范围的命令方块的更新。
- **bedboo：** 签名、选项和检查都相同（通过 `bot.game.gameMode` 检查创造模式）；模式 0 / 1 / 2 → chain / repeat / impulse，
  `alwaysActive` → `!needs_redstone`。与上游一样接受非对象的 `options`（例如 `false`）。应等待方块实体更新而不是聊天消息，
  并把命令方块放在触及范围内。

## 爆炸伤害  {#explosion}

- **影响：** `bot.getExplosionDamages`。
- **Java：** 实体带有 `generic.armor` 属性；没有该属性时上游返回 `null`（而不是 rawDamages）。
- **Bedrock：** 线上没有护甲属性。
- **bedboo：** 内置的上游插件同时接受 Java 资源名（`minecraft:armor` 等）以及 bedboo 为实体合成的护甲属性
  （[装备](entities.md#equipment)）；没有任何护甲属性的生物实体（玩家 / 怪物）按无护甲计算，而不是返回 `null`。其余公式相同
  （Bedrock 的爆炸伤害遵循同一公式）。

## 方块动作  {#block-actions}

- **影响：** `noteHeard`、`pistonMove`、`chestLidMove`、`blockBreakProgressObserved`、`blockBreakProgressEnd`。
- **Java：** `block_action`（音符盒、活塞、带玩家数量的箱子）和 `block_break_animation`（阶段 0–9，带破坏者的实体 id）。
- **Bedrock：**
  - 音符盒：`block_event { type: instrument, data: pitch }`（Bedrock 乐器 id，例如 6 bell）；
  - 箱子：`block_event { type: change_state, data: open count }`，大箱子通过方块实体配对（`pairx` / `pairz`）；
  - 活塞不发送事件：它的 `PistonArm` 方块实体的 NewState 依次为 0 → 1 → 2 → 3 → 0；活塞的 `facing_direction` 为 0 下、1 上、
    2 南、3 北、4 东、5 西；
  - 破坏：`level_event` block_start_break / block_break_speed（每 tick 进度 × 65535）/ block_stop_break，不带破坏者和阶段，
    并且也会发给正在破坏的玩家本人。
- **bedboo：** `noteHeard(block, registry.instruments[type], pitch)`；`chestLidMove(block, count, block2)` 每次变化触发一次，
  block2 = 配对的另一半；`pistonMove(block, 0 | 1, Java face index)` 在推 / 拉开始时触发；破坏进度：开始时为阶段 0，之后根据速度
  算出的每个新阶段触发一次 `blockBreakProgressObserved`，停止或方块变化时触发 `blockBreakProgressEnd`；实体取 8 格内最近的其他
  玩家（没有时为 undefined）；机器人自己正在挖掘的位置（`bot.targetDigBlock`）会被跳过。

## pitch / yaw 为 0 时的射线检测（修复上游 bug）  {#ray-trace}

- **影响：** `bot.blockAtEntityCursor`、`bot.blockAtCursor`、`bot.blockInSight`、`bot.entityAtCursor`。
- **Java：** 当实体的 pitch 或 yaw 恰好为 0 时，mineflayer 4.39.0 返回 `null`（`!entity.pitch || !entity.yaw`）：水平视线，或
  朝北（默认朝向）时永远命中不了方块。
- **Bedrock：** 不是协议差异。
- **bedboo：** 内置插件只在缺少 pitch / yaw 时返回 `null`；其余不变。

## 在玩家体内设置的末地传送门可能把玩家推出去  {#end-portal-push}

- **影响：** 在机器人位置 `/setblock … end_portal` 以把它送到末地。
- **Java：** 末地传送门方块没有碰撞；位于其中的实体会被传送。
- **Bedrock：** `end_portal` 有一个 0.25 高的碰撞箱。在玩家体内设置方块（`/setblock`）会让 BDS 把玩家推出该方块；如果这次推动
  在同一批 tick 中先于传送门检测生效，玩家就站到传送门旁边，什么也不会发生（在高负载下在线追踪到：`command_output` 成功，随后
  `correct_player_move_prediction` 把玩家移开 0.8 格，30 s 内没有 `change_dimension`）。
- **bedboo：** 库中无需修改。要可靠地进入末地，把机器人脚下的方块替换为传送门，然后让机器人（已停止创造飞行）落到上面，就像
  玩家走进传送门一样。

## 末地传送门方块的碰撞  {#end-portal-shape}

- **影响：** 走进末地传送门。
- **Java：** 末地传送门方块没有碰撞箱；碰到即传送。
- **Bedrock：** 数据给 `end_portal` 一个 0.25 高的碰撞箱（[会被推出](#end-portal-push)）；玩家一碰到该方块，BDS 就会传送玩家。
- **bedboo：** 库中无需处理。要进入要塞中的传送门，从楼梯走上框架环，再朝环的中心走，直到维度切换。

## 长距离传送后的区块  {#chunk-after-teleport}

- **影响：** 传送后立即在机器人位置执行的命令（例如 `/setblock`）和方块变更。
- **Bedrock：** 传送到 16–128 格之外后，目标区块在服务器上可能尚未加载：此时在那里执行 `/setblock ~ ~ ~ portal` 会以
  `commands.setblock.outOfWorld` 失败，传送门不会出现。
- **bedboo：** 库中无需处理。在操作目标区块之前先等待 `bot.waitForChunksToLoad()`（服务器只会在加载区块后才发送它）。

## 用命令放置的箱子  {#chest-pairing}

- **影响：** 用 `/setblock` 组成的大箱子、用 `/replaceitem` 填充容器。
- **Bedrock：** 两个相邻且朝向相同的箱子，若沿垂直于其朝向的轴相邻，`/setblock` 会把它们合并成大箱子（默认朝北时沿 x
  轴合并）。容器槽位用 `/replaceitem block <x y z> slot.container <n> <item> <count>` 填充。
- **bedboo：** 库中无需处理；这样放置的箱子，其窗口与手动放置的箱子行为相同。
