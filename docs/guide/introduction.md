# Introduction

bedboo is a Minecraft Bedrock Edition bot library with a mineflayer-compatible API. It offers the same `createBot()`,
the same `bot.*` properties, methods and events, the same TypeScript types and the same plugin system as
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0, but it talks to a **Bedrock Dedicated Server** (BDS)
through [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol). Bot code written for mineflayer,
including ecosystem plugins such as mineflayer-pathfinder, runs against BDS.

## Why

mineflayer is the usual way to write Minecraft bots in JavaScript and it has a large plugin ecosystem, but it targets
Java Edition. Bedrock Edition uses a different protocol, different block and item ids, server-authoritative inventory
and block breaking, and its own movement physics, so Java bots and their plugins cannot join a Bedrock server. bedboo
closes that gap without inventing a new API: mineflayer's documentation, examples and plugins apply unchanged.

The only differences are inherent Java/Bedrock ones: Bedrock block and item names, no teams, server-authoritative
inventory and block breaking, and so on. Each of them is listed in the
[Bedrock differences](../reference/differences/index.md).

## What is supported

- **Servers:** every stable BDS from 1.26.42.1 (August 7, 2026) to 1.26.63.1 (November 6, 2026), in four protocol
  families: 1.26.40 (protocol 2168), 1.26.45 (2169), 1.26.51 (2193, the default) and 1.26.60 (2225).
  `createBot({ version })` takes the family or the BDS build; `bot.version` is the family. See
  [Supported versions](../reference/versions/index.md).
- **Transports:** RakNet by default; NetherNet (BDS's default transport) with `transport: 'nethernet'`.
- **Auth:** `auth: 'offline'` (default) for `online-mode=false` servers, `auth: 'microsoft'` for Xbox Live.
- **Real client:** `transport: 'bedd'` drives a real Bedrock client hosted by [Be.D.D.](bedd.md) instead.
- **Runtime:** Node.js 24 or newer. RakNet needs x64 (raknet-native ships x64 prebuilds only); NetherNet is pure
  JavaScript.

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
from its monorepo for now (see [Your first bot](getting-started.md#get-the-code)).

## Packages

| package | |
|---|---|
| `bedboo` | the library |
| `@bedboo/bedrock-data` | the Bedrock data overlays for minecraft-data, one per supported family |
| `@bedboo/agent` | a scripted survival agent built on bedboo ([Survival agent](agent.md)) |

## The name

bedboo (Bedrock + Bangboo) is named after the Bangboo of Zenless Zone Zero: a Bangboo goes into the Hollows on a
Proxy's behalf, your bot goes into a Bedrock server on yours.

## Next

- [Your first bot](getting-started.md): server settings, install, a bot that walks to you.
- [Ecosystem plugins](plugins.md): pathfinder, pvp, collectblock and friends on Bedrock.
- [API](../reference/api.md): `createBot` options and the Bedrock extras.
