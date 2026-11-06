# 名称、id 与数据

`bot.registry` 在 Bedrock 上包含什么：方块、物品和实体的名称与 id、方块状态 id、数据集、特性表，以及 Bedrock 数据中缺少的
内容。核对依据为 BDS 1.26.51.1（protocol 2193）、CloudburstMC/Data 的 `659ce1e2eee3a67045693f4fd5515c6ccf571953`（BDS 导出）
以及一台在线服务器；数据的构建方式见 `packages/bedrock-data/NOTICE.md`。

## `bot.registry` 中的 Bedrock 方块、物品名称与 id  {#registry}

- **影响：** `bot.registry` / `require('minecraft-data')('bedrock_1.26.51')`，以及所有接受方块或物品名称 / id 的 API
  （`bot.blockAt().name`、`bot.findBlocks({ matching })`、`bot.inventory.items()[i].name`、配方等）。
- **Java：** Java 的名称和 id（`grass_block`、`oak_door`、`zombified_piglin` 等）。
- **Bedrock：** Bedrock 标识符：1,477 个方块 / 22,091 个方块状态 / 2,076 个物品（minecraft-data PR #1335 的 1.26.51 数据，
  每个状态都对应到 BDS 的 runtime id，每个物品的名称和 id 都与 BDS `item_registry` 对应）。许多名称与 Java 相同，也有不同的
  （Java 的 `oak_door` 在 Bedrock 上方块和物品都叫 `wooden_door`，以及 `noteblock`、`unpowered_repeater`、实体
  `zombie_pigman`、`fishing_hook`、`fireworks_rocket` 等）。物品 id 是服务器的网络 id（方块物品的 id 可以为负）。
  还有 Bedrock 独有的物品 / 方块（例如 `element_*`、`hard_*_stained_glass`、`unknown`）。
