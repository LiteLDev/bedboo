'use strict'
// owner: U18 (agent combat & dimensions) — the combat skill's guard / hunt / safety helpers on a fake mineflayer bot
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const combat = require('../src/skills/combat')

/** a minimal mineflayer-shaped bot on a stone floor (y < 0 solid); `world` overrides blocks by "x,y,z" */
function fakeBot ({ position = new Vec3(0.5, 0, 0.5), items = [], world = {} } = {}) {
  const bot = new EventEmitter()
  bot.entity = { id: 0, position, yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, type: 'player', isCollidedHorizontally: false }
  bot.entities = { 0: bot.entity }
  bot.health = 20
  bot.food = 20
  bot.game = { dimension: 'overworld' }
  bot.controlState = { forward: false, back: false, left: false, right: false, sprint: false, jump: false, sneak: false }
  bot.setControlState = (c, on) => { bot.controlState[c] = on }
  bot.clearControlStates = () => { for (const c of Object.keys(bot.controlState)) bot.controlState[c] = false }
  bot.inventory = { slots: new Array(46).fill(null), items: () => items }
  bot.heldItem = null
  bot.equip = async (item, dest) => { if (dest === 'hand') bot.heldItem = item }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async (p) => {
    const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
    bot.entity.yaw = Math.atan2(-d.x, -d.z)
    bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  bot.attacks = []
  bot.attack = (target) => { bot.attacks.push(target); bot.emit('_attack', target) }
  bot.activateItem = () => {}
  bot.deactivateItem = () => {}
  bot.blockAt = (p) => {
    const f = p.floored()
    const name = world[`${f.x},${f.y},${f.z}`] ?? (f.y < 0 ? 'stone' : 'air')
    return { name, position: f, boundingBox: ['air', 'lava', 'water', 'fire'].includes(name) ? 'empty' : 'block' }
  }
  bot.nearestEntity = (match) => {
    let best = null
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !match(e)) continue
      if (!best || e.position.distanceTo(bot.entity.position) < best.position.distanceTo(bot.entity.position)) best = e
    }
    return best
  }
  bot.waitForTicks = async (n) => {
    for (let i = 0; i < n; i++) {
      if (bot.controlState.forward) {
        const step = bot.controlState.sprint ? 0.28 : 0.22
        bot.entity.position = bot.entity.position.offset(-Math.sin(bot.entity.yaw) * step, 0, -Math.cos(bot.entity.yaw) * step)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return bot
}

function mob (id, name, position, extra = {}) {
  return { id, name, type: 'hostile', kind: 'Hostile mobs', position, width: 0.6, height: 1.9, ...extra }
}

/** kill `target` after `hits` attacks (entityHurt per hit, entityDead + removal on the last) */
function dieAfter (bot, target, hits) {
  let n = 0
  bot.on('_attack', (t) => {
    if (t !== target) return
    bot.emit('entityHurt', t)
    if (++n === hits) setImmediate(() => { bot.emit('entityDead', t); delete bot.entities[t.id] })
  })
}

const until = async (predicate, ms = 3000) => {
  const end = Date.now() + ms
  while (!predicate()) {
    if (Date.now() > end) throw new Error('condition not met')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

describe('U18 combat skill: safety (hazardAhead)', () => {
  it('lava or fire ahead, a void or a cliff higher than 3 blocks are hazards; a step down onto ground is not', () => {
    const facingNorth = { forward: true } // yaw 0 → -z
    assert.strictEqual(combat.hazardAhead(fakeBot(), facingNorth), false)
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,0,-1': 'lava' } }), facingNorth), true)
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,-1,-1': 'lava' } }), facingNorth), true, 'lava below the next step')
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,0,-1': 'fire' } }), facingNorth), true)
    // a hole 5 deep in front: no ground within 3 blocks below the step
    const hole = {}
    for (let y = -1; y >= -6; y--) { hole[`0,${y},-1`] = 'air'; hole[`0,${y},-2`] = 'air' }
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: hole }), facingNorth), true)
    // a 2-block drop onto stone is fine
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,-1,-1': 'air', '0,-2,-1': 'air', '0,-1,-2': 'air', '0,-2,-2': 'air' } }), facingNorth), false)
    // backing away from lava behind the bot is the hazard, not walking forward
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,0,1': 'lava' } }), { back: true }), true)
    assert.strictEqual(combat.hazardAhead(fakeBot({ world: { '0,0,1': 'lava' } }), facingNorth), false)
    assert.strictEqual(combat.hazardAhead(fakeBot(), {}), false, 'standing still')
  })

  it('fight (safe: the guard, hunts) never walks into lava between the bot and the target', async () => {
    const world = {}
    for (let z = -1; z >= -3; z--) world[`0,0,${z}`] = 'lava'
    const bot = fakeBot({ world, items: [{ name: 'iron_sword' }] })
    const zombie = mob(2, 'zombie', new Vec3(0.5, 0, -5))
    bot.entities[2] = zombie
    const r = await combat.fight(bot, zombie, { bow: false, timeout: 400, safe: true })
    assert.strictEqual(r.outcome, 'timeout')
    assert.ok(r.hazardStops > 0, 'stopped at the lava')
    assert.ok(bot.entity.position.z > -0.5, `the bot stayed out of the lava: ${bot.entity.position}`)
  })

  it('fight: a target that runs farther than maxChase from the fight start → escaped', async () => {
    const bot = fakeBot({ items: [{ name: 'iron_sword' }] })
    const zombie = mob(2, 'zombie', new Vec3(0.5, 0, -6))
    bot.entities[2] = zombie
    setTimeout(() => { zombie.position = new Vec3(0.5, 0, -40) }, 30)
    const r = await combat.fight(bot, zombie, { bow: false, timeout: 3000, maxChase: 20 })
    assert.strictEqual(r.outcome, 'escaped')
  })
})

