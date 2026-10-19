// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Background safety behaviours of the Agent. They run between and *during* skills: when one takes over (`busy`),
 * pathfinder and digging are stopped, the skill's waits (`safety.idle()`, navigate.goto, obtain, dig) pause, and the
 * skill carries on afterwards.
 *
 * - **threats**: a hostile mob that hurt the bot, or comes close (creepers, anything within `engageRadius`), is fought
 *   with the combat helpers of skills/combat.js (`fight`: melee / bow, retreats when low) — or fled from when the
 *   bot is too weak (no weapon and low health);
 * - **lava / fire**: in lava → jump and run to the nearest solid ground away from it;
 * - **drowning**: low on air in water → swim up;
 * - **eating**: mineflayer-auto-eat (loaded by the runner) eats when hungry; while it eats the skill waits.
 * Everything is recorded in `interventions` (type, target, outcome, ms) for the Agent's report.
 */
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const world = require('./world')
const { AbortError } = require('./errors')

class Safety extends EventEmitter {
  /**
   * @param {object} bot
   * @param {object} [opts]
   * @param {number} [opts.engageRadius=5] fight hostiles that come this close (creepers: 6)
   * @param {number} [opts.alertRadius=12] fight a hostile this far away when it hurt the bot recently
   * @param {number} [opts.fleeHealth=4] flee instead of fighting at or below this health without a weapon
   * @param {(msg: string) => void} [opts.log]
   */
  constructor (bot, opts = {}) {
    super()
    this.bot = bot
    this.opts = { engageRadius: 5, alertRadius: 12, fleeHealth: 4, fightTimeout: 15000, ignoreMs: 60000, ...opts }
    this.ignored = new Map() // entity id → until (fights that timed out: the mob cannot get at the bot either)
    this.lastBusyEnd = 0
    this.log = opts.log ?? (() => {})
    this.busy = null // { type, since }
    this.interventions = []
    this.lastHurt = 0
    this.enabled = false
    this._tick = 0
    this._waiters = []
    this._listeners = []
  }

  start () {
    if (this.enabled) return
    this.enabled = true
    const on = (emitter, event, fn) => { emitter.on(event, fn); this._listeners.push([emitter, event, fn]) }
    on(this.bot, 'entityHurt', (e) => { if (e === this.bot.entity) this.onHurt() })
    on(this.bot, 'physicsTick', () => this.onTick())
    if (this.bot.autoEat) {
      on(this.bot.autoEat, 'eatStart', () => this.claim('eat'))
      on(this.bot.autoEat, 'eatFinish', () => this.release('eat'))
      on(this.bot.autoEat, 'eatFail', () => this.release('eat'))
    }
    on(this.bot, 'death', () => { this.release(this.busy?.type) })
  }

  stop () {
    this.enabled = false
    for (const [emitter, event, fn] of this._listeners) emitter.removeListener(event, fn)
    this._listeners = []
    this.release(this.busy?.type)
  }

