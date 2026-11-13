# Driving a real client (BeDD)

bedboo normally *is* the client: it logs in to Bedrock Dedicated Server over RakNet or NetherNet and sends every
packet itself. With `transport: 'bedd'` it drives a **real Minecraft Bedrock client** instead, hosted by
[Be.D.D.](https://docs.levimc.org/BeDD/) (Bedrock Deep Dive, a LeviLamina client mod). The same script then runs
against a real game: you watch the local player walk, look, dig, place and chat as the script says.

```js
const bedboo = require('bedboo')
const bot = bedboo.createBot({ transport: 'bedd', version: '1.26.60', bedd: {} }) // the only running BeDD game
bot.once('spawn', () => bot.chat('hello from bedboo'))
```

Choosing between the modes is only `transport`; direct BDS mode (`raknet`, `nethernet`) is unchanged. The differences
of this mode, entry by entry: [BeDD mode](../reference/differences/bedd.md).

## Setup {#setup}

Windows only (BeDD is a Windows client mod); Node 24 or later. bedboo needs **BeDD v2**, which serves every game over
a local WebSocket; BeDD v1 (named pipes `\\.\pipe\BeDD`) is no longer supported.

1. Install BeDD v2 (see the [BeDD docs](https://docs.levimc.org/BeDD/)) and start a game with it:

   ```sh
   BeDD.exe launch --slot 2
   ```

   BeDD runs each game in its own copy of your LeviLauncher instance (`%LOCALAPPDATA%\BeDD\instances\<base>-<slot>`)
   and announces it in `%LOCALAPPDATA%\BeDD\run\<pid>.json` (`$BEDD_HOME` moves that folder) while it listens:
   `{ "protocol": 2, "kind": "client", "pid", "url": "ws://127.0.0.1:<port>/v1", "token", "instance", "label", … }`.
   bedboo reads this file to connect; the token is the only credential.
2. Everything bedboo uses is **on by default** in BeDD v2 (the token is the boundary). The keys of the game's
   `mods\BeDD\config\config.json` that matter to bedboo:

   | key | default | what it does | bedboo needs it for |
   |---|---|---|---|
   | `tap` | `true` | the tap: every clientbound packet, an echo of every serverbound packet, markers, a join journal | everything (without it bedboo cannot attach) |
   | `tapLoopback` | `true` | tapping singleplayer / LAN-host worlds (loopback link, re-serialized packets) | [singleplayer](#singleplayer) |
   | `tapJournalMiB` | `128` | size cap of the join journal replayed to a late attach | attaching mid-session (`complete:false` past the cap) |
   | `gameHooks` | `true` | the `world`, `look` and `input` ops (hooks in the game's own input pipeline) | precise movement and looking (without it: virtual keys and mouse) |
   | `allowSend` | `true` | the `send` op for the allowlisted packet ids (`sendAllow`, default `[9, 77]` = text, command_request) | `bot.chat`, whispers, commands |
   | `allowStack` | `true` | the `stack` op: item_stack_request submitted through the client's own ItemStackNetManager | inventory: clickWindow, transfer, craft, deposit/withdraw, equip from the main inventory, creative |
   | `wsPort` | `0` | the WebSocket port (0: any free port, read it from the run file) | `bedd.url` |
   | `wsMaxClients` | `8` | how many WebSocket connections may be open at once (bedboo uses two) | bedboo next to the BeDD manager and other harnesses |

   A key set to `false` turns that op off: bedboo then sees it as `disabled` and falls back (see the
   [coverage table](#coverage)). `pipeName` and `pipeInstances` are gone with the pipes.

   `loopbackOnly` (BeDD's own key) keeps the client on servers of the same PC (127.0.0.1). The client joins BDS over
   NetherNet, so start the server with `transport=nethernet`; NetherNet joins go through Minecraft's online signalling
   service, so no other Minecraft game on the PC may start while the client joins and plays (a later sign-in knocks the
   session out: "Multiplayer Connection Failed … NetherNet").
3. Get the player into a world (a server, a LAN world or singleplayer): bedboo attaches to a client that is already
   playing, it does not log in.
4. `createBot({ transport: 'bedd', version: '1.26.60', bedd: {} })`, with `version` the game's protocol family (the
   tap's HELLO is refused otherwise; in this mode it defaults to `1.26.60`, the game BeDD v2 runs). `bedd: {}` picks the only running BeDD game; with several, name one (see
   [options](#options)). `spawn` fires once the join journal has been replayed; from then on `bot.*` is the client's
   state.

The `bedd_follow.js` example makes the client follow the nearest other player:

```sh
node examples/bedd_follow.js                       # the only running BeDD game
node examples/bedd_follow.js --instance <instance>  # or --pid <pid>
```

## How it works {#how-it-works}

The real client stays authoritative for everything it sends: login, resource packs, the loading screen, chunk
requests, `player_auth_input` every tick (physics included), block actions, inventory transactions and item stack
requests. bedboo never forges those packets. Its whole stack still runs, and what it *would* have sent becomes an
**intent** for the client. Both directions go over the game's BeDD WebSocket (`ws://127.0.0.1:<port>/v1?token=…`),
on two connections:

```text
script → mineflayer API → plugins → _client.queue → router ──(JSON text frames)───→ WebSocket 1 (control) → the game's input pipeline
bot.* state ← plugins ← decoder ← tap reader ←──(binary frames)──────── WebSocket 2 (tap subscribe) ← every packet the client gets / sends
```

- **State in:** the second connection sends `{ op: 'tap', action: 'subscribe' }` and then receives one binary message
  per tap frame: every clientbound packet the client receives, an echo of every serverbound packet it sends, and JSON
  markers (`HELLO`, `LINK_UP`/`LINK_DOWN`, `REPLAY_BEGIN`/`REPLAY_END`, `DROPPED`). bedboo decodes them with
  bedrock-protocol exactly as in direct mode, so `bot.entities`, the world, inventory, chat and every event come from
  the real session. A **join journal** (since `start_game`, compacted: the latest chunk per position, the latest
  attributes per entity, removed entities pruned) is replayed to every new subscriber, so bedboo can attach
  mid-session. The tap has one subscriber at a time (a second one gets `code: 'busy'`). If bedboo falls more than
  32 MiB behind, BeDD sends `DROPPED` and closes the connection; the bot ends with `bedd_dropped`, and a new bot gets
  a full replay.
- **Self state:** `bot.entity` position, velocity, yaw, pitch and onGround follow the echoed `player_auth_input`
  (eye − 1.62). `physicsTick` and `move` fire once per client tick; bedboo's own physics engine does not step.
- **Intents out:** a router diffs what bedboo would have sent and calls BeDD's control ops: `input` (move vector,
  jump, sneak, sprint, with a dead-man TTL), `look` (absolute yaw/pitch), `slot`, `button` (attack/use/pick, released
  on block change for digging), `action` (drop, inventory, …), `send` (allowlisted text/command_request bytes) and
  `stack` (item_stack_request through the client's ItemStackNetManager). Input is applied only while the game has the
  mouse and shows no menu. Requests are `{ id, op, … }` text frames, answered in order, one in flight.
- **Negotiation:** at attach, bedboo pings the control connection (BeDD v2 answers `protocol: 2`, `defaultMode:
  'bedboo'` and `modes`, the ops of each operation mode) and probes each op with no arguments: `unknown op` (or not
  listed in `modes`) → absent, `code:'disabled'` → present but turned off in config.json, `ok` → present.
  `bot.bedrock.bedd.caps` holds the result and `bot.bedrock.bedd.supports(name)` answers per mineflayer API.

## Authority table {#authority-table}

| class | packets | handling |
|---|---|---|
| clientOwned | login, client_to_server_handshake, request_network_settings, resource_pack_client_response, client_cache_status, client_cache_blob_status, request_chunk_radius, subchunk_request, serverbound_loading_screen, set_local_player_as_initialized, network_stack_latency, tick_sync, player_skin, emote_list, respawn, player_action (dimension_change_ack / start_item_use_on / stop_item_use_on), animate, interact mouse_over_entity | dropped by the router (the client sends its own); counted |
| translated | player_auth_input (move_vector and flags → `input`; yaw/pitch → `look`; block_actions start_break / abort_break / stop_break → `button attack`), mob_equipment (→ `slot`), inventory_transaction (item_use click_block / click_air, item_release, item_use_on_entity → `look` + `button`), interact open_inventory (→ `action inventory`), container_close (→ ESC), item_stack_request (→ `stack`) | translated into control ops |
| shared | text, command_request | sent as bytes through `send` (the command uuid is kept, so `command_output` correlates); fallback: T / SLASH key, `text`, ENTER |
| unsupported | book_edit, block_pick_request, crafting_event, set_default_game_type, everything else | `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`) |

## Coverage {#coverage}

"Caps" names the BeDD ops the API needs; without them `bot.bedrock.bedd.supports(name)` is false and the call throws
or rejects with `ERR_BEDD_UNSUPPORTED` (or uses the stated fallback).

| API | works | caps (fallback) |
|---|---|---|
| spawn, login, game events, `bot.game`, time, weather, health, food, experience | yes, from the tap | `tap` |
| `bot.entities`, `bot.players`, blocks and world (`blockAt`, `findBlocks`, raytrace, `waitForChunksToLoad`) | yes, from the tap | `tap` |
| chat / message / messagestr events, title, bossbar, scoreboard, tablist, sound, particle, explosion | yes, from the tap | `tap` |
| `bot.inventory`, `heldItem` (reads) | yes | `tap` |
| `bot.entity` position / velocity / yaw / pitch / onGround | yes, from the echoed player_auth_input (1-2 ticks behind) | `tap` |
| `setControlState`, `getControlState`, `clearControlStates` | yes | `input` (virtual W/A/S/D/SPACE/SHIFT/CTRL keys) |
| mineflayer-pathfinder, collectblock, pvp | yes, through controls, look and attack | `input`, `look` |
| `look`, `lookAt` | yes; resolve when the echo converges (< 0.5°) | `look` (closed-loop `raw` mouse) |
| `setQuickBarSlot`, `equip` of a hotbar item | yes | `slot` (keys 1-9) |
| `chat`, `whisper`, commands | yes, uuid preserved | `send` (T/SLASH + `text` + ENTER, uuid lost) |
| `dig`, `stopDigging` | yes; crack animation on the client, completes on update_block → air | `look`, `button` (`mouse`) |
| `placeBlock`, `activateBlock`, `activateItem`, `deactivateItem`, `consume`, bows | yes (look, then use) | `look`, `button` |
| `attack`, `activateEntity`, `mount`, `dismount` | yes | `look`, `button`, `input` |
| `toss` of the held item | yes | `action` (drop / dropAll) |
| `openContainer`, `openChest`, `openFurnace`, `closeWindow` | yes (close = ESC) | `look`, `button` |
| `clickWindow`, `moveSlotItem`, `transfer`, `deposit`, `withdraw`, `putAway`, `craft`, `equip` from the main inventory / armor / off-hand, `unequip`, `tossStack`, `creative.setInventorySlot`, anvil / enchanting / villager / smithing | yes, through the client's ItemStackNetManager | `stack` (none: `ERR_BEDD_UNSUPPORTED`) |
| `writeBook`, `updateSign`, `respawn`, bed UI sleep / wake | no (screen-level) | — |
| `bot.end`, `quit` | detach only; the client stays in its world | — |
| `auth`, `username`, `host`, `port`, `viewDistance` options | ignored with a warning (the client owns them) | — |

Notes: `activateItem(true)` (off-hand) uses the main hand, the client has no off-hand use button; `activateItem` of an
item that is not used by holding (throwables, a fishing rod) is one click; `bot.respawn()` is a no-op with a warning
(the user clicks Respawn, so `respawn: true` never throws from the health listener); `bot.craft` keeps upstream's
`new Error(err)` wrapping, so check `err.message` there when the surface did not refuse it first.

Degraded: pathfinder sees 1-2 ticks of lag (prediction is overwritten by the echo); the client's own raycast decides
what a click hits, so an action can land on an adjacent block or entity (bedboo sees it on `update_block` / entity
events); flight via a double-tap jump; input pauses while a screen is open; a late attach depends on the journal
(`complete:false` → chunks missing until re-entered); a world change on the client ends the bot (`LINK_DOWN`).

## Singleplayer and LAN worlds {#singleplayer}

With `tapLoopback` (on by default once `tap` is), BeDD also taps a world the client hosts itself: singleplayer or a
LAN world. Those packets never hit the network, so BeDD re-serializes them (`Packet::write`, frame flag
`reserialized`) and filters them to the local player, so LAN guests' traffic is not mixed in. Everything in the
[coverage table](#coverage) works the same; the HELLO marker says `link.type: 'local'`.

## Security {#security}

- **The token is the boundary.** BeDD v2 listens on 127.0.0.1 only and refuses a connection without the game's token
  (HTTP 401) or with an `Origin` header (403, so a web page cannot reach it). The token sits in the run file under
  your `%LOCALAPPDATA%`: anything running as your Windows user can read it and drive the game. bedboo sends it as
  `?token=` and never sends `Origin`.
- **The tap exposes the session.** A subscriber reads everything the logged-in player sees and does: chat, positions,
  inventory, the world.
- **`send` and `stack` act as the account.** `send` posts chat and commands as the logged-in player, `stack` moves its
  items. `send` is limited to the `sendAllow` ids (`[9, 77]`), and login, `player_auth_input`, item stack and similar
  ids (1, 30, 144, 147) are always refused. Set `allowSend` / `allowStack` to `false` in instances that should not
  allow them.
- Run BeDD games for automation in their own instances (`BeDD.exe launch --slot <n>` does), not with your main
  account's world.

## Options and `bot.bedrock.bedd` {#options}

`createBot({ transport: 'bedd', version, bedd })`, `bedd` being one of:

| `bedd` | connects to |
|---|---|
| `{}` | the only running BeDD game client (an error lists them when there are several) |
| `{ pid }` | the BeDD game with that process id |
| `{ instance }` | the BeDD game of that instance folder (e.g. `'1.26.60.05-2'`, the run file's `instance`) |
| `{ url, token }` | that endpoint, as given (e.g. read from a run file yourself) |

plus, in any form:

| option | |
|---|---|
| `bedd.home` | BeDD's home folder for the lookup (default `$BEDD_HOME`, else `%LOCALAPPDATA%\BeDD`) |
| `bedd.timeoutMs` | control request timeout, also the connect timeout (default 5000 ms; an op's own `timeoutMs` gets 2 s more) |
| `bedd.modules` | the `lib/bedd` modules to attach (default, in this order: `authority`, `router`, `router_actions`, `follower`, `surface`, `inventory`) |
| `bedd.WebSocket` | the WebSocket class (default Node's global `WebSocket`) |

Run files of processes that are gone (a crashed game) are skipped. When no game matches, the bot emits `'error'`
(`code: 'ERR_BEDD_DISCOVERY'`) and ends. `bedd.pipe`, `bedd.tapPipe` and `bedd.connect` (BeDD v1) throw, naming these
options; a BeDD v1 that answers anyway is refused with `ERR_BEDD_PROTOCOL` ("BeDD v1 uses named pipes; upgrade BeDD").

- `bot._bedrock.mode === 'bedd'`.
- `bot.bedrock.bedd.url` / `endpoint`: the WebSocket in use (without its token) and the game's `pid`, `instance`,
  `label` when it came from a run file.
- `bot.bedrock.bedd.control`: `ping`'s `protocol` (2), `pid`, `defaultMode` and `modes`
  (`{ bedboo: [...], input: [...], ui: [...] }`).
- `bot.bedrock.bedd.caps`: `{ [op]: 'present' | 'disabled' | 'absent' }` for `tap`, `world`, `look`, `input`, `slot`,
  `button`, `action`, `send`, `stack` (probed), and the other ops `ping.modes` lists (`key`, `text`, `mouse`, `raw`,
  `screenshot`, `ui`, …). Without a control connection every op is `absent` and the bot only observes.
- `bot.bedrock.bedd.supports(name)`: whether a mineflayer API (`'dig'`, `'craft'`, `'creative.setInventorySlot'`) or
  a BeDD op works with these caps.
- `bot.bedrock.bedd.observed`: `{ yaw, pitch, tick }` of the last echoed `player_auth_input`, `null` before the first.
- Errors: `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`, `bedd: true`, `feature`, `missing`); an unsupported
  packet also emits `'bedd_unsupported_packet'` `{ name, feature }` on `bot`, once per name. Connection errors on the
  bot's `'error'`: `ERR_BEDD_DISCOVERY`, `ERR_BEDD_CONNECT` (refused, wrong token, gone), `busy` (another client holds
  the tap), `disabled` (`tap: false`), `ERR_BEDD_PROTOCOL` / `ERR_BEDD_HELLO` (another BeDD or game version).
- Client events besides the usual ones: `'serverbound'` `{ name, params, reserialized }` (what the client sent),
  `'bedd_marker'` (tap markers) and `'warning'` (a packet that did not decode; the stream goes on).

## Roadmap {#roadmap}

- A drive / puppet mode (suppress, inject and pin the pose), once pinning is shown to survive client reconciliation.
- Screen-level ops: the respawn button, signs and books (BeDD v2's `ui` mode reads the screens' UI tree).
- A `connect` op so bedboo can make the client join a given server.
- A second split-screen subclient.
