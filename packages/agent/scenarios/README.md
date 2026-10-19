# Scenarios

One directory per milestone family. A scenario is a module exporting
`{ id?, name, steps: [{ skill, args?, name?, timeout?, retries? }], timeout?, verify?(agent, startInventory) }`
run by `Agent#runScenario` (src/runner.js); steps are cheat-free skill calls, `verify` checks the outcome. Each
milestone ≤ 10 min.

| Directory | Owner | |
|---|---|---|
| `overworld/` | U17 | M1–M5 (`milestones.js`), the e2e harness (`harness.js`, `milestones.e2e.js`), `full-run.js`, `seed.json` |
| `combat/`, `nether/`, `end/` | U18 | |

e2e files are `*.e2e.js` (`corepack pnpm --filter @bedboo/agent test:e2e`, config `.mocharc.e2e.json`); unit tests
stay in `test/`.
