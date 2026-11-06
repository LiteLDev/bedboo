# 实体与玩家

本页说明实体、玩家、玩家列表、战斗事件、骑乘以及与实体相关的事件在 Java 版与 Bedrock 版之间的差异，以及 bedboo 如何通过
mineflayer API 呈现它们。观察环境为 BDS 1.26.51.1（protocol 2193，bedrock-protocol 3.60.1），通过协议探测（两个机器人、
`/summon`、`/querytarget`、`/ride`、`/damage`、`/kill`、`setblock … destroy`）得出。

## 协议中的实体位置  {#positions}

- **影响：** 除机器人自身外所有实体的 `entity.position`、`entitySpawn`、`entityMoved`。
- **Java：** 生成 / 移动 / 传送数据包携带脚部位置（或其增量）。
- **Bedrock（实测）：**
  - `add_player` 是**脚部**高度（站在 y = -59 上的玩家：`add_player.position.y = -59`，`/querytarget` 眼睛 -57.38），
    但其他玩家的 `move_player` 是**眼睛**高度（脚部 + 1.62，潜行时也一样）；
  - `add_entity`、`add_item_entity`、`move_entity` 和 `move_entity_delta` 是脚部高度加上按类型的偏移：物品 0.125，
    点燃的 TNT 和下落的方块 0.49，船和运输船 0.375，矿车（所有种类）0.35，所有生物、盔甲架、经验球、箭、末地水晶 0；
  - `move_entity_delta`（1.26.40+）携带**绝对**坐标，每个坐标都可选（缺省 = 不变），旋转为字节（×360/256：`rot_x`
    俯仰、`rot_y` 偏航、`rot_z` 头部偏航；对盔甲架执行 `/tp … 90 30` → `rot_x` 21，`rot_y` 64）；
  - `move_entity.rotation` 已经是角度，协议顺序相同（俯仰、偏航、头部偏航——PocketMine / gophertunnel / dragonfly），
    尽管 bedrock-protocol 将这三个字节标为 `yaw`、`pitch`、`head_yaw`；在所有探测中 BDS 1.26.51.1 自身只发送了
    `move_entity_delta`（被传送的生物、盔甲架、矿车、船、箭）；
  - Bedrock 客户端在稀疏的更新（`set_entity_motion`）之间自行模拟物品，因此物品最后上报的位置可能与其静止位置相差零点几格。
- **bedboo：** `entity.position` 始终是脚部位置：每个数据包都会去掉按类型的偏移（`lib/plugins/entities.js` 中的
  `POSITION_OFFSETS`）和玩家眼高。Yaw / pitch / `headYaw` 为弧度（mineflayer 的 notchian 转换）；`move_entity` 中标为
  `yaw` 的字节被读作俯仰，`pitch` 被读作偏航。

## 实体 id  {#entity-ids}

- **影响：** `entity.id`、`bot.entities` 的键、所有实体事件。
- **Java：** 每个实体一个 int 实体 id；针对未知 id 的数据包会即时创建实体（`fetchEntity`）。
- **Bedrock：** 运行时 id（varint64，大多数数据包）和唯一 id（zigzag64；`remove_entity`、`set_entity_link`、
  `player_list`、`update_player_game_type`；`add_player.unique_id` 是 li64，protodef 将其读为 `[high, low]`）。
- **bedboo：** `entity.id = Number(runtime id)`；`entity.runtimeId` / `entity.uniqueId` 为 BigInt，二者的对应关系记录在
  `bot._bedrock.ids` 中。针对从未添加过的运行时 id 的数据包会被忽略，而不是在 (0, 0, 0) 创建空实体。维度切换后所有其他
  实体都会被丢弃（每个触发 `entityGone`），与 Java 客户端丢弃旧世界一致。

## 实体名称、类型与元数据  {#metadata}

- **影响：** `entity.name`、`displayName`、`type`、`kind`、`entityType`、`entity.metadata`、`entity.uuid`、
  `entity.getCustomName()`。
- **Java：** 注册表名称/id，元数据按数字索引，每个实体都有 UUID。
- **Bedrock：** 标识符如 `minecraft:villager_v2`、`minecraft:xp_orb`；元数据键是名称（`flags`、`nametag`、`variant`
  等）；协议中只有玩家有 UUID。
