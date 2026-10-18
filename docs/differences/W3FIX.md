# Differences — W3-FIX-A (wave-3 gate fix-ups: movement, flight, lifecycle, abilities)

Behaviour changed by the wave-3 review fix-ups (W3-FIX-A) that differs from mineflayer 4.39.0 because of Bedrock.
The owning units' entries (U5, U8, U9) link here where their text changed.

### Sneak / sprint before a click  {#controls-before-clicks}
- **Affects:** `bot.setControlState('sneak' | 'sprint')` followed at once by a click (`placeBlock` / `activateBlock`
  against an interactable block, `attack` with sprint knockback, `useOn`); `bot._bedrock.physics.controlsSent()`.
- **Java:** mineflayer writes `entity_action` / `player_input` inside `setControlState`, so the next click is handled
  with the new state.
- **Bedrock:** sneaking and sprinting only exist as `player_auth_input` flags (`start_sneaking`, `sneaking`, …), sent
  once per tick; BDS handles a transaction queued before that input with the old state (verified on BDS 1.26.51.1: a
  sneak-click on a chest opened it instead of placing the held block).
- **mineflayer-bedrock:** clicks that depend on the state wait for the input that carries it: `useItemOn` / `useOnEntity`
  (lib/bedrock/transactions.js) await `bot._bedrock.physics.controlsSent()` when a sneak / sprint change is pending;
  the synchronous `bot.attack` / `useOn` / `mount` (entities.js) send through `afterControlsSent(fn)`. The click is at
  most one tick (50 ms) later than upstream's; with nothing pending it is queued synchronously, as before. If the input
  is suspended first (loading screen, dimension change) the click goes out at once; after `end` it is dropped
  (`controlsSent()` rejects).
- **Tests:** `test/unit/physics_fixes.test.js` › "sneak / sprint before a click: …",
  `test/external/physicsInteractions.test.js` › "sneak, then useItemOn at once: the stone is placed on the chest (not
  opened)".

### Item use slowdown and the raised shield  {#item-use}
- **Affects:** movement while `bot.usingHeldItem` (eating, drawing a bow, a raised shield).
- **Java:** mineflayer's physics does not slow item use down at all.
- **Bedrock:** BDS clamps the movement impulse (±0.1225) and drops sprinting while the player uses an item — which it
  enters only on a `click_air` transaction. A shield is raised by sneaking (no item use), so BDS simulates a plain sneak
  (measured: 3.81 blocks per 60 ticks for both).
- **mineflayer-bedrock:** the engine applies the item-use clamp only while `bot.usingHeldItem` is set and a `click_air`
  was sent for that use (observed on the outgoing transactions; `item_release` / `completed_using_item` end it). A
  raised shield moves exactly like a sneak, without corrections.
- **Tests:** `test/unit/physics_fixes.test.js` › "a raised shield …", `test/external/physicsInteractions.test.js` › "a
  raised shield (activateItem(true)) walks like a plain sneak: same distance, no mispredictions".

### 'spawn' after the spawn search height  {#spawn-search-height}
- **Affects:** `spawn` after the End exit portal and after a respawn into another dimension.
- **Java:** the server sends the position before the health update that makes mineflayer emit `spawn`.
- **Bedrock:** the End exit's `change_dimension` carries y 32767 (the spawn search height); BDS answers the dimension
  ack at once and sends the real position ~50 ms later in `respawn` state 1. In a respawn into another dimension BDS
  often corrects the respawning player to the search height (`correct_player_move_prediction` y 32768.62, before or
  after the real `respawn` state 1; seen in 4 of 6 deaths in the nether) and to the real position ~300 ms later.
- **mineflayer-bedrock:** the `change_dimension` / `respawn` search heights are not applied (no `move` / `forcedMove`
  there), and while the bot's last server position is the search height `spawn` waits for the real one (the next
  `forcedMove` below it, emitted first), at most 2 s; the input clock stays suspended (End exit) or the bot stays in
  the respawning state meanwhile.
- **Tests:** `test/unit/physics_fixes.test.js` › "End exit: …", "a respawn into another dimension …";
  `test/external/dimensionTravel.test.js` (every travel asserts the position at `spawn`).

