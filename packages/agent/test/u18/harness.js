// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * E2E harness for U18's milestone scenarios (scenarios/{combat,nether,end}): one fresh BDS per run (@bedboo/bds),
 * a mineflayer-bedrock bot with the `bot.test` helpers, the scenario's cheat-assisted setup (console commands, kit,
 * `prepare`), then its steps: skills through the agent runner's `runSkill` (cheat-free), or `{ console }` steps
 * (cheat-assisted, documented in docs/differences/U18.md) run by the harness between skills.
 *
 * Scenario module shape (superset of scenarios/README.md):
 *   { name, server: startServer options, viewDistance?, kit?: [[item, count]], setup?: string[] ('{bot}' = the bot's
 *     name), prepare?: async (ctx) => void, steps: Step[] | (ctx) => Step[], check?: (report, ctx) => void,
 *     timeout? }
 *   Step = { skill, args?, name?, timeout? } | { console: string, name?, delayMs? } | { run: async (ctx) => void, name }
 * ctx = { bot, server, cmd(command) → output lines, who (quoted bot name), log, data: {} (prepare → steps) }
 */
const { createTestBot } = require('../../../mineflayer-bedrock/test/external/common')
const bds = require('@bedboo/bds')
const { runSkill } = require('../../src/runner')

const RUNS = Math.max(1, Number(process.env.BEDBOO_U18_RUNS) || 1)

/** `"name"` for console selectors */
const quote = (name) => /^[A-Za-z0-9_]+$/.test(name) ? name : `"${name}"`

/** a JSON-friendly copy of a step result (no Vec3 / class instances, no huge arrays) */
function summary (value, depth = 0) {
  if (value === null || typeof value !== 'object') return value
  if (depth > 4) return '…'
  if (Array.isArray(value)) return value.length > 12 ? [...value.slice(0, 12).map((v) => summary(v, depth + 1)), `… ${value.length - 12} more`] : value.map((v) => summary(v, depth + 1))
  const out = {}
  for (const [k, v] of Object.entries(value)) out[k] = summary(v, depth + 1)
  return out
}

/**
 * Run one scenario once on a fresh server. Never throws for a failed run: resolves with
 * `{ ok, reason, ms, steps: [{ name, ok, ms, result | error }], logs }`.
 */
async function runOnce (scenario, { username = 'u18bot', onLog } = {}) {
  const started = Date.now()
  const logs = []
  const log = (msg) => {
    const line = `${((Date.now() - started) / 1000).toFixed(1).padStart(6)}s ${msg}`
    logs.push(line)
    if (onLog) onLog(line)
  }
  const report = { name: scenario.name, ok: false, reason: null, ms: 0, steps: [], logs }
  let server = null
  let bot = null
  const deadline = started + (scenario.timeout ?? 20 * 60 * 1000)
  try {
    server = await bds.startServer(scenario.server)
    ;({ bot } = await createTestBot({ server, username, botOptions: { viewDistance: scenario.viewDistance ?? 8 } }))
    bot.on('agent_log', (m) => log(m))
    bot.on('death', () => log(`DEATH at ${bot.entity?.position?.floored()} in ${bot.game?.dimension}`))
    bot.on('kicked', (r) => log(`KICKED ${JSON.stringify(r)}`))
    bot.on('messagestr', (m, pos) => { if (pos !== 'game_info' && /death|slain|fell|burn|lava|drown|blew|shot|killed/i.test(m)) log(`message: ${m}`) })
    const who = quote(bot.username)
    const cmd = (command) => server.commandOutput(command.replaceAll('{bot}', who))
    const ctx = { bot, server, cmd, who, log, data: {} }
    await bot.waitForChunksToLoad()
    for (const command of scenario.setup ?? []) log(`setup: ${command} → ${(await cmd(command)).join(' | ')}`)
    for (const [item, n] of scenario.kit ?? []) {
      const out = await cmd(`give {bot} ${item} ${n}`)
      if (!out.some((l) => /^Gave/.test(l))) throw new Error(`kit: give ${item} ${n}: ${out.join(' | ')}`)
    }
    if (scenario.kit?.length) log(`kit: ${scenario.kit.map(([i, n]) => `${n} ${i}`).join(', ')}`)
    if (scenario.prepare) await scenario.prepare(ctx)
    await bot.waitForTicks(10)
    const steps = typeof scenario.steps === 'function' ? scenario.steps(ctx) : scenario.steps
    for (const step of steps) {
      const name = step.name ?? step.skill ?? 'console'
      const t = Date.now()
      if (step.run) {
        // a harness-level (cheat-assisted) setup step between skills, e.g. the End's stronghold teleport
        log(`run (cheat-assisted): ${name}`)
        await step.run(ctx)
        report.steps.push({ name, ok: true, ms: Date.now() - t, result: null })
        continue
      }
      if (step.console) {
        if (step.delayMs) await new Promise((resolve) => setTimeout(resolve, step.delayMs))
        const out = await cmd(step.console)
        log(`console (cheat-assisted): ${step.console} → ${out.join(' | ')}`)
        report.steps.push({ name, ok: true, ms: Date.now() - t, result: out })
        continue
      }
      const timeout = Math.max(1000, Math.min(step.timeout ?? 15 * 60 * 1000, deadline - Date.now()))
      log(`step ${name}: ${step.skill} ${JSON.stringify(step.args ?? {})}`)
      try {
        const result = await runSkill(bot, step.skill, step.args ?? {}, { timeout })
        report.steps.push({ name, ok: true, ms: Date.now() - t, result: summary(result) })
        log(`step ${name} done in ${((Date.now() - t) / 1000).toFixed(1)} s`)
      } catch (err) {
        report.steps.push({ name, ok: false, ms: Date.now() - t, error: err.message })
        throw new Error(`${name}: ${err.message}`)
      }
    }
    if (scenario.check) await scenario.check(report, ctx)
    report.ok = true
  } catch (err) {
    report.reason = err.message
    log(`FAILED: ${err.stack?.split('\n').slice(0, 3).join(' / ')}`)
  } finally {
    report.ms = Date.now() - started
    report.final = bot?.entity ? { dimension: bot.game?.dimension, position: bot.entity.position?.floored?.()?.toString(), health: bot.health, food: bot.food } : null
    try { bot?.pathfinder?.stop() } catch {}
    try { bot?.end('scenario done') } catch {}
    if (server) await server.stop().catch(() => {})
  }
  return report
}

