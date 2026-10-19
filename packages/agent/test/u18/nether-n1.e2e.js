'use strict'
// owner: U18 (agent combat & dimensions) — e2e on BDS: `BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent exec mocha --timeout 0 test/u18/nether-n1.e2e.js`
const { describeScenario } = require('./harness')

describeScenario(require('../../scenarios/nether/n1-portal'))
