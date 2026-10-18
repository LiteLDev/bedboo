# Testing against Bedrock Dedicated Server

Owner: U1 (wave 1). Seeded by U0 with the transport spike results.

## Transport spike (U0, 2026-10-18) — RESULT: RakNet works

Host: WSL2 kernel 6.18, Docker 29 (native dockerd, host networking), Node 24.22, pnpm 12.14.0.
Server: `itzg/minecraft-bedrock-server:2026.10.1`, BDS **1.26.51.1** (build 51061372, branch r/26_u5),
`transport=raknet`, `online-mode=false`, flat world.

| Client transport / backend | Result |
|---|---|
| bedrock-protocol 3.60.1, `transport: 'raknet'`, `raknetBackend: 'raknet-native'` (patched) | **works**: join ≈0.3 s, `start_game` ≈0.5 s, `spawn` ≈1.0 s, `level_chunk` + `subchunk`, stable 25 s sessions with a 50 ms `player_auth_input` loop |
| `raknetBackend: 'raknet-native'` unpatched | fails to load: binding looks for `prebuilds/linux-6-x64` (kernel major 6), only `linux-5-x64` ships, falls back to a cmake build (no toolchain) |
| `raknetBackend: 'jsp-raknet'` | **fails**: BDS answers the open-connection request with `ID_INCOMPATIBLE_PROTOCOL_VERSION` (0x19, server RakNet protocol 11; jsp-raknet speaks 10) and the client retries until timeout |
| NetherNet | not needed for the gate (BDS default transport; public-client signalling is an unmerged bedrock-protocol PR) — U16 smoke only |
| Unconnected ping (`bedrock.ping`, discovery without `skipPing`) | **no reply** with `enable-lan-visibility=false` → discovery waits 1 s then falls back to configured defaults. `lib/client.js` therefore defaults to `skipPing: true` |

Limitation: raknet-native 1.2.3 bundles x64 prebuilds only (`linux-5-x64`, `darwin-21-x64`,
`win32-10-x64`) and its cmake build is disabled, so arm64 hosts (Apple Silicon, linux-arm64) currently
have no working RakNet backend (jsp-raknet is rejected by BDS). Our dev/CI hosts are x64.

The raknet-native fix is `patches/raknet-native@1.2.3.patch`: `binding.js` also tries
`helpers/buildPath.getFallbackPath()` (any bundled prebuild for the platform+arch — upstream defines but
never calls it) before `bindings`, and resolves `build/Release` relative to the package instead of the
cwd. The prebuild needs glibc ≥ 2.34. Its install script (cmake build) is disabled via
`allowBuilds: { raknet-native: false }` in `pnpm-workspace.yaml`.

Re-run the spike: `node scripts/capture-fixtures.js --port 40100 --container bds-u0` (exit code 1 unless
join, start_game, spawn, level_chunk and subchunk were all observed), or as a test:
`BDS_HOST=127.0.0.1 BDS_PORT=40100 corepack pnpm test:e2e -- --grep smoke`.

## BDS 1.26.51.1 quirks seen

- **Readiness line:** `[… INFO] Server started.` (followed by a multi-line `TRANSPORT TYPE ERROR` block when
  `transport=raknet`: "Your current connection type is not set to NetherNet … Players will not be able to
  connect". It is harmless — RakNet clients connect fine. Whitelist it.) BDS also logs
  `Signed in to signaling service successfully` (it reaches Xbox signalling even with RakNet).
- **First start downloads BDS** (`Downloading Bedrock server version 1.26.51.1 ...`, ≈10 s here); a restart
  of the same container with the same `/data` reused it (`Using given version 1.26.51.1`, no download).
  U1's golden cache + `VERSION=EXISTING` makes starts offline.
- **Console commands:** the image's `docker exec <c> send-command …` fails on this host with
  `find: '/proc/1/exe': Permission denied … ERROR: failed to search for bedrock server process`: it runs as
  root without `CAP_SYS_PTRACE` and cannot readlink the uid-1000 server's `/proc/<pid>/exe`. Working
  approach (used by `@bedboo/bds/lib/docker.sendCommand`): exec as the server's own uid:gid (owner of
  `/data`, here `1000:1000`) and write the command to the server process's `/proc/<pid>/fd/0`. Output
  appears only in `docker logs`; `say` prints nothing to the log, `list`/`querytarget` do.
- **Join sequence:** `start_game.player_position` = `(0.5, 32769.62, 0.5)` (spawn search height), then
  three `respawn` packets: state 0 at 32769.62, state 0 at 32768, state 1 at the real eye-level spawn
  `(0.5, -58.38, 0.5)` on the flat world (feet y = -60 = `groundY`). The spike answers state 1 with
  `respawn { state: 2, runtime_entity_id }` (vanilla client_ready). Then chunks, `play_status player_spawn`
  (bedrock-protocol sends `set_local_player_as_initialized` and emits `spawn`).
