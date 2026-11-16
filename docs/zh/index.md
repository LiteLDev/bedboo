---
layout: home

hero:
  name: bedboo
  text: 用 mineflayer API 编写基岩版机器人
  tagline: 兼容 mineflayer API 的 Minecraft 基岩版机器人库。你的 mineflayer 机器人及其插件无需修改即可加入基岩版专用服务器（BDS）。
  image:
    src: /logo.png
    alt: bedboo
  actions:
    - theme: brand
      text: 从这里开始
      link: https://levimc.org/tutorials/zh-Hans/automate/first-bedboo-bot/
    - theme: alt
      text: API
      link: /zh/reference/api

features:
  - title: mineflayer API
    details: createBot()、所有 bot.* 属性、方法和事件，以及 mineflayer 4.39.0 的 TypeScript 类型，参数、错误和事件顺序完全一致。
    link: /zh/reference/api
  - title: 插件无需修改
    details: mineflayer-pathfinder、-pvp、-collectblock、-tool、-armor-manager 和 -auto-eat 通过 bot.loadPlugin() 加载，在基岩版上照常工作。
    link: /zh/guide/plugins
  - title: RakNet 与 NetherNet
    details: 可加入 1.26.42.1 至 1.26.63.1 的所有稳定版 BDS（4 个协议族），通过 RakNet 或 NetherNet，支持离线模式或 Microsoft 账号。
    link: /zh/guide/connecting
  - title: 差异逐条记录
    details: 基岩版方块名称、服务端权威的物品栏、挖掘和移动。每一处 Java 版与基岩版之间的固有差异都有文档说明。
    link: /zh/reference/differences/
  - title: 驱动真实客户端
    details: 使用 transport 'bedd' 时，同一个脚本可以驱动由 Be.D.D. 托管的真实 Minecraft 基岩版客户端。
    link: /zh/guide/bedd
  - title: 内置生存智能体
    details: "@bedboo/agent 能玩生存模式：从木头一路到钻石，还会建造和战斗，全部通过公开 API 完成。"
    link: /zh/guide/agent
---

bedboo 是一个兼容 mineflayer API 的 Minecraft 基岩版机器人库。它提供与
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0 相同的 `createBot()`、相同的 `bot.*` 属性、方法和事件、
相同的 TypeScript 类型以及相同的插件系统，但它通过 [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol)
与**基岩版专用服务器**（BDS）通信。为 mineflayer 编写的机器人代码，包括 mineflayer-pathfinder 等生态插件，都可以直接在
BDS 上运行。

```js
const bedboo = require('bedboo') // 替代 require('mineflayer')

const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

::: tip 从这里开始
第一次用 bedboo？教程[你的第一个 bedboo 机器人](https://levimc.org/tutorials/zh-Hans/automate/first-bedboo-bot/)带你
获取代码、准备服务器，并连接一个会走到你身边的机器人。
:::

## 给谁用

- **mineflayer 用户**：想让自己的机器人和插件进入基岩版服务器；mineflayer 的文档、示例和插件都可以原样使用。
- **服务器和模组作者**：用脚本化的玩家测试 BDS（或 [LeviLamina](https://levimc.org/LeviLamina/zh-Hans/) 服务器）。
- **客户端模组作者**：通过 [Be.D.D.](/zh/guide/bedd) 用同一套机器人代码驱动真实的 Minecraft 客户端。

## 为什么

mineflayer 是用 JavaScript 编写 Minecraft 机器人的常用方式，拥有庞大的插件生态，但它面向的是 Java 版。基岩版使用不同的协议、
不同的方块和物品 ID、服务端权威的物品栏和方块破坏，以及自己的一套移动物理，因此 Java 版机器人及其插件无法加入基岩版服务器。
bedboo 在不发明新 API 的前提下弥合了这一差距。

唯一的差异是 Java 版与基岩版之间的固有差异：基岩版的方块和物品名称、没有队伍、服务端权威的物品栏和方块破坏等等。每一项都列在
[基岩版差异](/zh/reference/differences/)中。

## 支持范围

- **服务器：** 从 1.26.42.1（2026 年 8 月 7 日）到 1.26.63.1（2026 年 11 月 6 日）的所有稳定版 BDS，分属 4 个协议族：
  1.26.40（protocol 2168）、1.26.45（2169）、1.26.51（2193，默认）和 1.26.60（2225）。`createBot({ version })` 接受协议族
  或 BDS 版本；`bot.version` 为协议族。见[支持的版本](/zh/reference/versions/)。
- **传输层：** 默认 RakNet；使用 `transport: 'nethernet'` 时为 NetherNet（BDS 的默认传输层）
  （[连接服务器](/zh/guide/connecting#transports)）。
- **认证：** `auth: 'offline'`（默认）用于 `online-mode=false` 的服务器，`auth: 'microsoft'` 用于 Xbox Live。
- **真实客户端：** `transport: 'bedd'` 改为驱动由 [Be.D.D.](/zh/guide/bedd) 托管的真实基岩版客户端。
- **运行时：** Node.js 24 或更高版本。RakNet 需要 x64（raknet-native 只提供 x64 预编译包）；NetherNet 是纯
  JavaScript 实现。

## 在生态里的位置

| 项目 | 作用 |
|---|---|
| [mineflayer](https://github.com/PrismarineJS/mineflayer) | bedboo 实现的 API，也是其插件的来源 |
| [Be.D.D.](https://levimc.org/BeDD/zh-Hans/) | 托管真实的 Minecraft 基岩版客户端，bedboo 用 `transport: 'bedd'` 驱动它（[指南](/zh/guide/bedd)） |
| [LeviLamina](https://levimc.org/LeviLamina/zh-Hans/) | BDS 和客户端的模组加载器：LeviLamina 服务器就是 BDS，bedboo 照常加入 |

## 构建方式

- 使用 [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) 建立连接（RakNet 基于
  raknet-native，NetherNet 基于 [node-nethernet](https://github.com/PrismarineJS/node-nethernet)），使用
  prismarine-auth 登录 Xbox Live；
- prismarine-* 系列库（block、chat、chunk、entity、item、nbt、recipe、registry、windows、world）和
  [minecraft-data](https://github.com/PrismarineJS/minecraft-data)，并以 `@bedboo/bedrock-data` 作为基岩版
  数据补充层（每个协议族一份）；
- 一个从 prismarine-physics 分叉而来的基岩版移动引擎；
- mineflayer 自身的插件，每个插件对应一个改编文件，各自保留原有的署名头。

对这些依赖的小修复以 pnpm 补丁的形式放在仓库的 `patches/` 目录中，因此目前需要在 bedboo 的 monorepo 中使用它
（[教程](https://levimc.org/tutorials/zh-Hans/automate/first-bedboo-bot/)里有做法）。

## 包

| 包 | |
|---|---|
| `bedboo` | 库本体 |
| `@bedboo/bedrock-data` | minecraft-data 的基岩版数据补充层，每个支持的协议族一份 |
| `@bedboo/agent` | 基于 bedboo 的脚本化生存智能体（[生存智能体](/zh/guide/agent)） |

## 名字

bedboo（Bedrock + Bangboo）得名自《绝区零》的邦布：邦布替绳匠深入空洞，你的机器人替你进入基岩版服务器。
