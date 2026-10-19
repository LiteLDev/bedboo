'use strict'
// owner: FINAL-FIX-AGENT-A — the agent core's final fixes on fake bots (no server): safety under U18 guards, the
// runner's wind-down and stuck watchdog, navigate's spawn goal, smelting splits, nights
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Agent, runSkill } = require('../src/runner')
const { Safety } = require('../src/safety')
const { setContext, sleep } = require('../src/skill')
const combat = require('../src/skills/combat')

/** a mineflayer-shaped bot on a stone floor (y < 0 solid) */
function fakeBot ({ position = new Vec3(0.5, 0, 0.5) } = {}) {
  const bot = new EventEmitter()
  bot.entity = { id: 0, position, yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, type: 'player' }
  bot.entities = { 0: bot.entity }
  bot.health = 20
  bot.food = 20
  bot.isAlive = true
  bot.game = { dimension: 'overworld', minY: -64, height: 384 }
  bot.controlState = {}
  bot.setControlState = (c, on) => { bot.controlState[c] = on }
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.inventory = { slots: new Array(46).fill(null), items: () => [] }
  bot.heldItem = null
  bot.equip = async () => {}
  bot.lookAt = async () => {}
  bot.attacks = []
  bot.attack = (e) => bot.attacks.push(e)
  bot.waitForTicks = async () => {}
  bot.blockAt = (p) => {
    const f = p.floored()
    const name = f.y < 0 ? 'stone' : 'air'
    return { name, position: f, boundingBox: name === 'air' ? 'empty' : 'block', shapes: [] }
  }
  bot.nearestEntity = (match) => {
    let best = null
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !match(e)) continue
      if (!best || e.position.distanceTo(bot.entity.position) < best.position.distanceTo(bot.entity.position)) best = e
    }
    return best
  }
  return bot
}

const mob = (id, name, position, extra = {}) => ({ id, name, type: 'mob', position, width: 0.6, height: 1.9, ...extra })

