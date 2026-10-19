#!/usr/bin/env node
// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * The final acceptance chain, ONE world (seed.json, seed 1234), ONE bot, no reconnects:
 *
 *   M1 → M2 → M3 → M4 → M5      U17's overworld milestones (cheat-free)
 *   N1M3                        U18's nether entry from the M3 state (cheat-free: second bucket, iron ingot, back to the
 *                               spawn, bucket-cast obsidian, build + light the portal, enter the Nether)
 *   home                        back through the bot's own portal (U18's nether skill; `--nether-ores` also mines
 *                               quartz / nether gold / ancient debris on the way, like N2)
 *   E1 stronghold               U18's toPortalRoom (CHEAT-ASSISTED: locate + teleport into the portal room, 12 eyes of
 *                               ender and food given; documented in docs/differences/U18.md)
 *   E1 activate / fight / exit  U18's end skill: eyes into the frames, into the End, (cheat) the dragon is killed with
 *                               /kill, two endermen fought, the exit portal → back in the overworld
 *
 *   node packages/agent/scenarios/overworld/final-chain.js [--log] [--nether-ores] [--difficulty easy]
 *   AGENT_FINAL_CHAIN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep "final chain"
 *
 * Prints every phase's time; the full report (events, tasks, deaths, fights) goes to $AGENT_REPORT_DIR
 * (default ~/.cache/bedboo/agent-reports/final-chain-<time>.json). Exit code 0 when every phase passed.
 */
const fs = require('fs')
const path = require('path')
const { Agent } = require('../../src/runner')
const { MILESTONES } = require('./milestones')
const { config, serverOptions, USERNAME } = require('./harness')

const NETHER_ORES = { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 }

/**
 * @param {{ log?: (line: string) => void, cfg?: object, netherOres?: boolean }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, phases: object[], report: string }>}
 */
async function finalChain ({ log = () => {}, cfg = config(), netherOres = false } = {}) {
  const bds = require('@bedboo/bds')
  const { N1M3 } = require('../nether/n1-from-m3')
  const e1 = require('../end/e1-end')
  const server = await bds.startServer(serverOptions(cfg, null))
  const t0 = Date.now()
  const phases = []
  let agent = null
  /** one phase: { name, ok, ms, error?, detail? }; returns whether it passed */
  const phase = async (name, fn) => {
    const t = Date.now()
    try {
      const detail = await fn()
      phases.push({ name, ok: true, ms: Date.now() - t, detail })
      log(`== ${name} passed in ${((Date.now() - t) / 1000).toFixed(0)} s`)
      return true
    } catch (err) {
      phases.push({ name, ok: false, ms: Date.now() - t, error: err.message })
      log(`== ${name} FAILED (${err.message}) in ${((Date.now() - t) / 1000).toFixed(0)} s`)
      return false
    }
  }
  try {
    agent = await Agent.create({ host: server.host, port: server.port, username: USERNAME, log: (line) => log(line) })
    const bot = agent.bot
    const scenario = async (s) => {
      const r = await agent.runScenario(s)
      if (!r.ok) throw new Error(r.error?.message ?? 'failed')
      return r.verified ?? null
    }
    // the cheat-assisted part talks to the console like U18's harness (`{bot}` = the quoted bot name)
    const who = JSON.stringify(bot.username)
    const ctx = { bot, server, cmd: (c) => server.commandOutput(c.replaceAll('{bot}', who)), who, log: (m) => agent.event('log', { msg: m }), data: {} }
    let ok = true
    for (const m of MILESTONES) {
      ok = await phase(m.id, () => scenario(m))
      if (!ok) break
    }
    ok = ok && await phase('N1M3', () => scenario(N1M3))
    ok = ok && await phase('home', async () => {
      const r = await agent.run('nether', { targets: netherOres ? NETHER_ORES : {}, returnHome: true }, { name: 'back home', timeout: 14 * 60 * 1000, retries: 0 })
      if (!r.returned || bot.game.dimension !== 'overworld') throw new Error(`not back in the overworld (${bot.game.dimension})`)
      return { mined: r.mined }
    })
    ok = ok && await phase('E1 stronghold (cheat-assisted)', () => e1.toPortalRoom(ctx, { kit: [['ender_eye', 12], ['cooked_beef', 16]] }))
    if (ok) {
      for (const step of e1.steps) {
        ok = await phase(`E1 ${step.name}`, async () => {
          if (step.console) {
            if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
            const out = await ctx.cmd(step.console)
            agent.event('log', { msg: `console (cheat-assisted): ${step.console} → ${out.join(' | ')}` })
            if (/kill/.test(step.console) && !out.some((l) => /Killed/.test(l))) throw new Error(`${step.console}: ${out.join(' | ')}`)
            return out
          }
          const r = await agent.run(step.skill, step.args ?? {}, { name: `E1 ${step.name}`, timeout: step.timeout, retries: 0 })
          if (step.args?.phase === 'activate' && !r.entered) throw new Error('did not enter the End')
          if (step.args?.phase === 'fight' && (r.killed?.enderman ?? 0) < (step.args.endermen ?? 1)) throw new Error(`endermen killed: ${r.killed?.enderman ?? 0}`)
          if (step.args?.phase === 'exit' && (!r.exited || bot.game.dimension !== 'overworld')) throw new Error(`not back in the overworld (${bot.game.dimension})`)
          return { killed: r.killed, entered: r.entered, exited: r.exited }
        })
        if (!ok) break
      }
    }
  } catch (err) {
    phases.push({ name: 'setup', ok: false, ms: Date.now() - t0, error: err.message })
  } finally {
    await agent?.stop().catch(() => {})
    await server.stop().catch(() => {})
  }
  const expected = MILESTONES.length + 3 + require('../end/e1-end').steps.length
  const ok = phases.length === expected && phases.every((p) => p.ok)
  const file = path.join(cfg.reportDir, `final-chain-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(cfg.reportDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ok, ms: Date.now() - t0, seed: cfg.seed, difficulty: cfg.difficulty, phases, report: agent?.report() }, null, 2))
  return { ok, ms: Date.now() - t0, phases, report: file }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const verbose = args.includes('--log')
  const di = args.indexOf('--difficulty')
  if (di >= 0) process.env.AGENT_DIFFICULTY = args[di + 1]
  finalChain({ netherOres: args.includes('--nether-ores'), log: (line) => { if (verbose || line.startsWith('==')) console.log(line) } })
    .then((r) => {
      console.log(`final chain ${r.ok ? 'PASSED' : 'FAILED'} in ${(r.ms / 60000).toFixed(1)} min`)
      for (const p of r.phases) console.log(`  ${p.name}: ${p.ok ? 'ok' : 'FAILED'} ${(p.ms / 1000).toFixed(0)} s${p.error ? ` — ${p.error}` : ''}`)
      console.log(`report: ${r.report}`)
      process.exit(r.ok ? 0 : 1)
    }, (err) => { console.error(err); process.exit(1) })
}

module.exports = { finalChain, NETHER_ORES }
