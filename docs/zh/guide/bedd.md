# 驱动真实客户端（BeDD）

通常情况下 bedboo 本身*就是*客户端：它通过 RakNet 或 NetherNet 登录基岩版专用服务器，并亲自发送每一个数据包。使用
`transport: 'bedd'` 时，它改为驱动一个**真实的 Minecraft 基岩版客户端**，该客户端由
[Be.D.D.](https://docs.levimc.org/BeDD/)（Bedrock Deep Dive，一个 LeviLamina 客户端模组）托管。于是同一个脚本会作用于一个
真实的游戏：你能看到本地玩家按照脚本的指示行走、转头、挖掘、放置和聊天。

```js
const bedboo = require('bedboo')
const bot = bedboo.createBot({ transport: 'bedd', version: '1.26.60', bedd: {} }) // 唯一一个正在运行的 BeDD 游戏
bot.once('spawn', () => bot.chat('hello from bedboo'))
```

两种模式之间的切换只取决于 `transport`；直连 BDS 的模式（`raknet`、`nethernet`）保持不变。该模式的差异逐条列在
[BeDD 模式](../reference/differences/bedd.md)中。

## 安装配置 {#setup}

仅支持 Windows（BeDD 是 Windows 客户端模组）；需要 Node 24 或更高版本。bedboo 需要 **BeDD v2**，它通过本机 WebSocket
提供每个游戏；不再支持 BeDD v1（命名管道 `\\.\pipe\BeDD`）。

1. 安装 BeDD v2（见 [BeDD 文档](https://docs.levimc.org/BeDD/)），并用它启动一个游戏：

   ```sh
   BeDD.exe launch --slot 2
   ```

   BeDD 让每个游戏运行在你的 LeviLauncher 实例的独立副本中（`%LOCALAPPDATA%\BeDD\instances\<base>-<slot>`），并在监听期间
   于 `%LOCALAPPDATA%\BeDD\run\<pid>.json`（`$BEDD_HOME` 可移动该目录）中公布它：
   `{ "protocol": 2, "kind": "client", "pid", "url": "ws://127.0.0.1:<port>/v1", "token", "instance", "label", … }`。
   bedboo 读取这个文件来连接；token 是唯一的凭据。
2. bedboo 用到的一切在 BeDD v2 中都**默认开启**（以 token 为边界）。游戏的 `mods\BeDD\config\config.json` 中与 bedboo 相关的键：

   | 键 | 默认值 | 作用 | bedboo 用它来 |
   |---|---|---|---|
   | `tap` | `true` | tap：所有客户端方向（clientbound）的数据包、所有服务端方向（serverbound）数据包的回显、标记，以及一份加入日志 | 一切功能（没有它 bedboo 无法附加） |
   | `tapLoopback` | `true` | 监听单人 / 局域网主机世界（回环链路，数据包经重新序列化） | [单人游戏](#singleplayer) |
   | `tapJournalMiB` | `128` | 回放给后附加客户端的加入日志的大小上限 | 在会话中途附加（超过上限时为 `complete:false`） |
   | `gameHooks` | `true` | `world`、`look` 和 `input` 操作（挂钩到游戏自身的输入管线） | 精确的移动和视角（没有它：使用虚拟按键和鼠标） |
   | `allowSend` | `true` | 针对白名单中数据包 ID 的 `send` 操作（`sendAllow`，默认 `[9, 77]` = text、command_request） | `bot.chat`、私聊、命令 |
   | `allowStack` | `true` | `stack` 操作：通过客户端自身的 ItemStackNetManager 提交 item_stack_request | 物品栏：clickWindow、transfer、craft、deposit/withdraw、从主物品栏装备、创造模式 |
   | `wsPort` | `0` | WebSocket 端口（0：任意空闲端口，从 run 文件中读取） | `bedd.url` |
   | `wsMaxClients` | `8` | 同时允许打开的 WebSocket 连接数（bedboo 使用两个） | 让 bedboo 与 BeDD 管理器及其他测试工具并存 |

   设为 `false` 的键会关闭对应操作：bedboo 会把它视为 `disabled` 并使用兜底方案（见[支持范围表](#coverage)）。
   `pipeName` 和 `pipeInstances` 已随管道一起移除。

   `loopbackOnly`（BeDD 自己的配置项）让客户端只连接本机（127.0.0.1）上的服务器。客户端通过 NetherNet 加入 BDS，
   因此请以 `transport=nethernet` 启动服务器；NetherNet 加入要经过 Minecraft 的在线信令服务，所以在客户端加入和
   游戏期间，这台电脑上不能再启动其他 Minecraft 游戏（后续的登录会把当前会话挤掉："Multiplayer Connection Failed … NetherNet"）。
3. 让玩家进入一个世界（服务器、局域网世界或单人游戏）：bedboo 附加到一个已经在游戏中的客户端上，它不负责登录。
4. `createBot({ transport: 'bedd', version: '1.26.60', bedd: {} })`，其中 `version` 是游戏的协议族（否则 tap 的 HELLO
   会被拒绝；该模式下默认为 BeDD v2 所运行的游戏版本 `1.26.60`）。`bedd: {}` 选择唯一一个正在运行的 BeDD 游戏；有多个时请指明其中一个（见[选项](#options)）。加入日志回放
   完成后触发 `spawn`；从此 `bot.*` 反映的就是客户端的状态。

`bedd_follow.js` 示例让客户端跟随最近的其他玩家：

```sh
node examples/bedd_follow.js                       # 唯一一个正在运行的 BeDD 游戏
node examples/bedd_follow.js --instance <instance>  # 或 --pid <pid>
```

## 工作原理 {#how-it-works}

真实客户端对它发送的一切保持权威：登录、资源包、加载界面、区块请求、每 tick 的 `player_auth_input`（包括物理）、方块操作、
物品栏事务和物品堆叠请求。bedboo 从不伪造这些数据包。它的整个栈依然运行，而它*原本*要发送的内容会变成交给客户端的**意图**。
两个方向都经过游戏的 BeDD WebSocket（`ws://127.0.0.1:<port>/v1?token=…`），使用两个连接：

```text
script → mineflayer API → plugins → _client.queue → router ──(JSON text frames)───→ WebSocket 1 (control) → the game's input pipeline
bot.* state ← plugins ← decoder ← tap reader ←──(binary frames)──────── WebSocket 2 (tap subscribe) ← every packet the client gets / sends
```

- **状态输入：** 第二个连接发送 `{ op: 'tap', action: 'subscribe' }`，之后每个 tap 帧作为一条二进制消息到达：客户端收到的
  每一个客户端方向数据包、它发送的每一个服务端方向数据包的回显，以及 JSON 标记（`HELLO`、`LINK_UP`/`LINK_DOWN`、
  `REPLAY_BEGIN`/`REPLAY_END`、`DROPPED`）。bedboo 用 bedrock-protocol 解码它们，方式与直连模式完全相同，因此
  `bot.entities`、世界、物品栏、聊天以及每一个事件都来自真实会话。一份**加入日志**（从 `start_game` 开始，经过压缩：每个位置
  只保留最新的区块，每个实体只保留最新的属性，已移除的实体会被剔除）会回放给每个新的订阅者，因此 bedboo 可以在会话中途附加。
  tap 同一时间只有一个订阅者（第二个会得到 `code: 'busy'`）。如果 bedboo 落后超过 32 MiB，BeDD 会发送 `DROPPED` 并关闭连接；
  机器人以 `bedd_dropped` 结束，新建的机器人会获得完整回放。
- **自身状态：** `bot.entity` 的位置、速度、偏航角、俯仰角和 onGround 跟随回显的 `player_auth_input`（眼睛高度 − 1.62）。
  `physicsTick` 和 `move` 每个客户端 tick 触发一次；bedboo 自己的物理引擎不会步进。
- **意图输出：** 路由器对比 bedboo 原本要发送的内容，并调用 BeDD 的控制操作：`input`（移动向量、跳跃、潜行、疾跑，带有失效保护
  TTL）、`look`（绝对偏航角/俯仰角）、`slot`、`button`（攻击/使用/选取，挖掘时方块变化即释放）、`action`（丢弃、物品栏……）、
  `send`（白名单内的 text/command_request 字节）以及 `stack`（通过客户端的 ItemStackNetManager 发送 item_stack_request）。
  只有在游戏占有鼠标且没有打开菜单时，输入才会生效。请求是 `{ id, op, … }` 文本帧，按顺序应答，同一时间只有一个在途。
- **协商：** 附加时，bedboo 会 ping 控制连接（BeDD v2 应答 `protocol: 2`、`defaultMode: 'bedboo'` 和 `modes`，即每种操作模式
  的操作列表），并以不带参数的方式探测每个操作：`unknown op`（或不在 `modes` 中）→ 不存在（absent），`code:'disabled'` →
  存在但在 config.json 中被关闭，`ok` → 存在（present）。`bot.bedrock.bedd.caps` 保存探测结果，`bot.bedrock.bedd.supports(name)`
  按 mineflayer API 逐项给出答案。

## 权威归属表 {#authority-table}

| 类别 | 数据包 | 处理方式 |
|---|---|---|
| clientOwned | login, client_to_server_handshake, request_network_settings, resource_pack_client_response, client_cache_status, client_cache_blob_status, request_chunk_radius, subchunk_request, serverbound_loading_screen, set_local_player_as_initialized, network_stack_latency, tick_sync, player_skin, emote_list, respawn, player_action (dimension_change_ack / start_item_use_on / stop_item_use_on), animate, interact mouse_over_entity | 被路由器丢弃（客户端会自己发送）；计入统计 |
| translated | player_auth_input（move_vector 和标志 → `input`；yaw/pitch → `look`；block_actions start_break / abort_break / stop_break → `button attack`）、mob_equipment（→ `slot`）、inventory_transaction（item_use click_block / click_air、item_release、item_use_on_entity → `look` + `button`）、interact open_inventory（→ `action inventory`）、container_close（→ ESC）、item_stack_request（→ `stack`） | 转换为控制操作 |
| shared | text, command_request | 以字节形式通过 `send` 发送（保留命令 uuid，因此 `command_output` 能对应上）；兜底方案：T / SLASH 键、`text`、ENTER |
| unsupported | book_edit, block_pick_request, crafting_event, set_default_game_type，以及其他所有数据包 | `BeddUnsupportedError`（`code: 'ERR_BEDD_UNSUPPORTED'`） |

## 支持范围 {#coverage}

“Caps” 列出该 API 所需的 BeDD 操作；缺少它们时 `bot.bedrock.bedd.supports(name)` 为 false，调用会抛出或以
`ERR_BEDD_UNSUPPORTED` 拒绝（或使用所列的兜底方案）。

| API | 是否可用 | caps（兜底方案） |
|---|---|---|
| spawn、login、游戏事件、`bot.game`、时间、天气、生命值、饥饿值、经验 | 可用，来自 tap | `tap` |
| `bot.entities`、`bot.players`、方块与世界（`blockAt`、`findBlocks`、射线检测、`waitForChunksToLoad`） | 可用，来自 tap | `tap` |
| chat / message / messagestr 事件、标题、Boss 栏、计分板、Tab 列表、声音、粒子、爆炸 | 可用，来自 tap | `tap` |
| `bot.inventory`、`heldItem`（读取） | 可用 | `tap` |
| `bot.entity` 的位置 / 速度 / 偏航角 / 俯仰角 / onGround | 可用，来自回显的 player_auth_input（落后 1-2 tick） | `tap` |
| `setControlState`、`getControlState`、`clearControlStates` | 可用 | `input`（虚拟 W/A/S/D/SPACE/SHIFT/CTRL 键） |
| mineflayer-pathfinder、collectblock、pvp | 可用，通过控制状态、视角和攻击实现 | `input`、`look` |
| `look`、`lookAt` | 可用；回显收敛（< 0.5°）时完成 | `look`（闭环 `raw` 鼠标） |
| `setQuickBarSlot`、装备（`equip`）快捷栏中的物品 | 可用 | `slot`（按键 1-9） |
| `chat`、`whisper`、命令 | 可用，保留 uuid | `send`（T/SLASH + `text` + ENTER，丢失 uuid） |
| `dig`、`stopDigging` | 可用；客户端上显示裂纹动画，在 update_block → air 时完成 | `look`、`button`（`mouse`） |
| `placeBlock`、`activateBlock`、`activateItem`、`deactivateItem`、`consume`、弓 | 可用（先转向，再使用） | `look`、`button` |
| `attack`、`activateEntity`、`mount`、`dismount` | 可用 | `look`、`button`、`input` |
| 用 `toss` 丢出手持物品 | 可用 | `action`（drop / dropAll） |
| `openContainer`、`openChest`、`openFurnace`、`closeWindow` | 可用（关闭 = ESC） | `look`、`button` |
| `clickWindow`、`moveSlotItem`、`transfer`、`deposit`、`withdraw`、`putAway`、`craft`、从主物品栏 / 盔甲栏 / 副手 `equip`、`unequip`、`tossStack`、`creative.setInventorySlot`、铁砧 / 附魔台 / 村民 / 锻造台 | 可用，通过客户端的 ItemStackNetManager | `stack`（无兜底：`ERR_BEDD_UNSUPPORTED`） |
| `writeBook`、`updateSign`、`respawn`、床界面的睡觉 / 起床 | 不可用（界面层面） | — |
| `bot.end`、`quit` | 仅断开附加；客户端留在原世界 | — |
| `auth`、`username`、`host`、`port`、`viewDistance` 选项 | 忽略并给出警告（由客户端决定） | — |

说明：`activateItem(true)`（副手）会使用主手，因为客户端没有副手使用键；对不需要按住使用的物品（投掷物、钓鱼竿）调用
`activateItem` 相当于单击一次；`bot.respawn()` 不做任何事并给出警告（由用户点击重生，因此 `respawn: true` 永远不会从生命值监听器中
抛出）；`bot.craft` 保留了上游的 `new Error(err)` 包装，因此在界面层没有先拒绝的情况下，请检查那里的 `err.message`。

降级之处：pathfinder 会感受到 1-2 tick 的延迟（预测会被回显覆盖）；点击命中什么由客户端自己的射线检测决定，因此操作可能落在相邻
的方块或实体上（bedboo 会通过 `update_block` / 实体事件看到）；飞行通过双击跳跃实现；打开界面时输入暂停；后附加依赖加入日志
（`complete:false` → 缺失的区块要重新进入才会出现）；客户端切换世界会结束机器人（`LINK_DOWN`）。

## 单人游戏与局域网世界 {#singleplayer}

开启 `tapLoopback`（`tap` 开启后默认即开启）时，BeDD 还会监听客户端自己托管的世界：单人游戏或局域网世界。这些数据包从不经过
网络，因此 BeDD 会将它们重新序列化（`Packet::write`，帧标志 `reserialized`），并过滤为只与本地玩家相关的内容，这样局域网访客的
流量不会混入。[支持范围表](#coverage)中的一切都照常工作；HELLO 标记中为 `link.type: 'local'`。

## 安全性 {#security}

- **token 是边界。** BeDD v2 只监听 127.0.0.1，并拒绝没有游戏 token 的连接（HTTP 401）或带有 `Origin` 头的连接（403，
  因此网页无法访问它）。token 位于你的 `%LOCALAPPDATA%` 下的 run 文件中：任何以你的 Windows 用户身份运行的程序都能读取它并
  驱动游戏。bedboo 以 `?token=` 发送它，并且从不发送 `Origin`。
- **tap 会暴露整个会话。** 订阅者可以读取已登录玩家看到和做的一切：聊天、位置、物品栏、世界。
- **`send` 和 `stack` 以该账号的身份行事。** `send` 以已登录玩家的身份发送聊天和命令，`stack` 移动其物品。`send` 仅限
  `sendAllow` 中的 ID（`[9, 77]`），login、`player_auth_input`、物品堆叠等 ID（1、30、144、147）始终被拒绝。在不应允许它们
  的实例中，把 `allowSend` / `allowStack` 设为 `false`。
- 让用于自动化的 BeDD 游戏运行在各自的实例中（`BeDD.exe launch --slot <n>` 就是这样做的），不要使用你主账号的世界。

## 选项与 `bot.bedrock.bedd` {#options}

`createBot({ transport: 'bedd', version, bedd })`，其中 `bedd` 为以下之一：

| `bedd` | 连接到 |
|---|---|
| `{}` | 唯一一个正在运行的 BeDD 游戏客户端（有多个时会报错并列出它们） |
| `{ pid }` | 该进程 ID 的 BeDD 游戏 |
| `{ instance }` | 该实例目录的 BeDD 游戏（例如 `'1.26.60.05-2'`，即 run 文件中的 `instance`） |
| `{ url, token }` | 原样使用该端点（例如你自己从 run 文件中读取） |

以及任何形式都可附加的：

| 选项 | |
|---|---|
| `bedd.home` | 查找时使用的 BeDD 主目录（默认为 `$BEDD_HOME`，否则为 `%LOCALAPPDATA%\BeDD`） |
| `bedd.timeoutMs` | 控制请求超时，也是连接超时（默认 5000 ms；操作自带的 `timeoutMs` 会再多给 2 秒） |
| `bedd.modules` | 要附加的 `lib/bedd` 模块（默认按以下顺序：`authority`、`router`、`router_actions`、`follower`、`surface`、`inventory`） |
| `bedd.WebSocket` | WebSocket 类（默认为 Node 的全局 `WebSocket`） |

进程已不存在（游戏崩溃）的 run 文件会被跳过。没有匹配的游戏时，机器人发出 `'error'`（`code: 'ERR_BEDD_DISCOVERY'`）并结束。
`bedd.pipe`、`bedd.tapPipe` 和 `bedd.connect`（BeDD v1）会抛出错误并指出上述选项；仍然应答的 BeDD v1 会以 `ERR_BEDD_PROTOCOL`
被拒绝（"BeDD v1 uses named pipes; upgrade BeDD"）。

- `bot._bedrock.mode === 'bedd'`。
- `bot.bedrock.bedd.url` / `endpoint`：正在使用的 WebSocket（不含 token），以及来自 run 文件时游戏的 `pid`、`instance`、`label`。
- `bot.bedrock.bedd.control`：`ping` 的 `protocol`（2）、`pid`、`defaultMode` 和 `modes`（`{ bedboo: [...], input: [...], ui: [...] }`）。
- `bot.bedrock.bedd.caps`：`{ [op]: 'present' | 'disabled' | 'absent' }`，涵盖 `tap`、`world`、`look`、`input`、`slot`、
  `button`、`action`、`send`、`stack`（经过探测），以及 `ping.modes` 列出的其他操作（`key`、`text`、`mouse`、`raw`、
  `screenshot`、`ui`……）。没有控制连接时，所有操作都是 `absent`，机器人只能观察。
- `bot.bedrock.bedd.supports(name)`：在当前 caps 下，某个 mineflayer API（`'dig'`、`'craft'`、`'creative.setInventorySlot'`）
  或 BeDD 操作是否可用。
- `bot.bedrock.bedd.observed`：最近一次回显的 `player_auth_input` 的 `{ yaw, pitch, tick }`，在第一次回显之前为 `null`。
- 错误：`BeddUnsupportedError`（`code: 'ERR_BEDD_UNSUPPORTED'`、`bedd: true`、`feature`、`missing`）；不支持的数据包还会在
  `bot` 上发出 `'bedd_unsupported_packet'` `{ name, feature }`，每个名称只发一次。机器人 `'error'` 上的连接错误：
  `ERR_BEDD_DISCOVERY`、`ERR_BEDD_CONNECT`（被拒绝、token 错误、已离开）、`busy`（另一个客户端占用着 tap）、`disabled`
  （`tap: false`）、`ERR_BEDD_PROTOCOL` / `ERR_BEDD_HELLO`（BeDD 或游戏版本不同）。
- 除常规事件外的客户端事件：`'serverbound'` `{ name, params, reserialized }`（客户端发送的内容）、`'bedd_marker'`（tap 标记）
  和 `'warning'`（某个数据包解码失败；数据流继续）。

## 路线图 {#roadmap}

- 驾驶 / 傀儡模式（抑制、注入并锁定姿态），前提是证明锁定能在客户端的状态校正中保持住。
- 界面层面的操作：重生按钮、告示牌和书（BeDD v2 的 `ui` 模式可读取界面的 UI 树）。
- 一个 `connect` 操作，让 bedboo 可以使客户端加入指定服务器。
- 第二个分屏子客户端。
