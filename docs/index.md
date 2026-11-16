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
      text: Start here
      link: https://levimc.org/tutorials/automate/first-bedboo-bot/
    - theme: alt
      text: API
      link: /reference/api

features:
  - title: The mineflayer API
    details: createBot(), every bot.* property, method and event, and the TypeScript types of mineflayer 4.39.0, with the same arguments, errors and event order.
    link: /reference/api
  - title: Plugins run unchanged
    details: mineflayer-pathfinder, -pvp, -collectblock, -tool, -armor-manager and -auto-eat load with bot.loadPlugin() and work on Bedrock.
    link: /guide/plugins
  - title: RakNet and NetherNet
    details: Joins every stable BDS from 1.26.42.1 to 1.26.63.1 (four protocol families) over RakNet or NetherNet, offline or with a Microsoft account.
    link: /guide/connecting
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

bedboo is a Minecraft Bedrock Edition bot library with a mineflayer-compatible API. It offers the same `createBot()`,
the same `bot.*` properties, methods and events, the same TypeScript types and the same plugin system as
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0, but it talks to a **Bedrock Dedicated Server** (BDS)
through [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol). Bot code written for mineflayer,
including ecosystem plugins such as mineflayer-pathfinder, runs against BDS.

```js
const bedboo = require('bedboo') // instead of require('mineflayer')

const bot = bedboo.createBot({ host: '127.0.0.1', port: 19132, username: 'Bot', auth: 'offline' })
bot.on('chat', (username, message) => {
  if (username !== bot.username) bot.chat(message)
})
```

::: tip Start here
New to bedboo? The tutorial [Your first bedboo bot](https://levimc.org/tutorials/automate/first-bedboo-bot/) gets the
code, prepares a server and connects a bot that walks to you.
:::

## Who it is for

- **mineflayer users** who want their bots and plugins on a Bedrock server: mineflayer's documentation, examples and
  plugins apply unchanged.
- **Server and mod authors** who test a BDS (or a [LeviLamina](https://levimc.org/LeviLamina/) server) with scripted
  players.
- **Client mod authors** who drive a real Minecraft client through [Be.D.D.](/guide/bedd) with the same bot code.

## Why

mineflayer is the usual way to write Minecraft bots in JavaScript and it has a large plugin ecosystem, but it targets
Java Edition. Bedrock Edition uses a different protocol, different block and item ids, server-authoritative inventory
and block breaking, and its own movement physics, so Java bots and their plugins cannot join a Bedrock server. bedboo
closes that gap without inventing a new API.

The only differences are inherent Java/Bedrock ones: Bedrock block and item names, no teams, server-authoritative
inventory and block breaking, and so on. Each of them is listed in the [Bedrock differences](/reference/differences/).

## What is supported

- **Servers:** every stable BDS from 1.26.42.1 (August 7, 2026) to 1.26.63.1 (November 6, 2026), in four protocol
  families: 1.26.40 (protocol 2168), 1.26.45 (2169), 1.26.51 (2193, the default) and 1.26.60 (2225).
  `createBot({ version })` takes the family or the BDS build; `bot.version` is the family. See
  [Supported versions](/reference/versions/).
- **Transports:** RakNet by default; NetherNet (BDS's default transport) with `transport: 'nethernet'`
  ([Connecting to a server](/guide/connecting#transports)).
- **Auth:** `auth: 'offline'` (default) for `online-mode=false` servers, `auth: 'microsoft'` for Xbox Live.
- **Real client:** `transport: 'bedd'` drives a real Bedrock client hosted by [Be.D.D.](/guide/bedd) instead.
- **Runtime:** Node.js 24 or newer. RakNet needs x64 (raknet-native ships x64 prebuilds only); NetherNet is pure
  JavaScript.

## Where it fits

| Project | Role |
|---|---|
| [mineflayer](https://github.com/PrismarineJS/mineflayer) | the API bedboo implements, and the source of its plugins |
| [Be.D.D.](https://levimc.org/BeDD/) | hosts a real Minecraft Bedrock client that bedboo drives with `transport: 'bedd'` ([guide](/guide/bedd)) |
| [LeviLamina](https://levimc.org/LeviLamina/) | the mod loader for BDS and the client: a LeviLamina server is a BDS that bedboo joins like any other |

## How it is built

- [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) for the connection (RakNet through
  raknet-native, NetherNet through [node-nethernet](https://github.com/PrismarineJS/node-nethernet)) and
  prismarine-auth for Xbox Live sign-in;
- the prismarine-* libraries (block, chat, chunk, entity, item, nbt, recipe, registry, windows, world) and
  [minecraft-data](https://github.com/PrismarineJS/minecraft-data), with `@bedboo/bedrock-data` as the Bedrock data
  overlay (one per protocol family);
- a Bedrock movement engine forked from prismarine-physics;
- mineflayer's own plugins, adapted one file per plugin, each keeping its attribution header.

Small fixes to those dependencies are pnpm patches in the repository's `patches/` folder, which is why bedboo is used
from its monorepo for now (the [tutorial](https://levimc.org/tutorials/automate/first-bedboo-bot/) shows how).

## Packages

| package | |
|---|---|
| `bedboo` | the library |
| `@bedboo/bedrock-data` | the Bedrock data overlays for minecraft-data, one per supported family |
| `@bedboo/agent` | a scripted survival agent built on bedboo ([Survival agent](/guide/agent)) |

## The name

bedboo (Bedrock + Bangboo) is named after the Bangboo of Zenless Zone Zero: a Bangboo goes into the Hollows on a
Proxy's behalf, your bot goes into a Bedrock server on yours.
