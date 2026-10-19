// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Scripted (no LLM) agent runner.
 *
 *   const { Agent } = require('@bedboo/agent')
 *   const agent = await Agent.create({ host, port, username: 'Agent' })   // createBot + plugins + safety behaviours
 *   agent.on('event', (e) => console.log(e))                             // progress stream
 *   await agent.run('obtain', { item: 'stone_pickaxe' }, { timeout: 600000 })
 *   const report = await agent.runScenario({ name: 'M1', steps: [{ skill: 'obtain', args: { item: 'stone_axe' } }] })
 *   agent.writeReport('report.json'); await agent.stop()
 *
 * The Agent loads the ecosystem plugins (mineflayer-pathfinder with Bedrock Movements, -collectblock, -tool,
 * -armor-manager, -auto-eat, -pvp), runs skills (src/skills, auto-discovered) as tasks with timeouts and retries,
 * and keeps the safety behaviours of src/safety.js running in the background (fight / flee hostiles, escape lava,
 * swim up, eat). A death during a task aborts it; after the respawn the Agent walks back to where it died, picks up
 * what it dropped (when that is reasonable) and retries the task (the obtain planner starts again from what the bot
 * has then).
 *
 * Every skill log line / progress event becomes an `event` ({ t, type, … }); `report()` is a JSON-serialisable
 * summary (tasks with timings and results, deaths, safety interventions, final inventory, the event log).
 *
 * Legacy helpers (U0 skeleton contract, used by U18's tests): `runSkill(bot, name, args, { skills, timeout })`,
 * `runScenario(bot, scenario, { skills, log })`.
 */
const { EventEmitter } = require('events')
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')
const defaultSkills = require('./skills')
const { setContext, withTimeout } = require('./skill')
const { SkillError, isAbort } = require('./errors')
const { Safety } = require('./safety')
const inventory = require('./inventory')

const DEFAULT_STEP_TIMEOUT = 10 * 60 * 1000

/**
 * Run one skill with a timeout.
 * @param {object} bot
 * @param {string} name skill name (key of the skill registry)
 * @param {object} [args]
 * @param {{ skills?: Record<string, Function>, timeout?: number, signal?: AbortSignal }} [opts]
 */
async function runSkill (bot, name, args = {}, { skills = defaultSkills, timeout = DEFAULT_STEP_TIMEOUT, signal } = {}) {
  const skill = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (typeof skill !== 'function') throw new Error(`Unknown skill: ${name}`)
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  try {
    return await Promise.race([
      skill(bot, { ...args, signal: controller.signal }),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('timeout'))
          reject(new SkillError(`Skill ${name} timed out after ${timeout} ms`, { code: 'TIMEOUT' }))
        }, timeout)
      })
    ])
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
  }
}

/**
 * @param {object} bot
 * @param {{ name: string, timeout?: number, steps: Array<{ skill: string, args?: object, name?: string, timeout?: number }> }} scenario
 *   `scenario.timeout` bounds the whole scenario; `step.timeout` (default 10 min) bounds one step
 * @param {{ skills?: Record<string, Function>, log?: (msg: string) => void }} [opts]
 */
async function runScenario (bot, scenario, { skills = defaultSkills, log = () => {} } = {}) {
  const results = []
  const deadline = scenario.timeout != null ? Date.now() + scenario.timeout : Infinity
  for (const step of scenario.steps) {
    const stepName = step.name ?? step.skill
    const started = Date.now()
    const timeout = Math.max(0, Math.min(step.timeout ?? DEFAULT_STEP_TIMEOUT, deadline - started))
    log(`[${scenario.name}] ${stepName} ${JSON.stringify(step.args ?? {})}`)
    try {
      const result = await runSkill(bot, step.skill, step.args, { skills, timeout })
      results.push({ name: stepName, skill: step.skill, ok: true, result, ms: Date.now() - started })
    } catch (error) {
      results.push({ name: stepName, skill: step.skill, ok: false, error, ms: Date.now() - started })
      log(`[${scenario.name}] ${stepName} failed: ${error.message}`)
      return { name: scenario.name, ok: false, results }
    }
  }
  return { name: scenario.name, ok: true, results }
}

/**
 * Load the ecosystem plugins the skills use (idempotent).
 * @param {object} bot
 * @param {{ autoEat?: boolean, pvp?: boolean, armor?: boolean }} [opts]
 */
