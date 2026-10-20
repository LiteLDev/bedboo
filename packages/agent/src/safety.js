// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Background safety behaviours of the Agent. They run between and *during* skills: when one takes over (`busy`),
 * pathfinder and digging are stopped, the skill's waits (`safety.idle()`, navigate.goto, obtain, dig) pause, and the
 * skill carries on afterwards.
 *
 * - **threats**: a hostile mob that hurt the bot, or comes close (creepers, anything within `engageRadius`), is fought
 *   with the combat helpers of skills/combat.js (`fight` with `safe: true`: it never steps into lava / fire / a portal
 *   or off a ledge; melee / bow, retreats and eats when low) — or fled from when the bot is too weak (no weapon and low
 *   health). A mob that hurt the bot is fought back even when it is neutral (a piglin, an enderman), but only when it
 *   swung its arm just before (combat.likelyAttacker): provoking a neutral mob by mistake turns its group against the
 *   bot. A mob the bot could neither hit nor get closer to for `fightGiveUpMs`, or that ran `maxChase` blocks away, is
 *   left alone for `ignoreMs`;
 * - **fireballs**: a ghast fireball coming within 4 blocks is hit back;
 * - **lava / fire**: in lava → jump and run to the nearest solid ground away from it;
 * - **drowning**: low on air in water → swim up (or to the nearest pocket of air);
 * - **suffocating**: gravel / sand fell into the head cell → dig it out;
 * - **eating**: mineflayer-auto-eat (loaded by the runner) eats when hungry — and, while the bot is hurt, as soon as
 *   the food bar drops below 18 (natural regeneration needs 18); while it eats the skill waits. During a fight
 *   auto-eat is paused (the fight eats itself while it retreats).
 * - **drops**: what a mob the bot killed dropped right next to it (string, bones, rotten flesh) is picked up.
 *
 * U18's skills (portal, nether, end) run under `combat.guardFor()`, which under an Agent is a `SafetyGuard` around
 * this object: the guard's options (`radius`, `maxDy`, `ignore`, `includeNeutral`, `retaliate`, `deflect`) are pushed
 * with `pushGuard()` for as long as the skill runs, so the skill keeps the protections its own `combat.defend()` guard
 * would give it.
 *
 * Everything is recorded in `interventions` (type, target, outcome, ms) for the Agent's report.
 */
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const world = require('./world')
const { AbortError } = require('./errors')

/** projectiles a melee hit sends back (ghast fireballs) */
const DEFLECTABLE = new Set(['fireball', 'large_fireball'])
/** how long fights given up on a mob count towards ignoring it for good */
const GIVEN_UP_MS = 3 * 60 * 1000
const fullCube = (b) => b.shapes?.length === 1 && b.shapes[0].join(',') === '0,0,0,1,1,1'
/** melee mobs that follow the bot at its own speed: no use running from them */
const CHASERS = new Set(['zombie', 'husk', 'drowned', 'zombie_villager', 'zombie_villager_v2', 'spider', 'cave_spider', 'zombified_piglin', 'zombie_pigman', 'piglin', 'piglin_brute', 'hoglin', 'zoglin', 'vindicator', 'enderman', 'silverfish', 'endermite', 'slime', 'magma_cube'])

