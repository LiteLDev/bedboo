// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Running the overworld milestones on real BDS servers (@bedboo/bds harness).
 *
 * World: the scouted seed (seed.json), default generator, survival, difficulty `AGENT_DIFFICULTY` (default easy),
 * vanilla gamerules (profile 'none': mobs spawn, day and night pass). The milestone steps are cheat-free; the only
 * server-side actions are starting a server (fresh or from a snapshot) and taking snapshots.
 *
 * Snapshot chain: milestone k starts from `u17-<seed>-m<k-1>` (M1: the fresh world). The snapshot is the end state of
 * a successful run of milestone k-1 — the world *and* the player (BDS saves an offline player's inventory and position
 * under its SelfSignedId, which mineflayer-bedrock derives from the username: the bot rejoins as the same player).
 * A missing snapshot is produced on demand by running the earlier milestones (each up to `attempts` times).
 *
 * Env: AGENT_RUNS (runs per milestone, default 1), AGENT_DIFFICULTY, AGENT_REPORT_DIR (default
 * ~/.cache/bedboo/agent-reports), AGENT_REFRESH=1 (re-create the snapshots), AGENT_LOG=1 (print the event stream),
 * AGENT_SNAPSHOT_TAG (suffix of the snapshot names, to keep several chains apart).
 */
const fs = require('fs')
const os = require('os')
const path = require('path')
const { Agent } = require('../../src/runner')
const { MILESTONES } = require('./milestones')
const SEED = require('./seed.json')

const USERNAME = 'Agent'

function config () {
  return {
    seed: String(SEED.seed),
    difficulty: process.env.AGENT_DIFFICULTY || 'easy',
    reportDir: process.env.AGENT_REPORT_DIR || path.join(process.env.BEDBOO_CACHE || path.join(os.homedir(), '.cache', 'bedboo'), 'agent-reports'),
    refresh: process.env.AGENT_REFRESH === '1',
    log: process.env.AGENT_LOG === '1',
    tag: process.env.AGENT_SNAPSHOT_TAG ? `-${process.env.AGENT_SNAPSHOT_TAG}` : ''
  }
}

function snapshotName (id, cfg = config()) {
  return `u17-s${cfg.seed}-${id.toLowerCase()}${cfg.tag}`
}

function serverOptions (cfg, snapshot) {
  const base = { gamemode: 'survival', difficulty: cfg.difficulty, profile: 'none', log: () => {} }
  return snapshot ? { ...base, snapshot } : { ...base, world: 'default', seed: cfg.seed }
}

function appendRun (cfg, record) {
  fs.mkdirSync(cfg.reportDir, { recursive: true })
  fs.appendFileSync(path.join(cfg.reportDir, 'runs.jsonl'), JSON.stringify(record) + '\n')
}

/**
 * Run one milestone once on a fresh server (from the previous milestone's snapshot).
 * @param {object} milestone from milestones.js
 * @param {{ snapshotAfter?: string|null, run?: number, cfg?: object }} [opts]
 * @returns {Promise<object>} the agent report (+ `snapshot` when one was taken)
 */
async function runMilestone (milestone, { snapshotAfter = null, run = 1, cfg = config(), from } = {}) {
  const bds = require('@bedboo/bds')
  const index = MILESTONES.indexOf(milestone)
  const startSnap = from !== undefined ? from : (index > 0 ? snapshotName(MILESTONES[index - 1].id, cfg) : null)
  const server = await bds.startServer(serverOptions(cfg, startSnap))
  let agent = null
  const t0 = Date.now()
  let report
  try {
    agent = await Agent.create({
      host: server.host,
      port: server.port,
      username: USERNAME,
      log: cfg.log ? (line) => console.log(`      [${milestone.id}#${run}] ${line}`) : undefined
    })
    report = await agent.runScenario(milestone)
  } catch (err) {
    report = { name: milestone.name, ok: false, error: { code: err.code, message: err.message }, ...(agent ? agent.report() : {}) }
  } finally {
    await agent?.stop().catch(() => {})
  }
  report.milestone = milestone.id
  report.run = run
  report.from = startSnap
  report.wallMs = Date.now() - t0
  try {
    if (report.ok && snapshotAfter) {
      await server.snapshot(snapshotAfter, { overwrite: true, description: `${milestone.name}: end state of a successful run (${new Date().toISOString()})` })
      report.snapshot = snapshotAfter
    }
  } finally {
    await server.stop().catch(() => {})
  }
  const file = path.join(cfg.reportDir, `${milestone.id}-${new Date().toISOString().replace(/[:.]/g, '-')}-run${run}.json`)
  fs.mkdirSync(cfg.reportDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify(report, null, 2))
  appendRun(cfg, summary(report, file))
  return report
}

/** one line per run for the log / runs.jsonl */
function summary (report, file) {
  const failed = report.tasks?.find((t) => !t.ok)
  return {
    at: new Date().toISOString(),
    milestone: report.milestone,
    run: report.run,
    ok: report.ok,
    ms: report.ms ?? null,
    wallMs: report.wallMs,
    from: report.from,
    error: report.error?.message ?? null,
    failedTask: failed ? `${failed.name}: ${failed.error?.message}` : null,
    deaths: report.deaths?.length ?? 0,
    interventions: (report.interventions ?? []).map((i) => `${i.type}${i.target ? ` ${i.target}` : ''}: ${i.outcome}`),
    tasks: (report.tasks ?? []).map((t) => `${t.name} ${t.ok ? 'ok' : 'FAILED'} ${(t.ms / 1000).toFixed(0)}s`),
    verified: report.verified ?? null,
    report: file
  }
}

/**
 * Make sure the start snapshot of `milestone` exists (running the earlier milestones as needed).
 * @returns {Promise<string|null>} the snapshot name (null for M1)
 */
async function ensureStart (milestone, { cfg = config(), attempts = 3, log = () => {} } = {}) {
  const bds = require('@bedboo/bds')
  const index = MILESTONES.indexOf(milestone)
  if (index <= 0) return null
  const prev = MILESTONES[index - 1]
  const name = snapshotName(prev.id, cfg)
  if (!cfg.refresh && bds.readSnapshot(name)) return name
  await ensureStart(prev, { cfg, attempts, log })
  for (let i = 1; i <= attempts; i++) {
    log(`building start snapshot ${name}: ${prev.id} attempt ${i}`)
    const r = await runMilestone(prev, { snapshotAfter: name, run: `setup${i}`, cfg })
    log(`  ${prev.id} ${r.ok ? 'ok' : `failed: ${r.error?.message}`} in ${(r.wallMs / 1000).toFixed(0)} s`)
    if (r.ok) return name
  }
  throw new Error(`could not produce snapshot ${name}: ${prev.id} failed ${attempts} times`)
}

module.exports = { config, snapshotName, serverOptions, runMilestone, ensureStart, summary, USERNAME, MILESTONES }