describe('final fix (agent): safety under U18 guards', () => {
  it('pushGuard widens the radius, adds ignore rules and a height band; popGuard restores', () => {
    const safety = new Safety(fakeBot())
    assert.strictEqual(safety.effective().radius, 5)
    const ghast = (e) => e.name === 'ghast'
    const token = safety.pushGuard({ radius: 10, retaliate: true, ignore: ghast })
    const eff = safety.effective()
    assert.strictEqual(eff.radius, 10)
    assert.strictEqual(eff.maxDy, 4, 'a guard keeps fights to its height band')
    assert.ok(eff.ignores.includes(ghast))
    safety.popGuard(token)
    assert.strictEqual(safety.effective().radius, 5)
    assert.strictEqual(safety.effective().ignores.length, 0)
  })

  it('a neutral mob that swung and hurt the bot is fought back; one that did not swing is not', () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    safety.enabled = true
    const piglin = mob(5, 'piglin', new Vec3(2.5, 0, 0.5))
    bot.entities[5] = piglin
    // hurt without a swing: no attacker, and a piglin is no hostile
    safety.check = () => {}
    safety.onHurt()
    assert.strictEqual(safety.threat(true), null)
    safety.swings.set(piglin, Date.now())
    safety.onHurt()
    const t = safety.threat(true)
    assert.ok(t && t.target === piglin, 'retaliation')
    // an ignored kind (a ghast without a bow) is never blamed
    const ghast = mob(6, 'ghast', new Vec3(0.5, 6, 8.5))
    delete bot.entities[5]
    bot.entities[6] = ghast
    safety.attackers.clear()
    safety.pushGuard({ ignore: (e) => e.name === 'ghast' })
    safety.onHurt()
    assert.strictEqual(safety.attackers.size, 0)
  })

  it('a mob given up on stays ignored even next to the bot until it hurts it (a zombie behind a wall); creepers never', () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    safety.enabled = true
    safety.check = () => {}
    const zombie = mob(7, 'zombie', new Vec3(3.5, 0, 0.5), { kind: 'Hostile mobs' })
    bot.entities[7] = zombie
    assert.strictEqual(safety.threat(false)?.target, zombie)
    safety.ignored.set(7, Date.now() + 60000)
    assert.strictEqual(safety.threat(false), null, 'ignored at 3 blocks')
    safety.onHurt() // it hit the bot after all: an attacker again
    assert.strictEqual(safety.threat(true)?.target, zombie)
    const creeper = mob(8, 'creeper', new Vec3(2.5, 0, 0.5), { kind: 'Hostile mobs' })
    delete bot.entities[7]
    bot.entities[8] = creeper
    safety.attackers.clear()
    safety.ignored.set(8, Date.now() + 60000)
    assert.strictEqual(safety.threat(false)?.target, creeper, 'a close creeper is fought anyway')
  })

  it('a fight against a mob out of reach gives way to one hitting the bot from up close', () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    const creeper = mob(8, 'creeper', new Vec3(6.5, 0, 0.5), { kind: 'Hostile mobs' })
    const zombie = mob(9, 'zombie', new Vec3(1.5, 0, 0.5), { kind: 'Hostile mobs' })
    bot.entities[8] = creeper
    bot.entities[9] = zombie
    assert.strictEqual(safety.betterTarget(creeper), false)
    safety.attackers.set(zombie, Date.now() + 20000) // it just hit the bot
    assert.strictEqual(safety.betterTarget(creeper), true)
    assert.strictEqual(safety.betterTarget(zombie), false, 'the target itself in reach: no switch')
  })

  it('a ghast fireball within reach is hit back', async () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    safety.enabled = true
    const fireball = { id: 9, name: 'fireball', type: 'object', position: new Vec3(0.5, 1.5, 2.5), width: 0.3, height: 0.3 }
    bot.entities[9] = fireball
    safety.check(false)
    await sleep(20)
    assert.deepStrictEqual(bot.attacks, [fireball])
    assert.strictEqual(safety.interventions[0].type, 'deflect')
  })

  it('safety fights are safe, give an unreachable mob up and leave it alone afterwards', async () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    const zombie = mob(7, 'zombie', new Vec3(3.5, 0, 0.5), { kind: 'Hostile mobs' })
    bot.entities[7] = zombie
    const fight = combat.fight
    let opts = null
    combat.fight = async (b, target, o) => { opts = o; return { outcome: 'unreachable' } }
    try {
      assert.strictEqual(await safety.fight(zombie), 'unreachable')
    } finally {
      combat.fight = fight
    }
    assert.strictEqual(opts.safe, true)
    assert.ok(opts.giveUpMs > 0 && Number.isFinite(opts.giveUpMs))
    assert.ok(opts.maxChase > 0 && Number.isFinite(opts.maxChase))
    assert.ok(safety.ignored.get(7) > Date.now(), 'left alone for a while')
  })

  it('guardFor under an Agent pushes the skill\'s guard options until stop() or its signal', async () => {
    const bot = fakeBot()
    const safety = new Safety(bot)
    safety.enabled = true
    setContext(bot, { agent: { safety }, log: () => {}, progress: () => {} })
    const controller = new AbortController()
    const g = combat.guardFor(bot, { radius: 8, retaliate: true, signal: controller.signal })
    assert.ok(g instanceof combat.SafetyGuard)
    assert.strictEqual(safety.effective().radius, 8)
    controller.abort()
    assert.strictEqual(safety.guards.length, 0)
    const g2 = combat.guardFor(bot, { radius: 12 })
    assert.strictEqual(safety.effective().radius, 12)
    await g2.stop()
    await g2.stop() // twice is fine
    assert.strictEqual(safety.effective().radius, 5)
  })
})

