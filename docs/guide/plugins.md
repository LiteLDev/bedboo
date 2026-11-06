# Ecosystem plugins

Plugins written for mineflayer load with `bot.loadPlugin()` unchanged. The popular ones are pinned in the bedboo
workspace, and the few Java assumptions they make (the Java `entity_status` packet, Java enchantment NBT, …) are fixed
by small pnpm patches in `patches/mineflayer-*.patch`. A plugin that only uses mineflayer's public API needs nothing.

The `overrides` in `pnpm-workspace.yaml` pin the patched versions, so every package, the plugins' dependencies on each
other included, loads the same patched copy. Outside the workspace apply the same patches (`pnpm patch` /
`patch-package`): unpatched, auto-eat waits for a Java `entity_status` that never comes and pathfinder digs through
doors and fights the server with its recentring. What each patch changes and why:
[Ecosystem plugin patches](../reference/differences/plugins.md).

| plugin | version | verified on BDS 1.26.51.1 |
|---|---|---|
| mineflayer-pathfinder | 2.4.5 | hills, a lake, GoalXZ 120 blocks, GoalY, ladder, parkour, pillar, bridge, digging through a wall, door and gate, GoalFollow, scaffolding |
| mineflayer-collectblock | 1.6.0 | logs from trees, coal and iron ore, chest deposit when full |
| mineflayer-tool | 1.2.0 | best tool, enchantments, hand fallback / `NoItem` |
| mineflayer-armor-manager | 2.0.1 | auto-equip on pickup, upgrades, `equipAll()` |
| mineflayer-auto-eat | 5.0.3 (ESM) | `eat()`, `enableAuto()` |
| mineflayer-pvp | 1.3.2 | zombie, zombie with a shield, creeper with a shield, skeleton |

## Loading {#loading}

```js
const bedboo = require('bedboo')
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

const bot = bedboo.createBot({ host, port, username })
bot.loadPlugin(pathfinder)
bot.loadPlugin(require('mineflayer-pvp').plugin) // needs pathfinder loaded
bot.loadPlugin(require('mineflayer-collectblock').plugin) // loads pathfinder + tool itself on the next tick
bot.loadPlugin(require('mineflayer-armor-manager'))
const { loader: autoEat } = await import('mineflayer-auto-eat') // ESM only
bot.loadPlugin(autoEat)
```

The mineflayer examples ported to Bedrock are in the library's `examples/` folder (plugin examples:
`pathfinder/gps.js`, `collectblock.js`, `guard.js`, `auto-eat.js`).

## mineflayer-pathfinder {#pathfinder}

Recommended `Movements` on Bedrock:

```js
const moves = new Movements(bot)
moves.canOpenDoors = true // wooden doors (all woods, copper) and fence gates are opened, not dug (patched)
moves.allowSprinting = true // default
moves.allowParkour = true // default: 1–3 block gaps (2-block gaps verified)
moves.allow1by1towers = true // default: pillars up with scaffolding items (dirt, cobblestone; add more ids to
// moves.scafoldingBlocks, e.g. bot.registry.itemsByName.netherrack.id)
moves.canDig = true // default; dig costs use Bedrock dig speed (effects, enchantments)
bot.pathfinder.setMovements(moves)
bot.pathfinder.thinkTimeout = 20000 // recommended (upstream 5000 ms): see below
```

- `thinkTimeout`: overworld chunks span y -64..319 and a search on natural terrain visits many nodes; on a loaded host
  a plain goal of a few blocks can take over the default 5 s, and `goto` rejects with
  `Timeout: Took to long to decide path to goal!`. Raising it costs nothing when the search is quick.
- A failed placement never hangs the path (patched; upstream 2.4.5 hangs on each of these):
  - a rejected `bot.equip` of the scaffolding block releases pathfinder's equip lock;
  - a refused placement is retried once, then that cell is avoided by the next searches for the current goal
    (`bot.pathfinder.refusedPlacements`, `maxPlaceRetries` = 1): the path goes another way or the goal has no path;
    after `maxPlaceFailures` (6) failed placements in a row `goto` rejects with `NoPath` ("… placements failed in a
    row"). A retry with the same goal object keeps the refused cells; a new goal starts afresh;
  - a placement or door click that takes longer than `bot.pathfinder.placeTimeout` (10 s) counts as failed;
  - `stop()` settles on the next tick while a placement is pending (its late outcome is ignored);
  - after a failure the bot steps back from the edge it leaned over, and a search started at an edge begins from the
    block the bot stands on.

  `path_reset` reasons: `equip_error`, `place_error`, `use_error`, `place_timeout`, `stop`.
- Names are Bedrock names; flowing water / lava, water-filled plants and waterlogged blocks count as liquid.
- The executor's `fullStop()` no longer recentres the bot client-side (BDS corrected it back); expect at most an
  occasional ~0.24-block server correction when the bot stops.
- Not handled (as upstream): trapdoors, iron doors (dug when `canDig`), vines (not climbable), Bedrock scaffolding
  blocks, swimming as such (the bot crosses water by floating with jump).
- `bot.pathfinder.stop()` while idle is a no-op and `goto()` rejects with `NoPath` on an unreachable goal (backported
  from upstream master). A `GoalFollow` re-plans when the bot is knocked away.
- Doors: BDS opens a door's lower half only; bedboo gives the upper half the open leaf's shape, so the bot walks back
  through a door it opened ([door halves](../reference/differences/world.md#door-halves)).
- A sprint lasts while `forward` is held on Bedrock: pathfinder releasing the sprint control does not slow the bot
  down until it stops ([sticky sprint](../reference/differences/movement.md#sticky-sprint)).
- XP orbs, thrown potions, tridents, fireworks and other projectiles are passable.

## mineflayer-pvp {#pvp}

- Shields: `activateItem(true)` raises the shield by sneaking on Bedrock, so the bot moves at sneaking speed between
  attacks while it holds one; pathfinder's `clearControlStates()` does not lower it (only `deactivateItem()` does); a
  fusing creeper (Bedrock `ignited` flag) makes pvp raise it (patched).
- Ranged mobs (skeletons, strays, pillagers) back off: set `bot.pvp.followRange = 1`, otherwise the bot can stop 4
  blocks away, out of the 3.5 attack range (upstream behaviour on Java too).
- Bedrock has no attack cooldown; pvp's Java cooldown timing only attacks a little slower than possible.

## mineflayer-auto-eat {#auto-eat}

ESM: `const { loader } = await import('mineflayer-auto-eat')`. Configure with `bot.autoEat.setOpts({ minHunger,
priority, bannedFood })`, `enableAuto()` / `disableAuto()`, events `eatStart` / `eatFinish` / `eatFail` on
`bot.autoEat`. Meals complete on Bedrock's `completed_using_item` (patched). On peaceful the food level never drops.
Two upstream bugs are patched: a failed equip no longer leaves the plugin "eating" for good, and `eatFail` is also
emitted with `strictErrors` (the default) before `eat()` rejects.

## mineflayer-collectblock, -tool, -armor-manager {#collectblock}

- collectblock: `collect(blocks)` with a tool and scaffolding blocks in the inventory; `chestLocations` (Vec3 of a
  chest block) are used when the inventory is full. The callback form `collect(target, cb)` works (patched);
  `cancelTask()` ends the job after the step in progress (patched).
- tool: `equipForBlock(block, { requireHarvest })` rejects with `NoItem` when nothing can harvest the block, with
  `getFromChest` and no chest too (patched: upstream recursed for ever and ran out of memory).
- armor-manager: picked-up armor, shields and totems are equipped one at a time (patched); `equipAll()`.
