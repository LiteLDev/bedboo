# BDS notes

Behaviour of Bedrock Dedicated Server 1.26.51.1 worth knowing when you run bots against it: what the server prints,
what it sends, and when. bedboo handles all of this; the notes help when you read packet logs or script the server
console.

## Startup and ports {#startup}

- **Readiness line:** `[… INFO] Server started.`, followed by a multi-line `TRANSPORT TYPE ERROR` block when
  `transport=raknet` ("Your current connection type is not set to NetherNet … Players will not be able to connect").
  It is harmless: RakNet clients connect fine. BDS also logs `Signed in to signaling service successfully`. A fresh
  flat world is ready about 1 s after the process starts.
- **A busy port** prints `ERROR] Port [<port>] may be in use by another process. Free up port and re-run program …`,
  then `Exiting program` and a crash dump; the server exits within a second.
- **NetherNet:** BDS opens its signalling listener on **TCP** `server-port` and logs `Accepting clients on [::]:<port>`.
  When that TCP port is still held (for example `TIME_WAIT` connections of a previous server, about a minute) it runs
  without the listener and logs nothing; clients then get `ECONNREFUSED`.
- **Pings:** with `enable-lan-visibility=false` BDS does not answer the unconnected ping, so bedboo defaults to
  `skipPing: true`.

## Transports and backends {#transports}

- RakNet through raknet-native works (join ≈0.3 s, `start_game` ≈0.5 s, `spawn` ≈1.0 s). raknet-native 1.2.3 bundles
  x64 prebuilds only (`linux-5-x64`, `darwin-21-x64`, `win32-10-x64`) and its source build is disabled, so arm64
  hosts (Apple Silicon, linux-arm64) have no RakNet backend. The workspace patch makes the binding find the bundled
  prebuild on newer kernels (`linux-6`); the prebuild needs glibc ≥ 2.34.
- `raknetBackend: 'jsp-raknet'` fails: BDS answers the open-connection request with `ID_INCOMPATIBLE_PROTOCOL_VERSION`
  (server RakNet protocol 11; jsp-raknet speaks 10).
- NetherNet with HTTP signalling on the server port works (join ≈1.7 s, spawn ≈2.6 s). The HTTP signalling of
  bedrock-protocol and node-nethernet is backported in the workspace patches.

## Join sequence {#join}

- `start_game.player_position` is `(0.5, 32769.62, 0.5)` (the spawn search height), then three `respawn` packets:
  state 0 at 32769.62, state 0 at 32768, state 1 at the real eye-level spawn (`(0.5, -58.38, 0.5)` on a flat world,
  feet y = -60). The client answers state 1 with `respawn { state: 2, runtime_entity_id }`. Then chunks and
  `play_status player_spawn`.
- **Loading screen gate:** after spawning, BDS does **not simulate the player** (`player_auth_input` positions and
  move vectors are ignored, no `correct_player_move_prediction`) until the client sends
  `serverbound_loading_screen { type: 1 }` and `{ type: 2 }`. After that, walking inputs move the player and
  impossible moves are corrected.
- `start_game`: `rewind_history_size = 40`, `server_authoritative_block_breaking = true`,
  `server_authoritative_inventory = true`, `block_network_ids_are_hashes = true`; `player_gamemode` is `fallback`, so
  `world_gamemode` holds the game mode. Default `server.properties`: `server-authoritative-movement-strict=false`,
  `player-position-acceptance-threshold=0.5`.
- `player_list` arrives as `records: [{ type: 'add', username, … }]`, before the player is spawned or targetable.

## Chunks and saving {#chunks}

- `level_chunk` always arrives in sub-chunk request mode (`sub_chunk_count: 0` with `highest_subchunk_count`
  present), never with inline sub-chunks. `subchunk_request { dimension, origin, requests: [{ x: 0, y: -4..19, z: 0 }] }`
  returns one `subchunk` with an entry per request (`success` with payload, or `success_all_air`).
  `network_chunk_publisher_update` radius 64 → 160 blocks after `request_chunk_radius 10`.
- With no player nearby, chunks are not loaded: `setblock` / `testforblock` answer
  `Cannot place block outside of the world`.
- Modified chunks reach LevelDB only every 5–10 s, and `save hold` does **not** flush them, so an online backup can
  miss recent changes. A graceful stop saves everything.

## Console commands {#console}

- `say` / `tellraw` print nothing on the console; command errors are `ERROR` lines (`Unknown command: <cmd>. Please
  check that the command exists …`, `No targets matched selector`, `Syntax error: …`).
- `list` prints `There are n/max players online:` plus a line of names; `querytarget` prints a JSON block (eye-level
  `y`); `gamerule` (no arguments) prints all rules on one line; `testforblock` prints
  `Successfully found the block at x,y,z.` / `The block at x,y,z is Air (expected: …)`.
- `gamemode <m> <player>` sends `update_player_game_type { gamemode, player_unique_id }` (not
  `set_player_game_type`); nothing is sent when the player already has that mode. Game mode commands do not reach dead
  players (`No targets matched selector`).
- `tp <p> 10 -60 10` centres integer x/z (`Teleported p to 10.50, -60.00, 10.50`) and sends
  `move_player { mode: 'teleport', teleport: { cause: 'command' } }` at eye level.
- `setblock` prints `Block placed` and sends `update_block`; the same block again prints
  `The block couldn't be placed` and sends nothing.
- `summon` prints `Object successfully summoned` and sends `add_entity` (feet position, centred); `kill @e[type=pig]`
  prints `Killed Pig` and sends `entity_event death_animation`, the drops (`add_item_entity`), then `remove_entity`.
- Creative players cannot be killed (`Players cannot be killed while they are in Creative mode.`), not even by
  `/damage … void` or the void.

## Packets worth knowing {#packets}

- **Commands from the client:** `command_request { command, origin: { type: 'player', uuid, request_id: '' }, … }` is
  answered by `command_output` whose origin echoes the **uuid** (not `request_id`), plus an
  `event { event_type: 'command_executed' }`.
- **Chat:** a client `text` chat (`type: 'chat'`, `category: 'authored'`) is echoed to everyone with
  `source_name: '<name>§r'`.
- **Inventory:** `/give`, `/replaceitem` (hotbar / inventory) and `/clear` (even when nothing is cleared) send
  `inventory_content` of every window (inventory 36, armor 5, ui 54, off-hand 1); an armor `replaceitem` sends
  `inventory_slot`; `/give` also sends an `inventory_transaction`. Player items carry `stack_id`s.
- **Inventory resend:** an `inventory_transaction { transaction_type: 'inventory_mismatch' }` makes BDS resend the
  player's inventory (`inventory_content` × 4 + `player_hotbar`); a rejected item stack request or reopening the
  inventory screen resends nothing.
- **Death:** own `entity_event death_animation`, `death_info`, `text` (`death.attack.generic`), `respawn` state 0 at
  the death position. Respawn: client `respawn` state 2 → server `respawn` state 0 (`y 32767`) + state 1 (eye-level
  spawn) → client `player_action respawn` → `entity_event respawn` + `set_health 20`.
- **Time:** there is no `set_time` packet, not even for `/time set`; time travels in `sync_world_clocks`.
- **Falling blocks:** a block starting to fall and a falling block landing come as `update_block_synced` only, never
  as `update_block` ([falling blocks](differences/world.md#falling-blocks)).
- **Mobs:** a flat world spawns passive mobs continuously: hundreds of `move_entity_delta` per minute.
