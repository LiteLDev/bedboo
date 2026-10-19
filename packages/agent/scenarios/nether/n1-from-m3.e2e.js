'use strict'
// owner: U18 (agent combat & dimensions) — N1 from U17's M3 snapshot under U17's Agent (no cheat at all); long (the M3
// snapshot is built first when missing), so only with BEDBOO_U18_FROM_M3=1 (or AGENT_FULL_RUN=1):
//   BEDBOO_U18_FROM_M3=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1M3
const assert = require('assert')
const { runMilestone, ensureStart, MILESTONES } = require('../overworld/harness')
const { N1M3 } = require('./n1-from-m3')

if (process.env.BEDBOO_U18_FROM_M3 === '1' || process.env.AGENT_FULL_RUN === '1') {
  describe('U18 scenario N1M3 (from U17\'s M3 snapshot, U17\'s Agent)', function () {
    this.timeout(0)
    it('N1M3: second bucket, iron ingot, back to the spawn, portal → the nether', async function () {
      const m4 = MILESTONES.find((m) => m.id === 'M4')
      const from = await ensureStart(m4, { log: (m) => console.log(`      ${m}`) }) // = the M3 end-state snapshot
      const report = await runMilestone(N1M3, { from })
      for (const t of report.tasks ?? []) console.log(`      ${t.name}: ${t.ok ? 'ok' : `FAILED ${t.error?.message}`} ${(t.ms / 1000).toFixed(0)} s`)
      assert.ok(report.ok, `N1M3 failed: ${report.error?.message ?? (report.tasks ?? []).find((t) => !t.ok)?.error?.message}`)
    })
  })
}
