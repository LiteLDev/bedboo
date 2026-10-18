# bedboo

**mineflayer for Minecraft: Bedrock Edition.** `mineflayer-bedrock` exposes the same API as
[mineflayer](https://github.com/PrismarineJS/mineflayer) 4.39.0 — the same `bot.*` properties, methods,
events, TypeScript types and plugin system — but connects to a Bedrock Dedicated Server (BDS 1.26.51,
via [bedrock-protocol](https://github.com/PrismarineJS/bedrock-protocol)). Ecosystem plugins such as
mineflayer-pathfinder, -pvp, -collectblock, -tool, -armor-manager and -auto-eat are meant to run unchanged.

> Status: under construction. The package skeleton, contracts and transport are in place; features land
> unit by unit (see `docs/CONTRIBUTING.md`). Unimplemented APIs throw/reject `NotImplementedError`.

```js
const mineflayer = require('mineflayer-bedrock')

const bot = mineflayer.createBot({
  host: '127.0.0.1', // BDS address
  port: 19132,
  username: 'Bot',
  offline: true // online-mode=false server; omit for Xbox Live auth
})

bot.on('chat', (username, message) => {
  if (username === bot.username) return
  bot.chat(message)
})

bot.once('spawn', async () => {
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  bot.loadPlugin(pathfinder)
  bot.pathfinder.setMovements(new Movements(bot))
  await bot.pathfinder.goto(new goals.GoalNear(10, -60, 10, 1))
})

bot.on('kicked', console.log)
bot.on('error', console.log)
```

The only differences from mineflayer are inherent Java/Bedrock ones (Bedrock block/item names and registry,
no teams, no tab-list header, …), each documented in `docs/differences/`.

## Packages

| Package | Description |
|---|---|
| [`mineflayer-bedrock`](packages/mineflayer-bedrock) | the library |
| [`@bedboo/bedrock-data`](packages/bedrock-data) | Bedrock 1.26.51 data overlay for minecraft-data |
| [`@bedboo/bds`](packages/bds) | Docker BDS harness and `bds` CLI used by the tests |
| [`@bedboo/agent`](packages/agent) | scripted survival agent (build, mine every ore, Nether, End, combat) |

## Development

Requires Node ≥ 24 and Docker (for end-to-end tests). pnpm is pinned through corepack:

```sh
COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm install
corepack pnpm lint && corepack pnpm test      # unit tests
corepack pnpm typecheck                       # index.d.ts
corepack pnpm test:e2e                        # against a real BDS (docs/testing.md)
```

See [`docs/CONTRIBUTING.md`](docs/CONTRIBUTING.md) (conventions, contracts, ownership) and
[`docs/testing.md`](docs/testing.md) (BDS in Docker, fixtures).

## License

MIT. Includes code adapted from mineflayer and the PrismarineJS packages (MIT); attribution is kept in
the adapted files and in `docs/upstream/`.
