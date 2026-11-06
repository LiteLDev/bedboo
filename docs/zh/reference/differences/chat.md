# 聊天、命令与 HUD

本页说明聊天消息、命令、Tab 补全以及 HUD（标题、动作栏、Boss 栏、计分板、声音、粒子）在 Java 版与 Bedrock 版之间的差异，
以及 bedboo 如何将它们映射到 mineflayer API。观察环境为 BDS 1.26.51.1（protocol 2193，bedrock-protocol 3.60.1），
下文涉及的每条命令都在实际服务器上做过数据包探测。

## 聊天消息与文本类型  {#chat-messages}

- **影响：** `message`、`messagestr`、`chat`、`whisper`、`actionBar`（位置与渲染）。
- **Java：** 玩家聊天（带签名）和系统聊天均为 JSON 组件；`/tellraw` 属于系统聊天；动作栏是带 `overlay` 的系统聊天。
- **Bedrock：** 使用 `text` 数据包：`chat` / `whisper`（`source_name` + § 格式文本）、`announcement`（`/say`：
  "[name] text"）、`raw` / `system` / `tip`（§ 文本）、`translation` / `popup` / `jukebox_popup`（`%key` + 参数）、
  `json` / `json_whisper` / `json_announcement`（rawtext JSON）。`/tellraw` 以 `json_whisper` 到达；`/me` 以 `chat`
  到达，`source_name` 为空，消息为 "* name action"；`/tell` 对目标是 `whisper`，对发送者是一条
  `commands.message.display.outgoing` 的 command_output。
