# @bedboo/agent

Scripted (no LLM) survival agent for mineflayer-bedrock. It drives a bot through milestones —
wood → tools → iron → diamond, a house, every ore, a self-built Nether portal, the Nether, The End
(cheat-assisted setup) and mob fights — using only the public mineflayer API and the unchanged
ecosystem plugins (mineflayer-pathfinder, -pvp, -collectblock, -tool, -armor-manager, -auto-eat).

## Skill interface

```js
// src/skills/<name>.js
module.exports = async function mySkill (bot, args) {
  // bot:  a spawned mineflayer-bedrock bot (public API only, never bot._client)
  // args: JSON-serialisable options + args.signal (AbortSignal set by the runner on timeout)
  return { /* JSON-serialisable result */ } // throw a descriptive Error on failure
}
```

Skills are cheat-free; cheat-assisted prerequisites (e.g. End setup, world snapshots) are scenario
`setup` steps executed by the test harness. Registry: `src/skills/index.js`.

| Skill | Owner | Purpose |
|---|---|---|
| navigate, gather, craft, smelt, mine, build | U17 | overworld progression |
| combat, portal, nether, end | U18 | fighting and dimensions |

## Runner

```js
const { runScenario } = require('@bedboo/agent')
const report = await runScenario(bot, {
  name: 'wooden-tools',
  steps: [
    { skill: 'gather', args: { item: 'oak_log', count: 4 } },
    { skill: 'craft', args: { item: 'wooden_pickaxe' } }
  ]
})
// report = { name, ok, results: [{ name, skill, ok, result | error, ms }] }
```

Scenarios live in `scenarios/overworld/**` (U17) and `scenarios/{combat,nether,end}/**` (U18).
