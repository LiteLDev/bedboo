# Digging and placing

How `bot.dig`, `bot.placeBlock`, `bot.placeEntity` and item use on blocks work on Bedrock, where the server breaks and
places blocks itself. Observed on BDS 1.26.51.1 (protocol 2193, bedrock-protocol 3.60.1).

## Server-authoritative block breaking  {#protocol}

- **Affects:** `bot.dig`, `bot.stopDigging`, `diggingCompleted`, `diggingAborted`, `bot.targetDigBlock`
- **Java:** the client sends `block_dig` start (status 0), waits `digTime` ms itself, sends finish (status 2) and sets
  the block to air locally; cancel = status 1.
- **Bedrock:** `start_game.server_authoritative_block_breaking` is true on BDS. Block actions ride
  `player_auth_input.block_action` (one input per tick). Measured behaviour:
  - `start_break` = the mouse goes down on the block. From that input on, BDS adds the break progress itself every
    tick — **the start tick counts** — using its own copy of the held item, effects, on-ground and eyes-in-water
    state, and destroys the block in the input where the progress reaches 1 (`ceil(1/speed)` inputs after and
    including the start one) **as long as the break is held**: no other action is needed. It reports the speed to
    every viewer (`level_event block_start_break` then `block_break_speed` every tick, data = progress per tick ×
    65535, floored) and the destruction with `update_block` (air) + `particle_destroy`, then the drops
    (`add_item_entity`).
  - `predict_break` (the client's "it broke") is accepted from that same input on; one input earlier BDS answers
    with an `update_block` restoring the block (and, while the break is held, still destroys it a tick later).
  - `continue_break` restarts the break on BDS: every one makes it send `block_stop_break` + `block_start_break`
    to all viewers (another player's crack animation and mineflayer's `blockBreakProgressObserved` restart every
    tick). `crack_break` is accepted and changes nothing.
  - `abort_break` ends the break. `stop_break` does **not**: after a completed break BDS keeps "holding" the
    position and destroys the next block placed there (even by `/setblock`) on its own.
  - The face and the look direction are not validated (any face, looking away, reach up to ~7 blocks all break).
  - Creative: `start_break` alone breaks instantly (no drops); `player_action creative_player_destroy_block` alone
    does nothing.
- **bedboo:** `start_break` (in the input after the look), nothing while the break is held, then `predict_break` once
  BDS' own per-tick progress reports (`block_break_speed`) show the break one tick from done — i.e. in the very input
  BDS completes it while client and server run in step (the earliest input BDS accepts, measured), later when the
  server runs behind, never early. A purely client-side tick count is not enough: on a loaded host BDS lags behind the
  client's input count and restores the block. When BDS sends no reports, bedboo uses its own count with one tick of
  margin.
  - Completion is the server's `update_block` (air, or a liquid for waterlogged blocks / ice), followed by
    `abort_break` to release the break state; `dig` settles once the input carrying it went out (≤ 1 tick later), so
    whatever the caller does next — placing a block at that spot, digging on — reaches BDS after the release
    (measured: a `/setblock` right after the update was otherwise broken again by BDS).
  - Creative and instant breaks (progress ≥ 1 in the first tick): `start_break` + `predict_break` in one input.
  - `stopDigging` / a new dig / death / a dimension change: `abort_break`.
  - The speed BDS reports for the dug block replaces the local estimate when they differ, so a mismatch never makes
    the client predict early.
  - Upstream's arm swing every 350 ms is kept (`animate`).
  - Legacy (non server-authoritative) servers get `start_break`, `crack_break` every tick, then `stop_break` + an
    `inventory_transaction` `break_block` after `digTime`, and the block is predicted locally like upstream. BDS is
    always server-authoritative, so this path cannot be exercised against it.

## dig() completes on the server's confirmation  {#completion}

- **Affects:** `bot.dig` (when the promise settles), `diggingCompleted`, `bot.lastDigTime`
- **Java:** the promise resolves when the client's own `digTime` timer fires (block set to air locally).
- **Bedrock:** the server destroys the block; a client-side air would be a guess the server may contradict.
- **bedboo:** `dig` resolves (and `diggingCompleted` fires with the air block) after the server's `update_block`: it
  arrives `digTime` − 1 tick + the round trip after the start input (measured over 848 timed digs on a local BDS:
  median −21 ms, −75…+44 ms vs `digTime`), and the dig settles with the release input up to one tick later (see
  [Server-authoritative block breaking](#protocol)).
  - BDS sends the destroyed block's `update_block` more than once within about a tick (the destruction, the answers
    to `predict_break` / `abort_break`): code that waits for "the next update" at that position should let them pass
    first.
  - "Broken" = air, a liquid (waterlogged blocks, kelp, coral fans and ice leave water; a bubble column over soul
    sand / magma), or a turtle egg with one egg less.
  - If the server shows no sign of breaking the block for 40 ticks after `predict_break` (no update, no speed report —
    BDS reports the speed every tick while it still breaks; e.g. adventure mode, protected or education-edition
    blocks) the dig is aborted like `stopDigging` (`diggingAborted`, rejection `Digging aborted: the server did not
    break <name> at <pos>`); upstream would resolve regardless.
  - A disconnect also rejects a pending dig (`Digging aborted: the connection ended`; upstream's timer would resolve
    it).
  - `bot._bedrock.digging` (internal) keeps diagnostics of the last digs (start / end time, ticks, the speed BDS
    reported, restores).

## Dig speed: Bedrock status-effect factors  {#dig-speed}

- **Affects:** `bot.digTime`, and `block.digTime(...)` (prismarine-block) as called directly by
  mineflayer-pathfinder / mineflayer-tool
- **Java:** Haste and Conduit Power multiply the speed by `1 + 0.2 × level`; Mining Fatigue by 0.3 / 0.09 / 0.0027 /
  0.00081 (levels 1–4+).
- **Bedrock (measured, `level_event` data):** Haste / Conduit Power (the higher level counts) multiply by
  `(1 + 0.2 × level) × 1.2^level` (I 1.44, II 2.016, III 2.7648, V 4.9766); Mining Fatigue by `0.21^level`
  (= 0.3^level × 0.7^level: I 0.21, II 0.0441, III 0.0093, IV 0.0019, V 0.0004). Everything else is Java's formula,
  verified on BDS: tool multipliers per material (from the Bedrock data, incl. golden 12 and copper 5), the tool tier
  still speeds up a non-harvesting tool (wooden pickaxe on iron ore), Efficiency `level² + 1` only when the tool
  multiplier is above 1, Aqua Affinity on the helmet, eyes in water ÷5, not on ground ÷5 (both: ÷25),
  `canHarvest ? 30 : 100`, hardness 0 = instant (BDS reports 65535 = 1.0), `ceil(1/speed)` ticks.
- **bedboo:** `bot.digTime` uses `lib/bedrock/dig_speed.js` (the same structure as prismarine-block's `digTime` with
  the Bedrock effect factors; without those effects it equals prismarine-block for every block × tool × water / air /
  enchantment). prismarine-block's own `block.digTime` keeps Java's effect factors (unpatched): plugin cost estimates
  that call it under Haste or Mining Fatigue are off by those factors (the dig itself is right, it waits for the
  server). The patched mineflayer-pathfinder and mineflayer-tool use
  `bot._bedrock.digging.blockDigTime` instead (see [mineflayer-pathfinder](plugins.md#pathfinder),
  [mineflayer-tool](plugins.md#tool)). For every diggable block, the speed BDS reports equals `bot.digTime`.

## Creative: no breaking with swords, the trident or the mace  {#creative-weapons}

- **Affects:** `bot.digTime`, `bot.dig` in creative mode
- **Java:** `digTime` is 0 for everything in creative (Java creative players cannot break blocks with a sword either;
  upstream ignores it and the server restores the block).
- **Bedrock (measured):** BDS restores the block when a creative player breaks it holding any sword, the trident or
  the mace; spears, tools, other items and the bare hand break instantly.
- **bedboo:** `digTime` is `Infinity` in creative with those items, so `dig` rejects at once with upstream's
  `dig time for <name> is Infinity` instead of waiting for the server.

## Eye-level water includes waterlogged blocks  {#eye-water}

- **Affects:** `bot.digTime`, `bot._getBlockAtEyeLevel` (unchanged)
- **Java:** upstream counts the eyes as under water when the eye-level block is `water` / `flowing_water`.
- **Bedrock:** water can also be the block's second layer (waterlogged blocks, kelp, seagrass).
- **bedboo:** eyes are under water in `water`, `flowing_water`, or a block whose layer 1 is water
  (`block.isWaterlogged`). `bot.entity.isInWater` is not used (same as upstream). Digging with the eyes under water
  takes 5× longer, and BDS agrees.

## 'auto' dig face  {#dig-face}

- **Affects:** `bot.targetDigFace`, the face of the block actions
- **Java:** `dig(block)` with `digFace` 'auto' looks at the block center and sends face 1 (top).
- **Bedrock:** BDS does not validate the face, but the vanilla client sends the face under its crosshair and the face
  drives the punch particles other players see.
- **bedboo:** 'auto' (with a look) uses the face through which the line of sight from the eyes to the block center
  enters the block (e.g. 4 = west when the bot is west of it, level with it). Face vectors, 'raycast' and
  `forceLook: 'ignore'` (face 1) are upstream's.

## Tool durability  {#durability}

- **Affects:** `bot.heldItem` durability after a dig, `heldItemChanged`
- **Java:** the server damages the tool and sends `set_slot`.
- **Bedrock:** the vanilla client attaches an `item_stack_request` `mine_block` { hotbar slot, predicted durability,
  stack id } to its `predict_break`; BDS only accepts it in the exact input the break completes (one input later it
  answers `status: error`) and then reports the durability in the response's `durability_correction` instead of
  sending the slot. Without the request BDS damages the tool itself and sends `inventory_slot` with the new `Damage`.
- **bedboo:** no `mine_block` request (the prediction lands in the completing input only while the server runs in
  step, see [Server-authoritative block breaking](#protocol)); the inventory model applies the server's
  `inventory_slot` (Damage +1 per block, the tool disappears when used up, `heldItemChanged` like Java's `set_slot`).

## Digging air  {#dig-air}

- **Affects:** `bot.dig(air)`, `bot.digTime(air)`, `registry.blocksByName.air.hardness`
- **Java:** air has hardness 0: `digTime` is 0 and `dig` resolves at once with `diggingCompleted`.
- **Bedrock:** minecraft-data PR #1335 and BDS's own block dump give air hardness -1 (unbreakable).
- **bedboo:** the data overlay sets air's hardness to 0 (`packages/bedrock-data/scripts/tables.js` `BLOCK_FIXES`), so
  `digTime(air)` is 0 like upstream. `bot.dig` of a block that is air in the world (also a stale Block of a block that
  is gone by now — a door's other half) completes at once with `diggingCompleted(air)` and sends nothing (BDS never
  reports breaking air). A stale air Block whose position holds a block by now is dug normally.

## Blocks that cannot be staged or dug  {#dig-everything}

- **Affects:** `bot.dig`, `bot.digTime` across the whole block registry
- **Java:** every diggable Java block can be placed and dug (a few excepted).
- **Bedrock:** the registry has 1,442 diggable blocks. On BDS 1.26.51.1 about 230 of them cannot be put into a
  survival test world or are never broken:
  - ids `/setblock` refuses: education-edition `element_*`, compounds and hardened glass, internal ids such as
    `unknown` / `info_update` / `reserved6`, and the `*_concrete_double_slab` / `*_wool_double_slab` states BDS
    1.26.51.1 does not know;
  - blocks that do not stay where they are set (coral wall fans, tripwire hooks, soul fire, bubble columns, …);
  - `frosted_ice` (melts during the dig);
  - the education-edition `allow` / `deny` / `border_block` (BDS never breaks them in survival).

  Attachments that face down by default (buttons, item frames, banners, levers) only stay when set on the floor
  (`facing_direction` 1) or on a wall. "Gone" after a dig = air or a liquid (ice, kelp, seagrass, coral fans and sea
  pickles leave water).
- **bedboo:** every other block was dug in survival with the fastest of netherite pickaxe / axe / shovel / hoe and
  shears (Efficiency V), a netherite sword and the bare hand: BDS' reported speed equalled `bot.digTime` and BDS
  never restored a dug block.

## Progress reports after an instant break  {#instant-break-report}

- **Affects:** `bot._bedrock.digging.last.serverSpeedData` (diagnostics)
- **Java:** no equivalent (the client times the dig itself).
- **Bedrock:** after an instant break BDS may report the block-break progress of what replaced the block (the water a
  plant in a water source leaves, e.g. `short_dry_grass`) — sometimes in the batch before the `update_block` of the
  break.
- **bedboo:** an instant break (start and predict in one input) keeps only an instant report (≥ 1 per tick: the dug
  block's own) as the server's speed; a slower one only counts as server activity.

## Placement protocol: click_block wrapped in start/stop_item_use_on  {#placement-protocol}

- **Affects:** `bot._genericPlace`, `bot.placeBlock`, `bot._placeBlockWithOptions`, `bot.placeEntity`, `blockPlaced`
- **Java:** `block_place` (location, direction, hand, cursor); the server answers with `block_change` for the clicked
  block and then the block across the face, whether or not it placed anything.
- **Bedrock:** like the vanilla client, a click on a block face is `player_action start_item_use_on` (clicked block,
  clicked block + face, face) → `inventory_transaction item_use click_block` (the exact server copy of the held item
  incl. its stack id, the clicked block's runtime id, the click point on the face, the face, the hotbar slot, the hand,
  the player position at EYE level, prediction `success`) → `player_action stop_item_use_on` (clicked block + face)
  150 ms later. Measured answers (≈ 80–120 ms locally): the inventory first (`inventory_content` of every window: the
  count, durability or new stack id after a use), then a burst of `update_block` — the clicked block, the block across
  the face, the clicked block's lower neighbour, the block across the face again, its upper neighbour, the clicked
  block again — and ~20 ms later the destination once more with the `place` sound. A refusal (an entity in the way,
  the player's own hitbox, an item that is not a block, out of the world) gets the same burst with the destination
  unchanged (plus a `set_entity_data` resync) and no inventory change.
- **bedboo:** `bot.placeBlock` / `bot._placeBlockWithOptions` are upstream's code (vendored verbatim);
  `bot._genericPlace` / `bot.placeEntity` keep upstream's checks, options, look and events. The answer has Java's
  shape (reference block first, then the destination), so upstream's `place_block.js` runs unchanged with its error
  messages (`Server refused to place <item> at <pos>: the block is still <name>`, `Server did not answer the placement
  at …`, `must be holding an item to place`). `_genericPlace` resolves as soon as the click is queued (upstream: right
  after `block_place`); the stop of a click is sent before the start of the next one (pairs never interleave).
  Placement is not predicted client-side (like upstream): the block appears with the server's update.

## Sneak-placing against interactive blocks  {#sneak-placing}

- **Affects:** `bot._genericPlace` and everything built on it (`placeBlock`, `placeEntity`; mineflayer-pathfinder)
- **Java:** mineflayer does not tell the server it sneaks ("TODO" in `generic_place.js`); mineflayer-pathfinder
  presses sneak itself for its `interactable.json` (Java names).
- **Bedrock:** BDS runs the clicked block's use action (open the chest / crafting table / furnace, toggle a door, open
  a sign's editor, …) instead of placing unless the player sneaks; the sneak keys travel in `player_auth_input`, which
  the server must have processed before the click (one input of ordering is enough; `set_entity_data` `sneaking` is
  the acknowledgement). A flying player never gets the `sneaking` state but the raw sneak keys of the input count.
- **bedboo:** when the reference block is interactive (`lib/bedrock/placement.js` `isInteractive`, Bedrock names:
  containers, stations, doors / trapdoors / gates except iron, buttons, levers, repeaters, comparators, signs, beds,
  cakes, item frames, …) `_genericPlace` holds the sneak control, waits until it went out with an input
  (`bot._bedrock.physics.controlsSent()` when present, else the next sent input) and the server acknowledged it (not
  while flying), clicks, then releases the sneak it pressed (a sneak the caller holds, e.g. mineflayer-pathfinder's, is
  kept). While riding nothing is pressed (sneaking dismounts on Bedrock). While flying the bot may descend a little
  during that tick (sneak = descend). This places on top of a chest, crafting table, furnace, wooden door, standing
  sign or barrel in survival, and against a chest in creative flight.

## Placements wait for the server's answer to the previous click  {#placement-serialization}

- **Affects:** `bot.placeBlock`, `bot._placeBlockWithOptions`, `bot.placeEntity`, `bot.activateItem` with buckets and
  boats — when several run at once or back to back
- **Java:** `block_place` carries no item: placements in flight never invalidate each other.
- **Bedrock:** every click carries the exact server copy of the held item; BDS gives the stack a new stack id after
  each use (`inventory_content`, right before its `update_block` answer) and refuses a click with the old one (live:
  two placements 0–30 ms apart → the second refused).
- **bedboo:** clicks are serialized in the placer (`lib/bedrock/placement.js`): the next click goes out once the held
  item was updated, the clicked block was answered, or after 500 ms. Sequential awaited placements (e.g.
  mineflayer-pathfinder) never wait; `Promise.all` of placements places all of them. A bucket / boat use
  (`activateItem` → the looked-at block) issued while a placement is unanswered keeps its target and hotbar slot and
  goes out after it. Other item uses (`activateBlock`, the `click_air` of `activateItem`) are not serialized: fired
  without awaiting right after a placement, they can still carry the old stack id.

## A click with a stale block state is retried  {#stale-click}

- **Affects:** `bot.placeBlock` / `_placeBlockWithOptions` against a block the server changed right before
- **Java:** `block_place` carries no block state.
- **Bedrock:** the click carries the clicked block's runtime id, and BDS refuses a click whose id is not its own state
  of that block. BDS changes some blocks a tick after a neighbour update (farmland and grass paths turn into dirt under
  a placed block, 50–90 ms after the placement's answer), so the next click against them was refused.
- **bedboo:** the answer to a click discloses the server's state of the clicked block; a refusal whose click carried
  another state is retried once with the block as it is now (a wrapper of the vendored `place_block.js` in
  `generic_place.js`). Any other refusal rejects like upstream. A click that changed the clicked block itself is never
  taken for a stale one: against a replaceable block (`snow_layer`, `short_grass`, `fern`, `vine`, `seagrass`, …) or a
  block the held item merges into (the same half slab → double slab, one more candle / sea pickle / snow layer /
  petal, a candle onto a cake) BDS puts the block into the clicked position and leaves the block across the face as it
  was — exactly like Java, so the call rejects with upstream's `Server refused` after one click (instead of clicking
  again and placing a second block above it); nor is a click that used up an item.

## A click whose held stack changed on the server is retried  {#stale-held}

- **Affects:** `bot.placeBlock` / `_placeBlockWithOptions` while items are picked up, given (`/give`) or otherwise
  added to the held stack (dig-then-place loops, mineflayer-pathfinder's scaffolding)
- **Java:** `block_place` carries no item.
- **Bedrock:** the click carries the exact server copy of the held item (its stack id). A pickup that merges into the
  held stack between the click and its processing gives the stack a new stack id first (`inventory_transaction`
  normal, then `inventory_content`), and BDS refuses the click (measured: 4 of 180 placements of a dig-then-place
  loop; a `/give` right before the click: every time).
- **bedboo:** the placer notes a server-side change of the held slot between the click and its answer (an
  `inventory_transaction` of that slot, or the stack grew); such a refusal is retried once with the server's copy (the
  client has it by then). Any other refusal rejects like upstream.

## Pillaring and bridging (mineflayer-pathfinder scaffolding)  {#scaffolding}

- **Affects:** `bot._genericPlace` (jump-placing), mineflayer-pathfinder `allow1by1towers` and bridging
- **Java:** pathfinder jumps and calls `placeBlock` under its feet as soon as they left the ground; a refused click
  resets the path (`place_error`) and it tries again.
- **Bedrock:** BDS refuses any block that intersects the player's server-side hitbox (measured: an overlap of 0.01
  block is refused; nothing is ever placed into the player, so there is no push-out). It processes a click after the
  player inputs sent before it, so the click must follow an input whose hitbox is clear of the destination.
- **bedboo:** while the bot rises out of the destination block, or keeps jumping (jump control held), the click waits
  (≤ 20 inputs) for the first input with the hitbox clear of the block and follows it; a bot that will not clear it
  clicks at once and gets the server's refusal like upstream. Measured (survival, gravity, local BDS):
  - manual pillar ×4 (place as soon as the feet left the ground): 0 refusals, 0 corrections;
  - pathfinder pillar ×5: 0 `place_error`, 0 corrections (≈ 0.45 s per block, the click goes out 2 ticks after the
    feet leave the ground);
  - manual bridge ×4 (sneak backwards to the edge, place against the side of the block below): 0 corrections;
  - pathfinder bridge ×5–6: unpatched, 3–4 corrections of 0.16–0.64 block, all from pathfinder's own `fullStop()`,
    which moves `bot.entity.position` to the block centre client-side ("the server will not tell the difference" on
    Java; a server-authoritative BDS does: it corrects the bot back, then it walks on). The patched pathfinder skips
    that recentring: 0 corrections (see [mineflayer-pathfinder](plugins.md#pathfinder)).

  Pillaring under a ceiling has its own limit: see [1×1 towers](plugins.md#towers).

## No placement from the off-hand  {#offhand-placing}

- **Affects:** option `offhand` of `bot._genericPlace` / `bot._placeBlockWithOptions` / `bot._placeEntityWithOptions`
- **Java:** `hand: 1` places the off-hand item.
- **Bedrock:** the off-hand only holds a few items (shield, totem, arrows, rockets, maps, …, see
  [Off-hand](inventory.md#offhand)) and the player never uses it on a block; a click with `hand: off_hand` and the
  off-hand item (or the main-hand item) places nothing (measured, with a block forced into the off-hand by
  `/replaceitem`).
- **bedboo:** the click is sent like the vanilla client would (hand `off_hand`, the off-hand's wire item), the server
  refuses and `placeBlock` rejects with upstream's refusal message; upstream's check for an empty off-hand is kept.

## placeEntity  {#place-entity}

- **Affects:** `bot.placeEntity`, `bot._placeEntityWithOptions`, `entityPlaced`
- **Java:** a click on the block (`block_place`); boats additionally `use_item` (a server raycast along the look); the
  entity is found by name (`EnderCrystal` / `end_crystal`, `boat`, `armor_stand`, the spawn egg's mob) within 2 blocks
  (3 for boats) of the destination; minecarts are not supported (assertion 'Unimplemented').
- **Bedrock:** everything is a click on a block: armor stands, end crystals (obsidian / bedrock), spawn eggs, minecarts
  (on a rail) and boats (BDS ignores a boat's `click_air`; the vanilla client clicks the water it aims at; boats can
  also be placed on land). Entity names: `ender_crystal`, `boat` / `chest_boat` (chest boats, rafts), `armor_stand`,
  `minecart` / `chest_minecart` / …, spawn eggs `villager` → `villager_v2`, `zombie_villager` → `zombie_villager_v2`,
  `evoker` → `evocation_illager`, `tropical_fish` → `tropicalfish`. A hostile mob's spawn egg spawns nothing in
  peaceful (the egg is used).
- **bedboo:** upstream's code with:
  - a boat whose reference block is a liquid clicks the liquid's top face (it spawns centred on it whatever face was
    given; the look does not matter, so it never lands on the bot);
  - minecarts accepted (on a rail), chest boats also on land;
  - the Bedrock names above;
  - upstream stops listening after the first `entitySpawn` even when it is another entity (and then always times out
    after 5 s); here the listener stays until the placed entity spawned or the timeout ('Failed to place entity',
    unchanged).

## Item use on blocks: buckets, flint and steel, bone meal, fireworks  {#item-use-on-blocks}

- **Affects:** `bot.placeBlock` / `bot.activateBlock` / `bot.activateItem` with these items
- **Java:** `activateItem` (`use_item`) uses a bucket or a boat on the block the player looks at (server raycast);
  `placeBlock` / `activateBlock` with a bucket, flint and steel or bone meal acts on the clicked block.
- **Bedrock:** BDS ignores `click_air` for buckets and boats (measured: nothing happens); the vanilla client clicks the
  looked-at block (`click_block`: an empty bucket on the liquid source itself, a filled bucket on the solid block behind
  the liquid, the liquid going across the face). `click_block` with flint and steel lights a fire (an obsidian frame
  becomes `portal` blocks), bone meal grows the clicked plant, a firework rocket on a block launches it; like Java a
  rocket used in the air without gliding does nothing.
- **bedboo:** `placeBlock` with a water / lava bucket resolves with `blockPlaced(air, water|lava)`, with flint and
  steel `blockPlaced(air, fire|portal)`; `activateBlock(<liquid source>)` with an empty bucket fills it.
  `bot.activateItem` with a bucket or a boat calls `bot._bedrock.placement.useOnLookedAtBlock(item, offHand)`, the
  Bedrock form of that use: a raycast along the look (liquids where the item acts on them), then the click. Other item
  uses: see [Item use, eating and the shield](inventory.md#item-use).
