'use strict'
// owner: U18 (agent combat & dimensions) — N1 from U17's M3 / M5 snapshots under U17's Agent (no cheat at all); long
// (the snapshots are built first when missing), so only with BEDBOO_U18_FROM_M3=1 / BEDBOO_U18_FROM_M5=1 (or
// AGENT_FULL_RUN=1); BEDBOO_U18_RUNS=5 for the ≥ 4/5 gate:
//   BEDBOO_U18_FROM_M3=1 BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1M3
//   BEDBOO_U18_FROM_M5=1 BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep N1M5
const assert = require('assert')
const { runMilestone, ensureStart, snapshotName, MILESTONES, config } = require('../overworld/harness')
const { N1M3, N1M5 } = require('./n1-from-m3')

const RUNS = Math.max(1, Number(process.env.BEDBOO_U18_RUNS) || 1)
const log = (m) => console.log(`      ${m}`)

/** the snapshot after `milestoneId` (M3 → u17-s1234-m3), built by running the milestones up to it when missing */
async function snapshotAfter (milestoneId) {
  const bds = require('@bedboo/bds')
  const cfg = config()
  const index = MILESTONES.findIndex((m) => m.id === milestoneId)
  const next = MILESTONES[index + 1]
  if (next) return ensureStart(next, { log })
  const name = snapshotName(milestoneId, cfg)
  if (!cfg.refresh && bds.readSnapshot(name)) return name
  const m = MILESTONES[index]
  await ensureStart(m, { log })
  for (let i = 1; i <= 3; i++) {
    const r = await runMilestone(m, { snapshotAfter: name, run: `setup${i}` })
    log(`building ${name}: ${m.id} ${r.ok ? 'ok' : `failed: ${r.error?.message}`}`)
    if (r.ok) return name
  }
  throw new Error(`could not produce snapshot ${name}`)
}

function gate (scenario, from) {
  const required = RUNS === 1 ? 1 : Math.ceil(RUNS * 0.8)
  it(`${scenario.id}: second bucket, iron ingot, portal → the nether (${required}/${RUNS} runs must pass)`, async function () {
    const start = await snapshotAfter(from)
    const results = []
    for (let i = 1; i <= RUNS; i++) {
      const report = await runMilestone(scenario, { from: start, run: i })
      results.push(report)
      const failed = (report.tasks ?? []).findLast((t) => !t.ok)
      console.log(`      run ${i}/${RUNS}: ${report.ok ? 'PASS' : 'FAIL'} in ${(report.wallMs / 1000).toFixed(0)} s` +
        (report.ok ? '' : ` — ${report.error?.message ?? failed?.error?.message}`) +
        ` | ${(report.tasks ?? []).map((t) => `${t.name} ${(t.ms / 1000).toFixed(0)}s${t.ok ? '' : ' ✗'}`).join(', ')}` +
        ` | deaths ${report.deaths?.length ?? 0}`)
      if (process.env.BEDBOO_U18_REPORT) {
        require('fs').appendFileSync(process.env.BEDBOO_U18_REPORT, JSON.stringify({ scenario: scenario.id, run: i, ok: report.ok, error: report.error?.message ?? null, ms: report.wallMs, tasks: (report.tasks ?? []).map((t) => ({ name: t.name, ok: t.ok, ms: t.ms, error: t.error?.message })), deaths: report.deaths?.length ?? 0, at: new Date().toISOString() }) + '\n')
      }
      if (results.filter((r) => !r.ok).length > RUNS - required) break
    }
    const passes = results.filter((r) => r.ok).length
    console.log(`      ${scenario.id}: ${passes}/${results.length} passed`)
    assert.ok(passes >= required, `${scenario.id}: ${passes}/${RUNS} runs passed (needs ${required}): ${results.filter((r) => !r.ok).map((r) => r.error?.message).join(' ; ')}`)
  })
}

if (process.env.BEDBOO_U18_FROM_M3 === '1' || process.env.AGENT_FULL_RUN === '1') {
  describe('U18 scenario N1M3 (from U17\'s M3 snapshot, U17\'s Agent)', function () {
    this.timeout(0)
    gate(N1M3, 'M3')
  })
}

if (process.env.BEDBOO_U18_FROM_M5 === '1' || process.env.AGENT_FULL_RUN === '1') {
  describe('U18 scenario N1M5 (from U17\'s M5 snapshot: far from the spawn, underground; U17\'s Agent)', function () {
    this.timeout(0)
    gate(N1M5, 'M5')
  })
}
