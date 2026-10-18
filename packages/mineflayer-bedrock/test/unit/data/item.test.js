'use strict'
// owner: U2 (Bedrock data layer) — patched prismarine-item (ItemV4) on the U0 BDS 1.26.51.1 capture
const assert = require('assert')
const fixtures = require('../../fixtures')
const { createRegistry } = require('../../../lib/registry')

const cap = fixtures.load('join_flat')
const registry = createRegistry()
registry.handleStartGame(cap.first('start_game'))
registry.handleItemRegistry(cap.first('item_registry'))
const Item = require('prismarine-item')(registry)

function serializer () {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  const s = createSerializer('1.26.51')
  s.proto.setVariable('ShieldItemID', registry.itemsByName.shield.id)
  return s
}

describe('prismarine-item (bedboo patch) with Bedrock ItemV4', () => {
  const ser = serializer()
  const contents = cap.packets('inventory_content').map(p => p.params)

  it('toNotch(null) is the full 1.26.40+ empty ItemV4, exactly as BDS sends it', () => {
    const empty = contents[0].input.find(i => i.network_id === 0)
    const defined = o => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined))
    assert.deepStrictEqual(Item.toNotch(null), defined(empty))
    assert.ok(ser.createPacketBuffer({ name: 'inventory_content', params: { ...contents[0], input: [empty] } })
      .equals(ser.createPacketBuffer({ name: 'inventory_content', params: { ...contents[0], input: [Item.toNotch(null)] } })))
    assert.deepStrictEqual(Item.toNotch(null), { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })
    assert.strictEqual(Item.fromNotch(empty), null)
  })

  it('fromNotch keeps stack_id, block_runtime_id and the extra NBT (Damage, ench)', () => {
    const wires = contents.flatMap(p => p.input).filter(i => i.network_id !== 0)
    const sword = wires.find(i => nbtOf(i)?.ench)
    const item = Item.fromNotch(sword)
    assert.strictEqual(item.name, 'iron_sword')
    assert.strictEqual(item.stackId, sword.stack_id)
    assert.strictEqual(item.durabilityUsed, 0)
    assert.deepStrictEqual(item.enchants, [{ name: 'sharpness', lvl: 2 }])
    const log = Item.fromNotch(wires.find(i => registry.items[i.network_id].name === 'oak_log'))
    assert.strictEqual(log.blockRuntimeId, registry.runtimeIdByStateId[registry.itemsByName.oak_log.blockStateId])
  })

  it('toNotch(fromNotch(x)) re-serializes every captured inventory packet byte for byte', () => {
    for (const params of contents) {
      const roundTripped = { ...params, input: params.input.map(i => Item.toNotch(Item.fromNotch(i))) }
      const a = ser.createPacketBuffer({ name: 'inventory_content', params })
      const b = ser.createPacketBuffer({ name: 'inventory_content', params: roundTripped })
      assert.ok(a.equals(b), 'inventory_content ' + JSON.stringify(params.input.filter(i => i.network_id).map(i => registry.items[i.network_id].name)))
    }
    for (const { params } of cap.packets('inventory_slot')) {
      const b = ser.createPacketBuffer({ name: 'inventory_slot', params: { ...params, item: Item.toNotch(Item.fromNotch(params.item)) } })
      assert.ok(ser.createPacketBuffer({ name: 'inventory_slot', params }).equals(b))
    }
  })

  it('new block items carry the block runtime id BDS uses (every creative_content entry)', () => {
    const creative = cap.first('creative_content').items
    assert.ok(creative.length > 1900)
    let blockItems = 0
    for (const { item: wire } of creative) {
      const item = new Item(wire.network_id, 1, wire.metadata)
      if (wire.block_runtime_id) blockItems++
      assert.strictEqual(Item.toNotch(item).block_runtime_id, wire.block_runtime_id, item.name)
    }
    assert.ok(blockItems > 1000)
  })

  it('new items get a client stack id; non-block items carry block_runtime_id 0', () => {
    const pick = new Item(registry.itemsByName.diamond_pickaxe.id, 1)
    const wire = Item.toNotch(pick)
    assert.strictEqual(wire.has_stack_id, true)
    assert.strictEqual(typeof wire.stack_id, 'number')
    assert.strictEqual(wire.block_runtime_id, 0)
    assert.deepStrictEqual(pick.nbt.value.Damage, { type: 'int', value: 0 }, 'explicit Damage like the server copy')
    assert.strictEqual(Item.toNotch(pick, false).has_stack_id, false)
    ser.createPacketBuffer({ name: 'inventory_content', params: { ...contents[0], input: [wire] } })
  })
})

function nbtOf (wire) {
  const nbt = require('prismarine-nbt')
  return wire.extra?.nbt?.nbt ? nbt.simplify(wire.extra.nbt.nbt) : null
}
