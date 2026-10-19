'use strict'
// owner: U17 — the vendored smelting table and the drop / fuel knowledge, checked against the 1.26.51 registry
const assert = require('assert')
const data = require('../src/data')

describe('smelting table + game knowledge (U17)', () => {
  let registry
  before(() => {
    require('@bedboo/bedrock-data').install()
    registry = require('prismarine-registry')('bedrock_1.26.51')
  })

  it('every furnace recipe names real 1.26.51 items; no gear is ever smelted', () => {
    assert.ok(data.smeltingRecipes.length > 90, `${data.smeltingRecipes.length} recipes`)
    for (const r of data.smeltingRecipes) {
      assert.ok(registry.itemsByName[r.input], `input ${r.input}`)
      assert.ok(registry.itemsByName[r.output], `output ${r.output}`)
      assert.ok(r.count >= 1)
      assert.ok(!/_(pickaxe|axe|sword|shovel|hoe|helmet|chestplate|leggings|boots)$/.test(r.input), r.input)
    }
  })

  it('the progression recipes are there', () => {
    const src = (out) => data.smeltingSources(out).map((r) => r.input)
    assert.ok(src('iron_ingot').includes('raw_iron'))
    assert.ok(src('gold_ingot').includes('raw_gold'))
    assert.ok(src('copper_ingot').includes('raw_copper'))
    assert.ok(src('glass').includes('sand'))
    assert.ok(src('stone').includes('cobblestone'))
    for (const log of ['oak_log', 'birch_log', 'spruce_log', 'cherry_log', 'pale_oak_log', 'stripped_oak_log']) assert.ok(src('charcoal').includes(log), log)
    for (const food of ['beef', 'porkchop', 'mutton', 'chicken', 'cod', 'salmon', 'potato']) assert.ok(data.smeltResult(food), food)
    assert.strictEqual(data.smeltResult('raw_iron').output, 'iron_ingot')
    assert.strictEqual(data.smeltResult('diamond'), null)
  })

  it('fuels: coal smelts 8, planks / logs 1.5, a stick 0.5; non-fuels 0', () => {
    assert.strictEqual(data.itemsPerFuel('coal'), 8)
    assert.strictEqual(data.itemsPerFuel('charcoal'), 8)
    assert.strictEqual(data.itemsPerFuel('oak_planks'), 1.5)
    assert.strictEqual(data.itemsPerFuel('birch_log'), 1.5)
    assert.strictEqual(data.itemsPerFuel('stick'), 0.5)
    assert.strictEqual(data.itemsPerFuel('lava_bucket'), 100)
    assert.strictEqual(data.itemsPerFuel('crimson_planks'), 0, 'nether wood does not burn')
    assert.strictEqual(data.itemsPerFuel('cobblestone'), 0)
    for (const f of data.FUEL_CANDIDATES) assert.ok(registry.itemsByName[f], f)
  })

  it('drop yields: ores with several drops, chance drops, deepslate variants', () => {
    assert.strictEqual(data.dropYield('redstone_ore', 'redstone', ['redstone']), 4.5)
    assert.strictEqual(data.dropYield('deepslate_redstone_ore', 'redstone', ['redstone']), 4.5)
    assert.strictEqual(data.dropYield('lit_redstone_ore', 'redstone', ['redstone']), 4.5)
    assert.strictEqual(data.dropYield('deepslate_lapis_ore', 'lapis_lazuli', ['lapis_lazuli']), 6.5)
    assert.strictEqual(data.dropYield('gravel', 'flint', ['gravel', 'flint']), 0.1)
    assert.strictEqual(data.dropYield('oak_leaves', 'stick', ['oak_sapling', 'stick', 'apple']), 0.02)
    assert.strictEqual(data.dropYield('stone', 'cobblestone', ['cobblestone']), 1)
    assert.strictEqual(data.dropYield('stone', 'dirt', ['cobblestone']), 0)
  })

  it('mob drops: passive mobs only unless asked', () => {
    assert.deepStrictEqual(data.mobSources('leather').map((s) => s.mob).sort(), ['cow', 'mooshroom'])
    assert.deepStrictEqual(data.mobSources('string'), [])
    assert.deepStrictEqual(data.mobSources('string', { hostile: true }).map((s) => s.mob).sort(), ['cave_spider', 'spider'])
  })

  it('natural blocks: every name exists; emerald ore needs a mountain biome that exists', () => {
    const biomes = new Set(registry.biomesArray.map((b) => b.name))
    for (const [name, info] of Object.entries(data.NATURAL)) {
      assert.ok(registry.blocksByName[name], name)
      for (const b of info.biomes ?? []) assert.ok(biomes.has(b), `${name}: biome ${b}`)
    }
    assert.ok(data.NATURAL.emerald_ore.biomes.includes('meadow'))
  })
})
