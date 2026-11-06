# 玩家状态与生存

死亡与重生、维度切换、经验、能力、出生点，以及床、钓鱼和书这几项生存交互。观察环境为 BDS 1.26.51.1（protocol 2193）与
bedrock-protocol 3.60.1。

## 重生握手  {#respawn}

- **影响：** `bot.respawn()`、`respawn` 选项、`isAlive`、`death` / `respawn` / `spawn` 事件。
- **Java：** 死亡 = `update_health` ≤ 0；`client_command`（执行重生）→ 服务器 `respawn` 包 → `update_health` → `spawn`。
- **Bedrock：** 死亡 = 玩家自己的 `entity_event death_animation` + `minecraft:health` 属性为 0（没有 `set_health` 0），随后在
  死亡位置收到 `respawn` state 0（搜索中）。重生是一个三步握手：客户端 `respawn` state 2（client_ready；若在服务器的 state 0
  之前发送，BDS 会忽略）→ 服务器 `respawn` state 0 + state 1（就绪，眼睛高度的出生位置）→ 客户端 `player_action respawn` →
  服务器 `entity_event respawn` + `set_health 20`。重生到另一维度时（在下界死亡、在主世界出生），客户端 state 2 与服务器
  state 1 之间会插入一个**不带 loading_screen_id** 的 `change_dimension`；若用 `serverbound_loading_screen` 回应它，客户端会被
  断开（`unexpected_packet`）。
