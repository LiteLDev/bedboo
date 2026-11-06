---
layout: home

hero:
  name: bedboo
  text: Bedrock bots with the mineflayer API
  tagline: A Minecraft Bedrock Edition bot library with a mineflayer-compatible API. Your mineflayer bot and its plugins join a Bedrock Dedicated Server unchanged.
  image:
    src: /logo.png
    alt: bedboo
  actions:
    - theme: brand
      text: Get started
      link: /guide/introduction
    - theme: alt
      text: API
      link: /reference/api
    - theme: alt
      text: GitHub
      link: https://github.com/LiteLDev/bedboo

features:
  - title: The mineflayer API
    details: createBot(), every bot.* property, method and event, and the TypeScript types of mineflayer 4.39.0, with the same arguments, errors and event order.
    link: /reference/api
  - title: Plugins run unchanged
    details: mineflayer-pathfinder, -pvp, -collectblock, -tool, -armor-manager and -auto-eat load with bot.loadPlugin() and work on Bedrock.
    link: /guide/plugins
  - title: RakNet and NetherNet
    details: Joins BDS 1.26.51 over RakNet by default or over NetherNet, offline or with a Microsoft account.
    link: /guide/getting-started
  - title: Every difference documented
    details: Bedrock block names, server-authoritative inventory, digging and movement. Each inherent Java/Bedrock difference is written down.
    link: /reference/differences/
  - title: Drive a real client
    details: With transport 'bedd' the same script drives a real Minecraft Bedrock client hosted by Be.D.D.
    link: /guide/bedd
  - title: A survival agent included
    details: "@bedboo/agent plays survival from wood to diamonds, builds and fights, all through the public API."
    link: /guide/agent
---

```js
const bedboo = require('bedboo') // instead of require('mineflayer')

const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

::: tip Start here
Read the [introduction](/guide/introduction), then connect [your first bot](/guide/getting-started) to a BDS.
:::
