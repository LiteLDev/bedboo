#!/usr/bin/env node
// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * One chained, cheat-free run of the overworld milestones M1 → M5 in a single fresh world (seed.json), one bot, no
 * snapshots and no reconnects in between — the coordinator's final acceptance run.
 *
 *   node packages/agent/scenarios/overworld/full-run.js [--from M1] [--to M5] [--log]
 *
 * Prints the timing of every milestone and writes the full report to $AGENT_REPORT_DIR (default
 * ~/.cache/bedboo/agent-reports/full-run-<time>.json). Exit code 0 when every milestone passed.
 */
const fs = require('fs')
const path = require('path')
const { Agent } = require('../../src/runner')
const { MILESTONES } = require('./milestones')
const { config, serverOptions, snapshotName, USERNAME } = require('./harness')

/**
 * @param {{ from?: string, to?: string, log?: (line: string) => void, cfg?: object }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, milestones: object[], report: string }>}
 */
async function fullRun ({ from = 'M1', to = 'M5', log = () => {}, cfg = config() } = {}) {
  const bds = require('@bedboo/bds')
  const a = MILESTONES.findIndex((m) => m.id === String(from).toUpperCase())
  const b = MILESTONES.findIndex((m) => m.id === String(to).toUpperCase())
  if (a < 0 || b < a) throw new Error(`bad milestone range ${from}..${to} (M1..M5)`)
  const list = MILESTONES.slice(a, b + 1)
  // from M1: a fresh world; from Mk: the end state of M(k-1) (its snapshot, see harness.js)
  const startSnapshot = a > 0 ? snapshotName(MILESTONES[a - 1].id, cfg) : null
  if (startSnapshot && !bds.readSnapshot(startSnapshot)) throw new Error(`snapshot ${startSnapshot} is missing: run the milestones up to ${MILESTONES[a - 1].id} first`)
  const server = await bds.startServer(serverOptions(cfg, startSnapshot))
  const t0 = Date.now()
  const milestones = []
  let agent = null
  try {
    agent = await Agent.create({ host: server.host, port: server.port, username: USERNAME, log: (line) => log(line) })
    for (const m of list) {
      const r = await agent.runScenario(m)
      milestones.push({ id: m.id, ok: r.ok, ms: r.ms, withinLimit: r.ms <= m.timeout, error: r.error?.message ?? null, verified: r.verified ?? null })
      log(`== ${m.id} ${r.ok ? 'passed' : `FAILED (${r.error?.message})`} in ${(r.ms / 1000).toFixed(0)} s`)
      if (!r.ok) break
    }
  } finally {
    await agent?.stop().catch(() => {})
    await server.stop().catch(() => {})
  }
  const ok = milestones.length === list.length && milestones.every((m) => m.ok)
  const file = path.join(cfg.reportDir, `full-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(cfg.reportDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ok, ms: Date.now() - t0, seed: cfg.seed, difficulty: cfg.difficulty, milestones, report: agent?.report() }, null, 2))
  return { ok, ms: Date.now() - t0, milestones, report: file }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (name, def) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : def }
  const verbose = args.includes('--log')
  fullRun({ from: opt('--from', 'M1'), to: opt('--to', 'M5'), log: (line) => { if (verbose || line.startsWith('==')) console.log(line) } })
    .then((r) => {
      console.log(`full run ${r.ok ? 'PASSED' : 'FAILED'} in ${(r.ms / 60000).toFixed(1)} min`)
      for (const m of r.milestones) console.log(`  ${m.id}: ${m.ok ? 'ok' : 'FAILED'} ${(m.ms / 1000).toFixed(0)} s${m.error ? ` — ${m.error}` : ''}`)
      console.log(`report: ${r.report}`)
      process.exit(r.ok ? 0 : 1)
    }, (err) => { console.error(err); process.exit(1) })
}

module.exports = { fullRun }
