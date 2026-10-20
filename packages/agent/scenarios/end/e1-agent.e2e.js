'use strict'
// owner: U18 (agent combat & dimensions) — E1A: the End phases of the final chain in its world (seed 1234) under U17's
// Agent; only with BEDBOO_U18_CHAIN_SEED=1 (or AGENT_FULL_RUN=1), BEDBOO_U18_RUNS=5 for the ≥ 4/5 gate:
//   BEDBOO_U18_CHAIN_SEED=1 BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep E1A
const assert = require('assert')
const { runE1UnderAgent, walkSummary } = require('./e1-agent')

const RUNS = Math.max(1, Number(process.env.BEDBOO_U18_RUNS) || 1)

if (process.env.BEDBOO_U18_CHAIN_SEED === '1' || process.env.AGENT_FULL_RUN === '1') {
  describe('U18 scenario E1A (the End in the chain\'s world, seed 1234, U17\'s Agent)', function () {
    this.timeout(0)
    const required = RUNS === 1 ? 1 : Math.ceil(RUNS * 0.8)
    it(`E1A: stronghold (cheat) → eyes → the End → endermen → exit (${required}/${RUNS} runs must pass)`, async function () {
      const results = []
      for (let i = 1; i <= RUNS; i++) {
        const r = await runE1UnderAgent({ log: process.env.AGENT_LOG === '1' ? (l) => console.log(`      [E1A#${i}] ${l}`) : () => {} })
        results.push(r)
        const failed = r.phases.find((p) => !p.ok)
        const walk = r.phases.find((p) => p.detail?.walk)?.detail.walk
        console.log(`      run ${i}/${RUNS}: ${r.ok ? 'PASS' : 'FAIL'} in ${(r.ms / 1000).toFixed(0)} s${failed ? ` — ${failed.name}: ${failed.error}` : ''} | ` +
          `${r.phases.map((p) => `${p.name.replace(/ \(.*\)/, '')} ${(p.ms / 1000).toFixed(0)}s${p.ok ? '' : ' ✗'}`).join(', ')} | deaths ${r.deaths}` +
          `${walk ? ` | walk up ${walkSummary(walk)}` : ''}`)
        if (process.env.BEDBOO_U18_REPORT) {
          // a failed run's agent report (its events) next to the runs' lines
          if (r.report) require('fs').writeFileSync(`${process.env.BEDBOO_U18_REPORT}.run${i}.json`, JSON.stringify(r.report, null, 1))
          require('fs').appendFileSync(process.env.BEDBOO_U18_REPORT, JSON.stringify({ scenario: 'E1A', run: i, ok: r.ok, reason: failed ? `${failed.name}: ${failed.error}` : null, ms: r.ms, steps: r.phases, deaths: r.deaths, walk, at: new Date().toISOString() }) + '\n')
        }
        if (results.filter((x) => !x.ok).length > RUNS - required) break
      }
      const passes = results.filter((r) => r.ok).length
      console.log(`      E1A: ${passes}/${results.length} passed`)
      assert.ok(passes >= required, `E1A: ${passes}/${RUNS} passed (needs ${required})`)
    })
  })
}
