# 基岩版差异

bedboo 的行为与 mineflayer 一致。唯一的偏差是 Java 版与基岩版之间的固有差异：基岩版的协议、数据或游戏规则使之无法实现或表现不同
的地方。每一项都在本节的各主题页中逐条记录（mineflayer 在 Java 版上怎么做、基岩版改为怎么做、bedboo 怎么做）。所有事实均在
BDS 1.26.51.1（protocol 2193）上观察得出。

| 页面 | 涵盖内容 |
|---|---|
| [连接与版本](connection.md) | 版本、传输层、登录、生成、踢出、设置、维度 |
| [名称、id 与数据](data.md) | 基岩版注册表、方块状态、线上传输的物品、数据来源 |
| [世界与方块](world.md) | 含水、方块变体、时间、天气、游戏规则、告示牌、爆炸 |
| [玩家状态与生存](survival.md) | 重生、维度切换、经验、能力、床、钓鱼、书 |
| [聊天、命令与 HUD](chat.md) | 聊天、命令、标题、Boss 栏、计分板、声音、粒子、队伍 |
| [实体与玩家](entities.md) | 实体 ID、元数据、玩家列表、受伤与死亡、战斗、载具 |
| [移动与物理](movement.md) | 移动引擎、服务端纠正、视角、疾跑、飞行、鞘翅 |
| [物品栏与窗口](inventory.md) | 物品堆叠请求、窗口、重新同步、副手、创造模式物品栏 |
| [合成与工作站](crafting.md) | 配方、合成、熔炉、附魔、铁砧、交易 |
| [挖掘与放置](digging.md) | 服务端权威的方块破坏、挖掘速度、放置 |
| [生态插件补丁](plugins.md) | 每个插件补丁改了什么、为什么改 |
| [BeDD 模式](bedd.md) | `transport: 'bedd'`，由 Be.D.D. 托管的真实客户端 |

## 概要 {#in-short}

机器人作者可能会注意到的地方。未列出的一切都与 mineflayer 在 Java 版上的行为相同。

