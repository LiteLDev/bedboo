# Ecosystem plugin patches

The mineflayer ecosystem plugins run on bedboo unchanged except for the small `pnpm patch`es in `patches/`
(`patches/mineflayer-*.patch`). This page says what each patch changes and why, and records how the plugins behave on
Bedrock where that differs from Java (and the workarounds that help). Recommended usage: [Plugins](../../guide/plugins.md).
Observed on BDS 1.26.51.1 (protocol 2193).

## mineflayer-pathfinder 2.4.5 patch  {#pathfinder}

- **Affects:** `Movements`, `bot.pathfinder.bestHarvestTool`, `goto`, `stop`, the path executor (`monitorMovement`,
  `fullStop`, `postProcessPath`); everything built on it (mineflayer-collectblock, mineflayer-pvp, mineflayer-tool's
  chest retrieval)
- **Java:** block-name sets with Java names; doors are dug through (only fence gates can be opened, and
  `canOpenDoors` was left off upstream); `fullStop()` recentres the bot by moving `bot.entity.position` ("the server
  will not tell the difference"); dig costs from prismarine-block `block.digTime` with the tool's simplified NBT.
- **Bedrock:** different block names (`flowing_water` / `flowing_lava` are blocks of their own, `web`, `wooden_door`,
  `fence_gate`, `standing_sign`, `lit_furnace`, … — `lib/interactable.json` only knew Java names); server-authoritative
  movement corrects any client-side position change (the recentring cost 3–4 corrections of 0.16–0.64 block per
  bridge, see [scaffolding](digging.md#scaffolding)); Bedrock items keep enchantments in `ench` (numeric ids) and BDS
  applies Bedrock's Haste / Mining Fatigue factors ([dig speed](digging.md#dig-speed)).
- **bedboo (patch, new file `lib/bedrock.js` + edits):**
  - names: `flowing_water` / `flowing_lava` join `liquids` and `replaceables`, `flowing_lava` joins `blocksToAvoid`;
    water-filled blocks (`seagrass`, `kelp`, `bubble_column`, …) and waterlogged blocks count as liquid, the
    postprocessed path centres in them (backport of upstream master #384); `interactable.json` gets the 156 Bedrock
    names of interactive blocks (the same set as `lib/bedrock/placement.js`), so pathfinder also sneaks before placing
    against them ([sneak-placing](digging.md#sneak-placing));
  - doors and gates: `openable` holds the hand-openable doors (`wooden_door`, `spruce_door`, …, copper doors; never
    iron) besides fence gates; with `canOpenDoors` a closed one becomes a `useOne` click (the door's upper half is not
    dug), an open door / gate (`open_bit`, Java `open`) is passable and never clicked again; the doorway node is the
    floor centre and a `useOne` node no longer stops the path post-processing (backport of master #372); after the
    click the executor walks on (upstream kept `placing` set and then read `placingBlock.y` of undefined or reset the
    path for want of scaffolding blocks). BDS opens a door's lower half only (the upper half keeps `open_bit` 0): the
    upper half gets the open leaf's shape from bedboo's `blockAt()` ([door halves](world.md#door-halves)), so the bot
    walks back through a door it opened instead of finding no path or digging it;
  - `fullStop()` keeps upstream's zeroed horizontal velocity but skips the recentring teleport when the bot has
    `bot._bedrock.physics` (server-authoritative movement). Measured: pathfinder bridge 0 corrections (was 3–4); at
    most one ~0.24-block correction now and then when BDS does not accept the zeroed velocity (releasing the keys only
    let the bot drift out of the goal block);
  - dig costs (`bestHarvestTool`, `safeOrBreak`): `item.enchants` (Java `Enchantments` and Bedrock `ench` alike; the
    simplified NBT had `id`, which prismarine-block never matched) and `bot._bedrock.digging.blockDigTime` when present
    (Bedrock effect factors; prismarine-block's `digTime` otherwise);
  - backports of master #375: `stop()` while idle no longer latches (it stopped the next goal), `goto` rejects with
    `NoPath` instead of resolving on an empty failed search. mineflayer-collectblock's `cancelTask()` relied on that
    latch (it calls `stop()` while the pathfinder is idle during a dig): its patch now cancels by itself
    ([mineflayer-collectblock](#collectblock));
  - `lib/passableEntities.json` also lists the Bedrock names of the passable entities (`xp_orb`, `xp_bottle`,
    `splash_potion`, `lingering_potion`, `fireworks_rocket`, `thrown_trident`, `fishing_hook`, `evocation_fang`,
    `wind_charge_projectile`, `breeze_wind_charge_projectile`, `ender_crystal`, `eye_of_ender_signal`,
    `ominous_item_spawner`, `wither_skull_dangerous`): with only the Java names, XP orbs and projectiles counted as
    obstacles (entity cost, no pillaring or scaffolding where an orb was);
  - `detectDiggingStopped` removes only its own listeners (`removeAllListeners(event, fn)` ignores `fn` and dropped
    every other `diggingCompleted` / `diggingAborted` listener of the bot);
  - a dynamic goal (`GoalFollow`) re-plans when the bot was pushed more than a block away from where its finished path
    was computed (a skeleton's arrows pushed a mineflayer-pvp bot out of range for good: the target itself had not
    moved far enough for `hasChanged()`);
  - failed placements never hang the path (upstream 2.4.5 and master d773d15 both hang — master's open PR #365 only
    moves the futility check; any server, Java too):
    - upstream: a rejected `bot.equip` of the scaffolding block never released `lockEquipItem`, so the executor
      returned early on every tick, before its futility check, for good; a refused placement reset the path into the
      same placement for ever; `stop()` waited for a node or a reset that never came;
    - now the equip lock is held from the equip until the placement settles and released on every outcome;
    - a failed equip / placement / door click (`equip_error`, `place_error`, `use_error`) or one that takes over
      `placeTimeout` (10 s, `place_timeout`) is counted at its cell: a cell that failed more than `maxPlaceRetries` (1)
      times joins `bot.pathfinder.refusedPlacements`, where `Movements#getNeighbors` never plans a placement for the
      current goal (the same goal object set again — a caller's retry — keeps them; another goal or `stop()` clears
      them);
    - `maxPlaceFailures` (6) in a row give the goal up (`path_update` 'noPath', `goto` rejects `NoPath` "… placements
      failed in a row"; the goal is dropped unless dynamic, so no later reset revives it);
    - `stop()` during a placement settles on the next tick; a placement abandoned by a stop / reset / new goal changes
      nothing when it settles late (and never releases a newer placement's lock); the walk back to `returnPos` after a
      placement is bounded like a walk to a node;
    - after a failure the bot steps back onto the block it leaned out from, and a search begins from the block the bot
      stands on when its floored position is over a gap (upstream started from the cell over the gap and planned a
      placement against the air under it — after a stop at a bridge edge the next `goto` spent 2 × 10 s on it).

## Long searches and partial paths  {#pathfinder-long}

- **Affects:** mineflayer-pathfinder `goto()` to goals 100+ blocks away over hills (same on Java)
- **Java / Bedrock:** identical upstream behaviour: `goto(GoalLookAtBlock(<ore 90 blocks away>))` rejects with "Took
  to long to decide path to goal!" — `goto` rejects on the search's `timeout` status instead of following the best
  partial path, although the pathfinder then walks that partial path, and nothing re-plans at its end.
- **bedboo:** nothing in the library or the patch. Workarounds (used by the bundled agent, `packages/agent`): walk far
  goals in legs of 32 blocks (`GoalNearXZ` waypoints, a leg 16 blocks to the side when one fails), `thinkTimeout`
  10 s; after a timeout wait for the partial walk to end and search again from there; give up when the bot has not
  moved for 30 s. A 1×1 pillar needs the bot centred in its column (a hitbox overlapping the neighbouring column hits
  that column's ceiling when jumping): centre the bot before each jump.

## No path out through a door the bot just placed  {#own-door}

- **Affects:** mineflayer-pathfinder (patched, `canOpenDoors`) right after the bot placed a wooden door and stays
  connected
- **Java:** not observed.
- **Bedrock (observed, not explained):** a bot that had placed a house door from the inside got `NoPath` for every goal
  outside; after a rejoin pathfinder opened the same door and walked out. The door's block states seen by the bot are
  correct (`open_bit` on the lower half, `upper_block_bit` on the upper one, the same after a rejoin), so the cause is
  not the world model; not investigated further.
- **bedboo:** no fix. Workaround: place a door from outside the footprint and leave a finished structure through its
  door explicitly (`activateBlock` + walk); when stuck, open an adjacent closed door and step through.

## mineflayer-pathfinder drops into lava  {#pathfinder-lava-drop}

- **Affects:** anyone using mineflayer-pathfinder's defaults in the Nether
- **Java / Bedrock:** identical upstream behaviour: `Movements.infiniteLiquidDropdownDistance` (default true) lets a
  path drop any height into a "liquid", and pathfinder's liquids include lava — a nether path dropped the bot into the
  lava ocean (measured: "\<bot> tried to swim in lava" while exploring at y 26).
- **bedboo:** nothing in the library or the patch. Workaround: set `infiniteLiquidDropdownDistance = false` (drops
  limited to `maxDropDown` 3) and add portals, fire, magma, berry bushes, … to `blocksToAvoid`.

## Pillaring (1×1 towers) under a ceiling  {#towers}

- **Affects:** mineflayer-pathfinder's `allow1by1towers`
- **Java:** pathfinder jumps and places a block under its feet; it only clears the block two above the feet. Java's
  server accepts the placement as soon as the client says it rose; the client re-centres itself on the pillar.
- **Bedrock:** BDS refuses any block that overlaps the player's server-side hitbox
  ([scaffolding](digging.md#scaffolding)), and the patched pathfinder no longer re-centres the bot (that caused
  corrections). An off-centre hitbox spans the neighbouring columns; a block two or three above the feet there (e.g.
  the underside of the End's island over its arrival platform) cuts the jump short and every placement is refused
  (measured: 204 `place_error` path resets in a row, the bot stuck on a 3-block pillar).
- **bedboo:** nothing in the library. Workaround: where a ceiling is near, drop tower steps with a block 2–3 above the
  feet in any of the nine columns, so the pathfinder digs a staircase instead (End platform → island top in ≈ 25 s).
  Elsewhere towers work (a bot that dug itself into a 1×1 shaft is centred and towers out fine).

## Bridging over the Nether's lava ocean  {#nether-bridges}

- **Affects:** mineflayer-pathfinder scaffolding in the Nether
- **Java / Bedrock:** identical: a bridge over the lava ocean is exposed (a hoglin's toss or a crossbow bolt knocks the
  bot into the lava).
- **bedboo:** nothing in the library. Workaround: place no scaffolding block over a drop deeper than 4 blocks there;
  the pathfinder digs through rock instead.

## mineflayer-tool 1.2.0 patch  {#tool}

- **Affects:** `bot.tool.getDigTime`, `equipForBlock`, `retrieveTools`' cost order
- **Java:** `block.digTime(type, …, nbt.simplify(item.nbt).Enchantments, effects)`.
- **Bedrock:** enchantments are `ench` NBT with numeric ids; Bedrock effect factors ([dig speed](digging.md#dig-speed)).
- **bedboo (patch):** `item.enchants` + `bot._bedrock.digging.blockDigTime` (else prismarine-block) — the estimate
  equals `bot.digTime` with that tool in hand, so Efficiency picks the enchanted tool.
  - Upstream bug fixed (not Bedrock-specific): `equipForBlock(block, { requireHarvest, getFromChest })` with no
    harvesting tool in the inventory called `retrieveTools()`, which returns without an error when there is no chest
    (or no chest had a tool), and then called itself again — for ever. Without chests that is an endless chain of
    microtasks: the event loop froze and the process died out of memory within ~25 s (e.g. mineflayer-collectblock's
    `collect()` of coal ores without a pickaxe; its options are `{ requireHarvest: true, getFromChest: true,
    maxTools: 2 }`). The patch searches the chests only when there are some, and one round of them; otherwise (or
    still without a tool) the call rejects with `NoItem`, as without `getFromChest`.

## mineflayer-collectblock 1.6.0 patch  {#collectblock}

- **Affects:** `bot.collectBlock.collect(target, [options], cb)` (callback form), the drops it picks up,
  `cancelTask()`
- **Java / Bedrock:** the same upstream bugs on both:
  - `callbackify(this.collect)` lost `this`, so the callback form (mineflayer's `examples/collectblock.js`) always
    failed with "Cannot read properties of undefined (reading 'bot')";
  - a mined block's drops spawn at a random point 0.25–0.75 into the block on each axis (minus half the item height):
    up to ~0.52 block from its centre (measured on BDS: 0.17–0.52). collectblock only targets drops within 0.5 of the
    centre, so now and then a drop was left behind (Java has the same spread);
  - a target block that is already gone when its turn comes (mineflayer-pathfinder digs what is in its way, e.g. the
    log above a dug one while following that log's drop) got a `GoalLookAtBlock` on air, which never ends: the search
    ran into its 5 s timeout and `collect()` rejected (measured: 2 of 4 runs collecting 5 logs);
  - `cancelTask()` calls `bot.pathfinder.stop()` and waits for the job to end. With pathfinder 2.4.5 the stop latched
    while the pathfinder was idle (during a dig, while waiting for a pickup), so the job's next `goto` rejected with
    `PathStopped`, which `collect()` swallows. The patched pathfinder no longer latches
    ([mineflayer-pathfinder](#pathfinder)): the cancel was lost and `cancelTask()` waited for the whole job (measured:
    17 s for 4 logs).
- **bedboo (patch):** `callbackify(this.collect).call(this, …)`; drops within 0.75 of the mined block's centre are
  collected; a block target that changed is dropped before pathing to it; `cancelTask()` also flags the running job,
  which checks the flag after each step (`goto`, the dig, the pickup wait, emptying the inventory) and ends with
  `PathStopped` like before — after the step in progress, as with pathfinder 2.4.5 — and a pickup wait ends at once.
  Nothing else is patched: digging waits for the server ([completion](digging.md#completion)), drops come from
  `itemDrop` → `GoalFollow` → `playerCollect` / `entityGone`, the chest flow uses `openChest` / `deposit` unchanged.

## Ore search uses the chunk data  {#ore-search}

- **Affects:** `bot.findBlocks` for ores (mineflayer-collectblock's examples do the same)
- **Java / Bedrock:** identical — the server sends whole chunks, and bots locate blocks with `bot.findBlocks`.
- **bedboo:** nothing to change. Nether facts worth knowing when mining there:
  - the ancient debris band y 8–22 (the big veins, around y 15) mostly lies under the lava ocean (y ≤ 31): targets
    there often sit under an open cavern, and mineflayer-pathfinder bridges and pillars through the void towards them
    or the bot falls into the lava. Searching above the lava ocean first (y ≥ 32, where the small veins are), requiring
    the debris to be buried in rock up to the bot's level (no open cavern or lava above it), and falling back to the
    8–22 band or a straight branch-mining tunnel works better;
  - when pathing to ores, never break a block next to a liquid;
  - mining nether gold angers the piglins that see it, gold armour or not (crossbow piglins then shoot the bot): mine
    it last and never within 20 blocks of a piglin.

## mineflayer-armor-manager 2.0.1 patch  {#armor-manager}

- **Affects:** auto-equip on `playerCollect`
- **Java:** each picked-up piece starts `equipItem` 100 ms later; with Java's instant window clicks the equips rarely
  overlap.
- **Bedrock:** every click waits for the server's item stack response, so pieces picked up together equip at the same
  time; their clicks interleave through the shared cursor and swap the pieces around (measured: 1 of 5 pieces ended up
  equipped).
- **bedboo (patch):** the equips run one after another (a promise queue). `getDroppedItem()` and the Java armor slots
  5–8 / off-hand 45 work as is; `supportFeature('doesntHaveOffHandSlot')` is false.

## mineflayer-auto-eat 5.0.3 patch  {#auto-eat}

- **Affects:** `bot.autoEat.eat()`, `enableAuto()`
- **Java:** a meal ends with `entity_status` 9 on `bot._client`.
- **Bedrock:** no `entity_status` packet; BDS sends `completed_using_item` to the eater (what `bot.consume` waits for).
- **bedboo (patch):** the eating listener also completes on `completed_using_item`. The plugin is ESM-only (load it
  with `await import('mineflayer-auto-eat')`); `registry.foods` / `foodsByName` come from bedrock-data; its GPL-3.0
  dependency `@nxg-org/mineflayer-util-plugin` is used unmodified (it needs Java version comparisons
  ([version comparisons](data.md#version-comparisons)), `bot.version.split('.')`, `clickWindow`,
  `inventory.selectedItem`, `firstEmptyInventorySlot`). Hunger only drops on difficulty easy or harder (on peaceful
  Bedrock never lets the food level drop).
  - Upstream bugs fixed (not Bedrock-specific):
    1. `eat()` sets its eating flag before equipping the food and only cleared it on the paths after the meal started:
       an equip that failed (`customEquip` → false, e.g. a window open or a hand swap at the same moment) left
       `isEating` true for good — every later `eat()` threw `Already eating!` and the automatic mode never ate again
       ([details](#auto-eat-stuck)). Now any failure before the meal starts (no food, the equip, activating the item)
       clears the flag; such a failure still emits nothing (no meal started), as upstream.
    2. With `strictErrors` (the default) a failed meal (timeout, the item switched away, `cancelEat()`) threw before
       emitting `eatFail`, so no failure event was ever emitted with the default options; now `eatFail` comes first
       (then `eatFinish`, then the rejection), as with `strictErrors: false`. `eatFail` is emitted once per failure:
       code that emitted it itself with the error `eat()` threw (a workaround for the missing event) does not report a
       failure twice.
  - The automatic mode tries again 2 s after a meal that could not start (a failing equip would otherwise be repeated
    on every tick), at once after a meal that failed, as upstream; `eat()` called directly is never held back. A
    throwing `eatStart` listener no longer leaves the flag set either (the event is emitted inside the meal's `try`).

## mineflayer-auto-eat eats whenever health \< 14  {#auto-eat-health}

- **Affects:** mineflayer-auto-eat 5.0.3 `minHealth` (default 14), on Java and Bedrock alike
- **Java:** the same option; a low-health meal at a full food bar is the same futile loop for ordinary food.
- **Bedrock:** a player with a full food bar cannot eat (BDS refuses the meal), so an auto-eat triggered by low health
  alone starts a meal every tick that never completes (3 s timeout each).
- **bedboo:** nothing patched. Recommended options: `minHealth: 0`, `minHunger: 16` (eat by hunger only).

## mineflayer-auto-eat stops eating after a refused equip  {#auto-eat-stuck}

- **Affects:** mineflayer-auto-eat 5.0.3 `eat()` / its automatic mode (same code on Java)
- **Java / Bedrock:** identical upstream bug: `eat()` sets its "eating" flag before equipping the food and clears it
  only on the paths after the meal started; an equip that throws (other code or a fight swapping the hand at the same
  moment, a window open) leaves the flag set, and the automatic mode (`physicsTick` → `if (!_eating) eat()`) never
  tries again (observed: a bot went on with food 5 and 5 cooked meals in its inventory for minutes).
- **bedboo:** fixed in the [mineflayer-auto-eat patch](#auto-eat): the flag is cleared after a failure before the
  meal. As a last resort, resetting a meal that has been "in progress" for 15 s is still a sensible safety net.

## mineflayer-auto-eat against the pathfinder's held item  {#auto-eat-livelock}

- **Affects:** bots that dig or place while hungry with mineflayer-auto-eat enabled
- **Java / Bedrock:** identical upstream behaviour. auto-eat starts a meal on any physics tick where the food level is
  under `minHunger` and something edible is carried (it equips the food and holds "use"); it gives the meal up with
  "Item switched early" as soon as the held item changes. mineflayer-pathfinder equips a tool to dig and a block to
  place — on the next tick auto-eat equips the food again. A hungry bot whose path needs digging or a block placed does
  neither (measured: a bot stood 12 min next to a lava pool, food 4, nine rotten flesh carried, every walk timing out).
- **bedboo:** nothing patched. Workaround: eat first, standing still (auto-eat's own `eat()` with the pathfinder
  stopped), before a task that digs or places; do not treat a meal in progress as an interruption to retry forever;
  bound retries and searches by time.

## mineflayer-pvp 1.3.2 patch, shield and timing  {#pvp}

- **Affects:** `bot.pvp` (creeper shield block, shield use, attack timing, `followRange`)
- **Java:** a fusing creeper is metadata index 16 = 1; the shield is raised with `activateItem(true)`; the attack rate
  follows Java's weapon cooldowns.
- **Bedrock:** a fusing creeper has the `ignited` entity flag; a shield is raised by sneaking (no use action, see
  [Item use, eating and the shield](inventory.md#item-use)); there is no attack cooldown.
- **bedboo (patch):** `checkExplosion` also reads `metadata.flags.ignited` (measured live: the flag is set, pvp raises
  the shield). Unpatched:
  - `activateItem(true)` / `deactivateItem()` hold / release sneak, so the bot moves at sneaking speed between attacks
    while it holds a shield; that sneak is the shield's own, so pathfinder's `clearControlStates()` (each time a chase
    ends, before a dig or placement, on `stop()`) does not lower it;
  - the Java cooldown timing just attacks a little slower than Bedrock allows;
  - with the default `followRange` 2 a skeleton that backs off while shooting stays 4 blocks away (`GoalFollow`
    re-plans only when the target moved more than the range; the same on Java): use `bot.pvp.followRange = 1` against
    ranged mobs;
  - pvp listens to `physicTick` (mineflayer prints its deprecation warning, as on Java).

## Core fixes found by running the plugins  {#core-fixes}

- **Affects:** `bot.stopDigging`, `bot.creative.flyTo`, `bot.waitForChunksToLoad`
- **Java:** n/a (library behaviour the plugins rely on).
- **Bedrock:** the plugins exercise timing that the basic API calls do not.
- **bedboo:**
  - `lib/plugins/digging.js`: `blockUpdate` listeners run before the dig's per-position one; mineflayer-pathfinder
    stops digging on any change near its path, so every pathfinder dig ended as `diggingAborted` ("Digging aborted")
    although the block broke. A `stopDigging` while the block is already broken now completes the dig like upstream
    (whose `finishDigging` clears `targetDigBlock` before the local update).
    `bot._bedrock.digging.blockDigTime(block, type, creative, inWater, notOnGround, enchantments, effects)`
    (prismarine-block's signature, Bedrock factors) is provided for the plugins' cost estimates.
  - `lib/plugins/physics.js`: the creative `flyTo` planner never re-presses forward within 10 ticks of releasing it
    (BDS sprint-flies after a double-tapped forward), keeps its jump guard across consecutive `flyTo` calls and never
    lands short of a destination above the landing spot (BDS stops the flight when the player touches the ground); see
    [flight](movement.md#flight).
  - `waitForChunksToLoad`: called on "loaded" right after a teleport, it timed out because columns BDS sent during the
    join (beyond its advertised publisher radius) were unloaded and never resent; `lib/plugins/blocks.js` now keeps
    them.

## Ported mineflayer examples  {#examples}

- **Affects:** the library's `examples/`
- **Java:** mineflayer 4.39.0 `examples/` (`require('mineflayer')`).
- **bedboo:** 51 example files ported with `require('bedboo')` and otherwise identical (Java item / block names they
  hard-code are kept: e.g. fisherman's `fish`, graffiti's `sign` are not Bedrock names — nor modern Java ones).
  `auto-eat.js` is adapted to the pinned mineflayer-auto-eat 5 API (ESM `import()`, `setOpts`, `enableAuto` /
  `disableAuto`, `eatStart` / `eatFinish`), which upstream's example predates. Not ported: `session.js` (Java
  launcher-profile authentication), `discord.js` / `telegram.js` (third-party bots, nothing Bedrock-specific),
  `perfectShotBow.js` (minecrafthawkeye, Java), `viewer/`, `screenshot-with-node-canvas-webgl/` (prismarine-viewer:
  Java chunks), `anvil_saver/` (Java Anvil world files), `python/`. Where an example needs Bedrock behaviour:
  - `/op` from a player is refused by BDS; op through the server console ([op command](chat.md#op-command));
  - `bee.js` (creative `flyTo`) really flies on Bedrock: its 11 short legs take ≈ 15.5 s instead of ≈ 3 s
    ([flight](movement.md#flight));
  - `inventory.js`: `equip off-hand` only takes off-hand items such as arrows, not dirt ([off-hand](inventory.md#offhand)).
