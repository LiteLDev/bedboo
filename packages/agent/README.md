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
| `smelt` | `{ item, count, input?, fuel? }` | `bot.openFurnace`; the furnace is placed and taken back |
| `build` | `{ blueprint, origin?, radius? }` | builds a blueprint near the bot, verifies it block by block |
| `navigate` | `{ position \| spawn: true, goal?, range? }` | pathfinder with re-planning, legs for far goals, unsticking |
| `explore` | `{ blocks?, biomes?, maxDistance? }` | spiral walk until a block / biome is loaded |
| `surface` | `{}` | out of a mine: pillar up (staircase where liquid is above, around lakes) |
| `food` | `{ min }` | hunt passive animals for food |
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

- a hostile that hurt the bot or comes close (creepers from 6 blocks) is fought with skills/combat.js `fight`
  (melee, bow when available, retreat when low) — or fled from without a weapon at low health; a mob it could not get
  at within 15 s is left alone for a minute;
- in lava: jump towards the nearest solid ground; low on air: swim up (centred in the water column); a falling
  block in the head cell (gravel, sand): dig it out (never towards lava);
- mineflayer-auto-eat eats when the food level drops below 16 (rotten flesh too when starving); between tasks the
  agent hunts passive animals in sight when hungry and out of food (chased with the pathfinder around fences and
  ledges), and cooks the meat in its furnace;
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

Gate on BDS 1.26.51.1 (2026-10-19, seed 1234, easy, 5 runs each from the previous milestone's snapshot; failure
reasons and timings in `$AGENT_REPORT_DIR/runs.jsonl`):

| | passed | wall time per run (s) | notes |
|---|---|---|---|
| M1 | 5/5 | 91, 86, 80, 93, 88 | |
| M2 | 5/5 | 220, 252, 227, 195, 223 | night falls: zombies fought |
| M3 | 5/5 | 159, 90, 121, 120, 121 | diamonds at y 3–4 (deepslate diamond ore) |
| M4 | 5/5 | 185, 176, 200, 188, 172 | 125 cells verified; spiders, zombies, creepers fought |
| M5 | 5/5 | 361, 327, 424, 316, 506 | two runs survived a death (respawn, walk back, drops recovered) |

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
`AGENT_FINAL_CHAIN=1 … test:e2e -- --grep "final chain"`) runs everything in one world with one bot and no reconnects:
M1 → M5, provisions (meat hunted and cooked for the trip, best effort), U18's N1M3 (second bucket, iron ingot, back to the spawn, bucket-cast obsidian portal, into the Nether), back
home through the bot's own portal (`--nether-ores`: N2's quartz, nether gold and ancient debris on the way), then
U18's End part — the stronghold portal room is reached with cheats (locate + teleport, eyes of ender given; see
docs/differences/U18.md), the bot fills the frames, enters the End, the dragon is killed by `/kill` (cheat), the bot
fights two endermen and leaves through the exit portal. Every phase's time is printed; the report goes to
`$AGENT_REPORT_DIR/final-chain-<time>.json`.

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