- **Loading screen gate:** after spawning, BDS does **not simulate the player** — `player_auth_input`
  positions and move vectors are ignored (server-side position unchanged per `querytarget`, no
  `correct_player_move_prediction`) — until the client sends `serverbound_loading_screen { type: 1 }` and
  `{ type: 2 }`. After that, walking inputs move the player and impossible moves are corrected.
- **Movement:** `start_game.rewind_history_size = 40`, `server_authoritative_block_breaking = true`,
  `server_authoritative_inventory = true`, `block_network_ids_are_hashes = true`. Default
  `server.properties`: `server-authoritative-movement-strict=false`, `player-position-acceptance-threshold=0.5`.
  `/tp` → `move_player { mode: 'teleport', teleport: { cause: 'command' } }`; standing still in the air
  after a teleport produced 3 corrections while falling back to the ground.
- **Chunks:** `level_chunk` always arrives in sub-chunk request mode — `sub_chunk_count: 0` with
  `highest_subchunk_count` present (1 on the flat world) — never with inline sub-chunks.
  `subchunk_request { dimension, origin: { x: cx, y: 0, z: cz }, requests: [{ x: 0, y: -4..19, z: 0 }] }`
  returns one `subchunk` with an entry per request (`success` with payload, or `success_all_air`).
  `network_chunk_publisher_update` radius 64 → 160 blocks after `request_chunk_radius 10`.
- **Time:** there is **no `set_time` packet** — not even for `/time set` — time is carried by
  `sync_world_clocks` (sent before `start_game` and on changes).
- **Inventory:** `/give`, `/replaceitem` (hotbar/armor), `/clear`, `/enchant` → `inventory_content`; only the
  off-hand `replaceitem` produced an `inventory_slot` (window `offhand`). Player inventory items carry
  `stack_id`s (server-authoritative inventory).
- **Commands from the client:** `command_request { command: '/time set 1000', origin: { type: 'player',
  uuid, request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' }` → `command_output`
  (`commands.time.set`). A client `text` chat (`type: 'chat'`) is echoed back as a `text` packet.
- The flat world spawns passive mobs (horses, pigs, …) continuously: hundreds of `move_entity_delta` per
  minute. U1's deterministic profile disables mob spawning.

## Manual docker recipe (before U1's harness)

Fixed ports per unit: U0 40100/40101, U2 40110/40111, U3 40120/40121.

```sh
mkdir -p ~/.cache/bedboo/manual-u0 && docker run -d --name bds-u0 --network host \
  -v ~/.cache/bedboo/manual-u0:/data -e EULA=TRUE -e VERSION=1.26.51.1 -e TRANSPORT=raknet \
  -e ENABLE_LAN_VISIBILITY=false -e ONLINE_MODE=false -e ALLOW_LIST=false -e ALLOW_CHEATS=true \
  -e DEFAULT_PLAYER_PERMISSION_LEVEL=operator -e LEVEL_TYPE=FLAT -e PLAYER_IDLE_TIMEOUT=0 \
  -e SERVER_PORT=40100 -e SERVER_PORT_V6=40101 itzg/minecraft-bedrock-server:2026.10.1
until docker logs bds-u0 2>&1 | grep -q 'Server started.'; do sleep 1; done

# console command (send-command does not work here, see above)
node -e "require('@bedboo/bds/lib/docker').sendCommand('bds-u0', 'list')"   # run from the repo root
docker logs --tail 5 bds-u0

# e2e against it
BDS_HOST=127.0.0.1 BDS_PORT=40100 BDS_CONTAINER=bds-u0 corepack pnpm test:e2e -- --grep smoke

docker rm -f bds-u0      # only your own container
```

`ENABLE_LAN_VISIBILITY=false` is mandatory: otherwise every RakNet server also binds 19132/19133, which
breaks parallel host-network servers.

## Fixtures

Recorded packets live in `packages/mineflayer-bedrock/test/fixtures/<version>/<capture>.jsonl.gz`
(format and loader: `packages/mineflayer-bedrock/test/fixtures/README.md`). Regenerate with a fresh
manual container (fresh `/data` gives a fresh flat world):

```sh
docker rm -f bds-u0; rm -rf ~/.cache/bedboo/manual-u0     # optional: fresh world
# start the container (recipe above), wait for "Server started."
node scripts/capture-fixtures.js --host 127.0.0.1 --port 40100 --container bds-u0 --seconds 22 \
  --out packages/mineflayer-bedrock/test/fixtures/1.26.51/join_flat.jsonl.gz
corepack pnpm --filter mineflayer-bedrock test             # fixtures.test.js re-parses every packet
```

Options: `--username`, `--backend raknet-native|jsp-raknet`, `--transport`, `--ping yes` (disable
`skipPing`), `--container ""` (no console commands). Tests must not depend on exact entity ids, ticks or
positions of a capture beyond what the README documents.