describe('U18 combat skill: defend (background guard)', () => {
  it('engages a hostile that comes within the radius, kills it, reports busy → idle and the kill', async () => {
    const bot = fakeBot({ items: [{ name: 'iron_sword' }] })
    const guard = combat.defend(bot, { radius: 8, interval: 10, eat: false })
    const events = []
    guard.on('busy', () => events.push('busy'))
    guard.on('idle', () => events.push('idle'))
    try {
      await new Promise((resolve) => setTimeout(resolve, 40))
      assert.strictEqual(guard.busy, false, 'nothing to do yet')
      const zombie = mob(2, 'zombie', new Vec3(0.5, 0, -6))
      dieAfter(bot, zombie, 2)
      bot.entities[2] = zombie
      await until(() => guard.stats.killed.zombie === 1)
      await guard.idle()
      assert.deepStrictEqual(events, ['busy', 'idle'])
      assert.strictEqual(bot.attacks.length, 2)
    } finally {
      await guard.stop()
    }
    assert.ok(Object.values(bot.controlState).every((on) => !on), 'controls released')
  })

  it('ignores hostiles out of the radius / far below, neutral mobs until they swing at the bot and hurt it (retaliation)', async () => {
    const bot = fakeBot({ items: [{ name: 'iron_sword' }] })
    bot.entities[3] = mob(3, 'zombie', new Vec3(0.5, -12, 0.5)) // in a cave far below
    bot.entities[4] = mob(4, 'skeleton', new Vec3(30, 0, 0)) // out of the radius
    const enderman = mob(5, 'enderman', new Vec3(2.5, 0, 0.5))
    bot.entities[5] = enderman
    dieAfter(bot, enderman, 3)
    const guard = combat.defend(bot, { radius: 10, interval: 10, eat: false })
    try {
      await new Promise((resolve) => setTimeout(resolve, 80))
      assert.strictEqual(bot.attacks.length, 0, 'nothing engaged')
      bot.emit('entityHurt', bot.entity) // hurt, but the enderman did not swing: something else (fire, a fall)
      await new Promise((resolve) => setTimeout(resolve, 60))
      assert.strictEqual(bot.attacks.length, 0, 'a neutral mob is not blamed without a swing')
      bot.emit('entitySwingArm', enderman)
      bot.emit('entityHurt', bot.entity) // the enderman hit the bot
      await until(() => guard.stats.killed.enderman === 1)
      assert.strictEqual(guard.stats.retaliations, 1)
      assert.ok(bot.attacks.every((t) => t === enderman))
    } finally {
      await guard.stop()
    }
  })

  it('knocks a ghast fireball back when it comes close', async () => {
    const bot = fakeBot()
    const guard = combat.defend(bot, { interval: 10, eat: false })
    try {
      bot.entities[9] = { id: 9, name: 'fireball', type: 'projectile', position: new Vec3(0.5, 1.5, -2), width: 1, height: 1 }
      await until(() => guard.stats.deflected > 0)
      assert.strictEqual(bot.attacks[0].name, 'fireball')
    } finally {
      await guard.stop()
    }
  })

  it('stop() aborts a running fight and resolves with the stats; pause() keeps the guard out', async () => {
    const bot = fakeBot()
    const guard = combat.defend(bot, { interval: 10, eat: false })
    guard.pause()
    bot.entities[2] = mob(2, 'zombie', new Vec3(0.5, 0, -2))
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.strictEqual(guard.busy, false, 'paused')
    guard.resume()
    await until(() => guard.busy)
    const stats = await guard.stop()
    assert.strictEqual(guard.busy, false)
    assert.strictEqual(stats.fights, 1)
  })

  it('guardFor: under an Agent the skill uses the Agent\'s safety behaviours (one background fighter), else defend()', async () => {
    const { setContext } = require('../src/skill')
    const util = require('../src/dims/util')
    const bot = fakeBot()
    const own = combat.guardFor(bot, { interval: 10, eat: false })
    assert.ok(own instanceof combat.Guard)
    await own.stop()
    const safety = new EventEmitter()
    safety.enabled = true
    safety.busy = null
    safety.interventions = [1, 2]
    safety.idle = () => safety.busy ? new Promise((resolve) => safety.once('idle', resolve)) : Promise.resolve()
    setContext(bot, { agent: { safety }, log: () => {}, progress: () => {} })
    const g = combat.guardFor(bot, {})
    assert.ok(g instanceof combat.SafetyGuard)
    assert.strictEqual(util.guardOf(bot), g, 'util.goto waits for it')
    const seen = []
    g.on('busy', () => seen.push('busy'))
    g.on('idle', () => seen.push('idle'))
    safety.busy = { type: 'fight' }
    safety.emit('busy', 'fight')
    assert.strictEqual(g.busy, true)
    const idle = g.idle()
    safety.busy = null
    safety.emit('idle')
    await idle
    g.pause()
    assert.strictEqual(safety.enabled, false)
    g.resume()
    assert.strictEqual(safety.enabled, true)
    g.pause()
    assert.deepStrictEqual(await g.stop(), { delegated: 'agent safety', interventions: 2 })
    assert.strictEqual(safety.enabled, true, 'stop() resumes the safety')
    assert.strictEqual(util.guardOf(bot), null)
    assert.deepStrictEqual(seen, ['busy', 'idle'])
  })

  it('guarded(): an action interrupted by a fight waits for the guard, then runs again', async () => {
    const guard = new EventEmitter()
    guard.busy = false
    guard.idle = () => guard.busy ? new Promise((resolve) => guard.once('idle', resolve)) : Promise.resolve()
    let calls = 0
    const result = await combat.guarded(guard, async () => {
      calls++
      if (calls === 1) {
        guard.busy = true
        guard.emit('busy')
        setTimeout(() => { guard.busy = false; guard.emit('idle') }, 20)
        throw new Error('PathStopped')
      }
      return 'done'
    })
    assert.strictEqual(result, 'done')
    assert.strictEqual(calls, 2)
    // a failure without a fight is the action's own: thrown at once
    await assert.rejects(combat.guarded(guard, async () => { throw new Error('NoPath') }), /NoPath/)
    // no guard: plain call
    assert.strictEqual(await combat.guarded(null, async () => 7), 7)
  })
})