### Creative flight and gravity  {#flight-gravity}
- **Affects:** `bot.creative.startFlying`, `bot.creative.stopFlying`, `bot.physics.gravity`.
- **Java:** `startFlying` sets `bot.physics.gravity = 0`, `stopFlying` restores it.
- **Bedrock:** flight is a server-side movement state that the physics engine simulates itself (U5).
- **mineflayer-bedrock:** with the physics flight hook, `startFlying` / `stopFlying` only request the flight and leave
  `bot.physics.gravity` untouched (a gravity of 0 would outlive a flight the server refused or ended — game mode change,
  death — and break every later movement and pathfinder's simulations). Without the hook, upstream's gravity handling.
- **Tests:** `test/unit/physics_fixes.test.js` › "creative.startFlying leaves bot.physics.gravity alone …",
  `test/unit/inventory.test.js` › "creative flight: startFlying / stopFlying → bot._bedrock.physics.setFlying (gravity
  untouched with the hook); flyTo → physics.flyTo (U5)", `test/external/creative.test.js` › "startFlying / stopFlying /
  flyTo (flight: U5 physics hook)".

### Abilities events  {#abilities}
- **Affects:** `bot.abilities`, `abilities` event.
- **Java:** one `abilities` packet per change (join, game mode change, …).
- **Bedrock:** besides the game mode's abilities the client derives itself (U9), BDS sends `update_abilities` twice in
  answer to a `request_ability`, and after a game mode change that changes the flight (flying → survival, into / out of
  spectator) — repeating values the bot already has (measured on BDS 1.26.51.1).
- **mineflayer-bedrock:** an `update_abilities` that changes nothing emits no `abilities` and keeps the `bot.abilities`
  object (the join's first one is always reported); a game mode change is reported once. In spectator BDS's layers
  clear `mayFly` while `flying` stays on. `bot.abilities` is the only flight state source: the physics engine follows
  it without sending `request_ability` back.
- **Tests:** `test/unit/physics_fixes.test.js` › "abilities.js is the single flight source: …",
  `test/external/playerState.test.js` › "playerState: abilities at join and per game mode".

### Plain items from the creative inventory  {#creative-defaults}
- **Affects:** `bot.creative.setInventorySlot` with a plain `firework_rocket`, `firework_star` or `banner`.
- **Java:** any item, any NBT.
- **Bedrock:** the creative inventory lists these only with NBT (rockets `Fireworks {Flight: 1, Explosions: []}`, banners
  `Type: 0`, stars per colour).
- **mineflayer-bedrock:** an item without NBT that has no exact entry gets the entry with the fewest NBT tags when
  exactly one has the fewest (the default variant); the slot then holds that NBT. Enchanted books (all variants alike)
  stay refused.
- **Tests:** `test/unit/physics_fixes.test.js` › "creative.setInventorySlot entry: …",
  `test/external/physicsInteractions.test.js` › "elytra + a plain firework rocket: …".

### The rider's position  {#riding}
- **Affects:** `bot.entity.position` and `move` while `bot.vehicle` is set, the position after `bot.dismount()`.
- **Java:** the client simulates the vehicle and the rider sits on it.
- **Bedrock:** BDS simulates the vehicle from the rider's input and keeps the rider at the vehicle's seat: vehicle
  position + the `rider_seat_position` actor data (measured on BDS 1.26.51.1: boat seat (0, 1.02, 0) above the boat's
  wire position = feet 0.225 below the boat's feet; horse (0, 2.32, −0.2) = feet 0.7 above, 0.2 behind). It sends a
  vehicle correction every 6 ticks and does not always teleport a boat rider on dismount (it keeps the reported
  position).
- **mineflayer-bedrock:** while riding, every `player_auth_input` reports that seat (the vehicle's latest position from
  move_entity or a vehicle correction, the seat rotated by the vehicle's yaw) and `bot.entity.position` follows it
  (`move` fires as the vehicle moves); vehicle physics is not predicted. Seat offsets along x / z are rotated by the
  vehicle's reported yaw: the measured single-rider seats have none; a two-rider boat's seats are not verified.
- **Tests:** `test/unit/physics_fixes.test.js` › "riding: every input reports the vehicle seat …",
  `test/external/riding.test.js` (the rider stays at the seat and gets off next to the boat / horse).
