'use strict'
// owner: U2 (Bedrock data layer) — patched prismarine-block on the bedrock_1.26.51 overlay
const assert = require('assert')
const fixtures = require('../../fixtures')
const { createRegistry } = require('../../../lib/registry')

const cap = fixtures.load('join_flat')
const registry = createRegistry()
registry.handleStartGame(cap.first('start_game'))
registry.handleItemRegistry(cap.first('item_registry'))
const Block = require('prismarine-block')(registry)
const item = name => registry.itemsByName[name].id
const block = (name, properties) => properties ? Block.fromProperties(name, properties, 0) : Block.fromStateId(registry.blocksByName[name].defaultState, 0)

describe('prismarine-block (bedboo patch) on bedrock_1.26.51', () => {
  it('Block.fromStateId resolves name, type, metadata, shapes and properties', () => {
    const stone = block('stone')
    assert.strictEqual(stone.name, 'stone')
    assert.strictEqual(stone.type, registry.blocksByName.stone.id)
    assert.strictEqual(stone.metadata, 0)
    assert.strictEqual(stone.hardness, 1.5)
    assert.deepStrictEqual(stone.shapes, [[0, 0, 0, 1, 1, 1]])
    const log = block('oak_log', { pillar_axis: 'x' })
    assert.strictEqual(log.name, 'oak_log')
    assert.deepStrictEqual(log.getProperties(), { pillar_axis: 'x' })
    assert.strictEqual(log.metadata, log.stateId - registry.blocksByName.oak_log.minStateId)
    assert.deepStrictEqual(block('air').shapes, [])
  })

  it('per-state collision shapes: slabs, stairs, fences (1.26.50 connection states)', () => {
    assert.deepStrictEqual(block('oak_slab', { 'minecraft:vertical_half': 'bottom' }).shapes, [[0, 0, 0, 1, 0.5, 1]])
    assert.deepStrictEqual(block('oak_slab', { 'minecraft:vertical_half': 'top' }).shapes, [[0, 0.5, 0, 1, 1, 1]])
    const fence = block('oak_fence')
    assert.ok(fence.shapes.length >= 1)
    assert.ok(fence.shapes.every(box => box[4] === 1.5), 'fences are 1.5 high')
  })

  it('block.hash is the network runtime id of the state (BDS hashes)', () => {
    for (const name of ['stone', 'grass_block', 'chest']) {
      const b = block(name)
      assert.strictEqual(b.hash, registry.runtimeIdByStateId[b.stateId], name)
    }
    const log = block('oak_log', { pillar_axis: 'x' })
    assert.strictEqual(log.hash, registry.runtimeIdByStateId[log.stateId])
    assert.notStrictEqual(log.hash, block('oak_log').hash)
    // what BDS sent for /setblock stone in the capture
    assert.strictEqual(block('stone').hash, -2144268767)
    // a server without hashed ids: the runtime id is the state index
    const plain = createRegistry()
    plain.handleStartGame({ block_network_ids_are_hashes: false })
    const PlainBlock = require('prismarine-block')(plain)
    const stone = PlainBlock.fromStateId(plain.blocksByName.stone.defaultState, 0)
    assert.strictEqual(stone.hash, stone.stateId)
  })

  it('stone: wooden pickaxe vs hand (canHarvest, digTime)', () => {
    const stone = block('stone')
    assert.ok(stone.canHarvest(item('wooden_pickaxe')))
    assert.ok(!stone.canHarvest(null))
    assert.strictEqual(stone.digTime(item('wooden_pickaxe'), false, false, false, [], {}), 1150) // 1.5 * 1.5 / 2 s
    assert.strictEqual(stone.digTime(null, false, false, false, [], {}), 7500) // 1.5 * 5 s, no drops
    assert.strictEqual(stone.digTime(item('wooden_pickaxe'), true, false, false, [], {}), 0) // creative
  })

  it('diamond_ore: iron vs stone pickaxe', () => {
    const ore = block('diamond_ore')
    assert.ok(ore.canHarvest(item('iron_pickaxe')))
    assert.ok(ore.canHarvest(item('diamond_pickaxe')))
    assert.ok(!ore.canHarvest(item('stone_pickaxe')))
    assert.ok(!ore.canHarvest(item('golden_pickaxe')))
    assert.strictEqual(ore.digTime(item('iron_pickaxe'), false, false, false, [], {}), 750) // 3 * 1.5 / 6 s
    assert.strictEqual(ore.digTime(item('stone_pickaxe'), false, false, false, [], {}), 3750) // 3 * 5 / 4 s, no drops
  })

  it('digTime uses Bedrock effect ids (Haste 3, MiningFatigue 4) and Bedrock enchantment names', () => {
    const stone = block('stone')
    const pick = item('iron_pickaxe')
    const base = stone.digTime(pick, false, false, false, [], {})
    const haste = stone.digTime(pick, false, false, false, [], { 3: { amplifier: 1 } })
    assert.ok(haste < base, `haste ${haste} < ${base}`)
    const fatigue = stone.digTime(pick, false, false, false, [], { 4: { amplifier: 0 } })
    assert.ok(fatigue > base)
    const efficiency = stone.digTime(pick, false, false, false, [{ name: 'efficiency', lvl: 3 }], {})
    assert.ok(efficiency < base)
    assert.strictEqual(stone.digTime(pick, false, true, false, [], {}), stone.digTime(pick, false, false, true, [], {}), 'water and air both divide by 5')
  })

  it('unbreakable and instant blocks', () => {
    assert.strictEqual(block('bedrock').digTime(item('diamond_pickaxe'), false, false, false, [], {}), Infinity)
    assert.strictEqual(block('short_grass').digTime(null, false, false, false, [], {}), 0)
  })
})
