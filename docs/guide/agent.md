# Survival agent

`@bedboo/agent` is a scripted (no LLM) survival agent built on bedboo. It plays legit survival on a Bedrock Dedicated
Server: wood → stone tools → iron → diamonds, it builds a house from a blueprint and mines every overworld ore, while
it fights the mobs that attack it, eats, and gets out of lava and water. Everything goes through the public mineflayer
API and the ecosystem plugins (mineflayer-pathfinder, -collectblock, -tool, -armor-manager, -auto-eat, -pvp), so the
same code would drive a Java bot. It is also a large example of bedboo in use.

## Quick start {#quick-start}

```js
const { Agent } = require('@bedboo/agent')

const agent = await Agent.create({ host: '127.0.0.1', port: 19132, username: 'Agent', log: console.log })
await agent.run('obtain', { item: 'iron_pickaxe' }) // wood, stone, a furnace, iron… whatever it takes
await agent.run('build', { blueprint: 'house5x5' }) // materials obtained, verified block by block
await agent.run('mine', { all: [{ item: 'diamond' }, { item: 'emerald' }] })
agent.writeReport('report.json') // tasks, timings, deaths, fights, event log
await agent.stop()
```

The agent joins as an ordinary offline player: no operator rights, no commands.

## Options and tasks {#options}

`Agent.create(opts)` options: `host`, `port`, `username` (default `Agent`), `bot` (use an existing spawned bot),
`botOptions`, `safety` (`true` / options / `false`), `autoEat`, `keepFed` (hunt for food between tasks when hungry),
`recoverItems` (go back for the drops after a death), `log` (line sink), `skills` (registry).

`agent.run(skill, args, { timeout, retries })` runs one skill as a task; `agent.runScenario({ name, steps, timeout,
verify })` runs steps in order (stops at the first failure) and returns the report; `agent.on('event', e)` streams
`{ t, type, … }` events (`task-start`, `mine`, `craft`, `smelt`, `place`, `safety`, `death`, `log`, …).

## Skills {#skills}

A skill is `async (bot, args) => result` (`args.signal` is the runner's AbortSignal); skills never send commands.

| skill | does |
|---|---|
| `obtain` | gets `count` × `item` by any means: craft, smelt, mine, gather or hunt, recursively, planned by cost |
| `mine` | ores and stone: shafts down to deep ones, explores towards the right biome when none is loaded |
| `gather` | surface blocks: logs (`item: 'log'` = any), sand, gravel, … |
| `craft` | `bot.recipesFor` / `bot.craft`, 2×2 or a crafting table (placed and taken back) |
| `smelt` | `bot.openFurnace`; the furnace is placed and taken back |
| `build` | builds a blueprint near the bot, verifies it block by block and repairs what is wrong |
| `navigate` | pathfinder with re-planning, legs for far goals and unsticking |
| `explore` | spiral walk until a block or biome is loaded |
| `surface`, `descend`, `escape` | out of a mine, down a safe shaft, last-resort unsticking |
| `food`, `hunt`, `fish` | keep fed: hunt passive animals and cook the meat, or fish |
| `rest` | sleep through the night in the carried bed, or shelter |
| `combat`, `portal`, `nether`, `end` | fighting, portals and the other dimensions |

While a task runs, background safety behaviours fight or flee hostile mobs, get out of lava, swim up for air, eat
(through mineflayer-auto-eat), and recover after a death. The full description of the skills, the obtain planner, the
safety behaviours and the blueprint format is in the package's
[README](https://github.com/LiteLDev/bedboo/tree/main/packages/agent#readme).