- **bedboo：** 所有文本都转换为 prismarine-chat 的 `ChatMessage`（`lib/bedrock/text.js`）：
  - chat → `{ translate: 'chat.type.text', with: [name, text] }`（"\<name> text"）；whisper →
    `commands.message.display.incoming`（"name whispers to you: text"）；`/me` → 原样的消息；
  - `%key` 和 rawtext 的 `translate` 通过 `registry.language` 解析（rawtext 中的字面格式：`%%s` / `%1` 占位符；见
    [语言格式](#language-formats)）；
  - 位置：chat / whisper / announcement → `chat`；raw / system / translation / json / json_whisper（tellraw）/
    json_announcement → `system`；tip / popup / jukebox_popup → `game_info`（并触发 [`actionBar`](#action-bar)）；
  - `verified` 始终为 null（Bedrock 没有聊天签名）。当 `bot.players` 认识发送者时会传入其 uuid。

## `§` 格式代码  {#formatting}

- **影响：** 所有 Bedrock 文本的 `ChatMessage` 样式（`toMotd`、`toAnsi`、`color` 等）；`toString()` 不变。
- **Java：** `§0`–`§f` 颜色，`§k` `§l` `§m`（删除线）`§n`（下划线）`§o`，`§r`；颜色代码会重置格式。
- **Bedrock：** 额外的材质颜色 `§g` `§h` `§i` `§j` `§m` `§n` `§p` `§q` `§s` `§t` `§u` `§v`（因此 `§m` 和 `§n` 是颜色，
  没有删除线/下划线），且颜色代码不会重置粗体/斜体/乱码。
- **bedboo：** `lib/bedrock/text.js` 自行解析 § 代码（不修补 prismarine-chat）：材质颜色转为十六进制颜色
  （`§g` → `#DDD605` 等），格式在颜色代码之后保持，`§r` 重置，未知代码被丢弃。

## 语言格式  {#language-formats}

- **影响：** Bedrock 翻译键对应的每个 `ChatMessage` 的 `toString()`。
- **Java：** `%s` / `%1$s` 格式。
- **Bedrock：** en_US 语言文件还使用 `%1$d`、`%d`、`%.2f` 以及裸的 `%1`。
- **bedboo：** `bot.registry.language` 被规范化为 prismarine-chat 能替换的 `%s` / `%N$s` 形式（`lib/registry.js`），
  例如 `commands.time.set` "Set the time to %1$s"。

## 默认聊天模式（`chat` / `whisper` 事件）  {#default-chat-patterns}

- **影响：** `chat`、`whisper`、`bot.chatAddPattern`、`bot.addChatPattern`、`bot.removeChatPattern`。
- **Java：** mineflayer 注册三个已弃用的正则模式（两种私聊格式和旧版 "\<name> text" 聊天格式），当 `messagestr` 匹配时
  触发 `chat` / `whisper`（username、message、translate、jsonMsg）。
- **Bedrock：** 玩家聊天、私聊和 `/say` 公告（`source_name: name, message: '[name] text'`）都在数据包中给出发送者；
  Bedrock 的玩家代号可以包含空格，`(\w+)` 无法捕获。
- **bedboo：** 注册同样的三个默认模式（名称和索引相同，可移除，`defaultChatPatterns: false` 可禁用）。对于带发送者的
  `chat` / `whisper` / `announcement` 数据包，它们直接从数据包取 username 和 message（每个数据包一个事件）；公告的消息为
  `{ translate: 'chat.type.announcement', with: [name, text] }`（"[name] text"），其 `chat` 事件携带该 translate，
  与 Java 的 say_command 聊天类型一致。其他所有消息都走上游的正则（例如 `/tellraw` "\<U9G> Hello"）。用户模式始终使用
  自己的正则。模式的管理逻辑（repeat、parse、集合、按名称/编号移除、返回值）沿用上游代码。

## `unmatchedMessage`  {#unmatched-message}

- **影响：** `unmatchedMessage` 事件。
- **Java：** 在 mineflayer 4.39.0 的 `index.d.ts` 中声明（`(stringMsg, jsonMsg)`），但其插件从不触发。
- **Bedrock：** 协议层面无差异。
- **bedboo：** 对每条未被任何聊天模式匹配的消息触发（即该声明事件在 4.x 之前的 mineflayer 中的含义），在 `messagestr`
  之后。

## `bot.whisper`  {#whisper}

- **影响：** `bot.whisper(username, message)`。
- **Java：** `chatWithHeader('/tell <username> ', message)`。
- **Bedrock：** `/tell <target> <message>`（别名 `/w`、`/msg`）；含空格的目标必须加引号。
- **bedboo：** 使用上游的 `/tell` 前缀（以[命令请求](#commands)发送），玩家名不是普通单词时加引号；选择器（`@p`、
  `@a[r=5]` 等）与上游一样原样发送（带引号的 `"@p"` 在 BDS 上匹配不到任何目标）。当仅前缀就达到 `chatLengthLimit` 时，
  上游会无限拆分；bedboo 则抛出异常。

## 命令  {#commands}

- **影响：** `bot.chat('/…')`。
- **Java：** 聊天命令（`chat_command` 数据包）。
- **Bedrock：** `command_request { command, origin: { type: 'player', uuid, request_id, player_entity_id }, internal,
  version }` → `command_output`（回显 origin uuid）。
- **bedboo：** `bot.chat('/…')` 发送一个带新 origin uuid 的 `command_request`（绝不作为聊天消息发送）；每一行
  `command_output` 都成为一条 `message`（位置 `system`，`translate` = 其消息 id）。`bot._bedrock.commands.request(cmd)`
  （内部）以匹配的输出 resolve；成功但没有输出的命令以空输出 resolve（[无输出的命令](#silent-commands)）。

## 无输出的命令  {#silent-commands}

- **影响：** `bot._bedrock.commands.request(command, { timeout })`（内部钩子）、`bot.chat('/…')`（发出即不管，行为
  不变）。
- **Java：** mineflayer 中没有对应的钩子。
- **Bedrock：** `/say`、`/me`、成功的 `/tellraw`——以及 `sendcommandfeedback` 游戏规则关闭时的所有命令——完全没有
  `command_output`。对于每条成功的命令，BDS 会发送 `event { event_type: 'command_executed', event_data: 08 02 00
  <len> <name> 00 }`，若命令有 `command_output`，则紧挨在它之前（同一批次）；失败的命令从不产生该事件，但总会有
  `command_output`（即使关闭反馈：`output_type: 'silent'`）。
- **bedboo：** 该事件与同名命令中最早的请求匹配；若 100 ms 内没有 `command_output` 跟随，请求以
  `{ origin, output_type: 'none', success_count: 1, output: [], has_data: false }` resolve。若两者都未到达，请求仍会在
  `timeout`（10 s）后 reject。

## 玩家执行 `/op`  {#op-command}

- **影响：** `bot.chat('/op …')` 以及等待 `commands.op.success` 的代码（例如 mineflayer 的示例）。
- **Java：** 管理员玩家可以给其他人 op；机器人会看到 "Opped" 聊天消息。
- **Bedrock：** 对于 `operator` 权限级别的玩家，BDS 回复 `commands.generic.error.permissions`；`/op` 需要控制台或更高
  的权限级别。BDS 从不在聊天中告知玩家控制台执行的 op；被 op 的玩家只会收到一条宣告此事的 `update_abilities`。
- **bedboo：** 错误输出仍是一条 `message`。请通过服务器控制台给机器人 op，如有需要，等待 `update_abilities`
  （[`abilities`](survival.md#abilities) 事件）而不是聊天消息。

## `bot.tabComplete`  {#tab-complete}

- **影响：** `bot.tabComplete(str, assumeCommand, sendBlockInSight, timeout)`。
- **Java：** 由服务器响应的 `tab_complete` 请求（对最后一个词给出 brigadier 建议，方块坐标会用到准星所指的方块）。
- **Bedrock：** 没有 Tab 补全数据包；客户端根据 `available_commands` 树进行补全（枚举、由 `update_soft_enum` 更新的
  软枚举、`/execute` 的链式子命令、命令别名）。
- **bedboo：** 在客户端根据 `available_commands` 补全（`lib/bedrock/commands.js`），结果形状与上游一致
  （`tabCompleteHasAToolTip` → `[{ match, tooltip: undefined }]`）：命令名/别名、枚举值、软枚举、目标参数的玩家名 +
  选择器（`@a @e @initiator @p @r @s`）、坐标的 `~` 形式，并递归处理 `/execute … run <command>`；普通聊天补全在线
  玩家名。最多等待 `timeout` 以获得 `available_commands`（超时时与上游一样 reject）。`sendBlockInSight` 无效果。结果遵循
  Bedrock 的命令集：`/weather ` → clear、**query**、rain、thunder。

## 标题  {#titles}

- **影响：** `title`、`title_times`、`title_clear`。
- **Java：** `set_title_text` / `set_title_subtitle`（JSON 组件）、`set_title_time`、`clear_titles`。
- **Bedrock：** `set_title { type: set_title | set_subtitle | set_title_json | set_subtitle_json | set_durations |
  clear | reset | action_bar_message(_json), text, fade_in_time, stay_time, fade_out_time }`（`/title` 将该行剩余部分
  作为文本发送，`/titleraw` 发送 rawtext）。
- **bedboo：** set_title / set_subtitle → `title(parseTitle(text), 'title'|'subtitle')`，使用上游的 parseTitle（因此
  `/title @a title {"text":"Test Title"}` 得到 "Test Title"；纯文本与上游的原始文本一样保留 § 代码）；`*_json` →
  渲染为纯文本的 rawtext；set_durations → `title_times`；clear 和 reset → `title_clear`；动作栏 → `actionBar`
  （[见下](#action-bar)）。

## 动作栏  {#action-bar}

- **影响：** `actionBar` 事件。
- **Java：** 带 `overlay` 的系统聊天 → `message` + `messagestr`（game_info）+ `actionBar`；`/title … actionbar`
  （set_action_bar_text）在 mineflayer 4.39.0 中不触发任何事件。
- **Bedrock：** `text` 的 tip / popup / jukebox_popup 以及 `set_title` 的 action_bar_message(_json) 都显示在动作栏上。
- **bedboo：** 它们各自 → `game_info` 位置的 `message` + `messagestr`，然后 `actionBar(jsonMsg, null)`。

## Boss 栏  {#boss-bars}

- **影响：** `bot.bossBars`、`bossBarCreated`、`bossBarUpdated`、`bossBarDeleted`、`BossBar` 字段。
- **Java：** `/bossbar` 创建服务器端的栏（uuid、标题、血量、颜色、样式、标志）；`boss_bar` 动作用于添加 / 移除 / 更新。
- **Bedrock：** 没有 `/bossbar`；Boss 栏属于 Boss 实体（凋灵、末影龙）。`boss_event { target_entity_id, type, title,
  progress, color, overlay }`：BDS 在 Boss 出现时发送 `show_bar`，之后大约每秒再发送一次当前进度；在我们的探测中从未
  发送 `hide_bar`——客户端随实体一起丢弃 Boss 栏（死亡动画后的 `remove_entity`，或 Boss 离开视野时）。未命名 Boss 的标题
  是翻译键（`entity.wither.name`）；命名牌会替换它（末影龙除外）。颜色：pink、blue、red、green、yellow、purple、
  **rebecca_purple**（凋灵）、white。凋灵在和平难度下会消失。
- **bedboo：**
  - 每个 Boss 的第一条 `show_bar` → `bossBarCreated`；之后改变了某个字段的 `show_bar`（每秒一次的重复通常不改变，
    正如 Java 只发送变化）以及 set_bar_progress / set_bar_title / update_properties / texture → `bossBarUpdated`；
    `hide_bar`、Boss 的 `remove_entity` 以及维度切换 → `bossBarDeleted`；
  - `entityUUID` = Boss 的 unique id（字符串），`title` 为 `ChatMessage`（已翻译），`health` = progress，`dividers`
    来自 overlay（0、6、10、12、20），`color` = Bedrock 颜色名（`BossBar` 子类；已在 `index.d.ts` 中声明类型），
    已知实体时标志取自 Boss 类型（凋灵：天空变暗；末影龙：龙栏 + 雾），否则为 0。

## 计分板  {#scoreboards}

- **影响：** `bot.scoreboards`、`bot.scoreboard`、`scoreboardCreated`、`scoreboardDeleted`、
  `scoreboardTitleChanged`、`scoreUpdated`、`scoreRemoved`、`scoreboardPosition`。
- **Java：** 每个目标都会发送给每个客户端（`scoreboard_objective`），分数按实体名记录，显示位置 0 list / 1 sidebar /
  2 belowName（+ 队伍侧边栏）。
- **Bedrock：** 客户端只知道**正在显示**的目标：`set_display_objective { display_slot: list | sidebar | belowname,
  objective_name, display_name, criteria_name, sort_order }`（名称为空表示清空该位置），然后是带该目标分数的
  `set_score`；`set_score` 条目以计分板 id 为键（玩家 / 实体：unique id；虚拟玩家：自定义名；`remove` 条目只携带 id）；
  `remove_objective`。只有 `dummy` 准则；没有队伍侧边栏。
- **bedboo：**
  - 目标在首次显示时出现在 `bot.scoreboards` 中（`scoreboardCreated`；`title` = 纯文本显示名，即使它看起来像 JSON，
    例如 "2024"）；显示名改变 → `scoreboardTitleChanged`；`scoreboardPosition(position, scoreboard, previous)` 使用
    Java 的位置编号；清空位置只是将其置空（不触发事件）；
  - 以升序显示（`sort_order` 0）的目标，其 `items` 按从低到高排列，与 Bedrock 客户端一致（Java 只有降序）；
  - 分数：`scoreUpdated` / `scoreRemoved`，使用上游的 ScoreBoard 条目；条目名 = 虚拟玩家名、玩家用户名（自身、
    player_list、`bot.players`）或实体的 unique id；
  - `remove_objective` → `scoreboardDeleted` 并清空其占用的显示位置。

## 声音  {#sounds}

- **影响：** `soundEffectHeard`、`hardcodedSoundEffectHeard`。
- **Java：** `sound_effect`（注册表 id 或命名声音、类别、位置 × 8、音量、音调）。
- **Bedrock：** `/playsound` 使用 `play_sound { name, coordinates (× 8), volume, pitch }`（BDS 转发任意名称，例如
  `note.harp`、`gui.button.press`）；游戏自身的声音使用 `level_sound_event { sound_id (name, e.g.
  'armor.equip_iron'), position, extra_data, entity_type, … }`，没有音量和音调。
- **bedboo：** play_sound → `soundEffectHeard(name, position, volume, pitch)`；level_sound_event →
  `soundEffectHeard(name, position, 1, pitch)`（音调为 1，音符盒则为 Java 的音符音调）；无法命名的 id →
  `hardcodedSoundEffectHeard(id, 'master', position, 1, pitch)`（Bedrock 没有声音类别）。`noteHeard` 来自方块事件：见
  [方块动作](world.md#block-actions)。

## 粒子  {#particles}

- **影响：** `particle` 事件、`Particle` 导出。
- **Java：** `world_particles`（粒子类型、位置、偏移、数量、速度、远距离渲染）；`/particle <name> x y z dx dy dz speed
  count force`。
- **Bedrock：** 只有 `/particle <effect> [x y z]` → `spawn_particle_effect { dimension, entity_id, position,
  particle_name, molang_variables }`（BDS 转发任意效果名）；游戏自身生成的粒子使用 `level_event`
  `add_particle_<type>`（0x4000 | type）。协议中没有偏移、数量、速度或远距离标志。粒子类型 id 从 1 开始。
- **bedboo：** `Particle`（导出和事件）是 mineflayer 的类，扩展了 Bedrock 的 `fromNetwork`：
  - spawn_particle_effect → `id` = 效果名；若它是粒子类型名，则通过 `registry.particles` 解析（`bubble` → id 1），
    否则标识符保留为 `id` 并同时作为 `name`（`minecraft:heart_particle`）；
  - level_event `add_particle_*` → 类型 id 和名称（0x4000 范围之外的两个粒子事件
    `add_particle_smash_attack_ground_dust` / `add_particle_creaking_heart_trail` 以名称作为 id）；
  - `offset` (0, 0, 0)、`count` 1、`movementSpeed` 0、`longDistanceRender` false。

## 没有队伍  {#no-teams}

- **影响：** `bot.teams`、`bot.teamMap`、`teamCreated`、`teamRemoved`、`teamUpdated`、`teamMemberAdded`、
  `teamMemberRemoved`。
- **Java：** `/team`（或 `/scoreboard teams`）以及 `teams` 数据包。
- **Bedrock：** 完全没有队伍：`/team` 是未知命令，`/scoreboard teams` 是语法错误，没有队伍数据包。
- **bedboo：** `bot.teams = {}` 和 `bot.teamMap = {}` 永远为空；从不触发队伍事件。ScoreBoard 条目的 `displayName`
  退化为纯名称（上游的无队伍路径）。

## 没有 Tab 列表页眉 / 页脚  {#no-tablist-header}

- **影响：** `bot.tablist.header`、`bot.tablist.footer`。
- **Java：** `playerlist_header` 设置 Tab 列表的页眉和页脚。
- **Bedrock：** 玩家列表没有页眉或页脚（protocol 2193 中没有此类数据包）。
- **bedboo：** `bot.tablist = { header, footer }` 始终是空的 `ChatMessage`。
