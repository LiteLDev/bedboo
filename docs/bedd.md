# Driving a real client with Be.D.D. (`transport: 'bedd'`)

mineflayer-bedrock normally *is* the client: it logs in to Bedrock Dedicated Server over RakNet or NetherNet and sends
every packet itself. With `transport: 'bedd'` it drives a **real Minecraft Bedrock 1.26.51.01 client** instead,
hosted by [Be.D.D.](https://github.com/LiteLDev/BeDD) (Bedrock Deep Dive, a LeviLamina client mod). The same script
then runs against the game window on your desk: you watch the local player walk, look, dig, place and chat as the
script says.

```js
const mineflayer = require('mineflayer-bedrock')
const bot = mineflayer.createBot({ transport: 'bedd', bedd: { pipe: '\\\\.\\pipe\\BeDD' } })
bot.once('spawn', () => bot.chat('hello from bedboo'))
```

Choosing between the modes is only `transport`. Direct BDS mode (`raknet`, `nethernet`) is unchanged.

- [Setup](#setup)
- [How it works](#how-it-works)
- [Authority table](#authority-table)
- [Coverage matrix](#coverage-matrix)
- [Singleplayer and LAN worlds](#singleplayer-and-lan-worlds)
- [Security](#security)
- [Options and the `bot.bedrock.bedd` surface](#options-and-the-botbedrockbedd-surface)
- [Testing](#testing)
- [Roadmap (v2)](#roadmap-v2)

Java ↔ Bedrock-style differences of this mode, entry by entry: [differences/BEDD.md](differences/BEDD.md).

## Setup

Windows only (BeDD's pipes are Windows named pipes); Node 24 or later.

1. Install BeDD into a Minecraft Bedrock 1.26.51.01 instance (see BeDD's README; `clone-instance.ps1` makes a
   separate instance, `Start-BeDDGame.ps1 -Instance <name>` starts it).
2. Turn the bedboo features on in the instance's `mods\BeDD\config\config.json`. Every one of them is **off by
   default**:

   | key | default | what it enables | bedboo needs it for |
   |---|---|---|---|
   | `pipeName` | `BeDD` | the control pipe `\\.\pipe\<pipeName>`; the tap pipe is `\\.\pipe\<pipeName>-tap` | `bedd.pipe` (the tap name is derived) |
   | `tap` | `false` | the tap pipe: every clientbound packet, an echo of every serverbound packet, markers, a join journal | everything (without it bedboo cannot attach) |
   | `tapLoopback` | `true` | tapping singleplayer / LAN-host worlds (loopback link, re-serialized packets) | [singleplayer](#singleplayer-and-lan-worlds) |
   | `tapJournalMiB` | `128` | size cap of the join journal replayed to a late attach | attaching mid-session (`complete:false` past the cap) |
   | `gameHooks` | `false` | the `world`, `look` and `input` ops (hooks in the game's own input pipeline) | precise movement and looking (without it: virtual keys and mouse) |
   | `allowSend` | `false` | the `send` op for the allowlisted packet ids (`sendAllow`, default `[9, 77]` = text, command_request) | `bot.chat`, whispers, commands |
   | `allowStack` | `false` | the `stack` op: item_stack_request submitted through the client's own ItemStackNetManager | inventory: clickWindow, transfer, craft, deposit/withdraw, equip from the main inventory, creative |
   | `pipeInstances` | `4` | how many control-pipe clients may be connected at once | bedboo next to BeDD.psm1 and other harnesses |

   A config for bedboo:

   ```json
   { "pipeName": "BeDD-1.26.51.01-hi20", "tap": true, "tapLoopback": true, "gameHooks": true,
     "allowSend": true, "allowStack": true, "pipeInstances": 4, "loopbackOnly": true }
   ```

   `loopbackOnly` (BeDD's own key) keeps the client on servers of the same PC, which is what the Docker BDS of
   `corepack pnpm bds up --transport nethernet` is (127.0.0.1). The client joins BDS 1.26.51 over NetherNet, so start
   the server with `--transport nethernet`.
3. Start the game and get the player into a world (a server, a LAN world or singleplayer): bedboo attaches to a client
   that is already playing, it does not log in.
4. `createBot({ transport: 'bedd', bedd: { pipe: '\\\\.\\pipe\\BeDD-1.26.51.01-hi20' } })`. `spawn` fires once the join
   journal has been replayed; from then on `bot.*` is the client's state.

The `bedd_follow.js` example ([examples/bedd_follow.js](../packages/mineflayer-bedrock/examples/bedd_follow.js)) makes the
client follow the nearest other player:

```sh
node packages/mineflayer-bedrock/examples/bedd_follow.js --pipe \\.\pipe\BeDD-1.26.51.01-hi20
```

## How it works

The real client stays authoritative for everything it sends: login, resource packs, the loading screen, chunk
requests, `player_auth_input` every tick (physics included), block actions, inventory transactions and item stack
requests. bedboo never forges those packets. Its whole stack still runs, and what it *would* have sent becomes an
**intent** for the client:

```
script → mineflayer API → plugins → _client.queue → router ──(JSON ops)──────→ \\.\pipe\<pipeName>     → the game's input pipeline
bot.* state ← plugins ← decoder ← tap reader ←──(binary frames)──── \\.\pipe\<pipeName>-tap ← every packet the client gets / sends
```

- **State in:** the tap pipe carries every clientbound packet the client receives, an echo of every serverbound packet
  it sends, and JSON markers (`HELLO`, `LINK_UP`/`LINK_DOWN`, `REPLAY_BEGIN`/`REPLAY_END`, `DROPPED`). bedboo decodes
  them with bedrock-protocol exactly as in direct mode, so `bot.entities`, the world, inventory, chat and every event
  come from the real session. A **join journal** (since `start_game`, compacted: the latest chunk per position, the
  latest attributes per entity, removed entities pruned) is replayed to every new tap client, so bedboo can attach
  mid-session. If bedboo falls more than 32 MiB behind, BeDD sends `DROPPED` and closes; bedboo reconnects and gets a
  full replay.
- **Self state:** `bot.entity` position, velocity, yaw, pitch and onGround follow the echoed `player_auth_input`
  (eye − 1.62). `physicsTick` and `move` fire once per client tick; bedboo's own physics engine does not step.
- **Intents out:** a router diffs what bedboo would have sent and calls BeDD's control ops: `input` (move vector,
  jump, sneak, sprint, with a dead-man TTL), `look` (absolute yaw/pitch), `slot`, `button` (attack/use/pick, released
  on block change for digging), `action` (drop, inventory, …), `send` (allowlisted text/command_request bytes) and
  `stack` (item_stack_request through the client's ItemStackNetManager). Input is applied only while the game has the
  mouse and shows no menu.
- **Negotiation:** at attach, bedboo pings the control pipe and probes each op with no arguments: `unknown op` →
  absent, `code:'disabled'` → present but turned off in config.json, `ok` → present. `bot.bedrock.bedd.caps` holds the
  result and `bot.bedrock.bedd.supports(name)` answers per mineflayer API.

## Authority table

The same table lives in BeDD's CONTRIBUTING.md and in `packages/mineflayer-bedrock/lib/bedd/authority.js`.

| class | packets | handling |
|---|---|---|
| clientOwned | login, client_to_server_handshake, request_network_settings, resource_pack_client_response, client_cache_status, client_cache_blob_status, request_chunk_radius, subchunk_request, serverbound_loading_screen, set_local_player_as_initialized, network_stack_latency, tick_sync, player_skin, emote_list, respawn, player_action (dimension_change_ack / start_item_use_on / stop_item_use_on), animate, interact mouse_over_entity | dropped by the router (the client sends its own); counted |
| translated | player_auth_input (move_vector and flags → `input`; yaw/pitch → `look`; block_actions start_break / abort_break / stop_break → `button attack`), mob_equipment (→ `slot`), inventory_transaction (item_use click_block / click_air, item_release, item_use_on_entity → `look` + `button`), interact open_inventory (→ `action inventory`), container_close (→ ESC), item_stack_request (→ `stack`) | translated into control ops |
| shared | text, command_request | sent as bytes through `send` (the command uuid is kept, so `command_output` correlates); fallback: T / SLASH key, `text`, ENTER |
| unsupported | book_edit, block_pick_request, crafting_event, set_default_game_type, everything else | `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`) |

## Coverage matrix

"Caps" names the BeDD ops the API needs; without them `bot.bedrock.bedd.supports(name)` is false and the call throws
or rejects with `ERR_BEDD_UNSUPPORTED` (or uses the stated fallback). "e2e" is the real-client scenario of
`corepack pnpm test:e2e:bedd` covering it.

| API | works | caps (fallback) | e2e |
|---|---|---|---|
| spawn, login, game events, `bot.game`, time, weather, health, food, experience | yes, from the tap | `tap` | spawn and position |
| `bot.entities`, `bot.players`, blocks and world (`blockAt`, `findBlocks`, raytrace, `waitForChunksToLoad`) | yes, from the tap | `tap` | every scenario (setup is checked on the tap) |
| chat / message / messagestr events, title, bossbar, scoreboard, tablist, sound, particle, explosion | yes, from the tap | `tap` | chat |
| `bot.inventory`, `heldItem` (reads) | yes | `tap` | place, eat, inventory |
| `bot.entity` position / velocity / yaw / pitch / onGround | yes, from the echoed player_auth_input (1-2 ticks behind) | `tap` | spawn and position |
| `setControlState`, `getControlState`, `clearControlStates` | yes | `input` (virtual W/A/S/D/SPACE/SHIFT/CTRL keys) | walk |
| mineflayer-pathfinder, collectblock, pvp | yes, through controls, look and attack | `input`, `look` | pathfinder goal |
| `look`, `lookAt` | yes; resolve when the echo converges (< 0.5°) | `look` (closed-loop `raw` mouse) | lookAt |
| `setQuickBarSlot`, `equip` of a hotbar item | yes | `slot` (keys 1-9) | setQuickBarSlot |
| `chat`, `whisper`, commands (`bot._bedrock.commands.request`) | yes, uuid preserved | `send` (T/SLASH + `text` + ENTER, uuid lost) | chat, /say, command_output |
| `dig`, `stopDigging` | yes; crack animation on the client, completes on update_block → air | `look`, `button` (`mouse`) | dig dirt |
| `placeBlock`, `activateBlock`, `activateItem`, `deactivateItem`, `consume`, bows | yes (look, then use) | `look`, `button` | place, eat |
| `attack`, `activateEntity`, `mount`, `dismount` | yes | `look`, `button`, `input` | — |
| `toss` of the held item | yes | `action` (drop / dropAll) | — |
| `openContainer`, `openChest`, `openFurnace`, `closeWindow` | yes (close = ESC) | `look`, `button` | open / close chest |
| `clickWindow`, `moveSlotItem`, `transfer`, `deposit`, `withdraw`, `putAway`, `craft`, `equip` from the main inventory / armor / off-hand, `unequip`, `tossStack`, `creative.setInventorySlot`, anvil / enchanting / villager / smithing | yes, through the client's ItemStackNetManager | `stack` (none: `ERR_BEDD_UNSUPPORTED`) | craft planks, deposit into a chest |
| `writeBook`, `updateSign`, `respawn`, bed UI sleep / wake | no (screen-level) | — | unsupported error code |
| `bot.end`, `quit` | detach only; the client stays in its world | — | (after the run) |
| `auth`, `username`, `host`, `port`, `viewDistance` options | ignored with a warning (the client owns them) | — | — |

Degraded: pathfinder sees 1-2 ticks of lag (prediction is overwritten by the echo); the client's own raycast decides
what a click hits, so an action can land on an adjacent block or entity (bedboo sees it on `update_block` / entity
events); flight via a double-tap jump; input pauses while a screen is open; a late attach depends on the journal
(`complete:false` → chunks missing until re-entered); a world change on the client ends the bot (`LINK_DOWN`).

## Singleplayer and LAN worlds

With `tapLoopback` (on by default once `tap` is), BeDD also taps a world the client hosts itself: singleplayer or a
LAN world. Those packets never hit the network, so BeDD re-serializes them (`Packet::write`, frame flag
`reserialized`) and filters them to the local player, so LAN guests' traffic is not mixed in. Everything in the
[coverage matrix](#coverage-matrix) works the same; the HELLO marker says `link.type: 'local'`.

## Security

- **The tap exposes the session.** A tap client reads everything the logged-in player sees and does: chat, positions,
  inventory, the world. The tap pipe accepts one local client of the current Windows user (`PIPE_REJECT_REMOTE_CLIENTS`,
  current-user DACL), and it only exists when `tap` is on.
- **`send` and `stack` act as the account.** `send` posts chat and commands as the logged-in player, `stack` moves its
  items. Both are **off by default** (`allowSend`, `allowStack`); `send` is limited to the `sendAllow` ids
  (`[9, 77]`), and login, `player_auth_input`, item stack and similar ids (1, 30, 144, 147) are always refused.
- Turn these on only in instances you use for automation, and never let a manager or remote tool toggle them.

## Options and the `bot.bedrock.bedd` surface

`createBot({ transport: 'bedd', bedd: { pipe, tapPipe?, connect? } })`:

| option | |
|---|---|
| `bedd.pipe` | the control pipe, `\\.\pipe\<pipeName>` |
| `bedd.tapPipe` | the tap pipe (default `<pipe>-tap`) |
| `bedd.connect` | `(path) => Duplex`, to connect over something else (the unit tests use a unix socket) |

- `bot._bedrock.mode === 'bedd'`.
- `bot.bedrock.bedd.caps`: `{ [op]: 'present' | 'disabled' | 'absent' }` for `tap`, `world`, `look`, `input`, `slot`,
  `button`, `action`, `send`, `stack`.
- `bot.bedrock.bedd.supports(name)`: whether a mineflayer API works with these caps.
- `bot.bedrock.bedd.observed`: `{ yaw, pitch, tick }` of the last echoed `player_auth_input`.
- Client events besides the usual ones: `'serverbound'` `{ name, params, reserialized }` (what the client sent) and
  `'warning'` (a packet that did not decode; the stream goes on).

## Testing

The unit tests run everywhere against a fake BeDD (`test/unit/helpers/fake_bedd.js`, replaying the recorded
`join_flat` capture). The real-client e2e is opt-in and Windows-only: see
[testing.md](testing.md#real-client-e2e-bedd).

## Roadmap (v2)

- A drive / puppet mode (suppress, inject and pin the pose), once pinning is shown to survive client reconciliation.
- Screen-level ops: the respawn button, signs and books.
- A `connect` op so bedboo can make the client join a given server.
- A second split-screen subclient.