describe('final fix (agent): runner', () => {
  it('runSkill: the caller\'s abort ends the task at once, after the skill unwound (bounded)', async () => {
    let unwound = false
    const slowUnwind = (bot, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => setTimeout(() => { unwound = true; reject(new Error('stopped')) }, 60))
    })
    const controller = new AbortController()
    setTimeout(() => controller.abort(Object.assign(new Error('the bot died'), { code: 'DIED' })), 10)
    await assert.rejects(runSkill({}, 'slowUnwind', {}, { skills: { slowUnwind }, signal: controller.signal }), (err) => err.code === 'DIED')
    assert.strictEqual(unwound, true, 'waited for the skill to unwind')
    // a skill that ignores its signal holds nothing up for longer than the wind-down
    const deaf = () => new Promise(() => {})
    const c2 = new AbortController()
    setTimeout(() => c2.abort(new Error('stop')), 10)
    const t = Date.now()
    await assert.rejects(runSkill({}, 'deaf', {}, { skills: { deaf }, signal: c2.signal, windDownMs: 50 }), /stop/)
    assert.ok(Date.now() - t < 1000)
  })

  it('the stuck watchdog aborts a task whose bot does nothing, escapes, and runs it again', async () => {
    const bot = fakeBot()
    let attempts = 0
    const skills = {
      dig: async (bot, { signal }) => {
        attempts++
        if (attempts === 1) await new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason)))
        return { attempts }
      }
    }
    const agent = new Agent({ bot, skills, watchdogInterval: 10 })
    agent.startedAt = Date.now()
    let escaped = 0
    agent.unstuck = async () => { escaped++ }
    const r = await agent.run('dig', {}, { stuckMs: 80 })
    assert.deepStrictEqual(r, { attempts: 2 })
    assert.strictEqual(escaped, 1)
    assert.strictEqual(agent.tasks[0].errors[0].code, 'STUCK')
    assert.strictEqual(agent.state.traps.length, 1, 'the spot is remembered')
  })

  it('the watchdog leaves a task alone that makes progress (events / heartbeats) or moves', async () => {
    const bot = fakeBot()
    const { heartbeat } = require('../src/skill')
    const skills = {
      wait: async (bot) => {
        for (let i = 0; i < 20; i++) { heartbeat(bot); await sleep(10) }
        return 'done'
      },
      walk: async (bot) => {
        for (let i = 0; i < 20; i++) { bot.entity.position = bot.entity.position.offset(3, 0, 0); await sleep(10) }
        return 'walked'
      }
    }
    const agent = new Agent({ bot, skills, watchdogInterval: 10 })
    agent.startedAt = Date.now()
    setContext(bot, { agent, log: () => {}, progress: (type, data) => agent.event(type, data) })
    assert.strictEqual(await agent.run('wait', {}, { stuckMs: 60 }), 'done')
    assert.strictEqual(await agent.run('walk', {}, { stuckMs: 60 }), 'walked')
    assert.ok(!agent.events.some((e) => e.type === 'heartbeat'), 'heartbeats are not in the report')
  })
})

describe('final fix (agent): mineflayer-auto-eat guard', () => {
  it('a meal that failed before it started (equip refused) does not leave auto-eat "eating" for good', async () => {
    const { guardAutoEat } = require('../src/runner')
    // auto-eat 5.0.3's eat(): the flag first, then the equip (which may throw), eatStart only once the meal began
    class FakeEat extends EventEmitter {
      constructor () { super(); this._eating = false; this.equipFails = true }
      get isEating () { return this._eating }
      async eat () {
        if (this._eating) throw new Error('Already eating!')
        this._eating = true
        if (this.equipFails) throw new Error('Failed to equip: cooked_beef!')
        this.emit('eatStart')
        this._eating = false
        this.emit('eatFinish')
      }
    }
    const ae = new FakeEat()
    guardAutoEat(ae)
    await assert.rejects(ae.eat(), /Failed to equip/)
    assert.strictEqual(ae.isEating, true, 'not on the next tick (no equip retry every tick)…')
    await sleep(2100)
    assert.strictEqual(ae.isEating, false, '…but 2 s later')
    ae.equipFails = false
    await ae.eat()
    assert.strictEqual(ae.isEating, false)
    // a meal in progress keeps its flag: "Already eating" is no reason to clear it
    ae._eating = true
    await assert.rejects(ae.eat(), /Already eating/)
    assert.strictEqual(ae.isEating, true)
  })
})

