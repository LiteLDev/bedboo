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
      text: 开始使用
      link: /zh/guide/introduction
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
    details: 默认通过 RakNet 加入 BDS 1.26.51，也可使用 NetherNet；支持离线模式或 Microsoft 账号。
    link: /zh/guide/getting-started
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

```js
const bedboo = require('bedboo') // 替代 require('mineflayer')

const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

::: tip 从这里开始
先阅读[简介](/zh/guide/introduction)，然后将[你的第一个机器人](/zh/guide/getting-started)连接到 BDS。
:::
