# World and blocks

How bedboo keeps the world model (`bot.blockAt`, `blockUpdate`) in step with Bedrock's block layers and block
updates, and how world state (time, weather, game rules), signs, command blocks, block actions and portals differ.
Observed on BDS 1.26.51.1 (protocol 2193).

## Waterlogging (block layer 1)  {#waterlogging}

- **Affects:** `bot.blockAt`, `blockUpdate`, `bot.world`.
- **Java:** a `waterlogged=true` block state.
- **Bedrock:** a second block storage layer: layer 0 is the block, layer 1 the liquid (`update_block.layer`,
  `update_subchunk_blocks.extra`, two-layer sub-chunks).
- **bedboo:** `blockAt()` returns the layer-0 block; when layer 1 holds water it carries `block.superimposed` (the
  layer-1 Block), `block.computedStates.waterlogged = true` and `block.isWaterlogged = true` (prismarine-chunk's
  Bedrock representation; bedboo's patch only superimposes non-air layer-1 entries). Layer-1 updates emit
  `blockUpdate` like layer 0. BDS sends only layer 0 when a block replaces water or a waterlogged block: the liquid
  layer then follows Bedrock's rule ([liquid layer](#liquid-layer)).

## The liquid layer of replaced blocks  {#liquid-layer}

- **Affects:** `bot.blockAt(…).isWaterlogged` / `.superimposed` / `.computedStates.waterlogged`, `blockUpdate`, the
  physics engine's water (it reads `isWaterlogged`).
- **Java:** `waterlogged` is a block state: every block update carries it.
- **Bedrock:** waterlogging is block layer 1, and BDS sends only the layer-0 change when a block replaces a water
  source or a waterlogged block (`update_block` layer 0, or `update_subchunk_blocks` with an empty `extra`); the client
  applies the liquid-layer rule itself. Observed live (a fresh join as ground truth): a fence, ladder, slab, carpet or
  wall placed into a water source is waterlogged; a waterlogged fence replaced by a slab / carpet / wall stays
  waterlogged, replaced by stone / glass it is dry, replaced by air or water it is plain water; flowing water (not a
  source) and lava never end up in layer 1. Bedrock's can-contain-liquid set differs from Java's `waterlogged` blocks
  (carpets are waterloggable) and no client data lists it.
- **bedboo:** a layer-0 update whose new block is air or a liquid clears layer 1, and the same block in another state
  (a trapdoor toggling, kelp growing) keeps its layer; both are certain. Any other block replacing a water source or a
  waterlogged block is predicted (a full cube dry, any other block keeping / taking the water; one `blockUpdate` with
  both layers) and then confirmed: the bot requests that sub-chunk again (one `subchunk_request` per sub-chunk at a
  time, sent again after 5 s without an answer, up to 3 times) and applies the server's layer 1 for those blocks (one
  more `blockUpdate` where the prediction was wrong; a block whose layer 0 changed again meanwhile is left to its own
  update, and a block changed while the request was out is asked for again).

## Falling blocks (`update_block_synced`)  {#falling-blocks}

- **Affects:** `bot.blockAt`, `blockUpdate` / `blockUpdate:(x, y, z)`, `bot.world`, everything reading them (physics,
  digging, mineflayer-pathfinder).
- **Java:** `block_update` turns the block into air when it starts falling (the falling block is an entity) and sets
  it where it lands.
- **Bedrock:** gravel, sand, concrete powder, anvils, … starting to fall and landing are sent as
  `update_block_synced` only, never as `update_block`: the start position becomes air with
  `transition_type: 'create'` (followed by `add_entity minecraft:falling_block`), the landing position the block with
  `'destroy'` (followed by `remove_entity` of the falling block ~150 ms later). A block placed in mid-air
  (`/setblock`, a placement) first comes as `update_block`, then starts falling ~100 ms later. `entity_unique_id` is
  the falling block's unique id written as an unsigned varint64 (bedrock-protocol reads it as zigzag64: -4294967288
  arrives as 9223372034707292164). A client that ignores these packets keeps a fallen block in the air and does not
  see the landed one, and the server then suffocates the bot in a block the client shows as air.
