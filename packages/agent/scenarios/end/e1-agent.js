// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * E1 in the final chain's world (seed 1234, scenarios/nether/seed-1234.json: stronghold located at (-878, 194), its
 * portal room's ring at (-872, -34, 198)) under U17's Agent — the End part of scenarios/overworld/final-chain.js on its
 * own, run the same way (agent.run per phase, the Agent's safety as the guard):
 *
 *   1. (cheat-assisted stand-in for the chain's earlier phases) the gear the chain's bot carries when it gets there —
 *      `CHAIN_GEAR`: its own iron sword and diamond pickaxe, cobblestone, a bucket — given with /give;
 *   2. (cheat-assisted, like the chain) e1.toPortalRoom: `/locate`, teleports into the portal room, `CHAIN_KIT`;
 *   3. the end skill: activate (eyes into the frames, into the End) → (cheat) the dragon killed with /kill → fight two
 *      endermen → exit portal → credits → the overworld.
 *
 *   node packages/agent/scenarios/end/e1-agent.js [--log]
 *   BEDBOO_U18_CHAIN_SEED=1 BEDBOO_U18_RUNS=5 corepack pnpm --filter @bedboo/agent test:e2e -- --grep E1A
 */
const e1 = require('./e1-end')

/** what the chain's bot carries at the End (M1–M5 + the Nether): stands in for those phases here */
const CHAIN_GEAR = [['iron_sword', 1], ['diamond_pickaxe', 1], ['iron_pickaxe', 1], ['cobblestone', 64], ['bucket', 1]]

/**
 * One run. @returns {Promise<{ ok, ms, phases: Array<{ name, ok, ms, error? }>, deaths }>}
 */
async function runE1UnderAgent ({ seed = require('../nether/seed-1234.json').seed, difficulty = process.env.AGENT_DIFFICULTY || 'easy', gear = CHAIN_GEAR, kit = e1.CHAIN_KIT, log = () => {} } = {}) {
  const bds = require('@bedboo/bds')
  const { Agent } = require('../../src/runner')
  const t0 = Date.now()
  const phases = []
  const server = await bds.startServer({ world: 'default', seed: String(seed), gamemode: 'survival', difficulty, profile: 'none', log: () => {} })
  let agent = null
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
    agent = await Agent.create({ host: server.host, port: server.port, username: 'Agent', log })
    const bot = agent.bot
    const who = JSON.stringify(bot.username)
    const ctx = { bot, server, cmd: (c) => server.commandOutput(c.replaceAll('{bot}', who)), who, log: (m) => agent.event('log', { msg: m }), data: {} }
    let ok = await phase('gear (cheat-assisted stand-in for M1–M5 + the Nether)', async () => {
      for (const [item, n] of gear) {
        const out = await ctx.cmd(`give {bot} ${item} ${n}`)
        if (!out.some((l) => /^Gave/.test(l))) throw new Error(`give ${item}: ${out.join(' | ')}`)
      }
    })
    ok = ok && await phase('E1 stronghold (cheat-assisted)', () => e1.toPortalRoom(ctx, { kit }))
    for (const step of e1.steps) {
      if (!ok) break
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
        return { killed: r.killed, entered: r.entered, exited: r.exited, timings: r.timings }
      })
    }
  } catch (err) {
    phases.push({ name: 'setup', ok: false, ms: Date.now() - t0, error: err.message })
  } finally {
    await agent?.stop().catch(() => {})
    await server.stop().catch(() => {})
  }
  const expected = 2 + e1.steps.length
  return { ok: phases.length === expected && phases.every((p) => p.ok), ms: Date.now() - t0, phases, deaths: agent?.deaths?.length ?? 0 }
}

module.exports = { runE1UnderAgent, CHAIN_GEAR }

if (require.main === module) {
  const verbose = process.argv.includes('--log')
  runE1UnderAgent({ log: (l) => { if (verbose || l.startsWith('==')) console.log(l) } }).then((r) => {
    console.log(`E1 under the Agent (seed 1234) ${r.ok ? 'PASSED' : 'FAILED'} in ${(r.ms / 1000).toFixed(0)} s, deaths ${r.deaths}`)
    for (const p of r.phases) console.log(`  ${p.name}: ${p.ok ? 'ok' : 'FAILED'} ${(p.ms / 1000).toFixed(0)} s${p.error ? ` — ${p.error}` : ''}`)
    process.exit(r.ok ? 0 : 1)
  }, (err) => { console.error(err); process.exit(1) })
}
