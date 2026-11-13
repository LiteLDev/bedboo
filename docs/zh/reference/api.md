# API

**bedboo 的 API 就是 mineflayer 的 API。** mineflayer 4.39.0
[API 参考](https://github.com/PrismarineJS/mineflayer/blob/4.39.0/docs/api.md)中记录的每一个类、属性、方法和事件都存在，
名称、参数、返回值、错误消息和事件顺序均相同；bedboo 的 TypeScript 定义（`index.d.ts`）就是 mineflayer 的定义，只是替换了协议
客户端。完整参考请阅读上游文档；本页只列出不同或新增的内容。因基岩版本身不同而产生的行为差异见
[基岩版差异](differences/index.md)。

## 模块导出 {#module-exports}

`require('bedboo')` 导出的内容与 `require('mineflayer')` 相同：

| 导出 | 值 |
|---|---|
| `createBot(options)` | 见[下文](#createbot-options) |
| `Location`、`Painting`、`ScoreBoard`、`BossBar` | mineflayer 的类，未作修改 |
| `Particle` | mineflayer 的类，针对基岩版粒子数据包做了扩展（[粒子](differences/chat.md#particles)） |
| `latestSupportedVersion`、`oldestSupportedVersion` | `'1.26.60'`、`'1.26.40'` |
| `testedVersions` | `['1.26.40', '1.26.45', '1.26.51', '1.26.60']`，已测试的协议族，从旧到新（[支持的版本](versions/index.md)） |
| `supportFeature(feature, version)` | 依据基岩版特性表作答（[特性表](differences/data.md#feature-table)） |

## createBot 选项 {#createbot-options}

`createBot(options)` 接受 mineflayer 的选项以及 bedrock-protocol 的
[`ClientOptions`](https://github.com/PrismarineJS/bedrock-protocol/blob/master/docs/API.md)（`index.d.ts` 中 `BotOptions`
继承了它们）。在基岩版需要时，默认值有所不同：

| 选项 | 默认值 | |
|---|---|---|
| `host` | `'127.0.0.1'` | BDS 地址 |
| `port` | `19132` | BDS 的 `server-port`（RakNet 用 UDP，NetherNet 用 TCP + UDP） |
| `username` | `'Player'` | 离线模式：玩家名；microsoft：令牌缓存的键（游戏内名称为玩家代号 gamertag） |
| `auth` | `'offline'` | `'offline'`（无 Xbox Live；服务器需设置 `online-mode=false`）或 `'microsoft'`（通过 prismarine-auth 登录 Xbox Live：`profilesFolder`、`onMsaCode`、`authTitle`、`flow`、`deviceType` 与 mineflayer 相同）。`'mojang'` 会抛出错误。 |
| `version` | `'1.26.51'` | 已测试的协议族（`'1.26.60'`）或其任一 BDS 版本（`'1.26.62.1'`）；`false`（自动）即 1.26.51（不检测服务器版本）；其他任何值都会抛出 `ERR_BEDBOO_VERSION`（[支持的版本](versions/index.md#choosing)） |
| `transport` | `'raknet'` | `'nethernet'` 表示使用 NetherNet（[传输层](differences/connection.md#transport)）；`'bedd'` 驱动真实客户端（[BeDD](../guide/bedd.md#options)） |
| `nethernet` | `{ signalling: 'http' }` | 仅限 NetherNet：`signalling`（`'http'` = 服务器端口上的 HTTP，`'lan'` = UDP 7551 发现，`'services'` = Xbox）、`url`（信令源，默认 `http://host:port`）、`serverKey`（服务器身份密钥的 `'sha256:<hex>'` 固定值）、`onServerKey(fingerprint, url) → boolean`（批准一个未固定的密钥；默认接受任意密钥）、`networkId`、`webrtcBackend`、`signallingConnectTimeout` |
| `bedd` | | 仅限 `transport: 'bedd'`：`url` + `token`、`pid` 或 `instance`（BeDD v2 游戏；`{}` = 唯一一个正在运行的游戏）、`home`、`timeoutMs`、`modules`（[BeDD 选项](../guide/bedd.md#options)） |
| `raknetBackend` | `'raknet-native'` | `'jsp-raknet'` 会被 BDS 拒绝（RakNet 协议 10 与 11 不兼容） |
| `skipPing` | `true` | 关闭局域网可见性的 BDS 不响应 ping |
| `conLog` | `null` | bedrock-protocol 的控制台日志（设为 `console.log` 可查看连接消息） |
| `viewDistance` | `'far'` | mineflayer 的名称或区块数；以 `request_chunk_radius` 发送 |
| `maxCatchupTicks` | `4` | *新增：* 卡顿之后，机器人一次最多补发多少个错过的 `player_auth_input` tick |
| `respawn`、`physicsEnabled`、`plugins`、`loadInternalPlugins`、`chat`、`colorsEnabled`、`hideErrors`、`logErrors`、`defaultChatPatterns`、`chatLengthLimit`、`mainHand`、`client`、`brand` | 与 mineflayer 相同 | `client`：任意 bedrock-protocol `Client`（`createClient` 的返回值）；`brand` 会被忽略（基岩版没有 brand 通道） |

## 基岩版扩展：`bot.bedrock` {#bedrock-extras}

基岩版独有的新增内容都放在 `bot.bedrock` 下，绝不会作为新的 `bot` 顶层成员出现，其类型定义在
`types/bedrock.d.ts`（`BedrockExtras`）中：

| 成员 | 类型 | |
|---|---|---|
| `bot.bedrock.gameRules` | `{ [name: string]: boolean \| number }` | 服务器的游戏规则，按基岩版名称索引（`doDayLightCycle`、`keepInventory`、`randomTickSpeed`……），来自 `start_game` 和 `game_rules_changed`（[游戏规则](differences/world.md#game-rules)） |
| `bot.bedrock.blockVariants(block)` | `(block: string \| number) => number[]` | Java 版建模为“一个方块 + 状态”的那些基岩版方块的 ID。燃烧中的熔炉是 `lit_furnace`：`bot.findBlock({ matching: bot.bedrock.blockVariants('furnace') })` 也能找到它（[方块变体](differences/world.md#block-variants)） |
| `bot.bedrock.resyncInventory()` | `() => Promise<boolean>` | 向服务器请求玩家物品栏（物品栏、盔甲、光标、副手）的服务端副本；应用完成后解析为 `true`，2 秒内无应答则为 `false`。机器人发现某个槽位过时时会自动执行此操作（[物品栏重新同步](differences/inventory.md#inventory-resync)） |
| `bot.bedrock.bedd` | `{ caps, supports(name), observed } \| undefined` | 仅在 `transport: 'bedd'`（由 Be.D.D. 托管的真实客户端）时存在：`caps` 将每个 BeDD 操作映射为 `'present'`、`'disabled'` 或 `'absent'`；`supports(name)` 表示某个机器人 API（`'dig'`、`'craft'`……）在这些操作下是否可用。所需操作缺失的物品堆叠或界面层面 API（`clickWindow`、`craft`、从快捷栏以外 `equip`、`creative`、`writeBook`、`updateSign`……）会抛出 / 拒绝 `BeddUnsupportedError`（`code: 'ERR_BEDD_UNSUPPORTED'`、`feature`、`missing`）（[BeDD](../guide/bedd.md#options)） |
| `bot.bedrock.bedd.observed` | `{ yaw: number, pitch: number, tick: number \| null } \| null` | 仅限 transport `'bedd'`：真实客户端最近一次发送的 `player_auth_input` 中的朝向（基岩版角度）和 tick；在第一次之前为 `null`。`bot.entity` 跟随同一回显（[自身状态](differences/bedd.md#self-state-from-echo)） |

## 内部实现 {#internals}

不属于 API（可能会变化），但对调试很有用：

- `bot._client`：bedrock-protocol 的 `Client`（`on(packetName, …)`、`queue`、`write`；数据包名称和字段采用基岩版的，
  见[协议文档](https://prismarinejs.github.io/minecraft-data/?v=bedrock_1.26.51&d=protocol)）。
- `bot._bedrock`：各插件共享的基岩版状态（输入队列、生命周期、物品堆叠请求、窗口……）。
