'use strict'
// owner: U18 (agent combat & dimensions) — U18's part of the final chained run (N1 → N2 with the bot's own portal → E1), one world:
// `npx mocha --no-config --timeout 0 test/u18/chain.e2e.js` (not part of the per-scenario gate; ~10 min)
const { describeScenario } = require('./harness')

describeScenario(require('../../scenarios/nether/chain'), { runs: Math.max(1, Number(process.env.BEDBOO_U18_CHAIN_RUNS) || 1) })
