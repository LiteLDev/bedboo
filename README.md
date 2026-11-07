# bedboo

[![CI](https://github.com/LiteLDev/bedboo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LiteLDev/bedboo/actions/workflows/ci.yml)
[![Docs](https://img.shields.io/badge/docs-docs.levimc.org%2Fbedboo-blue.svg?style=flat-square)](https://docs.levimc.org/bedboo/)
[![license: LGPL-3.0-only](https://img.shields.io/badge/license-LGPL--3.0--only-blue.svg?style=flat-square)](COPYING.LESSER)

A Minecraft Bedrock Edition bot library with a mineflayer-compatible API.

bedboo offers the same `createBot()`, `bot.*` properties, methods and events, TypeScript types and plugin system as
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0, but talks to a **Bedrock Dedicated Server** (BDS)
through [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol). Bots written for mineflayer, and
mineflayer plugins such as mineflayer-pathfinder, run against BDS. The only differences are inherent Java/Bedrock
ones, and each of them is documented.

- Supported server: **BDS 1.26.51.x** (protocol 2193; 1.26.52.x is wire-identical).
- Transport: **RakNet** by default; **NetherNet** with `transport: 'nethernet'`; a real client hosted by
  [Be.D.D.](https://docs.levimc.org/BeDD/) with `transport: 'bedd'`.
- Auth: `auth: 'offline'` (default) or `auth: 'microsoft'` (Xbox Live).

**Documentation: https://docs.levimc.org/bedboo/**

## Install

bedboo is not published to npm yet: a few fixes to its dependencies are pnpm patches in [`patches/`](patches) that
apply inside this workspace, so use it from the monorepo (Node.js ≥ 24; RakNet needs x64):

```sh
git clone https://github.com/LiteLDev/bedboo && cd bedboo
corepack enable && pnpm install
```

Then add your bot as a workspace package; see [Your first bot](https://docs.levimc.org/bedboo/guide/getting-started).

## Usage

Bot code written for mineflayer runs unchanged; only the `require` changes:

```js
const bedboo = require('bedboo') // instead of require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = bedboo.createBot({
  host: '127.0.0.1', // your BDS
  port: 19132,
  username: 'Bot',
  auth: 'offline' // 'microsoft' to sign in with Xbox Live (online-mode=true servers)
})

bot.loadPlugin(pathfinder)

bot.on('chat', async (username, message) => {
  if (username === bot.username) return
  if (message !== 'come') return bot.chat(message) // echo

  const target = bot.players[username]?.entity
  if (!target) return bot.chat("I can't see you")
  const { x, y, z } = target.position
  bot.pathfinder.setMovements(new Movements(bot))
  try {
    await bot.pathfinder.goto(new goals.GoalNear(x, y, z, 1))
    bot.chat('here!')
  } catch (err) {
    bot.chat(`I can't get there: ${err.message}`) // no path, or a new "come" changed the goal
  }
})

bot.on('kicked', console.log)
bot.on('error', console.log)
```

The runnable copy is [`packages/bedboo/examples/readme_quickstart.js`](packages/bedboo/examples/readme_quickstart.js):
`node packages/bedboo/examples/readme_quickstart.js <host> <port>`. The server needs `transport=raknet`,
`online-mode=false` and `allow-list=false` in `server.properties` for this bot; see
[Your first bot](https://docs.levimc.org/bedboo/guide/getting-started#prepare-the-server).

## Packages

| package | |
|---|---|
| [`packages/bedboo`](packages/bedboo) | the bedboo library |
| [`packages/bedrock-data`](packages/bedrock-data) | `@bedboo/bedrock-data`: the BDS 1.26.51 data overlay for minecraft-data |
| [`packages/agent`](packages/agent) | `@bedboo/agent`: a scripted survival agent built on bedboo |
| [`docs`](docs) | the documentation site |

## Contributing

Questions and bug reports go to [GitHub issues](https://github.com/LiteLDev/bedboo/issues); pull requests are welcome.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Acknowledgements

bedboo builds on, and partly adapts, the work of others:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — MIT, Copyright (c) 2013 Andrew Kelley. Plugins adapted
  from it keep an attribution header.
- [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol), [node-nethernet](https://github.com/PrismarineJS/node-nethernet),
  prismarine-auth, -block, -chat, -chunk, -entity, -item, -nbt, -physics (forked in `lib/physics/`), -recipe,
  -registry, -windows, -world, [minecraft-data](https://github.com/PrismarineJS/minecraft-data) — MIT, PrismarineJS
  contributors. The Bedrock 1.26.51 blocks, block states and items come from minecraft-data
  [PR #1335](https://github.com/PrismarineJS/minecraft-data/pull/1335) (MIT).
- [CloudburstMC/Data](https://github.com/CloudburstMC/Data) — Apache License 2.0, Copyright CloudburstMC: block
  runtime ids, collision boxes, friction, foods, creative items, biomes (see
  [packages/bedrock-data/NOTICE.md](packages/bedrock-data/NOTICE.md)).
- [pmmp/BedrockData](https://github.com/pmmp/BedrockData) — CC0 1.0: biome ids and item tags.
- [Sandertv/gophertunnel](https://github.com/Sandertv/gophertunnel) — MIT: sound event and effect ids.

## License

[LGPL-3.0-only](COPYING.LESSER) © 2026 LiteLDev and bedboo contributors

bedboo is licensed under the GNU Lesser General Public License v3.0 only. See [COPYING](COPYING) and
[COPYING.LESSER](COPYING.LESSER) for the full terms. Code and data adapted from other projects keep their original
licenses and notices (see [Acknowledgements](#acknowledgements)).

Minecraft is a trademark of Mojang Synergies AB; bedboo is not affiliated with Mojang or Microsoft.
