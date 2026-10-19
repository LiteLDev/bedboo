'use strict'
// owner: U18 (agent combat & dimensions) — FINAL-FIX-AGENT-B: lava pools, bounded searches, fight-only retries, the
// dimension-change tick, the End's locate parsing, the nether skill's restart after a death
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const portal = require('../src/skills/portal')
const nether = require('../src/skills/nether')
const u = require('../src/dims/util')
const e1 = require('../scenarios/end/e1-end')

/** blocks by "x,y,z"; default: stone below y 63, grass at 63, air above */
function world (blocks = {}) {
  return (p) => {
    const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = blocks[`${f.x},${f.y},${f.z}`] ?? (f.y < 63 ? 'stone' : f.y === 63 ? 'grass_block' : 'air')
    const liquid = /lava|water/.test(name)
    return {
      name: name.replace(/:flowing$/, ''),
      position: f,
      boundingBox: liquid || name === 'air' ? 'empty' : 'block',
      getProperties: () => liquid ? { liquid_depth: name.endsWith(':flowing') ? 2 : 0 } : {}
    }
  }
}

describe('U18 lava pools (FINAL-FIX-AGENT-B)', () => {
  it('clusters connected lava blocks (diagonals included) into pools, largest first', () => {
    const a = [new Vec3(0, 62, 0), new Vec3(1, 62, 0), new Vec3(2, 62, 1)] // (1,0) → (2,1) diagonal
    const b = [new Vec3(10, 62, 10), new Vec3(10, 62, 11)]
    const clusters = portal.clusterPositions([...b, ...a])
    assert.strictEqual(clusters.length, 2)
    assert.strictEqual(clusters[0].length, 3)
    assert.strictEqual(clusters[1].length, 2)
  })

  it('a pool: its sources, the ones a bucket reaches (clear above), how many under the open sky', () => {
    const blocks = {}
    const lava = []
    for (let x = 0; x < 3; x++) {
      for (let z = 0; z < 3; z++) {
        blocks[`${x},63,${z}`] = 'lava'
        lava.push(new Vec3(x, 63, z))
      }
    }
    blocks['0,63,0'] = 'lava:flowing' // not a source
    blocks['1,64,1'] = 'stone' // covered: no bucket from above
    blocks['2,70,2'] = 'stone' // a roof high above: reachable, not under the sky
    const [pool] = portal.lavaPools(world(blocks), lava)
    assert.strictEqual(pool.size, 9)
    assert.strictEqual(pool.sources.length, 8)
    assert.strictEqual(pool.reachable.length, 7)
    assert.strictEqual(pool.sky, 6)
    assert.strictEqual(pool.key, '(0, 63, 0)')
  })

  it('a lava bucket is filled from a cell with no lava beside or under it', () => {
    const blocks = {}
    for (let x = 0; x < 4; x++) for (let z = 0; z < 4; z++) blocks[`${x},63,${z}`] = 'lava'
    const bot = { blockAt: world(blocks) }
    const goal = portal.lavaSafeGoal(bot, new Vec3(3, 63, 1), require('mineflayer-pathfinder').goals)
    assert.strictEqual(goal.isEnd(new Vec3(4, 64, 1)), false, 'the rim, next to the source')
    assert.strictEqual(goal.isEnd(new Vec3(5, 64, 1)), true, 'one block back, still in reach')
    assert.strictEqual(goal.isEnd(new Vec3(9, 64, 1)), false, 'out of reach')
    // a bank high above the pool: near the cell over the source, but the eyes are 4.8+ blocks from it (N1M5 #1)
    const bank = { ...blocks }
    for (let x = 5; x < 10; x++) for (let z = 0; z < 4; z++) for (const y of [64, 65]) bank[`${x},${y},${z}`] = 'dirt'
    const bankGoal = portal.lavaSafeGoal({ blockAt: world(bank) }, new Vec3(3, 63, 1), require('mineflayer-pathfinder').goals)
    assert.strictEqual(bankGoal.isEnd(new Vec3(5, 66, 1)), false, 'on a bank 3 blocks up, 2 out: out of reach')
    // a rim (a bank 1 up) over an emptied source's hole, 2 deep: the walk's momentum carried the bot into it (N1 seed 35)
    const rim = { ...blocks }
    for (let x = 5; x < 10; x++) for (let z = 0; z < 4; z++) rim[`${x},64,${z}`] = 'dirt'
    const goals = require('mineflayer-pathfinder').goals
    assert.strictEqual(portal.lavaSafeGoal({ blockAt: world(rim) }, new Vec3(3, 63, 2), goals).isEnd(new Vec3(5, 65, 1)), true, 'the rim, solid ground beside')
    const holed = { ...rim, '4,63,1': 'air' }
    assert.strictEqual(portal.dropBeside({ blockAt: world(holed) }, new Vec3(5, 65, 1)), true)
    assert.strictEqual(portal.lavaSafeGoal({ blockAt: world(holed) }, new Vec3(3, 63, 2), goals).isEnd(new Vec3(5, 65, 1)), false, 'the rim over the hole at (4, 63, 1)')
  })

  it('ranks open-sky pools first unless a cave pool is far nearer; skips given-up pools and pools with too few sources', () => {
    const pool = (key, x, n, sky) => ({ key, sky, center: new Vec3(x, 62, 0), reachable: Array.from({ length: n }, (_, i) => new Vec3(x + i, 62, 0)), sources: [] })
    const cave = pool('cave', 13, 40, 0) // run 4's pool next to the spawn: 13 blocks, no sky
    const open = pool('open', 58, 40, 20) // the surface pool 58 blocks away
    const from = new Vec3(0, 64, 0)
    assert.deepStrictEqual(portal.rankPools([cave, open], { from, need: 10 }).map((p) => p.key), ['open', 'cave'])
    assert.deepStrictEqual(portal.rankPools([cave, open], { from, need: 10, bad: new Set(['open']) }).map((p) => p.key), ['cave'])
    const tiny = pool('tiny', 2, 1, 1)
    assert.deepStrictEqual(portal.rankPools([tiny, open], { from, need: 10 }).map((p) => p.key), ['open'])
    // one cast left: a one-source pool next to the bot is fine
    assert.deepStrictEqual(portal.rankPools([tiny, open], { from, need: 1 }).map((p) => p.key), ['tiny', 'open'])
    // a deep cave lake / a ravine's lava floor (below y 40, sky or not) is never worth the walk
    const deep = { ...pool('deep', 5, 40, 0), center: new Vec3(5, -55, 0) }
    const ravine = { ...pool('ravine', 5, 200, 15), center: new Vec3(5, -31, 0) }
    assert.deepStrictEqual(portal.rankPools([deep, ravine, open], { from, need: 10 }).map((p) => p.key), ['open'])
  })
})

