'use strict'
// owner: U18 (agent combat & dimensions) — portal frame planner, portal site search, obsidian casting (mold) planner
const assert = require('assert')
const { Vec3 } = require('vec3')
const portal = require('../src/skills/portal')

/** a fake world: `fill` boxes of named blocks over a default (air above `groundY`, stone below) */
function fakeWorld ({ groundY = 63, ground = 'grass_block' } = {}) {
  const blocks = new Map()
  const key = (p) => `${p.x},${p.y},${p.z}`
  const make = (name, p) => ({
    name,
    position: p,
    boundingBox: ['air', 'water', 'flowing_water', 'lava', 'flowing_lava', 'short_grass', 'wildflowers', 'portal', 'fire'].includes(name) ? 'empty' : 'block',
    getProperties: () => (name === 'lava' || name === 'water') ? { liquid_depth: 0 } : {}
  })
  const world = {
    blockAt (p) {
      p = new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z))
      const name = blocks.get(key(p)) ?? (p.y > groundY ? 'air' : p.y === groundY ? ground : 'stone')
      return make(name, p)
    },
    fill (from, to, name) {
      for (let x = Math.min(from.x, to.x); x <= Math.max(from.x, to.x); x++) {
        for (let y = Math.min(from.y, to.y); y <= Math.max(from.y, to.y); y++) {
          for (let z = Math.min(from.z, to.z); z <= Math.max(from.z, to.z); z++) blocks.set(key({ x, y, z }), name)
        }
      }
      return world
    }
  }
  world.at = (p) => world.blockAt(p)
  return world
}

const s = (p) => `${p.x},${p.y},${p.z}`

describe('U18 portal frame planner', () => {
  it('10 obsidian: bottom 2 + sides 6 + top 2; the bottom corners are ground, the top corners scaffolding', () => {
    const plan = portal.planPortalFrame({ x: 10, y: 63, z: 5 }, 'x')
    assert.strictEqual(plan.obsidianNeeded, 10)
    assert.strictEqual(plan.frame.length, 10)
    const frame = new Set(plan.frame.map(s))
    for (const p of ['11,63,5', '12,63,5', '10,64,5', '10,65,5', '10,66,5', '13,64,5', '13,65,5', '13,66,5', '11,67,5', '12,67,5']) assert.ok(frame.has(p), p)
    const corners = plan.steps.filter((st) => st.role === 'corner')
    assert.deepStrictEqual(corners.map((c) => [s(c.pos), c.block]), [['10,63,5', 'support'], ['13,63,5', 'support'], ['10,67,5', 'scaffold'], ['13,67,5', 'scaffold']])
    assert.deepStrictEqual(plan.interior.map(s).sort(), ['11,64,5', '11,65,5', '11,66,5', '12,64,5', '12,65,5', '12,66,5'])
    // flint and steel on the top of a bottom obsidian block lights the interior's lowest cell
    assert.strictEqual(s(plan.light.ref), '11,63,5')
    assert.ok(plan.interior.some((p) => p.equals(plan.light.ref.plus(plan.light.face))))
  })

  it('every reference block is the ground under the bottom row or placed by an earlier step', () => {
    for (const axis of ['x', 'z']) {
      for (const obsidian of [10, 12, 14]) {
        const plan = portal.planPortalFrame({ x: 0, y: 63, z: 0 }, axis, { obsidian })
        const placed = new Set()
        for (const st of plan.steps) {
          if (st.block === 'clear') continue
          assert.ok(st.ref && st.face, `${s(st.pos)} has a reference`)
          assert.ok(st.ref.plus(st.face).equals(st.pos), `${s(st.ref)} + face → ${s(st.pos)}`)
          assert.ok(st.ref.y === 62 || placed.has(s(st.ref)), `${axis}/${obsidian}: ${s(st.pos)} placed against ${s(st.ref)} before it exists`)
          placed.add(s(st.pos))
        }
        assert.strictEqual(plan.frame.length, obsidian >= 14 ? 14 : obsidian >= 12 ? 12 : 10)
      }
    }
  })

  it('axis z: the frame spans z, the build spots stand off in x, two blocks from the frame', () => {
    const plan = portal.planPortalFrame({ x: 0, y: 63, z: 0 }, 'z')
    assert.ok(plan.frame.every((p) => p.x === 0))
    assert.deepStrictEqual([...new Set(plan.frame.map((p) => p.z))].sort((a, b) => a - b), [0, 1, 2, 3])
    for (const p of plan.stand) {
      assert.strictEqual(Math.abs(p.x), 2)
      assert.strictEqual(p.y, 64)
    }
    assert.throws(() => portal.planPortalFrame({ x: 0, y: 0, z: 0 }, 'y'), /axis/)
  })
})

