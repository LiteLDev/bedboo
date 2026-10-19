#!/usr/bin/env node
// owner: U17 (agent core & overworld milestones); FINAL-FIX-AGENT-A: camp, gear, nights, provisions, phase budgets
'use strict'
/**
 * The final acceptance chain, ONE world (seed.json, seed 1234), ONE bot, no reconnects:
 *
 *   M1                          U17's milestone: wood → stone tools (cheat-free, like every overworld phase)
 *   camp                        while it is day at the spawn: 3 sheep → a bed (white wool + planks), meat for later
 *                               (best effort: the chain goes on without a bed)
 *   M2                          iron tools, bucket
 *   gear                        iron for the trip: iron armor (helmet, chestplate, leggings, boots) and a shield, worn;
 *                               the second bucket and the iron ingot of N1M3's flint and steel; the camp's meat cooked
 *   M3 → M4 → M5                diamonds, the house at the spawn, every overworld ore
 *   provisions                  back to the spawn; ≥ 8 food items (hunted and cooked; fishing when no animal is left)
 *   N1M3                        U18's nether entry from the M3 state (second bucket, iron ingot, back to the spawn,
 *                               bucket-cast obsidian, build + light the portal, enter the Nether)
 *   home                        back through the bot's own portal (U18's nether skill; `--nether-ores` also mines
 *                               quartz / nether gold / ancient debris on the way, like N2)
 *   E1 stronghold               U18's toPortalRoom (CHEAT-ASSISTED: locate + teleport into the portal room, 12 eyes of
 *                               ender and food given; documented in docs/differences/U18.md)
 *   E1 activate / fight / exit  U18's end skill: eyes into the frames, into the End, (cheat) the dragon is killed with
 *                               /kill, two endermen fought, the exit portal → back in the overworld
 *
 * Nights: between tasks the Agent sleeps in its bed (src/runner.js restIfNight → skills/rest.js: the night is skipped);
 * without a bed and without armor it waits in its house / a sealed hole (`shelter`). Every phase has a time budget
 * (the milestones 10 min each, the others below); a task that is stuck (the bot has not moved or done anything for
 * 2–4 minutes) is aborted by the Agent's watchdog, the bot escapes (out of the water, up to the sky) and the task
 * runs again.
 *
 *   node packages/agent/scenarios/overworld/final-chain.js [--log] [--nether-ores] [--difficulty easy]
 *        [--from m5] [--until N1M3]
 *   AGENT_FINAL_CHAIN=1 corepack pnpm --filter @bedboo/agent test:e2e -- --grep "final chain"
 *
 * `--from mK` (development only: not an acceptance run) starts from the milestone snapshot u17-s<seed>-mK and skips
 * the phases up to MK; `--until <phase>` stops after that phase.
 *
 * Prints every phase's time; the full report (events, tasks, deaths, fights) goes to $AGENT_REPORT_DIR
 * (default ~/.cache/bedboo/agent-reports/final-chain-<time>.json). Exit code 0 when every phase passed.
 */
const fs = require('fs')
const path = require('path')
const { Agent } = require('../../src/runner')
const { MILESTONES } = require('./milestones')
const { config, serverOptions, snapshotName, USERNAME } = require('./harness')
const inventory = require('../../src/inventory')

const NETHER_ORES = { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 }
const MINUTES = 60 * 1000

/** iron for the gear phase: armor 24, shield 1, N1M3's second bucket 3 and flint and steel 1 */
const GEAR = [
  { item: 'iron_chestplate', ingots: 8 },
  { item: 'iron_leggings', ingots: 7 },
  { item: 'iron_helmet', ingots: 5 },
  { item: 'iron_boots', ingots: 4 },
  { item: 'shield', ingots: 1 }
]
const ARMOR_SLOT = { iron_helmet: 5, iron_chestplate: 6, iron_leggings: 7, iron_boots: 8 }
/** a bed takes 3 wool of one colour */
const WOOL = ['white', 'light_gray', 'gray', 'black', 'brown', 'pink', 'orange', 'magenta', 'light_blue', 'yellow', 'lime', 'cyan', 'purple', 'blue', 'green', 'red'].map((c) => `${c}_wool`)
/** food items to carry into the Nether */
const PROVISIONS = 8