async function loadPlugins (bot, { autoEat = true, pvp = true, armor = true } = {}) {
  const { pathfinder } = require('mineflayer-pathfinder')
  if (!bot.pathfinder) bot.loadPlugin(pathfinder)
  if (!bot.tool) bot.loadPlugin(require('mineflayer-tool').plugin)
  if (!bot.collectBlock) bot.loadPlugin(require('mineflayer-collectblock').plugin)
  if (armor && !bot.armorManager) bot.loadPlugin(require('mineflayer-armor-manager'))
  if (pvp && !bot.pvp) bot.loadPlugin(require('mineflayer-pvp').plugin)
  if (autoEat && !bot.autoEat) {
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
  }
  await bot.waitForTicks(2).catch(() => {})
  if (bot.autoEat) {
    bot.autoEat.setOpts({
      minHunger: 16,
      minHealth: 0, // auto-eat's default 14 tries to eat whenever hurt, even when full (Bedrock refuses): hunger only
      priority: 'foodPoints',
      bannedFood: ['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew']
    })
    if (autoEat) bot.autoEat.enableAuto()
  }
  bot.pathfinder.thinkTimeout = 10000 // ms per search (upstream 5 s): hills and caves need more nodes
  bot.pathfinder.setMovements(require('./skills/navigate').movements(bot))
}

class Agent extends EventEmitter {
  /**
   * @param {object} opts
   * @param {object} [opts.bot] an existing (spawned) mineflayer bot; else created from host/port/username
   * @param {string} [opts.host]
   * @param {number} [opts.port]
   * @param {string} [opts.username='Agent']
   * @param {object} [opts.botOptions] extra createBot options
   * @param {Record<string, Function>} [opts.skills] skill registry (default: src/skills)
   * @param {boolean|object} [opts.safety=true] background safety behaviours (options of src/safety.js)
   * @param {boolean} [opts.autoEat=true]
   * @param {boolean} [opts.recoverItems=true] go back for the drops after a death
   * @param {(line: string) => void} [opts.log] where log lines go (default: nowhere; events are kept anyway)
   * @param {number} [opts.maxEvents=5000] events kept for the report
   */
  constructor (opts = {}) {
    super()
    this.opts = { username: 'Agent', safety: true, autoEat: true, keepFed: true, recoverItems: true, maxEvents: 5000, ...opts }
    this.bot = opts.bot ?? null
    this.skills = opts.skills ?? defaultSkills
    this.events = []
    this.tasks = []
    this.deaths = []
    this.state = { protectedZones: [], lastDeath: null }
    this.startedAt = null
    this.safety = null
    this._log = this.opts.log ?? (() => {})
  }

  /** create (if needed) the bot, wait for the spawn, load plugins, start the safety behaviours */
  static async create (opts) {
    const agent = new Agent(opts)
    await agent.start()
    return agent
  }

