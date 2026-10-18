# Packet fixtures

Raw packet captures recorded from a real Bedrock Dedicated Server, used by unit tests that must not
need a server (chunk decoding, registry wiring, inventory parsing, …).

| Capture | Server | What happens |
|---|---|---|
| `1.26.51/join_flat.jsonl.gz` | BDS 1.26.51.1, `LEVEL_TYPE=FLAT`, RakNet, offline | Raw bedrock-protocol client `U0Bot` joins, answers the initial `respawn` (state 1 → 2), spawns, sends a stationary `player_auth_input` every 50 ms, requests every sub-chunk (-4..19) of each `level_chunk`, and runs console commands: `give` (diamond_pickaxe, oak_log, oak_planks ×2), `setblock` stone/chest/air, `say`, `xp`, `effect speed`, `weather rain/clear`, `replaceitem` (hotbar, armor, off-hand shield), `enchant`, `tp`, `title`, `gamemode creative/survival`, `summon pig`, `time set`; plus one client `command_request` (`/time set 1000`) and one client `text` chat. |

## Format

gzip'd JSON lines. Line 1: `{"meta": {bds, version, protocol, transport, raknetBackend, username,
capturedAt, milestones, stats}}` (`stats` counts every packet seen, including dropped duplicates).
Every other line: `{"i", "t", "dir": "in"|"out", "name", "buf"}` where `buf` is the base64 raw
decompressed packet (varint id header + body) — exactly what bedrock-protocol's deserializer reads.
Identical packets are stored once; per-name caps keep the file small (see
`scripts/capture-fixtures.js`). The client's own `login` packet is never stored.

## Use

```js
const fixtures = require('../fixtures')
const cap = fixtures.load('join_flat')
const startGame = cap.first('start_game')
for (const { params } of cap.packets('subchunk')) { /* … */ }
```

## Regenerate

See `docs/testing.md` ("Fixtures"). In short: start the manual BDS container, then

```sh
node scripts/capture-fixtures.js --port 40100 --container bds-u0
```

Notable observations (BDS 1.26.51.1): `level_chunk` arrives in sub-chunk request mode with
`sub_chunk_count: 0` and `highest_subchunk_count` present; there is no `set_time` packet (time is in
`sync_world_clocks`); `/give` and `/replaceitem` produce `inventory_content`, only the off-hand
`replaceitem` produced an `inventory_slot`; no `correct_player_move_prediction` while standing still.
