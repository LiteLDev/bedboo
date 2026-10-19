'use strict'
// owner: U18 (agent combat & dimensions) — U18's part of the final chained run (N1 → N2 with the bot's own portal → E1),
// one world, ≈ 10 min; only with BEDBOO_U18_CHAIN=1 (or AGENT_FULL_RUN=1):
//   BEDBOO_U18_CHAIN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep CHAIN
const { describeScenario } = require('../../test/u18/harness')

if (process.env.BEDBOO_U18_CHAIN === '1' || process.env.AGENT_FULL_RUN === '1') {
  describeScenario(require('./chain'), { runs: Math.max(1, Number(process.env.BEDBOO_U18_CHAIN_RUNS) || 1) })
}