describe('final fix (agent): skills', () => {
  it('navigate: the world spawn is an x/z goal; a height outside the world is never a goal', () => {
    const { targetSpec } = require('../src/skills/navigate')
    const bot = fakeBot()
    bot.spawnPoint = new Vec3(-516, 32767, 77)
    assert.deepStrictEqual(targetSpec(bot, { spawn: true }), { position: bot.spawnPoint, goal: 'xz', range: 2 })
    bot.spawnPoint = new Vec3(-516, 69, 77)
    assert.strictEqual(targetSpec(bot, { spawn: true, range: 16 }).goal, 'xz')
    assert.strictEqual(targetSpec(bot, { spawn: true, goal: 'near' }).goal, 'near', 'asked for')
    assert.strictEqual(targetSpec(bot, { position: { x: 1, y: 32767, z: 2 }, goal: 'near' }).goal, 'xz')
    assert.strictEqual(targetSpec(bot, { position: { x: 1, y: 64, z: 2 } }).goal, undefined)
  })

  it('smelt: a big batch is split evenly over the furnaces; the fuel covers every share', () => {
    const { split, fuelFor } = require('../src/skills/smelt')
    assert.deepStrictEqual(split(25, 3), [9, 8, 8])
    assert.deepStrictEqual(split(5, 1), [5])
    assert.deepStrictEqual(split(2, 3), [1, 1])
    assert.strictEqual(fuelFor([9, 8, 8], 8), 4)
    assert.strictEqual(fuelFor([25], 8), 4)
  })

  it('rest: sleep at night with a bed (overworld only); shelter without bed and armor only when asked', () => {
    const rest = require('../src/skills/rest')
    const bot = fakeBot()
    bot.registry = { blocksByName: { bed: { id: 1 } } }
    bot.findBlocks = () => []
    bot.time = { timeOfDay: 6000 }
    assert.strictEqual(rest.restMode(bot), null, 'day')
    bot.time.timeOfDay = 14000
    assert.strictEqual(rest.restMode(bot), null, 'no bed, no shelter asked')
    assert.strictEqual(rest.restMode(bot, { shelter: true }), 'shelter')
    bot.inventory.items = () => [{ name: 'bed', count: 1 }]
    assert.strictEqual(rest.restMode(bot), 'sleep')
    bot.game.dimension = 'the_nether'
    assert.strictEqual(rest.restMode(bot), null, 'beds explode in the Nether')
    bot.game.dimension = 'overworld'
    bot.inventory.items = () => []
    bot.inventory.slots[5] = { name: 'iron_helmet' }
    bot.inventory.slots[6] = { name: 'iron_chestplate' }
    assert.strictEqual(rest.restMode(bot, { shelter: true }), null, 'armored: the night is no reason to stop')
  })

  it('inventory: junk, surplus blocks and replaced tools go when it is full; wanted drops are still picked up', async () => {
    const inventory = require('../src/inventory')
    const bot = fakeBot()
    const stacks = { cobblestone: 300, leaf_litter: 5, oak_sapling: 2, wooden_pickaxe: 1, stone_pickaxe: 1, iron_pickaxe: 1, diamond_pickaxe: 1, stone_sword: 1, iron_sword: 1, flint: 1, raw_gold: 3, arrow: 4 }
    bot.inventory.items = () => Object.entries(stacks).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: name }))
    const junk = Object.fromEntries(inventory.junk(bot).map((j) => [j.name, j.count]))
    assert.deepStrictEqual(junk, { cobblestone: 172, leaf_litter: 5, oak_sapling: 2, wooden_pickaxe: 1, stone_pickaxe: 1, stone_sword: 1, arrow: 4 })
    assert.ok(inventory.unwanted(bot, 'cobblestone') && inventory.unwanted(bot, 'oak_sapling'))
    assert.ok(!inventory.unwanted(bot, 'raw_gold') && !inventory.unwanted(bot, 'flint') && !inventory.unwanted(bot, null))
    // declutter tosses until enough slots are free
    let free = 1
    bot.inventory.emptySlotCount = () => free
    bot.registry = { itemsByName: Object.fromEntries(Object.keys(stacks).map((n) => [n, { id: n }])) }
    const thrown = []
    bot.toss = async (id, meta, n) => { thrown.push(id); stacks[id] -= n; free++ }
    const tossed = await inventory.declutter(bot, { minFree: 3 })
    assert.strictEqual(Object.keys(tossed).length, 2)
    assert.ok(thrown.every((n) => inventory.JUNK.test(n)), 'whole junk stacks first')
  })

  it('traps: blocks near a spot where a task got stuck are skipped for a while', () => {
    const world = require('../src/world')
    const bot = fakeBot()
    const state = { traps: [{ x: 10, y: 60, z: 10, until: Date.now() + 60000 }, { x: 50, y: 60, z: 50, until: Date.now() - 1 }] }
    setContext(bot, { agent: { state }, log: () => {}, progress: () => {} })
    assert.ok(world.inTrap(bot, new Vec3(12, 58, 9)))
    assert.ok(!world.inTrap(bot, new Vec3(20, 60, 10)))
    assert.ok(!world.inTrap(bot, new Vec3(50, 60, 50)), 'expired')
  })
})
