# Player state and survival

Death and respawn, dimension changes, experience, abilities, the spawn point, and the survival interactions beds,
fishing and books. Observed on BDS 1.26.51.1 (protocol 2193) with bedrock-protocol 3.60.1.

## Respawn handshake  {#respawn}

- **Affects:** `bot.respawn()`, the `respawn` option, `isAlive`, `death` / `respawn` / `spawn` events.
- **Java:** death = `update_health` ≤ 0; `client_command` (perform respawn) → server `respawn` packet →
  `update_health` → `spawn`.
- **Bedrock:** death = the player's own `entity_event death_animation` + `minecraft:health` attribute 0 (no
  `set_health` 0), then `respawn` state 0 (searching) at the death position. Respawning is a 3-step handshake: client
  `respawn` state 2 (client_ready; ignored by BDS when sent before the server's state 0) → server `respawn` state 0 +
  state 1 (ready, eye-level spawn position) → client `player_action respawn` → server `entity_event respawn` +
  `set_health 20`. A respawn into another dimension (death in the nether, spawn in the overworld) puts a
  `change_dimension` **without loading_screen_id** between the client state 2 and the server state 1; answering it
  with `serverbound_loading_screen` gets the client disconnected (`unexpected_packet`).
- **bedboo:** same API and event order as upstream (`health` → `death`; `respawn` at the server's state 1, the analog
  of Java's respawn packet; `spawn` once the server's health update says the player is alive, from the lifecycle).
  `bot.respawn()` sends state 2 once per death (waiting for the server's state 0 if needed); the `respawn: false`
  option keeps the bot on the death screen. The lifecycle sends no loading screen ack for a `change_dimension` without
  loading_screen_id and completes a dimension change during a respawn without `spawn`: one `respawn` and one `spawn`
  per death, also across dimensions. The join's and the End exit's respawn packets are not deaths. For the position
  at `spawn` after a respawn into another dimension see
  [spawn search height](connection.md#spawn-search-height).

## Creative players cannot die  {#creative-death}

- **Affects:** `/kill` (or any damage) on a bot in creative mode; setting the game mode of a dead bot.
- **Java:** `/kill` kills a creative player.
- **Bedrock:** "Players cannot be killed while they are in Creative mode" (not even by `/damage` or the void), and a
  game mode cannot be set on a dead player ("No targets matched selector").
- **bedboo:** nothing to change in the library. Switch the bot to survival or adventure before killing it; a
  non-default game mode (e.g. adventure) survives the respawn.

## Dimension change, End credits  {#dimension-change}

- **Affects:** `bot.game.dimension`, `respawn` / `game` / `spawn` events on a dimension change, the End exit portal.
- **Java:** a `respawn` packet with another dimension (+ `game_state_change win_game` for the credits, skipped with
  `client_command`).
- **Bedrock:** `change_dimension` (the feet position for `/execute in … tp`; a junk position followed by a
  `move_player` reset for portals) → client `player_action dimension_change_ack` → server `dimension_change_ack` →
  client `serverbound_loading_screen` 1 / 2 with the loading_screen_id. Leaving the End through the exit portal: BDS
  first sends `show_credits {status: 0}` (only the first time a player leaves the End) and waits, forever, for the
  client's `show_credits {status: 1}` before the `change_dimension` (`respawn: true`) to the overworld.
- **bedboo:** like upstream: `game` then `respawn` (isAlive false) at the change, `spawn` (isAlive true) when the new
  dimension is loaded; the credits are skipped at once (`show_credits` status 1), like upstream's `client_command`.
  Portal travel works by standing in `portal` (nether portal, Bedrock's name; a survival player needs ~4 s, a
  creative one ~1.5 s) and `end_portal` blocks. How the world is reset and which heights apply:
  [dimensions](connection.md#dimensions).

## Waiting for a tick across a dimension change  {#dimension-change-ticks}

- **Affects:** code that walks into a portal with `await bot.waitForTicks(1)` in its loop.
- **Java:** physics ticks go on through a respawn into another dimension.
- **Bedrock:** bedboo pauses physics while the player changes dimension (`change_dimension` → dimension change ack →
  `player_spawn`; the End exit also shows the credits).
- **bedboo:** `bot.waitForTicks(1)` waits through the change and rejects after 5 s ("Timeout waiting for 1 ticks"),
  although the bot arrived. A portal walk should wait for the next tick or for the `game` (the dimension switched),
  `spawn`, `respawn` or `death` event, whichever comes first, and await the arrival on `spawn` in the new dimension
  (the bedboo agent's `util.tick(bot)` does this and never rejects).

## Experience points  {#experience-points}

- **Affects:** `bot.experience.points`.
- **Java:** the server sends the total experience.
- **Bedrock:** `update_attributes` `minecraft:player.level` and `minecraft:player.experience` (bar progress) only.
- **bedboo:** points = the XP needed for the level + progress × the XP of the next level (the curve Bedrock shares
  with Java; `/xp 10` → level 1 + 3/9 → 10 points). Points spent on enchanting are not distinguishable.

## Abilities  {#abilities}

- **Affects:** `bot.abilities`, `abilities` event.
- **Java:** an `abilities` packet with flag bits on join and on every game mode change.
- **Bedrock:** `update_abilities` with ability layers (base, spectator, commands, editor, loading screen: allowed /
  enabled sets, fly / walk speeds) at join and on permission changes. On `/gamemode` the client derives the game
  mode's abilities itself; BDS sends `update_abilities` only when the flight changes. BDS sends it twice in answer to
  a `request_ability`, and after a game mode change that changes the flight (flying → survival, into / out of
  spectator), repeating values the bot already has (measured on BDS 1.26.51.1). In spectator BDS's layers clear
  `mayFly` while `flying` stays on.
- **bedboo:** the layers are merged (a layer decides the flags it allows; later layers override). On a game mode
  change the abilities follow the Java server's `GameType.updatePlayerAbilities` (creative: mayFly, instantBuild,
  invulnerable; spectator: + flying, no instantBuild; survival / adventure: none) and `abilities` is emitted once, like
  Java. An `update_abilities` that changes nothing emits no `abilities` and keeps the `bot.abilities` object (the
  join's first one is always reported). `bot.abilities` is the only flight state source: the physics engine follows
  it without sending `request_ability` back ([flight](movement.md#flight)).

## Spawn point  {#spawn-point}

- **Affects:** `bot.spawnPoint`.
- **Java:** `spawn_position` = the world spawn (compass target), with its real height.
- **Bedrock:** `start_game.spawn_position` (the world spawn; y = 32767 while the height is not fixed: the server
  searches the highest safe block when someone spawns there) and `set_spawn_position` with `spawn_type` `world`
  (`/setworldspawn`) or `player` (bed, respawn anchor, `/spawnpoint`; never sent by Java).
- **bedboo:** `bot.spawnPoint` = the world spawn (start_game, then `world` updates + `game`); the player's own respawn
  point does not change it. A 32767 height is resolved once the spawn column is loaded:
  [spawn search height](connection.md#spawn-search-height).

## Beds, sleeping and spawnReset  {#beds}

- **Affects:** `bot.sleep`, `bot.wake`, `sleep` / `wake` events, `bot.isABed`, `bot.parseBedMetadata`, `spawnReset`.
- **Java:** 16 coloured bed blocks with facing / part / occupied states; sleep = use the bed; `entity_action
  leave_bed` wakes; the sleeping state is the player's pose metadata;
  `game_state_change no_respawn_block_available`.
- **Bedrock:**
  - One `bed` block (the colour is in the block entity; plus `straw_bed`) with `direction` (0 south, 1 west, 2 north,
    3 east), `head_piece_bit`, `occupied_bit`. The first item whose name ends in "bed" is `straw_bed`, not the bed.
  - Sleep = item use `click_block` on the bed. The server answers with `set_entity_data` `player_flags` bit 1 +
    `player_bed_position` (the head), moves the player into the bed with a `correct_player_move_prediction` (feet
    ~0.7 below the bed top, in the head block's centre) and marks the head `occupied_bit`; a creative player can sleep
    too. `player_action stop_sleeping` wakes the player (`animate wake_up` + `player_flags` 0, a correction next to the
    bed). With nobody waking the player, BDS ends the sleep itself after 100 ticks (the night is skipped when
    `doDaylightCycle` is on; the clock jumps to the morning).
  - `/setblock` of a bed always places the whole bed: the given position becomes the head and the foot goes behind it
    (`head_piece_bit` is ignored; e.g. `/setblock <head> bed ["direction"=0]`); removing one half breaks the other.
  - A respawn whose bed / anchor is gone is announced with the `tile.bed.notValid` / `tile.respawn_anchor.notValid`
    message, and not at all when the fallback is the bed spawn's own position.
- **bedboo:** `isABed` matches `bed` and `*_bed`; `parseBedMetadata` returns upstream's shape from the Bedrock states;
  `spawnReset` is emitted on those messages. `sleep()` runs upstream's checks in upstream's order and with its messages
  (time / thunderstorm, already sleeping, not a bed, occupied, half a bed, `canDigBlock` reach, click range, hostile
  mobs); `activateBlock` is awaited (Bedrock's is asynchronous); 'bot is not sleeping' after 3 s. `wake()` sends
  `player_action stop_sleeping` and resolves at once, like upstream.

## A bed placed a moment ago is "half a bed"  {#bed-halves}

- **Affects:** `bot.sleep(bed)` right after `bot.placeBlock` placed the bed.
- **Java:** the server places both halves with one block change each; a client sees both before it can click.
- **Bedrock:** the foot and the head arrive as two separate `update_block`s (observed on BDS 1.26.51.1).
- **bedboo:** a `bot.sleep()` issued as soon as the clicked cell holds a bed is refused with upstream's "there's only
  half bed" (`bot.isABed` of the other half is still false), and works a tick later. Wait (≤ 20 ticks) until both
  cells are beds, and try `sleep` again after such a refusal. Sleeping then behaves as in [beds](#beds).

## Fishing  {#fishing}

- **Affects:** `bot.fish()`.
- **Java:** cast / reel in with use_item; the bobber is a `fishing_bobber` spawn_entity; a bite shows as 6 `fishing` /
  `bubble` particles next to the bobber (world_particles), which upstream detects.
- **Bedrock:** cast / reel in = item use `click_air` with the rod. The bobber is `add_entity minecraft:fishing_hook`
  whose `owner_eid` metadata is the caster's unique id. While waiting, the hook sends `entity_event fish_hook_tease`
  (fish nearby) and then `fish_hook_position` with `fish_x` / `fish_z` metadata (a fish swimming in, ~1–3 s); the bite
  is `entity_event fish_hook_hook` on the hook. Reeling in then drops the catch as an `add_item_entity` flying to the
  player (collected with `take_item_entity`) plus XP orbs, and removes the hook (`remove_entity`).
  - Measured waits (cast → `fish_hook_hook`, open water, `/enchant` levels): Lure 0 clear 6.3–32.3 s (mean 20.7,
    n=10); Lure 0 rain 6.0–20.9 s (12.1, n=8); Lure III clear 2.5–12.7 s (5.9, n=8); Lure III rain 1.9–12.2 s (5.7,
    n=14). The base window matches Java's 100–600 ticks (+ the fish swimming in), so `fishingBiteDelayMaxTicks: 600`
    ([feature table](data.md#feature-table)) holds; Lure lowers it by ~5 s per level like Java.
  - Bedrock's `/give` cannot carry enchantments and `/enchant` caps Lure at III (`/give @s fishing_rod` +
    `/enchant @s lure 3`); BDS tells a creative player nothing about an `/enchant`.
- **bedboo:** upstream's task logic and messages are unchanged; the bobber is the first `fishing_hook` the bot owns
  after `fish()` (another player's bobber is ignored; upstream takes any bobber), and the bite is `fish_hook_hook` on
  it. Like upstream, `fish()` has no time limit of its own.

## Books  {#books}

- **Affects:** `bot.writeBook`, `bot.signBook`.
- **Java:** `edit_book { slot, pages[], title? }` with the whole book, up to 100 pages; pages are NBT strings
  (`nbt.value.pages.value.value` = the page texts); the server echoes the edited slot.
- **Bedrock:**
  - The book must be *opened* first: an item use (`click_air`) of the held `writable_book` (a new book then comes back
    with an empty `pages` list); edits that reach the server in the same tick as the use are dropped.
  - Edits go page by page: `book_edit { inventory_slot: hotbar slot, type: replace_page | add_page | delete_page |
    swap_pages, page_number, text, photo_name }`; signing is `book_edit { type: sign, title, author, xuid }`. BDS
    sends nothing back for an edit; closing the book (`item_release`) makes it resend the book (new stack id).
  - Item NBT: `pages: [{ text, photoname }]` (read the texts as `pages.value.value.map(p => p.text.value)`, not as a
    list of strings); a written book adds `author`, `title`, `xuid` ('' offline) and `generation` 0. An 18-character
    title is accepted.
  - BDS keeps at most 50 pages and drops the rest.
- **bedboo:** upstream's checks, messages and slot handling (the book is moved to hotbar slot 0 and held, then the
  held slot / book slot are restored). The edit is one session: open → `book_edit`s (only the pages that change, extra
  pages deleted from the end) → (`sign`) → release, acknowledged by the resent book holding the requested pages (or
  the written book); an unacknowledged session is retried once with a longer open delay (20 s in total, like
  upstream's acknowledgement timeout). `writeBook` with the book's own pages sends nothing. More than 50 pages are
  refused at once (`too many pages: a Bedrock book holds at most 50 pages`), before anything is moved; a failed edit
  still restores the held slot and puts the book back.
