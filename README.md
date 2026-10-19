# bedboo — mineflayer for Minecraft: Bedrock Edition

**`mineflayer-bedrock`** is [mineflayer](https://github.com/PrismarineJS/mineflayer) for Bedrock: the same
`createBot()`, the same `bot.*` properties, methods and events, the same TypeScript types and the same plugin system
as mineflayer **4.39.0**, but it talks to a **Bedrock Dedicated Server** (BDS) through
[bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol). Code written for mineflayer — including
ecosystem plugins such as mineflayer-pathfinder — runs against BDS. The only differences are inherent Java/Bedrock
ones (Bedrock block and item names, no teams, server-authoritative inventory and block breaking, …), and each of them
is documented.

- Supported server: **BDS 1.26.51.x** (protocol 2193; 1.26.52.x is wire-identical). `bot.version` is `1.26.51`.
- Transport: **RakNet** by default; **NetherNet** (BDS's default transport) with `transport: 'nethernet'`.
- Auth: `auth: 'offline'` (default) for `online-mode=false` servers, `auth: 'microsoft'` for Xbox Live.
- Node.js ≥ 24, x64 (the RakNet backend ships x64 prebuilds only; see [docs/testing.md](docs/testing.md#transport-spike-u0-2026-10-18--result-raknet-works)).

## Quick start

```js
const mineflayer = require('mineflayer-bedrock') // instead of require('mineflayer')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = mineflayer.createBot({
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

That is the whole difference from a Java bot: the `require`. The runnable copy is
[`packages/mineflayer-bedrock/examples/readme_quickstart.js`](packages/mineflayer-bedrock/examples/readme_quickstart.js)
(`node packages/mineflayer-bedrock/examples/readme_quickstart.js <host> <port>`); an end-to-end test runs it against a
real BDS on every test run.

Step by step, including the server setup: **[docs/getting-started.md](docs/getting-started.md)**.

## Install

mineflayer-bedrock is not published to npm yet. It depends on a few small fixes to its dependencies
(bedrock-protocol, nethernet, raknet-native, prismarine-*) that live in [`patches/`](patches) and that pnpm applies
only inside this workspace, so use it from the monorepo:

```sh
git clone https://github.com/LiteLDev/bedboo && cd bedboo
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install   # Node >= 24; pnpm is pinned through corepack
```

Then add your bot as a workspace package — `packages/my-bot/package.json` with
`"dependencies": { "mineflayer-bedrock": "workspace:*", "mineflayer-pathfinder": "2.4.5" }` (plus any other plugin
you use), then `corepack pnpm install` — see [docs/getting-started.md](docs/getting-started.md#2-get-the-code). For a
quick experiment, a script in `packages/mineflayer-bedrock/examples/` resolves `mineflayer-bedrock` and
`mineflayer-pathfinder` without any setup.

To vendor it into another pnpm project, copy `patches/`, the `overrides`, `packageExtensions` and
`patchedDependencies` of [`pnpm-workspace.yaml`](pnpm-workspace.yaml), and `packages/mineflayer-bedrock` +
`packages/bedrock-data`. (`corepack pnpm --filter mineflayer-bedrock pack` builds a tarball with the right metadata,
but without the patched dependencies it cannot join a server.)

## A server to connect to

Any BDS 1.26.51.x works. For a quick local one, the repository's Docker harness downloads the official server once and
starts isolated instances:

```sh
corepack pnpm bds pull                           # once: Docker image + BDS 1.26.51.1 (verified checksum)
corepack pnpm bds up --name mybds --gamemode survival
#   bedboo-mybds ready on 127.0.0.1:41000 …      → createBot({ host: '127.0.0.1', port: 41000, … })
corepack pnpm bds cmd mybds op Bot               # console commands
corepack pnpm bds down mybds
```

Your own BDS needs, in `server.properties`:

| property | value | why |
|---|---|---|
| `transport` | `raknet` (or `nethernet` with `transport: 'nethernet'` in `createBot`) | RakNet is the default client transport |
| `online-mode` | `false` for `auth: 'offline'`; `true` needs `auth: 'microsoft'` | offline bots have no Xbox Live identity |
| `allow-list` | `false`, or add the bot's name to `allowlist.json` | otherwise the bot is kicked |
| `server-port` | the `port` you pass to `createBot` | |

[docs/getting-started.md](docs/getting-started.md) has the details (permissions, cheats, NetherNet, Microsoft auth).

### RakNet or NetherNet?

BDS 1.26.51 defaults to **NetherNet** (WebRTC) and still ships RakNet behind `transport=raknet`; Mojang has announced
that RakNet will go away, possibly as soon as BDS 26.60. mineflayer-bedrock defaults to RakNet because it is the
transport bedrock-protocol has supported for years and the one the test suite runs on; NetherNet is supported with
`createBot({ transport: 'nethernet' })`, which joins over HTTP signalling on the server port (no LAN discovery needed)
— see [docs/getting-started.md](docs/getting-started.md#nethernet).

## Ecosystem plugins

Plugins written for mineflayer load with `bot.loadPlugin()` unchanged: mineflayer-pathfinder, mineflayer-pvp,
mineflayer-collectblock, mineflayer-tool, mineflayer-armor-manager and mineflayer-auto-eat are pinned in the
workspace, and the few Java assumptions they make (the Java `entity_status` packet, Java enchantment NBT, …) are
patched in `patches/`. A plugin that only uses mineflayer's public API needs nothing.

## Documentation

| | |
|---|---|
| [docs/getting-started.md](docs/getting-started.md) | connect a bot to your own BDS, step by step |
| [docs/api.md](docs/api.md) | API reference: mineflayer's API, the Bedrock differences in short, `bot.bedrock.*` extras, connection options |
| [docs/differences.md](docs/differences.md) / [docs/differences/](docs/differences) | every Java ↔ Bedrock difference, in detail |
| [docs/parity.md](docs/parity.md) | parity matrix: every mineflayer member, event and test, and the test that proves it |
| [docs/testing.md](docs/testing.md) | the BDS Docker harness, e2e tests, BDS quirks |
| [docs/README.md](docs/README.md) | index of all documents |

## Testing

```sh
corepack pnpm lint && corepack pnpm test         # unit tests (no server)
corepack pnpm typecheck                          # index.d.ts
corepack pnpm bds pull                           # once per host: golden BDS cache (Docker required)
corepack pnpm test:e2e                           # every end-to-end suite against real BDS instances
corepack pnpm test:e2e -- --grep "combat matrix" # one suite (mocha --grep)
```

The end-to-end suites start one isolated BDS per test file (host networking, slots of ports from 41000) and port every
mineflayer external test plus Bedrock-specific ones: digging every block, crafting, containers, physics against server
corrections, dimensions, a mob combat matrix against 21 hostile mobs, NetherNet (`--grep nethernet`, opt-in) and more.
See [docs/testing.md](docs/testing.md).

## Repository layout

| path | |
|---|---|
| [`packages/mineflayer-bedrock`](packages/mineflayer-bedrock) | the library (`index.js`, `index.d.ts`, `lib/plugins/*` — one file per mineflayer plugin, `lib/bedrock/*` — Bedrock internals, `lib/physics/` — Bedrock movement engine, `examples/`, `test/unit`, `test/external`) |
| [`packages/bedrock-data`](packages/bedrock-data) | `@bedboo/bedrock-data`: the BDS 1.26.51 data overlay for minecraft-data |
| [`packages/bds`](packages/bds) | `@bedboo/bds`: Docker BDS harness and the `bds` CLI |
| [`packages/agent`](packages/agent) | `@bedboo/agent`: a scripted survival agent (skills: navigate, gather, craft, mine, build, combat, …) |
| [`patches/`](patches) | pnpm patches of dependencies |
| [`docs/`](docs) | documentation (above), contributor guide ([`CONTRIBUTING.md`](docs/CONTRIBUTING.md)) |
| [`scripts/`](scripts) | e2e runner, parity tooling, fixture capture |

## License and attributions

bedboo is MIT licensed ([LICENSE](LICENSE)). It builds on, and partly adapts, the work of others:

- [mineflayer](https://github.com/PrismarineJS/mineflayer) — MIT, Copyright (c) 2013 Andrew Kelley. Plugins adapted
  from it keep an attribution header; pinned reference copies are in [docs/upstream/](docs/upstream).
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
- [itzg/docker-minecraft-bedrock-server](https://github.com/itzg/docker-minecraft-bedrock-server) — MIT: the Docker
  image the test harness runs BDS in. BDS itself is downloaded from minecraft.net under Mojang's
  [EULA](https://www.minecraft.net/eula) and never redistributed.

Minecraft is a trademark of Mojang Synergies AB; bedboo is not affiliated with Mojang or Microsoft.
