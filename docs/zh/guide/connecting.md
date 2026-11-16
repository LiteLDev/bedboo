# 连接服务器

机器人加入基岩版专用服务器（BDS）时的服务器设置、版本、账号和传输层。从零写第一个机器人（获取代码、编写、运行）：见教程
[你的第一个 bedboo 机器人](https://levimc.org/tutorials/zh-Hans/automate/first-bedboo-bot/)。

## 服务器设置 {#prepare-the-server}

从 [minecraft.net](https://www.minecraft.net/download/server/bedrock) 获取的受支持 BDS（默认版本是 1.26.51.1）需要在
`server.properties` 中设置：

```properties
# 机器人默认通过 RakNet 加入（BDS 1.26.51 及更新版本默认使用 nethernet；见下文“传输层”）
transport=raknet
# 离线机器人（auth: 'offline'）没有 Xbox Live 身份
online-mode=false
# 或者保持为 true，并把机器人的名字加入 allowlist.json
allow-list=false
server-port=19132
# 可选：允许机器人执行命令（bot.chat('/time set day')）
allow-cheats=true
```

| 属性 | 值 | 原因 |
|---|---|---|
| `transport` | `raknet`，或在 `createBot` 中使用 `transport: 'nethernet'` 时为 `nethernet` | RakNet 是客户端的默认传输层 |
| `online-mode` | `auth: 'offline'` 时为 `false`；`true` 需要 `auth: 'microsoft'` | 离线机器人没有 Xbox Live 身份 |
| `allow-list` | `false`，或把机器人的名字加入 `allowlist.json` | 否则机器人会被踢出 |
| `server-port` | 传给 `createBot` 的 `port` | |

`online-mode=false` 允许任何人以任意名字加入：请把这样的服务器放在私有网络中，或者使用 `online-mode=true` 配合
[Microsoft 账号](#microsoft-accounts)。在 `transport=raknet` 且 `enable-lan-visibility=true` 时，BDS 还会额外绑定
19132/19133 端口；在同一台主机上运行多个服务器时请关闭它。

启动服务器，等待日志中出现 `Server started.`。紧随其后的 `TRANSPORT TYPE ERROR … not set to NetherNet` 信息块是 BDS
在提示原版客户端可能很快需要 NetherNet；RakNet 客户端可以正常连接。

## 其他版本 {#versions}

服务器不是 1.26.51 时，把它的 BDS 版本或协议族传给 `createBot`：

```js
const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', version: '1.26.62.1' })
// bot.version === '1.26.60'，bot.protocolVersion === 2225
```

各协议族、其 BDS 版本以及每个 BDS 默认的传输层列在[支持的版本](../reference/versions/index.md#matrix)中。bedboo
不认识的版本会抛出 `ERR_BEDBOO_VERSION`，并列出支持的版本。机器人的代码在所有版本上都相同。

## 权限、作弊与命令 {#commands}

- `bot.chat('/…')` 发送的是命令请求（基岩版没有通过聊天输入的命令）。命令需要 `allow-cheats=true` 和管理员权限：在 BDS 上
  玩家无法给自己 op，因此请在服务器控制台中给机器人 op（`op Bot`），或者设置 `default-player-permission-level=operator`。
- 命令结果以 `message` 事件的形式到达（基岩版的 `command_output`，每行一个）。
- `/give`、`/replaceitem`、`/tp` 等命令的效果对机器人可见，与 Java 版一致（`playerCollect`、`forcedMove`……）。

## Microsoft（Xbox Live）账号 {#microsoft-accounts}

对于 `online-mode=true` 的服务器，请使用拥有 Minecraft 的 Microsoft 账号：

```js
const bot = bedboo.createBot({
  host: 'my.server.example',
  port: 19132,
  username: 'me@example.com', // 令牌缓存使用的名字
  auth: 'microsoft',
  profilesFolder: './.auth-cache' // 可选；选项与 mineflayer 相同（prismarine-auth）
})
```

首次运行会打印一个设备码链接（可以用 `onMsaCode` 自行处理）；之后令牌会被缓存。游戏内名称为该账号的玩家代号（gamertag）。
`auth: 'mojang'` 在基岩版上不存在，会抛出错误。

## 传输层：RakNet 或 NetherNet {#transports}

BDS 1.26.51 及更新版本默认使用 **NetherNet**（WebRTC 数据通道），RakNet 需通过 `transport=raknet` 启用；1.26.40 和
1.26.45 仍默认 RakNet。Mojang 已表示将移除 RakNet；BDS 1.26.60 至 1.26.63.1 仍提供它。除非另行指定，bedboo 都通过 RakNet 连接，因为 bedrock-protocol 支持它已有多年。要使用
NetherNet，请以 `transport=nethernet` 启动 BDS，并将传输层传给 `createBot`：

```js
const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', transport: 'nethernet' })
```

- 信令走的是**服务器端口上的 HTTP**（`POST http://<host>:<port>/v1/join/<id>`），因此在 `enable-lan-visibility=false`
  时也能工作，也可以通过转发 `server-port`（TCP）端口使用；之后的媒体流走 UDP（BDS 的 `server-udp-ports`）。
  bedrock-protocol 的其他信令模式也会透传，但测试较少：局域网发现（UDP 7551，需要 `enable-lan-visibility=true`），使用
  `nethernet: { signalling: 'lan' }`；以及 Xbox 信令，使用 `nethernet: { signalling: 'services', networkId }` +
  `auth: 'microsoft'`。
- **服务器密钥。** BDS 会用一个身份密钥对应答进行签名。在明文 HTTP 上没有任何机制为该密钥背书，因此默认接受任意密钥，
  这与 RakNet 提供的信任程度相同。可以固定密钥以拒绝冒充者：`nethernet: { serverKey: 'sha256:<hex>' }`；
  `nethernet: { onServerKey: (fingerprint, url) => true | false }` 让你自行决定（并展示可用于固定的指纹）。HTTPS 信令
  URL（`nethernet: { url: 'https://…' }`）通过 TLS 获得信任。
- 机器人的 API 在两种传输层上完全相同。详情：[连接与版本](../reference/differences/connection.md#transport)。

## 故障排查 {#troubleshooting}

| 现象 | 原因 |
|---|---|
| `Connect timed out` | 主机或端口错误、服务器的 `transport` 与机器人不一致，或防火墙丢弃了 UDP（RakNet）/ TCP（NetherNet 信令） |
| 登录后立即 `kicked` | `allow-list=true` 但机器人不在 `allowlist.json` 中，或 `online-mode=true` 却使用 `auth: 'offline'`（`reason` 会说明是哪一种） |
| 以客户端 / 服务器版本过旧为由被踢出 | 服务器的协议族与机器人的 `version` 不同（[其他版本](#versions)） |
| RakNet 后端加载失败 | 不是 x64，或依赖是在工作区之外安装的（缺少 raknet-native 补丁） |
| 命令被拒绝 | 在控制台给机器人 op，并开启作弊（`allow-cheats=true`） |
| NetherNet：`Untrusted Nethernet server key` | `serverKey` 固定值与服务器的密钥不匹配（或 `onServerKey` 返回了 false） |
| NetherNet：`fetch failed`（`ECONNREFUSED`） | 服务器运行的是 RakNet，或 BDS 无法打开 TCP 信令监听（此时日志中没有 `Accepting clients on …` 一行；端口被其他进程占用） |

更多值得了解的 BDS 行为（加入流程、区块加载、控制台输出）汇总在 [BDS 笔记](../reference/bds.md)中。
