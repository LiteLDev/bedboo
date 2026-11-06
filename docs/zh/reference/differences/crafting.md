# 合成与工作站

本页说明配方、`bot.craft` 以及工作站 API（`bot.openFurnace`、`bot.openEnchantmentTable`、`bot.openAnvil`、
`bot.openVillager`、`bot.trade`）在 Bedrock 上如何工作。工作站 API 保留 mineflayer 的签名、窗口成员、事件和错误消息；
在底层，每个合成和工作站操作都是服务端权威的 item stack request（`lib/bedrock/stations.js`，参见
[clickWindow](inventory.md#click-window)）。观测环境为 BDS 1.26.51.1（协议 2193，bedrock-protocol 3.60.1）。

## 配方来自服务端的 crafting_data  {#recipes}

- **影响：** `bot.recipesFor`、`bot.recipesAll`、`bot.registry.recipes`、`require('prismarine-recipe')(bot.registry)`
- **Java：** mineflayer 通过 prismarine-recipe 的 `Recipe.find` 读取 minecraft-data 的 Java 配方（`registry.recipes[resultId]` =
  `{ result, inShape | ingredients, outShape? }`，标签已展开为每个物品一个配方）。
- **Bedrock：** minecraft-data 的 Bedrock `recipes` 结构不同（按索引组织，使用 Bedrock 名称），而且并不是服务端实际使用的配方。
  BDS 在加入时通过 `crafting_data` 发送配方（1.26.51：分类型的数组 `shaped_recipes`、`shapeless_recipes`、
  `shulker_box_recipes`、…）：每个配方带有 `recipe_id`、`network_id`（合成请求引用的就是它）、`block` 标签、`priority`、
  原料描述符（`name` + metadata，32767 = 任意；`item_tag`）以及一个或多个产物（network-id 物品）。
  - 所有合成网格配方——包括 2×2——都是 `block: 'crafting_table'`；是否适合 2×2 网格取决于其尺寸。
  - `deprecated` 配方是隐藏的旧版重复项（BDS 仍然接受）。
  - 熔炉、烟熏炉、高炉、营火、切石机、制图台、锻造台和药水配方都不是合成网格配方；`multi_recipes`（地图复制、烟花、旗帜 / 书的复制、…）
    没有固定的输入或输出。
  - 标签原料只给出标签名；参见[物品标签](data.md#item-tags)。
- **bedboo：** `lib/bedrock/recipes.js` 把 `crafting_table` 的有序 / 无序 / 潜影盒配方转换为 prismarine-recipe 的 `Recipe`，
  字段相同（`result {id, count, metadata}`、`inShape`、`outShape`、`ingredients`、`delta`、`requiresTable`），另加 Bedrock
  的 `networkId`。
  - 标签原料按 minecraft-data Java 配方的方式展开：同一标签的所有格子使用同一个成员（13 个木棍配方，每种木板一个）；一个配方中的
    两个标签取笛卡尔积（13 种木板 × 13 种木台阶 = 169 个木桶配方）；结构相同的展开结果只保留一个（Bedrock `priority` 较低者优先：
    通用的 `minecraft:stick` 优先于 `stick_from_crimson_planks`；BDS 接受任一 id，其他 id 保留用于限制合成）。与 Java
    的展开配方一样，一个配方从不混用同一标签的不同成员（2 块橡木木板 + 2 块白桦木板不对应任何工作台配方，尽管 BDS 会接受这样的网格）
    ——这是上游的行为，予以保留。BDS 1.26.51 的 `crafting_data` 由 4128 个 Bedrock 配方得到 4874 个配方，没有跳过任何一个。
  - `bot.registry.recipes` 按 bot 替换为同样这些配方的 minecraft-data Java 结构（每次收到 `crafting_data` 时原地填充），因此
    `require('prismarine-recipe')(bot.registry).Recipe.find(id)` 的用法与 Java 相同。这些 Recipe 没有 `networkId`
    （prismarine-recipe 会丢弃未知字段），所以 `bot.craft` 按结果和原料把它们匹配到服务端配方（手动构造的 Recipe 也一样）。
    来自旧 `crafting_data` 的 Recipe 也以同样方式重新匹配。
  - `recipesFor` / `recipesAll` 是上游代码作用于这些配方，只有一处修正：`metadata` 参数按结果的 metadata 过滤（上游的
    `Recipe.find` 查找的是 `meta` 键，从不过滤）。这在 Bedrock 上很重要，例如床的颜色就是 `bed` 物品的 metadata（白色 0，红色 14）。
  - 开启游戏规则 `doLimitedCrafting` 时，只返回服务端已解锁的配方（`unlocked_recipes`）（只要某个网格的任一 Bedrock 配方已解锁，
    该网格即可用，并用那个配方合成）。
  - 下界合金装备是锻造台升级，不属于合成（并且没有对应的 mineflayer API）。

## 每批合成是一个 item stack request  {#craft-request}

- **影响：** `bot.craft`
- **Java：** mineflayer 把原料逐个点击放入网格（每次点击一个 `window_click`），从槽位 0 取出结果并收起，每次合成重复一遍。
- **Bedrock：** 没有点击数据包；服务端根据 `item_stack_request` 合成，并且只从合成网格中取料：直接从快捷栏消耗会被拒绝
  （`craft_recipe`：状态 35 "mismatched recipe for grid items"；`craft_recipe_auto`：状态 27）。2×2 网格是
  `crafting_input` ui 28-31，需要玩家物品栏界面（否则状态 7）；工作台的网格是 ui 32-40（按行优先；形状可以放在任意位置，
  也接受混用同一标签的不同成员）。已验证的请求结构（一个请求，任意次数的合成）：
  1. `place` × n（物品栏 → 网格格子），
  2. `craft_recipe { recipe_network_id, times_crafted }`（旧版 id 12），
  3. `results_deprecated { result_items: [{ type: 'name', legacy_type: 1, name, metadata, count (per craft),
     block_runtime_id, extra }], times_crafted }`（19），
  4. 对每个网格格子 `consume`（5）（count = 次数），
  5. 对每个结果，从 `creative_output` 50（stack id = 请求 id）`place`（1）到物品栏——或 `take` 到光标。

  每个请求的产物最多一组物品堆（16 个原木 → 一个请求得到 64 块木板；20 个原木 → 状态 14），每个结果都必须取走（否则状态 17），
  结果也可以从产物中直接丢出（`drop`）。批量合成即 `times_crafted` > 1。
- **bedboo：** `bot.craft(recipe, count, craftingTable)` 保留上游的检查、错误和窗口处理
  （`Recipe requires craftingTable, but one was not supplied: …`、`crafting: non craftingTable used as craftingTable`，
  错误以 `new Error(err)` 重新抛出，因此缺少原料时显示为 `Error: missing ingredient`；工作台窗口只打开一次，在结束或出错时关闭）。
  - 每个请求在物品栏、每格一组物品堆以及每种结果一组物品堆允许的范围内，尽可能多地完成 `count` 次合成（`count` = 25 次木棍 →
    16 和 9 两个请求）；若完成部分合成后原料用完，会像上游的下一次 `craftOnce` 一样抛出 `missing ingredient`。
  - 原料按上游 `findInventoryItem` 的顺序取用（先主物品栏，再快捷栏；每格一种物品堆）；结果放到上游 `putSelectedItemRange`
    会放的位置（先有空间的物品堆，再第一个空槽位，主物品栏优先）。
  - 请求经过物品栏模型（预测，被拒绝时回滚）；在网格中发现的物品会先被归还。
  - 在 2×2 网格中合成时若有容器窗口打开，或在工作台合成时有其他窗口打开，会先关闭它：2×2 网格只存在于玩家物品栏界面中（上游会点进
    打开的容器），并且另一个窗口打开时 BDS 会忽略容器激活（[切换窗口](inventory.md#window-switch)）。已在同一方块上打开的工作台窗口
    会被复用，并且像上游 `activateBlock` 本会在其位置打开的窗口一样，在结束时关闭。

## 多个结果：桶和瓶子进入物品栏  {#remainders}

- **影响：** 蛋糕、蜂蜜块以及蜂蜜瓶 → 糖 的 `bot.craft` / `recipe.delta` / `recipe.outShape`
- **Java：** 空桶 / 空瓶留在合成网格中（minecraft-data 旧的 `outShape`），mineflayer 在合成后把它们收起。
- **Bedrock：** 配方把它们列为额外产物（蛋糕：`output: [cake, bucket × 3]`）；客户端用 `create { result_slot_id: k }`
  （旧版 id 6）选择每一个，并像主结果一样从产物中取走（这是原版客户端的请求，已在 BDS 上确认：不发 `create` 时取走会以状态 49 失败）。
- **bedboo：** 额外产物被加入 `recipe.delta`（正数）；由于网格中没有剩余物品，`outShape` 保持 null。有多个结果时，`bot.craft`
  在取走每个结果之前发送 `create`。

## 放不下的结果先拿在光标上，再丢出  {#overflow}

- **影响：** 物品栏已满时的 `bot.craft`
- **Java：** 上游的 `putSelectedItemRange` 会丢出放不下的物品（`tossLeftover`）。
- **Bedrock：** 结果必须在合成请求本身中取走。
- **bedboo：** 放不下的部分在同一请求中取到光标上，随后 `returnCursor` 把它放回（Java 的规则，与[关闭窗口](inventory.md#close-window)
  相同）并丢出剩余部分——结果与上游相同（一个 `itemDrop`）。光标只能拿一组物品堆，因此结果溢出超过一组的批次会减少合成次数（剩余的放到下一个
  请求）；即便如此仍放不下结果的单次合成以 `destination full`（上游对已满范围的消息）失败。

## 服务端不提供熔炉配方  {#furnace-recipes}

- **影响：** 任何需要知道什么能熔炼成什么的代码
- **Java：** minecraft-data / 客户端的配方书包含熔炉配方。
- **Bedrock：** BDS 1.26.51 的 `crafting_data` 不含熔炉配方（参见[配方](#recipes)）；minecraft-data 的 Bedrock 配方并不是
  服务端使用的配方。
- **bedboo：** 库中没有熔炼数据。agent 包（`packages/agent`）内置了一份经过核对的熔炉表，来自 CloudburstMC/Data（Apache-2.0）的
  `recipes.json` @73bda57f9afa（1.21.40，最后一份包含熔炉配方的导出）：`packages/agent/src/data/smelting.json`，由
  `packages/agent/scripts/gen-smelting.js` 重新生成，并已对照 1.26.51 注册表检查。

## 熔炉属性来自 container_set_data  {#furnace}

- **影响：** `Furnace` 的 `.fuel`、`.progress`、`.totalFuel`、`.fuelSeconds`、`.totalProgress`、`.progressSeconds`，
  `Furnace` 的 `update` 事件，`bot.openFurnace`（熔炉、高炉、烟熏炉）
- **Java：** `craft_progress_bar`（窗口属性）携带属性 0（剩余燃料）、1（燃料燃烧时长）、2（烧炼进度）和 3（总烧炼时间）。
- **Bedrock：** `container_set_data { window_id, property, value }`。属性 0 是 tick 计数（进度），1 是燃烧剩余时间（剩余燃料），
  2 是燃烧时长（燃料燃烧时长）。3（储存的经验）和 4（燃料 aux）没有 Java 对应项。**没有总烧炼时间**：它是方块的常量，熔炉为
  200 tick，高炉或烟熏炉为 100 tick（高炉或烟熏炉烧一块煤也只有 800 tick，而不是 1600）。BDS 在该方块的 `container_open`
  **之前**发送其状态，之后在方块燃烧期间每 tick 发送一次。熔炼产物以该窗口的 `inventory_slot` 到达。Bedrock 既没有 `/data`
  也没有 `/blockdata`，因此无法用命令缩短烧炼时间。
- **bedboo：** Bedrock 属性映射到 Java 属性（0→2、1→0、2→1），并完全按上游的方式归一化。窗口打开时根据方块类型设置
  `totalProgress`。窗口打开之前到达的值在打开时应用。窗口的每个 `container_set_data` 都会触发 `update`，正如上游对每个窗口属性
  都触发它。

## 对刚放置的熔炉的点击偶尔会被拒绝  {#furnace-click}

- **影响：** 熔炉刚放置并打开后的 `Furnace.putInput` / `putFuel` / `takeOutput`
- **Java：** 没有这种拒绝。
- **Bedrock：** 大约每 10 次熔炼中有 1 次，对刚放置的熔炉的第一次转移以
  `Server rejected transaction for clicking on slot 1, on window with id N.` 失败（BDS 对该 item stack request 应答了错误）；
  几百毫秒后同样的转移成功。单独测试时无法复现（放置已久的熔炉不受影响）。
- **bedboo：** 库中未修复。请重试被拒绝的熔炉转移（agent 在 `packages/agent/src/skills/smelt.js` 中会在 600 ms 后重试两次，
  并重新计算仍缺少的物品）。

## 附魔：选项、种子和附魔请求  {#enchanting}

- **影响：** `EnchantmentTable` 的 `.enchantments`、`.xpseed`、`.enchant(choice)`，`EnchantmentTable` 的 `ready` 事件
- **Java：** 窗口属性 0–9 给出三个等级要求、附魔种子，以及每个选项一个*提示*附魔（id + 等级）。`enchant_item { windowId, enchantment }`
  执行附魔，服务端发送新物品。
- **Bedrock：** `player_enchant_options { options: [{ cost, slot_flags, equip_enchants, held_enchants, self_enchants,
  name, option_id }] }` 在附魔台的 `container_open` 之前发送（为空），并在物品槽每次变化后再次发送。`cost` 是等级要求。三个列表是该选项
  施加的**全部**附魔，而不只是一个提示。种子从不发送给客户端。附魔是一个 item stack request：
  `craft_recipe { recipe_network_id: zigzag32(option_id) }`，然后 `results_deprecated`，然后 `consume` choice + 1 个青金石
  （创造模式下不消耗），然后 `consume` 物品，最后把产物从 `creative_output` 50 `place` 回物品槽。BDS 应用自己的结果（错误的
  `results_deprecated` 会被忽略）并扣除 choice + 1 级。**应答中不携带物品。**
- **bedboo：** `enchantments[i] = { level: cost, expected: { enchant, level } }`，其中 `expected` 是该选项的第一个附魔
  （Bedrock id，与 `bot.registry.enchantments` 中一致）。`ready` 在与上游相同的状态转换时触发，`xpseed` 保持 −1。
  `enchant(choice)` 根据选项预测附魔后的物品：依次为 equip、held 和 self 附魔，`ench` NBT 与 BDS 相同（书会变成
  `enchanted_book`）。该预测已针对剑、镐、胸甲和书的选项 0–2 与服务端副本逐字节比对一致。服务端接受请求后，它以槽位 0 中的物品
  resolve。缺少青金石或等级时会以说明性错误 reject，而不是无限等待。

## 没有附魔的附魔选项  {#enchanting-empty-options}

- **影响：** `EnchantmentTable.enchant`、`enchantments[i].expected`
- **Java：** 每个提供的选项至少施加一个附魔。
- **Bedrock：** BDS 可能提供附魔列表全为空的选项（在没有书架的附魔台上附魔钓鱼竿或胡萝卜钓竿）；它照样扣除等级和青金石，物品保持不变。
- **bedboo：** 这样的选项为 `expected: { enchant: -1, level: -1 }`；`enchant()` 预测物品不变（不会生成空的 `ench` 列表），
  因此 bot 的副本与服务端一致。

## 铁砧：名称随请求发送，客户端预测结果  {#anvil}

- **影响：** `Anvil` 的 `.combine(itemOne, itemTwo[, name])`、`Anvil` 的 `.rename(item[, name])`、`bot.openAnvil`
- **Java：** 名称通过 `name_item`（或 `MC|ItemName`）输入，服务端在槽位 2 显示结果，`putAway(2)` 取走它。上游检查的花费来自
  prismarine-item 的 `Item.anvil`。
- **Bedrock：** 没有命名数据包。整个操作是一个 item stack request：
  `optional { recipe_network_id: 0, filtered_string_index: 0 (rename) | -1 }`，然后 `consume` 目标物品和牺牲物品，最后从
  `creative_output` 50 `place` 产物。新名称放在请求的 `custom_names` 中（cause `anvil_text`）。BDS 在槽位 2 中不显示任何东西，
  也从不回传结果。
  - Bedrock 的规则与 Java 不同：附魔的花费是倍率 × **它增加的等级**（锋利 IV + IV → V 花费 1，而不是 5），不兼容的附魔被免费丢弃，
    穿刺的倍率为 2/1，仅重命名会保留之前的累积惩罚（新重命名的物品 `RepairCost` 为 0），并且重命名也可能"过于昂贵"（Java 将其
    上限设为 39）。
  - 名称最多 30 个字符，自定义名称是普通字符串，而不是 JSON 文本组件。
  - prismarine-item 没有 Bedrock 铁砧（`Item.anvil` 为 undefined）。
- **bedboo：** `lib/bedrock/anvil.js`（改编自 prismarine-item 的 `anvil.js`）在检查（"Not anvil-able…"、"not enough xp"、
  输入顺序）和预测结果时应用 Bedrock 规则。该结果采用 BDS 的 NBT 布局：`RepairCost`、`display.Name`、`ench`、`Damage`。两者都已
  针对合并、合并 + 重命名、重命名、材料修复、整组重命名和附魔升级与服务端副本核对。
  - 结果按上游 `putAway(2)` 的方式放入物品栏：先放到有空间的相同物品堆，否则放到第一个空槽位。
  - 经验检查使用实际采用方向的花费（上游的 `smallest` 在某个方向不可行时总为 0，因此从不拒绝；而 BDS 会拒绝请求并把物品留在铁砧中）。
  - 与原版一样，没有任何效果的牺牲物品即使带名称也不产生结果；每次操作前会清空槽位中的残留物品（例如未用完的修复材料）。
  - 创造模式下 `rename` 不等待经验变化（上游在创造模式下也会等待，尽管永远等不到）。
  - 超过 30 个字符的名称以上游的 "Name is too long." 拒绝（上游上限：35）。

## 村民交易：update_trade 打开窗口，交易项为 NBT  {#trading}

- **影响：** `bot.openVillager`、`bot.trade`、`Villager` 的 `.trades`、`.selectedTrade`、
  `villager.trade(tradeIndex, [times])`、`Villager` 的 `.close()`、`Villager` 的 `ready` 事件
- **Java：** `open_window`（merchant）加上 `trade_list`（只含已解锁的交易项，带 `specialPrice`、`demand` 和 `priceMultiplier`）。
  `select_trade` 让服务端移动输入物品，`putAway(2)` 取走产物。打开器只接受 `villager` 实体。
- **Bedrock：** 与村民交互会发送 `update_trade { window_id, window_type: 'trading', trade_tier,
  villager_unique_id, offers: NBT { Recipes: [{ buyA, buyCountA, buyB, buyCountB, sell, uses, maxUses, tier, traderExp,
  demand, priceMultiplierA/B, netId }] } }`，并且**没有** `container_open`：正是这个数据包打开界面。
  - 交易项列出所有等级（包括未解锁的）。`buyA.Count` 是服务端实际收取的价格，已计入村庄英雄等折扣（已验证），`buyCountA` 是基础价格。
    `Damage` 为 32767 表示任意数据值。
  - 没有 `select_trade`。一次交易是一个 item stack request：`craft_recipe { recipe_network_id: netId }`，然后从
    `trade2_ingredient1` / `trade2_ingredient2`（ui 槽位 4 / 5，已验证）`consume`，最后从 `creative_output` 50 `place` 产物。
    服务端计入使用次数（下一个 `update_trade` 中的 `uses`）。
  - 村民实体是 `villager_v2`；`wandering_trader` 打开同样的窗口。
- **bedboo：** 村民插件把 `update_trade` 作为 `trading` 容器交给物品栏插件（`minecraft:merchant`，参见
  [窗口类型](inventory.md#window-types)；在另一个窗口打开时或对正在关闭的窗口的刷新不会打开任何东西）。`trades` 列出已解锁的交易项
  （tier ≤ `trade_tier`），与 Java 一致。
  - 价格：`inputItem1.count` 是基础价格，`realPrice` 是服务端价格。`specialPrice` 是两者之差减去 Java 的 demand 项，因此上游的公式
    仍得到 `realPrice`。`xp` 是 `traderExp`。`Damage` 为 32767 的输入在计数和放入时匹配任意数据值。配方 network id 是不可枚举的
    `trade.bedrock.netId`。
  - `trade()` 保留上游的检查和消息，每次使用发送一个请求（`putRequirements` 像上游一样放入输入物品）。由于 Bedrock 没有
    `select_trade`，它会先清空存放其他物品的原料槽。产物根据交易项的 `sell` 物品预测（包括 NBT，例如附魔书），并像 `putAway(2)`
    一样放置。已用完的交易会以 "trade blocked" reject。
  - `openVillager` 接受 `villager_v2`、`villager` 和 `wandering_trader`。死亡交易者留在交易输入槽中的物品会随下一个交易窗口返还
    （[容器已不存在](inventory.md#container-gone)）。
