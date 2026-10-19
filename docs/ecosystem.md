# Ecosystem plugins on mineflayer-bedrock

The popular mineflayer plugins run on mineflayer-bedrock unchanged, apart from small `pnpm patch`es in this repo
(`patches/mineflayer-*.patch`, what each changes and why: [differences/U15.md](differences/U15.md)). Install them
from the workspace (the `overrides` in `pnpm-workspace.yaml` pin the patched versions, so every package — the
plugins' dependencies on each other included — loads the same patched copy). Outside this workspace apply the same
patches (`pnpm patch` / `patch-package`): unpatched, auto-eat waits for a Java `entity_status` that never comes and
pathfinder digs through doors and fights the server with its recentring.

| plugin | version | patched | verified on BDS 1.26.51.1 (`packages/mineflayer-bedrock/test/external/`) |
|---|---|---|---|
| mineflayer-pathfinder | 2.4.5 | yes | `ecosystemPathfinder` — hills, a lake, GoalXZ 120 blocks, GoalY, ladder, parkour, pillar, bridge, dig through a wall, door + gate, GoalFollow; `scaffold` |
| mineflayer-collectblock | 1.6.0 | yes | `ecosystemCollectBlock` — logs from trees, coal + iron ore, chest deposit when full |
| mineflayer-tool | 1.2.0 | yes | `ecosystemTool` — best tool, enchantments, hand fallback / NoItem |
| mineflayer-armor-manager | 2.0.1 | yes | `ecosystemArmor` — auto-equip on pickup, upgrades, `equipAll()` |
| mineflayer-auto-eat | 5.0.3 (ESM) | yes | `ecosystemAutoEat` — `eat()`, `enableAuto()` |
| mineflayer-pvp | 1.3.2 | yes | `ecosystemPvp` — zombie, zombie with a shield, creeper with a shield, skeleton |

## Loading

```js
const mineflayer = require('mineflayer-bedrock')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = mineflayer.createBot({ host, port, username })
bot.loadPlugin(pathfinder)
bot.loadPlugin(require('mineflayer-pvp').plugin)              // needs pathfinder loaded
bot.loadPlugin(require('mineflayer-collectblock').plugin)     // loads pathfinder + tool itself on the next tick
bot.loadPlugin(require('mineflayer-armor-manager'))
const { loader: autoEat } = await import('mineflayer-auto-eat') // ESM only
bot.loadPlugin(autoEat)
```

The mineflayer examples ported to Bedrock are in `packages/mineflayer-bedrock/examples/` (`node examples/<name>.js
<host> <port> [<name>]`; plugin examples: `pathfinder/gps.js`, `collectblock.js`, `guard.js`, `auto-eat.js`).

## mineflayer-pathfinder: recommended Movements on Bedrock

```js
const moves = new Movements(bot)
moves.canOpenDoors = true        // wooden doors (all woods, copper) and fence gates are opened, not dug (patched)
moves.allowSprinting = true      // default
moves.allowParkour = true        // default: 1–3 block gaps (2-block gaps verified)
moves.allow1by1towers = true     // default: pillars up with scaffolding items (dirt, cobblestone; add more ids to
                                 // moves.scafoldingBlocks, e.g. bot.registry.itemsByName.netherrack.id)
moves.canDig = true              // default; dig costs use Bedrock dig speed (effects, ench enchantments)
bot.pathfinder.setMovements(moves)
```

- Names are Bedrock names; flowing water / lava, water-filled plants and waterlogged blocks count as liquid.
- The executor's `fullStop()` no longer recentres the bot client-side (BDS corrected it back); expect at most an
  occasional ~0.24-block server correction when the bot stops, never a storm. Measured (survival, seed 2):
  bridge 5 / pillar 5 / ladder / parkour / door: 0–1 corrections; 120-block walk: 0.
- Not handled (as upstream): trapdoors, iron doors (dug when `canDig`), vines (not climbable), Bedrock scaffolding
  blocks, swimming as such (the bot crosses water by floating with jump; sprint-swimming is not modelled).
- `bot.pathfinder.stop()` while idle is a no-op and `goto()` rejects with `NoPath` on an unreachable goal (master
  backports). A `GoalFollow` re-plans when the bot is knocked away.

## mineflayer-pvp

- Shields: `activateItem(true)` raises the shield by sneaking on Bedrock, so the bot moves at sneaking speed between
  attacks while it holds one; a fusing creeper (Bedrock `ignited` flag) makes pvp raise it (patched).
- Ranged mobs (skeletons, strays, pillagers) back off: set `bot.pvp.followRange = 1`, otherwise the bot can stop 4
  blocks away, out of the 3.5 attack range (upstream behaviour on Java too).
- Bedrock has no attack cooldown; pvp's Java cooldown timing only attacks a little slower than possible.

## mineflayer-auto-eat

ESM: `const { loader } = await import('mineflayer-auto-eat')`. Configure with `bot.autoEat.setOpts({ minHunger,
priority, bannedFood })`, `enableAuto()` / `disableAuto()`, events `eatStart` / `eatFinish` / `eatFail` on
`bot.autoEat`. Meals complete on Bedrock's `completed_using_item` (patched). On peaceful the food level never drops.

## mineflayer-collectblock / -tool / -armor-manager

- collectblock: `collect(blocks)` with a tool and scaffolding blocks in the inventory; `chestLocations` (Vec3 of a
  chest block) are used when the inventory is full. The callback form `collect(target, cb)` works (patched).
- tool: `equipForBlock(block, { requireHarvest })` — rejects with `NoItem` when nothing can harvest the block.
- armor-manager: picked-up armor / shields / totems are equipped one at a time (patched); `equipAll()`.

## Test world  {#test-world}

The pathfinder and collectblock suites use a default (non-flat) world with seed **"2"**: spawn (-31, 67, 6) in a
birch / oak forest; hills up to y 80 to the west (hill top around (-55, 73, -30)); a lake from z 12 to z 50 south of
the spawn (south shore around (-60, 68, 50)) and another east of x -10; caves and every ore below. Structured
scenarios (ladder, parkour, pillar, bridge, wall, door) are built with console `fill`s on a stone deck at y 109 north
of the spawn (x -64..-10, z -60..-20).
