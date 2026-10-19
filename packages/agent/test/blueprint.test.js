'use strict'
// owner: U17 — blueprint compiler and verifier (no server)
const assert = require('assert')
const { Vec3 } = require('vec3')
const { compile, verify, inBounds, BLUEPRINTS, STONE, PLANKS } = require('../src/blueprint')

const key = (p) => `${p.x},${p.y},${p.z}`

describe('blueprint compiler (U17)', () => {
  const house = BLUEPRINTS.house5x5

  it('house5x5: 98 structure blocks + door, table, chest; materials per spec', () => {
    const c = compile(house, { x: 10, y: 64, z: -5 })
    assert.deepStrictEqual(c.size, { x: 5, y: 5, z: 5 })
    assert.deepStrictEqual(c.bounds.min, new Vec3(10, 64, -5))
    assert.deepStrictEqual(c.bounds.max, new Vec3(14, 68, -1))
    const byItem = Object.fromEntries(c.materials.map((m) => [m.item, m.count]))
    assert.deepStrictEqual(byItem, { cobblestone: 71, oak_planks: 25, wooden_door: 1, crafting_table: 1, chest: 1 })
    assert.deepStrictEqual(c.materials.find((m) => m.item === 'cobblestone').names, STONE)
    assert.deepStrictEqual(c.materials.find((m) => m.item === 'oak_planks').names, PLANKS)
    assert.strictEqual(c.placements.length, 99)
    // interior air: 3×3×3 minus the table and chest cells
    assert.strictEqual(c.air.length, 25)
    // checks: every placement + the door's upper half
    assert.strictEqual(c.checks.length, 100)
    assert.ok(c.checks.some((x) => x.upper && x.pos.equals(new Vec3(12, 66, -1))))
  })

  it('buildable order: bottom-up, every block touches an earlier one (or the ground), furniture and door last', () => {
    const c = compile(house, { x: 0, y: 0, z: 0 })
    const placed = new Set()
    let phase2 = false
    for (const p of c.placements) {
      if (p.phase === 2) phase2 = true
      else assert.ok(!phase2, 'structure blocks all come before phase 2')
      const supported = p.pos.y === 0 || [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
        .some(([dx, dy, dz]) => placed.has(key(p.pos.offset(dx, dy, dz))))
      assert.ok(supported, `${p.item} at ${p.pos} has a neighbour to click`)
      placed.add(key(p.pos))
    }
    const ys = c.placements.filter((p) => p.phase === 1).map((p) => p.pos.y)
    assert.deepStrictEqual(ys, ys.slice().sort((a, b) => a - b), 'layers bottom-up')
    const door = c.placements.at(-1)
    assert.ok(door.tall, 'the door is placed last')
    assert.deepStrictEqual(door.pos, new Vec3(2, 1, 4))
    // the roof's middle comes after its edge
    const roof = c.placements.filter((p) => p.pos.y === 4)
    assert.ok(roof.findIndex((p) => p.pos.x === 2 && p.pos.z === 2) > roof.findIndex((p) => p.pos.x === 0 && p.pos.z === 0))
  })

  it('verify: block by block, alternatives accepted, interior must be air', () => {
    const c = compile(house, { x: 0, y: 0, z: 0 })
    const world = new Map()
    for (const x of c.checks) world.set(key(x.pos), { name: x.names[x.names.length > 1 ? 1 : 0], boundingBox: 'block' })
    for (const p of c.air) world.set(key(p), { name: 'air', boundingBox: 'empty' })
    const blockAt = (p) => world.get(key(p)) ?? null
    const ok = verify(c, blockAt)
    assert.deepStrictEqual({ ok: ok.ok, checked: ok.checked, mismatches: ok.mismatches.length }, { ok: true, checked: 125, mismatches: 0 })

    world.set('0,2,0', { name: 'dirt', boundingBox: 'block' })
    world.set('2,2,2', { name: 'cobblestone', boundingBox: 'block' })
    world.set('1,1,2', { name: 'short_grass', boundingBox: 'empty' })
    const bad = verify(c, blockAt)
    assert.strictEqual(bad.ok, false)
    assert.deepStrictEqual(bad.mismatches.map((m) => [key(m.pos), m.actual]).sort(), [['0,2,0', 'dirt'], ['2,2,2', 'cobblestone']])
  })

  it('rejects malformed blueprints with a reason', () => {
    assert.throws(() => compile({ layers: [] }), /no layers/)
    assert.throws(() => compile({ palette: { a: 'stone' }, layers: [['ab']] }), /'b' is not in the palette/)
    assert.throws(() => compile({ palette: { D: { block: 'wooden_door', tall: true } }, layers: [['D']] }), /upper-half/)
    // a floating block in layer 2 with nothing under it or next to it
    assert.throws(() => compile({ palette: { s: 'stone' }, layers: [['s  '], ['   '], ['  s']] }), /unsupported block/)
  })

  it('inBounds', () => {
    const c = compile(house, { x: 0, y: 0, z: 0 })
    assert.ok(inBounds(c, new Vec3(4, 4, 4)))
    assert.ok(!inBounds(c, new Vec3(5, 0, 0)))
    assert.ok(inBounds(c, new Vec3(5, 0, 0), 1))
  })
})