**连接与版本**
- 仅支持 BDS 1.26.51.x / 1.26.52.x（protocol 2193）：`bot.version` 为 `'1.26.51'`，`bot.protocolVersion` 为 2193
  （[版本](connection.md#versions)）。默认 RakNet，按需使用 NetherNet（[传输层](connection.md#transport)）。
- 登录之前没有 `connect`：它在发送登录数据包时触发（[客户端](connection.md#client)）；`kicked` 的原因是基岩版的断开消息或
  原因代码（[踢出原因](connection.md#kick-reason)）。
- `bot.game.serverBrand` 为 `'vanilla'`（[服务器品牌](connection.md#server-brand)）；`bot.game.maxPlayers` 为
  undefined（[最大玩家数](connection.md#max-players)）；`bot.settings` 中只有视距会传到服务器
  （[设置](connection.md#settings)）。

**名称、ID 与数据**
- `bot.registry` 是基岩版 1.26.51 的注册表：基岩版的方块、物品、实体、状态效果、生物群系和附魔的名称与 ID
  （`grass_block`、`oak_log`、`villager_v2`……）（[注册表](data.md#registry)）。配方来自服务器
  （[配方](crafting.md#recipes)）；物品标签来自 pmmp/BedrockData（[物品标签](data.md#item-tags)）。
- `block.stateId` 是 `registry.blockStates` 中的索引，而不是网络运行时 ID（在基岩版上是一个哈希值）
  （[状态 ID](data.md#state-ids)）。
- 实体：`entity.id` 是数字形式的运行时 ID，`entity.uniqueId` / `entity.runtimeId` 是 BigInt
  （[实体 ID](entities.md#entity-ids)）；`entity.metadata` 以基岩版元数据名称为键（`flags`、`variant`、
  `boundingbox_width`……）（[元数据](entities.md#metadata)）；玩家没有 `skinData`（[皮肤](entities.md#skin-data)）。

**世界**
- 含水方块：`blockAt()` 返回方块本身，水层放在 `block.superimposed` / `block.isWaterlogged` 中
  （[含水](world.md#waterlogging)）。
- 燃烧中的熔炉是一个独立的方块（`lit_furnace`）；`bot.bedrock.blockVariants()` 能同时找到两者
  （[方块变体](world.md#block-variants)）。
- `bot.time` 来自基岩版的世界时钟（[世界时间](world.md#world-time)）；游戏规则在 `bot.bedrock.gameRules` 中
  （[游戏规则](world.md#game-rules)）。

**聊天、命令、HUD**
- `bot.chat('/…')` 发送命令请求；其输出以 `message` 事件到达，每行一个（[命令](chat.md#commands)）。在 BDS 上玩家无法给自己
  `/op`（[op](chat.md#op-command)）。
- `bot.tabComplete` 在客户端根据服务器的命令列表补全（[Tab 补全](chat.md#tab-complete)）。
- 没有队伍（`bot.teams` 始终为 `{}`），也没有 Tab 列表的页眉/页脚（[没有队伍](chat.md#no-teams)、
  [没有页眉](chat.md#no-tablist-header)）；Boss 栏只为 Boss 存在（[Boss 栏](chat.md#boss-bars)）。

**移动**
- 移动是服务端权威的：机器人每 tick 发送一个 `player_auth_input`，由服务器纠正；纠正时会回退并重放此后的输入
  （[纠正](movement.md#corrections)）。`look()` 在下一次输入中生效，而不是逐渐转动（[视角](movement.md#look)）。
- 潜行/疾跑的变化随下一 tick 发送：紧跟在 `setControlState('sneak')` 之后的点击会等待它
  （[点击前的控制状态](movement.md#controls-before-clicks)）。只要按住 `forward`，疾跑就会持续
  （[粘滞疾跑](movement.md#sticky-sprint)）。

**实体与战斗**
- `entityHurt(entity)` 没有来源实体（[受伤与死亡](entities.md#hurt-death)、
  [伤害来源](entities.md#hurt-source)）；`entityHandSwap` 永远不会触发（[交换手中物品](entities.md#hand-swap)）。
- `bot.attack()` 不会让机器人转向（与上游相同）；基岩版没有攻击冷却，受伤的生物有 10 tick 的无敌时间
  （[战斗](entities.md#combat)）。

**物品栏与窗口**
- 物品栏是服务端权威的：`clickWindow` 以及基于它的一切（`equip`、`transfer`、`craft`……）都是物品堆叠请求，结果和错误与
  Java 版相同（[点击窗口](inventory.md#click-window)）。
- `bot.creative.setInventorySlot` 只能创建服务器创造模式物品目录中的物品，不能使用任意 NBT
  （[创造模式](inventory.md#creative)）。副手只能放副手物品（[副手](inventory.md#offhand)）。
- 使用盾牌就是潜行（`activateItem` 会举起盾牌）（[物品使用](inventory.md#item-use)）；窗口以 Java 版的窗口类型报告
  （[窗口类型](inventory.md#window-types)）。

**挖掘与放置**
- 方块破坏是服务端权威的：`dig()` 在服务器确认后完成；挖掘时间使用基岩版的状态效果系数（[协议](digging.md#protocol)、
  [挖掘速度](digging.md#dig-speed)）。在创造模式下，剑、三叉戟和重锤无法破坏方块（[创造模式武器](digging.md#creative-weapons)）。
- 不能从副手放置方块（[副手放置](digging.md#offhand-placing)）；对着可交互方块放置时会潜行
  （[潜行放置](digging.md#sneak-placing)）。

**工作站与生存**
- 熔炉、附魔台、铁砧和村民通过基岩版请求实现，使用 mineflayer 的窗口 API（[熔炉](crafting.md#furnace)、
  [附魔](crafting.md#enchanting)、[铁砧](crafting.md#anvil)、[交易](crafting.md#trading)）；钓鱼、书、床和骑乘与上游相同，
  只是使用基岩版数据包（[钓鱼](survival.md#fishing)、[书](survival.md#books)、[床](survival.md#beds)、
  [骑乘](movement.md#riding-control)）。
- 重生、维度切换和末地制作人员名单遵循基岩版的握手流程，并触发 mineflayer 的事件（[重生](survival.md#respawn)、
  [维度切换](survival.md#dimension-change)）；创造模式玩家不会死亡（[创造模式死亡](survival.md#creative-death)）。
