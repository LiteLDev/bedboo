# Scenarios

One directory per milestone family; each scenario is a module exporting
`{ name, setup?: string[], world?: string, steps: [{ skill, args?, name?, timeout? }], timeout? }`
run by `src/runner.js` (each milestone ≤ 10 min, cheat-free steps).

| Directory | Owner |
|---|---|
| `overworld/` | U17 |
| `combat/`, `nether/`, `end/` | U18 |