- **bedboo：** API 和事件顺序与上游相同（`health` → `death`；`respawn` 在服务器的 state 1 时触发，对应 Java 的 respawn 包；
  服务器的生命值更新表明玩家存活后，由生命周期模块触发 `spawn`）。`bot.respawn()` 每次死亡只发送一次 state 2（必要时等待服务器的
  state 0）；`respawn: false` 选项让机器人停留在死亡界面。对于不带 loading_screen_id 的 `change_dimension`，生命周期模块不发送
  加载界面确认，并且在重生过程中完成维度切换而不触发额外的 `spawn`：每次死亡只有一次 `respawn` 和一次 `spawn`，跨维度也是如此。
  加入时和末地出口的 respawn 包不算死亡。重生到另一维度后 `spawn` 时的位置见[出生搜索高度](connection.md#spawn-search-height)。

## 创造模式玩家不会死亡  {#creative-death}

- **影响：** 对创造模式的机器人使用 `/kill`（或任何伤害）；为已死亡的机器人设置游戏模式。
- **Java：** `/kill` 能杀死创造模式玩家。
- **Bedrock：** "Players cannot be killed while they are in Creative mode"（`/damage` 和虚空也不行），并且不能对已死亡的玩家
  设置游戏模式（"No targets matched selector"）。
- **bedboo：** 库中无需修改。杀死机器人之前先把它切换到生存或冒险模式；非默认的游戏模式（例如冒险）在重生后会保留。

## 维度切换、末地制作人员名单  {#dimension-change}

- **影响：** `bot.game.dimension`、维度切换时的 `respawn` / `game` / `spawn` 事件、末地出口传送门。
- **Java：** 一个带有另一维度的 `respawn` 包（制作人员名单另有 `game_state_change win_game`，用 `client_command` 跳过）。
- **Bedrock：** `change_dimension`（`/execute in … tp` 时为脚部位置；经传送门时是一个无效位置，随后由 `move_player` 重置）→
  客户端 `player_action dimension_change_ack` → 服务器 `dimension_change_ack` → 客户端带 loading_screen_id 的
  `serverbound_loading_screen` 1 / 2。经出口传送门离开末地：BDS 先发送 `show_credits {status: 0}`（仅在玩家第一次离开末地时），
  并一直等待客户端的 `show_credits {status: 1}`（不等到就永远不继续），然后才发送前往主世界的 `change_dimension`（`respawn: true`）。
- **bedboo：** 与上游一致：切换时先 `game` 再 `respawn`（isAlive 为 false），新维度加载完成后 `spawn`（isAlive 为 true）；
  制作人员名单立即跳过（`show_credits` status 1），与上游的 `client_command` 一致。站在 `portal`（下界传送门，Bedrock 的名字；
  生存模式玩家约需 4 s，创造模式约 1.5 s）和 `end_portal` 方块中即可通过传送门旅行。世界如何重置、适用哪些高度：
  见[维度](connection.md#dimensions)。

## 跨维度切换等待 tick  {#dimension-change-ticks}

- **影响：** 在循环中用 `await bot.waitForTicks(1)` 走进传送门的代码。
- **Java：** 重生到另一维度期间，物理 tick 仍在继续。
- **Bedrock：** 玩家切换维度期间（`change_dimension` → 维度切换确认 → `player_spawn`；末地出口还会显示制作人员名单），bedboo
  会暂停物理。
- **bedboo：** `bot.waitForTicks(1)` 会一直等到切换结束，并在 5 s 后以 "Timeout waiting for 1 ticks" 拒绝，即使机器人已经到达。
  走进传送门时，应等待下一个 tick，或 `game`（维度已切换）、`spawn`、`respawn`、`death` 事件中最先发生的一个，并在新维度中通过
  `spawn` 等待到达（bedboo agent 的 `util.tick(bot)` 就是这样做的，且从不拒绝）。

## 经验值  {#experience-points}

- **影响：** `bot.experience.points`。
- **Java：** 服务器发送总经验值。
- **Bedrock：** 只有 `update_attributes` 中的 `minecraft:player.level` 和 `minecraft:player.experience`（经验条进度）。
- **bedboo：** points = 达到当前等级所需的经验 + 进度 × 下一级所需经验（Bedrock 与 Java 共用同一条曲线；`/xp 10` → 1 级 + 3/9
  → 10 点）。无法区分附魔花掉的经验。

## 能力  {#abilities}

- **影响：** `bot.abilities`、`abilities` 事件。
- **Java：** 加入时以及每次游戏模式变化时发送带标志位的 `abilities` 包。
- **Bedrock：** 加入时以及权限变化时发送带能力层的 `update_abilities`（base、spectator、commands、editor、loading screen：
  allowed / enabled 集合、飞行 / 行走速度）。执行 `/gamemode` 时，客户端自行推导该游戏模式的能力；BDS 只在飞行状态变化时发送
  `update_abilities`。BDS 在回应 `request_ability` 时，以及在改变飞行状态的游戏模式变化之后（飞行中 → 生存，进入 / 离开旁观），
  会发送两次 `update_abilities`，重复机器人已有的值（在 BDS 1.26.51.1 上测得）。在旁观模式下，BDS 的能力层会清除 `mayFly`，
  而 `flying` 仍保持开启。
- **bedboo：** 合并各能力层（每层决定它所允许的标志；后面的层覆盖前面的层）。游戏模式变化时，能力按 Java 服务器的
  `GameType.updatePlayerAbilities` 设置（创造：mayFly、instantBuild、invulnerable；旁观：再加 flying，没有 instantBuild；
  生存 / 冒险：无），并像 Java 一样只触发一次 `abilities`。没有任何变化的 `update_abilities` 不触发 `abilities`，并保持
  `bot.abilities` 对象不变（加入时的第一次总会上报）。`bot.abilities` 是唯一的飞行状态来源：物理引擎跟随它，不会回发
  `request_ability`（[飞行](movement.md#flight)）。

## 出生点  {#spawn-point}

- **影响：** `bot.spawnPoint`。
- **Java：** `spawn_position` = 世界出生点（指南针目标），带真实高度。
- **Bedrock：** `start_game.spawn_position`（世界出生点；高度未确定时 y = 32767：有人在那里出生时服务器会搜索最高的安全方块），
  以及 `spawn_type` 为 `world`（`/setworldspawn`）或 `player`（床、重生锚、`/spawnpoint`；Java 从不发送）的
  `set_spawn_position`。
- **bedboo：** `bot.spawnPoint` = 世界出生点（来自 start_game，之后是 `world` 更新 + `game`）；玩家自己的重生点不会改变它。
  32767 的高度会在出生点区块列加载后解析：见[出生搜索高度](connection.md#spawn-search-height)。

## 床、睡觉与 spawnReset  {#beds}

- **影响：** `bot.sleep`、`bot.wake`、`sleep` / `wake` 事件、`bot.isABed`、`bot.parseBedMetadata`、`spawnReset`。
- **Java：** 16 种颜色的床方块，带朝向 / 部位 / 占用状态；睡觉 = 使用床；`entity_action leave_bed` 起床；睡眠状态是玩家的姿态
  元数据；`game_state_change no_respawn_block_available`。
- **Bedrock：**
  - 只有一个 `bed` 方块（颜色在方块实体中；另有 `straw_bed`），带 `direction`（0 南、1 西、2 北、3 东）、`head_piece_bit`、
    `occupied_bit`。名字以 "bed" 结尾的第一个物品是 `straw_bed`，而不是床。
  - 睡觉 = 对床进行物品使用 `click_block`。服务器回应 `set_entity_data` 的 `player_flags` 第 1 位 + `player_bed_position`
    （床头），用一次 `correct_player_move_prediction` 把玩家移到床上（脚在床顶面下方约 0.7，位于床头方块中心），并标记床头的
    `occupied_bit`；创造模式玩家也能睡觉。`player_action stop_sleeping` 让玩家起床（`animate wake_up` + `player_flags` 0，
    并修正到床旁边）。若没有人叫醒玩家，BDS 会在 100 tick 后自行结束睡眠（`doDaylightCycle` 开启时跳过夜晚；时钟跳到早晨）。
  - 用 `/setblock` 放床总是放置整张床：给定位置成为床头，床尾在其后方（`head_piece_bit` 被忽略；例如
    `/setblock <head> bed ["direction"=0]`）；移除一半会破坏另一半。
  - 当重生用的床 / 重生锚已不存在时，会以 `tile.bed.notValid` / `tile.respawn_anchor.notValid` 消息通知；若回退位置就是床出生点
    本身的位置，则不会有任何通知。
- **bedboo：** `isABed` 匹配 `bed` 和 `*_bed`；`parseBedMetadata` 根据 Bedrock 状态返回与上游相同结构的结果；收到上述消息时触发
  `spawnReset`。`sleep()` 按上游的顺序、使用上游的消息执行上游的检查（时间 / 雷暴、已在睡觉、不是床、已被占用、半张床、
  `canDigBlock` 触及范围、点击距离、敌对生物）；会等待 `activateBlock` 完成（Bedrock 上它是异步的）；3 s 后报 'bot is not
  sleeping'。`wake()` 发送 `player_action stop_sleeping` 并立即返回，与上游一致。

## 刚放下的床是"半张床"  {#bed-halves}

- **影响：** 在 `bot.placeBlock` 放下床之后立即调用 `bot.sleep(bed)`。
- **Java：** 服务器为两半各发送一次方块变化；客户端在能点击之前就能看到两半。
- **Bedrock：** 床尾和床头作为两个独立的 `update_block` 到达（在 BDS 1.26.51.1 上观察到）。
- **bedboo：** 在被点击的格子刚出现床时就调用 `bot.sleep()`，会以上游的 "there's only half bed" 被拒绝（另一半的 `bot.isABed`
  仍为 false），一个 tick 之后就可以成功。应等待（≤ 20 tick）两个格子都是床，并在这种拒绝后再试一次 `sleep`。之后的睡眠行为见
  [床](#beds)。

## 钓鱼  {#fishing}

- **影响：** `bot.fish()`。
- **Java：** 用 use_item 抛竿 / 收竿；浮漂是一个 `fishing_bobber` spawn_entity；咬钩表现为浮漂旁边的 6 个 `fishing` / `bubble`
  粒子（world_particles），上游据此检测。
- **Bedrock：** 抛竿 / 收竿 = 手持钓竿进行物品使用 `click_air`。浮漂是 `add_entity minecraft:fishing_hook`，其 `owner_eid`
  元数据是抛竿者的 unique id。等待期间，鱼钩先发送 `entity_event fish_hook_tease`（附近有鱼），然后是带 `fish_x` / `fish_z`
  元数据的 `fish_hook_position`（一条鱼游过来，约 1–3 s）；咬钩是鱼钩上的 `entity_event fish_hook_hook`。随后收竿时，渔获作为一个
  飞向玩家的 `add_item_entity` 掉落（通过 `take_item_entity` 拾取），外加经验球，并移除鱼钩（`remove_entity`）。
  - 实测等待时间（抛竿 → `fish_hook_hook`，开阔水域，用 `/enchant` 设置等级）：Lure 0 晴天 6.3–32.3 s（均值 20.7，n=10）；
    Lure 0 雨天 6.0–20.9 s（12.1，n=8）；Lure III 晴天 2.5–12.7 s（5.9，n=8）；Lure III 雨天 1.9–12.2 s（5.7，n=14）。
    基础窗口与 Java 的 100–600 tick（+ 鱼游过来的时间）相符，因此 `fishingBiteDelayMaxTicks: 600`
    （[特性表](data.md#feature-table)）成立；与 Java 一样，每级 Lure 缩短约 5 s。
  - Bedrock 的 `/give` 不能携带附魔，`/enchant` 的 Lure 上限为 III（`/give @s fishing_rod` + `/enchant @s lure 3`）；BDS 不会把
    `/enchant` 的结果告诉创造模式玩家。
- **bedboo：** 上游的任务逻辑和消息不变；浮漂是 `fish()` 之后机器人拥有的第一个 `fishing_hook`（忽略其他玩家的浮漂；上游会接受任何
  浮漂），咬钩是它上面的 `fish_hook_hook`。与上游一样，`fish()` 本身没有时间限制。

## 书  {#books}

- **影响：** `bot.writeBook`、`bot.signBook`。
- **Java：** `edit_book { slot, pages[], title? }` 携带整本书，最多 100 页；页面是 NBT 字符串（`nbt.value.pages.value.value` =
  页面文本）；服务器回显被编辑的槽位。
- **Bedrock：**
  - 必须先*打开*书：对手持的 `writable_book` 进行一次物品使用（`click_air`）（新书随后会带着空的 `pages` 列表返回）；与该使用在
    同一 tick 到达服务器的编辑会被丢弃。
  - 编辑逐页进行：`book_edit { inventory_slot: hotbar slot, type: replace_page | add_page | delete_page | swap_pages,
    page_number, text, photo_name }`，署名是 `book_edit { type: sign, title, author, xuid }`。BDS 对编辑不作任何回应；关闭书
    （`item_release`）会让它重新发送这本书（新的 stack id）。
  - 物品 NBT：`pages: [{ text, photoname }]`（文本要用 `pages.value.value.map(p => p.text.value)` 读取，而不是当作字符串列表）；
    成书另外带 `author`、`title`、`xuid`（离线时为 ''）和 `generation` 0。18 个字符的标题会被接受。
  - BDS 最多保留 50 页，其余的被丢弃。
- **bedboo：** 上游的检查、消息和槽位处理（书被移到快捷栏槽位 0 并手持，之后恢复手持槽位 / 书所在槽位）。一次编辑是一个会话：
  打开 → 若干 `book_edit`（只发送有变化的页面，多余的页面从末尾删除）→（`sign`）→ 释放，以重新发送的书包含所请求的页面（或成书）
  作为确认；未得到确认的会话会以更长的打开延迟重试一次（总计 20 s，与上游的确认超时相同）。用书本身已有的页面调用 `writeBook`
  不会发送任何内容。超过 50 页会被立即拒绝（`too many pages: a Bedrock book holds at most 50 pages`），此时尚未移动任何物品；
  编辑失败时仍会恢复手持槽位并把书放回原处。
