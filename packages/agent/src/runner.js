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
const { SkillError, AbortError, isAbort } = require('./errors')
const { Safety } = require('./safety')
const inventory = require('./inventory')

const DEFAULT_STEP_TIMEOUT = 10 * 60 * 1000
/** longest wait for an aborted skill to unwind before the next task / the recovery drives the bot */
const WIND_DOWN_MS = 10000
/**
 * The stuck watchdog (Agent#run): a task whose bot stayed in a box of `STUCK_EXTENT` blocks for `stuckMs` without doing
 * anything (no block dug / placed, nothing crafted / smelted / picked up, no heartbeat) is aborted, the bot escapes
 * (out of the water, up to the sky, away from the spot) and the task runs again. Skills that stand still on purpose
 * (smelting, fishing, sleeping) send heartbeats. Defaults per skill; U18's skills (portal, nether, end, combat) have
 * their own budgets and run without it.
 */
const STUCK_MS = { obtain: 180000, mine: 180000, gather: 180000, navigate: 150000, explore: 150000, build: 240000, food: 150000, surface: 150000, fish: 150000, hunt: 150000 }
const STUCK_EXTENT = 6
/** event types that are progress (anything else — log lines, failed gotos — is not) */
const WORK_EVENTS = new Set(['mine', 'craft', 'smelt', 'place', 'pickup', 'obtained', 'build-site', 'build-verified', 'heartbeat', 'shaft', 'food', 'caught', 'slept'])

/**
 * Run one skill with a timeout.
 * @param {object} bot
 * @param {string} name skill name (key of the skill registry)
 * @param {object} [args]
 * @param {{ skills?: Record<string, Function>, timeout?: number, signal?: AbortSignal }} [opts]
 */
async function runSkill (bot, name, args = {}, { skills = defaultSkills, timeout = DEFAULT_STEP_TIMEOUT, signal, windDownMs = WIND_DOWN_MS } = {}) {
  const skill = Object.hasOwn(skills, name) ? skills[name] : undefined
  if (typeof skill !== 'function') throw new Error(`Unknown skill: ${name}`)
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal?.aborted) onAbort()
  else signal?.addEventListener('abort', onAbort, { once: true })
  let timer
  let onAborted
  const running = (async () => skill(bot, { ...args, signal: controller.signal }))()
  running.catch(() => {}) // settles after the race when it lost
  try {
    return await Promise.race([
      running,
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error('timeout'))
          reject(new SkillError(`Skill ${name} timed out after ${timeout} ms`, { code: 'TIMEOUT' }))
        }, timeout)
      }),
      // the caller's abort (a death, the stuck watchdog) ends the skill at once, whatever it is waiting for
      new Promise((resolve, reject) => {
        onAborted = () => {
          const reason = signal?.reason
          reject(reason instanceof Error ? reason : new AbortError(typeof reason === 'string' ? reason : undefined))
        }
        if (signal?.aborted) onAborted()
        else signal?.addEventListener('abort', onAborted, { once: true })
      })
    ])
  } catch (err) {
    // the skill saw the abort: let it unwind (it may be mid-dig / mid-path, its finally blocks may still move the bot)
    // before anything else drives the bot — bounded, a skill that ignores its signal cannot hold the next task
    if (controller.signal.aborted) {
      let wait
      await Promise.race([running.catch(() => {}), new Promise((resolve) => { wait = setTimeout(resolve, windDownMs) })])
      clearTimeout(wait)
    }
    throw err
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', onAbort)
    if (onAborted) signal?.removeEventListener('abort', onAborted)
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
  if (bot.autoEat) guardAutoEat(bot.autoEat)
  if (bot.autoEat) {
    bot.autoEat.setOpts({
      minHunger: 16,
      minHealth: 0, // auto-eat's default 14 tries to eat whenever hurt, even when full (Bedrock refuses): hunger only
      priority: 'saturation', // cooked > raw meat > rotten flesh (eaten only when nothing better is carried)
      bannedFood: ['spider_eye', 'poisonous_potato', 'pufferfish', 'chicken', 'golden_apple', 'enchanted_golden_apple', 'chorus_fruit', 'suspicious_stew']
    })
    if (autoEat) bot.autoEat.enableAuto()
  }
  bot.pathfinder.thinkTimeout = 10000 // ms per search (upstream 5 s): hills and caves need more nodes
  bot.pathfinder.setMovements(require('./skills/navigate').movements(bot))
}