describe('U18 bounded waits (FINAL-FIX-AGENT-B)', () => {
  function guardLike ({ safety } = {}) {
    const g = new EventEmitter()
    g.busy = false
    if (safety) g.safety = { busy: null }
    g.idle = () => Promise.resolve()
    g.bot = new EventEmitter()
    return g
  }

  it('busyKind: the Agent safety\'s auto-eat claim is "eat", anything else (and combat.defend\'s guard) is "fight"', () => {
    const s = guardLike({ safety: true })
    assert.strictEqual(u.busyKind(s), null)
    s.busy = true
    s.safety.busy = { type: 'eat' }
    assert.strictEqual(u.busyKind(s), 'eat')
    s.safety.busy = { type: 'fight' }
    assert.strictEqual(u.busyKind(s), 'fight')
    const g = guardLike()
    g.busy = true
    assert.strictEqual(u.busyKind(g), 'fight')
    assert.strictEqual(u.busyKind(null), null)
  })

  it('fightGuarded runs an action again after a fight, not after an auto-eat claim (chain run 4\'s endless loop)', async () => {
    const g = guardLike({ safety: true })
    let calls = 0
    const r = await u.fightGuarded(g, async () => {
      if (++calls === 1) {
        g.busy = true; g.safety.busy = { type: 'fight' }; g.emit('busy', 'fight')
        g.busy = false; g.safety.busy = null
        throw new Error('path stopped')
      }
      return 'done'
    })
    assert.strictEqual(r, 'done')
    assert.strictEqual(calls, 2)
    calls = 0
    await assert.rejects(u.fightGuarded(g, async () => {
      calls++
      g.busy = true; g.safety.busy = { type: 'eat' }; g.emit('busy', 'eat')
      g.busy = false; g.safety.busy = null
      throw new Error('goto timed out')
    }), /goto timed out/)
    assert.strictEqual(calls, 1)
    // bounded by `retries`
    calls = 0
    await assert.rejects(u.fightGuarded(g, async () => {
      calls++
      g.busy = true; g.safety.busy = { type: 'fight' }; g.emit('busy', 'fight')
      g.busy = false; g.safety.busy = null
      throw new Error('again')
    }, { retries: 2 }), /again/)
    assert.strictEqual(calls, 3)
  })

  it('deadlineSignal aborts after its time (and with its parent), done() clears it', async () => {
    const d = u.deadlineSignal(undefined, 30)
    await new Promise((resolve) => setTimeout(resolve, 60))
    assert.ok(d.signal.aborted)
    assert.ok(d.timedOut)
    const parent = new AbortController()
    const e = u.deadlineSignal(parent.signal, 10000)
    parent.abort()
    assert.ok(e.signal.aborted)
    assert.ok(!e.timedOut)
    e.done()
  })

  it('tick() ends on the lifecycle\'s dimension switch when no physics tick comes, and never rejects', async () => {
    const bot = new EventEmitter()
    bot.waitForTicks = () => new Promise(() => {}) // physics paused (changing dimension)
    const t0 = Date.now()
    const p = u.tick(bot, { ms: 5000 })
    setTimeout(() => bot.emit('game'), 20)
    await p
    assert.ok(Date.now() - t0 < 1000)
    assert.strictEqual(bot.listenerCount('game'), 0)
    const bot2 = new EventEmitter()
    bot2.waitForTicks = () => Promise.reject(new Error('Timeout waiting for 1 ticks'))
    await u.tick(bot2)
  })

  it('fillBucket gives up after `tries` walks with what it tried (chain run 2: 20 walks to unreachable water)', async () => {
    const bot = new EventEmitter()
    const blocks = {}
    for (let x = 0; x < 30; x++) blocks[`${x},63,20`] = 'water'
    const at = world(blocks)
    bot.blockAt = at
    bot.entity = { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 }
    bot.game = { dimension: 'overworld' }
    bot.registry = { blocksByName: { water: { id: 1 }, flowing_water: { id: 2 }, fire: { id: 3 } } }
    bot.findBlocks = () => []
    let walks = 0
    bot.pathfinder = {
      goto: async () => { walks++; const e = new Error('No path to the goal!'); e.name = 'NoPath'; throw e },
      stop () {},
      setGoal () {},
      setMovements () {}
    }
    const sources = Object.keys(blocks).map((k) => new Vec3(...k.split(',').map(Number)))
    // no registry on this fake: the pathfinder's Movements are not built
    const ensure = u.ensurePathfinder
    u.ensurePathfinder = () => ({ goals: require('mineflayer-pathfinder').goals, movements: {} })
    try {
      await assert.rejects(portal.fillBucket(bot, 'water', { sources, tries: 3, timeout: 60000 }), /could not fill a bucket with water \(3 sources tried/)
    } finally {
      u.ensurePathfinder = ensure
    }
    assert.ok(walks >= 3 && walks <= 6, `walks ${walks}`)
  })

  it('feed: eats while standing still until auto-eat would stop (food ≥ its minHunger)', async () => {
    const bot = new EventEmitter()
    bot.food = 4
    let stopped = 0
    bot.pathfinder = { stop () { stopped++ }, setGoal () {} }
    bot.clearControlStates = () => {}
    bot.inventory = { items: () => [{ name: 'rotten_flesh', count: 9 }] }
    let meals = 0
    bot.autoEat = {
      opts: { minHunger: 16, priority: 'saturation' },
      isEating: false,
      findBestChoices: (items) => items.filter((i) => i.name === 'rotten_flesh'),
      eat: async () => { meals++; bot.food += 4 }
    }
    await portal.feed(bot)
    assert.strictEqual(meals, 3)
    assert.ok(bot.food >= 16)
    assert.ok(stopped >= 3, 'the pathfinder stops before each meal')
    // nothing auto-eat may eat: no meal, no wait
    bot.food = 4
    bot.inventory = { items: () => [] }
    await portal.feed(bot)
    assert.strictEqual(meals, 3)
  })
})

describe('U18 nether skill restarts (FINAL-FIX-AGENT-B)', () => {
  function overworldBot (items = []) {
    const bot = new EventEmitter()
    bot.game = { dimension: 'overworld' }
    bot.entity = { position: new Vec3(0, 64, 0) }
    bot.inventory = { items: () => items }
    return bot
  }

  it('back in the overworld with nothing to mine (a death in the Nether respawned it there): home already', async () => {
    const r = await nether(overworldBot(), { targets: {}, returnHome: true })
    assert.strictEqual(r.returned, true)
    assert.strictEqual(r.already, 'overworld')
  })

  it('ores to mine but the pickaxe was lost: a clear error, not a trip into the Nether', async () => {
    await assert.rejects(nether(overworldBot([{ name: 'stone_sword', count: 1 }]), { targets: { quartz_ore: 3 } }), /no pickaxe for quartz_ore/)
    await assert.rejects(nether(overworldBot([{ name: 'iron_pickaxe', count: 1 }]), { targets: { ancient_debris: 1 } }), /no pickaxe for ancient_debris/)
  })
})

describe('U18 night ahead (FINAL-FIX-AGENT-B)', () => {
  const shelter = require('../src/dims/shelter')
  const at = (timeOfDay, armor = []) => ({ time: { timeOfDay, doDaylightCycle: true }, inventory: { slots: Object.assign(new Array(46).fill(null), armor) } })

  it('ticks to nightfall, 0 at night, no night without a daylight cycle', () => {
    assert.strictEqual(shelter.ticksToNight(at(9000)), 3800)
    assert.strictEqual(shelter.ticksToNight(at(15000)), 0)
    assert.strictEqual(shelter.ticksToNight(at(23500)), 0, 'dawn: the night\'s mobs are still out')
    assert.strictEqual(shelter.ticksToNight(at(100)), 12700)
    assert.strictEqual(shelter.ticksToNight({ time: { timeOfDay: 9000, doDaylightCycle: false } }), Infinity)
    assert.strictEqual(shelter.ticksToNight({}), Infinity)
  })

  it('the work ahead runs into the night only for an unarmored bot (M3\'s snapshot: ≈ 200 s of day left)', () => {
    assert.strictEqual(shelter.nightAhead(at(9000 + 1360), 5 * 60 * 1000), true)
    assert.strictEqual(shelter.nightAhead(at(1000), 5 * 60 * 1000), false)
    const armor = []
    armor[6] = { name: 'iron_chestplate' }
    armor[8] = { name: 'iron_boots' }
    assert.strictEqual(shelter.nightAhead(at(15000, armor), 5 * 60 * 1000), false)
  })
})

describe('U18 retaliation next to the Agent\'s safety (FINAL-FIX-AGENT-B)', () => {
  const { retaliate } = require('../src/dims/retaliate')

  function setup ({ mob = 'enderman', distance = 2, food = 20 } = {}) {
    const bot = new EventEmitter()
    bot.entity = { id: 0, position: new Vec3(0.5, 64, 0.5), onGround: true, height: 1.8, width: 0.6, type: 'player' }
    const enemy = { id: 1, name: mob, type: 'mob', position: new Vec3(0.5 + distance, 64, 0.5), height: 2.9, width: 0.6 }
    bot.entities = { 0: bot.entity, 1: enemy }
    bot.health = 20
    bot.food = food
    bot.blockAt = (p) => ({ name: p.y < 64 ? 'end_stone' : 'air', boundingBox: p.y < 64 ? 'block' : 'empty', position: p.floored() })
    const runs = []
    const safety = { busy: null, enabled: true, run: (type, fn, target) => runs.push({ type, target }), fight: async () => 'killed' }
    const guard = { delegated: true, safety }
    return { bot, enemy, safety, guard, runs }
  }
  const hurt = async (bot) => { bot.emit('entityHurt', bot.entity); await new Promise((resolve) => setImmediate(resolve)) }

  it('a neutral mob in reach that hurt the bot is fought through the safety (Bedrock endermen send no swing)', async () => {
    const { bot, enemy, guard, runs } = setup()
    const stop = retaliate(bot, guard)
    await hurt(bot)
    assert.strictEqual(runs.length, 1)
    assert.strictEqual(runs[0].type, 'fight')
    assert.strictEqual(runs[0].target, enemy)
    stop()
    await hurt(bot)
    assert.strictEqual(runs.length, 1, 'stopped')
  })

  it('no blame for a fall, starving, a busy / paused safety, or combat.defend\'s own guard', async () => {
    let s = setup({ food: 0 })
    let stop = retaliate(s.bot, s.guard)
    await hurt(s.bot)
    assert.strictEqual(s.runs.length, 0, 'starving')
    stop()
    s = setup()
    stop = retaliate(s.bot, s.guard)
    s.bot.entity.onGround = false
    s.bot.entity.position = new Vec3(0.5, 70, 0.5)
    s.bot.emit('move')
    s.bot.entity.onGround = true
    s.bot.entity.position = new Vec3(0.5, 64, 0.5)
    s.bot.emit('move')
    await hurt(s.bot)
    assert.strictEqual(s.runs.length, 0, 'a 6-block fall')
    stop()
    s = setup()
    stop = retaliate(s.bot, s.guard)
    s.safety.enabled = false // a hunt paused the guard: it fights itself
    await hurt(s.bot)
    s.safety.enabled = true
    s.safety.busy = { type: 'fight' }
    await hurt(s.bot)
    assert.strictEqual(s.runs.length, 0)
    stop()
    s = setup()
    assert.strictEqual(typeof retaliate(s.bot, { delegated: false, busy: false }), 'function')
    await hurt(s.bot)
    assert.strictEqual(s.runs.length, 0)
  })

  it('the nether skill can walk back to a far portal (portal.travelTo is exported)', () => {
    assert.strictEqual(typeof portal.travelTo, 'function')
  })
})

describe('U18 end skill: a death ends the phase (FINAL-FIX-AGENT-B)', () => {
  it('endWatch aborts on the death / a spawn in another dimension, with the reason', () => {
    const end = require('../src/skills/end')
    const bot = new EventEmitter()
    bot.game = { dimension: 'the_end' }
    bot.entity = { position: new Vec3(95, -41, -3) }
    const w = end.endWatch(bot)
    bot.emit('spawn') // still in the End: nothing
    assert.ok(!w.signal.aborted)
    bot.emit('death')
    assert.ok(w.signal.aborted)
    assert.match(w.reason, /died in The End/)
    w.done()
    assert.strictEqual(bot.listenerCount('death'), 0)
    const w2 = end.endWatch(bot)
    bot.game.dimension = 'overworld'
    bot.emit('spawn')
    assert.match(w2.reason, /no longer in The End \(overworld\)/)
    w2.done()
  })
})

describe('U18 E1 cheat-assisted setup helpers (FINAL-FIX-AGENT-B)', () => {
  it('parses Bedrock\'s locate answer', () => {
    assert.deepStrictEqual(e1.parseLocate(['The nearest stronghold is at block -878, (y?), 194 (389 blocks away)']), { x: -878, z: 194 })
    assert.deepStrictEqual(e1.parseLocate(['The nearest stronghold is at block 1666, (y?), -830 (1861 blocks away)']), { x: 1666, z: -830 })
    assert.strictEqual(e1.parseLocate(['Could not find a structure of type stronghold within a reasonable distance']), null)
  })

  it('looks at the locate point first, then 64 and 128 blocks around it', () => {
    const pts = e1.searchPoints({ x: 100, z: -50 })
    assert.deepStrictEqual(pts[0], { x: 100, z: -50 })
    assert.strictEqual(pts.length, 17)
    assert.ok(pts.some((p) => p.x === 228 && p.z === -50))
  })
})
