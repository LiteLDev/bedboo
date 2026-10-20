'use strict'
// owner: POLISH-AGENT — the End's walk up from the arrival platform (another way after a stall), the exit through the
// portal during a fight, and the Nether's guard (piglins left alone in gold, no arrows near them, hoglins) on fake bots
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const { Safety } = require('../src/safety')
const combat = require('../src/skills/combat')
const end = require('../src/skills/end')
const nether = require('../src/skills/nether')
const u = require('../src/dims/util')
const { retaliate } = require('../src/dims/retaliate')

/** a mineflayer-shaped bot; `blocks` by "x,y,z" (default: stone below y 0, air above) */
function fakeBot ({ position = new Vec3(0.5, 0, 0.5), blocks = {}, dimension = 'overworld' } = {}) {
  const bot = new EventEmitter()
  bot.entity = { id: 0, position, yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, type: 'player', onGround: true }
  bot.entities = { 0: bot.entity }
  bot.health = 20
  bot.food = 20
  bot.game = { dimension, minY: -64, height: 384 }
  bot.controlState = {}
  bot.setControlState = (c, on) => { bot.controlState[c] = on }
  bot.clearControlStates = () => { bot.controlState = {} }
  bot.inventory = { slots: new Array(46).fill(null), items: () => [] }
  bot.heldItem = null
  bot.equip = async () => {}
  bot.lookAt = async () => {}
  bot.attack = () => {}
  bot.waitForTicks = async () => {}
  bot.blockAt = (p) => {
    const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = blocks[`${f.x},${f.y},${f.z}`] ?? (f.y < 0 ? 'stone' : 'air')
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

describe('polish (agent): the End walk up from the arrival platform', () => {
  /** u.ensurePathfinder / u.goto stubbed: `walk(noPlace)` decides what a goto does */
  async function withPathfinder (walk, fn) {
    const ensure = u.ensurePathfinder
    const goto = u.goto
    const calls = []
    let noPlace = false
    u.ensurePathfinder = (bot, opts = {}) => {
      if (opts.fresh) noPlace = Array.isArray(opts.scaffold) && opts.scaffold.length === 0
      return { goals: require('mineflayer-pathfinder').goals, movements: { noPlace } }
    }
    u.goto = async (bot, goal, opts) => {
      calls.push({ noPlace, stallMs: opts.stallMs })
      await walk(noPlace, bot)
    }
    try {
      return await fn(calls)
    } finally {
      u.ensurePathfinder = ensure
      u.goto = goto
    }
  }
  /** 30 blocks towards the island's centre (0, 0) */
  const hop = (bot) => {
    const p = bot.entity.position
    const d = Math.hypot(p.x, p.z)
    bot.entity.position = p.offset((-p.x / d) * Math.min(30, d), 0, (-p.z / d) * Math.min(30, d))
  }

  it('a stalled bridge (placements failing) is left for the way without placements after one stall', async () => {
    const bot = fakeBot({ position: new Vec3(100.5, 50, 0.5), dimension: 'the_end' })
    await withPathfinder(async (noPlace, b) => {
      // mineflayer-pathfinder hangs on its half-built bridge: the walk's stall detection gives up
      if (!noPlace) throw new Error('goto stalled: no progress for 15000 ms (at (96, 50, 2))')
      hop(b)
    }, async (calls) => {
      const walk = await end.toIslandTop(bot, { stallMs: 15000 })
      assert.strictEqual(walk.onTop, true)
      assert.strictEqual(walk.stalls.length, 1)
      assert.strictEqual(walk.stalls[0].way, 'path')
      assert.deepStrictEqual(calls.map((c) => c.noPlace), [false, true, true, true])
      assert.ok(calls.every((c) => c.stallMs === 15000))
    })
  })

  it('a walk that works is not changed (no stall: the pathfinder with placements all the way)', async () => {
    const bot = fakeBot({ position: new Vec3(100.5, 50, 0.5), dimension: 'the_end' })
    await withPathfinder(async (noPlace, b) => hop(b), async (calls) => {
      const walk = await end.toIslandTop(bot)
      assert.strictEqual(walk.onTop, true)
      assert.deepStrictEqual(walk.stalls, [])
      assert.ok(calls.every((c) => !c.noPlace))
    })
  })

  it('a stall after a few blocks of bridge counts too; every way stalling ends the walk in its time bound', async () => {
    const bot = fakeBot({ position: new Vec3(100.5, 50, 0.5), dimension: 'the_end' })
    // nothing within 6 blocks under the platform's level, no block to bridge with: no own step either
    await withPathfinder(async (noPlace, b) => {
      b.entity.position = b.entity.position.offset(-0.2, 0, 0)
      throw new Error('goto stalled: no progress for 15000 ms')
    }, async () => {
      const t = Date.now()
      const walk = await end.toIslandTop(bot, { maxMs: 2000 })
      assert.strictEqual(walk.onTop, false)
      assert.ok(Date.now() - t < 5000)
      assert.ok(walk.stalls.length >= 3)
      assert.deepStrictEqual([...new Set(walk.stalls.map((s) => s.way))].sort(), ['manual', 'no placement', 'path'])
    })
  })

  it('manual steps: directions towards the target first; the ground under a cell (never the void)', () => {
    const dirs = end.directionsTowards(new Vec3(100, 50, 0), new Vec3(70, 50, 1))
    assert.deepStrictEqual(dirs[0], new Vec3(-1, 0, 0))
    assert.deepStrictEqual(dirs[3], new Vec3(1, 0, 0))
    const bot = fakeBot({ blocks: { '97,44,0': 'end_stone' } })
    assert.strictEqual(end.groundBelow(bot, new Vec3(97, 50, 0), 6)?.name, 'end_stone')
    assert.strictEqual(end.groundBelow(bot, new Vec3(97, 52, 0), 6), null, '7 down: too deep')
    assert.strictEqual(end.groundBelow(bot, new Vec3(96, 50, 0), 6), null, 'the void')
  })
})

describe('polish (agent): the End exit', () => {
  it('a bot that reaches the overworld during the walk to the exit portal (knocked in) has exited', async () => {
    const bot = fakeBot({ position: new Vec3(8.5, 62, 0.5), dimension: 'the_end' })
    const ensure = u.ensurePathfinder
    const goto = u.goto
    u.ensurePathfinder = () => ({ goals: require('mineflayer-pathfinder').goals, movements: {} })
    // the walk to the fountain: an enderman knocks the bot into the portal → credits → the overworld spawn
    u.goto = (b, goal, { signal }) => new Promise((resolve, reject) => {
      setTimeout(() => {
        bot.game.dimension = 'overworld'
        bot.entity.position = new Vec3(-514.5, 69, 73.5)
        bot.emit('spawn')
      }, 20)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    bot.findBlocks = () => []
    bot.registry = { blocksByName: { end_portal: { id: 1 } } }
    try {
      const r = await end.exitEnd(bot, { exitTimeout: 2000 })
      assert.strictEqual(r.exited, true)
      assert.deepStrictEqual(r.arrival, { x: -515, y: 69, z: 73 })
    } finally {
      u.ensurePathfinder = ensure
      u.goto = goto
    }
  })
})

describe('polish (agent): the End exit (deaths)', () => {
  it('a death during the walk to the exit portal (respawned in the overworld) is no exit', async () => {
    const bot = fakeBot({ position: new Vec3(8.5, 62, 0.5), dimension: 'the_end' })
    const ensure = u.ensurePathfinder
    const goto = u.goto
    u.ensurePathfinder = () => ({ goals: require('mineflayer-pathfinder').goals, movements: {} })
    u.goto = (b, goal, { signal }) => new Promise((resolve, reject) => {
      setTimeout(() => {
        bot.emit('death')
        bot.game.dimension = 'overworld'
        bot.emit('spawn')
      }, 20)
      signal.addEventListener('abort', () => reject(signal.reason), { once: true })
    })
    bot.findBlocks = () => []
    bot.registry = { blocksByName: { end_portal: { id: 1 } } }
    try {
      await assert.rejects(end.exitEnd(bot, { exitTimeout: 2000 }), /died in The End/)
    } finally {
      u.ensurePathfinder = ensure
      u.goto = goto
    }
  })
})

describe('polish (agent): the Nether guard', () => {
  const golden = { name: 'golden_boots', type: 1, count: 1 }

  it('piglins are calm while the bot wears gold; arrows stay in the quiver with piglins around', () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    const piglin = mob(5, 'piglin', new Vec3(3.5, 0, 0.5))
    assert.strictEqual(nether.calmPiglin(bot, piglin), false, 'no gold: a piglin attacks')
    bot.inventory.slots[8] = golden
    assert.strictEqual(nether.wearsGold(bot), true)
    assert.strictEqual(nether.calmPiglin(bot, piglin), true)
    assert.strictEqual(nether.calmPiglin(bot, mob(6, 'piglin_brute', new Vec3(3.5, 0, 0.5))), false, 'brutes attack anyway')
    assert.strictEqual(nether.piglinsNear(bot), false)
    bot.entities[5] = piglin
    assert.strictEqual(nether.piglinsNear(bot), true)
    piglin.position = new Vec3(40.5, 0, 0.5)
    assert.strictEqual(nether.piglinsNear(bot), false, 'far away')
  })

  it('under the Agent: a calm piglin that swung beside the bot is no attacker; hoglins: no arrows near piglins, a retreat kept, fled from when low', async () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    bot.inventory.slots[8] = golden
    const safety = new Safety(bot)
    safety.enabled = true
    safety.check = () => {}
    const token = safety.pushGuard(nether.netherGuard(bot))
    const piglin = mob(5, 'piglin', new Vec3(1.5, 0, 0.5))
    bot.entities[5] = piglin
    safety.swings.set(piglin, Date.now()) // it swung at a hoglin beside the bot
    safety.onHurt()
    assert.strictEqual(safety.attackers.size, 0, 'the piglin is not blamed')
    // a hoglin: fought (armored, armed) with its retreat kept and no bow (a piglin is near)
    const hoglin = mob(6, 'hoglin', new Vec3(3.5, 0, 0.5), { kind: 'Hostile mobs' })
    bot.entities[6] = hoglin
    bot.inventory.slots[5] = { name: 'iron_helmet' }
    bot.inventory.slots[6] = { name: 'iron_chestplate' }
    bot.inventory.items = () => [{ name: 'iron_sword', type: 2, count: 1 }]
    const fight = combat.fight
    let opts = null
    combat.fight = async (b, target, o) => { opts = o; return { outcome: 'killed' } }
    try {
      await safety.fight(hoglin)
    } finally {
      combat.fight = fight
    }
    assert.strictEqual(opts.bow, false)
    assert.notStrictEqual(opts.retreatHealth, 0, 'a hoglin is not fought to the end')
    // at 8 hp: fled from
    const runs = []
    safety.run = (type, fn, target) => runs.push({ type, target: target?.name })
    delete safety.check
    bot.health = 8
    safety.check(false)
    assert.deepStrictEqual(runs, [{ type: 'flee', target: 'hoglin' }])
    bot.health = 16
    safety.check(false)
    assert.deepStrictEqual(runs[1], { type: 'fight', target: 'hoglin' })
    safety.popGuard(token)
    assert.deepStrictEqual(safety.effective().noBow, [])
  })

  it('a fight in the Nether keeps the one gold piece on (no iron "upgrade"); in the overworld the best piece goes on', async () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    const iron = { name: 'iron_boots', type: 3, count: 1 }
    bot.inventory.items = () => [iron]
    bot.inventory.slots[8] = golden
    const equipped = []
    bot.equip = async (item, dest) => { equipped.push([item.name, dest]); if (dest === 'feet') bot.inventory.slots[8] = item }
    await combat.equipForCombat(bot, { shield: false })
    assert.deepStrictEqual(equipped, [])
    bot.game.dimension = 'overworld'
    await combat.equipForCombat(bot, { shield: false })
    assert.deepStrictEqual(equipped, [['iron_boots', 'feet']])
  })

  it('a piglin that hits the bot in spite of its gold (no other mob to blame) is angry: no longer calm', async () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    bot.inventory.slots[8] = golden
    const piglin = mob(5, 'piglin', new Vec3(1.5, 0, 0.5))
    bot.entities[5] = piglin
    const stop = nether.watchPiglins(bot)
    try {
      // a hoglin beside it did it: the piglin stays calm
      const hoglin = mob(6, 'hoglin', new Vec3(0.5, 0, 1.5), { kind: 'Hostile mobs' })
      bot.entities[6] = hoglin
      bot.emit('entityHurt', bot.entity)
      await new Promise((resolve) => setImmediate(resolve))
      assert.strictEqual(nether.calmPiglin(bot, piglin), true)
      // nobody else around: the piglin
      delete bot.entities[6]
      bot.emit('entityHurt', bot.entity)
      await new Promise((resolve) => setImmediate(resolve))
      assert.strictEqual(nether.calmPiglin(bot, piglin), false)
      assert.strictEqual(nether.calmPiglin(bot, mob(7, 'piglin', new Vec3(2.5, 0, 0.5))), true, 'only that one')
    } finally {
      stop()
    }
  })

  it('likelyAttacker passes over an excluded mob beside the bot to the one that hit it', () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    const piglin = mob(5, 'piglin', new Vec3(1.5, 0, 0.5))
    const zombified = mob(6, 'zombified_piglin', new Vec3(2.5, 0, 0.5))
    bot.entities[5] = piglin
    bot.entities[6] = zombified
    const swings = new Map([[piglin, Date.now()], [zombified, Date.now()]])
    assert.strictEqual(combat.likelyAttacker(bot, { swings, exclude: (e) => e.name === 'piglin' }), zombified)
  })

  it('two gold pieces worn in the Nether: one stays on, the other may be upgraded', async () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    bot.inventory.slots[5] = { name: 'golden_helmet' }
    bot.inventory.slots[8] = golden
    bot.inventory.items = () => [{ name: 'iron_helmet' }, { name: 'iron_boots' }]
    const equipped = []
    bot.equip = async (item, dest) => equipped.push([item.name, dest])
    await combat.equipForCombat(bot, { shield: false })
    assert.deepStrictEqual(equipped, [['iron_boots', 'feet']], 'the helmet (the first gold piece) stays')
  })

  it('retaliation (next to the Agent) never blames an excluded mob, with or without a swing', () => {
    const bot = fakeBot({ dimension: 'the_nether' })
    const safety = new Safety(bot)
    safety.enabled = true
    const fights = []
    safety.run = (type, fn, target) => fights.push(target?.name)
    const guard = { delegated: true, safety }
    const piglin = mob(5, 'piglin', new Vec3(1.5, 0, 0.5))
    bot.entities[5] = piglin
    const stop = retaliate(bot, guard, { exclude: (e) => e.name === 'piglin' })
    try {
      bot.emit('entitySwingArm', piglin)
      bot.emit('entityHurt', bot.entity)
      return new Promise((resolve) => setImmediate(() => {
        assert.deepStrictEqual(fights, [])
        resolve()
      }))
    } finally {
      stop()
    }
  })
})