class Safety extends EventEmitter {
  /**
   * @param {object} bot
   * @param {object} [opts]
   * @param {number} [opts.engageRadius=5] fight hostiles that come this close (creepers: 6)
   * @param {number} [opts.alertRadius=12] fight a hostile this far away when it hurt the bot recently
   * @param {number} [opts.fleeHealth=4] flee instead of fighting at or below this health without a weapon
   * @param {number} [opts.fightTimeout=25000] longest fight
   * @param {number} [opts.fightGiveUpMs=12000] give a fight up after this long without a hit or getting closer
   * @param {number} [opts.maxChase=24] give a fight up when the mob ran this far from where it started
   * @param {number} [opts.ignoreMs=60000] a mob given up on is left alone this long (unless it hurts the bot)
   * @param {boolean} [opts.pickupDrops=true] pick up what a killed mob dropped next to the bot
   * @param {(msg: string) => void} [opts.log]
   */
  constructor (bot, opts = {}) {
    super()
    this.bot = bot
    this.opts = { engageRadius: 5, alertRadius: 12, fleeHealth: 4, fightTimeout: 25000, fightGiveUpMs: 12000, maxChase: 24, ignoreMs: 60000, pickupDrops: true, ...opts }
    this.ignored = new Map() // entity id → until (fights given up: the mob cannot get at the bot either)
    this._givenUp = new Map() // entity id → { n: fights given up on it (within GIVEN_UP_MS of each other), at: the last }
    this.attackers = new Map() // entity → until: mobs that hurt the bot (retaliation)
    this.swings = new WeakMap() // entity → time of its last arm swing
    this.guards = [] // option sets of U18 skills running under combat.guardFor()
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
    this._air = undefined // (sampled again: a reading from before a stop is no fall)
    const on = (emitter, event, fn) => { emitter.on(event, fn); this._listeners.push([emitter, event, fn]) }
    on(this.bot, 'entityHurt', (e) => { if (e === this.bot.entity) this.onHurt() })
    on(this.bot, 'entitySwingArm', (e) => { if (e !== this.bot.entity) this.swings.set(e, Date.now()) })
    on(this.bot, 'physicsTick', () => this.onTick())
    on(this.bot, 'health', () => this.tuneEating())
    // auto-eat's automatic mode as the runner set it up (once: a restart during a hold sees it off): the meal holds
    // (suppressMeals) restore it
    this._autoEatWanted ??= !!this.bot.autoEat?.enabled
    if (this.bot.autoEat) {
      // a meal that starts or ends is no stuck one (back-to-back meals keep isEating set for long); 'eatFail' under
      // auto-eat's strictErrors comes from runner.js guardAutoEat
      on(this.bot.autoEat, 'eatStart', () => { this._eatingSince = 0; this.claim('eat') })
      on(this.bot.autoEat, 'eatFinish', () => { this._eatingSince = 0; this.release('eat') })
      on(this.bot.autoEat, 'eatFail', () => { this._eatingSince = 0; this.release('eat'); this.mealFailed() })
    }
    on(this.bot, 'death', () => { this.attackers.clear(); this.release(this.busy?.type) })
  }

  stop () {
    this.enabled = false
    if (this._mealPause) {
      clearTimeout(this._mealPause.timer)
      this._mealPause.release()
      this._mealPause = null
    }
    for (const [emitter, event, fn] of this._listeners) emitter.removeListener(event, fn)
    this._listeners = []
    this.release(this.busy?.type)
  }

  /**
   * A U18 skill's guard options, in force until `popGuard(token)`.
   * @param {{ radius?: number, maxDy?: number, ignore?: (e) => boolean, includeNeutral?: boolean, retaliate?: boolean,
   *   deflect?: boolean, names?: string[] }} opts
   * @returns {object} token
   */
  pushGuard (opts = {}) {
    const token = { opts }
    this.guards.push(token)
    return token
  }

  popGuard (token) {
    this.guards = this.guards.filter((g) => g !== token)
  }

