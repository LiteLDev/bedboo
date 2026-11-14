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
   | `allowSend` | `true` | the `send` op for the allowlisted packet ids (`sendAllow`, default `[9, 77, 78, 97]` = text, command_request, command_block_update, book_edit) | `bot.chat`, whispers, commands; any other packet whose id you add (see [sendAllow](#send-allow)) |
   | `allowStack` | `true` | the `stack` op: item_stack_request submitted through the client's own ItemStackNetManager | inventory: clickWindow, transfer, craft, deposit/withdraw, equip from the main inventory, creative |
   | `ui` | `true` | the `ui` op: the game's screens as a tree of nodes, clicked and typed into by ref | `respawn`, `wake`, `updateSign`, closing the book screen ([screens](#screens)) |
   | `wsPort` | `0` | the WebSocket port (0: any free port, read it from the run file) | `bedd.url` |
   | `wsMaxClients` | `8` | how many WebSocket connections may be open at once (bedboo uses two) | bedboo next to the BeDD manager and other harnesses |

   A key set to `false` turns that op off: bedboo then sees it as `disabled` and falls back (see the
   [coverage table](#coverage)). `pipeName` and `pipeInstances` are gone with the pipes.

   `loopbackOnly` (BeDD's own key) keeps the client on servers of the same PC (127.0.0.1). The client joins BDS over
   NetherNet, so start the server with `transport=nethernet`; NetherNet joins go through Minecraft's online signalling
   service, so no other Minecraft game on the PC may start while the client joins and plays (a later sign-in knocks the
   session out: "Multiplayer Connection Failed … NetherNet").
3. Get the player into a world (a server, a LAN world or singleplayer): bedboo attaches to a client that is already
   playing, it does not log in. Or pass `host` (and `port`) to `createBot`: bedboo then makes the client join that
   server first with BeDD's `join` op (leaving its world, answering "Trust this server?") and attaches once it is in
   the level.
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
  on block change for digging), `action` (drop, inventory, …), `send` (allowlisted packet bytes: text/command_request,
  and any id you add to `sendAllow`), `stack` (item_stack_request through the client's ItemStackNetManager), `ui` (the
  client's screens: Respawn, Leave Bed, the sign editor) and `join` (createBot's `host`). Input is applied only while the game has the
  mouse and shows no menu. Requests are `{ id, op, … }` text frames, answered in order, one in flight.
- **Negotiation:** at attach, bedboo pings the control connection (BeDD v2 answers `protocol: 2`, `defaultMode:
  'bedboo'` and `modes`, the ops of each operation mode) and probes each op with no arguments: `unknown op` (or not
  listed in `modes`) → absent, `code:'disabled'` → present but turned off in config.json, `ok` → present.
  `bot.bedrock.bedd.caps` holds the result and `bot.bedrock.bedd.supports(name)` answers per mineflayer API.

## Authority table {#authority-table}

| class | packets | handling |
|---|---|---|
| clientOwned | login, client_to_server_handshake, request_network_settings, resource_pack_client_response, client_cache_status, client_cache_blob_status, subchunk_request, serverbound_loading_screen, set_local_player_as_initialized, network_stack_latency, tick_sync, player_skin, emote_list, respawn, player_action (dimension_change_ack / start_item_use_on / stop_item_use_on / respawn), animate, show_credits, interact mouse_over_entity | dropped by the router (the client sends its own); counted. The APIs behind them: `bot.swingArm` → `action swing`, `bot.respawn` → `ui` (Respawn), the credits → ESC on `credits_screen`, `bot.quit` → `join host:null` |
| translated | player_auth_input (move_vector and flags → `input`; yaw/pitch → `look`; block_actions start_break / abort_break / stop_break → `button attack`), mob_equipment (→ `slot`), inventory_transaction (item_use click_block / click_air, item_release, item_use_on_entity → `look` + `button`), interact open_inventory (→ `action inventory`), container_close (→ ESC), item_stack_request (→ `stack`), block_pick_request (→ `look` + `button pick`), interact leave_vehicle (→ a sneak tap), request_chunk_radius (→ `settings renderDistance`) | translated into control ops |
| screens | player_action stop_sleeping, block_entity_data (a sign) | `ui` (Leave Bed, the sign editor), or `send` as is when the id is in `sendAllow` |
| shared | text, command_request | sent as bytes through `send` (the command uuid is kept, so `command_output` correlates); fallback: T / SLASH key, `text`, ENTER |
| allowlisted | book_edit, command_block_update | sent as bytes through `send` (in BeDD's default `sendAllow`) |
| unsupported | crafting_event, set_default_game_type, everything else | sent as bytes through `send` when its id is in BeDD's `sendAllow` ([below](#send-allow)); otherwise `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`), whose message names the id to add |

The bot's own `respawn` / `player_action respawn` stay client-owned: `bot.respawn()` clicks the death screen's
Respawn button instead and the client sends them itself.

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
| `respawn` (and the `respawn` option) | yes: clicks the death screen's Respawn button | `ui` (none: a no-op with a warning) |
| `sleep`, `wake` | yes: sleep is a use click on the bed, wake clicks the bed screen's Leave Bed | `look`, `button`; wake: `ui` or `send` with 36 in `sendAllow` |
| `updateSign` | yes: types into the client's sign editor (opened with a use click when it is not showing) and presses Done | `ui` or `send` with 56 in `sendAllow` |
| `writeBook`, `signBook` | yes: the book is opened with a use click, its pages are sent as book_edit, the book screen is closed with ESC | `button`, and `send` with 97 in `sendAllow` (BeDD's default) |
| `setCommandBlock` | yes, as command_block_update | `send` with 78 in `sendAllow` (BeDD's default) |
| `swingArm` | yes (`'left'` swings the off hand on this client; animate carries no hand on the wire) | `action` with `swing` (none: a no-op with a warning) |
| `setSettings({ viewDistance })`, the `viewDistance` option | yes: the client's render distance (the server may grant more) | `settings` (none: ignored with a warning) |
| credits after the End exit | skipped, as headless bedboo does: ESC while `credits_screen` shows | `world`, `key` |
| inventory resync (`inventory_mismatch`) | a no-op: the client owns its inventory | — |
| `block_pick_request` (a plugin's own `_client.write`) | yes: looks at the block and presses pick | `look`, `button` |
| any other `_client.write` / `queue` of a plugin | yes when its packet id is in `sendAllow` | `send` |
| `host`, `port` options | the client joins that server first | `join` |
| `bot.quit` | the client leaves its world (to the title screen), then the bot detaches | `join` (none: detach only, with a warning) |
| `bot.end` | detach only; the client stays in its world | — |
| `auth`, `username` options | ignored with a warning (the client is signed in with its own account) | — |

Notes: `activateItem(true)` (off-hand) uses the main hand: Bedrock has no use input for the off hand (it only acts passively: a shield raises while sneaking, totems, maps); `activateItem` of an
item that is not used by holding (throwables, a fishing rod) is one click; without `ui`, `bot.respawn()` is a no-op
with a warning (so `respawn: true` never throws from the health listener); the sign editor edits the side the client
faces, so `updateSign(block, text, true)` (the back) warns when the editor shows the front; `bot.craft` keeps
upstream's `new Error(err)` wrapping, so check `err.message` there when the surface did not refuse it first.

Degraded: pathfinder sees 1-2 ticks of lag (prediction is overwritten by the echo); the client's own raycast decides
what a click hits, so an action can land on an adjacent block or entity (bedboo sees it on `update_block` / entity
events); flight via a double-tap jump; input pauses while a screen is open; a late attach depends on the journal
(`complete:false` → chunks missing until re-entered); a world change on the client ends the bot (`LINK_DOWN`).

## Screens {#screens}

BeDD v2's `ui` op reads the game's JSON UI screens as a tree of nodes (`role`, `name`, `text`, `state`) with refs and
clicks or types into a node by its ref. `lib/bedd/screens.js` uses it for what the client only does when its user
acts on a screen:

| API | node |
|---|---|
| `bot.respawn()` (the `respawn` option calls it on death) | a button whose name or text says "respawn" (`respawn_button` of the death screen) |
| `bot.wake()` | a button saying "wake", "leave bed" or "stop sleeping" (`wake_up_button` "Leave Bed" of the bed screen) |
| `bot.updateSign(block, text)` | the text box of the sign screen, then its Done button (else ESC) |
| `bot.writeBook` / `signBook` | ESC on the book screen when bedboo releases the book |

Each action reads the tree again until the node shows up (10 s), and again after `stale_snapshot`, `stale_ref` or
`occluded`. The same helpers drive any other screen: `bot.bedrock.bedd.screens.click(node => node.role === 'button' &&
/play/i.test(node.text ?? ''))`, `screens.setText(matcher, text)`, `screens.read()` for the raw snapshot.

## sendAllow {#send-allow}

`send` only sends the packet ids in the game's `sendAllow` (config.json, default `[9, 77, 78, 97]` since BeDD's parity ops; `[9, 77]` before); 1, 30, 144 and 147
(login, inventory_transaction, player_auth_input, item_stack_request) are always refused. bedboo reads the list from
the `send` probe (`bot.bedrock.bedd.sendAllow`), and every packet it would send that no op translates goes out as
is when its id is listed. The ids that matter (add the others for a server you control):

| id | packet | what then works |
|---|---|---|
| 97 | book_edit | `bot.writeBook`, `bot.signBook` (default) |
| 78 | command_block_update | `bot.setCommandBlock` (default) |
| 56 | block_entity_data | `bot.updateSign` as the packet (any side, no editor) instead of through the sign editor |
| 36 | player_action | `bot.wake` as the packet instead of the Leave Bed button (and any player_action a plugin sends) |
| 105 | set_default_game_type | a plugin's own `_client.write('set_default_game_type', …)` |

Client-owned packets (the authority table) are still dropped whatever `sendAllow` says.

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
- **`send`, `stack` and `ui` act as the account.** `send` posts chat and commands as the logged-in player (and any
  packet you add to `sendAllow`), `stack` moves its items, `ui` clicks its screens. `send` is limited to the
  `sendAllow` ids (`[9, 77]`), and login, `player_auth_input`, item stack and similar ids (1, 30, 144, 147) are always
  refused. Set `allowSend` / `allowStack` / `ui` to `false` in instances that should not allow them.
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
| `bedd.modules` | the `lib/bedd` modules to attach (default, in this order: `authority`, `router`, `router_actions`, `follower`, `surface`, `inventory`, `screens`) |
| `bedd.joinTimeoutMs` | how long `host` may take to join (default 60000 ms) |
| `bedd.WebSocket` | the WebSocket class (default Node's global `WebSocket`) |

`host` / `port` (createBot options, `port` default 19132) make the client join that server before bedboo attaches
(BeDD's `join` op with `wait`); a client already playing there is left alone. Without the `join` op, or when the
client gives up (`join_failed`, `not_allowed` for a host off this PC that `loopbackOnly` keeps it from), the bot emits
`'error'` with `code: 'ERR_BEDD_JOIN'` (`reason`: BeDD's code) and ends. `bot._client.bedd.joined` holds the reply.

Run files of processes that are gone (a crashed game) are skipped. When no game matches, the bot emits `'error'`
(`code: 'ERR_BEDD_DISCOVERY'`) and ends. `bedd.pipe`, `bedd.tapPipe` and `bedd.connect` (BeDD v1) throw, naming these
options; a BeDD v1 that answers anyway is refused with `ERR_BEDD_PROTOCOL` ("BeDD v1 uses named pipes; upgrade BeDD").

- `bot._bedrock.mode === 'bedd'`.
- `bot.bedrock.bedd.url` / `endpoint`: the WebSocket in use (without its token) and the game's `pid`, `instance`,
  `label` when it came from a run file.
- `bot.bedrock.bedd.control`: `ping`'s `protocol` (2), `pid`, `defaultMode` and `modes`
  (`{ bedboo: [...], input: [...], ui: [...] }`).
- `bot.bedrock.bedd.caps`: `{ [op]: 'present' | 'disabled' | 'absent' }` for `tap`, `world`, `look`, `input`, `slot`,
  `button`, `action`, `send`, `stack`, `join`, `ui`, `settings` (probed; `ui` with a one-node read), and the other ops `ping.modes`
  lists (`key`, `text`, `mouse`, `raw`, `screenshot`, …). Without a control connection every op is `absent` and the
  bot only observes.
- `bot.bedrock.bedd.sendAllow`: the packet ids `send` accepts (the probe's `allow`), `null` without `send`.
- `bot.bedrock.bedd.screens`: the [screen helpers](#screens) (`read`, `find`, `click`, `setText`, `respawn`, `wake`,
  `editSign`, `idle`).
- `bot.bedrock.bedd.supports(name)`: whether a mineflayer API (`'dig'`, `'craft'`, `'creative.setInventorySlot'`) or
  a BeDD op works with these caps.
- `bot.bedrock.bedd.observed`: `{ yaw, pitch, tick }` of the last echoed `player_auth_input`, `null` before the first.
- Errors: `BeddUnsupportedError` (`code: 'ERR_BEDD_UNSUPPORTED'`, `bedd: true`, `feature`, `missing`; `'send:97'` in
  `missing` means `send` with packet id 97 in `sendAllow`); an unsupported
  packet also emits `'bedd_unsupported_packet'` `{ name, feature }` on `bot`, once per name. Connection errors on the
  bot's `'error'`: `ERR_BEDD_DISCOVERY`, `ERR_BEDD_CONNECT` (refused, wrong token, gone), `busy` (another client holds
  the tap), `disabled` (`tap: false`), `ERR_BEDD_PROTOCOL` / `ERR_BEDD_HELLO` (another BeDD or game version),
  `ERR_BEDD_JOIN` (`host` could not be joined).
- Client events besides the usual ones: `'serverbound'` `{ name, params, reserialized }` (what the client sent),
  `'bedd_marker'` (tap markers) and `'warning'` (a packet that did not decode; the stream goes on).

## Roadmap {#roadmap}

- A drive / puppet mode (suppress, inject and pin the pose), once pinning is shown to survive client reconciliation.
- Following the client across a world change (`LINK_DOWN` → `LINK_UP`) instead of ending the bot.
- A second split-screen subclient.
