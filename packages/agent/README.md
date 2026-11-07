# @bedboo/agent

A scripted (no LLM) survival agent built on [bedboo](../bedboo). It plays legit survival on a Bedrock Dedicated
Server: wood → stone tools → iron → diamonds, it builds a house from a blueprint and mines every overworld ore, while
it fights the mobs that attack it, eats, and gets out of lava and water. Everything goes through the public mineflayer
API and the ecosystem plugins (mineflayer-pathfinder, -collectblock, -tool, -armor-manager, -auto-eat, -pvp), so the
same code would drive a Java bot.

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

The agent joins as an ordinary offline player: no operator rights, no commands.

`Agent.create(opts)` options: `host`, `port`, `username` (default `Agent`), `bot` (use an existing spawned bot),
`botOptions`, `safety` (`true` / options of src/safety.js / `false`), `autoEat`, `keepFed` (hunt for food between
tasks when hungry), `recoverItems` (go back for the drops after a death), `log` (line sink), `skills` (registry).

`agent.run(skill, args, { timeout, retries })` runs one skill as a task; `agent.runScenario({ name, steps, timeout,
verify })` runs steps in order (stops at the first failure) and returns the report; `agent.on('event', e)` streams
`{ t, type, … }` events (`task-start`, `mine`, `craft`, `smelt`, `place`, `safety`, `death`, `log`, …).

## Architecture

```
src/runner.js      Agent: createBot + plugins, tasks (timeouts, retries, death recovery), events, JSON report
src/skill.js       the skill contract: async (bot, args) => result; log / progress / sleep / withTimeout helpers
src/skills/*.js    skills, auto-discovered by skills/index.js (a new file registers itself)
src/planner.js     the obtain planner (pure: works on a world model, unit-tested with fakes)
src/knowledge.js   the live world model: recipes, furnace recipes, block drops, what is in sight
src/dig.js         find → reach (walk / shaft down) → dig with the right tool → pick up the drops
src/stations.js    crafting tables and furnaces: use a nearby one, or place the carried one and take it back
src/safety.js      background behaviours: fight / flee, lava, drowning, eating
src/blueprint.js   blueprint data + compiler (build order, materials) + verifier
src/data/          furnace recipes (vendored), fuels, drop yields, mob drops, natural blocks + their biomes
```

## Skills

A skill is `async (bot, args) => result` (`args.signal` is the runner's AbortSignal). Skills never send commands.

| skill | args | does |
|---|---|---|
| `obtain` | `{ item, count }` | gets `count` × `item` by any means: craft / smelt / mine / gather / hunt, recursively |
| `mine` | `{ item \| block \| blocks, count }` or `{ all: [{ item, count }] }` | ores and stone: shaft down to deep ones, explore towards the right biome when none is loaded |
| `gather` | `{ item \| blocks, count }` | surface blocks: logs (`item: 'log'` = any), sand, gravel, … |
| `craft` | `{ item, count }` | `bot.recipesFor` / `bot.craft`, 2×2 or a crafting table (placed and taken back) |
| `smelt` | `{ item, count, input?, fuel?, furnaces?: 3 }` | `bot.openFurnace`; the furnace is placed and taken back; ≥ 12 items are split over up to 3 furnaces |
| `build` | `{ blueprint, origin?, radius?, repairMs? }` | builds a blueprint near the bot, verifies it block by block and repairs what is wrong (≤ 3 rounds) |
| `navigate` | `{ position \| spawn: true, goal?, range? }` | pathfinder with re-planning, legs for far goals, unsticking; `escape` as the last resort |
| `explore` | `{ blocks?, biomes?, maxDistance? }` | spiral walk until a block / biome is loaded |
| `surface` | `{}` | out of a mine: pillar up (staircase where liquid or gravel is above) |
| `descend` | `{ y }` | down a safe shaft (dry column, a staircase step around what is unsafe) to a level |
| `escape` | `{ away? }` | last-resort unstick: out of the water onto a bank, up to the open sky, a few blocks away on dry land |
| `food` | `{ min, items?, stock?, explore?, fishing? }` | carry `min` hunger points: hunt passive animals, cook the meat; fish when no animal is left |
| `hunt` | `{ mobs, item, count }` | kill passive mobs for an item (wool, leather, …), exploring until one is in sight |
| `fish` | `{ count, obtainRod? }` | `bot.fish()` from a shore next to open water |
| `rest` | `{ shelter? }` | sleep through the night in the carried bed; with `shelter` and no bed / armor: the house or a sealed hole |
| `combat` | | melee, bow and shield against hostile mobs; `combat.defend()` is a background guard other skills run under |
| `portal` | `{ obsidian?, enter? }` | obsidian cast from lava with buckets, a 4×5 frame, flint and steel, through into the Nether |
| `nether` | | through the bot's own portal: mine quartz, nether gold and ancient debris (gold worn against piglins), home again |
| `end` | `{ phase? }` | fill a stronghold's end portal frames, fight endermen on the island, leave through the exit portal |

## The obtain planner

`planner.plan({ item, count }, world)` returns the steps (dependencies first) or why it cannot. For every item it
weighs, by estimated seconds: what the bot carries; every crafting recipe the server sent (plus a crafting table when
needed); furnace recipes with the cheapest fuel; blocks whose drops include the item (costed by the nearest one in
sight, or an exploration estimate, the cheapest harvest tool first); passive mobs in sight that drop it. Cycles are
cut and ingredients are reserved for their recipe. The obtain skill executes only the first step, then plans again
from the new inventory; failed ways are penalised and dropped after 3 failures.

## Safety behaviours

src/safety.js runs during every task. When it takes over, pathfinder and digging stop and the task waits:

- hostile mobs that hurt the bot or come close are fought (melee, bow, retreat and eat when low) or fled from; mobs
  out of reach are given up on for a while; neutral mobs are fought back only after they hurt the bot;
- in lava it jumps to solid ground; low on air it swims up or digs to air; a falling block in the head cell is dug out;
- mineflayer-auto-eat eats when hungry, never during a fight, a pillar step or a placement; between tasks the agent
  hunts and cooks when out of food, and sleeps through the night in its bed;
- a stuck watchdog aborts a task whose bot has not moved or made progress for minutes, escapes and retries it;
- a death aborts the task; after the respawn the agent walks back, picks up its drops and retries;
- digging never opens a cell next to lava or water, never drops into a deep cave and never digs what the agent built;
- the event log records every damage taken and the server's death messages, so a failed run says what killed the bot.

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
`bot.placeBlock` against a solid neighbour face. A refused placement is retried from another spot; after the build,
up to 3 repair rounds dig out wrong blocks and place missing ones again before the skill fails with the wrong cells.

## Data and attribution

`src/data/smelting.json` holds the furnace recipes of [CloudburstMC/Data](https://github.com/CloudburstMC/Data)
`recipes.json` at commit 73bda57f9afa (Apache License 2.0, Copyright CloudburstMC; the last dump with furnace
recipes — BDS's crafting_data has none), filtered by `scripts/gen-smelting.js` (furnace only, no gear → nuggets,
names checked against the 1.26.51 registry, newer wood types added). Fuel burn times, drop yields and mob drops in
`src/data/index.js` are the vanilla values.