describe('U18 dims/util goto with a guard', () => {
  const util = require('../src/dims/util')
  function fakeGuard () {
    const g = new EventEmitter()
    g.busy = false
    g.idle = () => g.busy ? new Promise((resolve) => g.once('idle', resolve)) : Promise.resolve()
    g.fight = (ms) => { g.busy = true; g.emit('busy'); setTimeout(() => { g.busy = false; g.emit('idle') }, ms) }
    return g
  }
  function pathBot () {
    const bot = fakeBot()
    bot.loadPlugin = () => {}
    const calls = []
    bot.pathfinder = {
      calls,
      next: [],
      goto (goal) { calls.push(Date.now()); const f = bot.pathfinder.next.shift(); return f ? f() : Promise.resolve() },
      stop () {},
      setGoal () {},
      setMovements () {}
    }
    return bot
  }
  const goal = { isEnd: () => false }

  it('waits while the guard fights, and walks on after a path the guard stopped (not a retry)', async () => {
    const bot = pathBot()
    const guard = fakeGuard()
    util.setGuard(bot, guard)
    try {
      guard.fight(40)
      const t0 = Date.now()
      // the first walk is stopped by a fight (PathStopped), the second one arrives
      bot.pathfinder.next.push(() => { guard.fight(30); const e = new Error('stopped'); e.name = 'PathStopped'; return Promise.reject(e) })
      await util.goto(bot, goal, { retries: 0, timeout: 5000 })
      assert.strictEqual(bot.pathfinder.calls.length, 2)
      assert.ok(bot.pathfinder.calls[0] - t0 >= 35, 'no walking while the guard fought')
    } finally {
      util.setGuard(bot, null)
    }
  })

  it('a search that ran out of think time: waits for the partial path, re-plans from there (not counted as a retry)', async () => {
    const bot = pathBot()
    let moving = false
    bot.pathfinder.isMoving = () => moving
    const far = { isEnd: () => false, heuristic: (p) => Math.abs(p.z - -40) }
    const timeoutErr = () => {
      const e = new Error('Took to long to decide path to goal!')
      e.name = 'Timeout'
      // the partial path: the bot walks 10 blocks closer, then stops
      moving = true
      setTimeout(() => { bot.entity.position = bot.entity.position.offset(0, 0, -10); moving = false }, 50)
      return Promise.reject(e)
    }
    // the final search reaches the goal
    const arrive = () => { bot.entity.position = bot.entity.position.offset(0, 0, -10); return Promise.resolve() }
    bot.pathfinder.next.push(timeoutErr, timeoutErr, timeoutErr, arrive)
    await util.goto(bot, far, { retries: 0, timeout: 10000 })
    assert.strictEqual(bot.pathfinder.calls.length, 4, 'three partial walks, then the final search')
    assert.ok(bot.entity.position.z <= -39, `${bot.entity.position}`)
  })

  it('a search that resolves short of the goal is a failed attempt, not an arrival', async () => {
    const bot = pathBot()
    const far = { isEnd: () => false, heuristic: (p) => Math.abs(p.z - -40) }
    await assert.rejects(util.goto(bot, far, { retries: 1, timeout: 5000 }), /stopped .* short of the goal/)
    assert.strictEqual(bot.pathfinder.calls.length, 2)
  })

  it('without a guard a stopped path counts as a failed attempt', async () => {
    const bot = pathBot()
    const stopped = () => { const e = new Error('stopped'); e.name = 'PathStopped'; return Promise.reject(e) }
    bot.pathfinder.next.push(stopped, stopped)
    await assert.rejects(util.goto(bot, goal, { retries: 1, timeout: 5000 }), /stopped/)
    assert.strictEqual(bot.pathfinder.calls.length, 2)
  })
})

