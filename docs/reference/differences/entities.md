# Entities and players

How entities, players, the player list, combat events, riding and entity-related events differ between Java and
Bedrock, and how bedboo presents them through the mineflayer API. Observed on BDS 1.26.51.1 (protocol 2193,
bedrock-protocol 3.60.1) with wire probes (two bots, `/summon`, `/querytarget`, `/ride`, `/damage`, `/kill`,
`setblock … destroy`).

## Entity positions on the wire  {#positions}

- **Affects:** `entity.position` of every entity but the bot, `entitySpawn`, `entityMoved`.
- **Java:** spawn / move / teleport packets carry the feet position (or deltas of it).
- **Bedrock (measured):**
  - `add_player` is **feet** level (a player standing on y = -59: `add_player.position.y = -59`, `/querytarget` eye
    -57.38), but `move_player` of other players is **eye** level (feet + 1.62, also while sneaking);
  - `add_entity`, `add_item_entity`, `move_entity` and `move_entity_delta` are feet level plus a per-type offset: item
    0.125, primed TNT and falling blocks 0.49, boats and chest boats 0.375, minecarts (all kinds) 0.35, every mob,
    armor stand, XP orb, arrow, end crystal 0;
  - `move_entity_delta` (1.26.40+) carries ABSOLUTE coordinates, each one optional (absent = unchanged), and byte
    rotations (×360/256: `rot_x` pitch, `rot_y` yaw, `rot_z` head yaw; `/tp … 90 30` of an armor stand → `rot_x` 21,
    `rot_y` 64);
  - `move_entity.rotation` is already in degrees, in the same wire order (pitch, yaw, head yaw — PocketMine /
    gophertunnel / dragonfly) although bedrock-protocol labels the three bytes `yaw`, `pitch`, `head_yaw`; BDS
    1.26.51.1 itself sent only `move_entity_delta` in every probe (teleported mobs, armor stands, minecarts, boats,
    arrows);
  - Bedrock clients simulate items between sparse updates (`set_entity_motion`), so an item's last reported position
    can lag its resting place by a few tenths of a block.