/** the bot carries `item` (armor worn counts) */
const has = (bot, item) => inventory.count(bot, item) > 0

/**
 * @param {{ log?: (line: string) => void, cfg?: object, netherOres?: boolean, from?: string, until?: string }} [opts]
 * @returns {Promise<{ ok: boolean, ms: number, phases: object[], report: string }>}
 */
async function finalChain ({ log = () => {}, cfg = config(), netherOres = false, from = null, until = null } = {}) {
  const bds = require('@bedboo/bds')
  const { N1M3 } = require('../nether/n1-from-m3')
  const e1 = require('../end/e1-end')
  const fromIndex = from ? MILESTONES.findIndex((m) => m.id === String(from).toUpperCase()) : -1
  if (from && fromIndex < 0) throw new Error(`--from ${from}: one of ${MILESTONES.map((m) => m.id.toLowerCase()).join(', ')}`)
  const snapshot = from ? snapshotName(MILESTONES[fromIndex].id, cfg) : null
  if (snapshot && !bds.readSnapshot(snapshot)) throw new Error(`snapshot ${snapshot} is missing (run the milestone gates first)`)
  const server = await bds.startServer(serverOptions(cfg, snapshot))
  const t0 = Date.now()
  const phases = []
  let agent = null
  let bot = null
  /** one phase: { name, ok, ms, error?, detail?, time } — returns whether it passed */
  const phase = async (name, fn) => {
    const t = Date.now()
    const time = bot?.time?.timeOfDay ?? null
    log(`== ${name} starts (${((t - t0) / 60000).toFixed(1)} min in, time of day ${time})`)
    try {
      const detail = await fn()
      phases.push({ name, ok: true, ms: Date.now() - t, timeOfDay: time, detail })
      log(`== ${name} passed in ${((Date.now() - t) / 1000).toFixed(0)} s`)
      return true
    } catch (err) {
      phases.push({ name, ok: false, ms: Date.now() - t, timeOfDay: time, error: err.message })
      log(`== ${name} FAILED (${err.message}) in ${((Date.now() - t) / 1000).toFixed(0)} s`)
      return false
    }
  }
  const plan = []
  try {
    // shelter: without a bed and without armor, nights are sat out in the house / a sealed hole
    agent = await Agent.create({ host: server.host, port: server.port, username: USERNAME, shelter: true, log: (line) => log(line) })
    bot = agent.bot
    const scenario = async (s) => {
      const r = await agent.runScenario(s)
      if (!r.ok) throw new Error(r.error?.message ?? 'failed')
      return r.verified ?? null
    }
    // a task of a phase: errors are the phase's
    const task = (skill, args, opts) => agent.run(skill, args, opts)
    // the cheat-assisted part talks to the console like U18's harness (`{bot}` = the quoted bot name)
    const who = JSON.stringify(bot.username)
    const ctx = { bot, server, cmd: (c) => server.commandOutput(c.replaceAll('{bot}', who)), who, log: (m) => agent.event('log', { msg: m }), data: {} }
    const milestone = (id) => ({ name: id, run: () => scenario(MILESTONES.find((m) => m.id === id)) })

    plan.push(milestone('M1'))
    plan.push({
      name: 'camp',
      // best effort: a bed (sheep at the spawn, while it is day) and some meat; never fails the chain
      run: async () => {
        const out = {}
        await task('navigate', { spawn: true, range: 24 }, { name: 'camp: to the spawn', timeout: 2 * MINUTES, retries: 0 }).catch((err) => { out.home = err.message })
        if (!has(bot, 'bed')) {
          // 3 wool of one colour from sheep (the plains around the spawn have flocks), then the bed is crafted
          const wool = 3 - Math.max(...WOOL.map((w) => inventory.count(bot, w)))
          if (wool > 0) {
            await task('hunt', { mobs: ['sheep'], item: WOOL, count: wool, radius: 48, explore: true, timeout: 170000 }, { name: 'camp: wool', timeout: 3 * MINUTES, retries: 0 })
              .catch((err) => { out.wool = err.message })
          }
          await task('obtain', { item: 'bed', count: 1 }, { name: 'camp: a bed', timeout: 2 * MINUTES, retries: 0 })
            .then(() => { out.bed = true }, (err) => { out.bed = err.message })
        }
        // wood for later (the shield's planks, sticks, a table): deep in a mine a log is a long climb away
        const logs = () => inventory.allItems(bot).filter((i) => /_log$/.test(i.name)).reduce((n, i) => n + i.count, 0)
        if (logs() < 6) {
          await task('gather', { item: 'log', count: 6 - logs() }, { name: 'camp: logs', timeout: 2 * MINUTES, retries: 0 }).catch((err) => { out.logs = err.message })
        }
        // meat for later (cooked in the gear phase): the animals in sight
        await task('food', { min: 0, items: 6, stock: true, radius: 48, explore: false, fishing: false, timeout: 90000 }, { name: 'camp: meat', timeout: 2 * MINUTES, retries: 0 })
          .then((r) => { out.food = r }, (err) => { out.food = err.message })
        return out
      }
    })
    plan.push(milestone('M2'))
    plan.push({
      name: 'gear',
      run: async () => {
        await agent.maintain()
        // all the iron in one trip and one (3-furnace) smelt: armor, shield, N1M3's second bucket and flint and steel
        const missing = GEAR.filter((g) => !has(bot, g.item))
        const ingots = missing.reduce((n, g) => n + g.ingots, 0) + (inventory.count(bot, 'bucket') < 2 ? 3 : 0) + 1
        if (inventory.count(bot, 'iron_ingot') < ingots) {
          await task('obtain', { item: 'iron_ingot', count: ingots }, { name: `gear: ${ingots} iron ingots`, timeout: 9 * MINUTES, retries: 1 })
        }
        const made = []
        for (const g of [...GEAR, { item: 'bucket', count: 2 }]) {
          if (inventory.count(bot, g.item) >= (g.count ?? 1)) continue
          await task('obtain', { item: g.item, count: g.count ?? 1 }, { name: `gear: ${g.item}`, timeout: 3 * MINUTES, retries: 0 })
          made.push(g.item)
        }
        await require('../../src/skills/combat').equipForCombat(bot, { shield: true })
        const worn = Object.entries(ARMOR_SLOT).filter(([, slot]) => bot.inventory.slots[slot]).map(([item]) => item)
        if (worn.length < 4) throw new Error(`armor worn: ${worn.join(', ') || 'none'}`)
        // the camp's meat: cooked while the furnace is out anyway (best effort)
        await task('food', { min: 0, items: 0, stock: true, explore: false, fishing: false, timeout: 90000 }, { name: 'gear: cook', timeout: 2 * MINUTES, retries: 0 }).catch(() => {})
        return { made, worn, shield: bot.inventory.slots[45]?.name ?? null }
      }
    })
    plan.push(milestone('M3'))
    plan.push(milestone('M4'))
    plan.push(milestone('M5'))
    plan.push({
      name: 'provisions',
      // back to the spawn (M5 ends deep under the mountains; N1M3 builds its portal at the spawn, and the plains there
      // have animals), then food for the long trip — the Nether part has no animals
      run: async () => {
        await agent.maintain()
        const home = await task('navigate', { spawn: true, range: 16 }, { name: 'provisions: to the spawn', timeout: 5 * MINUTES, retries: 1 })
          .catch((err) => ({ error: err.message }))
        let r = null
        for (let round = 0; round < 2 && require('../../src/skills/survive').foodItems(bot) < PROVISIONS; round++) {
          await agent.maintain()
          r = await task('food', { min: 30, items: PROVISIONS, stock: true, radius: 64, explore: true, timeout: 230000 }, { name: `provisions${round ? ' (again)' : ''}`, timeout: 4 * MINUTES, retries: 1 })
            .catch((err) => ({ error: err.message }))
        }
        const items = require('../../src/skills/survive').foodItems(bot)
        if (items < PROVISIONS) throw new Error(`${items} food items (need ${PROVISIONS}): ${r?.error ?? JSON.stringify(r?.hunted ?? {})}`)
        // back where the portal goes
        await task('navigate', { spawn: true, range: 16 }, { name: 'provisions: back to the spawn', timeout: 3 * MINUTES, retries: 1 }).catch(() => {})
        return { home: home.error ?? 'reached', items, hunted: r?.hunted, fished: r?.fished }
      }
    })
    plan.push({ name: 'N1M3', run: async () => { await agent.maintain(); return scenario(N1M3) } })
    plan.push({
      name: 'home',
      run: async () => {
        const r = await task('nether', { targets: netherOres ? NETHER_ORES : {}, returnHome: true }, { name: 'back home', timeout: 14 * MINUTES, retries: 0 })
        if (!r.returned || bot.game.dimension !== 'overworld') throw new Error(`not back in the overworld (${bot.game.dimension})`)
        return { mined: r.mined }
      }
    })
    plan.push({ name: 'E1 stronghold (cheat-assisted)', run: () => e1.toPortalRoom(ctx, { kit: [['ender_eye', 12], ['cooked_beef', 16]] }) })
    for (const step of e1.steps) {
      plan.push({
        name: `E1 ${step.name}`,
        run: async () => {
          if (step.console) {
            if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
            const out = await ctx.cmd(step.console)
            agent.event('log', { msg: `console (cheat-assisted): ${step.console} → ${out.join(' | ')}` })
            if (/kill/.test(step.console) && !out.some((l) => /Killed/.test(l))) throw new Error(`${step.console}: ${out.join(' | ')}`)
            return out
          }
          const r = await task(step.skill, step.args ?? {}, { name: `E1 ${step.name}`, timeout: step.timeout, retries: 0 })
          if (step.args?.phase === 'activate' && !r.entered) throw new Error('did not enter the End')
          if (step.args?.phase === 'fight' && (r.killed?.enderman ?? 0) < (step.args.endermen ?? 1)) throw new Error(`endermen killed: ${r.killed?.enderman ?? 0}`)
          if (step.args?.phase === 'exit' && (!r.exited || bot.game.dimension !== 'overworld')) throw new Error(`not back in the overworld (${bot.game.dimension})`)
          return { killed: r.killed, entered: r.entered, exited: r.exited }
        }
      })
    }
    // --from mK: the phases after MK only
    const start = from ? plan.findIndex((p) => p.name === MILESTONES[fromIndex].id) + 1 : 0
    const last = until ? plan.findIndex((p) => p.name === until) : plan.length - 1
    if (until && last < 0) throw new Error(`--until ${until}: one of ${plan.map((p) => p.name).join(', ')}`)
    for (const p of plan.slice(start, last + 1)) {
      if (!await phase(p.name, p.run)) break
    }
    plan.splice(last + 1)
    plan.splice(0, start)
  } catch (err) {
    phases.push({ name: 'setup', ok: false, ms: Date.now() - t0, error: err.message })
  } finally {
    await agent?.stop().catch(() => {})
    await server.stop().catch(() => {})
  }
  const ok = plan.length > 0 && phases.length === plan.length && phases.every((p) => p.ok)
  const file = path.join(cfg.reportDir, `final-chain-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  fs.mkdirSync(cfg.reportDir, { recursive: true })
  fs.writeFileSync(file, JSON.stringify({ ok, ms: Date.now() - t0, seed: cfg.seed, difficulty: cfg.difficulty, from, until, phases, report: agent?.report() }, null, 2))
  return { ok, ms: Date.now() - t0, phases, report: file, partial: !!(from || until) }
}

if (require.main === module) {
  const args = process.argv.slice(2)
  const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : null }
  const verbose = args.includes('--log')
  if (opt('--difficulty')) process.env.AGENT_DIFFICULTY = opt('--difficulty')
  finalChain({ netherOres: args.includes('--nether-ores'), from: opt('--from'), until: opt('--until'), log: (line) => { if (verbose || line.startsWith('==')) console.log(line) } })
    .then((r) => {
      console.log(`final chain${r.partial ? ' (partial)' : ''} ${r.ok ? 'PASSED' : 'FAILED'} in ${(r.ms / 60000).toFixed(1)} min`)
      for (const p of r.phases) console.log(`  ${p.name}: ${p.ok ? 'ok' : 'FAILED'} ${(p.ms / 1000).toFixed(0)} s${p.error ? ` — ${p.error}` : ''}`)
      console.log(`report: ${r.report}`)
      process.exit(r.ok ? 0 : 1)
    }, (err) => { console.error(err); process.exit(1) })
}

module.exports = { finalChain, NETHER_ORES, GEAR, PROVISIONS }