describe('U18 combat skill: modes', () => {
  it('nearby with nothing around: cleared, no fights', async () => {
    const bot = fakeBot({ items: [{ name: 'iron_sword' }] })
    const r = await combat(bot, { mode: 'nearby', settleMs: 30 })
    assert.strictEqual(r.mode, 'nearby')
    assert.strictEqual(r.outcome, 'cleared')
    assert.deepStrictEqual(r.killed, {})
  })

  it('nearby kills the hostiles around (equips the sword first)', async () => {
    const sword = { name: 'diamond_sword' }
    const bot = fakeBot({ items: [sword] })
    const a = mob(2, 'zombie', new Vec3(0.5, 0, -4))
    const b = mob(3, 'spider', new Vec3(3.5, 0, 0.5))
    dieAfter(bot, a, 2)
    dieAfter(bot, b, 2)
    Object.assign(bot.entities, { 2: a, 3: b })
    const r = await combat(bot, { mode: 'nearby', settleMs: 30 })
    assert.deepStrictEqual(r.killed, { zombie: 1, spider: 1 })
    assert.strictEqual(bot.heldItem, sword)
  })

  it('rejects an unknown mode and a hunt without a mob', async () => {
    await assert.rejects(combat(fakeBot(), { mode: 'dance' }), /unknown combat mode/)
    await assert.rejects(combat(fakeBot(), { mode: 'hunt' }), /needs args.mob/)
  })

  it('likelyAttacker: the nearest hostile in melee range, else a ranged mob in sight', () => {
    const bot = fakeBot()
    bot.entities[2] = mob(2, 'zombie', new Vec3(2.5, 0, 0.5))
    bot.entities[3] = mob(3, 'skeleton', new Vec3(12, 0, 0))
    bot.entities[4] = { id: 4, name: 'pig', type: 'animal', position: new Vec3(1, 0, 1), width: 0.9, height: 0.9 }
    assert.strictEqual(combat.likelyAttacker(bot).name, 'zombie')
    delete bot.entities[2]
    assert.strictEqual(combat.likelyAttacker(bot).name, 'skeleton')
  })
})
