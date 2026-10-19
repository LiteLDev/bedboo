'use strict'
// owner: U18 (agent combat & dimensions) — e2e on BDS (a fresh server per run):
//   corepack pnpm --filter @bedboo/agent test:e2e -- --grep N2      (BEDBOO_U18_RUNS=5: the ≥ 4/5 gate)
const { describeScenario } = require('../../test/u18/harness')

describeScenario(require('./n2-ores'))
