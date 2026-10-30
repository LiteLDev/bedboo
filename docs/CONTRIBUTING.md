# Contributing to bedboo (authoritative for every unit)

bedboo is **mineflayer for Bedrock Edition**: `require('mineflayer-bedrock').createBot({ host, port, username })`
must behave exactly like mineflayer 4.39.0 (same `bot.*` properties, methods, events, types and plugin
system) while talking to Bedrock Dedicated Server (BDS 1.26.51.1, protocol 2193). The only allowed
differences are inherent Java/Bedrock differences, each documented in `docs/differences/`.

This file holds the conventions, the cross-unit contracts, the ownership table and the workflow. When it
disagrees with anything else (including a stub's comment), this file wins; propose changes through the
coordinator.

- [Repository layout](#repository-layout)
- [Conventions](#conventions)
- [Cross-unit contracts](#cross-unit-contracts)
- [Ownership](#ownership)
- [Testing, e2e recipe and worker gate](#testing-e2e-recipe-and-worker-gate)
- [Workflow and merge loop](#workflow-and-merge-loop)

## Repository layout

```
package.json / pnpm-workspace.yaml / pnpm-lock.yaml   pnpm 12.14.0 workspace (settings in pnpm-workspace.yaml)
patches/<pkg>@<version>.patch                          pnpm patches (one owner per patch per wave)
scripts/capture-fixtures.js                            BDS packet capture (fixtures + transport spike)
scripts/run-e2e.js                                     `pnpm test:e2e` wrapper
docs/CONTRIBUTING.md                                   this file
docs/testing.md                                        BDS quirks, manual docker recipe, fixtures
docs/upstream/                                         pinned mineflayer 4.39.0 references (api.md, index.d.ts, externalTests, master abilities.js)
docs/parity/<unit>.md, docs/differences/<unit>.md      per-unit fragments, assembled by U3's tooling
packages/mineflayer-bedrock/                           the library
  index.js, index.d.ts, types/bedrock.d.ts
  lib/loader.js, client.js, registry.js, version.js
  lib/plugins/*.js        41 mineflayer plugin names + abilities + sign (43 files)
  lib/bedrock/*.js        shared Bedrock internals (contracts below)
  lib/physics/            in-repo Bedrock physics engine (prismarine-physics fork)
  test/unit/              no server (fixtures)
  test/external/          real BDS (`<mineflayer test name>.test.js` or Bedrock extras)
  test/external/common/   bot.test.* helpers (one owner per helper file)
  test/fixtures/          recorded packets (see test/fixtures/README.md)
packages/bedrock-data/                                 @bedboo/bedrock-data: minecraft-data overlay
packages/bds/                                          @bedboo/bds: Docker BDS harness + `bds` CLI
packages/agent/                                        @bedboo/agent: scripted survival agent
```

## Conventions

**Language & style**
- Node ≥ 24, CommonJS (`require`/`module.exports`), `'use strict'`. ESM-only dependencies
  (e.g. mineflayer-auto-eat) are loaded with `await import()`.
- `standard` style: `corepack pnpm lint` must pass (`corepack pnpm fix` autofixes).
- Tests: mocha. Unit tests: `packages/*/test/**/*.test.js` (mineflayer-bedrock: `test/unit/**`).
- Always run pnpm through corepack: `COREPACK_ENABLE_DOWNLOAD_PROMPT=0 corepack pnpm …`.
- Every source file under `lib/` starts with `// owner: U<n> (<unit title>)` (multi-wave: `// owner: U4 (wave 2) → U9 (wave 3)`).
  A unit test enforces it for `lib/plugins`, `lib/bedrock`, `lib/physics`.

**mineflayer plugin shape** — identical to upstream:
```js
module.exports = inject
function inject (bot, options) {
  bot.someProperty = <upstream default>          // define at inject time, upstream default value
  bot._client.on('<bedrock packet>', (params) => { … bot.emit('<mineflayer event>', …same args as upstream…) })
  bot.someMethod = someMethod                    // same name, arity, sync/async semantics as upstream
}
```
- Read the upstream plugin first (`node_modules/mineflayer/lib/plugins/<name>.js`) and keep its API and
  event semantics (argument order, when events fire, what promises resolve to, error messages where tests
  match them).
- Never `pnpm patch mineflayer`. To reuse upstream code, vendor a copy into `lib/plugins/` (or `lib/`) with
  an MIT attribution header (`// Adapted from mineflayer 4.39.0 lib/plugins/x.js (MIT, Copyright (c) 2013 Andrew Kelley)`).
  Deep requires of unmodified helpers are fine: `mineflayer/lib/plugin_loader`, `promise_utils`, `math`,
  `location`, `painting`, `conversions`, `bossbar`, `scoreboard`, `particle`, `team`.
- Pix3lPirat3/mineflayer `feat/bedrock-edition-adapter` (MIT) is reference only — attribute any adapted
  snippet in a comment. deepslate-bedrock/prismarine-bedrock is UNLICENSED: read-only, never copy.

**Talking to the server**
- `bot._client` is the bedrock-protocol `Client`. Listen with `bot._client.on('<packet_name>', params => …)`.
- Send with **`bot._client.queue(name, params)`** (batched, flushed every 20 ms) by default; use
  `bot._client.write` only when ordering against an immediate write matters. The local player's movement and
  per-tick actions are never written directly — they go through `bot._bedrock.input` (one
  `player_auth_input` per tick).
- 64-bit fields arrive as protodef `SignedBigInt`/BigInt-like values: convert with `BigInt(x)` / `Number(x)`.
  Packets referencing entities use runtime ids (`varint64`) or unique ids (`zigzag64`), see `ids.js`.
- Commands from the bot: `command_request { command: '/…', origin: { type: 'player', uuid, request_id: '',
  player_entity_id: 0n }, internal: false, version: 'latest' }` → `command_output`.

**Positions and angles**
- `bot.entity.position` is the **feet** position (mineflayer). Every local-player position on the wire is at
  **eye level**: `wire.y = feet.y + EYE_HEIGHT` (`lib/bedrock/constants.js`, helpers in `conversions.js`).
  Other entities' positions: check per packet (players in `add_player`/`move_player` are eye-level, most mobs
  are feet-level) and document what you find.
- Yaw/pitch are radians in mineflayer; on the wire degrees with the Java "notchian" convention, so
  `mineflayer/lib/conversions` (`toNotchianYaw`, `fromNotchianYaw`, …) apply unchanged.
- Block faces: mineflayer 0..5 (bottom, top, north, south, west, east) == Bedrock `face`.

**Not implemented yet / stubs**
- Unimplemented APIs are stubs from `lib/bedrock/errors.js`: `stubSync(unit, 'bot.x', arity)` throws
  `NotImplementedError`, `stubAsync(...)` returns a rejected promise; both carry `fn.notImplemented = true`
  and `fn.unit`. `err.notImplemented === true`, `err.unit === 'U<n>'`.
- Implementing a member = replacing the stub with the real function (same arity). The real function must
  not carry `notImplemented`. U3's conformance test reports remaining stubs (failing mode from Wave 6).

**Bedrock vs Java**
- Bedrock-only extras go under `bot.bedrock.*` (typed in `types/bedrock.d.ts`) — never new top-level bot
  members.
- Java-only concepts keep their mineflayer property with an empty value (e.g. `bot.teams = {}`,
  `bot.tablist.header` empty) and are documented in `docs/differences/<unit>.md`.
- Ported tests never silently `return`: use `this.skip()` plus a differences entry.
- Registry/item/block names are Bedrock names (`bot.registry` is `bedrock_1.26.51`); tests that hard-code Java
  names are adapted with a documented mapping.

**Dependencies & patches**
- Exact versions only. Packages that are (or will be) patched, minecraft-data and bedrock-protocol are pinned
  in `pnpm-workspace.yaml` `overrides` so exactly ONE copy resolves everywhere (mineflayer, pathfinder, … must
  see the patched instance). Add an override before patching a new package.
- All pnpm settings live in `pnpm-workspace.yaml` (pnpm ≥ 11 ignores `package.json#pnpm`; pnpm 12 fails on
  unknown keys there). Dependency build scripts must be listed in `allowBuilds` (strict by default).
- Patch workflow: `corepack pnpm patch <pkg>@<ver> --edit-dir <your scratch dir>` → edit →
  `corepack pnpm patch-commit <dir>` → commit `patches/<pkg>@<ver>.patch` + the `patchedDependencies` entry;
  verify with `rm -rf node_modules && corepack pnpm install --frozen-lockfile`. To change an existing patch,
  start from it (`pnpm patch` re-applies it in the edit dir). Small upstream fixes only — large changes go
  in-repo.
- Data: never patch minecraft-data; ship overlays in `@bedboo/bedrock-data` (installed by
  `require('@bedboo/bedrock-data').install()` before any `bedrock_1.26.51` data is loaded — `index.js` does it
  first thing; tests/tools using bedrock-protocol or prismarine-* directly must call it too).

**Docker hygiene**: stop only the containers you started. Before U1's harness: one manual container per unit
on its fixed ports (see the e2e recipe).

## Cross-unit contracts

### Plan text (verbatim)

> - **Plugins:** same shape/options as mineflayer. `bot._client` = bedrock-protocol client (`on`, `queue` preferred, `write`).
>   Stubs define the full property surface with empty defaults; unimplemented functions throw `NotImplementedError(unit)` with
>   `.notImplemented = true`.
> - **Coordinates:** `bot.entity.position` = feet; wire eye level ±`EYE_HEIGHT` (`lib/bedrock/constants.js`). Yaw/pitch radians
>   per mineflayer; use `mineflayer/lib/conversions` notchian helpers.
> - **Lifecycle** (`lib/bedrock/lifecycle.js`): the ONLY emitter of `spawn` (`markSpawned()`): after join, after respawn reaches
>   ready, after dimension change completes. health.js never emits `spawn`.
> - **Tick/input** (`lib/bedrock/input_queue.js`): `tick = anchorTick + round((now-anchorTime)/50)` anchored on
>   `start_game.current_tick`, re-anchored by corrections; one physics step per elapsed server tick; API `addFlags(flags)`,
>   `hold(flag,on)`, `queueBlockAction(a)`, `queueItemStackRequest(r)` (≤1 per tick), `setVehicle(id, rot)`,
>   `suspend(reason)/resume(reason)`; `bot._bedrock.physics.setPosition(pos,{forced})`, `.setFlying(on)`.
> - **Physics surface** (stub in U4, real in U5, unit-tested so it can't regress): `look/lookAt(force)`, `bot.physics` with
>   mineflayer default fields, `set/get/clearControlState`, `physicsEnabled`, `waitForTicks`, `physicsTick`+`physicTick`,
>   `move`, `forcedMove` (move_player + handled_teleport, correction snap), `bot.entity.{yaw,pitch,onGround,eyeHeight,height,width}`.
> - **Self entity data** (`lib/bedrock/entity_data.js`): U4 applies self `update_attributes`/`set_health`/`mob_effect`/
>   `set_entity_data`/`set_entity_motion` to `bot.entity` (attributes keyed by Java resource names, effects keyed by Bedrock id
>   with `registry.effects` names); U7-entities handles all other entities and skips self.
> - **Transactions** (`lib/bedrock/transactions.js`): `useItemOn` (with start/stop_item_use_on), `useItem`, `release`,
>   `useOnEntity`, `mouseOver`; `bot._bedrock.heldNetworkItem()` provider (U4 mirrors raw inventory packets; U8 replaces).
> - **Stack requests** (`lib/bedrock/stack_request.js`, owner U8): `create(actions) → {request, response: Promise}`,
>   `send(actions)`; `slots.resolve(window, javaSlot) → {container_id, slot, stack_network_id}`; window registry
>   `bot._bedrock.windows.register(containerType, {javaType, slotMap})` with ALL container types delivered by U8.
> - **Features** (`bedrock-data` + `lib/bedrock/features.js`): explicit Bedrock value for every Java feature name used in
>   mineflayer lib/ and test/ and reused plugins; unit test fails on unknown names. Ported tests never silently `return`; use
>   `this.skip()` + a differences fragment.
> - **Ownership:** one owner per file and per patch per wave (table in CONTRIBUTING). Never `pnpm patch mineflayer`: vendor a
>   copy into `lib/plugins/` with MIT attribution. Bedrock-only extras under `bot.bedrock.*`; Java-only concepts keep their
>   property with an empty value (documented).

### Expanded reference (exact names created by U0)

**`bot._bedrock`** — created by `lib/loader.js` before plugins are injected; one owner per namespace:

| Namespace | Created by | Owner | Contents |
|---|---|---|---|
| `bot._bedrock.input` | `createInputQueue(bot, { now? })` (`input_queue.js`) | U4 → U5 | `anchor(tick, at?)`, `currentTick(at?) → bigint`, `addFlags(flags[])`, `hold(flag, on)`, `queueBlockAction({ action, position, face })`, `queueItemStackRequest(request)`, `setVehicle(runtimeId \| null, rotation?)`, `suspend(reason)`, `resume(reason)`, `isSuspended()` |
| `bot._bedrock.physics` | loader | U4 → U5 | `setPosition(pos, { forced })`, `setFlying(on)` |
| `bot._bedrock.lifecycle` | `createLifecycle(bot)` (`lifecycle.js`) | U4 | `state`, `markSpawned('join'\|'respawn'\|'dimension')` (only emitter of `spawn`), `setState(state)`, `waitFor(state, { timeout })` |
| `bot._bedrock.stackRequests` | `createStackRequestManager(bot)` (`stack_request.js`) | U8 | `create(actions, opts?) → { request, response: Promise }`, `send(actions, opts?) → Promise<response>` |
| `bot._bedrock.windows` | `createWindowRegistry()` (`windows.js`) | U8 | `register(containerType, { javaType, slotMap, title? })`, `get(type)`, `has(type)`, `types()` |
| `bot._bedrock.heldNetworkItem` | loader (stub) | U4 → U8 | `() → wire Item` exact server copy of the held item |
| `bot._bedrock.ids` | `createIds()` (`ids.js`) | U4 | `runtimeToUnique`, `uniqueToRuntime` (Maps of BigInt), `trackEntity(runtimeId, uniqueId)`, `untrackEntity({ uniqueId?, runtimeId? }) → entityId`, `entityId(runtimeId) → number`, `entityIdFromUnique(uniqueId)`, `itemName(networkId)`, `itemNetworkId(name)`, `loadItemRegistry(packet)` |
| `bot._bedrock.startGame` | U4 | U4 | raw `start_game` params once received (else `null`) |

**`lib/bedrock/*` modules**

| Module | Exports |
|---|---|
| `errors.js` | `NotImplementedError(unit, feature)`, `stub(unit, feature, { async, noop, length })`, `stubSync(unit, feature, length)`, `stubAsync(unit, feature, length)`, `isStub(fn)` |
| `constants.js` | `VERSION` '1.26.51', `PROTOCOL_VERSION` 2193, `BDS_VERSION`, `EYE_HEIGHT` 1.62, `PLAYER_HEIGHT`, `PLAYER_WIDTH`, `SNEAK_HEIGHT`, `SNEAK_EYE_HEIGHT`, `TICK_MS`, `TICKS_PER_SECOND`, `DIMENSION_NAMES`, `DIMENSION_IDS`, `DIMENSION_HEIGHTS`, `GAME_MODES`, `DIFFICULTY_NAMES`, `toWireY(feetY)`, `fromWireY(wireY)` |
| `conversions.js` | everything from `mineflayer/lib/conversions` + `toBedrockYaw/Pitch`, `fromBedrockYaw/Pitch`, `vec3FromWire`, `vec3ToWire`, `feetFromWire`, `feetToWire`, `BLOCK_FACES` |
| `ids.js` | `createIds()` |
| `item.js` | `fromNetwork(registry, wireItem) → Item \| null`, `toNetwork(registry, item, { stackId? }) → wireItem`, `EMPTY_NETWORK_ITEM` |
| `input_queue.js` | `createInputQueue(bot, { now })` |
| `lifecycle.js` | `createLifecycle(bot)` |
| `entity_data.js` | `ATTRIBUTE_NAMES`, `applyAttributes(bot, packet)`, `applyHealth`, `applyEffect`, `applyMetadata`, `applyMotion` |
| `transactions.js` | `useItemOn(bot, { position, face, cursor?, hotbarSlot?, blockRuntimeId? })`, `useItem(bot, opts)`, `release(bot, opts)`, `useOnEntity(bot, entity, { action, position? })`, `mouseOver(bot, entity, position?)` |
| `stack_request.js` | `createStackRequestManager(bot)` |
| `slots.js` | `resolve(window, javaSlot) → { container_id, slot, stack_network_id }`, `toJava(window, containerId, slot) → number \| null` |
| `windows.js` | `createWindowRegistry()` |
| `features.js` | `FEATURES` (Java feature name → Bedrock value), `createSupportFeature(registry) → supportFeature(name)` |
| `text.js` | `toChatMessage(registry, textPacket) → { message, position, sender? }`, `fromRawText(registry, json)`, `fromFormattedString(registry, str)` |
| `paintings.js` | `MOTIVES`, `fromAddPainting(packet) → Painting` |
| `recipes.js` | `parseCraftingData(registry, packet) → Recipe[]`, `createRecipeBook(bot)` |
| `lib/physics/index.js` | `Physics(registry, world)` (→ `bot.physics`: upstream field names + `simulatePlayer(state, world)`), `PlayerState(bot, controls)` (prismarine-physics shape, used by mineflayer-pathfinder) |

**Other entry points**: `lib/registry.js` `installDataOverlay()`, `createRegistry(version)`;
`lib/client.js` `createClient(options)` (defaults: `host 127.0.0.1`, `port 19132`, `offline: true`,
`transport: 'raknet'`, `raknetBackend: 'raknet-native'`, `version: '1.26.51'`, `skipPing: true`);
`lib/version.js` `testedVersions`, `latestSupportedVersion`, `oldestSupportedVersion`;
`@bedboo/bedrock-data` `install()`; `@bedboo/bds` `startServer(opts) → { host, port, command(cmd), waitForLog(re), stop() }`,
`createTestBot(opts)`, env fallback `BDS_HOST`/`BDS_PORT` (+ `BDS_CONTAINER`); `@bedboo/agent` skill interface
`async (bot, args) => result`, `runSkill`, `runScenario`.

**Facts every unit must know** (from the U0 spike, details in `docs/testing.md`):
- Join: `start_game.player_position.y = 32769.62` (spawn search), then `respawn` state 0 ×2 and `respawn`
  state 1 with the real eye-level position; answer with `respawn { state: 2, runtime_entity_id }`.
- After `play_status player_spawn` the client must send `serverbound_loading_screen` type 1 then type 2,
  otherwise BDS **does not simulate the player at all** (auth inputs ignored, no corrections).
- `level_chunk` is in sub-chunk request mode: `sub_chunk_count: 0` + `highest_subchunk_count` present.
- No `set_time` packet on 1.26.51 — world time is in `sync_world_clocks`.
- `/give`, `/replaceitem` → `inventory_content` (not `inventory_slot`).

### As implemented by U4 (wave 2) — read before using these contracts

Additions/precisions to the tables above; all live on `main` since PR #5.

- **Lifecycle** (`bot._bedrock.lifecycle`): `state`, `markSpawned('join'|'respawn'|'dimension')`, `setState(s)`,
  `waitFor(s, {timeout})` (rejects immediately if already `ended`), `events` (`state`, `spawned`, `dimensionChange`),
  `sendLoadingScreenAck(id?)`, `beginDimensionChange(pkt)`, `completeDimensionChange()`. The input clock is suspended
  in `connecting`/`loading`/`changing_dimension`/`ended`; it runs in `dead`/`respawning`.
  - Join: `start_game` → `loading` (clock anchored) → `respawn` state 1 sets position (eye→feet, `forcedMove`) and
    replies `respawn {state: 2}` → `play_status player_spawn` → `serverbound_loading_screen` 1,2 →
    `markSpawned('join')`. Bot events: `login` → `game` → `spawn`.
  - Dimension change (observed live): `change_dimension` position is **feet-level** (unlike `move_player`);
    lifecycle emits `dimensionChange` (blocks.js resets world, game.js switches `bot.game.dimension` + emits `game`),
    applies position, sends `player_action dimension_change_ack`; BDS answers with its own `dimension_change_ack`
    → loading-screen acks (with `loading_screen_id`) → `markSpawned('dimension')` (→ `spawn`).
  - Respawn (U9): `respawn` state 1 after a death only moves the bot. U9 drives `setState('dead')` →
    `setState('respawning')` → `markSpawned('respawn')`. Until `bot.respawn` is real, the test harness answers deaths.
- **Input queue** (`bot._bedrock.input`): `tick = anchorTick + round((now-anchorTime)/50)`; a 50 ms timer `pump()`s exactly
  one packet per elapsed tick (catch-up capped at `maxCatchupTicks`=4, older ticks skipped). Extras: `setProvider(fn(tick)
  → movement fields)` (**U5 replaces the provider**), `onSent(fn)`, `start`, `stop`, `pump`, `lastTick`,
  `markTeleportHandled()`. Held flag `block_breaking_delay_enabled` is on by default; block actions add `block_action`,
  ≤1 stack request per tick adds `item_stack_request`, vehicle adds `client_predicted_vehicle`.
  Packet defaults: `play_mode normal`, `interaction_model crosshair`, `input_mode mouse`.
- **Physics stub** (`lib/plugins/physics.js`, U5 replaces the engine): all 31 upstream `bot.physics` fields;
  `simulatePlayer` no-op; `adjustPositionHeight` ground search; control states recorded; `look/lookAt` send the
  rotation in the next input and resolve when sent (`force` resolves immediately); `waitForTicks`; `physicsTick` +
  `physicTick` once per tick while the bot's column is loaded; `move` on position/look change; `forcedMove` on own
  `move_player` (teleport/reset also set `handled_teleport`; rotation mode only turns the head) and on
  `correct_player_move_prediction` (snap pos/vel/onGround); simple Java-style gravity; `bot._bedrock.physics.
  setPosition(pos, {forced, handledTeleport = forced})`, `setFlying(on)`, `isFlying()`. **No** walking/collisions/
  rewind/vehicles/elytra/flight movement yet → wave-3 tests place the bot with `/tp`.
- **Local player**: `bot.entity` = prismarine-entity, `id = Number(runtimeId)`, `uniqueId`/`runtimeId` BigInt,
  live `equipment` getter (U8 may redefine). Attributes keyed by Java resource name with `value` = **base** value
  (modifier formula inverted); `minecraft:health` → `max_health`; Bedrock-only attributes keep their Bedrock key.
  Effects keyed by Bedrock id. Metadata: Bedrock key names stored as named props on the metadata array; flags drive
  `crouching/sprinting/swimming/onFire/elytraFlying` + sleep events. `bot._bedrock.ids`: `setSelf`, `selfRuntimeId()`,
  `selfUniqueId()`, `isSelf(runtimeId)`, `isSelfUnique(uniqueId)` — **U7 skips `ids.isSelf(runtimeId)`**.
- **Transactions**: `useItemOn(bot, {position, face, cursor?, hotbarSlot?, blockRuntimeId?, hand?, lifecycle = true,
  stopDelay = 150})` = `player_action start_item_use_on` → `click_block` transaction → `stop_item_use_on`; `useItem`
  (click_air), `release`, `useOnEntity` (attack/interact), `mouseOver`; `build*` variants return the packet.
  Held-item provider mirrors `inventory_content/slot`, `player_hotbar`, own `mob_equipment`; exposes `.selectedSlot()`,
  `.slot(i)`, `.slots` (U8 replaces it).
- **Chat core**: `bot.chat('/x')` → `command_request` (fresh origin uuid), else authored `text` chat split like upstream.
  Incoming `text` → player chat as `{translate:'chat.type.text'}` ("<name> msg", `sender` = uuid when known);
  positions: chat-like → `chat`, raw/system/translation/json → `system`, tip/popup → `game_info`; `%key` / rawtext via
  `registry.language`. Each `command_output` line → a `message` with `translate` = its message id.
  **U6:** move the parser (`createTextParser()` in chat.js) into `lib/bedrock/text.js`, keep `emitMessage` the single
  emitter. Hooks: `bot._bedrock.chat = {emitMessage, chatWithHeader, send, parser}`,
  `bot._bedrock.commands.request(cmd) → Promise<command_output>`. `chat` event + patterns are U6's.
- **World core**: one `subchunk_request` per column covering the dimension range (overworld -4..19, nether 0..7,
  end 0..15); columns created with the dimension's `minY`/height. Waterlogging: `blockAt` returns layer 0 plus
  `superimposed` (layer 1), `computedStates.waterlogged`, `isWaterlogged` when layer 1 is water.
  `update_subchunk_blocks`: `blocks` = layer 0, `extra` = layer 1. Unload beyond publisher radius + 1 chunk.
  **U9:** `bot._bedrock.world` = `{reset(dimension), dimension(), pendingColumns, paintings (U7), stateIdOf,
  applyBlockUpdate}`.
- **bedrock-protocol patch**: `client.holdResourcePacks(packet) → bool`, `client.respondToResourcePacks('completed' |
  'have_all_packs' | 'refused')`.
- **Test helpers** (U1 files, fixed by U4): raw join/respawn handling decided lazily per packet (`ctx.raw` getters);
  `sayEverywhere('/x')` runs as the bot's own command; e2e runs with `BEDBOO_STRICT_FEATURES=1`
  (`test/strict-features.js`).
- **Known BDS facts**: `/op` from the bot is refused (op via console); same-name rejoin right after `quit()` in a new
  process can hit `server_id_conflict`; BDS sends no server brand (`serverBrand` = 'vanilla').

### As implemented in wave 3 (U6–U9) — read before building on them

- **Chat / text (U6)**: parser lives in `lib/bedrock/text.js`; `bot._bedrock.chat.emitMessage` stays the single emitter
  of `message`/`messagestr`. Patterns ported verbatim (default `chat`/`whisper` patterns take the sender from the
  Bedrock packet). `tabComplete` is client-side from `available_commands` (`lib/bedrock/commands.js`), upstream
  `[{match, tooltip}]` shape. `/tellraw` needs `{"rawtext":[…]}`; its messages arrive at position `system`.
  Boss bars come only from summoned bosses (no `/bossbar`); teams/tab header are empty (documented).
  `helpers/chat.js` makes `bot.test.tellAndListen` use the real `chat` event.
- **Entities (U7)**: `entities.js` handles all non-self entities (self skipped via `ids.isSelf`). Wire positions verified
  live: `add_player` **feet**; other players' `move_player` eye-level; `add_entity`/`add_item_entity`/`move_entity(_delta)`
  feet + per-type offset (item 0.125, TNT/falling block 0.49, boat 0.375, minecart 0.35). `move_entity_delta` = absolute
  optional coords + byte rotations. A killing blow emits `entityHurt` then `entityDead`. `attack/useOn/mount` (since W3-FIX-B: **no longer rotate the bot**; they wait on `afterControlsSent`) previously looked at the
  target, `mouseOver`, then `item_use_on_entity` with `heldNetworkItem()`. `generic.armor`/`generic.armorToughness`
  synthesized from equipment. prismarine-entity patch: Bedrock `getDroppedItem()` (from `add_item_entity`),
  `getCustomName()`. Helpers: `summon` (spawn events, name tags, aliases e.g. `villager_v2`→`villager`), `killEntity`,
  `botEvent`, `killAllEntities`.
- **Inventory / windows (U8)** — wave-4 units build on this:
  - `bot._bedrock.windows` is pre-filled for every container type; key = `container_open.window_type`, except chest-like
    blocks (BDS sends `container`): use `windowKey(packet, {blockName, entityName})`. Spec: `javaType`, `size`,
    `craftingResultSlot`, `content`, `slotMap` (`{container_id, slot, content, ui}` per Java slot), `quickMoveTargets`,
    `slotLimits`; `register(type, spec)` refines one.
  - Live-verified container ids/slots: chest/large/trapped/ender `container`; barrel `barrel`; shulker `shulker`;
    dispenser/dropper/hopper/crafter `container`; furnace/blast/smoker slots 0–2; brewing ingredient 0, bottles 1–3,
    fuel 4; crafting-table grid ui 32–40; anvil ui 1/2; enchanting 14/15; grindstone 16/17; stonecutter 3; loom 9–11;
    cartography 12/13; smithing 51–53; beacon 27; off-hand = slot **1** in requests; armor 0–3; crafted results from
    `creative_output` slot 50. Trading/horse/lectern maps are not yet live-verified (U13/U14 verify).
  - `lib/bedrock/slots.js`: `resolve(window, javaSlot)`, `toJava`, `contentToJava`, `uiToJava`, `slotInfo`.
  - `bot._bedrock.stackRequests`: `create(actions | (requestId) => actions, opts) → {request, response}`,
    `write(request, {viaInput})`, `send(...)`, `observe(fn)` (outcomes ok/error/timeout/closed/late-ok/late-error).
    Request ids -1, -3, -5…; `legacy_type_id` uses the **pre-1.26.40 numbering** filled automatically
    (craft_creative 14, craft_recipe 12, results_deprecated 19 — a wrong value or a count of 0 gets the bot
    disconnected). Errors roll back predictions; status 7 = no matching screen (retried once after reopening the
    inventory screen), 49 = stack id mismatch, 50 = invalid slot/container.
  - `bot._bedrock.inventoryModel.execute(window, steps)` accepts `raw`, `consume`, `{src: {created: item}}` steps for
    craft requests (U12); clicking a crafting result slot throws. `inventoryModel.screen.close()` for a deterministic
    state.
  - Opening: `openBlock/openContainer/openEntity` send a plain `click_block` (no start/stop wrapper). Opening another
    container waits for the close echo + 100 ms. `closeWindow` returns carried/station items to the inventory first.
  - Item use: `activateItem(offHand)` = click_air (direction from that tick's input); eating finishes on
    `completed_using_item`; `deactivateItem` = release; shield → hold sneak. No server cooldown packet exists.
  - Creative: `creative.setInventorySlot` = `craft_creative` (entry id from `creative_content`, index at
    `bot._bedrock.creativeItems`) + place from slot 50; **only items in the server's creative catalogue (incl. its NBT
    variants, e.g. enchanted books) can be created** — arbitrary NBT is impossible (documented difference). Helper
    `setInventorySlot` uses it in creative and falls back to console `replaceitem`.
- **Player state / dimensions (U9)**: `health.js` drives death/respawn (death on own `death_animation` or health 0 in
  `update_attributes`; `respawn()` sends client state 2 once per death after the server's state 0; `respawn: false`
  supported); `lifecycle.markDead()` and a lifecycle `dimensionChanged` event exist; a `change_dimension` without
  `loading_screen_id` (respawn into another dimension) must NOT be answered with `serverbound_loading_screen` (kick).
  `game.js` acks `show_credits` (status 1) after the End exit. `bot.bedrock.gameRules` holds raw gamerules.
  prismarine-chunk biomes fixed at every height; prismarine-block Bedrock signs read/write `FrontText`/`BackText`.
  Vendored ray_trace fixes upstream's null-at-exact-0-pitch/yaw bug (documented). Emulated: abilities after gamemode
  change, break-progress stages, `time` every 20 ticks, `spawnReset` from `tile.bed.notValid`.
- **Wave-3 fix-ups (W3-FIX-A)** — wave-4 units build on these:
  - **Sneak / sprint before a click:** `setControlState('sneak' | 'sprint')` reaches the server only with the next
    `player_auth_input` (upstream sends it at once). Anything that clicks right after a control change must wait for it:
    `bot._bedrock.physics.controlsPending()` (a change is not sent yet), `controlsSent()` → Promise (resolves right after
    the input that carries the current state was queued; at once when nothing is pending), `afterControlsSent(fn)` (runs
    `fn` now, or right after that input — for synchronous APIs: entities.js `attack` / `useOn` / `mount` must send
    through it). `transactions.useItemOn` / `useOnEntity` already wait (and stay synchronous when nothing is pending),
    so U11's `_genericPlace` / `activateBlock` get it for free when they use them.
  - **Abilities:** `abilities.js` is the only parser of `update_abilities`; physics follows `bot.abilities` (flight,
    `flyingSpeed`, `mayFly`) and never echoes a server-side change with `request_ability`. A repeated `update_abilities`
    emits no `abilities` event. `creative.startFlying` leaves `bot.physics.gravity` alone when the physics hook exists.
  - **Item use in physics:** the ±0.1225 clamp applies only after a `click_air` (observed on outgoing transactions); a
    raised shield (sneak) is not an item use.
  - **Firework boosts:** a raise of `bot.fireworkRocketDuration` between ticks is recorded in that tick's input
    (`fireworkStart`) and replayed by corrections / resimulations / teleports; set it when the bot's rocket appears.
  - **Spawn:** `lifecycle.markSpawned('respawn' | 'dimension')` waits (≤ 2 s) for the real position when the server sent
    the spawn search height (End exit, cross-dimension respawn); `spawn` then follows that position's `forcedMove`.
  - **Physics events:** a throwing `physicsTick` listener no longer aborts the tick (the error is emitted after the
    input is sent); `look()` / `lookAt()` resolve once the rotation was really sent (also from tick / move listeners);
    a jump queued between ticks survives replays; `entityElytraFlew(bot.entity)` fires on the server's gliding flag.

### As implemented in wave 4 (U10–U14, W3-FIX-A/B) — read before building on them

- **Digging (U10)**: `bot.dig` sends one `start_break` (no per-tick `continue_break` — BDS treats it as a restart),
  waits for BDS's own per-tick break-progress reports and sends `predict_break` when the server is one tick from done
  (client-count fallback when no reports), completes on the server's `update_block`, then sends `abort_break` to release
  the server's break state (otherwise BDS also breaks the next block placed there). No `mine_block` request (BDS damages
  the tool itself). Creative: `start_break` + `predict_break` in one input; swords/tridents/maces can't break in creative
  (`digTime = Infinity`). Speed model in `lib/bedrock/dig_speed.js` (Bedrock effect factors: Haste/Conduit Power
  ×(1+0.2h)·1.2^h, Mining Fatigue ×0.21^f) — prismarine-block's `block.digTime` keeps Java effect factors (pathfinder/
  mineflayer-tool cost estimates under effects are off; U15 may patch). Diagnostics: `bot._bedrock.digging`. BDS sends
  the destroyed block's update more than once within ~1 tick.
- **Placing (U11)**: `_genericPlace` = `start_item_use_on` → `click_block` (exact held item, clicked block runtime id,
  click point, face, hotbar slot, hand, eye-level player pos) → `stop_item_use_on` 150 ms later; BDS replies
  `inventory_content` + `update_block` burst (clicked block, then the target) even for refusals → upstream
  `place_block.js` vendored verbatim. Sneak-placing against interactive blocks holds sneak and awaits `controlsSent()`.
  BDS refuses any block overlapping the player's server hitbox (never pushes out); the click waits for an input whose
  hitbox clears the target while rising. `bot._bedrock.placement.useOnLookedAtBlock(item, offHand)` handles buckets/
  boats (BDS ignores their `click_air`; `activateItem` routes there). Off-hand placement is impossible on Bedrock.
  Pathfinder bridging gets ~3 corrections from pathfinder's own client-side recentring (U15 may patch).
- **Crafting (U12)**: recipes from `crafting_data` (`lib/bedrock/recipes.js`, `bot._bedrock.recipes`), tags from
  `lib/bedrock/item_tags.js` (pmmp/BedrockData CC0, live-verified), `bot.registry.recipes` replaced per bot in Java
  shape. Request: `place`×n → `crafting_input` (2×2 ui 28–31 needs the inventory screen; table ui 32–40 row-major),
  `craft_recipe`, `results_deprecated`, `consume` per grid cell, `create {result_slot_id}` before each of several
  results, take/place from `creative_output` 50. ≤1 stack per result per request; all results must be taken.
- **Stations (U13)**: furnace progress buffered by window id (properties 0/1/2; total cook time by block type);
  enchanting = `craft_recipe` with the zigzag option id + consume lapis/item + place (result predicted; `xpseed` = -1);
  anvil = `optional` request with custom names (Bedrock anvil cost calculator in-repo); trading window opened by
  `update_trade` (no `container_open`), ingredients ui 4/5, one `craft_recipe` per use. Shared helpers in
  `lib/bedrock/stations.js`.
- **Survival (U14)**: books must be opened with an item use first, edits are acked by the resend on close; `fish()`
  bite = `entity_event fish_hook_hook`; sleep/wake per upstream; elytra boost tracked from metadata key 18
  (`minecart_has_display`, the boosted player's unique id; `owner_eid` is -1).
- **Inventory model (W3-FIX-B)**: per-slot request chains (responses applied in order, rollbacks per request);
  `inventoryModel.execute()` passes `customNames`, `cause`, `requestId`; raw actions may be a function of the request
  id; items can be dropped from created output. `openBlock/openEntity/activateBlock/activateEntity` close any open
  container first. `bot._bedrock.commands.request` resolves ~100 ms after `command_executed` for commands without
  output. Liquid layer (waterlogging) predicted on block updates with sub-chunk re-request when uncertain.
- **Physics (W3-FIX-A)**: `abilities.js` is the single parser of `update_abilities`; physics follows `bot.abilities`.
  Riding reports the vehicle seat (vehicle pos + `rider_seat_position`). `spawn` waits (≤2 s) for a real position, never
  the 32767 search height. A throwing `physicsTick` listener no longer stops ticking. `creative.startFlying` no longer
  touches gravity. Plain fireworks/banners/firework stars resolve to the creative default variant.

### bedd mode: authority table and route registry (BEDD-2)

- **Authority table** (`lib/bedd/authority.js`, `classify(name, params)`; identical to Be.D.D.'s CONTRIBUTING.md, change
  both together). In `transport: 'bedd'` the real client sends every serverbound packet; `client.bedd.route(name,
  params)` receives what bedboo would have sent:

  | Class | Packets | Handling |
  |---|---|---|
  | clientOwned | login, client_to_server_handshake, request_network_settings, resource_pack_client_response, client_cache_status, client_cache_blob_status, request_chunk_radius, subchunk_request, serverbound_loading_screen, set_local_player_as_initialized, network_stack_latency, tick_sync, player_skin, emote_list, respawn, player_action (dimension_change_ack / start_item_use_on / stop_item_use_on / respawn), animate, interact mouse_over_entity | dropped, counted |
  | translated | player_auth_input (move + flags → `input`, yaw/pitch → `look`, block_action → BB3), mob_equipment (`slot`), inventory_transaction (item_use click_block/click_air, item_release, item_use_on_entity → BB3), interact open_inventory (`action inventory`), container_close (key ESC), item_stack_request (`stack`, BB7) | intents |
  | shared | text, command_request | `send` (bedrock-protocol bytes); fallback T / SLASH, `text`, ENTER |
  | unsupported | book_edit, block_pick_request, crafting_event, set_default_game_type, everything else | throws BeddUnsupportedError (`ERR_BEDD_UNSUPPORTED`), `bot` emits `'bedd_unsupported_packet'` once per name |

- **Route registry**: `client.bedd.routes.register(name, handler)` (returns an unregister function); whoever attaches
  first creates it with `require('./router').ensureRoutes(client.bedd)` or an equivalent `{ register, get }` object.
  `handler(params, ctx)` (`ctx`: `name, bot, client, call(op, args), present(op), key(name, action), inputAllowed(),
  world()`) wins over the router's built-in translation of `name`, and a translated name without a handler takes the
  unsupported path. player_auth_input handlers run after the built-in movement/look translation; its parts are
  dispatched as `'block_action'` (params = the block_action array) and `'item_stack_request'` (params =
  `{ requests: [request] }`, `ctx.embedded`), which only report (never throw) when unhandled.
- Input intents (`input`, `look`, `slot`, open_inventory, key fallbacks) are gated on `world.mouseGrabbed &&
  !world.showingMenu` when the `world` op is present (polled every 250 ms); ESC and chat are not gated.

### bedd inventory routing (BEDD-7)

| Contract | Where | Owner | Shape |
|---|---|---|---|
| `item_stack_request` route | `lib/bedd/inventory.js` `attach(bot, client)` | BEDD-7 | `client.bedd.routes.register('item_stack_request', fn)` (registry `{ map, register(name, fn) }` created when missing; `client.bedd.route` dispatches through it). With `caps.stack === 'present'` each request becomes `rpc.call('stack', { buf })` (base64 serialized item_stack_request, one request) → `{ ok, via, requestIds, map: { '<bedbooId>': clientId } }`; otherwise the request rejects with a BeddUnsupportedError (`ERR_BEDD_UNSUPPORTED`). |
| Response correlation | `stackRequests.bedd = { responseId(response) }`, `stackRequests.abort(requestId, err)` | BEDD-7 (hook in U8's `stack_request.js`) | `responseId` maps the client's request id of an item_stack_response to bedboo's (undefined: not a bedboo request). `null` outside bedd mode, so raknet/nethernet are unchanged. `viaInput` is ignored in bedd mode. Stack ids naming an earlier bedboo request are rewritten to its client id; a self reference keeps bedboo's id (BeDD substitutes the id it assigns). |

## Ownership

One owner per file and per patch **per wave**. A file not listed belongs to the unit that creates it. When a
later wave lists a new owner, the previous owner's work is merged and frozen for that wave.

**Rule for minimal fixes:** a later-wave unit may make *minimal* fixes to merged code that no unit of the
*current* wave owns (e.g. a one-line bug fix in a wave-2 file during wave 3), and must list every such edit
in its PR body. Files owned by a current-wave sibling are off limits — ask the coordinator.

**Shared, additive-only files** (any unit, smallest possible additive edit, keep both sides on conflicts):
root/package `package.json` dependency lists, `pnpm-workspace.yaml` (`overrides`, `patchedDependencies`,
`allowBuilds` entries for your own packages), `pnpm-lock.yaml` (on conflict take `origin/main`'s and re-run
`corepack pnpm install`), `index.d.ts` and `types/bedrock.d.ts` (members you implement/add),
`docs/parity/<unit>.md` and `docs/differences/<unit>.md` (your own fragment only).

### mineflayer-bedrock top level and `lib/`

| File | W0 | W1 | W2 | W3 | W4 | W5 | W6 |
|---|---|---|---|---|---|---|---|
| `index.js`, `lib/loader.js`, `lib/client.js`, `lib/registry.js`, `lib/version.js` | U0 | — | U4 | — | — | U16 | — |
| `index.d.ts`, `types/bedrock.d.ts` | U0 | — | U4 (+ additive) | additive | additive | U16 | — |
| `lib/physics/**` | U0 | — | — | U5 | — | — | — |

### `lib/bedrock/`

| File | W0 | W1 | W2 | W3 | W4 | W5 |
|---|---|---|---|---|---|---|
| `errors.js` | U0 (frozen; coordinator only) | | | | | |
| `constants.js`, `ids.js`, `conversions.js`, `lifecycle.js`, `entity_data.js`, `transactions.js` | U0 | — | U4 | — | — | — |
| `item.js` | U0 | — | U4 | U8 | — | — |
| `input_queue.js` | U0 | — | U4 | U5 | — | — |
| `stack_request.js`, `slots.js`, `windows.js` | U0 | — | — | U8 | — | — |
| `features.js` | U0 | U2 | — | U9 | U10 | — |
| `text.js` | U0 | — | — | U6 | — | — |
| `paintings.js` | U0 | — | — | U7 | — | — |
| `recipes.js` | U0 | — | — | — | U12 | — |

### `lib/plugins/` (43 files)

| Plugin file(s) | W2 | W3 | W4 |
|---|---|---|---|
| `game.js` | U4 | U9 | — |
| `kick.js`, `settings.js`, `resource_pack.js` | U4 | — | — |
| `blocks.js` | U4 (core world) | U9 (dimension reset, block entities API) | — |
| `chat.js` | U4 (core: `bot.chat`, message/messagestr) | U6 | — |
| `physics.js` | U4 (stationary stub, full surface) | U5 | — |
| `entities.js` | U4 (local player only) | U7 | — |
| `title.js`, `boss_bar.js`, `scoreboard.js`, `team.js`, `tablist.js`, `sound.js`, `particle.js` | — | U6 | — |
| `inventory.js`, `simple_inventory.js`, `chest.js`, `creative.js` | — | U8 | — |
| `health.js`, `experience.js`, `time.js`, `rain.js`, `spawn_point.js`, `abilities.js`, `breath.js`, `block_actions.js`, `command_block.js`, `ray_trace.js`, `explosion.js`, `sign.js` | — | U9 | — |
| `bed.js` | — | U9 (state: isSleeping, isABed, parseBedMetadata, spawnReset) | U14 (sleep/wake) |
| `digging.js` | — | — | U10 |
| `generic_place.js`, `place_block.js`, `place_entity.js` | — | — | U11 |
| `craft.js` | — | — | U12 |
| `furnace.js`, `enchantment_table.js`, `anvil.js`, `villager.js` | — | — | U13 |
| `fishing.js`, `book.js` | — | — | U14 |

(`sequence.js` does not exist in mineflayer 4.39.0, so there is no such file; if a later mineflayer adds
it, it goes to U11.) Wave 5: U16 may touch any plugin for parity hardening (listing edits in the PR body).

### Tests, tooling, other packages

| Path | Owner(s) |
|---|---|
| `packages/mineflayer-bedrock/test/fixtures/**` | U0 (a unit adding a new capture file owns that file) |
| `packages/mineflayer-bedrock/test/unit/smoke.test.js`, `errors.test.js`, `fixtures.test.js` | U0 |
| `packages/mineflayer-bedrock/test/unit/conformance/**`, `scripts/parity/**` | U3 (W1) |
| `packages/mineflayer-bedrock/test/unit/<area>.test.js` | the unit that creates it |
| `packages/mineflayer-bedrock/.mocharc*.json`, `scripts/run-e2e.js` | U1 (W1) |
| `test/external/common/index.js`, `helpers/base.js`, `helpers/world.js` | U1 (W1) |
| `test/external/common/helpers/inventory.js` | U1 (W1) → U8 (W3 upgrade) |
| `test/external/common/helpers/entities.js` | U1 (W1) → U7 (W3) |
| `test/external/common/helpers/chat.js` | U6 (W3) |
| `test/external/common/helpers/place.js` | U11 (W4; upgrades `bot.test.placeBlock` to the real API) |
| `test/external/transport.test.js` | U0 → U1 |
| `test/external/<name>.test.js` | owner listed for that test in `docs/parity/U0-seed.md` |
| `examples/**` | U15 |
| `packages/bds/**`, `.github/workflows/ci.yml`, `docs/testing.md` | U1 (W1; U0 seeded `docs/testing.md`) |
| `packages/bedrock-data/**` | U2 (W1) → U9 (W3) → U10 (W4) |
| `packages/agent/src/runner.js`, `src/skill.js`, `src/errors.js`, `src/skills/{index,navigate,gather,craft,smelt,mine,build}.js`, `scenarios/overworld/**` | U17 (W6) |
| `packages/agent/src/skills/{combat,portal,nether,end}.js`, `scenarios/{combat,nether,end}/**` | U18 (W6) |
| `scripts/capture-fixtures.js` | U0 |
| `docs/CONTRIBUTING.md`, `docs/upstream/**`, `docs/parity/README.md`, `docs/parity/_template.md`, `docs/differences/README.md` | coordinator (U0 created) |

### Patch targets (`patches/`)

| Package | Owner by wave |
|---|---|
| raknet-native | U0 |
| prismarine-registry, prismarine-chunk, prismarine-block | U2 (W1) → U4 (W2) → U9 (W3) |
| prismarine-item | U2 (W1) → U4 (W2) → U8 (W3) |
| bedrock-protocol | U4 (W2) → U8 (W3) → U11 (W4) → U16 (W5) |
| prismarine-entity | U7 (W3) |
| prismarine-windows | U8 (W3) |
| prismarine-chat | U6 (W3) |
| prismarine-recipe | U12 (W4) |
| mineflayer-pathfinder, -pvp, -collectblock, -tool, -armor-manager, -auto-eat | U15 (W5) |
| mineflayer | never patched — vendor copies into `lib/` |
| minecraft-data | never patched — overlay in `@bedboo/bedrock-data` |
| prismarine-physics | never patched — forked in-repo (`lib/physics/`, U5) |

## Testing, e2e recipe and worker gate

```sh
corepack pnpm install --frozen-lockfile        # `corepack pnpm install` if you changed deps
corepack pnpm lint && corepack pnpm test       # unit tests, no server
corepack pnpm typecheck                        # index.d.ts / types (when you touched typings)
corepack pnpm bds pull                         # once per host (golden BDS 1.26.51.1 cache)            [U1]
corepack pnpm test:e2e -- --grep "<suite>"     # harness takes slots (≤2 per worker), isolated containers [U1]
corepack pnpm bds up --name <me>-dbg; node examples/<x>.js   # manual debugging; `bds cmd`, `bds logs`, `bds down` [U1]
```

**Before U1 merges (U0/U2/U3 only)** — one manual container per unit, fixed ports (U0 40100, U2 40110,
U3 40120):

```sh
mkdir -p ~/.cache/bedboo/manual-<unit> && docker run -d --name bds-<unit> --network host \
  -v ~/.cache/bedboo/manual-<unit>:/data -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet \
  -e ENABLE_LAN_VISIBILITY=false -e ONLINE_MODE=false -e ALLOW_LIST=false -e ALLOW_CHEATS=true \
  -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator -e LEVEL_TYPE=FLAT -e PLAYER_IDLE_TIMEOUT=0 \
  -e SERVER_PORT=<P> -e SERVER_PORT_V6=<P+1> itzg/minecraft-bedrock-server:2026.10.1
BDS_HOST=127.0.0.1 BDS_PORT=<P> BDS_CONTAINER=bds-<unit> corepack pnpm test:e2e -- --grep smoke
docker rm -f bds-<unit>                         # when done — only your own container
```

Console commands for that container: `docker exec bds-<unit> send-command …` does **not** work on this
host; use `@bedboo/bds/lib/docker` `sendCommand(container, cmd)` (see `docs/testing.md`).

**Worker gate:** own suites pass 3/3 (deterministic) or ≥ 4/5 (random: mobs, agent, fishing, trading; log
failure reasons) + the smoke subset (`--grep smoke`) once. Full regression only at the coordinator's wave
gate. Ported tests: keep mineflayer test names (`test/external/<name>.test.js`), record verbatim vs adapted in
your parity fragment.

## Workflow and merge loop

0. `git fetch origin && git checkout -B bedboo/<unit-slug> origin/main`. Read this file, `docs/testing.md`,
   `docs/upstream/` and the upstream mineflayer plugin(s)/tests you port; keep identical API/event semantics.
   Only edit files/patches your unit owns; minimal hooks elsewhere must be listed in the PR body. Write your
   `docs/parity/<unit>.md` and `docs/differences/<unit>.md` fragments. Stop only the containers you started.
1. Code review (`code-review` skill) → fix findings.
2. `corepack pnpm lint && corepack pnpm test` (+ `typecheck` if typings changed).
3. E2E per the recipe above.
4. Commit, push, `gh pr create` (descriptive title; PR body lists edits outside your ownership).
5. **Merge loop** (the user requires continuous sync to `main`) — repeat until merged:
   ```sh
   git fetch origin && git rebase origin/main
   # lockfile conflict: git checkout origin/main -- pnpm-lock.yaml && corepack pnpm install && git add pnpm-lock.yaml && git rebase --continue
   corepack pnpm lint && corepack pnpm test        # + smoke e2e
   git push --force-with-lease
   gh pr merge <n> --squash --repo LiteLDev/bedboo --match-head-commit $(git rev-parse HEAD)
   ```
   then `git push origin --delete bedboo/<unit-slug>`.
6. Report: end with `PR: <url>`.