- **bedboo:** `update_block_synced` is applied like `update_block` (layer, runtime id → state id, the
  [liquid-layer rule](#liquid-layer), block entities), with `blockUpdate` events: pathfinder re-plans, and a dig of a
  block that fell away completes (as on Java, where the block turns into air).

## Burning furnaces and other "lit" blocks are separate blocks  {#block-variants}

- **Affects:** `bot.findBlock` / `bot.findBlocks` / `bot.blockAt` with furnaces, blast furnaces, smokers, redstone
  ore, redstone lamps, redstone torches, repeaters, comparators, daylight detectors; `bot.openFurnace`.
- **Java:** one block with a `lit` / `powered` / `inverted` state (`furnace[lit=true]`): matching by the block id finds
  it in every state.
- **Bedrock:** two blocks with their own ids: `furnace` / `lit_furnace`, `blast_furnace` / `lit_blast_furnace`,
  `smoker` / `lit_smoker`, `redstone_ore` / `lit_redstone_ore`, `deepslate_redstone_ore` /
  `lit_deepslate_redstone_ore`, `redstone_lamp` / `lit_redstone_lamp`, `redstone_torch` / `unlit_redstone_torch`,
  `unpowered_repeater` / `powered_repeater`, `unpowered_comparator` / `powered_comparator`, `daylight_detector` /
  `daylight_detector_inverted`. A furnace that burns is `lit_furnace` until it goes out.
- **bedboo:** the registry keeps the Bedrock blocks (`bot.findBlock({ matching: furnace.id })` misses a burning
  furnace). `bot.bedrock.blockVariants(nameOrId)` returns the ids of the group (`blockVariants('furnace')` →
  `[furnace, lit_furnace]`; other blocks → `[id]`) for `matching` (see [Bedrock extras](../api.md#bedrock-extras)).
  `openFurnace` accepts the lit blocks (window type and total cook time of the unlit block); a furnace window stays
  open when its block lights up or goes out.

## A door's upper half takes its shape from the lower half  {#door-halves}

- **Affects:** `bot.blockAt(<upper half of a door>).shapes`, physics collisions in a doorway, mineflayer-pathfinder
  through doors.
- **Java:** both halves carry `open`, `facing` and `hinge`.
- **Bedrock:** the open state and the facing live on the lower half and the hinge on the upper half: BDS never sets the
  upper half's `open_bit` (measured on 1.26.51.1, also checked with `testforblock`), and the vanilla client draws both
  halves from both. Per-state shapes therefore give an open door's upper half the closed leaf: the bot bumps its head
  in the doorway (server correction), and mineflayer-pathfinder finds no way back through a door it opened (NoPath, or
  it digs the door with `canDig`).
- **bedboo:** `bot.blockAt()` (`lib/plugins/blocks.js`) gives each half of a door the shapes of the combined state (open
  state and facing of the lower half, hinge of the upper half); `stateId` and `getProperties()` stay the server's
  (`open_bit` of the upper half stays 0: read the lower half).

## World time  {#world-time}

- **Affects:** `bot.time.*`, `time` event.
- **Java:** `update_time` every 20 ticks (world age + day time; 26.1: per-dimension clocks).
- **Bedrock:** no set_time packet at all: the `minecraft:overworld` world clock of `sync_world_clocks`
  (`initialize_registry` with time markers, `sync_state` on `/time set|add` and occasionally); the daylight cycle is
  the `doDayLightCycle` game rule; there is no world age.
- **bedboo:** `bot.time.time` = the world clock (absolute day time, in every dimension), the derived fields as
  upstream; `doDaylightCycle` comes from the game rule (a change emits `time`); `bigAge` / `age` = the server tick
  (`start_game.current_tick` + elapsed ticks). Between syncs the clock runs locally (while the cycle is on and the
  clock is not paused) and `time` is emitted every 20 physics ticks like Java's broadcast. `bot.time.clocks` holds the
  Bedrock clocks keyed by name (`overworld`): upstream's `{ id, totalTicks, partialTick, rate }` + `name`, `paused`,
  `timeMarkers`.

## Weather levels  {#weather}

- **Affects:** `bot.rainState`, `bot.thunderState`, `weatherUpdate`.
- **Java:** `game_state_change` start / stop raining + rain / thunder level changes while the server fades them.
- **Bedrock:** `level_event` start_rain / stop_rain / start_thunder / stop_thunder with the *target* level × 65535;
  clients fade locally. At join, `start_game.rain_level` / `lightning_level` carry the current (fading) levels and no
  level_event follows.
- **bedboo:** `isRaining` / `rain` exactly as upstream (zero crossings, one event per change); `rainState` /
  `thunderState` are the target levels of the level events (0 or 1 on BDS) and the start_game levels at join; one
  `weatherUpdate` per level event.

## Game rules  {#game-rules}

- **Affects:** `bot.bedrock.gameRules` (a [Bedrock extra](../api.md#bedrock-extras)), `bot.game.enableRespawnScreen`.
- **Java:** no client-side game rule state (only reducedDebugInfo / immediate respawn through game events).
- **Bedrock:** every game rule comes in `start_game.gamerules` and `game_rules_changed`.
- **bedboo:** `bot.bedrock.gameRules` (`{ [Bedrock name]: boolean | number }`, e.g. `doDayLightCycle`,
  `keepInventory`); `bot.game.enableRespawnScreen` comes from `doImmediateRespawn` at join, like upstream's login
  field.

## Signs  {#signs}

- **Affects:** `bot.updateSign`, `signOpen`, `block.signText`.
- **Java:** `open_sign_entity`; `update_sign` with four lines; the server echoes `tile_entity_data`.
- **Bedrock:** `open_sign { position, is_front }`, sent when the player places a sign or interacts with an unwaxed
  sign; one edit per opening. The edit is a `block_entity_data` with the whole sign compound: `FrontText` /
  `BackText` compounds, each with one `Text` string (lines joined by `\n`) and style fields.
- **bedboo:** `updateSign(block, text, back)` keeps upstream's validation (4 lines, 45 characters) and sends the
  block's current sign compound with that side's `Text` replaced. prismarine-block's Bedrock sign helpers are patched
  to read / write FrontText / BackText (`getSignText()` → `[front, back]` like Java's multi-sided signs; upstream read
  a top-level `Text` and threw).

## Command blocks  {#command-block}

- **Affects:** `bot.setCommandBlock`.
- **Java:** `update_command_block` (mode, flags); the server answers with `advMode.setCommand.success`.
- **Bedrock:** `command_block_update` with mode names (`impulse` / `repeat` / `chain`; the mode is the block:
  `repeating_command_block`, `chain_command_block`), `needs_redstone`, `conditional`, `should_track_output`. BDS sends
  no message: the updated block entity comes back (`Command`, `auto`, `conditionalMode`, `TrackOutput`). It ignores
  updates of command blocks out of the player's reach.
- **bedboo:** same signature, options and checks (creative mode via `bot.game.gameMode`); mode 0 / 1 / 2 →
  chain / repeat / impulse, `alwaysActive` → `!needs_redstone`. Like upstream, a non-object `options` (e.g. `false`)
  is accepted. Wait for the block entity update instead of a chat message, and place the command block within reach.

## Explosion damages  {#explosion}

- **Affects:** `bot.getExplosionDamages`.
- **Java:** entities carry a `generic.armor` attribute; without it upstream returns `null` (not rawDamages).
- **Bedrock:** no armor attribute on the wire.
- **bedboo:** the vendored upstream plugin also accepts Java resource names (`minecraft:armor`, …) and the armor
  attribute bedboo synthesizes for entities ([equipment](entities.md#equipment)); a living entity (player / mob)
  without any armor attribute counts as unarmored instead of `null`. Same formula otherwise (Bedrock's explosion
  damage follows it).

## Block actions  {#block-actions}

- **Affects:** `noteHeard`, `pistonMove`, `chestLidMove`, `blockBreakProgressObserved`, `blockBreakProgressEnd`.
- **Java:** `block_action` (note block, piston, chest with player count) and `block_break_animation` (stage 0–9 with
  the breaker's entity id).
- **Bedrock:**
  - note blocks: `block_event { type: instrument, data: pitch }` (Bedrock instrument ids, e.g. 6 bell);
  - chests: `block_event { type: change_state, data: open count }`, double chests paired through their block
    entities (`pairx` / `pairz`);
  - pistons send no event: their `PistonArm` block entity goes NewState 0 → 1 → 2 → 3 → 0; `facing_direction` of
    pistons is 0 down, 1 up, 2 south, 3 north, 4 east, 5 west;
  - breaking: `level_event` block_start_break / block_break_speed (progress per tick × 65535) / block_stop_break,
    without breaker and stage, and sent to the breaking player too.
- **bedboo:** `noteHeard(block, registry.instruments[type], pitch)`; `chestLidMove(block, count, block2)` once per
  change, block2 = the paired half; `pistonMove(block, 0 | 1, Java face index)` at the push / pull start; break
  progress: stage 0 at the start, then one `blockBreakProgressObserved` per new stage computed from the speed,
  `blockBreakProgressEnd` on stop or block change; the entity is the nearest other player within 8 blocks (undefined
  when there is none); the bot's own digging position (`bot.targetDigBlock`) is skipped.

## Ray trace at pitch / yaw 0 (upstream bug fixed)  {#ray-trace}

- **Affects:** `bot.blockAtEntityCursor`, `bot.blockAtCursor`, `bot.blockInSight`, `bot.entityAtCursor`.
- **Java:** mineflayer 4.39.0 returns `null` when the entity's pitch or yaw is exactly 0 (`!entity.pitch ||
  !entity.yaw`): a level look, or facing north (the default orientation), never hits a block.
- **Bedrock:** not a protocol difference.
- **bedboo:** the vendored plugin only returns `null` for a missing pitch / yaw; everything else is unchanged.

## An end portal set inside the player can push it out  {#end-portal-push}

- **Affects:** `/setblock … end_portal` at the bot's position to send it to the End.
- **Java:** the end portal block has no collision; an entity inside it is teleported.
- **Bedrock:** `end_portal` has a 0.25-high collision box. A block set (`/setblock`) inside the player makes BDS push
  the player out of it; when that push wins against the portal check of the same ticks, the player stands next to the
  portal and nothing happens (traced live under load: `command_output` success, then `correct_player_move_prediction`
  moving the player 0.8 blocks away, no `change_dimension` within 30 s).
- **bedboo:** nothing to change in the library. To enter the End reliably, replace the block under the bot's feet
  with the portal and let the bot (creative flight stopped) fall onto it, the way a player walks into a portal.

## End portal block collision  {#end-portal-shape}

- **Affects:** walking into an end portal.
- **Java:** the end portal block has no collision box; touching it teleports.
- **Bedrock:** the data gives `end_portal` a 0.25-high collision box ([pushed out](#end-portal-push)); BDS teleports
  the player as soon as it touches the block.
- **bedboo:** nothing in the library. To enter a stronghold portal, walk from the stairs onto the frame ring and
  towards the ring's centre until the dimension changes.

## Chunks right after a long teleport  {#chunk-after-teleport}

- **Affects:** commands (e.g. `/setblock`) and block changes at the bot's position right after a teleport.
- **Bedrock:** right after a teleport 16–128 blocks away the target chunk may not be loaded on the server yet: a
  `/setblock ~ ~ ~ portal` there fails with `commands.setblock.outOfWorld` and no portal appears.
- **bedboo:** nothing in the library. Wait for `bot.waitForChunksToLoad()` (the server sends a chunk only once it has
  loaded it) before acting on the target chunk.

## Chests set by command  {#chest-pairing}

- **Affects:** large chests made with `/setblock`, `/replaceitem` into containers.
- **Bedrock:** `/setblock` pairs two adjacent chests when they face the same way along the axis perpendicular to their
  facing (the default facing north pairs them along x). Container slots are filled with
  `/replaceitem block <x y z> slot.container <n> <item> <count>`.
- **bedboo:** nothing in the library; the windows of such chests behave like placed ones.
