# Scenarios

One directory per milestone family. A scenario is a module exporting
`{ id?, name, steps: [{ skill, args?, name?, timeout?, retries? }], timeout?, verify?(agent, startInventory) }`
run by `Agent#runScenario` (src/runner.js); steps are cheat-free skill calls, `verify` checks the outcome. Each
milestone ≤ 10 min.

| Directory | Owner | |
|---|---|---|
| `overworld/` | U17 | M1–M5 (`milestones.js`), the e2e harness (`harness.js`, `milestones.e2e.js`), `full-run.js`, the final chain (`final-chain.js`: M1 → camp → M2 → gear → victuals → M3 → M4 → M5 → provisions → N1M3 → home → E1, see [../README.md](../README.md#the-final-chain)), `seed.json`; B1 (`build-repair.js` + `.e2e.js`, FINAL-ROUND): the build's block-by-block repair on BDS — house5x5 on a flat world with a cow in a floor cell, 5 refused placements and a griefed wall block (`--grep B1`, `BEDBOO_U18_RUNS` runs) |
| `combat/`, `nether/`, `end/` | U18 | C1 / N1 / N2 / E1 / chain scenarios + their `*.e2e.js`, `seed.json` per directory (section below) |

e2e files are `*.e2e.js` (`corepack pnpm --filter @bedboo/agent test:e2e`, config `.mocharc.e2e.json`); unit tests
stay in `test/`.

## Combat & dimensions (U18)

Skills (`src/skills/`, public mineflayer API + mineflayer-pathfinder only; helpers in `src/dims/`):

| skill | args | what the bot does |
|---|---|---|
| `combat` | `{ mode: 'nearby' \| 'hunt' \| 'survive', radius?, names?, mob?, count?, durationMs? }` | fight everything around / hunt `count` × `mob` / stand guard; melee with the best weapon, the bow for far or flying mobs, shield = sneak when cornered, hit-and-run vs creepers, retreat and eat when low, never steps into lava or off a ledge |
| `portal` | `{ obsidian?: 10, origin?, axis?, enter?: true, lava?: [{x,y,z}], water?: [{x,y,z}], obsidianMs?, stallMs?, flintMs? }` | bucket-cast obsidian at a lava pool (fill buckets, pour lava into a dug mold, water next to it, take the water back, mine with a diamond pickaxe), build a 4×5 frame (10 obsidian + 2 scaffolding corners), craft a flint and steel (flint from gravel), light it, walk in. Bounded everywhere: night ahead and no armor → a sealed pocket / pit until the morning; up to the surface first; pools ranked (open sky, sources, distance), each left after `stallMs` (150 s) without a new obsidian; then the `lava` hints (known pools), natural obsidian, a surface spiral; 10 min in all (`obsidianMs`), every bucket fill ≤ 6 walks; eats standing still (auto-eat vs the pathfinder), a fight-only retry, lava fills from a cell with no lava around it, a pause when hurt |
| `nether` | `{ targets?: { quartz_ore, nether_gold_ore, ancient_debris }, returnHome?: true, portal?, home?, debrisY?, timeMs?: 12 min, homeMs?: 5 min, oreMs? }` | through the portal (walks back to the remembered one first), gold armor on (piglins; kept on: a fight's `equipForCombat` never swaps the gold piece for iron in the Nether, and it goes back on when something took it off), mine quartz, ancient debris (buried, above the lava ocean first, then y 8–22, branch mining when none in reach) and nether gold (out of piglins' sight), guard against nether mobs (`netherGuard`; under an Agent: fireballs hit back, neutral attackers fought through its safety — a piglin never while the bot wears gold, unless it hit the bot with no other mob to blame; no arrows with piglins / zombified piglins within 24 blocks; hoglins fought with a retreat and a meal at low health, fled from at ≤ 8 hp), back home along its breadcrumbs. Each ore has its share of the time and a failed ore never strands the bot: it goes home anyway (`failed` in the result). Started in the overworld with nothing to mine (the retry after a death in the Nether) → home already; without a pickaxe for the ores → a clear error |
| `end` | `{ phase?: 'activate' \| 'fight' \| 'exit', endermen?: 2, walkMs?: 150 s, walkStallMs?: 15 s, walkWays? }` | eyes of ender into the stronghold frames (a walk to a frame that stalls: clicked from where the bot is when in reach, else walked to again), into the End, from the arrival platform up to the island top (`toIslandTop`: another way after a 15 s stall — the pathfinder without placements, then the bot's own staircase / drop / bridge / pillar steps; [the walk up](../README.md#the-end-walk-up)), kill endermen (one at a time, healed up in between; under an Agent angry endermen are fought through its safety), exit portal → credits → overworld (knocked into the portal before its own step in: exited too; a death is not); the walks into portals wait on the lifecycle (`util.tick`), not on bare ticks |

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
BEDBOO_U18_FROM_M5=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1M5 # the same from U17's M5 snapshot (the chain's start)
BEDBOO_U18_CHAIN_SEED=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep E1A # end/e1-agent.e2e.js: the chain's End phases, seed 1234
node scenarios/nether/scout.js --pools 1234 -630,100 --out scenarios/nether/seed-1234.json  # lava pools, obsidian, stronghold
```

(`BEDBOO_U18_RUNS=5` applies to N1M3 / N1M5 / E1A too.)

The scenarios run on their own servers through `test/u18/harness.js` (a mineflayer-bedrock bot with the `bot.test`
helpers, the skills through `runSkill`); under U17's `Agent` the same skills use the Agent's safety behaviours as their
guard (`combat.guardFor`).

| scenario | world | cheat-assisted |
|---|---|---|
| C1 survive the night | flat, normal, midnight, natural spawns | kit, time |
| N1 nether entry | seed 35 (lava pool 28 blocks from the spawn) | kit (stands in for U17's M3 end state) |
| N1M3 nether entry from M3 | U17's seed 1234, M3 snapshot (≈ 200 s before nightfall), U17's Agent | no command: second bucket and an iron ingot via U17's `obtain`, `portal` with seed-1234.json's scouted lava pool / lake as hints |
| N1M5 nether entry from M5 | U17's seed 1234, M5 snapshot (≈ 135 blocks west of the spawn, y 1–7), U17's Agent | the same as N1M3 — the final chain's real starting point |
| E1A the End in the chain's world | seed 1234 (stronghold portal room at −872, −34, 198), easy, U17's Agent | E1's locate + teleports, the chain's kit (12 eyes, food) + the End's fight gear (diamond sword / armor) when missing, the chain bot's gear (iron sword, pickaxes) as a stand-in, `/kill` of the dragon |
| N2 nether ores | seed 35, normal | kit, the overworld portal frame (`/setblock`) |
| E1 the End | seed 35 (stronghold portal room at 1703, -4, -869), normal | `/locate` + teleports into the portal room, kit (12 eyes), `/kill` of the ender dragon |
| chain | seed 35, easy | N1's kit, then E1's stronghold teleport + eyes and the dragon kill |

### Results (FINAL-FIX-AGENT-B, BDS 1.26.51.1, 2026-10-20)

Five runs each on main with FINAL-FIX-AGENT-A (#32) under it; wall time per run in seconds, ✗ = failed (reason below).

| scenario | passed | wall time per run (s) | notes |
|---|---|---|---|
| C1 survive the night | 5/5 | 304, 305, 305, 304, 304 | |
| N1 nether entry (seed 35) | 5/5 | 173, 187, 184, 175, 191 | before the pool-rim fixes 0/4: every run slid off the rim into a taken source's hole at 90 s |
| N2 nether ores | 5/5 | 120, 75, 76, 132, 68 | |
| E1 the End (seed 35) | 5/5 | 144, 70, 93, 117, 79 | |
| E1A the End in seed 1234 (Agent) | 5/5 | 67, 81, 69, 136, 74 | no deaths |
| N1M3 from M3 (Agent) | 5/5 | 954, 969, 959, 1001, 960 | ≈ 10 min of each in a night shelter (the snapshot is ≈ 200 s before nightfall); no deaths |
| N1M5 from M5 (Agent) | 4/5, 4/5 | 459, 463, 461, 476, ✗; 466, 467, ✗, 469, 570 | ✗: a death in the lava pool between two fills (before the rim fixes); two creeper blasts at dawn at 9.6 hp (the snapshot's health). On the final code 0/2 so far: both stuck in U17's `obtain` of the second bucket before the portal (the surface climb holds rotten flesh instead of a block: auto-eat) |
| N1M5H from M5 + back home, nether ores (Agent) | 0/2 | 612 ✗, 484 ✗ | #1: the Nether reached (portal 326 s), 3 quartz in 67 s, then slain by a piglin (no gold armor; mining near piglins) — the retry stopped at once with "no pickaxe … (lost in a death?)"; #2: U17's `obtain` as above |

### Results (POLISH-AGENT, BDS 1.26.51.1, 2026-10-20)

- **E1A, the End phases** (seed 1234, the Agent; a run now also fails when the walk up from the arrival platform stood
  still for over 60 s). 29/30 runs passed in three batches of 10: 9/10, then 10/10, then 10/10 on the final End code.
  - Every walk up took 29–30 s in 3 hops, with no stall; the longest stand-still was 1 s.
  - The one failure was a death in the endermen fight (batch 1). Failed runs now keep the agent's report
    (`$BEDBOO_U18_REPORT.run<i>.json`).
  - Root cause of the walk's earlier 5-minute stalls, and the fallback ways, in
    [../README.md](../README.md#the-end-walk-up).
- **`final-chain --nether-ores`** (M1 → … → M5 → gold armor → provisions → N1M3 → Nether ores + home → E1): see
  [../README.md](../README.md#--nether-ores). Runs that passed end to end:
  ores-3 52.1 min, ores-4 47.7 min, ores-r2 39.6 min, ores-r3 43.9 min and, on the final code, ores-f1 43.2 min.
  One run between them (ores-r1) failed in the overworld: no food, then deaths in M3. That is 6 of 8 full runs.
  - The Nether's ores took 44–49 s per trip: 3 quartz, 1 ancient debris, 3 nether gold next to the bot's portal,
    and back home.
  - Before the portal fix, 1 of 2 runs passed. The one failure was in N1M3: the walk back from the flint pit stalled.
- **Default `final-chain`** (regression): 4 of 7 passed.
  - Rebased on POLISH-LIB: default-r2 42.0 min, default-r3 41.6 min, and on the final code default-f1 36.5 min.
  - default-1 failed: endermen at the exit fountain (→ the exit change).
  - default-r1 failed: drowned under a flooded cave's ceiling in M4's climb (→ the safety digs up there).
  - default-f2 failed: U17's build left 1 of 125 blocks wrong in M4, after a stalled walk and two refused placements.
- **E1A after the rebase:** 10/10 more runs on the rebased code and 10/10 on the final code (70–106 s each, walk up
  29–34 s, no stall). That is 49/50 in all.

### Results (FINAL-ROUND, BDS 1.26.51.1, 2026-10-20/21)

These are the final acceptance runs, on the merged final code 77314f1 (#43): seed 1234, easy, a fresh world per run,
two at a time. Per-run phase times and the failures fixed on the way are in
[../README.md](../README.md#final-acceptance-final-round).

| scenario | target | result |
|---|---|---|
| default `final-chain` (M1 → … → E1) | ≥ 4/5 | **4/5** — 46.1, 35.7, 40.3, 37.1 min; X2 failed in N1M3: no diamond pickaxe left (it burned in a covered lava pocket at the spawn during provisions) |
| `final-chain --nether-ores` | ≥ 2/3 | **3/3** — 36.7, 44.0, 46.8 min; Nether ores and home in 46–50 s; no deaths |
| E1A, the End phases (the Agent, seed 1234) | ≥ 9/10 | **10/10** — 69–141 s; walk up 29–30 s, 3 hops, no stall |
| M1 – M5 gates | ≥ 4/5 each | **M1–M4 5/5, M5 4/5**. M5 run 2 died 4 times at night on the way to the mountains (the gate's snapshot has no armor) |
| B1, the build's repair (`--grep B1`) | | **6/6** — 21–23 s; a cow in a floor cell, 5 refused placements and a griefed wall block, repaired in one round |

The fixes made during the acceptance, each of which restarted the counts it affected:
- **#39**: a hunt makes room for its drops (a provisions phase had all 36 slots taken).
- **#40**: a `victuals` phase before the mines, and a meal between fights against mobs out of reach (M3 deaths with no
  food).
- **#41**: the surface climb leaves out the fights' time (M4 timed out at y 39).
- **#42**: the End walk-in survives a silverfish fight (E1A), and the obsidian drop is followed out of the mold (N1M3).
- **#43**: a fight gives way to a closer mob hitting the bot (deaths in the gear phase).

On #41's code the E1A score was 8/10:
- one walk-in timeout, fixed by #42;
- one death to endermen at the exit (not changed).