- **bedboo:** `entity.position` is always the feet position: the per-type offsets (`POSITION_OFFSETS` in
  `lib/plugins/entities.js`) and the player eye height are removed per packet. Yaw / pitch / `headYaw` are radians
  (mineflayer's notchian conversions); `move_entity`'s labelled `yaw` byte is read as the pitch and `pitch` as the yaw.

## Entity ids  {#entity-ids}

- **Affects:** `entity.id`, `bot.entities` keys, every entity event.
- **Java:** one int entity id per entity; packets for unknown ids create the entity on the fly (`fetchEntity`).
- **Bedrock:** a runtime id (varint64, most packets) and a unique id (zigzag64; `remove_entity`, `set_entity_link`,
  `player_list`, `update_player_game_type`; `add_player.unique_id` is an li64 that protodef reads as `[high, low]`).
- **bedboo:** `entity.id = Number(runtime id)`; `entity.runtimeId` / `entity.uniqueId` are BigInt and the pair is
  tracked in `bot._bedrock.ids`. Packets about runtime ids that were never added are ignored instead of creating
  empty entities at (0, 0, 0). After a dimension change every other entity is dropped (`entityGone` each), like the
  Java client discarding its old world.

## Entity names, types and metadata  {#metadata}

- **Affects:** `entity.name`, `displayName`, `type`, `kind`, `entityType`, `entity.metadata`, `entity.uuid`,
  `entity.getCustomName()`.
- **Java:** registry names/ids, metadata indexed by number, a UUID for every entity.
- **Bedrock:** identifiers like `minecraft:villager_v2`, `minecraft:xp_orb`; metadata keys are names (`flags`,
  `nametag`, `variant`, …); only players have a UUID on the wire.
- **bedboo:**
  - name / displayName / type / kind / entityType / width / height come from `registry.entitiesByName` (Bedrock names
    from the [Bedrock data](data.md#registry); types `hostile`, `animal`, `passive`, `ambient`, `mob`, `living`,
    `projectile`, `other`, `player` like modern Java; an unknown identifier → type `other`, name/displayName
    `unknown`, `entityType` = the identifier);
  - `entity.metadata[<Bedrock key>]` (named properties of the metadata array, merged per packet);
  - `entity.uuid` is set for players only;
  - `getCustomName()` reads the `nametag` key ('' = none) — a prismarine-entity patch;
  - Bedrock mobs such as foxes use the same sneaking flag as players: `entityCrouch` / `entityUncrouch` fire for them,
    but only players get the crouching hitbox (1.5 high, eyes at 1.27);
  - extras: `entity.health` (current health of living entities, from `minecraft:health`), `entity.count` of XP orbs
    (`experience_value`), `entity.sleeping`.

## Metadata, attributes and effects of the bot  {#self-metadata}

- **Affects:** `bot.entity.metadata`, `bot.entity.attributes`, `bot.entity.effects`, `entityUpdate`,
  `entityAttributes`, `entityEffect` / `entityEffectEnd`, `entityCrouch` / `entityUncrouch`, `entityElytraFlew`,
  `entitySleep` / `entityWake`.
- **Java:** metadata indexed by number; attribute values are base values + modifiers.
- **Bedrock:** metadata keys are names (`flags`, `flags_extended`, `air`, `nametag`, …); `update_attributes` sends the
  CURRENT value (modifiers already applied) with min/max/default; effects use Bedrock ids.
- **bedboo:**
  - `bot.entity.metadata[<name>]` (named properties of prismarine-entity's metadata array); flags drive `crouching`,
    `sprinting`, `swimming`, `onFire`, `elytraFlying` and the sleeping events;
  - attributes are keyed by the Java resource name (from the Bedrock data), `value` is the base value recovered from
    `current` and the modifiers (`minecraft:health` → `minecraft:max_health` = its max), plus `current`, `min`, `max`,
    `default`; Bedrock-only attributes keep their Bedrock name;
  - effects: `bot.entity.effects[<Bedrock id>] = { id, amplifier, duration }`;
  - `set_health` sets `bot.entity.health`.

## The bot's player record  {#self-player}

- **Affects:** `bot.player`, `bot.players[bot.username]`.
- **Java:** from player_info (skin textures, ping, gamemode).
- **Bedrock:** `player_list` (before start_game) with raw skin images and no ping.
- **bedboo:** `{ username, uuid, displayName, gamemode, ping: 0, entity, skinData: undefined }`. Every other player:
  see the [player list](#player-list).

## Player list  {#player-list}

- **Affects:** `bot.players`, `bot.player`, `bot.uuidToUsername`, `playerJoined`, `playerUpdated`, `playerLeft`,
  `player.ping`, `player.gamemode`.
- **Java:** player_info add / update_game_mode / update_latency / update_display_name / remove.
- **Bedrock:** `player_list` add / remove only — the players already online arrive BEFORE `start_game`, the last
  record of a packet may be truncated (`maybeIncompleteArray`); no latency; game mode changes come as
  `update_player_game_type { gamemode, player_unique_id }` (BDS sends it to every player); a re-sent record (the full
  list after the bot's own join) is an update.
- **bedboo:**
  - records received before `start_game` are applied after its reset (upstream resets the lists on login), once that
    login's `login` and `game` events were handled (upstream's order: player_info follows the login packet, so
    `bot.game` is set) — `playerJoined` fires for each, the bot included;
  - truncated records are ignored; `ping` is 0;
  - `gamemode` starts at the world default (the bot: its start_game mode) and follows `update_player_game_type`
    (`playerUpdated`); `playerUpdated` never fires for latency / display names.

## Display names  {#display-name}

- **Affects:** `player.displayName`.
- **Java:** player_info carries an optional display name (team prefixes, `update_display_name`).
- **Bedrock:** `player_list` has no display name; name tags are entity metadata.
- **bedboo:** `player.displayName` is always the username (a `ChatMessage`, like upstream's default).

## Skins  {#skin-data}

- **Affects:** `player.skinData`.
- **Java:** a `textures` property (base64 JSON or mojangson) → `{ url, model, capeUrl }`.
- **Bedrock:** `player_list` carries raw skin images (RGBA buffers, geometry JSON), no texture URL.
- **bedboo:** `skinData` is `undefined` for every player; malformed or truncated skin records never throw.

## Hurt and death  {#hurt-death}

- **Affects:** `entityHurt`, `entityDead`.
- **Java:** `damage_event` (1.20+; with the source entity) for every damage, `entity_status 3` for the death.
- **Bedrock:** `entity_event hurt_animation` (data = damage cause, no source entity) for non-lethal damage; the lethal
  hit (and `/kill`) sends `death_animation` only.
- **bedboo:** `hurt_animation` → `entityHurt(entity)` (no `source` argument: Bedrock does not say who hit; see
  [who hit whom](#hurt-source)); `death_animation` → `entityHurt(entity)` for the killing blow (unless a
  hurt_animation for it came in the same packet batch, i.e. the same server tick — batches are counted at
  bedrock-protocol's batch entry points, not per event-loop turn, so batches read back to back stay apart) then
  `entityDead(entity)`, matching Java's damage_event + status order. The local player gets both too.

## Who hit whom: `entityHurt` has no source  {#hurt-source}

- **Affects:** combat code that wants to know whether its own hit killed a mob (e.g. the combat library of
  `@bedboo/agent`).
- **Java:** `damage_event` carries the source entity (`entityHurt(entity, source)` in newer mineflayer).
- **Bedrock:** `entity_event hurt_animation` / `death_animation` carry no attacker (see [hurt and death](#hurt-death)).
- **bedboo:** unchanged events. `@bedboo/agent`'s combat library attributes a kill to the bot when the target's
  `entityDead` comes within 1.5 s of one of the bot's own `attack()`s (3 s of one of its arrows) after at least one
  `entityHurt`, with no other damage source around.

## Combat on Bedrock  {#combat}

- **Affects:** `bot.attack`, `bot.activateItem` / `deactivateItem` (bow, shield), mineflayer-pvp-style fighting.
- **Java:** since 1.9 an attack cooldown scales the damage of fast hits; a raised shield is an item use.
- **Bedrock:** no attack cooldown (every hit does full damage), but a hurt mob ignores damage for 10 ticks; a shield
  blocks while the player sneaks; arrows never hurt endermen (they teleport away); `/summon slime …
  minecraft:spawn_large` only sets the hitbox — the split count follows the size variant (1, 2 or 4).
- **bedboo:** the API is unchanged (`activateItem` with a shield sneaks: see [item use](inventory.md#item-use) and
  [item use slowdown](movement.md#item-use-slowdown)). `@bedboo/agent`'s combat library attacks every 10 ticks and
  never shoots endermen.

## Entity events  {#entity-events}

- **Affects:** `entityTaming`, `entityTamed`, `entityShakingOffWater`, `entityEatingGrass`, `entityEat`,
  `entitySwingArm`, `entityWake`, `entityCriticalEffect`, `entityMagicCriticalEffect`.
- **Java:** `entity_status` 6/7/8/10 and `animation` 0/2/3/4/5.
- **Bedrock:** `entity_event` `tame_fail` / `tame_success` / `shake_wet` / `eat_grass_animation` / `eating_item` /
  `arm_swing` (mob attacks) and `animate` `swing_arm` / `wake_up` / `critical_hit` / `magic_critical_hit`.
- **bedboo:** mapped one to one. `entityEat` comes from `eating_item`, which BDS sends for animals eating (a wolf fed a
  bone) — upstream's `entityEat` (animation 3) never fires on modern Java either. Like Java, the bot's own swing is
  not echoed as `entitySwingArm`. `entityWake` fires once per wake-up (the metadata or the animation).

## Hand swap  {#hand-swap}

- **Affects:** `entityHandSwap`.
- **Java:** `entity_status 55` when a player swaps main hand and off-hand.
- **Bedrock:** there is no such event; the swap shows up as `mob_equipment` changes.
- **bedboo:** `entityHandSwap` never fires; `entityEquip` reports the new equipment.

## Sleeping players  {#sleep}

- **Affects:** `entitySleep`, `entityWake`, `entity.sleeping`.
- **Java:** metadata pose = sleeping; animation 2 on wake-up.
- **Bedrock (measured):** a sleeping player has `player_flags` bit 1 (value 2) and `player_bed_position`; the
  `flags_extended` "sleeping" bit (as named by bedrock-protocol) stays clear for players. Other entities:
  `flags_extended`.
- **bedboo:** `entitySleep` / `entityWake` on the transitions of `player_flags` for players and of
  `flags_extended`.sleeping for other entities (an update without the key changes nothing). The bot itself follows
  `player_flags` too once it has seen one (`lib/bedrock/entity_data.js`).

## Swinging the arm  {#swing-arm}

- **Affects:** `bot.swingArm(arm, showHand)`.
- **Java:** `arm_animation` with the hand (main / off-hand), or no hand on 1.8.
- **Bedrock:** a single `animate swing_arm` (no off-hand swing animation, no hidden swing); 1.21.130+ adds an optional
  swing source.
- **bedboo:** `swingArm()` sends `animate swing_arm` for either arm; `arm` / `showHand` are accepted and ignored.
  `attack` swings with source `attack` like the vanilla client.

## Attacking and using entities  {#interact}

- **Affects:** `bot.attack`, `bot.useOn`, `bot.mount`, `bot.dismount`.
- **Java:** `use_entity` (attack / interact) or the 1.21.2+ `attack` packet; dismount with the jump input.
- **Bedrock:** `inventory_transaction item_use_on_entity` (attack / interact) carrying the exact held item and the
  player position; the vanilla client hovers the entity first (`interact mouse_over_entity`); getting off is
  `interact leave_vehicle`.
- **bedboo:**
  - like upstream the bot's view is left alone (BDS accepts attacks and interactions whatever the player faces,
    verified live: an attack on a zombie behind the bot, a boat mounted behind it);
  - the bot hovers the target when it changed, then sends the transaction (`click_pos` relative to the target's feet;
    held item from `bot._bedrock.heldNetworkItem()`); `attack` swings first (vanilla order);
  - the packets go through `bot._bedrock.physics.afterControlsSent`: at once, or — while a sneak / sprint change is
    not in a sent player_auth_input yet — right after the next one (upstream sends entity_action synchronously in
    setControlState; see [sneak / sprint before a click](movement.md#controls-before-clicks));
  - same synchronous API and return value as upstream. `dismount()` without a vehicle emits `error` like upstream.

## Vehicles  {#vehicle-entities}

- **Affects:** `bot.vehicle`, `entity.vehicle`, `entity.passengers`, `mount`, `dismount`, `entityAttach`,
  `entityDetach`, `bot.moveVehicle`.
- **Java:** `attach_entity` / `set_passengers`.
- **Bedrock:** `set_entity_link { ridden_entity_id, rider_entity_id (unique ids), type: 0 remove, 1 rider,
  2 passenger }`, also inside `add_entity.links` / `add_player.links` for entities spawned riding.
- **bedboo:** links update `vehicle` / `passengers` and emit `entityAttach(passenger, vehicle)` /
  `entityDetach(passenger, vehicle)`; for the bot `bot.vehicle` + `mount` / `dismount(vehicle)`. A repeated link is
  ignored. When the vehicle is removed under the bot, `dismount(vehicle)` fires (upstream registers that handler on
  the protocol client, where `entityGone` never fires — bedboo implements the intended behaviour). `moveVehicle`
  drives the vehicle through the per-tick input (`bot._bedrock.input.setVehicle`) and belongs to the physics plugin:
  see [vehicles](movement.md#vehicles) and [riding control](movement.md#riding-control).

## Getting off a boat or minecart  {#dismount}

- **Affects:** `bot.dismount()`, `dismount` / `forcedMove` events, `bot.entity.position` after a ride.
- **Java:** the server computes a dismount position (DismountHelper: a free spot around the vehicle, else on top of
  it) and teleports the rider there.
- **Bedrock:** BDS sends no teleport when a rider leaves a boat or a minecart (a horse rider may get a correction).
  The rider sits at the vehicle's seat (`rider_seat_position`, 1.02 above the vehicle's wire position, eye level),
  which puts its feet 0.1 into the block under a minecart on rails and 0.225 into the ground under a boat on land.
  BDS itself lifts its copy of the rider straight up out of that block (measured: a correction to the seat x/z on top
  of the block when the client reports anything else).
- **bedboo:** like BDS: on `dismount` the rider is raised from its seat until its box is free (a seat that is free —
  a boat on water — stays); the move is emitted like a teleport (`forcedMove`) and goes out with the next input, so
  the server's position equals the bot's and the bot can walk away (it does not stay buried one block down).

## The rider's seat across rides  {#rider-seat}

- **Affects:** `bot.entity.position` while riding.
- **Java:** the client does not move a passenger itself (mineflayer keeps the position at the mount point).
- **Bedrock:** the rider's position is its vehicle's seat. BDS sends `rider_seat_position` (actor data) only when it
  changes: the join's actor data has (0, 0, 0), the first boat or minecart sets (0, 1.02, 0), and later boats and
  minecarts send nothing.
- **bedboo:** the last seat is kept across rides (boat → minecart → boat: the rider follows its vehicle every time); a
  seat that is still unknown falls back to the boat / minecart seat or the top of the vehicle.

## The rider's position  {#rider-position}

- **Affects:** `bot.entity.position` and `move` while `bot.vehicle` is set, the position after `bot.dismount()`.
- **Java:** the client simulates the vehicle and the rider sits on it.
- **Bedrock:** BDS simulates the vehicle from the rider's input and keeps the rider at the vehicle's seat: vehicle
  position + the `rider_seat_position` actor data (measured on BDS 1.26.51.1: boat seat (0, 1.02, 0) above the boat's
  wire position = feet 0.225 below the boat's feet; horse (0, 2.32, −0.2) = feet 0.7 above, 0.2 behind). It sends a
  vehicle correction every 6 ticks and does not always teleport a boat rider on dismount (it keeps the reported
  position).
- **bedboo:** while riding, every `player_auth_input` reports that seat (the vehicle's latest position from
  move_entity or a vehicle correction, the seat rotated by the vehicle's yaw) and `bot.entity.position` follows it
  (`move` fires as the vehicle moves); vehicle physics is not predicted. Seat offsets along x / z are rotated by the
  vehicle's reported yaw: the measured single-rider seats have none; a two-rider boat's seats are not verified. The
  rider stays at the seat and gets off next to the boat / horse.

## Equipment and armor attributes  {#equipment}

- **Affects:** `entity.equipment`, `entity.heldItem`, `entityEquip`, `bot.getExplosionDamages(entity, …)`.
- **Java:** `entity_equipment` slots 0 main hand, 1 off-hand, 2 feet … 5 head, 6 body; armor / armor toughness are
  synced attributes.
- **Bedrock:** `mob_equipment` (window `inventory` = main hand, `offhand`) and `mob_armor_equipment { helmet,
  chestplate, leggings, boots, body }`; no armor attributes are sent.
- **bedboo:** same equipment indexes as upstream (0 hand, 1 off-hand, 2 boots, 3 leggings, 4 chestplate, 5 helmet,
  6 body). Living entities, players and the bot get live `generic.armor` / `generic.armorToughness` (what upstream's
  explosion plugin reads) and `minecraft:armor` / `minecraft:armor_toughness` attributes computed from the worn items
  (armor points and toughness per item from minecraft.wiki; enchantments not counted, as upstream). Non-living
  entities have none (`getExplosionDamages` returns null for them, like upstream).

## Dropped items  {#dropped-items}

- **Affects:** `entity.getDroppedItem()`, `itemDrop`, `playerCollect`.
- **Java:** the item stack is an item entity metadata entry; `itemDrop` fires on that metadata; `collect` packet.
- **Bedrock:** `add_item_entity` carries the item (ItemV4); `take_item_entity { runtime_entity_id: the item, target:
  the collector }`, then `remove_entity`. Stacks lying close together merge: `entity_event item_entity_merge
  { data: the new stack size }` on the surviving item, then `remove_entity` of the absorbed one (no metadata update).
- **bedboo:** the wire item is kept as `entity.metadata.item`; the prismarine-entity patch makes `getDroppedItem()`
  read it on Bedrock (prismarine-item `fromNotch`); `itemDrop` fires right after the item's `entitySpawn`; a merge
  sets the new count and fires `entityUpdate` + `itemDrop` like Java's item stack metadata update;
  `playerCollect(collector, collected)` with the item still readable.

## Paintings  {#paintings}

- **Affects:** `bot.blockAt(pos, true).painting`, mineflayer's `Painting`.
- **Java:** `spawn_entity_painting` (≤ 1.18; title / motive id, block position, direction) — 1.19+ paintings are
  ordinary entities.
- **Bedrock:** `add_painting { coordinates (the painting's center), direction 0-3, title }` (titles `Kebab`,
  `SkullAndRoses`, …).
- **bedboo:** both: a `painting` entity in `bot.entities` (`entitySpawn` / `entityGone`) and a `Painting(id, floored
  center, name, direction vector)` registered in the world; `name` is the modern Java variant name (`kebab`,
  `skull_and_roses`, …), the direction vector uses upstream's table.

## Firework boosts  {#fireworks}

- **Affects:** `usedFirework`, `bot.fireworkRocketDuration`.
- **Java:** the rocket's `attached_to_target` metadata names the boosted player.
- **Bedrock:** a boosting rocket is `add_entity minecraft:fireworks_rocket` with `owner_eid` -1 and names the boosted
  player's unique id in metadata key 18 (`minecart_has_display` in bedrock-protocol's names, a long for rockets); its
  item NBT is the display item (metadata key 16, `Fireworks.Flight`).
- **bedboo:** a `fireworks_rocket` attached to (key 18), owned or shot by the bot while the bot is gliding counts as a
  boost: `usedFirework(rocketId)` once per rocket and the upstream duration formula from the item's `Flight`. The
  physics side of a boost: see [elytra](movement.md#elytra).
