'use strict'
// owner: FINAL-ROUND — e2e on BDS (a fresh flat server per run):
//   corepack pnpm --filter @bedboo/agent test:e2e -- --grep B1      (BEDBOO_U18_RUNS=3: runs)
const { describeScenario } = require('../../test/u18/harness')

describeScenario(require('./build-repair'))
