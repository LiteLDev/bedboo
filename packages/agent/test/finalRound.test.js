'use strict'
// owner: FINAL-ROUND — the build skill's block-by-block repair (M4: a house left 1 of 125 blocks wrong after BDS refused
// the same placement four times from the same spot) on a fake bot whose "server" refuses placements like BDS does
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const build = require('../src/skills/build')
const navigate = require('../src/skills/navigate')
const { compile } = require('../src/blueprint')

const SOLID = [[0, 0, 0, 1, 1, 1]]

/**
 * A mineflayer-shaped bot over a block map (`blocks` by "x,y,z"; stone below y 0, air above). `refuse(ref, face, bot)`
 * decides whether the fake server refuses a placement (the library's error, the block unchanged).
 */
function fakeBot ({ position = new Vec3(4.5, 0, 0.5), refuse = () => false, blocks = {} } = {}) {
  const bot = new EventEmitter()
  const world = new Map(Object.entries(blocks))
  const nameAt = (f) => world.get(`${f.x},${f.y},${f.z}`) ?? (f.y < 0 ? 'stone' : 'air')
  bot.entity = { id: 0, position, yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, type: 'player', onGround: true }
  bot.entities = { 0: bot.entity }
  bot.registry = { itemsByName: {} }
  bot.blockAt = (p) => {
    const f = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
    const name = nameAt(f)
    const empty = name === 'air' || name === 'short_grass' || name === 'poppy'
    return { name, position: f, boundingBox: empty ? 'empty' : 'block', shapes: empty ? [] : SOLID, diggable: name !== 'bedrock' }
  }
  bot.world = { getBlock: bot.blockAt }
  bot.set = (p, name) => world.set(`${p.x},${p.y},${p.z}`, name)
  const items = [{ name: 'cobblestone', type: 1, count: 64, slot: 36 }, { name: 'dirt', type: 2, count: 64, slot: 37 }]
  bot.inventory = { slots: Object.assign(new Array(46).fill(null), { 36: items[0], 37: items[1] }), items: () => items }
  bot.heldItem = null
  bot.equip = async (item) => { bot.heldItem = item }
  bot.lookAt = async () => {}
  bot.attack = () => {}
  bot.waitForTicks = async () => {}
  bot.canDigBlock = () => true
  bot.dig = async (block) => { bot.set(block.position, 'air'); bot.dug.push(block.position.toString()) }
  bot.dug = []
  bot.placed = []
  bot.placeBlock = async (ref, face) => {
    const dest = ref.position.plus(face)
    const spot = bot.entity.position.floored().toString()
    bot.placed.push({ dest: dest.toString(), ref: ref.position.toString(), spot })
    if (refuse(ref, face, bot)) throw new Error(`Server refused to place ${bot.heldItem?.name} at ${dest}: the block is still ${nameAt(dest)}`)
    bot.set(dest, bot.heldItem.name)
  }
  return bot
}

/** navigate.goto stubbed: the bot is put on the nearest standable cell (≤ 5 away) where the goal ends */
async function withGoto (fn) {
  const goto = navigate.goto
  const movements = navigate.movements
  navigate.movements = () => ({ fake: true }) // the build's Movements (no registry on the fake bot)
  const calls = []
  navigate.goto = async (bot, goal) => {
    calls.push(goal)
    const here = bot.entity.position.floored()
    let best = null
    for (let dx = -5; dx <= 5; dx++) {
      for (let dz = -5; dz <= 5; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const n = here.offset(dx, dy, dz)
          if (bot.blockAt(n.offset(0, -1, 0)).boundingBox !== 'block' || bot.blockAt(n).boundingBox !== 'empty') continue
          if (!goal.isEnd(n)) continue
          const d = n.distanceTo(here)
          if (!best || d < best.d) best = { n, d }
        }
      }
    }
    if (!best) throw new Error('no path (fake)')
    bot.entity.position = best.n.offset(0.5, 0, 0.5)
  }
  try {
    return await fn(calls)
  } finally {
    navigate.goto = goto
    navigate.movements = movements
  }
}

/** a one-block "blueprint": cobblestone at the origin */
const ONE = { name: 'one', palette: { '#': ['cobblestone'] }, layers: [['#']] }