describe('polish (agent): drowning under a ceiling', () => {
  it('no drowning claim again and again where the last one found no way out: the task digging up is let be', () => {
    const bot = fakeBot({ blocks: { '0,0,0': 'water', '0,1,0': 'water', '0,2,0': 'stone' } })
    bot.entity.isInWater = true
    bot.oxygenLevel = 5
    const safety = new Safety(bot)
    safety.enabled = true
    const runs = []
    safety.run = (type) => runs.push(type)
    safety.check(false)
    assert.deepStrictEqual(runs, ['drowning'])
    // the last one: no air pocket, nothing to dig up — 30 s (or until the bot moved) of the task's own way out (its climb digs the ceiling)
    safety._noAir = { at: Date.now(), pos: bot.entity.position.clone() }
    safety.check(false)
    assert.deepStrictEqual(runs, ['drowning'])
    safety._noAir.at = Date.now() - 31000
    safety.check(false)
    assert.deepStrictEqual(runs, ['drowning', 'drowning'])
  })
})

describe('polish (agent): fights a guard stops ignoring', () => {
  it('a fight ends once its target is ignored (an enderman when the End exit runs low on health)', async () => {
    const bot = fakeBot({ dimension: 'the_end' })
    const safety = new Safety(bot)
    const enderman = mob(5, 'enderman', new Vec3(2.5, 0, 0.5))
    bot.entities[5] = enderman
    const token = safety.pushGuard({ ignore: (e) => e.name === 'enderman' && bot.health <= 10 })
    const fight = combat.fight
    let opts = null
    combat.fight = async (b, target, o) => { opts = o; return { outcome: 'switched' } }
    try {
      await safety.fight(enderman)
    } finally {
      combat.fight = fight
      safety.popGuard(token)
    }
    safety.pushGuard({ ignore: (e) => e.name === 'enderman' && bot.health <= 10 })
    assert.strictEqual(opts.stop(), false, 'at 20 hp: fought')
    bot.health = 9
    assert.strictEqual(opts.stop(), true, 'at 9 hp: left')
  })

  it('digging up out of a flooded ceiling: never under gravel, never a dig slower than the air left', async () => {
    const blocks = { '0,0,0': 'water', '0,1,0': 'water', '0,2,0': 'stone', '0,3,0': 'gravel' }
    const bot = fakeBot({ blocks })
    const safety = new Safety(bot)
    const digs = []
    bot.dig = async (b) => digs.push(b.name)
    const block = bot.blockAt
    bot.blockAt = (p) => Object.assign(block(p), { diggable: true })
    assert.strictEqual(await safety.digUp(), false, 'gravel over the ceiling')
    delete blocks['0,3,0']
    bot.digTime = () => 20000
    assert.strictEqual(await safety.digUp(), false, 'a 20 s dig')
    assert.deepStrictEqual(digs, [])
  })
})
