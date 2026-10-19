// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Overworld milestones on real BDS (mocha e2e):
 *
 *   corepack pnpm --filter @bedboo/agent test:e2e -- --grep M1          # one run of M1
 *   AGENT_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep M3   # the gate: ≥ 4 of 5 runs
 *   AGENT_FULL_RUN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep "full run"
 *
 * Each run starts a fresh server from the previous milestone's snapshot (harness.js) and must pass its verify()
 * within the milestone's 10-minute limit. Failure reasons and timings are printed and appended to
 * $AGENT_REPORT_DIR/runs.jsonl.
 */
const assert = require('assert')
const { MILESTONES } = require('./milestones')
const { config, snapshotName, runMilestone, ensureStart, summary, rebuilt } = require('./harness')

describe('overworld milestones (U17)', function () {
  this.timeout(0)
  const cfg = config()

  for (const milestone of MILESTONES) {
    it(`${milestone.id}: ${milestone.name}`, async function () {
      const bds = require('@bedboo/bds')
      const runs = Math.max(1, Number(process.env.AGENT_RUNS || 1))
      await ensureStart(milestone, { cfg, log: (line) => console.log(`      ${line}`) })
      const results = []
      for (let run = 1; run <= runs; run++) {
        const own = snapshotName(milestone.id, cfg)
        const snapshotAfter = (!bds.readSnapshot(own) || (cfg.refresh && !rebuilt.has(own))) ? own : null
        const r = await runMilestone(milestone, { run, snapshotAfter, cfg })
        const s = summary(r, null)
        const inTime = r.ok && r.ms <= milestone.timeout
        results.push({ ...s, inTime })
        console.log(`      ${milestone.id} run ${run}/${runs}: ${inTime ? 'PASS' : 'FAIL'} ${((r.ms ?? r.wallMs) / 1000).toFixed(0)} s` +
          `${r.ok ? '' : ` — ${s.failedTask ?? s.error}`}${s.deaths ? `, ${s.deaths} death(s)` : ''}` +
          `${s.interventions.length ? `, safety: ${s.interventions.join('; ')}` : ''}`)
        console.log(`        tasks: ${s.tasks.join(' | ')}`)
        if (r.verified) console.log(`        verified: ${JSON.stringify(r.verified)}`)
      }
      const passed = results.filter((r) => r.inTime).length
      const needed = runs === 1 ? 1 : Math.ceil(runs * 0.8)
      console.log(`      ${milestone.id}: ${passed}/${runs} passed (need ${needed}); times ${results.map((r) => `${((r.ms ?? r.wallMs) / 1000).toFixed(0)}s`).join(', ')}`)
      assert.ok(passed >= needed, `${milestone.id}: ${passed}/${runs} runs passed: ${results.filter((r) => !r.inTime).map((r) => r.failedTask ?? r.error ?? `too slow (${r.ms} ms)`).join(' / ')}`)
    })
  }

  it('full run M1→M5 in one world (AGENT_FULL_RUN=1)', async function () {
    if (process.env.AGENT_FULL_RUN !== '1') this.skip()
    const { fullRun } = require('./full-run')
    const r = await fullRun({ cfg, log: (line) => { if (cfg.log || line.startsWith('==')) console.log(`      ${line}`) } })
    console.log(`      full run: ${r.ok ? 'PASS' : 'FAIL'} in ${(r.ms / 60000).toFixed(1)} min — ${r.milestones.map((m) => `${m.id} ${(m.ms / 1000).toFixed(0)}s${m.ok ? '' : ' FAILED'}`).join(', ')}; report ${r.report}`)
    assert.ok(r.ok, r.milestones.map((m) => `${m.id}: ${m.error ?? 'ok'}`).join('; '))
  })
})