describe('U18 portal site search', () => {
  it('finds a flat site near the bot, never over the bot itself', () => {
    const w = fakeWorld()
    const bot = new Vec3(0, 64, 0)
    const site = portal.findPortalSite(w.at, bot, { radius: 8 })
    assert.ok(site, 'a site on flat ground')
    const plan = portal.planPortalFrame(site.base, site.axis)
    assert.strictEqual(site.base.y, 63)
    for (const p of [...plan.frame, ...plan.interior]) {
      assert.ok(!(Math.abs(p.x - bot.x) <= 1 && Math.abs(p.z - bot.z) <= 1), `frame cell ${s(p)} next to the bot`)
    }
  })

  it('skips sites with trees, water or lava around', () => {
    const w = fakeWorld()
    // a wall of logs everywhere except a clearing at x 20..30
    w.fill(new Vec3(-12, 64, -12), new Vec3(12, 70, 12), 'oak_log')
    const site = portal.findPortalSite(w.at, new Vec3(0, 64, 0), { radius: 16 })
    assert.ok(site)
    const plan = portal.planPortalFrame(site.base, site.axis)
    for (const p of plan.frame) assert.ok(Math.abs(p.x) > 12 || Math.abs(p.z) > 12, `frame at ${s(p)} in the forest`)

    const lava = fakeWorld().fill(new Vec3(-30, 63, -30), new Vec3(30, 63, 30), 'lava')
    assert.strictEqual(portal.findPortalSite(lava.at, new Vec3(0, 64, 0), { radius: 8 }), null)
    const water = fakeWorld()
    assert.strictEqual(portal.scorePortalSite(water.fill(new Vec3(1, 64, 0), new Vec3(1, 64, 0), 'water').at, new Vec3(0, 63, 0), 'x'), null)
  })
})

describe('U18 obsidian casting planner (mold)', () => {
  /** a 6×6 lava pool sunk 2 deep at x 0..5, z 0..5 */
  function poolWorld () {
    const w = fakeWorld()
    w.fill(new Vec3(0, 62, 0), new Vec3(5, 63, 5), 'lava')
    const lava = []
    for (let x = 0; x <= 5; x++) for (let z = 0; z <= 5; z++) for (const y of [62, 63]) lava.push(new Vec3(x, y, z))
    return { w, lava }
  }

  it('a mold 5–12 blocks from the pool: walls and floor solid, water next to it on the ground, stand 2 blocks back', () => {
    const { w, lava } = poolWorld()
    const plan = portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3) })
    assert.ok(plan, 'a mold')
    const { mold, water, stand, dir } = plan
    assert.ok(plan.lavaDistance >= 5 && plan.lavaDistance <= 12, `lava ${plan.lavaDistance}`)
    assert.strictEqual(mold.y, 63, 'the mold is a ground block')
    assert.strictEqual(w.at(mold.offset(0, -1, 0)).name, 'stone')
    for (const d of [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]) {
      assert.strictEqual(w.at(mold.plus(d)).boundingBox, 'block', 'walls around the mold')
    }
    assert.ok(water.equals(mold.plus(dir).offset(0, 1, 0)), 'water on the ground block next to the mold')
    assert.ok(stand.equals(mold.minus(dir.scaled(2)).offset(0, 1, 0)), 'stand two blocks on the other side')
    assert.strictEqual(w.at(stand).name, 'air')
    assert.strictEqual(w.at(stand.offset(0, -1, 0)).boundingBox, 'block')
    // the water must not reach the pool: the whole 5×5 around the mold is out of the lava
    for (const l of lava) assert.ok(Math.hypot(l.x - mold.x, l.z - mold.z) >= 5)
  })

  it('no mold when the ground around the pool is not flat / dry', () => {
    const { w, lava } = poolWorld()
    w.fill(new Vec3(-20, 64, -20), new Vec3(25, 64, 25), 'water')
    w.fill(new Vec3(0, 64, 0), new Vec3(5, 64, 5), 'air')
    assert.strictEqual(portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3) }), null)
  })

  it('the water cell and the cell over the hole are plain air (a flower there would hold the water); excluded molds are skipped', () => {
    const { w, lava } = poolWorld()
    const first = portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3) })
    // flowers on every cell around the first mold except one side
    const m = first.mold
    for (const d of [new Vec3(1, 1, 0), new Vec3(-1, 1, 0), new Vec3(0, 1, 1)]) w.fill(m.plus(d), m.plus(d), 'wildflowers')
    const again = portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3) })
    assert.ok(again.mold.equals(m), 'same mold')
    assert.strictEqual(w.at(again.water).name, 'air')
    assert.ok(again.water.equals(m.offset(0, 1, -1)), `water on the one free side: ${again.water}`)
    const other = portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3), exclude: new Set([m.toString()]) })
    assert.ok(other && !other.mold.equals(m), 'another mold when the first is excluded')
  })

  it('prefers a mold about 7 blocks from the lava and never on sand / gravel', () => {
    const { w, lava } = poolWorld()
    w.fill(new Vec3(-20, 63, -20), new Vec3(-1, 63, 25), 'sand')
    const plan = portal.planMold(w.at, lava, { near: new Vec3(3, 64, 3) })
    assert.ok(plan)
    assert.notStrictEqual(w.at(plan.mold).name, 'sand')
    assert.ok(Math.abs(plan.lavaDistance - 7) <= 1, `${plan.lavaDistance}`)
  })
})
