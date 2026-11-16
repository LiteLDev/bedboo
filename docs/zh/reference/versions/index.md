# 支持的版本

bedboo 支持从 1.26.42.1（2026 年 8 月 7 日）到 1.26.63.1（2026 年 11 月 6 日）的所有稳定版 Bedrock Dedicated Server（BDS），
共 11 个版本，分属 4 个协议族。
**协议族**是 minecraft-data / bedrock-protocol 的基岩版版本键，例如 `'1.26.51'`。同一协议族的所有 BDS 版本使用相同的网络协议，
并共用一套游戏数据（`@bedboo/bedrock-data` 的 `data/<协议族>/`）。`bot.version` 就是协议族。版本表位于
`packages/bedboo/lib/bedrock/versions.js`（`FAMILIES`）。某个协议族同时有 `FAMILIES` 条目且 `@bedboo/bedrock-data` 提供其数据时，该
协议族即视为已测试：它会出现在 `testedVersions` 中，`createBot` 也会接受它。

## 版本矩阵 {#matrix}

| 协议族（`bot.version`） | 协议 | BDS 版本（发布日期） | BDS 默认 `transport` | 说明 |
|---|---|---|---|---|
| `'1.26.40'` | 2168 | 1.26.42.1（2026-08-07）、1.26.43.1（2026-08-07）、1.26.44.3（2026-08-14） | `raknet` | [Bedrock 1.26.40](1.26.40.md) |
| `'1.26.45'` | 2169 | 1.26.45.1（2026-08-28） | `raknet` | [Bedrock 1.26.45](1.26.45.md) |
| `'1.26.51'`（默认） | 2193 | 1.26.50.5（2026-09-15）、1.26.51.1（2026-09-15）、1.26.52.3（2026-09-25） | `nethernet` | [Bedrock 1.26.51](1.26.51.md) |
| `'1.26.60'` | 2225 | 1.26.60.6（2026-10-27）、1.26.61.1（2026-10-29）、1.26.62.1（2026-11-04）、1.26.63.1（2026-11-06） | `nethernet` | [Bedrock 1.26.60](1.26.60.md) |

在把一个协议族标记为已测试之前，表中的每个 BDS 版本都以原生方式启动，并由一个机器人实际加入。机器人检查了出生、方块与物品、物品栏、
聊天、行走、挖掘与放置、实体以及命令树。CI 对每个协议族各运行一次单元测试。本参考的其余部分（[基岩版差异](../differences/index.md)
和 [BDS 备忘](../bds.md)）是在默认版本 BDS 1.26.51.1 上观察得出的。各协议族页面列出了该协议族的不同之处。

不支持预览版、测试版以及早于 1.26.42.1 的版本。不在表中的 BDS 版本也可能使用这些协议之一，但 bedboo 未针对它做过检查。

## 选择版本 {#choosing}

把服务器的版本传给 `createBot`。协议族和具体的 BDS 版本都可以，两者得到的机器人相同：

```js
const bot = bedboo.createBot({
  host: '127.0.0.1',
  port: 19132,
  username: 'Bot',
  version: '1.26.62.1', // 或 '1.26.60'
  transport: 'nethernet' // BDS 1.26.51 及更新版本默认 transport=nethernet
})
bot.once('spawn', () => console.log(bot.version, bot.protocolVersion)) // 1.26.60 2225
```

- **默认值：** 不传 `version`，或传 `version: false` 时，机器人使用 **1.26.51**。bedboo 不会检测服务器的版本（默认不 ping 就直接加入，
  因为关闭局域网可见性的 BDS 不响应 ping）。连接其他协议族的服务器时必须指定版本。
- **可接受的值：** `testedVersions` 中的协议族、它的任一 BDS 版本，或者带 `bedrock_` 前缀的上述两种写法。其他任何值都会像
  mineflayer 遇到不支持的版本时一样抛出 `Error`，其 `code` 为 `'ERR_BEDBOO_VERSION'`，消息中列出支持的协议族和 BDS 版本。
- **协议族不匹配：** BDS 会拒绝其他协议的登录，机器人以客户端版本过旧或服务器版本过旧为由被 `kicked`。
- **随版本变化的内容：** `bot.version`（协议族）、`bot.protocolVersion`、`bot.majorVersion`（`'1.26'`）、`bot.registry`
  （minecraft-data 的 `bedrock_<协议族>` 加上该协议族的 `@bedboo/bedrock-data` 补充层）和 `bot.supportFeature(...)`。
  特性表按协议族取值，例如 1.26.60 上的 `actionPacketsHaveHand` 以及 `defaultTransportIsNethernet`。
- **模块导出：** `testedVersions` 按从旧到新的顺序列出已测试的协议族（`['1.26.40', '1.26.45', '1.26.51', '1.26.60']`）。
  `oldestSupportedVersion` 为 `'1.26.40'`，`latestSupportedVersion` 为 `'1.26.60'`。`supportFeature(feature, version)`
  接受协议族、BDS 版本或不传版本（1.26.51）。

各协议族之间的差异在于少量新增的方块、物品和实体，部分数据包字段，命令参数类型的编号，以及默认传输层。bedboo 按协议族处理这些差异，
机器人的代码无需改动。各协议族页面列出了具体差异。

## 针对某个版本测试 {#testing}

单元测试默认使用 1.26.51。`BEDBOO_VERSION` 可以选择其他协议族或 BDS 版本：

```sh
pnpm test                              # 1.26.51
BEDBOO_VERSION=1.26.60 pnpm test       # 协议族
BEDBOO_VERSION=1.26.44.3 pnpm test     # BDS 版本，映射到其协议族（1.26.40）
```

模拟对象、序列化器、注册表和数据包录制（`packages/bedboo/test/fixtures/<协议族>/`）都随所选版本切换。需要该协议族尚无的录制的
测试会被跳过，并打印原因。目前只有 1.26.51 有加入过程的录制，因此在其他协议族上，加入回放测试会被跳过；这部分改由每个 BDS 版本的
实机加入来覆盖。CI（`.github/workflows/ci.yml`）在其 `bedrock` 矩阵中为每个协议族各运行一次 lint、单元测试和类型检查。手动运行该
工作流时可以传入 `version` 参数。

## 添加版本 {#adding}

添加 BDS 版本或协议族属于维护者工作：步骤（bedrock-data 固定版本、探测与生成、`FAMILIES` 条目、CI 矩阵、这些页面）见
[CONTRIBUTING.md](https://github.com/LiteLDev/bedboo/blob/main/CONTRIBUTING.md#adding-a-version)（英文）。
