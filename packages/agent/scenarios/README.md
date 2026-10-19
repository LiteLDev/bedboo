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
cd packages/agent
BEDBOO_U18_RUNS=5 npx mocha --no-config --timeout 0 test/u18/combat.e2e.js     # C1 survive the night
BEDBOO_U18_RUNS=5 npx mocha --no-config --timeout 0 test/u18/nether-n1.e2e.js  # N1 portal → nether
BEDBOO_U18_RUNS=5 npx mocha --no-config --timeout 0 test/u18/nether-n2.e2e.js  # N2 nether ores, back home
BEDBOO_U18_RUNS=5 npx mocha --no-config --timeout 0 test/u18/end-e1.e2e.js     # E1 the End (cheat-assisted)
```

| scenario | world | cheat-assisted |
|---|---|---|
| C1 survive the night | flat, normal, midnight, natural spawns | kit, time |
| N1 nether entry | seed 35 (lava pool 28 blocks from the spawn) | kit (stands in for U17's M3 end state) |
| N2 nether ores | seed 35, normal | kit, the overworld portal frame (`/setblock`) |
| E1 the End | seed 35 (stronghold portal room at 1703, -4, -869), normal | `/locate` + teleports into the portal room, kit (12 eyes), `/kill` of the ender dragon |