- **bedboo：**
  - name / displayName / type / kind / entityType / width / height 来自 `registry.entitiesByName`（Bedrock 名称，来自
    [Bedrock 数据](data.md#registry)；类型 `hostile`、`animal`、`passive`、`ambient`、`mob`、`living`、`projectile`、
    `other`、`player` 与新版 Java 一致；未知标识符 → 类型 `other`，name/displayName 为 `unknown`，`entityType` = 该标识符）；
  - `entity.metadata[<Bedrock key>]`（元数据数组上的命名属性，按数据包合并）；
  - 只有玩家会设置 `entity.uuid`；
  - `getCustomName()` 读取 `nametag` 键（'' = 无）——这是对 prismarine-entity 的补丁；
  - 狐狸等 Bedrock 生物与玩家使用同一个潜行标志：它们也会触发 `entityCrouch` / `entityUncrouch`，但只有玩家会使用潜行
    碰撞箱（高 1.5，眼睛在 1.27）；
  - 额外字段：`entity.health`（生物的当前生命值，来自 `minecraft:health`）、经验球的 `entity.count`
    （`experience_value`）、`entity.sleeping`。

## 机器人自身的元数据、属性与效果  {#self-metadata}

- **影响：** `bot.entity.metadata`、`bot.entity.attributes`、`bot.entity.effects`、`entityUpdate`、
  `entityAttributes`、`entityEffect` / `entityEffectEnd`、`entityCrouch` / `entityUncrouch`、`entityElytraFlew`、
  `entitySleep` / `entityWake`。
- **Java：** 元数据按数字索引；属性值为基础值 + 修饰符。
- **Bedrock：** 元数据键是名称（`flags`、`flags_extended`、`air`、`nametag` 等）；`update_attributes` 发送**当前**值
  （已应用修饰符）以及 min/max/default；效果使用 Bedrock id。
- **bedboo：**
  - `bot.entity.metadata[<name>]`（prismarine-entity 元数据数组上的命名属性）；标志驱动 `crouching`、`sprinting`、
    `swimming`、`onFire`、`elytraFlying` 以及睡眠事件；
  - 属性以 Java 资源名为键（来自 Bedrock 数据），`value` 是由 `current` 和修饰符反推出的基础值（`minecraft:health` →
    `minecraft:max_health` = 其最大值），另有 `current`、`min`、`max`、`default`；Bedrock 独有的属性保留 Bedrock 名称；
  - 效果：`bot.entity.effects[<Bedrock id>] = { id, amplifier, duration }`；
  - `set_health` 设置 `bot.entity.health`。

## 机器人自身的玩家记录  {#self-player}

- **影响：** `bot.player`、`bot.players[bot.username]`。
- **Java：** 来自 player_info（皮肤纹理、延迟、游戏模式）。
- **Bedrock：** `player_list`（在 start_game 之前），带原始皮肤图像，没有延迟。
- **bedboo：** `{ username, uuid, displayName, gamemode, ping: 0, entity, skinData: undefined }`。其他玩家见
  [玩家列表](#player-list)。

## 玩家列表  {#player-list}

- **影响：** `bot.players`、`bot.player`、`bot.uuidToUsername`、`playerJoined`、`playerUpdated`、`playerLeft`、
  `player.ping`、`player.gamemode`。
- **Java：** player_info 的 add / update_game_mode / update_latency / update_display_name / remove。
- **Bedrock：** `player_list` 只有 add / remove——已在线的玩家在 `start_game` **之前**到达，数据包的最后一条记录可能被
  截断（`maybeIncompleteArray`）；没有延迟；游戏模式变化以 `update_player_game_type { gamemode, player_unique_id }`
  到达（BDS 发给每个玩家）；重新发送的记录（机器人自身加入后的完整列表）视为更新。
- **bedboo：**
  - 在 `start_game` 之前收到的记录在其重置之后应用（上游在登录时重置列表），且在该次登录的 `login` 和 `game` 事件处理
    完之后（上游的顺序：player_info 跟在登录数据包之后，因此 `bot.game` 已设置）——每条都触发 `playerJoined`，包括机器人
    自己；
  - 被截断的记录被忽略；`ping` 为 0；
  - `gamemode` 从世界默认值开始（机器人：其 start_game 模式），并跟随 `update_player_game_type`（`playerUpdated`）；
    `playerUpdated` 从不因延迟 / 显示名而触发。

## 显示名  {#display-name}

- **影响：** `player.displayName`。
- **Java：** player_info 携带可选的显示名（队伍前缀、`update_display_name`）。
- **Bedrock：** `player_list` 没有显示名；名称标签属于实体元数据。
- **bedboo：** `player.displayName` 始终是用户名（一个 `ChatMessage`，与上游默认值相同）。

## 皮肤  {#skin-data}

- **影响：** `player.skinData`。
- **Java：** `textures` 属性（base64 JSON 或 mojangson）→ `{ url, model, capeUrl }`。
- **Bedrock：** `player_list` 携带原始皮肤图像（RGBA 缓冲区、几何 JSON），没有纹理 URL。
- **bedboo：** 所有玩家的 `skinData` 都是 `undefined`；格式错误或被截断的皮肤记录不会抛出异常。

## 受伤与死亡  {#hurt-death}

- **影响：** `entityHurt`、`entityDead`。
- **Java：** 每次伤害都有 `damage_event`（1.20+；带来源实体），死亡为 `entity_status 3`。
- **Bedrock：** 非致命伤害为 `entity_event hurt_animation`（data = 伤害原因，没有来源实体）；致命一击（以及 `/kill`）
  只发送 `death_animation`。
- **bedboo：** `hurt_animation` → `entityHurt(entity)`（没有 `source` 参数：Bedrock 不告知是谁造成的伤害；见
  [谁打了谁](#hurt-source)）；`death_animation` → 为致命一击触发 `entityHurt(entity)`（除非同一数据包批次，即同一服务器
  tick 中已有对应的 hurt_animation——批次在 bedrock-protocol 的批次入口处计数，而不是按事件循环轮次，因此连续读取的批次
  仍会分开），然后 `entityDead(entity)`，与 Java 的 damage_event + status 顺序一致。本地玩家同样会收到这两个事件。

## 谁打了谁：`entityHurt` 没有来源  {#hurt-source}

- **影响：** 需要知道是否是自己的攻击杀死了生物的战斗代码（例如 `@bedboo/agent` 的战斗库）。
- **Java：** `damage_event` 携带来源实体（新版 mineflayer 中为 `entityHurt(entity, source)`）。
- **Bedrock：** `entity_event hurt_animation` / `death_animation` 不携带攻击者（见[受伤与死亡](#hurt-death)）。
- **bedboo：** 事件不变。`@bedboo/agent` 的战斗库在以下情况下把击杀归于机器人：目标的 `entityDead` 发生在机器人自身某次
  `attack()` 之后 1.5 s 内（其箭矢则为 3 s 内），之前至少有一次 `entityHurt`，且周围没有其他伤害来源。

## Bedrock 上的战斗  {#combat}

- **影响：** `bot.attack`、`bot.activateItem` / `deactivateItem`（弓、盾牌）、mineflayer-pvp 式的战斗。
- **Java：** 自 1.9 起攻击冷却会按比例降低快速攻击的伤害；举盾是一次物品使用。
- **Bedrock：** 没有攻击冷却（每次攻击都是满伤害），但受伤的生物在 10 tick 内忽略伤害；玩家潜行时盾牌格挡；箭永远伤不到
  末影人（它们会传送走）；`/summon slime … minecraft:spawn_large` 只设置碰撞箱——分裂数量取决于体型变种（1、2 或 4）。
- **bedboo：** API 不变（手持盾牌时 `activateItem` 会潜行：见[物品使用](inventory.md#item-use)和
  [物品使用减速](movement.md#item-use-slowdown)）。`@bedboo/agent` 的战斗库每 10 tick 攻击一次，且从不射击末影人。

## 实体事件  {#entity-events}

- **影响：** `entityTaming`、`entityTamed`、`entityShakingOffWater`、`entityEatingGrass`、`entityEat`、
  `entitySwingArm`、`entityWake`、`entityCriticalEffect`、`entityMagicCriticalEffect`。
- **Java：** `entity_status` 6/7/8/10 以及 `animation` 0/2/3/4/5。
- **Bedrock：** `entity_event` 的 `tame_fail` / `tame_success` / `shake_wet` / `eat_grass_animation` / `eating_item` /
  `arm_swing`（生物攻击），以及 `animate` 的 `swing_arm` / `wake_up` / `critical_hit` / `magic_critical_hit`。
- **bedboo：** 一一对应。`entityEat` 来自 `eating_item`，BDS 在动物进食时发送（喂骨头的狼）——上游的 `entityEat`
  （animation 3）在新版 Java 上同样从不触发。与 Java 一样，机器人自身的挥手不会回显为 `entitySwingArm`。`entityWake`
  每次醒来只触发一次（元数据或动画）。

## 交换主副手  {#hand-swap}

- **影响：** `entityHandSwap`。
- **Java：** 玩家交换主手和副手时为 `entity_status 55`。
- **Bedrock：** 没有这样的事件；交换表现为 `mob_equipment` 的变化。
- **bedboo：** `entityHandSwap` 从不触发；`entityEquip` 报告新的装备。

## 睡觉的玩家  {#sleep}

- **影响：** `entitySleep`、`entityWake`、`entity.sleeping`。
- **Java：** 元数据 pose = sleeping；醒来时 animation 2。
- **Bedrock（实测）：** 睡觉的玩家具有 `player_flags` 第 1 位（值 2）和 `player_bed_position`；对玩家而言，
  `flags_extended` 的 "sleeping" 位（bedrock-protocol 的命名）保持清零。其他实体：`flags_extended`。
- **bedboo：** 对玩家依据 `player_flags` 的变化、对其他实体依据 `flags_extended`.sleeping 的变化触发 `entitySleep` /
  `entityWake`（不含该键的更新不改变任何东西）。机器人自身在见到一次 `player_flags` 后也会跟随它
  （`lib/bedrock/entity_data.js`）。

## 挥动手臂  {#swing-arm}

- **影响：** `bot.swingArm(arm, showHand)`。
- **Java：** 带手（主手 / 副手）的 `arm_animation`，1.8 上不带手。
- **Bedrock：** 只有一个 `animate swing_arm`（没有副手挥动动画，也没有隐藏挥动）；1.21.130+ 增加了可选的挥动来源。
- **bedboo：** `swingArm()` 对两只手都发送 `animate swing_arm`；接受 `arm` / `showHand` 但忽略它们。`attack` 与原版
  客户端一样以来源 `attack` 挥手。

## 攻击与使用实体  {#interact}

- **影响：** `bot.attack`、`bot.useOn`、`bot.mount`、`bot.dismount`。
- **Java：** `use_entity`（攻击 / 交互）或 1.21.2+ 的 `attack` 数据包；用跳跃输入下坐骑。
- **Bedrock：** `inventory_transaction item_use_on_entity`（攻击 / 交互），携带确切的手持物品和玩家位置；原版客户端会先
  悬停实体（`interact mouse_over_entity`）；下坐骑是 `interact leave_vehicle`。
- **bedboo：**
  - 与上游一样不改变机器人的视角（无论玩家朝向哪里，BDS 都接受攻击和交互，已实测验证：攻击机器人身后的僵尸、骑上身后的船）；
  - 目标变化时机器人先悬停目标，然后发送交易（`click_pos` 相对于目标脚部；手持物品来自
    `bot._bedrock.heldNetworkItem()`）；`attack` 先挥手（原版顺序）；
  - 数据包经由 `bot._bedrock.physics.afterControlsSent` 发送：立即发送，或者——当潜行 / 疾跑变化尚未包含在已发送的
    player_auth_input 中时——紧跟在下一个输入之后（上游在 setControlState 中同步发送 entity_action；见
    [点击前的潜行 / 疾跑](movement.md#controls-before-clicks)）；
  - 同步 API 和返回值与上游相同。没有坐骑时 `dismount()` 与上游一样触发 `error`。

## 载具  {#vehicle-entities}

- **影响：** `bot.vehicle`、`entity.vehicle`、`entity.passengers`、`mount`、`dismount`、`entityAttach`、
  `entityDetach`、`bot.moveVehicle`。
- **Java：** `attach_entity` / `set_passengers`。
- **Bedrock：** `set_entity_link { ridden_entity_id, rider_entity_id (unique ids), type: 0 remove, 1 rider,
  2 passenger }`，对于生成时就在骑乘的实体，也出现在 `add_entity.links` / `add_player.links` 中。
- **bedboo：** 链接更新 `vehicle` / `passengers` 并触发 `entityAttach(passenger, vehicle)` /
  `entityDetach(passenger, vehicle)`；对机器人则为 `bot.vehicle` + `mount` / `dismount(vehicle)`。重复的链接被忽略。
  当机器人所乘的载具被移除时触发 `dismount(vehicle)`（上游把该处理器注册在协议客户端上，而那里从不触发 `entityGone`——
  bedboo 实现了其本意）。`moveVehicle` 通过每 tick 的输入（`bot._bedrock.input.setVehicle`）驾驶载具，属于物理插件：见
  [载具](movement.md#vehicles)和[骑乘控制](movement.md#riding-control)。

## 下船或下矿车  {#dismount}

- **影响：** `bot.dismount()`、`dismount` / `forcedMove` 事件、骑乘结束后的 `bot.entity.position`。
- **Java：** 服务器计算下坐骑位置（DismountHelper：载具周围的空位，否则在其顶部）并把骑乘者传送过去。
- **Bedrock：** 骑乘者离开船或矿车时 BDS 不发送传送（马的骑乘者可能收到一次校正）。骑乘者坐在载具的座位上
  （`rider_seat_position`，在载具协议位置上方 1.02，眼睛高度），这使得在铁轨上的矿车下方其脚部陷入方块 0.1，在陆地上的
  船下方陷入地面 0.225。BDS 自己会把它那份骑乘者直接向上抬出该方块（实测：客户端上报其他位置时，会被校正到座位 x/z、
  方块顶部）。
- **bedboo：** 与 BDS 一致：在 `dismount` 时把骑乘者从座位向上抬，直到其碰撞箱不受阻挡（座位本就空闲时——水上的船——保持
  不动）；该移动像传送一样触发（`forcedMove`），并随下一个输入发出，因此服务器的位置与机器人一致，机器人可以走开（不会被
  埋在下方一格）。

## 多次骑乘之间的座位  {#rider-seat}

- **影响：** 骑乘时的 `bot.entity.position`。
- **Java：** 客户端自己不移动乘客（mineflayer 将位置保持在上坐骑的位置）。
- **Bedrock：** 骑乘者的位置就是其载具的座位。BDS 只在 `rider_seat_position`（actor data）变化时发送它：加入时的 actor
  data 为 (0, 0, 0)，第一次乘船或矿车时设为 (0, 1.02, 0)，之后的船和矿车不再发送。
- **bedboo：** 在多次骑乘之间保留上一次的座位（船 → 矿车 → 船：骑乘者每次都跟随其载具）；仍未知的座位退回到船 / 矿车的
  座位或载具顶部。

## 骑乘者的位置  {#rider-position}

- **影响：** `bot.vehicle` 已设置时的 `bot.entity.position` 和 `move`，`bot.dismount()` 之后的位置。
- **Java：** 客户端模拟载具，骑乘者坐在上面。
- **Bedrock：** BDS 根据骑乘者的输入模拟载具，并把骑乘者保持在载具的座位上：载具位置 + `rider_seat_position` actor data
  （在 BDS 1.26.51.1 上实测：船的座位 (0, 1.02, 0) 在船的协议位置之上 = 脚部比船的脚部低 0.225；马 (0, 2.32, −0.2) =
  脚部高 0.7、靠后 0.2）。它每 6 tick 发送一次载具校正，下船时并不总是传送骑乘者（保留其上报的位置）。
- **bedboo：** 骑乘时每个 `player_auth_input` 都上报该座位（载具的最新位置来自 move_entity 或载具校正，座位按载具的偏航
  旋转），`bot.entity.position` 跟随它（载具移动时触发 `move`）；不预测载具物理。沿 x / z 的座位偏移按载具上报的偏航旋转：
  实测的单人座位没有这种偏移；双人船的座位未经验证。骑乘者保持在座位上，并在船 / 马旁边下来。

## 装备与护甲属性  {#equipment}

- **影响：** `entity.equipment`、`entity.heldItem`、`entityEquip`、`bot.getExplosionDamages(entity, …)`。
- **Java：** `entity_equipment` 槽位 0 主手、1 副手、2 脚 … 5 头、6 身体；护甲 / 护甲韧性是同步的属性。
- **Bedrock：** `mob_equipment`（窗口 `inventory` = 主手，`offhand`）和 `mob_armor_equipment { helmet, chestplate,
  leggings, boots, body }`；不发送护甲属性。
- **bedboo：** 装备索引与上游相同（0 手、1 副手、2 靴子、3 护腿、4 胸甲、5 头盔、6 身体）。生物、玩家和机器人会获得实时的
  `generic.armor` / `generic.armorToughness`（上游爆炸插件读取的属性）以及 `minecraft:armor` /
  `minecraft:armor_toughness` 属性，由所穿戴的物品计算得出（每件物品的护甲值和韧性取自 minecraft.wiki；与上游一样不计
  附魔）。非生物实体没有这些属性（对它们 `getExplosionDamages` 返回 null，与上游一致）。

## 掉落物  {#dropped-items}

- **影响：** `entity.getDroppedItem()`、`itemDrop`、`playerCollect`。
- **Java：** 物品堆是物品实体的一个元数据条目；`itemDrop` 在该元数据上触发；`collect` 数据包。
- **Bedrock：** `add_item_entity` 携带物品（ItemV4）；`take_item_entity { runtime_entity_id: the item, target: the
  collector }`，然后 `remove_entity`。相邻的物品堆会合并：在保留的物品上发送 `entity_event item_entity_merge { data:
  the new stack size }`，然后对被吸收的物品发送 `remove_entity`（没有元数据更新）。
- **bedboo：** 协议中的物品保存为 `entity.metadata.item`；prismarine-entity 补丁让 `getDroppedItem()` 在 Bedrock 上读取
  它（prismarine-item `fromNotch`）；`itemDrop` 紧随物品的 `entitySpawn` 触发；合并会设置新数量并触发 `entityUpdate` +
  `itemDrop`，与 Java 的物品堆元数据更新一致；`playerCollect(collector, collected)` 触发时物品仍可读取。

## 画  {#paintings}

- **影响：** `bot.blockAt(pos, true).painting`、mineflayer 的 `Painting`。
- **Java：** `spawn_entity_painting`（≤ 1.18；标题 / 图案 id、方块位置、方向）——1.19+ 的画是普通实体。
- **Bedrock：** `add_painting { coordinates (the painting's center), direction 0-3, title }`（标题 `Kebab`、
  `SkullAndRoses` 等）。
- **bedboo：** 两者兼有：`bot.entities` 中的 `painting` 实体（`entitySpawn` / `entityGone`），以及注册在世界中的
  `Painting(id, floored center, name, direction vector)`；`name` 是新版 Java 的变种名（`kebab`、`skull_and_roses` 等），
  方向向量使用上游的表。

## 烟花助推  {#fireworks}

- **影响：** `usedFirework`、`bot.fireworkRocketDuration`。
- **Java：** 火箭的 `attached_to_target` 元数据指出被助推的玩家。
- **Bedrock：** 助推中的火箭是 `add_entity minecraft:fireworks_rocket`，`owner_eid` 为 -1，并在元数据键 18 中给出被助推
  玩家的 unique id（bedrock-protocol 命名为 `minecart_has_display`，对火箭而言是 long）；其物品 NBT 是展示物品（元数据
  键 16，`Fireworks.Flight`）。
- **bedboo：** 机器人滑翔时，附着于机器人（键 18）、由机器人拥有或射出的 `fireworks_rocket` 计为一次助推：每枚火箭触发一次
  `usedFirework(rocketId)`，并按上游公式根据物品的 `Flight` 计算持续时间。助推在物理方面的处理见[鞘翅](movement.md#elytra)。
