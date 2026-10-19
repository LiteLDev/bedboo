# Scenarios

One directory per milestone family. A scenario is a module exporting
`{ id?, name, steps: [{ skill, args?, name?, timeout?, retries? }], timeout?, verify?(agent, startInventory) }`
run by `Agent#runScenario` (src/runner.js); steps are cheat-free skill calls, `verify` checks the outcome. Each
milestone ≤ 10 min.

| Directory | Owner | |
|---|---|---|
| `overworld/` | U17 | M1–M5 (`milestones.js`), the e2e harness (`harness.js`, `milestones.e2e.js`), `full-run.js`, `seed.json` |
| `combat/`, `nether/`, `end/` | U18 | C1 / N1 / N2 / E1 / chain scenarios + their `*.e2e.js`, `seed.json` per directory (section below) |

e2e files are `*.e2e.js` (`corepack pnpm --filter @bedboo/agent test:e2e`, config `.mocharc.e2e.json`); unit tests
stay in `test/`.

## Combat & dimensions (U18)

Skills (`src/skills/`, public mineflayer API + mineflayer-pathfinder only; helpers in `src/dims/`):

| skill | args | what the bot does |
|---|---|---|
| `combat` | `{ mode: 'nearby' \| 'hunt' \| 'survive', radius?, names?, mob?, count?, durationMs? }` | fight everything around / hunt `count` × `mob` / stand guard; melee with the best weapon, the bow for far or flying mobs, shield = sneak when cornered, hit-and-run vs creepers, retreat and eat when low, never steps into lava or off a ledge |
| `portal` | `{ obsidian?: 10, origin?, axis?, enter?: true }` | bucket-cast obsidian at a lava pool (fill buckets, pour lava into a dug mold, water next to it, take the water back, mine with a diamond pickaxe), build a 4×5 frame (10 obsidian + 2 scaffolding corners), craft a flint and steel (flint from gravel), light it, walk in |
| `nether` | `{ targets?: { quartz_ore, nether_gold_ore, ancient_debris }, returnHome?: true, portal?, home?, debrisY? }` | through the portal, gold armor on (piglins), mine quartz, ancient debris (buried, above the lava ocean first, then y 8–22, branch mining when none in reach) and nether gold (out of piglins' sight), guard against nether mobs, back home along its breadcrumbs |
| `end` | `{ phase?: 'activate' \| 'fight' \| 'exit', endermen?: 2 }` | eyes of ender into the stronghold frames, into the End, kill endermen, exit portal → credits → overworld |

Library API for runners (`require('@bedboo/agent/src/skills/combat')`): `defend(bot, opts) → guard` (the background
safety behaviour: `guard.busy`, `await guard.idle()`, `guard.pause()` / `resume()`, `await guard.stop() → stats`),
`guarded(guard, fn)` (re-runs an action a fight interrupted), `fightNearby`, `huntFor(bot, mob, count)`, `survive`,
`fight` / `fightAll` (U16b). `portal.obtainObsidian / buildPortal / lightPortal / enterPortal`, the pure planners
`portal.planPortalFrame / findPortalSite / planMold`, and `src/dims/memory` (`portalIn(bot, dimension)`: the portals
the bot used).

Scenarios (`scenarios/{combat,nether,end}/*.js`, seeds in each `seed.json`) extend the format above with `server`
(startServer options), `kit` / `setup` / `prepare` (cheat-assisted setup, documented in
[docs/differences/U18.md](../../../docs/differences/U18.md#cheat-assisted)), `steps` (skills, plus `{ console }`
cheat steps run by the harness) and `check`. E2E on BDS, a fresh server per run (`BEDBOO_U18_RUNS=5` for the ≥ 4/5
gate, `BEDBOO_U18_REPORT=<file>` appends every run as JSON, `BEDBOO_AGENT_LOG=1` streams the agent's log):

```sh
export BEDBOO_MAX_SERVERS=10 BEDBOO_WORKER_SLOTS=2
BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep C1      # combat/night.e2e.js: survive the night
BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1      # nether/n1.e2e.js: portal → nether
BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N2      # nether/n2.e2e.js: nether ores, back home
BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep E1      # end/e1.e2e.js: the End (cheat-assisted)
BEDBOO_U18_CHAIN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep CHAIN  # nether/chain.e2e.js: N1 → N2 → E1 in one world
BEDBOO_U18_FROM_M3=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1M3 # nether/n1-from-m3.e2e.js: N1 from U17's M3 snapshot
```

The scenarios run on their own servers through `test/u18/harness.js` (a mineflayer-bedrock bot with the `bot.test`
helpers, the skills through `runSkill`); under U17's `Agent` the same skills use the Agent's safety behaviours as their
guard (`combat.guardFor`).

| scenario | world | cheat-assisted |
|---|---|---|
| C1 survive the night | flat, normal, midnight, natural spawns | kit, time |
| N1 nether entry | seed 35 (lava pool 28 blocks from the spawn) | kit (stands in for U17's M3 end state) |
| N1M3 nether entry from M3 | U17's seed 1234, M3 snapshot, U17's Agent | nothing: second bucket and an iron ingot via U17's `obtain`, back to the spawn, `portal` |
| N2 nether ores | seed 35, normal | kit, the overworld portal frame (`/setblock`) |
| E1 the End | seed 35 (stronghold portal room at 1703, -4, -869), normal | `/locate` + teleports into the portal room, kit (12 eyes), `/kill` of the ender dragon |
| chain | seed 35, easy | N1's kit, then E1's stronghold teleport + eyes and the dragon kill |
