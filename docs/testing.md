# Testing against Bedrock Dedicated Server

Owner: U1 (wave 1). U0 seeded it with the transport spike results, which are kept below.

- [Quick start](#quick-start)
- [How the harness works](#how-the-harness-works)
- [`@bedboo/bds` API](#bedboobds-api)
- [`bds` CLI](#bds-cli)
- [Writing e2e tests](#writing-e2e-tests-testexternal)
- [`bot.test.*` helpers](#bottest-helpers)
- [Environment variables](#environment-variables)
- [Troubleshooting](#troubleshooting)
- [BDS 1.26.51.1 quirks](#bds-126511-quirks-seen)
- [Transport spike (U0)](#transport-spike-u0-2026-10-18--result-raknet-works)
- [NetherNet (U16b)](#nethernet-u16b)
- [Real-client e2e (bedd)](#real-client-e2e-bedd)
- [Fixtures](#fixtures)
- [Manual docker recipe](#manual-docker-recipe-no-harness)

## Quick start

```sh
corepack pnpm bds pull                          # once per host: image + golden BDS 1.26.51.1 cache (idempotent)
corepack pnpm test:e2e -- --grep smoke          # harness smoke + raw transport smoke
corepack pnpm test:e2e -- --grep "<suite>"      # your suite; each test file gets its own isolated BDS
corepack pnpm bds up --name me-dbg              # persistent debug server, prints BDS_HOST/BDS_PORT/BDS_CONTAINER
corepack pnpm bds cmd me-dbg list               # console command + its output
corepack pnpm bds logs me-dbg -f
corepack pnpm bds down me-dbg
```

Every container, data dir and slot the harness creates is removed when the test process exits (also on
Ctrl-C / SIGTERM). Containers of crashed or killed processes are reaped by the next harness run or by
`bds clean`.

## How the harness works

**Golden cache** (`bds pull`). The official `bedrock-server-1.26.51.1.zip` is downloaded once (with
`curl`, so `HTTPS_PROXY` works) to `~/.cache/bedboo/downloads/`, verified against its pinned size
(94 926 669 bytes) and sha256 (`ad91d3b8…e2d860`, cross-checked with the server's Content-MD5), and
extracted to `~/.cache/bedboo/bds/1.26.51.1/`. The binary is renamed `bedrock_server-1.26.51.1` (what the
image's `VERSION=EXISTING` looks for) and made read-only. The image is pinned by tag and digest:
`itzg/minecraft-bedrock-server:2026.10.1@sha256:6ff3abf6…c4f9`. `pull` does nothing when both are
present; a half-finished extraction never replaces a good golden dir.

**Instances.** `startServer()` creates `~/.cache/bedboo/instances/<container>/data` owned by the host user:
the 245 MB binary is hardlinked from the golden cache, the rest (~75 MB of packs/definitions) copied
(~0.5 s), `server.properties` written by the harness. The container (`docker create -i`, host network,
`VERSION=EXISTING`, `SERVER_PORT(_V6)`, labels below) mounts it as `/data`; itzg's
`entrypoint-demoter --match /data` runs BDS as the dir's owner, so every file can be removed without
sudo. A fresh flat world starts in ≈1 s and never touches the network.

**Slots.** At most `BEDBOO_MAX_SERVERS` (6) harness servers run on the host. Slot *n* uses ports
**41000 + 2n** (IPv4) and **41000 + 2n + 1** (IPv6) — 41000–41011 by default; the pre-harness manual
ports 40100–40121 never collide. The registry is `~/.cache/bedboo/slots/<n>.lock` (JSON: slot, token,
pid + process start time + boot id, host, owner = git worktree, container, persistent, ports,
createdAt), created with `O_EXCL` inside a short synchronous section holding the registry mutex
`slots/registry.lock` (also `O_EXCL`; a mutex left by a dead process is stolen with an atomic rename,
one stealer at a time under `slots/registry.lock.steal`, which re-checks the holder; docker is never
queried while it is held). A lock is live while its process runs, and after that while the container it
names still exists — a crashed owner's BDS keeps binding the slot's ports until the reaper removes it
(`bds up` locks: while the container exists); other locks are replaced. Each worker (owner key = the git
worktree, or `BEDBOO_OWNER`) may hold at most `BEDBOO_WORKER_SLOTS` (2) test slots of running processes;
persistent `bds up` servers count only against `BEDBOO_MAX_SERVERS`. When nothing is
free, `startServer()` queues (polling ~1 s, reaping dead owners every 10 s) for up to
`BEDBOO_SLOT_TIMEOUT` (15 min), printing who holds the slots every minute; the timeout error lists them
too. If BDS reports its port in use, the harness reaps dead owners' containers and retries the slot once
if the port can be bound now; otherwise (something outside the harness) it moves to another slot.

**Containers** are named `bedboo-<name>` (default `bedboo-<worktree>-<pid>-<n>`) and labelled
`bedboo.managed=1`, `bedboo.owner` (worktree), `bedboo.pid` / `bedboo.pidstart` / `bedboo.boot` /
`bedboo.host` (owner process identity), `bedboo.slot`, `bedboo.dir`, `bedboo.persistent`, `bedboo.name`.
The **reaper** (run by every `startServer()` — one run shared by concurrent starts of a process —, after
a port-in-use failure, every 10 s while queueing, and by `bds clean`)
removes containers, instance dirs and slot locks whose owner process is gone (pid reuse is detected by the
start time), plus orphan instance dirs. Persistent (`bds up`) servers are never reaped. `bds clean`
removes only this worktree's containers unless `--all` is given.

**Console.** Harness-started servers are started with `docker start -a -i` in their own process group:
one long-lived child carries the server's stdin and stdout, attached before BDS starts, so no line is
lost and Ctrl-C in the terminal reaches only the test process (whose exit handler removes the container).
Every output line gets a sequence number. `awaitCommandsProcessed()` writes a unique unknown command
(`bedboo_marker_<hex>`) and waits for BDS's `Unknown command: bedboo_marker_<hex>` — commands run in
order on the server thread and print their output before the next one runs, so everything written
before has executed. `commandOutput(cmd)` uses this to return exactly the lines a command printed
(command, then marker; `[]` for silent commands such as `say`); the helpers check those lines for the
success message and fail fast with the whole output otherwise. `commandWithOutput(cmd, matcher)` waits
for the first matching line printed after the command. Output-reading calls are serialized;
`command(cmd)` only writes. For containers not started by this process (BDS_CONTAINER, `bds up`, the
CLI) the console is `docker exec` (write to the server's stdin as the server's uid, see quirks) plus a
`docker logs -f --since <first use>` child (`waitForLog` with an older `since` asks docker directly).
Startup is ready at `Server started.`; unexpected ERROR lines before it are collected in
`server.startupErrors` (the RakNet `TRANSPORT TYPE ERROR` block after it is harmless);
`Port [n] may be in use by another process` and a container exit fail fast (the last 40 log lines are
in the error).

**server.properties.** Precedence (lowest first): BDS template < harness defaults (`gamemode=creative`,
`difficulty=peaceful`, `level-type=FLAT`, `level-name=bedboo`, `allow-cheats=true`,
`default-player-permission-level=operator`, `view-distance=32`, `tick-distance=4`, `max-threads=4`,
`max-players=10`) < `startServer` options < `properties` overrides < enforced keys. **Enforced** (an
override with another value throws): `enable-lan-visibility=false` (otherwise every server also binds
19132/19133), `transport=raknet` (unless the `transport: 'nethernet'` option asks for NetherNet, see
[NetherNet](#nethernet-u16b)), `online-mode=false`, `allow-list=false`, `player-idle-timeout=0`, and
`server-port`/`server-portv6` from the slot.

**Profiles.** Right after `Server started.` (before any player joins) the profile's gamerules are applied
through the console, each answer verified. `deterministic` (default): `domobspawning false`,
`dodaylightcycle false`, `doweathercycle false`, `randomtickspeed 0`, `doinsomnia false`,
`dofiretick false`, `mobgriefing false`, `spawnradius 0` (+ `difficulty=peaceful` from the properties).
`none`: nothing. Suites opt in to randomness with `profile: 'none'`, `gamerules: { domobspawning: true }`
or `difficulty: 'normal'`. With the deterministic profile a fresh flat world has no entities at join.

**Snapshots.** `server.snapshot(name)` stops BDS gracefully (it saves everything on `stop`), copies
`worlds/<level>` to `~/.cache/bedboo/snapshots/<name>/world` (+ `meta.json`: level name/type, seed,
gamemode, difficulty, source, file count) and starts the server again — **connected bots are
disconnected** and must rejoin. `server.restore(name)` stops the server, replaces the world and starts it
again; `startServer({ snapshot: name })` starts a new server from it. Gamerules live in `level.dat`, so
they come with the snapshot (`startServer` still applies its profile unless `profile: 'none'`).
Snapshots are host-wide (Wave 6 milestone scenarios); delete them with `bds snapshots --delete <name>`.
The online backup protocol (`save hold`/`save query`/`save resume`) is deliberately not used — see quirks.

## `@bedboo/bds` API

```js
const bds = require('@bedboo/bds')
const server = await bds.startServer({ world: 'flat', gamemode: 'creative' })
```

`startServer(opts) → Promise<BdsServer>` — `BDS_HOST`/`BDS_PORT` set: returns that server instead
(`external: true`; the profile is applied when `BDS_CONTAINER` is set unless `profile: 'none'`).

| option | default | meaning |
|---|---|---|
| `name` | `<worktree>-<pid>-<n>` | container `bedboo-<name>` |
| `world` | `'flat'` | `'flat'` / `'default'` (`seed` implies `default`) |
| `seed` | — | `level-seed` |
| `snapshot` | — | start from a snapshot |
| `gamemode` | `'creative'` | `survival` / `creative` / `adventure` |
| `difficulty` | `'peaceful'` | `peaceful` / `easy` / `normal` / `hard` |
| `levelName` | `'bedboo'` | `level-name` |
| `properties` | `{}` | raw server.properties overrides (enforced keys excepted) |
| `transport` | `'raknet'` | `'nethernet'`: BDS's default transport, for `createBot({ transport: 'nethernet' })` (U16b; [NetherNet](#nethernet-u16b)) |
| `profile` | `'deterministic'` | gamerule profile, `'none'` for vanilla rules |
| `gamerules` | `{}` | gamerule overrides on top of the profile, e.g. `{ domobspawning: true }` |
| `persistent` | `false` | survives this process (`bds up`); never reaped |
| `slotTimeout` | `BEDBOO_SLOT_TIMEOUT` | ms to queue for a slot |
| `startTimeout` | 120000 | ms to wait for `Server started.` |
| `useExternal` | `true` | honour `BDS_HOST`/`BDS_PORT` |
| `log` | `console.error` | queue / reaper messages |

`BdsServer`: `host`, `port`, `portV6`, `container`, `slot`, `external`, `persistent`, `dataDir`,
`levelName`, `properties`, `gamerules`, `startupErrors`, `snapshotName`, `console` (lib/console.js) and

| method | |
|---|---|
| `command(cmd) → Promise<Date>` | write a console command (no `/`); resolves once written with the send time (U0 contract, pass it to `waitForLog`) |
| `commandOutput(cmd, { timeout }) → Promise<string[]>` | write the command + a console marker; resolve with every message (log prefix stripped) printed in between (`[]` for silent commands); serialized |
| `commandWithOutput(cmd, matcher, { timeout }) → Promise<string>` | write and resolve with the first output message matching `matcher` (substring, RegExp or `(message, line) => bool`); serialized |
| `waitForLog(re, { since, timeout }) → Promise<string>` | first raw log line matching `re` printed at/after `since` (Date, default now) |
| `awaitCommandsProcessed()` | console marker (see above) |
| `logs(n)` | last `n` raw console lines |
| `snapshot(name, { overwrite, description })` | graceful stop → copy world → start; resolves with the snapshot meta |
| `restore(name)` | stop → replace world → start |
| `restart()` | graceful stop + start |
| `stop()` | remove container, instance dir and slot (external: only detach) |
| `detach()` | stop following the console, leave the server running |

Other exports: `createTestBot({ server?, serverOptions?, createBot, username?, botOptions?, onCreate?,
waitForSpawn?, timeout? }) → { bot, server, stop }` (generic; the e2e suites use the wrapper in
`test/external/common`), `attachServer(name)` (handle for an existing container, exec console),
`downServer(name)` (`bds down`), `externalServer(env)`, `pull({ force })`, `reap()`, `clean({ all })`, `listSlots()`, `listSnapshots()`,
`readSnapshot(name)`, `deleteSnapshot(name)`, `Console`, `config`, `properties`, `profiles`, `docker`
(`sendCommand(container, cmd)`, `waitForLog(container, re, { since })` — the U0 helpers).

## `bds` CLI

`corepack pnpm bds <command>` (`pnpm bds -- <command>` works too):

| command | |
|---|---|
| `pull [--force]` | image + golden cache (idempotent) |
| `up [--name n] [--world flat\|default] [--seed s] [--gamemode m] [--difficulty d] [--profile p] [--gamerule k=v]… [--property k=v]… [--snapshot s] [--transport raknet\|nethernet]` | persistent server; prints `BDS_HOST=… BDS_PORT=… BDS_CONTAINER=…` (default name `<user>-dbg`) |
| `cmd <n> <command…>` | run a console command, print its output (everything up to a console marker) |
| `logs <n> [-f] [--tail k]` | `docker logs` |
| `down <n>…` | remove container, data dir and slot (also when the container was already removed with `docker rm`) |
| `ls` | slots (holder, pid/persistent, owner, stale) and harness containers |
| `snapshot <n> <s> [--overwrite]` / `restore <n> <s>` | as the API (restarts `<n>`; meant for `bds up` servers) |
| `snapshots [--delete s]` | list / delete snapshots |
| `clean [--all]` | reap dead owners, remove this worktree's containers (`--all`: every bedboo container on the host — other workers' too!) and stale locks |

`<n>` is the name given to `up` (container `bedboo-<n>`) or the container name.

## Writing e2e tests (`test/external/`)

`corepack pnpm test:e2e [-- mocha args]` runs `packages/mineflayer-bedrock/test/external/**/*.test.js`
(`.mocharc.e2e.json`, 120 s per test) through `scripts/run-e2e.js`, which forwards SIGINT/SIGTERM to
mocha and refuses to start without the golden cache (unless `BDS_HOST`/`BDS_PORT` is set). Test files are
run serially; each starts its own server (two files' servers never overlap, so a worker uses ≤ 2 slots).

```js
const { useBot } = require('./common')
describe('heldItem', function () {
  const ctx = useBot({ server: { gamemode: 'creative' } })   // before: server + bot; after: cleanup
  beforeEach(() => ctx.bot.test.resetState())                // like upstream's runner
  it('works', async () => {
    const { bot } = ctx
    await bot.test.setInventorySlot(36, new (require('prismarine-item')(bot.registry))(1, 1))
  })
})
```

`test/external/common` (`require('./common')`):

| export | |
|---|---|
| `useBot({ server, raw, username, botOptions, autoRespawn, timeout })` | mocha `before`/`after`: `startServer(server)` + `createTestBot`; returns `{ bot, server, ctx }` filled in by `before` |
| `useServer(serverOptions)` | mocha hooks for a server only (raw clients, console) |
| `createTestBot({ server?, serverOptions?, raw?, username?, botOptions?, autoRespawn?, timeout? })` | `mineflayer-bedrock`'s `createBot` (or a `RawBot` with `raw: true`) + `bot.test` installed synchronously + wait for spawn → `{ bot, server, ctx, stop }` |
| `createRawBot({ host, port, username })` | `RawBot`: raw bedrock-protocol client (lib/client.js defaults) with `_client`, `username`, `end()`, `quit()`, events `spawn`/`end` |
| `inject(bot, server, { autoRespawn })` | install `bot.test` (upstream `commonTest(bot, wrap)`); returns the helper context |
| `startServer`, `bds`, `implemented(fn)`, `helperFiles()` | |

Helpers are installed from `common/helpers/*.js`: `base`, `world`, `inventory`, `entities` first, then
every other file alphabetically. Each exports `install(bot, ctx)` and may replace or wrap helpers installed
before it — that is how later units upgrade them in their own files (U6 `chat.js`, U7 `entities.js`, U8
`inventory.js`, U11 `place.js`). The context (`bot.test.ctx`) offers: `server`, `state` (packet tracker:
`runtimeId`, `uniqueId`, feet `position`, `gameMode`, `dimension`, `alive`, `spawned`, raw `inventory`
windows with item names, `entities`, `worldDirty`, `events`), `packet(name|names, predicate, timeout) →
{ promise, cancel }` (arm before triggering), `event(name, predicate, timeout)`, `consoleOutput(cmd)`,
`consoleExpect(cmd, okRegExp)` (throws with the whole output unless a line matches), `botCommand(cmd)` (raw
`command_request` → `command_output`, correlated by origin uuid), `chat(msg)` (bot.chat when implemented,
else a raw `text` packet), `position()`, `username()`, `who()`, `inDimension()`, `raw` flags.

**Raw client behaviour.** Helpers must work while plugins are stubs, so `inject` adds what the client
side would do if the bot does not (yet): the join handshake when `bot._bedrock.lifecycle.markSpawned` is
a stub (answer `respawn` state 1 with state 2; after `play_status player_spawn` send
`serverbound_loading_screen` 1 and 2 — without them BDS does not simulate the player), and the respawn
handshake when `bot.respawn` is a stub (`autoRespawn`, default on): after `entity_event death_animation`
+ `respawn` state 0 → client `respawn` state 2 → server `respawn` state 0 + state 1 → client
`player_action respawn` → server `entity_event respawn` + `set_health 20`. Once U4/U9 implement those,
the harness steps back automatically.

## `bot.test.*` helpers

All 20 members of upstream `testCommon.js` plus Bedrock extras. Same names, signatures and semantics;
transport = BDS console + raw packets. `<bot>` is the bot's (quoted) name; `X Y Z` are absolute
coordinates; "in dim" = prefixed with `execute in <bot's dimension> run`.

| helper | Bedrock console command | completes on (raw packet / console) |
|---|---|---|
| `groundY` | — | `-60` (flat world: bedrock -64, dirt -63/-62, grass -61) |
| `port`, `host`, `server`, `ctx` | — | server handle / helper context |
| `wait(ms)` | — | timer |
| `dumpMarker(msg)` | — | logs when `BEDBOO_TRACE` is set |
| `sayEverywhere(msg)` | bot chat (`bot.chat` or raw `text`); `/…` → the bot's own `command_request` | sent (`/…`: its `command_output`); also `console.log` |
| `awaitCommandsProcessed()` *(extra)* | unknown-command marker | `Unknown command: bedboo_marker_…` |
| `becomeCreative()` / `becomeSurvival()` | `gamemode creative\|survival <bot>` | `Set <bot>'s game mode to …` + `update_player_game_type` (skipped when already in that mode) |
| `setGameMode(mode)` *(extra)* | same | same |
| `teleport(pos)` | `execute in overworld run tp <bot> X Y Z` | `Teleported …` + own `move_player` within 0.9 of `pos` |
| `fly(delta)` | in dim `tp <bot> X Y Z` (position + delta) | own `move_player` (creative flight itself is U5's) |
| `setBlock({ x, y, z, relative, blockName })` | in dim `setblock X Y Z <blockName>` (`relative`: offset from the floored bot position) | `Block placed` + `update_block`/`update_subchunk_blocks` at the position; `The block couldn't be placed` (already that block) resolves at once |
| `placeBlock(slot, pos)` | upstream: `setQuickBarSlot(slot - 36)` + `bot.placeBlock(<block below pos>, up)` (helpers/place.js, U11); raw bots: `execute as <bot> at @s run setblock X Y Z <item in slot>` | `blockPlaced` (the item is used in survival) / raw: `Block placed` + block update (item not consumed) |
| `resetBlocksToSuperflat()` *(extra)* | in dim `fill` 11×11 around the bot: grass at groundY-1, air groundY…groundY+4 | console marker |
| `setInventorySlot(slot, item)` | `replaceitem entity <bot> slot.hotbar\|slot.inventory\|slot.armor.*\|slot.weapon.offhand <i> <name> <count> <data>` (`null` → `air`; data = metadata, or a tool's `Damage`; any other NBT throws `NBT cannot be set with replaceitem`) | `Replaced …` + `inventory_content`/`inventory_slot` of that window |
| `clearInventory()` | `clear <bot>` | `Cleared the inventory…`/`Could not clear…` + `inventory_content` |
| `give(name, count, metadata)` *(extra)* | `give <bot> <name> <count> <metadata>` | `Gave …` + inventory update |
| `awaitItemReceived(command)` | `command` sent **by the bot** (raw `command_request`) | `command_output` success + next inventory update |
| `resetState()` | the above | creative, at (0, groundY, 0) (teleport if ≥ 0.9 away; `waitForChunksToLoad` when implemented), superflat restored when any block update was seen since the last reset, inventory cleared when not empty; `creative.startFlying()` when implemented |
| `selfKill()` | `kill <bot>` (switches to survival first: Bedrock refuses to kill creative players) | `Killed <bot>` + own `entity_event death_animation` |
| `awaitRespawn(timeout)` *(extra)* | — | `set_health > 0` / `entity_event respawn` |
| `killEntity(entity)` | in dim `kill @e[type=<entity.name>]` | `remove_entity` with the entity's unique id |
| `summon(type, pos)` *(extra)* | in dim `summon <type> X Y Z` | `add_entity` of that type near `pos` → `bot.entities[id]` or `{ id, runtimeId, uniqueId, type, name, position }` |
| `tellAndListen(to, what, listen)` | bot chat (`bot.chat` or raw `text`) | `[to, message]` of the first `text` chat from `to` (`§` codes stripped) with `listen(message)` truthy, 5 s |
| `runExample(file, run)` / `abortRunningExample()` | `tp <child> 50 -60 0` (retried until the child is targetable), `querytarget` until it arrived | child joins (`player_list`), bot says `loaded`, child says `Ready!`, then `run(childName)`; the child is killed afterwards |
| `command`, `commandWithOutput`, `botCommand` *(extra)* | console / raw command | as the server methods / `command_output` |
| `rawInventory()`, `rawEntities()` *(extra)* | — | tracker state |

## Environment variables

| variable | default | |
|---|---|---|
| `BDS_HOST`, `BDS_PORT`, `BDS_CONTAINER` | — | use an already-running server instead of starting one |
| `BEDBOO_CACHE` | `${XDG_CACHE_HOME:-~/.cache}/bedboo` | golden cache, instances, slots, snapshots |
| `BEDBOO_MAX_SERVERS` | 6 | host-wide slot count (keep it equal across workers) |
| `BEDBOO_WORKER_SLOTS` | 2 | slots per worker (owner key) |
| `BEDBOO_OWNER` | git worktree of the cwd | owner key for the worker cap and `bds clean` |
| `BEDBOO_PORT_BASE` | 41000 | slot n → ports base + 2n, base + 2n + 1 |
| `BEDBOO_SLOT_TIMEOUT` | 900000 | ms to queue for a slot |
| `BEDBOO_BDS_LOG` | — | `1`: echo every console line to stderr |
| `BEDBOO_TRACE` | — | `1`: `bot.test.dumpMarker` logs |
| `BEDBOO_STRESS`, `BEDBOO_STRESS_SERVERS` | — | enable `stress.test.js` (N parallel servers) |
| `BEDBOO_NETHERNET` | — | `1`: run `nethernet.test.js` without `--grep nethernet` (U16b) |
| `BEDBOO_COMBAT_RUNS` | 1 | fights per mob in `combatMatrix.test.js` (gate: `5`, a row needs ⌈0.8·runs⌉ wins; 1 = one fight + one retry) |
| `BEDBOO_COMBAT_REPORT` | — | file the combat matrix appends every fight to (JSON lines) |

## Troubleshooting

- **`golden BDS cache missing`** — run `corepack pnpm bds pull`. A checksum mismatch deletes the bad zip;
  re-run `pull` (check the proxy if it keeps failing).
- **Waiting for a slot** — `corepack pnpm bds ls` shows who holds them. Stale entries (owner dead) are
  replaced automatically; leftovers of your own worktree: `corepack pnpm bds clean`. Never run
  `clean --all` while other workers are testing.
- **`Port [41000] may be in use by another process`** — something outside the harness uses the port; the
  harness moves to another slot. Find it with `ss -ulpn | grep 410`.
- **Server does not start** — the error carries the container state and the last 40 log lines;
  `BEDBOO_BDS_LOG=1` echoes the whole console.
- **A helper times out** — it waits for a raw packet the server only sends to clients that have the chunk
  loaded (block updates) or can see the entity; run with `BEDBOO_BDS_LOG=1` to see the console answer.
  `Cannot place block outside of the world` means no player has that chunk loaded.
- **Leftover containers after a crash** — the next `startServer()` reaps them; or `corepack pnpm bds clean`.
- **arm64 hosts** — no RakNet backend (see the spike below).

## BDS 1.26.51.1 quirks seen

- **Readiness line:** `[… INFO] Server started.` followed by a multi-line `TRANSPORT TYPE ERROR` block when
  `transport=raknet` ("Your current connection type is not set to NetherNet … Players will not be able to
  connect"). It is harmless — RakNet clients connect fine — and whitelisted. BDS also logs
  `Signed in to signaling service successfully`. A fresh flat world is ready ≈1 s after the container starts.
- **Ports:** itzg's entrypoint rewrites `server-port`/`server-portv6` from `SERVER_PORT`/`SERVER_PORT_V6`
  (image defaults 19132/19133!), so the harness passes them. A busy port prints
  `ERROR] Port [41000] may be in use by another process. Free up port and re-run program …`, then
  `Exiting program` and a crash dump; the container exits with code 1 within a second.
- **First start downloads BDS** unless `/data` already contains `bedrock_server-<version>` and
  `VERSION=EXISTING` is set (the harness does this).
- **Console input:** the image's `docker exec <c> send-command …` fails on this host with
  `find: '/proc/1/exe': Permission denied … ERROR: failed to search for bedrock server process`: it runs as
  root without `CAP_SYS_PTRACE` and cannot readlink the uid-1000 server's `/proc/<pid>/exe`. Working
  approach (`@bedboo/bds/lib/docker.sendCommand`): exec as the server's uid:gid (owner of `/data`) and
  write the command to the server process's `/proc/<pid>/fd/0`. `docker create -i` sets `StdinOnce`, so
  when the first attached client (`docker start -a -i`) goes away the container's stdin is closed for good
  (BDS keeps running; `sendCommand` still works because it writes to BDS's own stdin pipe).
- **Console output:** `say`/`tellraw` print nothing; command errors are `ERROR` lines (`Unknown command:
  <cmd>. Please check that the command exists …`, `No targets matched selector`, `Syntax error: …`);
  `list` prints `There are n/max players online:` plus a line of names; `querytarget` prints a JSON block
  (eye-level `y`); `gamerule` (no args) prints all rules in one line (`doMobSpawning = false, …`);
  `testforblock` → `Successfully found the block at x,y,z.` / `The block at x,y,z is Air (expected: …)`.
- **Commands vs. chunks:** with no player nearby, chunks are not loaded: `setblock`/`testforblock` answer
  `Cannot place block outside of the world`.
- **Gamemode:** `gamemode <m> <player>` → `update_player_game_type { gamemode, player_unique_id }` (not
  `set_player_game_type`); nothing is sent when the player already has that mode (the console still says
  `Set <p>'s game mode to …`). `start_game.player_gamemode` is `fallback` → use `world_gamemode`.
  Gamemode commands do not reach dead players (`No targets matched selector`).
- **Killing players:** creative players cannot be killed (`Players cannot be killed while they are in
  Creative mode.`), not even by `/damage … void` or by standing at y = -200. Death sequence: own
  `entity_event death_animation`, `death_info`, `text` (`death.attack.generic`), `respawn` state 0 at the
  death position. Respawn: client `respawn` state 2 (a state 2 sent before the server's state 0 is
  ignored) → server `respawn` state 0 (`y 32767`) + state 1 (eye-level spawn) → client `player_action
  respawn` → `entity_event respawn` + `set_health 20`. With `spawnradius 0` the respawn point is exactly
  (0, -60, 0) (the first join spawns at (0.5, -60, 0.5)).
- **Teleport:** `tp <p> 10 -60 10` centers integer x/z (`Teleported p to 10.50, -60.00, 10.50`) →
  `move_player { mode: 'teleport', teleport: { cause: 'command' } }` at eye level.
- **Blocks:** `setblock` → `Block placed` + `update_block` (flags neighbors+network); the same block again →
  `The block couldn't be placed` and no packet.
- **Inventory:** `/give`, `/replaceitem` (hotbar/inventory), `/clear` (even when nothing is cleared) →
  `inventory_content` of every window (inventory 36, armor 5, ui 54, offhand 1); armor `replaceitem` →
  `inventory_slot` (armor); off-hand `replaceitem` → `inventory_content` (offhand); `/give` also sends an
  `inventory_transaction`. Player items carry `stack_id`s (server-authoritative inventory).
- **Falling blocks:** a block starting to fall and a falling block landing come as `update_block_synced` only
  (`transition_type` `create`: the block → air, then `add_entity minecraft:falling_block`; `destroy`: the landed block,
  then `remove_entity`), never as `update_block` (POLISH-LIB, docs/differences/U4.md#falling-blocks).
- **Inventory resend:** a client `inventory_transaction { transaction_type: 'inventory_mismatch' }` makes BDS resend
  the player's inventory (`inventory_content` × 4 + `player_hotbar`); a rejected item stack request or reopening the
  inventory screen resends nothing; `clear <player> <item> -1 0` prints `<player> has <n> items that match the
  criteria` without clearing (POLISH-LIB, docs/differences/U8.md#inventory-resync).
- **Entities:** `summon` → `Object successfully summoned` + `add_entity` (feet position, centered);
  `kill @e[type=pig]` → `Killed Pig`, `entity_event death_animation`, drops (`add_item_entity`), then
  `remove_entity { entity_id_self: <unique id> }`.
- **Commands from the client:** `command_request { command: '/time set 1000', origin: { type: 'player',
  uuid, request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' }` → `command_output`
  whose origin echoes the **uuid** (not `request_id`), plus an `event { event_type: 'command_executed' }`.
- **Chat:** a client `text` chat (`type: 'chat'`, `category: 'authored'`) is echoed to everyone with
  `source_name: '<name>§r'`. `player_list` arrives as `records: [{ type: 'add', username, … }]`, before the
  player is spawned/targetable.
- **Saving:** modified chunks reach LevelDB only every ≈5–10 s (writes observed at 5 s ticks, a change
  waited up to ~8 s), and `save hold` does **not** flush them: `save query` lists the files as they are, so
  an online backup silently misses recent changes. A graceful stop saves everything — snapshots use it.
- **Join sequence:** `start_game.player_position` = `(0.5, 32769.62, 0.5)` (spawn search height), then
  three `respawn` packets: state 0 at 32769.62, state 0 at 32768, state 1 at the real eye-level spawn
  `(0.5, -58.38, 0.5)` on the flat world (feet y = -60 = `groundY`). Answer state 1 with
  `respawn { state: 2, runtime_entity_id }` (vanilla client_ready). Then chunks, `play_status player_spawn`
  (bedrock-protocol sends `set_local_player_as_initialized` and emits `spawn`).
- **Loading screen gate:** after spawning, BDS does **not simulate the player** — `player_auth_input`
  positions and move vectors are ignored (server-side position unchanged per `querytarget`, no
  `correct_player_move_prediction`) — until the client sends `serverbound_loading_screen { type: 1 }` and
  `{ type: 2 }`. After that, walking inputs move the player and impossible moves are corrected.
- **Movement:** `start_game.rewind_history_size = 40`, `server_authoritative_block_breaking = true`,
  `server_authoritative_inventory = true`, `block_network_ids_are_hashes = true`. Default
  `server.properties`: `server-authoritative-movement-strict=false`, `player-position-acceptance-threshold=0.5`.
  Standing still in the air after a teleport produced 3 corrections while falling back to the ground.
- **Chunks:** `level_chunk` always arrives in sub-chunk request mode — `sub_chunk_count: 0` with
  `highest_subchunk_count` present (1 on the flat world) — never with inline sub-chunks.
  `subchunk_request { dimension, origin: { x: cx, y: 0, z: cz }, requests: [{ x: 0, y: -4..19, z: 0 }] }`
  returns one `subchunk` with an entry per request (`success` with payload, or `success_all_air`).
  `network_chunk_publisher_update` radius 64 → 160 blocks after `request_chunk_radius 10`.
- **Time:** there is **no `set_time` packet** — not even for `/time set` — time is carried by
  `sync_world_clocks` (sent before `start_game` and on changes).
- **Mobs:** the flat world spawns passive mobs (horses, pigs, …) continuously without the deterministic
  profile: hundreds of `move_entity_delta` per minute. With it, no entity exists at join.

## Transport spike (U0, 2026-10-18) — RESULT: RakNet works

Host: WSL2 kernel 6.18, Docker 29 (native dockerd, host networking), Node 24.22, pnpm 12.14.0.
Server: `itzg/minecraft-bedrock-server:2026.10.1`, BDS **1.26.51.1** (build 51061372, branch r/26_u5),
`transport=raknet`, `online-mode=false`, flat world.

| Client transport / backend | Result |
|---|---|
| bedrock-protocol 3.60.1, `transport: 'raknet'`, `raknetBackend: 'raknet-native'` (patched) | **works**: join ≈0.3 s, `start_game` ≈0.5 s, `spawn` ≈1.0 s, `level_chunk` + `subchunk`, stable 25 s sessions with a 50 ms `player_auth_input` loop |
| `raknetBackend: 'raknet-native'` unpatched | fails to load: binding looks for `prebuilds/linux-6-x64` (kernel major 6), only `linux-5-x64` ships, falls back to a cmake build (no toolchain) |
| `raknetBackend: 'jsp-raknet'` | **fails**: BDS answers the open-connection request with `ID_INCOMPATIBLE_PROTOCOL_VERSION` (0x19, server RakNet protocol 11; jsp-raknet speaks 10) and the client retries until timeout |
| NetherNet | **works** (U16b, see [NetherNet](#nethernet-u16b)): `createBot({ transport: 'nethernet' })` with HTTP signalling on the server port; join ≈1.7 s, spawn ≈2.6 s. RakNet stays the default |
| Unconnected ping (`bedrock.ping`, discovery without `skipPing`) | **no reply** with `enable-lan-visibility=false` → discovery waits 1 s then falls back to configured defaults. `lib/client.js` therefore defaults to `skipPing: true` |

Limitation: raknet-native 1.2.3 bundles x64 prebuilds only (`linux-5-x64`, `darwin-21-x64`,
`win32-10-x64`) and its cmake build is disabled, so arm64 hosts (Apple Silicon, linux-arm64) currently
have no working RakNet backend (jsp-raknet is rejected by BDS). Our dev/CI hosts are x64.

The raknet-native fix is `patches/raknet-native@1.2.3.patch`: `binding.js` also tries
`helpers/buildPath.getFallbackPath()` (any bundled prebuild for the platform+arch — upstream defines but
never calls it) before `bindings`, and resolves `build/Release` relative to the package instead of the
cwd. The prebuild needs glibc ≥ 2.34. Its install script (cmake build) is disabled via
`allowBuilds: { raknet-native: false }` in `pnpm-workspace.yaml`.

Re-run the spike: `corepack pnpm test:e2e -- --grep "raw bedrock-protocol transport"` (harness server),
or `node scripts/capture-fixtures.js --port <P> --container <c>` against a `bds up` server.

## NetherNet (U16b)

BDS 1.26.51's default transport is NetherNet (WebRTC data channels); RakNet still works with `transport=raknet` but
Mojang announced its removal (possibly in BDS 26.60). The library and the suite stay on RakNet by default — it is the
transport bedrock-protocol has supported for years and the one every suite was written against — and NetherNet is
opt-in:

- Client: `createBot({ transport: 'nethernet' })` joins with **HTTP signalling** on the server port
  (`POST http://host:port/v1/join/<network id>`), which works with `enable-lan-visibility=false`: bedrock-protocol#831
  and node-nethernet#32 (merged upstream, unreleased) are backported as `patches/bedrock-protocol@3.60.1.patch` and
  `patches/nethernet@1.1.2.patch`. See `docs/differences/U16-transport.md`.
- Server: `startServer({ transport: 'nethernet' })` / `bds up --transport nethernet`. LAN visibility stays off, so no
  exclusive slot is needed (HTTP signalling uses the slot's own port; nothing binds UDP 7551).
- Quirk: BDS opens its signalling listener on **TCP** `server-port` and logs `Accepting clients on [::]:<port>`; when
  that TCP port is still held (e.g. `TIME_WAIT` connections of the previous server on the slot, ~1 min) it runs
  without the listener and logs nothing — clients get `ECONNREFUSED`. The harness skips slots whose TCP port is held
  (`/proc/net/tcp`) and retries on another slot when the line is missing.
- Test: `test/external/nethernet.test.js` (join, spawn, chat both ways, a block update, walking, HTTP discovery,
  server-key pinning, quit) is tagged `nethernet` and kept out of the default run:
  `corepack pnpm test:e2e -- --grep nethernet` (or `BEDBOO_NETHERNET=1`). It needs a server the harness starts
  (skipped with `BDS_HOST`/`BDS_PORT`: an external server's transport is unknown).

## Real-client e2e (bedd)

`corepack pnpm test:e2e:bedd [-- mocha args]` (`scripts/run-e2e-bedd.js`, `packages/mineflayer-bedrock/.mocharc.bedd.json`)
runs `test/bedd/*.e2e.js` against a **real Minecraft Bedrock client** hosted by Be.D.D. through
`createBot({ transport: 'bedd' })` ([bedd.md](bedd.md)). It is opt-in: the suites only run on Windows with
`BEDBOO_BEDD_PIPE` set, in a build that has the `bedd` transport; anywhere else every suite is reported pending
(skipped), so the command is safe on Linux. The files are outside the unit glob (`test/unit/**`).

1. Start a BeDD game (`Start-BeDDGame.ps1 -Instance <name>`) whose `mods\BeDD\config\config.json` has `tap`,
   `gameHooks`, `allowSend`, `allowStack` and `pipeInstances` set (see [bedd.md](bedd.md#setup)).
2. Get the player into a throwaway world — the suites fill a 13×13 arena around the player, switch it to survival and
   change its inventory:
   - **BDS**: `corepack pnpm bds up --name bedd-e2e --gamemode survival --transport nethernet` (flat world, cheats
     on, everyone operator), then join `127.0.0.1:<port>` from the client (Play → Servers → Add server).
     `--transport nethernet` matters: the 1.26.51 client did not join a `transport=raknet` BDS. `BEDBOO_BEDD_START_BDS=1`
     makes the runner start (or reuse) that server and print the port. Where docker only runs inside WSL, run `bds up`
     from a WSL checkout of bedboo (Windows `pnpm bds` needs docker on the Windows PATH).
   - **Singleplayer / LAN host**: a new flat world with cheats on. There is no console: setup commands run as the
     player through `send` and every check uses the tapped state.
3. Run:

   ```powershell
   $env:BEDBOO_BEDD_PIPE = '\\.\pipe\BeDD-1.26.51.01-hi20'
   $env:BDS_CONTAINER = 'bedboo-bedd-e2e'                 # BDS world: console setup and server-side checks
   $env:BEDBOO_BEDD_DOCKER = 'wsl -d Debian -e docker'    # only when docker runs inside WSL, not on Windows
   corepack pnpm test:e2e:bedd
   ```

One bot is attached for the whole run and detached at the end; the client stays in its world. The runner probes
BeDD's ops (`bot.bedrock.bedd.caps` / `supports()`), and each scenario skips when the ops it needs are absent or
disabled:

| file | scenarios | caps | BDS-side check (console) |
|---|---|---|---|
| `01-core.e2e.js` | spawn and position · chat, `/say` and a command with `command_output` · unsupported API → `ERR_BEDD_UNSUPPORTED` · setup commands | `tap`, `send` | `querytarget` position; `tag <p> list` |
| `02-movement.e2e.js` | lookAt · walk 5 blocks with `setControlState` · pathfinder goal · `setQuickBarSlot` | `look`, `input`, `slot` | `querytarget` position / yRot; `testfor … hasitem mainhand` |
| `03-actions.e2e.js` | dig dirt in survival · place a block · open / close a chest · eat (golden apple) | `look`, `button` | `testforblock`; `clear <p> <item> 0 0` counts |
| `04-inventory.e2e.js` | craft planks (2×2) · deposit into a chest | `stack` | `clear <p> oak_planks 0 0` counts |

| variable | |
|---|---|
| `BEDBOO_BEDD_PIPE` | the client's control pipe (required) |
| `BEDBOO_BEDD_TAP_PIPE` | the tap pipe, when it is not `<pipe>-tap` |
| `BDS_CONTAINER` | the BDS container the client plays on: console setup and server-side checks |
| `BEDBOO_BEDD_DOCKER` | docker command prefix for that console, e.g. `wsl -d Debian -e docker` (default: `@bedboo/bds`'s docker) |
| `BEDBOO_BEDD_START_BDS` | `1`: start or reuse `bedboo-bedd-e2e` (`BEDBOO_BEDD_BDS_NAME`) with the harness; needs docker on PATH; waits for a player to join it (`BEDBOO_BEDD_JOIN_TIMEOUT`, 300000 ms) |
| `BEDBOO_BEDD_WORLD` | `remote` / `local`: override the world mode taken from the tap's HELLO link type |
| `BEDBOO_BEDD_SPAWN_TIMEOUT` | ms to wait for `spawn` after attaching (60000) |
| `BEDBOO_BEDD_DEBUG` | `1`: log the caps and why a scenario skipped |

Watch the game window while it runs (or take PrintWindow screenshots) to see the moves, digs and chat on the client.
Manual smoke: `node packages/mineflayer-bedrock/examples/bedd_follow.js --pipe \\.\pipe\BeDD-1.26.51.01-hi20`, then
walk a second player near the client.

## Fixtures

Recorded packets live in `packages/mineflayer-bedrock/test/fixtures/<version>/<capture>.jsonl.gz`
(format and loader: `packages/mineflayer-bedrock/test/fixtures/README.md`). Regenerate against a fresh
server (a new `bds up` instance has a fresh flat world):

```sh
corepack pnpm bds up --name fixtures --profile none   # prints the port, e.g. 41000
node scripts/capture-fixtures.js --host 127.0.0.1 --port 41000 --container bedboo-fixtures --seconds 22 \
  --out packages/mineflayer-bedrock/test/fixtures/1.26.51/join_flat.jsonl.gz
corepack pnpm bds down fixtures
corepack pnpm --filter mineflayer-bedrock test             # fixtures.test.js re-parses every packet
```

Options: `--username`, `--backend raknet-native|jsp-raknet`, `--transport`, `--ping yes` (disable
`skipPing`), `--container ""` (no console commands). Tests must not depend on exact entity ids, ticks or
positions of a capture beyond what the README documents. (`--profile none` keeps vanilla gamerules; the
U0 capture was recorded without a profile.)

## Manual docker recipe (no harness)

Only needed to reproduce something outside the harness. Use your own name and a free port outside
41000–41011.

```sh
mkdir -p ~/.cache/bedboo/manual-<me> && docker run -d --name bds-<me> --network host \
  -v ~/.cache/bedboo/manual-<me>:/data -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet \
  -e ENABLE_LAN_VISIBILITY=false -e ONLINE_MODE=false -e ALLOW_LIST=false -e ALLOW_CHEATS=true \
  -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator -e LEVEL_TYPE=FLAT -e PLAYER_IDLE_TIMEOUT=0 \
  -e SERVER_PORT=<P> -e SERVER_PORT_V6=<P+1> itzg/minecraft-bedrock-server:2026.10.1
until docker logs bds-<me> 2>&1 | grep -q 'Server started.'; do sleep 1; done
node -e "require('@bedboo/bds/lib/docker').sendCommand('bds-<me>', 'list')"   # from the repo root
BDS_HOST=127.0.0.1 BDS_PORT=<P> BDS_CONTAINER=bds-<me> corepack pnpm test:e2e -- --grep smoke
docker rm -f bds-<me>      # only your own container
```

`ENABLE_LAN_VISIBILITY=false` is mandatory: otherwise every RakNet server also binds 19132/19133, which
breaks parallel host-network servers.
