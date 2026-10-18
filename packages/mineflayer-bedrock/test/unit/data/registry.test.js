'use strict'
// owner: U2 (Bedrock data layer) — patched prismarine-registry on the U0 BDS 1.26.51.1 capture
const assert = require('assert')
const fixtures = require('../../fixtures')
const { createRegistry } = require('../../../lib/registry')

const cap = fixtures.load('join_flat')
const startGame = cap.first('start_game')
const itemRegistry = cap.first('item_registry')

function joinedRegistry () {
  const registry = createRegistry()
  registry.handleStartGame(startGame)
  registry.handleItemRegistry(itemRegistry)
  return registry
}

/** every block runtime id the capture carries: sub-chunk palettes, update_block, level_event block data */
function capturedRuntimeIds () {
  const ids = new Set()
  for (const { params } of cap.packets('update_block')) ids.add(params.block_runtime_id)
  for (const { params } of cap.packets('level_event')) if (params.event === 'particle_destroy') ids.add(params.data)
  return ids
}

describe('prismarine-registry (bedboo patch) from start_game + item_registry', () => {
  const registry = joinedRegistry()

  it('item_registry: every entry resolves name ↔ id', () => {
    assert.strictEqual(itemRegistry.itemstates.length, 2076)
    for (const { name, runtime_id: id } of itemRegistry.itemstates) {
      const short = name.replace('minecraft:', '')
      assert.strictEqual(registry.itemsByName[short]?.id, id, name)
      assert.strictEqual(registry.items[id]?.name, short, name)
    }
    assert.strictEqual(registry.itemsArray.length, 2076)
    // static data survives the re-keying
    assert.strictEqual(registry.itemsByName.diamond_pickaxe.maxDurability, 1561)
    assert.strictEqual(registry.itemsByName.apple.componentBased, true)
  })

  it('writeItemStates() reproduces the server palette', () => {
    const written = registry.writeItemStates()
    const byName = new Map(itemRegistry.itemstates.map(s => [s.name, s]))
    for (const state of written) {
      const original = byName.get(state.name)
      assert.ok(original, state.name)
      assert.strictEqual(state.runtime_id, original.runtime_id)
      assert.strictEqual(state.component_based, original.component_based)
    }
  })

  it('start_game with hashes: blocksByRuntimeId / runtimeIdByStateId are inverse over all 22091 states', () => {
    assert.strictEqual(startGame.block_network_ids_are_hashes, true)
    assert.strictEqual(registry.runtimeIdByStateId.length, 22091)
    assert.strictEqual(Object.keys(registry.blocksByRuntimeId).length, 22091)
    for (let stateId = 0; stateId < registry.blockStates.length; stateId++) {
      const runtimeId = registry.runtimeIdByStateId[stateId]
      assert.strictEqual(registry.blocksByRuntimeId[runtimeId].stateId, stateId)
    }
    const stone = registry.blocksByName.stone
    assert.strictEqual(registry.runtimeIdByStateId[stone.defaultState], -2144268767) // what BDS sent for /setblock stone
    assert.strictEqual(registry.blocksByRuntimeId[-2].name, 'unknown')
  })

  it('every block runtime id in the capture resolves', () => {
    const ids = capturedRuntimeIds()
    assert.ok(ids.size >= 3)
    for (const id of ids) assert.ok(registry.blocksByRuntimeId[id], `runtime id ${id}`)
  })

  it('state ids stay sequential (Java-like contiguous minStateId..maxStateId)', () => {
    const fence = registry.blocksByName.oak_fence
    assert.strictEqual(fence.maxStateId - fence.minStateId + 1, 16)
    assert.strictEqual(registry.blocksByStateId[fence.minStateId + 3], fence)
    assert.strictEqual(registry.blockStatesByStateId[fence.defaultState].name, 'oak_fence')
  })

  it('without hashes, runtime ids are the palette indexes (same order as BDS)', () => {
    const r = createRegistry()
    r.handleStartGame({ block_network_ids_are_hashes: false })
    assert.strictEqual(r.blocksByRuntimeId[r.blocksByName.stone.defaultState].name, 'stone')
    assert.strictEqual(r.runtimeIdByStateId[123], 123)
  })

  it('re-keys harvestTools, materials, drops and foods when the server item ids differ', () => {
    const r = createRegistry()
    const md = require('minecraft-data')('bedrock_1.26.51')
    // a server whose palette shifts every non-negative id by 10000
    const shifted = itemRegistry.itemstates.map(s => ({ ...s, runtime_id: s.runtime_id >= 0 ? s.runtime_id + 10000 : s.runtime_id }))
    r.handleStartGame(startGame)
    r.handleItemRegistry({ itemstates: shifted })
    const wooden = r.itemsByName.wooden_pickaxe.id
    assert.strictEqual(wooden, md.itemsByName.wooden_pickaxe.id + 10000)
    assert.strictEqual(r.blocksByName.stone.harvestTools[wooden], true)
    assert.strictEqual(r.blocksByName.stone.harvestTools[md.itemsByName.wooden_pickaxe.id], undefined)
    assert.strictEqual(r.materials['mineable/pickaxe'][wooden], 2)
    assert.strictEqual(r.foodsByName.bread.id, md.itemsByName.bread.id + 10000)
    assert.strictEqual(r.foods[r.foodsByName.bread.id], r.foodsByName.bread)
    assert.ok(r.blocksByName.stone.drops.includes(r.itemsByName.cobblestone.id))
    const Block = require('prismarine-block')(r)
    assert.ok(Block.fromStateId(r.blocksByName.stone.defaultState, 0).canHarvest(wooden))
    // minecraft-data (shared by every registry) is untouched
    assert.strictEqual(md.blocksByName.stone.harvestTools[md.itemsByName.wooden_pickaxe.id], true)
    assert.strictEqual(md.materials['mineable/pickaxe'][md.itemsByName.wooden_pickaxe.id], 2)
    assert.strictEqual(md.foodsByName.bread.id, md.itemsByName.bread.id)
  })

  it('custom items from the palette get component data', () => {
    const r = createRegistry()
    const nbt = require('prismarine-nbt')
    const custom = {
      name: 'test:widget',
      runtime_id: 9000,
      component_based: true,
      version: 'data_driven',
      nbt: nbt.comp({ components: nbt.comp({ item_properties: nbt.comp({ max_stack_size: nbt.int(16) }), 'minecraft:display_name': nbt.comp({ value: nbt.string('Widget') }) }) })
    }
    r.handleItemRegistry({ itemstates: [...itemRegistry.itemstates, custom] })
    assert.strictEqual(r.items[9000].name, 'test:widget')
    assert.strictEqual(r.items[9000].stackSize, 16)
    assert.strictEqual(r.items[9000].displayName, 'Widget')
  })
})
