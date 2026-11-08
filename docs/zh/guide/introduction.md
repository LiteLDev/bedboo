# 简介

bedboo 是一个兼容 mineflayer API 的 Minecraft 基岩版机器人库。它提供与
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0 相同的 `createBot()`、相同的 `bot.*` 属性、方法和事件、
相同的 TypeScript 类型以及相同的插件系统，但它通过 [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol)
与**基岩版专用服务器**（BDS）通信。为 mineflayer 编写的机器人代码，包括 mineflayer-pathfinder 等生态插件，都可以直接在
BDS 上运行。

## 为什么

mineflayer 是用 JavaScript 编写 Minecraft 机器人的常用方式，拥有庞大的插件生态，但它面向的是 Java 版。基岩版使用不同的协议、
不同的方块和物品 ID、服务端权威的物品栏和方块破坏，以及自己的一套移动物理，因此 Java 版机器人及其插件无法加入基岩版服务器。
bedboo 在不发明新 API 的前提下弥合了这一差距：mineflayer 的文档、示例和插件都可以原样使用。

唯一的差异是 Java 版与基岩版之间的固有差异：基岩版的方块和物品名称、没有队伍、服务端权威的物品栏和方块破坏等等。每一项都列在
[基岩版差异](../reference/differences/index.md)中。

## 支持范围

- **服务器：** 从 1.26.42.1（2026 年 8 月 7 日）到 1.26.63.1（2026 年 11 月 6 日）的所有稳定版 BDS，分属 4 个协议族：
  1.26.40（protocol 2168）、1.26.45（2169）、1.26.51（2193，默认）和 1.26.60（2225）。`createBot({ version })` 接受协议族
  或 BDS 版本；`bot.version` 为协议族。见[支持的版本](../reference/versions/index.md)。
- **传输层：** 默认 RakNet；使用 `transport: 'nethernet'` 时为 NetherNet（BDS 的默认传输层）。
- **认证：** `auth: 'offline'`（默认）用于 `online-mode=false` 的服务器，`auth: 'microsoft'` 用于 Xbox Live。
- **真实客户端：** `transport: 'bedd'` 改为驱动由 [Be.D.D.](bedd.md) 托管的真实基岩版客户端。
- **运行时：** Node.js 24 或更高版本。RakNet 需要 x64（raknet-native 只提供 x64 预编译包）；NetherNet 是纯
  JavaScript 实现。

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
（见[你的第一个机器人](getting-started.md#get-the-code)）。

## 包

| 包 | |
|---|---|
| `bedboo` | 库本体 |
| `@bedboo/bedrock-data` | minecraft-data 的基岩版数据补充层，每个支持的协议族一份 |
| `@bedboo/agent` | 基于 bedboo 的脚本化生存智能体（[生存智能体](agent.md)） |

## 下一步

- [你的第一个机器人](getting-started.md)：服务器设置、安装、一个会走到你身边的机器人。
- [生态插件](plugins.md)：在基岩版上使用 pathfinder、pvp、collectblock 等插件。
- [API](../reference/api.md)：`createBot` 选项和基岩版扩展。