describe('final round (agent): the build repairs block by block', () => {
  it('a refused placement is tried again from a spot a block away from the cell, against another face', async () => {
    // the fake server refuses every placement while the bot's feet are next to the cell (its hitbox touches it on BDS)
    const refuse = (ref, face, bot) => {
      const f = bot.entity.position.floored()
      return Math.abs(f.x) <= 1 && Math.abs(f.z) <= 1
    }
    // a neighbour block east of the cell: a second face to click
    const bot = fakeBot({ position: new Vec3(1.5, 0, 1.5), refuse, blocks: { '1,0,0': 'cobblestone' } })
    const compiled = compile(ONE, { x: 0, y: 0, z: 0 })
    await withGoto(async (calls) => {
      const ok = await build.placeCell(bot, compiled.placements[0], compiled, {})
      assert.ok(ok, `placed: ${JSON.stringify(bot.placed)}`)
      assert.strictEqual(bot.blockAt(new Vec3(0, 0, 0)).name, 'cobblestone')
      assert.strictEqual(bot.placed.length, 2, 'refused once, then placed')
      const [first, second] = bot.placed
      assert.notStrictEqual(second.spot, first.spot, 'from another spot')
      const f = new Vec3(...second.spot.replace(/[()]/g, '').split(',').map(Number))
      assert.ok(!build.nextToCell(f, new Vec3(0, 0, 0)), `a block away from the cell: ${second.spot}`)
      assert.notStrictEqual(second.ref, first.ref, 'against another face')
      assert.ok(calls.length >= 1)
    })
  })

  it('the repair rounds: a wrong block dug out, the missing ones placed again (a mob in the cell waited for)', async () => {
    const bot = fakeBot({ position: new Vec3(6.5, 0, 0.5) })
    const BP = { name: 'row', palette: { '#': ['cobblestone'] }, layers: [['###']] }
    const compiled = compile(BP, { x: 0, y: 0, z: 0 })
    bot.set(new Vec3(1, 0, 0), 'dirt') // wrong block
    bot.set(new Vec3(2, 0, 0), 'poppy') // a flower where a block goes: dug, not "replaced"
    // a sheep stands in (0, 0, 0) for a while
    const sheep = { id: 7, name: 'sheep', type: 'mob', position: new Vec3(0.5, 0, 0.5), width: 0.9, height: 1.3 }
    bot.entities[7] = sheep
    let hits = 0
    bot.attack = (e) => { hits++; if (hits >= 1) e.position = new Vec3(0.5, 0, 3.5) }
    bot.waitForTicks = async () => { await new Promise((resolve) => setImmediate(resolve)) }
    await withGoto(async () => {
      const mismatches = [
        { pos: new Vec3(0, 0, 0), expected: ['cobblestone'], actual: 'air' },
        { pos: new Vec3(1, 0, 0), expected: ['cobblestone'], actual: 'dirt' },
        { pos: new Vec3(2, 0, 0), expected: ['cobblestone'], actual: 'poppy' }
      ]
      await build.repair(bot, compiled, mismatches, { round: 1 })
    })
    for (let x = 0; x <= 2; x++) assert.strictEqual(bot.blockAt(new Vec3(x, 0, 0)).name, 'cobblestone', `x ${x}`)
    assert.ok(bot.dug.includes(new Vec3(1, 0, 0).toString()), 'the dirt was dug out')
    assert.ok(bot.dug.includes(new Vec3(2, 0, 0).toString()), 'the flower was dug out')
    assert.ok(hits >= 1, 'the sheep was shooed out of the cell')
  })

  it('a hunt makes room for the drops first (chain d2: 36 of 36 slots taken, no beef or porkchop picked up)', async () => {
    const { roomForDrops } = require('../src/skills/obtain')
    const bot = fakeBot()
    const stacks = { cobblestone: 356, feather: 2, leather: 6, white_wool: 3, mutton: 1 }
    bot.inventory.items = () => Object.entries(stacks).filter(([, c]) => c > 0).map(([name, count]) => ({ name, count, type: name }))
    let free = 0
    bot.inventory.emptySlotCount = () => free
    bot.registry = { itemsByName: Object.fromEntries(Object.keys(stacks).map((n) => [n, { id: n }])) }
    bot.toss = async (id, meta, n) => { stacks[id] -= n; free += id === 'cobblestone' ? Math.floor(n / 64) : 1 }
    const tossed = await roomForDrops(bot)
    assert.ok(free >= 3, `free slots: ${free}`)
    assert.ok(tossed.feather && tossed.leather, `junk first: ${JSON.stringify(tossed)}`)
    assert.strictEqual(stacks.mutton, 1, 'food stays')
    assert.strictEqual(stacks.white_wool, 3)
    // room enough: nothing tossed
    assert.deepStrictEqual(await roomForDrops(bot), {})
  })

  it('entitiesIn / replaceable: what blocks a placement', () => {
    const bot = fakeBot()
    bot.entities[1] = { id: 1, name: 'item', position: new Vec3(0.5, 0, 0.5) }
    bot.entities[2] = { id: 2, name: 'zombie', position: new Vec3(1.2, 0, 0.5), width: 0.6, height: 1.9 }
    bot.entities[3] = { id: 3, name: 'cow', position: new Vec3(3.5, 0, 0.5), width: 0.9, height: 1.4 }
    assert.deepStrictEqual(build.entitiesIn(bot, new Vec3(0, 0, 0)).map((e) => e.name), ['zombie'], 'items never block; a hitbox reaching in does')
    assert.deepStrictEqual(build.entitiesIn(bot, new Vec3(3, 0, 0)).map((e) => e.name), ['cow'])
    assert.ok(build.replaceable({ name: 'short_grass' }) && build.replaceable({ name: 'air' }) && build.replaceable({ name: 'water' }))
    assert.ok(!build.replaceable({ name: 'poppy' }) && !build.replaceable({ name: 'dirt' }))
    assert.ok(build.nextToCell(new Vec3(1, 0, 1), new Vec3(0, 0, 0)) && build.nextToCell(new Vec3(1, -1, 0), new Vec3(0, 0, 0)))
    assert.ok(!build.nextToCell(new Vec3(2, 0, 0), new Vec3(0, 0, 0)) && !build.nextToCell(new Vec3(1, 1, 0), new Vec3(0, 0, 0)))
  })
})
