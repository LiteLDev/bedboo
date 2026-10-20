# @bedboo/agent

A scripted (no LLM) survival agent for [mineflayer-bedrock](../mineflayer-bedrock). It plays legit survival on a
Bedrock Dedicated Server: wood → stone tools → iron → diamonds, it builds a house from a blueprint and mines every
overworld ore, while it fights the mobs that attack it, eats, and gets out of lava and water. Everything goes through
the public mineflayer API and the ecosystem plugins (mineflayer-pathfinder, -collectblock, -tool, -armor-manager,
-auto-eat, -pvp), so the same code would drive a Java bot.

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Skills](#skills)
- [The obtain planner](#the-obtain-planner)
- [Safety behaviours](#safety-behaviours)
- [Blueprints](#blueprints)
- [Overworld milestones (e2e)](#overworld-milestones-e2e)
- [Seed scouting](#seed-scouting)
- [Data and attribution](#data-and-attribution)

## Quick start

```js
const { Agent } = require('@bedboo/agent')

const agent = await Agent.create({ host: '127.0.0.1', port: 19132, username: 'Agent', log: console.log })
await agent.run('obtain', { item: 'iron_pickaxe' })            // wood, stone, a furnace, iron… whatever it takes
await agent.run('build', { blueprint: 'house5x5' })              // materials obtained, verified block by block
await agent.run('mine', { all: [{ item: 'diamond' }, { item: 'emerald' }] })
agent.writeReport('report.json')                                 // tasks, timings, deaths, fights, event log
await agent.stop()
```

A local server: `corepack pnpm bds up --name me --world default --seed 1234 --gamemode survival --difficulty easy
--profile none` (prints the port). The agent joins as an ordinary offline player: no operator rights, no commands.

## Architecture

```
src/runner.js      Agent: createBot + plugins, tasks (timeouts, retries, death recovery), events, JSON report;
                   legacy runSkill / runScenario
src/skill.js       the skill contract: async (bot, args) => result; log / progress / sleep / withTimeout helpers
src/skills/*.js    skills, auto-discovered by skills/index.js (a new file registers itself)
src/planner.js     the obtain planner (pure: works on a world model, unit-tested with fakes)
src/knowledge.js   the live world model: recipes (bot.recipesAll), furnace recipes, block drops, what is in sight
src/dig.js         find → reach (walk / shaft down) → dig with the right tool → pick up the drops
src/stations.js    crafting tables and furnaces: use a nearby one, or place the carried one and take it back
src/safety.js      background behaviours: fight / flee, lava, drowning, eating
src/blueprint.js   blueprint data + compiler (build order, materials) + verifier
src/world.js, src/inventory.js   block / inventory queries
src/data/          furnace recipes (vendored), fuels, drop yields, mob drops, natural blocks + their biomes
scenarios/overworld/   milestones M1–M5, the e2e harness, full-run.js, seed.json
scripts/           scout-seed.js (cheats allowed only there), gen-smelting.js
```

`Agent.create(opts)` options: `host`, `port`, `username` (default `Agent`), `bot` (use an existing spawned bot),
`botOptions`, `safety` (`true` / options of src/safety.js / `false`), `autoEat`, `keepFed` (hunt for food between
tasks when hungry), `recoverItems` (go back for the drops after a death), `log` (line sink), `skills` (registry).

`agent.run(skill, args, { timeout, retries })` runs one skill as a task; `agent.runScenario({ name, steps, timeout,
verify })` runs steps in order (stops at the first failure) and returns the report; `agent.on('event', e)` streams
`{ t, type, … }` events (`task-start`, `mine`, `craft`, `smelt`, `place`, `safety`, `death`, `log`, …).

## Skills

A skill is `async (bot, args) => result` (`args.signal` is the runner's AbortSignal). Skills never send commands.

| skill | args | does |
|---|---|---|
| `obtain` | `{ item, count }` | gets `count` × `item` by any means: craft / smelt / mine / gather / hunt, recursively |
| `mine` | `{ item \| block \| blocks, count }` or `{ all: [{ item, count }] }` | ores and stone: shaft down to deep ones, explore towards the right biome when none is loaded |
| `gather` | `{ item \| blocks, count }` | surface blocks: logs (`item: 'log'` = any), sand, gravel, … |
| `craft` | `{ item, count }` | `bot.recipesFor` / `bot.craft`, 2×2 or a crafting table (placed and taken back) |
| `smelt` | `{ item, count, input?, fuel?, furnaces?: 3 }` | `bot.openFurnace`; the furnace is placed and taken back; the window is only open to load / unload (a fight that closes it costs nothing); ≥ 12 items are split over up to 3 furnaces |
| `build` | `{ blueprint, origin?, radius? }` | builds a blueprint near the bot, verifies it block by block |
| `navigate` | `{ position \| spawn: true, goal?, range? }` | pathfinder with re-planning, legs for far goals (each leg's end on dry land, never in a lake), unsticking (own door, head block, out of the water onto a bank, a side dug open), the last resort after two failures in a pit / the water: `escape`; `spawn: true` is an x / z goal (the spawn column) |
| `explore` | `{ blocks?, biomes?, maxDistance? }` | spiral walk until a block / biome is loaded |
| `surface` | `{}` | out of a mine: pillar up (staircase where liquid is above, around lakes; over to the next column where gravel / sand is over the head) |
| `food` | `{ min, items?, stock?, explore?, fishing? }` | carry `min` hunger points and `items` food items: hunt passive animals (exploring for them), cook the meat; fish when no animal is left |
| `hunt` | `{ mobs, item, count }` | kill passive mobs for an item (wool, leather, …), exploring until one is in sight |
| `fish` | `{ count, obtainRod? }` | `bot.fish()` from a shore next to open water (≥ 2 deep); each cast waits ≤ 40 s for a bite |
| `rest` | `{ shelter? }` | the night: sleep in the carried bed (placed, `bot.sleep`, taken back: the night is skipped); with `shelter` and no bed / armor: the house, or a sealed hole in the ground until the morning |
| `descend` | `{ y }` | down a safe shaft (dry column, a staircase step around what is unsafe) to a level |
| `escape` | `{ away? }` | last-resort unstick: out of the water onto a bank, up to the open sky (pillar / staircase), a few blocks away on dry land |
| `combat`, `portal`, `nether`, `end` | | U18's (fighting, portals, other dimensions) |

## The obtain planner

`planner.plan({ item, count }, world)` returns the steps (dependencies first) or why it cannot. For every item it
weighs, by estimated seconds:

1. what the bot carries (only the missing units are costed);
2. every crafting recipe the server sent (tags already expanded: all plank types, …), plus a crafting table if the
   recipe needs one and none is near or carried;
3. furnace recipes (vendored table) with the cheapest fuel (carried first, then coal, charcoal, planks, logs) and a
   furnace;
4. blocks whose drops include the item (registry `drops` + harvest tools; multi-drop yields such as redstone 4–5,
   lapis 4–9), costed by the nearest one in sight (`bot.findBlocks` sees every loaded sub-chunk) or an exploration
   estimate for natural blocks; the cheapest harvest tool is obtained first;
5. passive mobs in sight that drop it.

Cycles (iron block ↔ ingot) are cut; ingredients acquired for a recipe are reserved so a sibling cannot use them up.
The obtain skill executes only the first step, then plans again from the new inventory; failed ways are penalised and
dropped after 3 failures.

## Safety behaviours

src/safety.js runs during every task. When it takes over, pathfinder and digging stop and the task waits:

- a hostile that hurt the bot or comes close (creepers from 6 blocks) is fought with skills/combat.js `fight` with
  `safe: true` (melee, bow when available, retreat and eat when low; its moves never step into lava / fire / a portal
  or off a ledge higher than 3) — or fled from without a weapon at low health, and a creeper at 10 hp or less (unless
  the last flight from it went nowhere: then it is fought); a mob the bot neither hit nor got closer to for 12 s, or
  that ran 24 blocks away, is left alone for a minute — until it hurts the bot (a creeper within 5 blocks only once it
  was given up on twice in 3 minutes); a neutral mob (piglin, enderman) that
  swung at the bot and hurt it is fought back (`combat.likelyAttacker`); a ghast fireball within 4 blocks is hit
  back; what a killed mob dropped next to the bot (string, bones) is picked up;
- U18's skills (portal, nether, end) run under `combat.guardFor()`: under an Agent it pushes the skill's guard options
  (radius, height band, `ignore` — ghasts without a bow —, neutral mobs, retaliation, deflection) onto the safety
  behaviours for as long as the skill runs, so they keep their own guard's protections; the combat skill's hunt /
  nearby modes pause the safety behaviours while they fight themselves (one fighter per mob);
- in lava: jump towards the nearest solid ground; low on air: swim up (centred in the water column), or to the
  nearest pocket of air under a ceiling; losing air in a block the client does not show yet: no fight starts (a fight
  stops) until the climb gets out; a falling block in the head cell (gravel, sand): dig it out (never towards
  lava);
- mineflayer-auto-eat eats when the food level drops below 16 — below 18 while the bot is hurt (natural regeneration
  needs 18) — (rotten flesh only when starving), never during a fight, a pillar step or a placement (counted holds:
  `Safety#suppressMeals`); 3 meals that fail in 15 s pause it for 10 s; before a climb and between tasks the bot eats
  standing still; between tasks the agent hunts passive animals
  in sight when hungry and out of food (chased with the pathfinder around fences and ledges), and cooks the meat in
  its furnace;
- nights: between tasks, in the overworld at night, the agent sleeps in its bed (`rest`: the night is skipped); with
  `shelter: true` (the final chain) and neither a bed nor armor it waits for the morning in its house or a sealed hole;
- the stuck watchdog: a task (obtain, mine, gather, navigate, explore, build, food, hunt, fish, surface) whose bot
  stayed in a box of 6 blocks for 2½–4 minutes without digging, placing, crafting, smelting or picking anything up is
  aborted; the bot escapes (`escape`: out of the water, up to the sky, away from the spot), the spot is a trap for ten
  minutes (no ore / goal there is chosen again) and the task runs again (twice at most); an aborted task's skill is
  given 10 s to unwind before anything else drives the bot;
- a death aborts the task; after the respawn the agent walks back (a shaft for a death deep underground, after making
  a wooden pickaxe if none is left), picks up its drops and retries the task; a lost tool is obtained again by the mine
  step that needs it;
- digging never opens a cell next to lava or water, never drops into a cave deeper than 3 blocks, never digs what the
  agent built (protected zones), and pathfinder never breaks stations / chests / doors;
- the event log records every damage taken (health, food, the blocks at the feet and the head, the nearest hostile)
  and the server's death messages, so a failed run says what killed the bot.

## Blueprints

```js
{
  name: 'house5x5',
  palette: { '#': ['cobblestone', 'cobbled_deepslate'], P: PLANKS, D: { block: DOORS, phase: 2, tall: true },
             d: { block: DOORS, upper: true }, T: { block: ['crafting_table'], phase: 2 }, C: { block: ['chest'], phase: 2 },
             '.': 'air' },
  layers: [['#####', …], ['#####', '#T.C#', '#...#', '#...#', '##D##'], …]  // bottom up; rows north → south
}
```

`compile(blueprint, origin)` gives the placement order (bottom-up, every block next to an earlier one), the cells that
must stay empty, the checks and the materials; `verify(compiled, bot.blockAt)` compares block by block. The build skill
obtains the materials first, picks a flat site, clears it, fills dips under the floor and places with
`bot.placeBlock` against a solid neighbour face.

## Overworld milestones (e2e)

```sh
export BEDBOO_MAX_SERVERS=10 BEDBOO_WORKER_SLOTS=2
corepack pnpm --filter @bedboo/agent test:e2e -- --grep M1            # one run of M1
AGENT_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep M3 # the gate: ≥ 4 of 5
AGENT_FULL_RUN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep "full run"
node packages/agent/scenarios/overworld/full-run.js --log             # the same chained run as a script
node packages/agent/scenarios/overworld/final-chain.js --log          # M1→M5 → Nether → End, one world (below)
```

| | from | steps | verified |
|---|---|---|---|
| M1 | fresh world, empty inventory | obtain stone pickaxe, stone axe, stone sword | the tools; planks, table, sticks, wooden pickaxe crafted; stone mined |
| M2 | M1's end | obtain iron pickaxe, iron sword, bucket | the tools; iron ore mined; iron smelted |
| M3 | M2's end | obtain 3 diamonds, a diamond pickaxe | the pickaxe; ≥ 3 diamond ores mined, deepslate ones among them |
| M4 | M3's end | surface, walk to the world spawn, build house5x5 | every block of the house, ≤ 48 blocks from the spawn |
| M5 | M4's end | coal, copper, iron; emerald (mountains); lapis, gold, redstone, diamond | one new item from each of the 8 ores |

Gate on BDS 1.26.51.1 (2026-10-20, seed 1234, easy, 5 runs each from the previous milestone's snapshot; failure
reasons and timings in `$AGENT_REPORT_DIR/runs.jsonl`; code of e4e832b — the final chain's code minus its late
declutter, the cobwebs for a fishing rod and the camp's extra meat, which only the chain uses):

| | passed | wall time per run (s) | notes |
|---|---|---|---|
| M1 | 5/5 | 76, 91, 93, 82, 96 | |
| M2 | 5/5 | 210, 232, 221, 200, 237 | night falls during the run: zombies fought |
| M3 | 5/5 | 126, 92, 113, 113, 97 | diamonds at y 3–4 (deepslate diamond ore) |
| M4 | 5/5 | 183, 174, 172, 176, 172 | 125 cells verified |
| M5 | 5/5 | 409, 303, 461, 483, 533 | |

Earlier rounds on the way there: M4 4/5 (one run failed after a death at night), M5 3/5 (copper dug under
the lake, its drops lost in the water → a spot whose digs give nothing is left; redstone dug in a shaft without a
'mine' event → ores dug by shafts and the pathfinder are counted).

World: the scouted seed in `scenarios/overworld/seed.json` (default generator), survival, difficulty
`AGENT_DIFFICULTY` (default `easy`), vanilla gamerules (mobs spawn, day and night pass). Each milestone runs on a
fresh server started from the snapshot `u17-s<seed>-m<k-1>` — the end state of a successful run of the previous
milestone, the player included (BDS saves an offline player's inventory and position under its SelfSignedId, which
mineflayer-bedrock derives from the username). Missing snapshots are produced by running the earlier milestones.
Nothing in a milestone is cheated: the harness only starts servers and takes snapshots.

Env: `AGENT_RUNS` (runs per milestone), `AGENT_DIFFICULTY`, `AGENT_REPORT_DIR` (reports + `runs.jsonl`; default
`~/.cache/bedboo/agent-reports`), `AGENT_REFRESH=1` (rebuild the snapshots), `AGENT_LOG=1` (print the event stream),
`AGENT_SNAPSHOT_TAG`.

### The final chain

`scenarios/overworld/final-chain.js` (`corepack pnpm --filter @bedboo/agent final-chain`, or
`AGENT_FINAL_CHAIN=1 … test:e2e -- --grep "final chain"`) runs everything in one world (seed 1234, easy) with one bot
and no reconnects:

| phase | what the bot does | budget |
|---|---|---|
| M1 | wood → stone tools (the milestone) | 10 min |
| camp | at the spawn while it is day: 3 wool of one colour from sheep → a bed; logs; meat (best effort) | ~6 min |
| M2 | iron tools, a bucket | 10 min |
| gear | all the iron in one trip and one 3-furnace smelt → iron helmet, chestplate, leggings, boots (worn) and a shield (off-hand), a spare iron pickaxe, the second bucket and the iron for the flint and steel; sticks; the camp's meat cooked | 9 + 2×7 min |
| down to the diamonds | a safe shaft to y -54 (`descend`): diamonds are a deepslate thing, and M3 checks a deepslate diamond ore is among its three | 4 min |
| M3, M4, M5 | diamonds, the house at the spawn, every overworld ore (the milestones) | 10 min each |
| gold armor | `--nether-ores` only: golden boots (`obtain`: M5's raw gold smelted, more gold ore mined from the vein M5 found) — one gold piece keeps piglins neutral | 2 × 8 min |
| provisions | back to the spawn; ≥ 8 food items (hunted around the spawn, exploring for animals; fishing when none is left; cooked); `--nether-ores`: aims for 14 (N1M3 eats some before the ores) | 5 + 2×4 min |
| N1M3 | U18's nether entry: second bucket, iron ingot (both carried by then), bucket-cast obsidian at a lava pool, frame, flint and steel, into the Nether | 45 min |
| home | U18's nether skill: back through the bot's own portal | 14 min |
| nether ores + home | `--nether-ores` instead of home: a gold piece carried and ≥ 8 food items (short of food: home through the portal first, food on the plains, back in), then the nether skill mines N2's quartz, nether gold and ancient debris (the gold piece worn; at least one of each, or the phase fails) and goes home | (6 + 4) + 14 min |
| E1 | U18's End part — the stronghold portal room reached with cheats (locate + teleport, eyes of ender given; docs/differences/U18.md), the bot fills the frames, enters the End, the dragon is killed by `/kill` (cheat), the bot walks up from the arrival platform to the island top ([the walk up](#the-end-walk-up)), fights two endermen and leaves through the exit portal | 4 + 11 + 4 min (the fight's budget includes 3 min for the walk up, bounded at 150 s) |

Between scenario steps the Agent sleeps through a night in its bed (and before every phase; without a bed and
without armor it would wait in its house or a sealed hole), tosses junk when the inventory fills up, hunts when
hungry; a stuck task is aborted by the watchdog and run again after an escape. Every phase's time and the time of day
it started at are printed; the report goes to `$AGENT_REPORT_DIR/final-chain-<time>.json`. Development only (not an
acceptance run): `--from m5` starts from a milestone snapshot after that milestone, `--until provisions` stops after a
phase.

Earlier runs (before FINAL-FIX-AGENT-A, M1 → M5 → provisions → N1M3 only): none passed every phase — drowned in a
flooded cave going back to the spawn; no food, the portal skill searching a mineshaft for 13 min, a starving fall;
stuck in the lake west of the spawn; killed by a spider at night during provisions; stuck 8 min in its own copper pit.

**Acceptance** (BDS 1.26.51.1, 2026-10-20, seed 1234, easy, code of 4903066 = this version; a fresh world per run,
three runs at a time; phase seconds): **5/5 end to end**, no deaths, no stuck task.

| run | total | M1 | camp | M2 | gear | down | M3 | M4 | M5 | provisions | N1M3 | home | E1: stronghold, activate, dragon, endermen, exit | nights slept |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| e1 | 35.3 min | 97 | 194 | 169 | 523 | 21 | 69 | 183 | 285 | 243 | 243 | 5 | 6, 12, 2, 46, 8 | 2 |
| e2 | 40.6 min | 87 | 161 | 324 | 564 | 110 | 83 | 236 | 298 | 169 | 296 | 5 | 5, 15, 2, 47, 11 | 2 |
| e3 | 34.6 min | 92 | 110 | 189 | 667 | 95 | 70 | 228 | 201 | 101 | 208 | 5 | 5, 11, 2, 44, 16 | 2 |
| e4 | 37.5 min | 78 | 161 | 374 | 524 | 96 | 63 | 248 | 199 | 181 | 214 | 5 | 6, 14, 2, 44, 23 | 2 |
| e5 | 37.0 min | 96 | 188 | 292 | 666 | 79 | 38 | 238 | 194 | 148 | 191 | 5 | 6, 12, 2, 42, 7 | 3 |

The code-review fixes after it (counted meal holds, ore counting by the dig target, creepers, climbs under gravel)
were validated the same way:

- M3 5/5 (106, 89, 99, 107, 89 s) and M5 5/5 (366, 270, 262, 297, 393 s).
- M4 5/5 on the final code (180, 192, 187, 219, 187 s). The M4 climb starts under a gravel column; the bot steps over
  to the next column twice.
- Final chain: 6 of 6 runs passed since the climbs step aside under gravel (36.2–47.8 min, no deaths). Three of them ran the final code (36.2, 43.8, 39.4 min).
- Before that change, 2 of 5 runs failed. In both the bot suffocated under gravel it dug into on the way up; one of
  them first died in a cave that the shaft down opened into.

Chained runs before (each failure fixed before the next round): full5, full6, full7 and a1 passed (40.1, 52.2, 32.9
and 42.5 min); full8 failed M3 — three plain diamond ores at y 9–10, none of deepslate (→ the "down to the diamonds"
phase); full9 failed the End: U18's walk from the arrival platform up to the island stalled 305 s and the fight ran
out of time (→ its budget covers the walk); b1 and c2 failed M3 with 2 and 1 diamond ores counted — the pathfinder
and the shaft had dug the others (→ every ore the bot digs is counted); b2 drowned in an aquifer in the gear phase;
c1 ran out of time in M3 fighting a creeper behind a wall every 12 s (→ a mob given up on twice stays ignored); d1
reached the stronghold with a full inventory, its kit of eyes on the ground (→ the inventory is cleared of
late-useless blocks and ores before every phase); d2 found 3 food items in provisions (→ more meat at the camp,
cobwebs for a fishing rod).

Development runs of this version's overworld part (seed 1234, easy; phase seconds; each failure fixed before the
next round):

| run | M1, camp, M2, gear, M3, M4, M5 (s) | result |
|---|---|---|
| ow1 | 83, 289, 177, 542, 186, 211, — | M5: 24 gold ores dug, no raw gold — the inventory was full (→ junk tossed, unwanted drops left) |
| ow2 | 89, 228, 206, 434, — | M3: the logs had been burnt as fuel, a log trip from y -12 (→ coal first, sticks kept); auto-eat stuck "eating" (→ guard) |
| ow3 | 85, 181, 212, 468, 362, 102, — | M5: full inventory, as ow1 |
| ow4 | 100, 368, 227, 426, 121, — | M4: suffocated in a pillar step retried after a meal (→ retried after a fight only); recovery left the drops at the first fight (→ goes on) |
| ow5 | 94, 302, 188, — | gear: the shield's planks were a log trip from underground (→ shield and spares best effort) |
| full1 | 79, 131, 260, 405, 59, 197, 196 | provisions: an x/z goal skipped the climb to the surface, a zombie behind a wall fought every 12 s (→ both fixed); stopped |


### The End walk up

From the arrival platform (an obsidian platform at (100, 49, 0) whose top floats 4–5 blocks over the island's slope in
seed 1234) the end skill's `toIslandTop` walks to the island top near the exit fountain in hops of ≤ 30 blocks. Its
usual way (≈ 30 s): mineflayer-pathfinder bridges west along z = 2 from x 97 to x 87 (10 scaffolding blocks, ≈ 2 s
each), drops 2 blocks onto the slope and climbs it, digging a few steps into the end stone.

**The stall** (4 development chain runs before the acceptance runs: 10 × "goto stalled: no progress for 30000 ms" at
x 89–95, z 2, y 50 — on the bot's own half-built bridge): when the equip or the placement of a bridge block fails,
mineflayer-pathfinder never gets past it. Its equip lock is not released when `bot.equip` rejects, and a refused
placement resets the path into the same placement. `stop()` waits for a placement that never ends, so the
pathfinder keeps pressing 'back' and 'sneak' towards its bridge edge. The walk gave up each hop after 30 s and started
the same hop again, 10 times. What made the equip / placement fail comes from the chain's state and was never
reproduced in E1A: 13 dedicated attempts (full inventories, mixed small scaffolding stacks, a hungry bot) and the 49
recorded runs below all walked up in 29–34 s. Simulating it — `bot.equip` of a scaffolding block rejected, or
`bot.placeBlock` rejected, in the End — reproduces the signature exactly:
"goto stalled … at (96, 50, 2)". None of the candidate causes was it — no tower under the island (`bedrockTowers`
already drops those), the obsidian edge is walked over, and no enderman was involved. The chain runs that stalled carried
full inventories into the End (the eyes' /give dropped the End's diamond boots and leggings); since the late declutter
(≥ 12 free slots before every late phase) no run stalled.

**The fix** (`skills/end.js` `toIslandTop`, bounded by `walkMs` = 150 s): a meal first, standing still (auto-eat
starting one mid-bridge swaps the block in the hand for food), no meals during a hop. A hop that does not move the bot
2 blocks, or whose walk stood still for `walkStallMs` (15 s), is a stall. The next hop then takes another way, the
first of these that stalled least:
1. `path`: the pathfinder as before (bridges, digs, towers where BDS accepts them);
2. `no placement`: the pathfinder without scaffolding and with drops of ≤ 6. It walks off the platform onto the slope
   under it (a fall of ≤ 3 damage) and digs up through the end stone;
3. `manual`: the bot's own steps (`manualStep`, after stopping the hung pathfinder). Each step is one of a staircase
   into the rock ahead, a step or a drop of ≤ 6 onto the ground ahead (never the void), a bridge block across a gap,
   or a pillar step where the 3×3 columns over the bot are clear.

Each way was verified on its own in E1A, from the platform to the island top:

| way | how it was forced | time to the island top |
|---|---|---|
| `path` | none (the normal walk) | 30 s, no stall |
| `no placement` | `bot.equip` of the scaffolding rejected (stall after 15 s) | 37 s |
| `no placement` | `bot.placeBlock` rejected | 55 s (two hops of 15 s, before a stall after a few bridge blocks counted) |
| `manual` | equip rejected, the `no placement` way left out | 43 s |
| `manual` | the only way | 27 s |

The walk's record — hops, stalls with their way, and the longest stand-still — is in the fight phase's result
(`walk`) and in the log line "end: on the island at … (30 s, 3 hops, longest stand-still 1 s, 0 stalls)". E1A prints
it for every run.

The exit phase also counts a bot that reached the overworld through the exit portal before its own step in as
exited. One E1A run had been knocked in by an enderman at the fountain, and the walk then went on towards (0, 0) in the
overworld for 4 minutes. A death during the exit is not counted as an exit. Endermen that follow the bot to the
fountain are fought while it has more than 10 hp. Below that it leaves them behind through the portal; a fight in
progress also ends, since the safety's fights end when a guard starts ignoring their target. A default chain run was
slain there by five endermen in a row, 17 → 0 hp in 12 s, three of them killed.

**End phases** (E1A: `BEDBOO_U18_CHAIN_SEED=1 BEDBOO_U18_RUNS=10 … --grep E1A`, seed 1234, easy, the Agent; E1A now fails
a run whose walk stood still for over 60 s; wall time per run in seconds):

| batch | code | passed | wall time per run (s) | walk up |
|---|---|---|---|---|
| 1 | the walk's fallbacks | 9/10 | 83, 87, 89, 85 ✗, 71, 136, 69, 144, 88, 82 | 29–30 s, 3 hops, no stall (9 recorded) |
| 2 | + failed runs keep the agent's report | 10/10 | 117, 83, 82, 80, 74, 99, 75, 69, 82, 81 | 29–30 s, 3 hops, no stall |
| 3 | the exit at low health, the review fixes | 10/10 | 79, 86, 79, 83, 75, 90, 83, 76, 93, 78 | 30 s, 3 hops, no stall, longest stand-still 1 s |
| 4 | rebased on POLISH-LIB (#36) | 10/10 | 72, 82, 76, 106, 80, 79, 72, 87, 72, 70 | 30 s, 3 hops, no stall, longest stand-still 1 s |
| 5 | final (the second review's fixes) | 10/10 | 76, 81, 97, 78, 70, 82, 79, 89, 82, 98 | 29–34 s, 3 hops, no stall, longest stand-still 1 s |

✗ batch 1 run 4: the bot died in the endermen fight, 59 s into the phase. No event log was kept then, so failed E1A
runs now write the agent's report next to `BEDBOO_U18_REPORT`. 49 of 50 runs passed. In 49 recorded walks none
stalled and none stood still for more than a second. The fallback was needed in a chain run instead: in default-1
the pathfinder found no path off the platform (no bridge), and the `no placement` way had the bot on the island in
20 s. In the 9 other chain runs that reached the End, the walk took 30–33 s with no stall.

### `--nether-ores`

`final-chain --nether-ores` adds the Nether's ores to the chain:
- **gold armor** after M5: golden boots, `obtain`ed from M5's raw gold. The planner smelts it, mines more gold ore
  from the vein M5 found, and makes a crafting table when none is carried.
- **provisions** aims for 14 food items instead of 8.
- **nether ores + home** replaces home. It checks that the bot carries a gold piece and ≥ 8 food items; short of food,
  it goes home through the portal first, hunts, and goes back in. Then the nether skill wears the gold piece and mines
  quartz, nether gold and ancient debris (3 / 3 / 1). The phase fails unless it mines at least one of each and gets home.

Under the Agent the Nether trip's guard (`nether.netherGuard`) works as follows:
- Piglins are nobody's attacker while the bot wears gold, unless one hits it with no other mob to blame (a hostile,
  a ghast's fireball, a zombified piglin). That piglin is then angry and fought back for a minute.
- No arrows fly with piglins or zombified piglins within 24 blocks.
- Hoglins are fought with a retreat and a meal at low health, rather than to the end. At ≤ 8 hp they are fled from.
- A fight's `equipForCombat` never swaps the worn gold piece for iron in the Nether, and the gold goes back on when
  something took it off.

Runs (BDS 1.26.51.1, 2026-10-20, seed 1234, easy; a fresh world per run, phase seconds):

| run | code | result | M1, camp, M2, gear, down, M3, M4, M5 | gold armor | provisions | N1M3 | nether ores + home | E1: stronghold, activate, dragon, endermen, exit |
|---|---|---|---|---|---|---|---|---|
| dev | `--from m5` (M5 snapshot) | passed, 29.1 min (partial) | — | 207 | 443 | 963 (a night in a shelter: the snapshot's bot has no armor) | 49 | 6, 15, 2, 43, 8 |
| ores-1 | first version | ✗ 37.3 min | 78, 192, 209, 473, 89, 29, 283, 213 | 194 | 190 | 270 ✗ | — | — |
| ores-2 | + exit at low health | passed, 41.5 min | 86, 125, 190, 488, 45, 69, 161, 278 | 282 | 371 | 193 | 44 | 6, 15, 2, 89, 12 |
| ores-3 | + portal out of the flint pit | passed, 52.1 min | 84, 186, 167, 682, 61, 92, 178, 515 | 360 | 427 | 211 | 47 | 6, 10, 2, 49, 20 |
| ores-4 | same | passed, 47.7 min | 98, 260, 210, 499, 30, 92, 161, 474 | 74 | 650 | 192 | 45 | 5, 13, 2, 39, 11 |
| ores-r1 | rebased on POLISH-LIB (#36), `guardAutoEat` removed | ✗ 45.1 min | 78, 297, 366, 1018, 47, 473 ✗ | — | — | — | — | — |
| ores-r2 | + drowning under a ceiling | passed, 39.6 min | 77, 233, 200, 572, 30, 96, 132, 288 | 169 | 239 | 211 | 44 | 6, 14, 2, 43, 4 |
| ores-r3 | same | passed, 43.9 min | 96, 239, 199, 637, 89, 28, 216, 281 | 167 | 285 | 260 | 47 | 5, 15, 2, 38, 6 |
| ores-f1 | final (the second review's fixes) | passed, 43.2 min | 72, 242, 189, 772, 25, 54, 135, 255 | 83 | 381 | 247 | 48 | 6, 15, 2, 43, 16 |

Every Nether trip went the same way: the portal comes out at (-53, 68, 5) in the Nether. The bot mined 3 quartz
there in 6–11 s, the ancient debris at (-60, 73, 18) in 14–16 s and 3 nether gold in 7–8 s, then went home along its
breadcrumbs. No piglin or hoglin fight, no death.

6 of 8 full runs passed end to end: 5 of 6 since the portal fix, and 3 of 3 since the drowning fix (the last one on
the final code). No death in any Nether or End phase.

✗ ores-r1 (overworld, before the Nether): the camp found no animals and the bot carried only rotten flesh, so it
could not regenerate. A creeper blast left it at 1 hp, and a skeleton and then a zombie villager killed it in M3 (U17's
food supply; not this change).

✗ ores-1: U18's portal skill dug its flint from a gravel pit 2–3 deep beside the lava pool. The walk back to the
frame then stood still at the pit's bottom for 30 s, and the stall error failed N1M3. That is the same mineflayer-
pathfinder hang on a failed placement. Now (`portal.lightPortal`) a stalled walk to the frame stops the pathfinder, and
the bot climbs out with U17's staircase steps (`stairStepUp`) and walks again.

**Default chain regression** (no `--nether-ores`):

| run | code | result | M1, camp, M2, gear, down, M3, M4, M5, provisions, N1M3, home | E1: stronghold, activate, dragon, endermen, exit |
|---|---|---|---|---|
| default-1 | first version | ✗ 47.3 min | 79, 448, 168, 373, 85, 72, 321, 326, 677, 194, 5 | 6, 15, 2, 42, 17 ✗ |
| default-2 | + exit at low health, portal out of the flint pit | passed, 40.6 min | 84, 100, 177, 501, 18, 239, 169, 496, 332, 194, 5 | 5, 12, 2, 56, 20 |
| default-r1 | rebased on POLISH-LIB (#36), `guardAutoEat` removed | ✗ 26.4 min | 86, 173, 167, 567, 62, 34, 489 ✗ | — |
| default-r2 | same | passed, 42.0 min | 80, 305, 253, 437, 94, 72, 235, 412, 308, 207, 3 | 6, 10, 2, 47, 13 |
| default-r3 | + drowning under a ceiling | passed, 41.6 min | 98, 211, 220, 508, 18, 62, 180, 323, 498, 281, 5 | 5, 14, 2, 54, 10 |
| default-f1 | final (the second review's fixes) | passed, 36.5 min | 99, 212, 206, 581, 92, 70, 210, 212, 97, 257, 5 | 5, 13, 2, 87, 20 |
| default-f2 | same | ✗ 21.3 min | 92, 215, 214, 469, 28, 49, 204 ✗ | — |

✗ default-f2 (U17's build in M4): the bot could not clear the grass at one floor cell. Its walk there stalled
("Took to long to decide path", then stuck twice), and BDS refused both cobblestone placements beside it ("the block
is still air"). The house ended with 1 of 125 blocks wrong after the repair pass. This change does not touch it.

✗ default-r1: drowned twice in M4's climb to the surface (U17's `surface`), at the same spot. The pillar had come up
under a flooded cave at y 52, with no air pocket within 6 blocks. Every 4 ticks the safety's drowning behaviour took
the controls again, and each time it stopped the climb's dig of the ceiling, the only way out. Now (`safety.js`) a
drowning claim that found no air pocket digs up through the ceiling itself. It digs at most 2 blocks, and never next to
lava, under gravel or sand, or when the dig would outlast the air. Where the last claim found no way out, no new one
is made until the bot moved, or for 30 s, so the task's own dig goes on.

✗ default-1: an enderman slew the bot at the exit fountain. Five endermen came in a row, 17 → 0 hp in 12 s, and three
of them were killed. That led to the exit change above. The run had died twice in the overworld before: slain by a
zombie while hunting sheep at the camp, which cost the bed's wool, and shot by a skeleton at night in provisions with
no bed. The Agent recovered from both.


## Seed scouting

```sh
node packages/agent/scripts/scout-seed.js --seeds 1234,100,31337 [--out scout.json] [--write-seed 1234]
```

Starts a server per seed, joins a creative bot and surveys the spawn area with `findBlocks` (trees, exposed stone,
surface lava, gravel, the nearest ore of each kind), `/locate`s the mountain biomes (`/locate biome minecraft:<id>`)
and teleports there to look for emerald ore. Cheats are allowed only here; the milestones never read seed.json.
Chosen: **1234** — spawn (-516, 69, 77) in plains with oak/birch woods 25 blocks away, exposed stone, surface lava 58
blocks away, gravel, coal/copper/iron within 15 blocks, every deep ore within ~70 blocks, and a meadow with emerald
ore 150 blocks west (emerald at (-663, 121, 43)).

## Data and attribution

`src/data/smelting.json` holds the furnace recipes of [CloudburstMC/Data](https://github.com/CloudburstMC/Data)
`recipes.json` at commit 73bda57f9afa (Apache License 2.0, Copyright CloudburstMC; the last dump with furnace
recipes — BDS's crafting_data has none), filtered by `scripts/gen-smelting.js` (furnace only, no gear → nuggets,
names checked against the 1.26.51 registry, newer wood types added). Fuel burn times, drop yields and mob drops in
`src/data/index.js` are the vanilla values.

## Combat & dimensions (U18)

The `combat`, `portal`, `nether` and `end` skills, the `combat.defend()` guard, the milestone scenarios (C1, N1, N2,
E1, chain) and their e2e commands: [scenarios/README.md](scenarios/README.md#combat--dimensions-u18).