/**
 * Mocha: one `it` running the scenario `BEDBOO_U18_RUNS` times (default 1), passing when ⌈0.8·runs⌉ runs pass
 * (1 run: it must pass). Prints a pass table with timings and failure reasons; `BEDBOO_U18_REPORT=<file>` appends
 * every run as a JSON line.
 */
function describeScenario (scenario, { runs = RUNS } = {}) {
  const required = runs === 1 ? 1 : Math.ceil(runs * 0.8)
  describe(`U18 scenario ${scenario.name}`, function () {
    this.timeout(runs * ((scenario.timeout ?? 20 * 60 * 1000) + 3 * 60 * 1000))
    it(`${scenario.name}: ${scenario.description ?? ''} (${required}/${runs} runs must pass)`, async function () {
      const results = []
      for (let i = 0; i < runs; i++) {
        const r = await runOnce(scenario, { onLog: process.env.BEDBOO_AGENT_LOG ? (l) => console.log(`      [${scenario.name}#${i + 1}] ${l}`) : null })
        results.push(r)
        const line = `      run ${i + 1}/${runs}: ${r.ok ? 'PASS' : 'FAIL'} in ${(r.ms / 1000).toFixed(0)} s` +
          (r.ok ? '' : ` — ${r.reason}`) + ` | steps: ${r.steps.map((s) => `${s.name} ${(s.ms / 1000).toFixed(0)}s${s.ok ? '' : ' ✗'}`).join(', ')}`
        console.log(line)
        if (!r.ok) console.log(r.logs.slice(-40).map((l) => `        ${l}`).join('\n'))
        if (process.env.BEDBOO_U18_REPORT) {
          require('fs').appendFileSync(process.env.BEDBOO_U18_REPORT, JSON.stringify({ scenario: scenario.name, run: i + 1, ok: r.ok, reason: r.reason, ms: r.ms, steps: r.steps, final: r.final, at: new Date().toISOString() }) + '\n')
        }
        if (results.filter((x) => !x.ok).length > runs - required) break // the gate cannot be met any more
      }
      const passes = results.filter((r) => r.ok).length
      const times = results.filter((r) => r.ok).map((r) => r.ms).sort((a, b) => a - b)
      console.log(`      ${scenario.name}: ${passes}/${results.length} passed, median ${times.length ? (times[Math.floor(times.length / 2)] / 1000).toFixed(0) + ' s' : '-'}`)
      if (passes < required) throw new Error(`${scenario.name}: ${passes}/${runs} runs passed (needs ${required}): ${results.filter((r) => !r.ok).map((r) => r.reason).join(' ; ')}`)
    })
  })
}

module.exports = { runOnce, describeScenario, quote, summary }