  /** the options in force: the Agent's own, widened by every pushed guard */
  effective () {
    const out = { radius: this.opts.engageRadius, maxDy: Infinity, includeNeutral: false, retaliate: true, deflect: true, ignores: [] }
    for (const { opts } of this.guards) {
      if (opts.radius > out.radius) out.radius = opts.radius
      if (opts.maxDy !== undefined) out.maxDy = Number.isFinite(out.maxDy) ? Math.max(out.maxDy, opts.maxDy) : opts.maxDy
      if (opts.includeNeutral) out.includeNeutral = true
      if (opts.retaliate === false) out.retaliate = false
      if (opts.deflect === false) out.deflect = false
      if (typeof opts.ignore === 'function') out.ignores.push(opts.ignore)
    }
    // a guard keeps its fights to its own height band (the default band of combat.defend)
    if (this.guards.length && !Number.isFinite(out.maxDy)) out.maxDy = 4
    return out
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

  /** whether a behaviour that takes the controls (a fight, lava, drowning — not a meal) ran within the last `ms` */
  recentlyIntervened (ms) {
    return (!!this.busy && this.busy.type !== 'eat') || Date.now() - (this.lastInterventionEnd ?? 0) < ms
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

  /** hurt → mineflayer-auto-eat eats below 18 food (regeneration needs 18); else below 16 */
  tuneEating () {
    const ae = this.bot.autoEat
    if (!ae?.opts) return
    const want = this.bot.health > 0 && this.bot.health < 14 ? 18 : 16
    if (ae.opts.minHunger !== want) ae.opts.minHunger = want
    // rotten flesh only when starving (≤ 6): above that a meal of it is hunger and nausea for nothing, and the hungry
    // bot that carries nothing else restarts it every tick
    const banned = ae.opts.bannedFood ?? (ae.opts.bannedFood = [])
    const starving = this.bot.food <= 6
    const i = banned.indexOf('rotten_flesh')
    if (starving && i >= 0) banned.splice(i, 1)
    else if (!starving && i < 0) banned.push('rotten_flesh')
  }

  /**
   * Meals that keep failing (a tool / block swap by the pathfinder cancels each one, and auto-eat starts the next on
   * the following tick): after 3 failures in 15 s auto-eat pauses for 10 s — the task gets its hand back.
   */
  mealFailed () {
    const now = Date.now()
    this._mealFails = (this._mealFails ?? []).filter((t) => now - t < 15000)
    this._mealFails.push(now)
    // (meals eaten by hand while automatic mode is off are no reason to pause it)
    if (this._mealFails.length < 3 || this._mealPause || !this.bot.autoEat?.enabled) return
    this.log('safety: meals keep failing; auto-eat paused for 10 s')
    this._mealFails = []
    const release = this.suppressMeals()
    const timer = setTimeout(() => { this._mealPause = null; release() }, 10000)
    timer.unref?.()
    this._mealPause = { timer, release }
  }

  /**
   * Hold mineflayer-auto-eat's automatic mode off (a fight, a placement, a pause after failing meals); the returned
   * function releases the hold. Counted: auto-eat comes back on when the last hold is released, never while a fight
   * still holds it. @returns {() => void}
   */
  suppressMeals () {
    this._mealHolds = (this._mealHolds ?? 0) + 1
    this.applyMeals()
    let released = false
    return () => {
      if (released) return
      released = true
      this._mealHolds--
      this.applyMeals()
    }
  }

  applyMeals () {
    const ae = this.bot.autoEat
    if (!ae || typeof ae.disableAuto !== 'function') return
    if (this._mealHolds > 0) {
      if (ae.enabled) ae.disableAuto()
    } else if (this._autoEatWanted && !ae.enabled) ae.enableAuto()
  }

  onHurt () {
    this.lastHurt = Date.now()
    const eff = this.effective()
    if (eff.retaliate && this.bot.entity) {
      try {
        const combat = require('./skills/combat')
        const attacker = combat.likelyAttacker(this.bot, { swings: this.swings, exclude: (e) => eff.ignores.some((f) => f(e)) })
        if (attacker) {
          this.ignored.delete(attacker.id) // it got at the bot after all
          this.attackers.set(attacker, Date.now() + 20000)
        }
      } catch {}
    }
    this.check(true)
  }

  onTick () {
    if (!this.enabled) return
    if (++this._tick % 4 !== 0) return
    this.staleMeal()
    // air going down (in the water, or in a wall); none left out of the water: still in the wall
    const air = this.bot.oxygenLevel ?? 20
    const wet = !!this.bot.entity?.isInWater || this.headWet()
    if (wet) this._lastWet = Date.now()
    if (air < (this._air ?? 20) || (air <= 0 && !wet)) this._airFalling = Date.now()
    this._air = air
    if (this.busy) return
    this.check(false)
  }

  /**
   * mineflayer-auto-eat stuck "eating" (a meal that never started or never ended: no eatStart / eatFinish) for 15 s:
   * reset it, release the 'eat' claim — the bot would never eat again (see runner.js guardAutoEat).
   */
  staleMeal () {
    const ae = this.bot.autoEat
    if (!ae?.isEating) { this._eatingSince = 0; return }
    this._eatingSince ||= Date.now()
    if (Date.now() - this._eatingSince < 15000) return
    this.log('safety: auto-eat stuck eating for 15 s; reset')
    try { ae.cancelEat?.() } catch {}
    ae._eating = false
    this._eatingSince = 0
    this.release('eat')
  }

  /** the mob to fight now (an attacker first, then the nearest hostile close by), or null */
  threat (hurt) {
    const bot = this.bot
    const combat = require('./skills/combat')
    const eff = this.effective()
    const pos = bot.entity.position
    const now = Date.now()
    const dead = combat.deadEntities(bot)
    const ignoredBy = (e) => eff.ignores.some((f) => f(e))
    for (const [e, until] of this.attackers) {
      if (until < now || dead.has(e) || !bot.entities[e.id] || e.position.distanceTo(pos) > this.opts.alertRadius + 12 || ignoredBy(e)) this.attackers.delete(e)
    }
    const attacker = [...this.attackers.keys()].sort((a, b) => a.position.distanceTo(pos) - b.position.distanceTo(pos))[0]
    if (attacker && attacker.position.distanceTo(pos) <= Math.max(this.opts.alertRadius, eff.radius)) return { target: attacker, engage: true }
    const recentlyHurt = now - this.lastHurt < 4000
    const radius = recentlyHurt ? Math.max(this.opts.alertRadius, eff.radius) : eff.radius
    const target = combat.nearestHostile(bot, {
      radius: Math.max(radius, 6),
      includeNeutral: eff.includeNeutral,
      // a mob given up on (could not get at it: behind a wall, across a gap) stays ignored until it hurts the bot —
      // it is then an attacker — even right next to the bot (a zombie behind a block 3 blocks away is fought
      // forever otherwise)
      // (a creeper within 5 blocks is never ignored: it hurts only once it blows up — unless it was given up on twice
      // in the last 3 minutes: behind a wall, it never gets there)
      exclude: (e) => ignoredBy(e) || Math.abs(e.position.y - pos.y) > eff.maxDy ||
        ((this.ignored.get(e.id) ?? 0) > now && !(e.name === 'creeper' && e.position.distanceTo(pos) < 5 && !this.hardIgnored(e.id)))
    })
    if (!target) return null
    const d = target.position.distanceTo(pos)
    const engage = d <= radius || (target.name === 'creeper' && d <= 6) || (hurt && d <= this.opts.alertRadius)
    return engage ? { target, engage } : null
  }

  check (hurt) {
    if (!this.enabled || this.busy || !this.bot.entity || this.bot.health <= 0) return
    const bot = this.bot
    // lava first
    const feet = bot.blockAt(bot.entity.position.floored())
    if (bot.entity.isInLava || world.isLava(feet)) { this.run('lava', () => this.escapeLava()); return }
    // suffocating: gravel / sand fell into the head cell
    const head = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).floored())
    if (head && this.headInBlock() && head.diggable && !world.isProtected(bot, head.position) && !(this.headBlockedUntil > Date.now())) {
      this.run('suffocating', () => this.digOut())
      return
    }
    // suffocating in a block the client does not see yet: no fight now (the task's next climb step gets out of it)
    if (this.inWall()) return
    if ((bot.oxygenLevel ?? 20) < 8 && (bot.entity.isInWater || world.isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())))) {
      this.run('drowning', () => this.swimUp())
      return
    }
    if (this.effective().deflect) {
      const fireball = this.fireball()
      if (fireball) { this.run('deflect', () => this.deflect(fireball), fireball); return }
    }
    const t = this.threat(hurt)
    if (!t) return
    const combat = require('./skills/combat')
    // no weapon and low, or a creeper while the bot could not take its blast: run (unless the last flight from that
    // creeper went nowhere — a ledge, lava, a wall: then it is fought, hit and run, rather than waited for)
    const cornered = this._cornered?.id === t.target.id && this._cornered.until > Date.now()
    const weak = (!combat.bestWeapon(bot) && bot.health <= this.opts.fleeHealth) || (t.target.name === 'creeper' && bot.health <= 10 && !cornered)
    if (weak) this.run('flee', () => this.flee(t.target), t.target)
    else this.run('fight', () => this.fight(t.target), t.target)
  }

  /** a ghast fireball within hitting distance */
  fireball () {
    const combat = require('./skills/combat')
    for (const e of Object.values(this.bot.entities ?? {})) {
      if (DEFLECTABLE.has(e.name) && combat.hitboxDistance(this.bot, e) <= 4) return e
    }
    return null
  }

  async deflect (fireball) {
    await this.bot.lookAt(fireball.position, true)
    this.bot.attack(fireball)
    return 'deflected'
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
    this.lastIntervention = started
    Promise.resolve().then(fn).then((outcome) => {
      record.outcome = outcome ?? 'done'
    }, (err) => {
      record.outcome = 'error'
      record.error = err.message
    }).finally(() => {
      record.ms = Date.now() - started
      this.lastInterventionEnd = Date.now()
      this.interventions.push(record)
      try { bot.clearControlStates() } catch {}
      this.release(type)
    })
  }

  async fight (target) {
    const bot = this.bot
    const combat = require('./skills/combat')
    // auto-eat would swap the weapon for food mid-fight: the fight eats itself (while it retreats, out of reach)
    const releaseMeals = this.suppressMeals()
    let r
    try {
      await combat.equipForCombat(bot, { shield: true }).catch(() => {})
      // safe: the fight's own moves (approach, strafe, retreat) never step into lava / fire / a portal or off a ledge
      // over 3 blocks; a mob it cannot get at (across lava, up a wall) is given up after fightGiveUpMs
      r = await combat.fight(bot, target, {
        timeout: this.opts.fightTimeout,
        // running from a mob as fast as the bot (a zombie, a spider) only takes hits in the back: armored and armed,
        // the bot fights it to the end; retreating stays for creepers, ranged mobs and an unarmored bot
        ...(CHASERS.has(target.name) && combat.bestWeapon(bot) && require('./skills/rest').wearsArmor(bot) >= 2 ? { retreatHealth: 0 } : {}),
        safe: true,
        giveUpMs: this.opts.fightGiveUpMs,
        maxChase: this.opts.maxChase,
        eat: true,
        bow: 'auto',
        // another mob hitting the bot from up close while this one is out of reach: that one first; the bot
        // suffocating (a falling block on its head mid-climb): out of the wall first
        stop: () => this.betterTarget(target) || this.inWall() || (!!this.headInBlock() && !(this.headBlockedUntil > Date.now())),
        log: this.log
      })
    } finally {
      releaseMeals()
    }
    if (r.outcome !== 'switched') this.attackers.delete(target) // (stopped for another one / to get out of a wall: still one)
    if (['timeout', 'unreachable', 'escaped'].includes(r.outcome)) {
      this.ignored.set(target.id, Date.now() + this.opts.ignoreMs)
      const g = this._givenUp.get(target.id)
      const now = Date.now()
      this._givenUp.set(target.id, { n: (g && now - g.at < GIVEN_UP_MS ? g.n : 0) + 1, at: now })
    }
    if (r.outcome === 'killed' && this.opts.pickupDrops) await this.collectDrops(target.position.clone()).catch(() => {})
    return r.outcome
  }

  /**
   * a mob given up on twice within 3 minutes: no exception for it any more while it is ignored (until it hurts the
   * bot); the count starts over when the last time is older (fight)
   */
  hardIgnored (id) {
    return (this._givenUp.get(id)?.n ?? 0) >= 2
  }

  /**
   * Suffocating in a block the client does not show yet (the server's block): air going down — out of the water for
   * 2 s and more — while being hurt
   */
  inWall () {
    if (!this.bot.entity) return false
    const now = Date.now()
    return now - (this._airFalling ?? 0) < 1500 && now - this.lastHurt < 1000 && now - (this._lastWet ?? 0) > 2000
  }

  headWet () {
    const e = this.bot.entity
    return !!e && world.isWater(this.bot.blockAt(e.position.offset(0, e.eyeHeight ?? 1.62, 0).floored()))
  }

  /** a full block in the head cell (gravel, sand fell into it): suffocating */
  headInBlock () {
    const bot = this.bot
    if (!bot.entity) return null
    const head = bot.blockAt(bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).floored())
    return head && head.boundingBox === 'block' && fullCube(head) && !world.isLiquid(head) ? head : null
  }

  /** an attacker that hit the bot in the last 2 s from within melee reach while `target` is out of it */
  betterTarget (target) {
    const combat = require('./skills/combat')
    if (combat.hitboxDistance(this.bot, target) <= 3.5) return false
    const now = Date.now()
    for (const [e, until] of this.attackers) {
      if (e === target || !this.bot.entities[e.id]) continue
      if (until - 20000 > now - 2000 && combat.hitboxDistance(this.bot, e) <= 3) return true
    }
    return false
  }

  /**
   * What the killed mob dropped (string, bones, …) within 4 blocks at about the same height: walked onto with plain
   * controls (≤ 4 s, never into lava / off a ledge).
   */
  async collectDrops (where) {
    const bot = this.bot
    const combat = require('./skills/combat')
    await bot.waitForTicks(6).catch(() => {}) // the drops spawn a moment after the death
    const near = () => Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(where) <= 3 &&
      e.position.xzDistanceTo(bot.entity.position) <= 4 && Math.abs(e.position.y - bot.entity.position.y) <= 1.2)
    const until = Date.now() + 4000
    try {
      for (let drop = near()[0]; drop && Date.now() < until && bot.health > 0; drop = near()[0]) {
        if (bot.entity.isInWater || bot.entity.isInLava) break
        await bot.lookAt(drop.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0), true)
        const controls = { forward: true }
        if (combat.hazardAhead(bot, controls)) break
        bot.setControlState('forward', true)
        bot.setControlState('jump', !!bot.entity.isCollidedHorizontally)
        await bot.waitForTicks(2).catch(() => {})
      }
    } finally {
      bot.clearControlStates()
    }
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
    const combat = require('./skills/combat')
    const from = bot.entity.position.clone()
    for (let i = 0; i < 60 && bot.entities[target.id] && bot.health > 0; i++) {
      const away = bot.entity.position.minus(target.position)
      const dir = away.norm() > 0.01 ? away.normalize() : new Vec3(1, 0, 0)
      await bot.lookAt(bot.entity.position.plus(dir.scaled(4)).offset(0, 1.6, 0), true)
      // never into lava / off a cliff
      if (combat.hazardAhead(bot, { forward: true })) { bot.clearControlStates(); break }
      bot.setControlState('forward', true)
      bot.setControlState('sprint', true)
      bot.setControlState('jump', bot.entity.isCollidedHorizontally)
      await bot.waitForTicks(2).catch(() => {})
      if (target.position.distanceTo(bot.entity.position) > 16) break
    }
    bot.clearControlStates()
    // cornered (less than 3 blocks gained, the mob still close): it is fought next time, not fled from again
    if (bot.entities[target.id] && bot.entity.position.distanceTo(from) < 3 && target.position.distanceTo(bot.entity.position) < 8) {
      this._cornered = { id: target.id, until: Date.now() + 15000 }
      return 'cornered'
    }
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
    await require('./skills/navigate').goto(bot, new goals.GoalBlock(pocket.x, pocket.y, pocket.z), { timeout: 8000, attempts: 1, legs: false, safety: false }).catch(() => {})
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

module.exports = { Safety, DEFLECTABLE }