  /** resolves when no safety behaviour has the controls (rejects on abort) */
  idle (signal) {
    if (signal?.aborted) return Promise.reject(new AbortError())
    if (!this.busy) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const waiter = { resolve, reject }
      const onAbort = () => {
        this._waiters = this._waiters.filter((w) => w !== waiter)
        reject(new AbortError())
      }
      waiter.resolve = () => { signal?.removeEventListener('abort', onAbort); resolve() }
      signal?.addEventListener('abort', onAbort, { once: true })
      this._waiters.push(waiter)
    })
  }

  claim (type) {
    if (this.busy) return false
    this.busy = { type, since: Date.now() }
    this.emit('busy', type)
    return true
  }

  /** whether a behaviour had the controls within the last `ms` */
  recentlyBusy (ms) {
    return !!this.busy || Date.now() - this.lastBusyEnd < ms
  }

  release (type) {
    if (!this.busy || (type && this.busy.type !== type)) return
    this.busy = null
    this.lastBusyEnd = Date.now()
    this.emit('idle')
    const waiters = this._waiters
    this._waiters = []
    for (const w of waiters) w.resolve()
  }

  onHurt () {
    this.lastHurt = Date.now()
    this.check(true)
  }

  onTick () {
    if (!this.enabled || this.busy) return
    if (++this._tick % 4 !== 0) return
    this.check(false)
  }

  check (hurt) {
    if (!this.enabled || this.busy || !this.bot.entity || this.bot.health <= 0) return
    const bot = this.bot
    // lava first
    const feet = bot.blockAt(bot.entity.position.floored())
    if (bot.entity.isInLava || world.isLava(feet)) { this.run('lava', () => this.escapeLava()); return }
    // suffocating: gravel / sand fell into the head cell
    const head = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).floored())
    const fullCube = (b) => b.shapes?.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1'
    if (head && head.boundingBox === 'block' && fullCube(head) && !world.isLiquid(head) && head.diggable && !world.isProtected(bot, head.position) && !(this.headBlockedUntil > Date.now())) {
      this.run('suffocating', () => this.digOut())
      return
    }
    if ((bot.oxygenLevel ?? 20) < 8 && (bot.entity.isInWater || world.isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())))) {
      this.run('drowning', () => this.swimUp())
      return
    }
    const combat = require('./skills/combat')
    const recentlyHurt = Date.now() - this.lastHurt < 4000
    const radius = recentlyHurt ? this.opts.alertRadius : this.opts.engageRadius
    const now = Date.now()
    const target = combat.nearestHostile(bot, {
      radius: Math.max(radius, 6),
      exclude: (e) => !hurt && (this.ignored.get(e.id) ?? 0) > now && e.position.distanceTo(bot.entity.position) > 4
    })
    if (!target) return
    const d = target.position.distanceTo(bot.entity.position)
    const engage = d <= radius || (target.name === 'creeper' && d <= 6) || (hurt && d <= this.opts.alertRadius)
    if (!engage) return
    const weak = !combat.bestWeapon(bot) && bot.health <= this.opts.fleeHealth
    if (weak) this.run('flee', () => this.flee(target), target)
    else this.run('fight', () => this.fight(target), target)
  }

  run (type, fn, target) {
    if (!this.claim(type)) return
    const bot = this.bot
    const started = Date.now()
    const record = { type, target: target?.name, at: posOf(bot), startedAt: new Date(started).toISOString() }
    this.log(`safety: ${type}${target ? ` ${target.name} at ${target.position.distanceTo(bot.entity.position).toFixed(1)}` : ''}`)
    this.emit('intervention', record)
    // take the controls: stop walking / digging, close windows
    try { bot.pathfinder?.setGoal(null) } catch {}
    try { if (bot.targetDigBlock) bot.stopDigging() } catch {}
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    try { bot.clearControlStates() } catch {}
    Promise.resolve().then(fn).then((outcome) => {
      record.outcome = outcome ?? 'done'
    }, (err) => {
      record.outcome = 'error'
      record.error = err.message
    }).finally(() => {
      record.ms = Date.now() - started
      this.interventions.push(record)
      try { bot.clearControlStates() } catch {}
      this.release(type)
    })
  }

  async fight (target) {
    const combat = require('./skills/combat')
    await combat.equipForCombat(this.bot, { shield: true }).catch(() => {})
    const r = await combat.fight(this.bot, target, { timeout: this.opts.fightTimeout, log: this.log })
    if (r.outcome === 'timeout') this.ignored.set(target.id, Date.now() + this.opts.ignoreMs)
    return r.outcome
  }

  /** dig the block (and whatever keeps falling) out of the head cell — never when lava would flow in */
  async digOut () {
    const bot = this.bot
    const navigate = require('./skills/navigate')
    for (let i = 0; i < 8; i++) {
      const cell = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).floored()
      const b = bot.blockAt(cell)
      if (!b || b.boundingBox !== 'block' || world.isLiquid(b)) return 'clear'
      if (world.FACES.some((f) => f.y !== -1 && world.isLava(bot.blockAt(cell.plus(f))))) break
      try {
        await navigate.digSafe(bot, b)
      } catch {
        break
      }
      await bot.waitForTicks(3).catch(() => {}) // a falling block lands before the next look
    }
    this.headBlockedUntil = Date.now() + 5000 // do not retry every 4 ticks
    return 'still blocked'
  }

  /** run away from `target` for a few seconds */
  async flee (target) {
    const bot = this.bot
    for (let i = 0; i < 60 && bot.entities[target.id] && bot.health > 0; i++) {
      const away = bot.entity.position.minus(target.position)
      const dir = away.norm() > 0.01 ? away.normalize() : new Vec3(1, 0, 0)
      await bot.lookAt(bot.entity.position.plus(dir.scaled(4)).offset(0, 1.6, 0), true)
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.setControlState('jump', bot.entity.isCollidedHorizontally)
      await bot.waitForTicks(2).catch(() => {})
      if (target.position.distanceTo(bot.entity.position) > 16) break
    }
    bot.clearControlStates()
    return 'fled'
  }

  /** out of lava: towards the nearest standable non-lava cell, jumping */
  async escapeLava () {
    const bot = this.bot
    const here = bot.entity.position.floored()
    let best = null
    for (let dx = -4; dx <= 4; dx++) {
      for (let dz = -4; dz <= 4; dz++) {
        for (let dy = -1; dy <= 2; dy++) {
          const p = here.offset(dx, dy, dz)
          if (!world.standable(bot, p) || world.isLava(bot.blockAt(p))) continue
          const d = Math.hypot(dx, dz) + Math.abs(dy)
          if (!best || d < best.d) best = { p, d }
        }
      }
    }
    for (let i = 0; i < 60 && bot.health > 0; i++) {
      const feet = bot.blockAt(bot.entity.position.floored())
      if (!bot.entity.isInLava && !world.isLava(feet)) break
      if (best) await bot.lookAt(best.p.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', !!best)
      bot.setControlState('jump', true)
      await bot.waitForTicks(1).catch(() => {})
    }
    bot.clearControlStates()
    return bot.entity.isInLava ? 'still in lava' : 'escaped'
  }

  async swimUp () {
    const bot = this.bot
    // centred in the cell: rubbing on the wall of a 1×1 water shaft keeps the bot down
    await require('./skills/navigate').stepTo(bot, bot.entity.position.floored(), undefined, { tolerance: 0.15, ticks: 20 }).catch(() => {})
    let lastY = bot.entity.position.y
    let still = 0
    for (let i = 0; i < 80 && bot.health > 0; i++) {
      const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())
      if (!world.isWater(head) && (bot.oxygenLevel ?? 20) >= 15) break
      bot.setControlState('jump', true)
      await bot.waitForTicks(1).catch(() => {})
      still = bot.entity.position.y > lastY + 0.01 ? 0 : still + 1
      lastY = bot.entity.position.y
      if (still > 10) break // a ceiling over the water (flooded cave)
    }
    bot.clearControlStates()
    const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())
    if (!world.isWater(head)) return 'surfaced'
    // no air above: swim to the nearest pocket of air instead
    const pocket = this.airPocket(6)
    if (!pocket) return 'no air'
    const { goals } = require('mineflayer-pathfinder')
    await require('./skills/navigate').goto(bot, new goals.GoalBlock(pocket.x, pocket.y, pocket.z), { timeout: 8000, attempts: 1, legs: false }).catch(() => {})
    return world.isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())) ? 'no air' : 'air pocket'
  }

  /** the nearest cell (≤ radius) with air at the feet and the head, on something to stand / float on */
  airPocket (radius) {
    const bot = this.bot
    const here = bot.entity.position.floored()
    let best = null
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        for (let dy = -2; dy <= radius; dy++) {
          const p = here.offset(dx, dy, dz)
          const feet = bot.blockAt(p)
          const head = bot.blockAt(p.offset(0, 1, 0))
          if (!feet || !head || !world.isPassable(feet) || !world.isPassable(head)) continue
          const below = bot.blockAt(p.offset(0, -1, 0))
          if (!below || !(world.isSolid(below) || world.isWater(below))) continue
          const d = Math.abs(dx) + Math.abs(dy) + Math.abs(dz)
          if (!best || d < best.d) best = { p, d }
        }
      }
    }
    return best?.p ?? null
  }
}

function posOf (bot) {
  const p = bot.entity?.position
  return p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null
}

module.exports = { Safety }