  async start () {
    this.startedAt = Date.now()
    if (!this.bot) {
      const mineflayer = require('mineflayer-bedrock')
      this.bot = mineflayer.createBot({ host: this.opts.host, port: this.opts.port, username: this.opts.username, ...this.opts.botOptions })
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('the bot did not spawn within 90 s')), 90000)
        this.bot.once('spawn', () => { clearTimeout(timer); resolve() })
        this.bot.once('end', (reason) => { clearTimeout(timer); reject(new Error(`the bot disconnected before spawning: ${reason}`)) })
        this.bot.once('kicked', (reason) => { clearTimeout(timer); reject(new Error(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`)) })
      })
    }
    const bot = this.bot
    bot.setMaxListeners?.(50) // the ecosystem plugins + the agent listen to the same bot events
    setContext(bot, {
      agent: this,
      log: (msg) => this.event('log', { msg }),
      progress: (type, data) => this.event(type, data)
    })
    await Promise.race([bot.waitForChunksToLoad(), new Promise((resolve) => setTimeout(resolve, 20000))]).catch(() => {})
    await loadPlugins(bot, { autoEat: this.opts.autoEat })
    // the inventory is already empty when 'death' fires: keep the last one seen alive
    this._lastInventory = inventory.counts(bot)
    bot.on('health', () => { if (bot.health > 0) this._lastInventory = inventory.counts(bot) })
    this._invTimer = setInterval(() => { if (bot.health > 0 && bot.entity) this._lastInventory = inventory.counts(bot) }, 2000)
    bot.on('death', () => this.onDeath())
    bot.on('kicked', (reason) => this.event('kicked', { reason: typeof reason === 'string' ? reason : JSON.stringify(reason) }))
    bot.on('end', (reason) => this.event('end', { reason: String(reason) }))
    if (this.opts.safety) {
      this.safety = new Safety(bot, { ...(typeof this.opts.safety === 'object' ? this.opts.safety : {}), log: (msg) => this.event('log', { msg }) })
      this.safety.on('intervention', (r) => this.event('safety', r))
      this.safety.start()
    }
    this.event('start', { username: bot.username, position: posOf(bot), gameMode: bot.game?.gameMode, inventory: inventory.counts(bot) })
    return this
  }

  /** record + emit an event */
  event (type, data = {}) {
    const e = { t: this.startedAt ? Date.now() - this.startedAt : 0, type, ...data }
    this.events.push(e)
    if (this.events.length > this.opts.maxEvents) this.events.splice(0, this.events.length - this.opts.maxEvents)
    this._log(formatEvent(e))
    this.emit('event', e)
    return e
  }

  onDeath () {
    const bot = this.bot
    const death = { at: posOf(bot), dimension: bot.game?.dimension, t: Date.now() - (this.startedAt ?? Date.now()), inventory: this._lastInventory ?? {} }
    this.deaths.push(death)
    this.state.lastDeath = death
    this.event('death', death)
    this._abortTask?.(new SkillError('the bot died', { code: 'DIED' }))
  }

  /**
   * Run one skill as a task: timeout, death → recover + retry (`retries`), events, report entry.
   * @param {string} skill
   * @param {object} [args]
   * @param {{ timeout?: number, retries?: number, name?: string }} [opts]
   */
  async run (skill, args = {}, { timeout = DEFAULT_STEP_TIMEOUT, retries = 1, name } = {}) {
    const task = { name: name ?? skill, skill, args: jsonSafe(args), attempts: 0, ok: false, startedAt: new Date().toISOString() }
    this.tasks.push(task)
    const started = Date.now()
    this.event('task-start', { task: task.name, skill, args: task.args })
    for (;;) {
      task.attempts++
      const controller = new AbortController()
      this._abortTask = (reason) => controller.abort(reason)
      try {
        const left = Math.max(1000, timeout - (Date.now() - started))
        const result = await withTimeout(runSkill(this.bot, skill, args, { skills: this.skills, timeout: left, signal: controller.signal }), left + 2000, {
          signal: controller.signal,
          message: `task ${task.name} timed out`
        })
        task.ok = true
        task.result = jsonSafe(result)
        break
      } catch (err) {
        const died = controller.signal.aborted && controller.signal.reason?.code === 'DIED'
        const error = died ? controller.signal.reason : err
        task.errors = (task.errors ?? []).concat({ code: error.code ?? error.name, message: error.message })
        this.event('task-error', { task: task.name, attempt: task.attempts, code: error.code ?? error.name, error: error.message })
        if (died) await this.recover().catch((e) => this.event('log', { msg: `recover: ${e.message}` }))
        if (!died || task.attempts > retries || Date.now() - started > timeout) {
          task.error = { code: error.code ?? error.name, message: error.message }
          break
        }
      } finally {
        this._abortTask = null
        try { this.bot.pathfinder?.setGoal(null) } catch {}
        try { this.bot.clearControlStates() } catch {}
      }
    }
    task.ms = Date.now() - started
    this.event('task-end', { task: task.name, ok: task.ok, ms: task.ms, ...(task.ok ? {} : { error: task.error?.message }) })
    if (!task.ok) {
      const err = new SkillError(`${task.name}: ${task.error?.message}`, { code: task.error?.code })
      err.task = task
      throw err
    }
    return task.result
  }

  /**
   * After a death: wait for the respawn, walk back to the death spot (same dimension, < 400 blocks, not lava) and
   * pick up the dropped items (they despawn after 5 minutes).
   */
  async recover () {
    const bot = this.bot
    const death = this.state.lastDeath
    for (let i = 0; i < 100 && (bot.health <= 0 || !bot.entity); i++) await new Promise((resolve) => setTimeout(resolve, 100))
    if (!bot.isAlive) await new Promise((resolve) => { bot.once('spawn', resolve); setTimeout(resolve, 15000) })
    await new Promise((resolve) => setTimeout(resolve, 1000))
    this.event('respawned', { position: posOf(bot), inventory: inventory.counts(bot) })
    if (!this.opts.recoverItems || !death?.at || death.dimension !== bot.game?.dimension) return
    const at = new Vec3(death.at.x, death.at.y, death.at.z)
    if (at.distanceTo(bot.entity.position) > 400) return
    const lost = Object.keys(death.inventory ?? {}).length
    if (!lost) return
    this.event('recover', { to: death.at })
    const navigate = require('./skills/navigate')
    const { goals } = require('mineflayer-pathfinder')
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('recover timeout')), 120000)
    try {
      await navigate.goto(bot, new goals.GoalNear(at.x, at.y, at.z, 2), { signal: controller.signal, timeout: 110000 })
      await require('./dig').pickupNear(bot, at.offset(0.5, 0.5, 0.5), { signal: controller.signal, radius: 8, wait: 2000, timeout: 30000 })
    } catch (err) {
      if (!isAbort(err)) this.event('log', { msg: `recover: ${err.message}` })
    } finally {
      clearTimeout(timer)
    }
    this.event('recovered', { inventory: inventory.counts(bot) })
  }

  /**
   * Between tasks: hungry and (almost) no food carried → hunt for some (best effort, `food` skill). Hunger only drops
   * on easy or harder; mineflayer-auto-eat does the eating.
   */
  async maintain ({ timeout = 90000 } = {}) {
    const bot = this.bot
    if (!this.opts.keepFed || !this.skills.food || !bot?.entity) return
    const { foodPoints } = require('./skills/survive')
    if (bot.food > 12 || foodPoints(bot) >= 6) return
    this.event('maintain', { food: bot.food, carried: foodPoints(bot) })
    await this.run('food', { min: 8, explore: false, radius: 40 }, { name: 'food (maintenance)', timeout, retries: 0 }).catch((err) => this.event('log', { msg: `maintenance: ${err.message}` }))
  }

  /**
   * Run a scenario: `{ name, steps: [{ skill, args?, name?, timeout?, retries? }], timeout? }`; stops at the first
   * failed step. `verify(agent, startInventory)` (optional) runs at the end and must return truthy / throw.
   * @returns {Promise<object>} report
   */
  async runScenario (scenario) {
    const started = Date.now()
    const deadline = scenario.timeout != null ? started + scenario.timeout : Infinity
    const start = inventory.counts(this.bot)
    this.event('scenario-start', { scenario: scenario.name, inventory: start, position: posOf(this.bot) })
    let ok = true
    let error = null
    for (const step of scenario.steps) {
      const left = deadline - Date.now()
      if (left <= 0) { ok = false; error = { code: 'TIMEOUT', message: `${scenario.name} ran out of time` }; break }
      await this.maintain({ timeout: Math.min(60000, left / 5) })
      try {
        await this.run(step.skill, step.args ?? {}, { name: step.name, timeout: Math.min(step.timeout ?? DEFAULT_STEP_TIMEOUT, left), retries: step.retries ?? 1 })
      } catch (err) {
        ok = false
        error = { code: err.code, message: err.message }
        break
      }
    }
    let verified = null
    if (ok && typeof scenario.verify === 'function') {
      try {
        verified = await scenario.verify(this, start)
        if (verified === false) { ok = false; error = { code: 'VERIFY', message: 'verification failed' } }
      } catch (err) {
        ok = false
        error = { code: 'VERIFY', message: err.message }
      }
    }
    const report = this.report({ name: scenario.name, ok, error, ms: Date.now() - started, verified: jsonSafe(verified) })
    this.event('scenario-end', { scenario: scenario.name, ok, ms: report.ms, ...(error ? { error: error.message } : {}) })
    this.lastReport = report
    return report
  }

  /** JSON-serialisable summary */
  report (extra = {}) {
    const bot = this.bot
    return {
      ...extra,
      username: bot?.username,
      startedAt: this.startedAt ? new Date(this.startedAt).toISOString() : null,
      position: bot?.entity ? posOf(bot) : null,
      health: bot?.health,
      food: bot?.food,
      inventory: bot?.inventory ? inventory.counts(bot) : {},
      tasks: this.tasks.map((t) => ({ ...t })),
      deaths: this.deaths.slice(),
      interventions: this.safety?.interventions.slice() ?? [],
      events: this.events.slice()
    }
  }

  writeReport (file, report = this.lastReport ?? this.report()) {
    fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(report, null, 2))
    return file
  }

  async stop (reason = 'agent stopped') {
    this.safety?.stop()
    clearInterval(this._invTimer)
    try { this.bot?.pathfinder?.setGoal(null) } catch {}
    if (this.bot && this.bot._client) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 3000)
        this.bot.once('end', () => { clearTimeout(timer); resolve() })
        try { this.bot.quit(reason) } catch { clearTimeout(timer); resolve() }
      })
    }
  }
}

function posOf (bot) {
  const p = bot.entity?.position
  return p ? { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 } : null
}

function formatEvent (e) {
  const secs = (e.t / 1000).toFixed(1).padStart(6)
  const { t, type, msg, ...rest } = e
  return `${secs}s ${type}${msg ? ` ${msg}` : ''}${Object.keys(rest).length ? ` ${JSON.stringify(rest)}` : ''}`
}

/** a JSON-safe copy (drops signals / functions, Vec3 → plain, BigInt → string) */
function jsonSafe (value) {
  if (value === undefined) return undefined
  try {
    return JSON.parse(JSON.stringify(value, (k, v) => {
      if (k === 'signal' || typeof v === 'function') return undefined
      if (typeof v === 'bigint') return String(v)
      return v
    }))
  } catch {
    return String(value)
  }
}

/** Create and start an Agent (see the class). */
function createAgent (opts) {
  return Agent.create(opts)
}

module.exports = { Agent, createAgent, loadPlugins, runSkill, runScenario, skills: defaultSkills, formatEvent, jsonSafe, DEFAULT_STEP_TIMEOUT }