/**
 * mineflayer-auto-eat 5.0.3 sets its "eating" flag before equipping the food and only clears it on the paths after
 * the meal started: an equip that fails (a window open, a skill swapping the hand at the same moment) leaves the flag
 * set for good and the bot never eats again (seen in a chained run: food 5 with 5 cooked meals carried). The wrapper
 * clears the flag when `eat()` fails before the meal began (instance property: auto-eat's own tick check calls
 * `this.eat()`, so it goes through it too).
 */
function guardAutoEat (autoEat) {
  if (autoEat._bedbooGuarded || typeof autoEat.eat !== 'function') return
  autoEat._bedbooGuarded = true
  const eat = autoEat.eat.bind(autoEat)
  autoEat.eat = async (opts) => {
    let started = false
    const onStart = () => { started = true }
    autoEat.once('eatStart', onStart)
    try {
      return await eat(opts)
    } catch (err) {
      if (!started && !/Already eating/.test(err.message)) autoEat._eating = false
      throw err
    } finally {
      autoEat.removeListener('eatStart', onStart)
    }
  }
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
    this.opts = { username: 'Agent', safety: true, autoEat: true, keepFed: true, recoverItems: true, rest: true, shelter: false, maxEvents: 5000, ...opts }
    this.bot = opts.bot ?? null
    this.skills = opts.skills ?? defaultSkills
    this.events = []
    this.tasks = []
    this.deaths = []
    // protectedZones: the agent's builds (never dug); traps: spots where a task got stuck (no ore / station / goal
    // there is chosen again for a while); home: where the bot's house is (M4)
    this.state = { protectedZones: [], lastDeath: null, traps: [], home: null }
    this._lastWork = 0
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
    // damage trace for the report: what hurt the bot and where (death causes are otherwise invisible)
    let lastHealth = bot.health
    bot.on('health', () => {
      if (bot.health > 0) this._lastInventory = inventory.counts(bot)
      if (bot.health < lastHealth && bot.entity) {
        const p = bot.entity.position
        const hostile = require('./skills/combat').nearestHostile(bot, { radius: 8 })
        this.event('hurt', {
          health: Math.round(bot.health * 10) / 10,
          damage: Math.round((lastHealth - bot.health) * 10) / 10,
          food: bot.food,
          oxygen: bot.oxygenLevel,
          at: posOf(bot),
          feet: bot.blockAt(p.floored())?.name,
          head: bot.blockAt(p.offset(0, 1.62, 0).floored())?.name,
          near: hostile ? `${hostile.name}@${hostile.position.distanceTo(p).toFixed(1)}` : null
        })
      }
      lastHealth = bot.health
    })
    bot.on('messagestr', (msg, position) => {
      if (bot.username && msg.includes(bot.username) && /death|died|slain|killed|drown|burn|fell|suffocat|lava|blew|shot/i.test(msg)) this.event('death-message', { msg })
    })
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
    if (WORK_EVENTS.has(type)) this._lastWork = Date.now()
    if (type === 'heartbeat') return e // the stuck watchdog's only: not worth a line in the report
    this.events.push(e)
    if (this.events.length > this.opts.maxEvents) this.events.splice(0, this.events.length - this.opts.maxEvents)
    this._log(formatEvent(e))
    this.emit('event', e)
    return e
  }

  onDeath () {
    const bot = this.bot
    let feet = null
    try { feet = bot.blockAt(bot.entity.position.floored())?.name ?? null } catch {}
    const death = { at: posOf(bot), feet, dimension: bot.game?.dimension, t: Date.now() - (this.startedAt ?? Date.now()), inventory: this._lastInventory ?? {} }
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
  async run (skill, args = {}, { timeout = DEFAULT_STEP_TIMEOUT, retries = 1, name, stuckMs = STUCK_MS[skill] ?? 0, stuckRetries = 2 } = {}) {
    const task = { name: name ?? skill, skill, args: jsonSafe(args), attempts: 0, ok: false, startedAt: new Date().toISOString() }
    this.tasks.push(task)
    const started = Date.now()
    let deaths = 0
    let stucks = 0
    this.event('task-start', { task: task.name, skill, args: task.args })
    for (;;) {
      task.attempts++
      const controller = new AbortController()
      this._abortTask = (reason) => controller.abort(reason)
      const watchdog = stuckMs > 0 ? this.watchdog(controller, stuckMs) : null
      try {
        const left = Math.max(1000, timeout - (Date.now() - started))
        // runSkill handles the abort (death, stuck) and its own timeout, and lets the skill wind down; this is the
        // last guard
        const result = await withTimeout(runSkill(this.bot, skill, args, { skills: this.skills, timeout: left, signal: controller.signal }), left + WIND_DOWN_MS + 5000, {
          message: `task ${task.name} timed out`
        })
        task.ok = true
        task.result = jsonSafe(result)
        break
      } catch (err) {
        const reason = controller.signal.aborted ? controller.signal.reason : null
        const died = reason?.code === 'DIED'
        const stuck = reason?.code === 'STUCK'
        const error = died || stuck ? reason : err
        task.errors = (task.errors ?? []).concat({ code: error.code ?? error.name, message: error.message })
        this.event('task-error', { task: task.name, attempt: task.attempts, code: error.code ?? error.name, error: error.message })
        if (died) {
          deaths++
          await this.recover().catch((e) => this.event('log', { msg: `recover: ${e.message}` }))
        }
        if (stuck) {
          stucks++
          await this.unstuck().catch((e) => this.event('log', { msg: `unstuck: ${e.message}` }))
        }
        const again = (died && deaths <= retries) || (stuck && stucks <= stuckRetries)
        if (!again || Date.now() - started > timeout) {
          task.error = { code: error.code ?? error.name, message: error.message }
          break
        }
      } finally {
        if (watchdog) clearInterval(watchdog)
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
   * The stuck watchdog of one task attempt (see STUCK_MS): every 5 s, the bot's positions over the last `stuckMs`
   * all in a box of STUCK_EXTENT blocks, no progress event and no heartbeat in that time, safety not busy → abort the
   * attempt with a STUCK error. @returns {object} the interval (cleared by run())
   */
  watchdog (controller, stuckMs) {
    const samples = []
    const started = Date.now()
    let quietSince = Date.now()
    return setInterval(() => {
      const bot = this.bot
      if (!bot?.entity || bot.health <= 0 || controller.signal.aborted) return
      const now = Date.now()
      // a fight / flight / meal, a sleep: not the task's fault
      // (a behaviour that has held the controls for over a minute is stuck itself: no excuse)
      if ((this.safety?.busy && now - this.safety.busy.since < 60000) || bot.isSleeping) quietSince = now
      samples.push({ t: now, p: bot.entity.position.clone() })
      while (samples.length && samples[0].t < now - stuckMs) samples.shift()
      if (now - started < stuckMs || now - Math.max(quietSince, this._lastWork) < stuckMs) return
      // the box the bot stayed in (a tower that keeps collapsing bounces up and down a few blocks: still stuck)
      const extent = Math.max(...['x', 'y', 'z'].map((a) => Math.max(...samples.map((s) => s.p[a])) - Math.min(...samples.map((s) => s.p[a]))))
      if (extent > STUCK_EXTENT) return
      const at = samples[0].p.floored()
      this.event('stuck', { at: posOf(bot), ms: stuckMs })
      this.state.traps.push({ x: at.x, y: at.y, z: at.z, until: now + 10 * 60 * 1000 })
      controller.abort(new SkillError(`stuck at ${at} for ${Math.round(stuckMs / 1000)} s`, { code: 'STUCK' }))
    }, this.opts.watchdogInterval ?? 5000)
  }

  /**
   * After the watchdog aborted a stuck task: out of the water onto a bank, up to the open sky (pillar / staircase),
   * then a few blocks away from the spot. Best effort, ≤ 3 minutes.
   */
  async unstuck () {
    const bot = this.bot
    if (!bot?.entity || bot.health <= 0) return
    this.event('unstuck', { at: posOf(bot) })
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('unstuck timeout')), 180000)
    // a death on the way out (lava, a fall) aborts the escape like a task: then the usual recovery
    this._abortTask = (reason) => controller.abort(reason)
    try {
      await require('./skills/survive').escape(bot, { signal: controller.signal, away: this.state.traps.at(-1) })
    } catch (err) {
      if (!isAbort(err) && err.code !== 'DIED') this.event('log', { msg: `unstuck: ${err.message}` })
    } finally {
      this._abortTask = null
      clearTimeout(timer)
      try { bot.pathfinder?.setGoal(null) } catch {}
      try { bot.clearControlStates() } catch {}
    }
    if (controller.signal.reason?.code === 'DIED') {
      await this.recover().catch((e) => this.event('log', { msg: `recover: ${e.message}` }))
      return
    }
    this.event('unstuck-done', { at: posOf(bot) })
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
    // died again while recovering (getting a pickaxe): that recovery goes on with what is left
    if (this._recovering) return
    if (!this.opts.recoverItems || !death?.at || death.dimension !== bot.game?.dimension) return
    const at = new Vec3(death.at.x, death.at.y, death.at.z)
    if (at.distanceTo(bot.entity.position) > 400) return
    const lost = Object.keys(death.inventory ?? {}).length
    if (!lost) return
    // died in (or burning next to) lava: the drops burnt, and walking back there kills the bot again
    const lavaNear = () => {
      for (let dx = -1; dx <= 1; dx++) {
        for (let dy = -1; dy <= 1; dy++) {
          for (let dz = -1; dz <= 1; dz++) if (/lava/.test(bot.blockAt(at.floored().offset(dx, dy, dz))?.name ?? '')) return true
        }
      }
      return false
    }
    if (/lava/.test(death.feet ?? '') || lavaNear()) {
      this.event('log', { msg: `recover: died in / next to lava at ${at.floored()}; the drops are gone` })
      return
    }
    this.event('recover', { to: death.at })
    const navigate = require('./skills/navigate')
    const { goals } = require('mineflayer-pathfinder')
    // far below (died in a mine): a shaft down next to the spot, like the miner reaches deep ores; it needs a pickaxe
    // (a wooden one is quick to make and digs stone; the drops despawn 5 minutes after the death)
    let deep = bot.entity.position.y - at.y > 12
    if (deep && !bot.inventory.items().some((i) => /_pickaxe$/.test(i.name))) {
      const depth = Math.round(bot.entity.position.y - at.y)
      if (!this.skills.obtain) {
        this.event('log', { msg: `recover: ${at.y} is ${depth} blocks down and no pickaxe is left; giving the drops up` })
        return
      }
      this.event('log', { msg: `recover: ${at.y} is ${depth} blocks down and no pickaxe is left; making one first` })
      this._recovering = true
      try {
        await this.run('obtain', { item: 'wooden_pickaxe', count: 1 }, { name: 'recover: a pickaxe', timeout: 120000, retries: 0 })
      } catch (err) {
        this.event('log', { msg: `recover: no pickaxe (${err.message}); giving the drops up` })
        return
      } finally {
        this._recovering = false
      }
      // the trees may have been anywhere: where the bot stands now decides
      if (at.distanceTo(bot.entity.position) > 400) return
      deep = bot.entity.position.y - at.y > 12
    }
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('recover timeout')), 120000)
    try {
      if (deep) await require('./dig').shaftTo(bot, at.floored(), { signal: controller.signal })
      await navigate.goto(bot, new goals.GoalNear(at.x, at.y, at.z, 2), { signal: controller.signal, timeout: 110000 })
      await require('./dig').pickupNear(bot, at.offset(0.5, 0.5, 0.5), { signal: controller.signal, radius: 8, wait: 2000, timeout: 30000 })
    } catch (err) {
      if (!isAbort(err)) this.event('log', { msg: `recover: ${err.message}` })
    } finally {
      clearTimeout(timer)
    }
    // the armor and the shield came back as items: wear them again
    await require('./skills/combat').equipForCombat(bot, { shield: true }).catch(() => {})
    this.event('recovered', { inventory: inventory.counts(bot) })
  }

  /**
   * Between tasks: hungry and (almost) no food carried → hunt for some (best effort, `food` skill). Hunger only drops
   * on easy or harder; mineflayer-auto-eat does the eating.
   */
  async maintain ({ timeout = 90000 } = {}) {
    const bot = this.bot
    if (!bot?.entity) return
    // between steps: a sleep only (a whole night in a shelter would eat the scenario's budget)
    await this.restIfNight({ timeout: Math.max(timeout, 90000), shelter: false })
    // room for what the next step digs up
    const tossed = await inventory.declutter(bot, { minFree: 6 }).catch(() => ({}))
    if (Object.keys(tossed).length) this.event('tossed', { items: tossed })
    if (!this.opts.keepFed || !this.skills.food) return
    const { foodPoints } = require('./skills/survive')
    if (bot.food > 12 || foodPoints(bot) >= 6) return
    this.event('maintain', { food: bot.food, carried: foodPoints(bot) })
    // the skill knows its budget (it decides whether cooking still fits)
    await this.run('food', { min: 8, explore: false, radius: 40, timeout: timeout - 5000 }, { name: 'food (maintenance)', timeout, retries: 0 }).catch((err) => this.event('log', { msg: `maintenance: ${err.message}` }))
  }

  /**
   * At night in the overworld: sleep in the carried bed (the night is skipped) — or, with `shelter` (default: the
   * Agent's `shelter` option) and no armor worn, sit the night out in the house / a sealed hole (skills/rest.js).
   * `maintain()` (between scenario steps) only sleeps; a runner calls this between its phases for the shelter. A
   * failed attempt is not repeated for 2 minutes. Never throws.
   */
  async restIfNight ({ timeout, shelter = !!this.opts.shelter } = {}) {
    const bot = this.bot
    if (!this.opts.rest || !this.skills.rest || !bot?.entity || bot.health <= 0) return
    // a sleep that failed (monsters nearby behind a wall, no room for the bed) is not tried again before every step
    if (Date.now() < (this._restAgainAt ?? 0)) return
    const rest = require('./skills/rest')
    const how = rest.restMode(bot, { shelter })
    if (!how) return
    const ms = Math.max(30000, Math.min(timeout ?? Infinity, how === 'shelter' ? 10 * 60 * 1000 : 90000))
    await this.run('rest', { shelter, timeout: ms - 5000 }, { name: `night: ${how}`, timeout: ms, retries: 0 })
      .then((r) => { if (r?.rested !== 'slept' && r?.rested !== 'sheltered') this._restAgainAt = Date.now() + 120000 })
      .catch((err) => {
        this._restAgainAt = Date.now() + 120000
        this.event('log', { msg: `rest: ${err.message}` })
      })
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
      if (deadline - Date.now() <= 0) { ok = false; error = { code: 'TIMEOUT', message: `${scenario.name} ran out of time` }; break }
      await this.maintain({ timeout: Math.min(75000, (deadline - Date.now()) / 4) })
      // what is left after the maintenance (a night's sleep, a meal hunted)
      const left = deadline - Date.now()
      if (left <= 0) { ok = false; error = { code: 'TIMEOUT', message: `${scenario.name} ran out of time` }; break }
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

module.exports = { Agent, createAgent, loadPlugins, guardAutoEat, runSkill, runScenario, skills: defaultSkills, formatEvent, jsonSafe, DEFAULT_STEP_TIMEOUT, STUCK_MS, WIND_DOWN_MS }