- **bedboo：** `bot.registry` 使用 Bedrock 的名称和 id；物品按服务器的 `item_registry` 重新建立索引（原版 BDS 下保持不变）。
  硬编码 Java 名称的代码需要改用 Bedrock 名称。部分在 Java 上带 `lit` / `powered` 状态的方块在 Bedrock 上是两个方块：
  见[方块变体](world.md#block-variants)。

## 方块状态 id 与网络 runtime id  {#state-ids}

- **影响：** `Block.stateId`、`registry.blocksByStateId`、`bot.world.setBlockStateId`，以及所有解码 `update_block` /
  子区块或发送 `block_runtime_id` 的代码。
- **Java：** 网络上传输全局调色板 id，与 `block.stateId` 是同一组数字。
- **Bedrock：** 开启 `block_network_ids_are_hashes` 时（BDS 1.26.51 上始终开启），网络上传输的是方块状态 NBT 的 32 位 FNV-1a
  哈希（线上为有符号 int32，例如 stone = -2144268767）。
- **bedboo：** `block.stateId` 仍是 **`registry.blockStates` 中的顺序下标**，因此每个方块的状态与 Java 完全一样是连续的
  `minStateId..maxStateId` 区间（mineflayer 的 `bed.js`、prismarine-block 的 metadata / shapes 以及 mineflayer-pathfinder 的
  `Block.fromStateId(x.minStateId)` 都无需修改即可工作）。网络 runtime id 会被转换：
  `registry.blocksByRuntimeId[runtimeId] → { stateId, ...block }` 和 `registry.runtimeIdByStateId[stateId]`（都由
  `registry.handleStartGame(start_game)` 构建），Block 的 `block.hash` 是它的 runtime id。prismarine-chunk 在解码 / 编码子区块时
  自行完成转换。这有意不同于 prismarine-registry PR #57（该 PR 让 `stateId` 等于哈希，并且 `minStateId` 未定义，会让 pathfinder
  失效）。`minecraft:unknown` 是唯一一个 runtime id 不等于其哈希的状态：BDS 为它保留了 `0xFFFFFFFE`（-2）。每个
  `blockStates[i]` 都以 `hash` 携带自己的 runtime id（由生成器预先计算并校验），因此 `handleStartGame` 不必对 22k 个状态做哈希。

## 未知的方块 runtime id 解码为 `minecraft:unknown`  {#unknown-runtime-ids}

- **影响：** 服务器发送数据中不存在的方块状态时的区块解码（`bot.blockAt`、`bot.world`），例如来自
  `start_game.block_properties` 的自定义 / 附加包方块。
- **Java：** 不适用（registry codec 由服务器发送）。
- **Bedrock：** 自定义方块与原版方块一样做哈希；它们的状态不在 1.26.51 数据中。
- **bedboo：** 子区块解码器从不抛出异常：未知的 runtime id 会成为一个 `minecraft:unknown` 的调色板条目（BDS 自己的占位方块：
  实心完整方块，硬度 0，因此物理引擎视其为实心，寻路视其为可挖掘），并保留 `entry.runtimeId`，重新编码时写回原 id。在线检查中
  原版 BDS 从未产生过这种情况（默认主世界、下界、末地）。自定义方块暂未加入 registry。在
  `registry.handleStartGame(start_game)` 之前解码网络区块会抛出异常（没有 runtime id 映射），而不是悄悄生成占位方块。

## 来自 BDS 的碰撞箱与摩擦系数  {#collision}

- **影响：** `block.shapes`（物理、寻路、`bot.canSeeBlock`）、`registry.blocksByName[x].friction`。
- **Java：** Java 的碰撞箱；滑度硬编码在 prismarine-physics 中。
- **Bedrock：** BDS 导出数据与 minecraft-data PR #1335 有 708 个状态不同：门的厚度为 0.1875（3/16）（PR 中为 0.1825），
  放了末影之眼的 `end_portal_frame` 多一个眼睛的碰撞箱。各方块的摩擦系数：冰 / 浮冰 / 霜冰 0.98，blue_ice 0.989，
  slime 0.8，**honey_block 0.8**，其余均为 0.6（air 和 `unknown` 为 0.899999）。
- **bedboo：** 碰撞箱取自 PR #1335，仅有一份明确的白名单取自 Cloudburst `collisionShape`（`/_door$/`、
  `end_portal_frame`）；出现其他任何不一致时生成器会失败。每个方块都有一个 Bedrock `friction` 字段（schema 中新增；
  [物理引擎](movement.md#engine)会读取它）。门上下两半的形状见[门的上下半](world.md#door-halves)。

## 数据集  {#datasets}

- **影响：** `bot.registry.effects*`、`foods*`、`attributes*`、`enchantments*`、`entities*`、`biomes*`、`particles*`、
  `sounds*`，以及所有使用它们的地方（`bot.entity.effects`、auto-eat、prismarine-physics 的 `PlayerState`、`digTime`、
  `item.enchants`、`bot.entities[x].name`、粒子 / 声音事件）。
- **Java / Bedrock / bedboo：**
  - **effects：** 使用 Bedrock id（`mob_effect.effect_id`：Speed 1 … SlowFalling 27、BadOmen 28、HeroOfTheVillage 29
    （`village_hero`）、Darkness 30、TrialOmen 31、WindCharged 32、Weaving 33、Oozing 34、Infested 35、RaidOmen 36、
    BreathOfTheNautilus 37），并带有 minecraft-data 的 Java 风格 `name` / `displayName` / `type`，因此
    `effectsByName.JumpBoost` 等可以正常使用；`bedrockName` 是命令中的名字。Bedrock 独有：FatalPoison（25）。Java 独有
    （缺失）：Glowing、Luck、BadLuck、DolphinsGrace。id 已在 BDS 上用 `/effect` 验证。
  - **enchantments：** 使用 Bedrock id（minecraft-data bedrock 0..37 + wind_burst 38、density 39、breach 40、lunge 41，
    已用 `/enchant` 验证）；名称是 Java 的（`efficiency`、`binding_curse` 等）。Java 的 `sweeping_edge` 在 Bedrock 上不存在。
  - **attributes：** `resource` 是 Java 键（`bot.entity.attributes` 以它为键，prismarine-physics 读取
    `attributesByName.movementSpeed.resource`），`bedrockName` 是 `update_attributes` 中的名字：maxHealth ←
    `minecraft:health`（其 `max` 为最大生命值，`current` 为当前生命值），movementSpeed ← `minecraft:movement`（玩家默认 0.1），
    followRange、knockbackResistance、attackDamage、maxAbsorption ← `minecraft:absorption`、luck、jumpStrength ←
    `minecraft:horse.jump_strength`、spawnReinforcements ← `minecraft:zombie.spawn_reinforcements`。Bedrock 独有的条目
    （`resource` = Bedrock 名称）：underwaterMovement、lavaMovement、frictionModifier、bounciness、airDragModifier、
    playerHunger、playerSaturation、playerExhaustion、playerLevel、playerExperience。Java 独有的属性（armor、stepHeight、
    gravity 等）保留但没有 `bedrockName`；BDS 从不发送它们。本地玩家属性的上报方式见[自身元数据](entities.md#self-metadata)。
  - **foods：** 采用 minecraft-data 的 `foods` schema（Java 字段名），数据来自 BDS 物品组件 `minecraft:food`：
    `foodPoints` = nutrition，`saturation` = nutrition × modifier × 2，`saturationRatio` = modifier × 2，
    `effectiveQuality` = foodPoints + saturation；共 40 种食物，使用 Bedrock 物品 id。
  - **entities：** 137 个 BDS 标识符（Cloudburst `entity_identifiers.dat`）；`id` = `internalId` = Bedrock 的数字实体类型
    （player 257）。尺寸是 BDS 为召唤出的实体报告的包围盒（有几个与 Java 不同：zombie / skeleton 0.6×1.9、chicken 0.6×0.8
    等）；slime / magma cube 按尺寸 1 给出，shulker 为 1×1（BDS 对它报告的是默认 actor 包围盒）；教育版实体（agent、balloon、
    ice_bomb、tripod_camera）没有尺寸（0×0）。minecraft-data 中 Bedrock 独有的 `moving_block`、`item_frame`、
    `glow_item_frame`、`chalkboard` 被移除（它们在 BDS 上是方块 / 方块实体，不是实体标识符）。minecraft-data bedrock 1.21.80
    把 Java 独有的变体归到它们映射的标识符下（zombie：Zombie + Giant，llama：Llama + Trader Llama，arrow：Arrow +
    Spectral Arrow，evocation_illager：Evoker + Illusioner，另有 armor_stand 和 minecart 的占位行）；生成器取 Bedrock
    实体自己的那一行（`tables.ENTITY_DUPLICATES`；未列出的重复项会让生成失败），因此 `entitiesByName.zombie` 是 Zombie
    而不是 Giant。部分标识符沿用 minecraft-data 的占位显示名（即标识符本身：`npc`、`tnt`、`boat`、`egg`、`*_minecart` 等）。
  - **biomes：** 以区块生物群系调色板中携带的原版数字 id 为键（ocean 0、plains 1、river 7、hell 8、the_end 9、…
    soulsand_valley 178 … mangrove_swamp 191、cherry_grove 192、pale_garden 193、sulfur_caves 194、dappled_forest 195）：
    共 89 个生物群系，即 BDS 1.26.51 在 `biome_definition_list` 中发送的列表。minecraft-data 的 bedrock 1.21.60 列表
    （`bedrock_1.26.51` 原本继承的）按字母顺序编号（0 bamboo_jungle、1 bamboo_jungle_hills、plains 64），导致每个生物群系
    都解析错误（超平坦世界的 plains 变成了 bamboo_jungle_hills）。BDS 对所有原版生物群系发送 `biome_id` 65535（"vanilla
    id"），并按 id 顺序列出，因此客户端必须知道编号：id 取自 pmmp/BedrockData 的 `biome_id_map.json`（CC0），外加
    dappled_forest 195（1.26.50 新增），并对照 minecraft-data bedrock 1.20.0、BDS `biome_definition_list` 的顺序以及在线
    核对（每个用 `/locate biome` 找到的生物群系在区块中都是这个 id）。schema 与 minecraft-data 相同（`id`、`name`、
    `category`、`temperature`、`has_precipitation`、`dimension` overworld / nether / the_end、`displayName`、`color` =
    BDS 地图水体颜色，与 minecraft-data bedrock 1.21.60 一致，另加 `rainfall` 和 `depth`）；气候数值取自 BDS
    （CloudburstMC `stripped_biome_definitions.json`，与数据包一致）；category 和显示名取自 minecraft-data bedrock 1.20.0
    （Java 风格的分类），较新的生物群系来自一张表。自定义（数据驱动）生物群系不在 registry 中。`bot.blockAt(p).biome` 由
    prismarine-block 1.23.0 通过 `prismarine-biome(registry.version)` 构建，只填充 `id`（其 `name` 为 `''`，Java 上也一样）；
    `bot.registry.biomes[block.biome.id]` 才是完整的生物群系。
  - **particles：** Bedrock 粒子类型（`level_event` `0x4000 | id`，例如 bubble 1、heart 19）。
  - **sounds：** 与 `level_sound_event.sound_id` 中发送的一致的关卡声音事件标识符（1.26.40 起为字符串，例如
    `armor.equip_iron`）；`id` 是旧的数字 LevelSoundEvent id（13 个较新的事件分配了 ≥ 615 的 id）。
  - **沿用 minecraft-data：** language（1.21.70）、recipes（1.19.10，已被 `crafting_data` 取代：见[配方](crafting.md#recipes)）、
    windows、instruments、blocksB2J / J2B、protocol。

## 线上的物品（ItemV4）  {#items}

- **影响：** `Item.fromNotch` / `Item.toNotch`（prismarine-item），用于物品栏、创造模式、事务。
- **Java：** `{ itemCount, itemId, components }`；空槽位为 `present: false` / count 0。
- **Bedrock：** ItemV4 `{ network_id, count, metadata, has_stack_id, stack_id, block_runtime_id, extra }`；从 1.26.40 起，
  空槽位同样携带所有字段；方块物品携带它所放置的方块状态的 runtime id（BDS 会精确比较手持物品）。
- **bedboo：** `Item.toNotch(null)` 即 BDS 的空物品；物品保留服务器的 `stack_id`、`blockRuntimeId` 以及
  `can_place_on` / `can_destroy` 列表（`item.canPlaceOn` / `item.canDestroy`），因此 `toNotch(fromNotch(x))` 逐字节相同；
  新建的方块物品通过 `registry.items[id].blockStateId`（来自 BDS 创造模式数据，新增字段）→ runtime id。在
  `registry.handleStartGame` 之前，新建的方块物品得到 0。

## 物品标签不在线上传输  {#item-tags}

- **影响：** 使用标签作为原料的配方（木板、原木、木台阶、石质材料、煤炭、蛋、羊毛、粒等）。
- **Java：** minecraft-data 的配方已经展开；标签存在于数据中。
- **Bedrock：** `crafting_data` 中写的是标签名（`minecraft:planks`）；BDS 从不发送其成员（`item_registry` 只列出数据驱动物品
  的标签，不包括上述任何原版标签）。1.26.51 的合成配方共用到 11 个标签。
- **bedboo：** `lib/bedrock/item_tags.js` 为这 11 个标签收录了 pmmp/BedrockData 的 `item_tags.json`（BDS 1.26.30，CC0），
  并在 BDS 1.26.51.1 上逐个成员验证：把每个候选物品放入使用该标签的配方中合成（被接受 = 是成员，状态 35 = 不是）。1.26.51 新增：
  poplar 木材系列（木板、原木、木台阶）以及 `minecraft:mushrooms_for_stew`（棕色、红色和 shelf 蘑菇）。含有未知标签或物品的
  配方会被跳过（`bot._bedrock.recipes.skipped`；在 1.26.51 上为空）。见[配方](crafting.md#recipes)。

## Bedrock 数据中没有战利品表  {#loot}

- **影响：** `registry.blockLoot`、`registry.entityLoot`（`bedrock_1.26.51` 下为空）。
- **Java：** minecraft-data 有方块和实体的战利品表（掉落概率和数量）。
- **Bedrock：** 只有 `blocks[].drops`（物品 id 列表，没有数量和概率）。
- **bedboo：** 两张表都是空的；需要产量数据的代码必须自带。bedboo agent（`packages/agent/src/data/index.js`）保存了它需要的
  数据：红石矿石 ×4.5、青金石 ×6.5、铜 ×3.5、沙砾 → 燧石 10 %、树叶 → 树苗 / 木棍 / 苹果，以及它所猎杀的被动生物的掉落物。

## 特性表（`bot.supportFeature`）  {#feature-table}

- **影响：** `bot.supportFeature(name)`、`supportFeature` 导出项，以及所有按 Java 特性名分支的复用插件。
- **Java：** 取自 minecraft-data 中该机器人版本的 Java 特性列表。
- **Bedrock：** minecraft-data 的 Bedrock 列表不认识任何 Java 特性名。
- **bedboo：** 为以下来源用到的每个 Java 特性名给出明确的值：mineflayer 4.39.0 的 `lib/` 和 `examples/` 及其测试套件，
  pathfinder / pvp / collectblock / tool / armor-manager / auto-eat，以及 prismarine-* 模块；另外还包括 minecraft-data 的全部
  17 个 Bedrock 特性，取 minecraft-data 自己的 1.26.51 值（`packages/bedrock-data/features.js`）。未知名称返回 `false`，并在
  进程内发出一次警告（`BEDBOO_UNKNOWN_FEATURE`）；设置 `BEDBOO_STRICT_FEATURES=1` 时则抛出异常。规则：
  1. **游戏 / 数据事实 → 取 Bedrock 的实际情况：** `tallWorld`、`itemsAreNotBlocks`（而非 `itemsAreAlsoBlocks`）、
     `blockSchemeIsFlat`、`blockStateId`、`doesntHaveChestType`（Bedrock 的箱子没有 `type` 状态）、
     `doesntHaveOffHandSlot: false`、`shieldSlot`（46 槽的玩家窗口）、`hasElytraFlying`、`mobSpawner`（方块名为
     `mob_spawner`；mineflayer 的示例会查询它）、`village&pillageInventoryWindows: false`（见下文）、
     `noteBlockNameIsNoteBlock: false`（`noteblock`）、`multiSidedSigns`、`furnaceNbtUsesSnakeCase: false`、
     `creativeSleepNearMobs`、实体名称（`enderCrystalNameEndsInErNoCaps`、`fireworkNamePlural`、
     `fishingBobberCorrectlyNamed: false`）、prismarine-item 用到的物品 NBT 事实（`itemsWithComponents: false`、
     `booksUseStoredEnchantments: false`、`itemLoreIsAString: false` 等）。
  2. **命令（已在 BDS 1.26.51.1 上核对）：** `hasExecuteCommand`（`execute in overworld run teleport …` 可用）、
     `hasItemCommand: false`（没有 `/item`）、`replaceItemSlotIsPrefixed`（`/replaceitem … slot.container <n>`；槽位下标是
     单独的参数，因此使用 `slot.container.<n>` 的代码需要调整）、`hasDataCommand: false`、
     `gameRuleUsesResourceLocation: false`、`effectAreNotPrefixed`（Bedrock 写作 `/effect <target> hunger 1 255`：既不接受
     `effect give`，也不接受 `minecraft:` 前缀）、`playsoundUsesResourceLocation: false`、`setBlockUsesMetadataNumber: false`。
  3. **Java 数据包布局 → false**（`stateIdUsed`、`blockPlaceHas*`、`dimensionIsA*`、`dimensionDataInCodec`、`titleUses*`、
     `updatedParticlesPacket`、`useItemWith*`、`teleportUsesOwnPacket`、`hasEditBookPacket` 等）：这些插件已基于 Bedrock
     数据包重新实现，`false` 防止走进内置的 Java 分支。例外：`positionUpdateSentEveryTick: true`（`player_auth_input` 每 tick
     发送）。
  4. **API 形态：** `tabCompleteHasAToolTip: true`（mineflayer ≥ 1.13 的 `[{ match, tooltip }]`）、`lessCharsInChat: false`
     （按 256 字符分段）、`selectingTradeMovesItems: false`（Bedrock 没有 `select_trade`）、`fishingBiteDelayMaxTicks: 600`
     （Java 的窗口；经测量在 BDS 上同样成立，见[钓鱼](survival.md#fishing)）。
  5. **prismarine-windows：** `village&pillageInventoryWindows: false` 选择它的旧版窗口表（通过 `shieldSlot` 得到 46 槽的玩家
     物品栏）。若为 `true` 则会走 1.14+ 分支，其中的 `registry.version['>=']('1.20.3')` 对 Bedrock 版本会抛出 RangeError。
     Bedrock 容器不是 Java 协议窗口：bedboo 注册了每一种 Bedrock 容器类型（`bot._bedrock.windows`），并自行构建 46 槽、Java
     布局的玩家物品栏（[窗口类型](inventory.md#window-types)）。`netherUpdateInventoryWindows` 只在那个 1.14+ 分支中读取
     （对 Bedrock 无影响）。

## 在 Bedrock registry 上比较 Java 版本  {#version-comparisons}

- **影响：** 使用 Java 版本号调用 `bot.registry.isNewerOrEqualTo` / `isOlderThan` / `version['>=']` 等（mineflayer 的
  `examples/inventory.js`、@nxg-org/mineflayer-util-plugin）。
- **Java：** Java 版本之间的比较。
- **Bedrock：** 对 Bedrock 版本对象，minecraft-data 只认识 Bedrock 版本，传入 `'1.9'` / `'1.16'` 会抛出 RangeError：util 插件
  （进而 mineflayer-auto-eat）连加载都无法完成。
- **bedboo：** `@bedboo/bedrock-data` 的 `install()` 放宽了缓存的 `bedrock_1.26.51` 版本对象的比较函数：minecraft-data 不认识的
  版本按数字（major.minor.patch）与 1.26.51 比较，因此比所有 Java 1.x 新、比 Java 26.x 旧；Bedrock 版本之间的比较与之前完全相同；
  非数字的未知版本仍会抛出异常。依赖该异常的代码（prismarine-windows 的 1.14+ 分支）不受影响：守护它的[特性](#feature-table)
  仍为 false。
