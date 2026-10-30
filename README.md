# bedboo

[![standard-readme compliant](https://img.shields.io/badge/readme%20style-standard-brightgreen.svg?style=flat-square)](https://github.com/RichardLitt/standard-readme)
[![CI](https://github.com/LiteLDev/bedboo/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/LiteLDev/bedboo/actions/workflows/ci.yml)
[![license: LGPL-3.0-only](https://img.shields.io/badge/license-LGPL--3.0--only-blue.svg?style=flat-square)](COPYING.LESSER)

Mineflayer for Minecraft: Bedrock Edition

bedboo's library, **`mineflayer-bedrock`**, is [mineflayer](https://github.com/PrismarineJS/mineflayer) for Bedrock:
the same `createBot()`, the same `bot.*` properties, methods and events, the same TypeScript types and the same plugin
system as mineflayer **4.39.0**, but it talks to a **Bedrock Dedicated Server** (BDS) through
[bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol). Code written for mineflayer — including
ecosystem plugins such as mineflayer-pathfinder — runs against BDS. The only differences are inherent Java/Bedrock
ones (Bedrock block and item names, no teams, server-authoritative inventory and block breaking, …), and each of them
is documented.

- Supported server: **BDS 1.26.51.x** (protocol 2193; 1.26.52.x is wire-identical). `bot.version` is `1.26.51`.
- Transport: **RakNet** by default; **NetherNet** (BDS's default transport) with `transport: 'nethernet'`.
- Auth: `auth: 'offline'` (default) for `online-mode=false` servers, `auth: 'microsoft'` for Xbox Live.

The repository and its pnpm workspace are called bedboo; the packages inside it have their own names. The library is
`mineflayer-bedrock`, named after the mineflayer API it implements, and it ships with the helper packages
`@bedboo/bedrock-data`, `@bedboo/bds` and `@bedboo/agent` (see [Repository layout](#repository-layout)).

## Table of Contents

- [Background](#background)
- [Install](#install)
  - [Dependencies](#dependencies)
- [Usage](#usage)
  - [CLI](#cli)
- [Server setup](#server-setup)
  - [RakNet or NetherNet?](#raknet-or-nethernet)
  - [Driving a real client (Be.D.D.)](#driving-a-real-client-bedd)
- [Ecosystem plugins](#ecosystem-plugins)
- [Testing](#testing)
- [Repository layout](#repository-layout)
- [API](#api)
- [Acknowledgements](#acknowledgements)
- [Contributing](#contributing)
- [License](#license)

## Background

[mineflayer](https://github.com/PrismarineJS/mineflayer) is the usual way to write Minecraft bots in JavaScript, and
it has a large ecosystem of plugins, but it targets Java Edition. Bedrock Edition uses a different protocol, different
block and item ids, server-authoritative inventory and block breaking, and its own movement physics, so Java bots and
their plugins cannot join a Bedrock server. bedboo closes that gap without inventing a new API. mineflayer-bedrock
re-implements mineflayer 4.39.0's public API on Bedrock, so mineflayer's documentation, examples and plugins apply
unchanged.

It is built on:

- [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol) for the connection (RakNet through
  raknet-native, NetherNet through [node-nethernet](https://github.com/PrismarineJS/node-nethernet)) and
  prismarine-auth for Xbox Live sign-in;
- the prismarine-* libraries (block, chat, chunk, entity, item, nbt, recipe, registry, windows, world) and
  [minecraft-data](https://github.com/PrismarineJS/minecraft-data), with `@bedboo/bedrock-data` as the BDS 1.26.51
  data overlay;
- a Bedrock movement engine forked from prismarine-physics (`lib/physics/`);
- mineflayer's own plugins, adapted one file per plugin (`lib/plugins/`), each keeping its attribution header.

Small fixes to those dependencies are pnpm patches in [`patches/`](patches) (see [Install](#install)).

See also [docs/differences.md](docs/differences.md), which lists every Java ↔ Bedrock difference, and
[docs/parity.md](docs/parity.md), the parity matrix that maps every mineflayer member, event and test to the test that
proves it.

## Install

mineflayer-bedrock is not published to npm yet. It depends on a few small fixes to its dependencies
(bedrock-protocol, nethernet, raknet-native, prismarine-*) that live in [`patches/`](patches) and that pnpm applies
only inside this workspace, so use it from the monorepo:

```sh
git clone https://github.com/LiteLDev/bedboo && cd bedboo
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install   # pnpm is pinned through corepack
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

### Dependencies

- **Node.js ≥ 24 on x64.** The RakNet backend (raknet-native) ships x64 prebuilds only; NetherNet is pure JavaScript
  (see [docs/testing.md](docs/testing.md#transport-spike-u0-2026-10-18--result-raknet-works)).
- **pnpm**, through corepack: the version is pinned in `package.json` (`packageManager`), so nothing is installed
  globally.
- **A Bedrock Dedicated Server 1.26.51.x** to connect to: your own (see [Server setup](#server-setup)) or a throw-away
  one from the [CLI](#cli).
- **Docker**, only for the CLI's servers and the end-to-end tests.

## Usage

The bot is mineflayer code; only the `require` changes:

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

The runnable copy is
[`packages/mineflayer-bedrock/examples/readme_quickstart.js`](packages/mineflayer-bedrock/examples/readme_quickstart.js);
an end-to-end test runs it against a real BDS on every test run:

```sh
node packages/mineflayer-bedrock/examples/readme_quickstart.js <host> <port>
```

Step by step, including the server setup: **[docs/getting-started.md](docs/getting-started.md)**.

### CLI

`@bedboo/bds` provides the `bds` CLI, which downloads the official server once and starts isolated BDS instances in
Docker. Use them as servers to develop against:

```sh
corepack pnpm bds pull                           # once: Docker image + BDS 1.26.51.1 (verified checksum)
corepack pnpm bds up --name mybds --gamemode survival
#   bedboo-mybds ready on 127.0.0.1:41000 …      → createBot({ host: '127.0.0.1', port: 41000, … })
corepack pnpm bds cmd mybds op Bot               # console commands
corepack pnpm bds down mybds
```

`corepack pnpm bds --help` lists every command (logs, world snapshots, cleanup, …); see
[docs/testing.md](docs/testing.md#bds-cli).

## Server setup

Any BDS 1.26.51.x works, whether it comes from the [CLI](#cli) or you run it yourself. Your own BDS needs, in
`server.properties`:

| property | value | why |
|---|---|---|
| `transport` | `raknet` (or `nethernet` with `transport: 'nethernet'` in `createBot`) | RakNet is the default client transport |
| `online-mode` | `false` for `auth: 'offline'`; `true` needs `auth: 'microsoft'` | offline bots have no Xbox Live identity |
| `allow-list` | `false`, or add the bot's name to `allowlist.json` | otherwise the bot is kicked |
| `server-port` | the `port` you pass to `createBot` | |

[docs/getting-started.md](docs/getting-started.md) has the details (permissions, cheats, NetherNet, Microsoft auth).

### RakNet or NetherNet?

BDS 1.26.51 defaults to **NetherNet** (WebRTC) and still ships RakNet behind `transport=raknet`; Mojang has announced
that RakNet will go away, possibly as soon as BDS 26.60. mineflayer-bedrock defaults to RakNet because
bedrock-protocol has supported it for years and the test suite runs on it. NetherNet is supported with
`createBot({ transport: 'nethernet' })`, which joins over HTTP signalling on the server port (no LAN discovery needed)
— see [docs/getting-started.md](docs/getting-started.md#nethernet).

### Driving a real client (Be.D.D.)

`createBot({ transport: 'bedd', bedd: { pipe } })` drives a real Minecraft Bedrock client hosted by
[Be.D.D.](https://github.com/LiteLDev/BeDD) instead of connecting to BDS: the same script runs and you watch the local
player do it, on a server or in singleplayer. Setup, coverage and security notes: [docs/bedd.md](docs/bedd.md).

## Ecosystem plugins

Plugins written for mineflayer load with `bot.loadPlugin()` unchanged: mineflayer-pathfinder, mineflayer-pvp,
mineflayer-collectblock, mineflayer-tool, mineflayer-armor-manager and mineflayer-auto-eat are pinned in the
workspace, and the few Java assumptions they make (the Java `entity_status` packet, Java enchantment NBT, …) are
patched in `patches/`. A plugin that only uses mineflayer's public API needs nothing.

## Testing

```sh
corepack pnpm lint && corepack pnpm test         # unit tests (no server)
corepack pnpm typecheck                          # index.d.ts
corepack pnpm bds pull                           # once per host: golden BDS cache (Docker required)
corepack pnpm test:e2e                           # every end-to-end suite against real BDS instances
corepack pnpm test:e2e -- --grep "combat matrix" # one suite (mocha --grep)
```

The end-to-end suites start one isolated BDS per test file (host networking, slots of ports from 41000). They port
every mineflayer external test and add Bedrock-specific ones: digging every block, crafting, containers, physics
against server corrections, dimensions, a combat matrix against 21 hostile mobs, NetherNet (`--grep nethernet`,
opt-in) and more. See [docs/testing.md](docs/testing.md).

## Repository layout

| path | |
|---|---|
| [`packages/mineflayer-bedrock`](packages/mineflayer-bedrock) | the library (`index.js`, `index.d.ts`, `lib/plugins/*` — one file per mineflayer plugin, `lib/bedrock/*` — Bedrock internals, `lib/physics/` — Bedrock movement engine, `examples/`, `test/unit`, `test/external`) |
| [`packages/bedrock-data`](packages/bedrock-data) | `@bedboo/bedrock-data`: the BDS 1.26.51 data overlay for minecraft-data |
| [`packages/bds`](packages/bds) | `@bedboo/bds`: Docker BDS harness and the `bds` CLI |
| [`packages/agent`](packages/agent) | `@bedboo/agent`: a scripted survival agent (skills: navigate, gather, craft, mine, build, combat, …) |
| [`patches/`](patches) | pnpm patches of dependencies |
| [`docs/`](docs) | documentation (see [API](#api)) and the contributor guide ([`CONTRIBUTING.md`](docs/CONTRIBUTING.md)) |
| [`scripts/`](scripts) | e2e runner, parity tooling, fixture capture |

## API

mineflayer-bedrock's API is mineflayer 4.39.0's: the same exports (`createBot(options)` and the rest), the same
`bot.*` properties, methods and events, and the same TypeScript types. Bedrock-only additions live under
`bot.bedrock.*`, plus a few `createBot` options (`transport`, …).

| | |
|---|---|
| [docs/api.md](docs/api.md) | API reference: mineflayer's API, the Bedrock differences in short, `bot.bedrock.*` extras, connection options |
| [docs/getting-started.md](docs/getting-started.md) | connect a bot to your own BDS, step by step |
| [docs/differences.md](docs/differences.md) / [docs/differences/](docs/differences) | every Java ↔ Bedrock difference, in detail |
| [docs/parity.md](docs/parity.md) | parity matrix: every mineflayer member, event and test, and the test that proves it |
| [docs/bedd.md](docs/bedd.md) | `transport: 'bedd'`: driving a real client hosted by Be.D.D. |
| [docs/testing.md](docs/testing.md) | the BDS Docker harness, e2e tests, BDS quirks |
| [docs/README.md](docs/README.md) | index of all documents |

## Acknowledgements

bedboo builds on, and partly adapts, the work of others:

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

## Contributing

Ask questions and report bugs in [GitHub issues](https://github.com/LiteLDev/bedboo/issues). Pull requests are
welcome. Before you open one, check that:

- `corepack pnpm lint` ([standard](https://standardjs.com) style) and `corepack pnpm test` pass, and a change in
  behaviour comes with an end-to-end test against a real BDS (see [Testing](#testing));
- code adapted from mineflayer or another project keeps an attribution header naming its source and license;
- every Java ↔ Bedrock difference you introduce is documented in [docs/differences/](docs/differences).

Conventions and the contracts between packages are in [docs/CONTRIBUTING.md](docs/CONTRIBUTING.md). By contributing,
you agree that your contributions are licensed under the project's [license](#license).

## License

[LGPL-3.0-only](COPYING.LESSER) © 2026 LiteLDev and bedboo contributors

bedboo is licensed under the GNU Lesser General Public License v3.0 only. See [COPYING](COPYING) and
[COPYING.LESSER](COPYING.LESSER) for the full terms. Code and data adapted from other projects keep their original
licenses and notices (see [Acknowledgements](#acknowledgements)).

Minecraft is a trademark of Mojang Synergies AB; bedboo is not affiliated with Mojang or Microsoft.
