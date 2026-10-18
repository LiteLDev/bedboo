'use strict'
// owner: U4 (core runtime) — inventory_transaction builders + the held-item provider (lib/bedrock/transactions.js),
// lib/bedrock/item.js; every built packet is serialized with bedrock-protocol 1.26.51
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const tx = require('../../lib/bedrock/transactions')
const item = require('../../lib/bedrock/item')

let serializer
function roundTrip (name, params) {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  if (!serializer) {
    serializer = createSerializer('1.26.51')
    serializer.deserializer = createDeserializer('1.26.51')
  }
  const buf = serializer.createPacketBuffer({ name, params })
  return serializer.deserializer.parsePacketBuffer(buf).data.params
}

async function withPickaxe () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  // the capture's first /give (diamond_pickaxe into hotbar slot 0) → inventory_content + player_hotbar
  for (const { name, params } of afterSpawnRecords()) {
    if (name === 'inventory_content' || name === 'player_hotbar') {
      created.client.receive(name, params)
      if (name === 'player_hotbar') break
    }
  }
  created.client.clearSent()
  return created
}

describe('transactions + held item provider (U4 → U8)', function () {
  this.timeout(30000)

  it('heldNetworkItem mirrors the raw inventory packets (exact server copy) and the selected slot', async () => {
    const { bot, client } = await withPickaxe()
    const held = bot._bedrock.heldNetworkItem()
    assert.strictEqual(bot.registry.items[held.network_id].name, 'diamond_pickaxe')
    assert.strictEqual(held.stack_id, 15)
    assert.strictEqual(bot._bedrock.heldNetworkItem.selectedSlot(), 0)
    client.receive('inventory_slot', { window_id: 'inventory', slot: 3, item: { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 } })
    client.receive('player_hotbar', { selected_slot: 3, window_id: 'inventory', select_slot: true })
    assert.strictEqual(bot._bedrock.heldNetworkItem().network_id, 0)
    client.receive('mob_equipment', { runtime_entity_id: 91n, item: held, slot: 1, selected_slot: 1, window_id: 'inventory' })
    assert.strictEqual(bot._bedrock.heldNetworkItem.selectedSlot(), 1)
    // U8's provider reads the inventory model: slot 1 is empty, the pickaxe (exact copy) stays in slot 0
    assert.deepStrictEqual(bot._bedrock.heldNetworkItem(), bot._bedrock.heldNetworkItem.slot(1))
    assert.deepStrictEqual(bot._bedrock.heldNetworkItem.slot(0), held)
    client.receive('mob_equipment', { runtime_entity_id: 7n, item: held, slot: 5, selected_slot: 5, window_id: 'inventory' })
    assert.strictEqual(bot._bedrock.heldNetworkItem.selectedSlot(), 1, "another entity's equipment")
  })

  it('useItemOn: start_item_use_on → item_use click_block → stop_item_use_on, held item and block runtime id exact', async () => {
    const { bot, client } = await withPickaxe()
    const held = bot._bedrock.heldNetworkItem()
    await tx.useItemOn(bot, { position: new Vec3(1, -61, 2), face: 1, stopDelay: 0 })
    const sent = client.written.map(([, name, params]) => [name, params])
    assert.deepStrictEqual(sent.map(([n, p]) => n === 'player_action' ? p.action : n), ['start_item_use_on', 'inventory_transaction', 'stop_item_use_on'])
    const [, start] = sent[0]
    assert.deepStrictEqual([start.position, start.result_position, start.face, start.runtime_entity_id], [{ x: 1, y: -61, z: 2 }, { x: 1, y: -60, z: 2 }, 1, 91n])
    const data = sent[1][1].transaction.transaction_data
    assert.strictEqual(sent[1][1].transaction.transaction_type, 'item_use')
    assert.strictEqual(data.action_type, 'click_block')
    assert.strictEqual(data.trigger_type, 'player_input')
    assert.deepStrictEqual(data.held_item, held)
    assert.strictEqual(data.hotbar_slot, 0)
    assert.strictEqual(data.hand, 'main_hand')
    assert.deepStrictEqual(data.click_pos, { x: 0.5, y: 1, z: 0.5 })
    assert.ok(Math.abs(data.player_pos.y - (bot.entity.position.y + 1.62)) < 1e-9, 'eye-level player position')
    const grass = bot.registry.blocksByName.grass_block.defaultState
    assert.strictEqual(data.block_runtime_id, bot.registry.runtimeIdByStateId[grass], 'network runtime id of the clicked block')
    assert.deepStrictEqual(sent[2][1].position, { x: 1, y: -60, z: 2 })
    // serializer round trip
    for (const [name, params] of sent) roundTrip(name, params)
    const back = roundTrip('inventory_transaction', sent[1][1]).transaction.transaction_data
    assert.strictEqual(back.held_item.stack_id, 15)
    assert.strictEqual(back.block_runtime_id, data.block_runtime_id)

    client.clearSent()
    await tx.useItemOn(bot, { position: new Vec3(1, -61, 2), face: 2, cursor: { x: 0.2, y: 0.3, z: 0 }, hotbarSlot: 4, blockRuntimeId: 7, lifecycle: false })
    assert.deepStrictEqual(client.written.map(([, n]) => n), ['inventory_transaction'])
    const bare = client.written[0][2].transaction.transaction_data
    assert.deepStrictEqual([bare.hotbar_slot, bare.block_runtime_id, bare.click_pos], [4, 7, { x: 0.2, y: 0.3, z: 0 }])
  })

  it('useItem (click_air), release, useOnEntity (attack / interact), mouseOver serialize', async () => {
    const { bot, client } = await withPickaxe()
    await tx.useItem(bot)
    await tx.release(bot)
    await tx.useOnEntity(bot, { id: 12 }, { action: 'attack' })
    await tx.useOnEntity(bot, { id: 13 }, { action: 'interact', position: { x: 0.1, y: 1, z: 0.2 } })
    tx.mouseOver(bot, { id: 13 }, { x: 1, y: 2, z: 3 })
    tx.mouseOver(bot, null)
    assert.throws(() => tx.buildUseOnEntity(bot, { id: 1 }, { action: 'hug' }), /action must be/)
    const sent = client.written.map(([, name, params]) => [name, params])
    const types = sent.map(([n, p]) => n === 'inventory_transaction' ? p.transaction.transaction_type + ':' + p.transaction.transaction_data.action_type : n + ':' + p.action_id)
    assert.deepStrictEqual(types, ['item_use:click_air', 'item_release:release', 'item_use_on_entity:attack', 'item_use_on_entity:interact', 'interact:mouse_over_entity', 'interact:mouse_over_entity'])
    assert.strictEqual(sent[2][1].transaction.transaction_data.entity_runtime_id, 12n)
    assert.strictEqual(sent[0][1].transaction.transaction_data.held_item.stack_id, 15)
    for (const [name, params] of sent) {
      const back = roundTrip(name, params)
      assert.ok(back)
    }
    assert.strictEqual(roundTrip('interact', sent[4][1]).position.z, 3)
    assert.strictEqual(roundTrip('interact', sent[5][1]).target_entity_id, 0n)
  })

  it('item.fromNetwork / toNetwork round-trip the server copy', async () => {
    const { bot } = await withPickaxe()
    const wire = bot._bedrock.heldNetworkItem()
    const it = item.fromNetwork(bot.registry, wire)
    assert.strictEqual(it.name, 'diamond_pickaxe')
    assert.strictEqual(it.stackId, 15)
    const slot = (i) => serializer.createPacketBuffer({ name: 'inventory_slot', params: { window_id: 'inventory', slot: 0, item: i } })
    roundTrip('inventory_slot', { window_id: 'inventory', slot: 0, item: wire })
    assert.ok(slot(item.toNetwork(bot.registry, it)).equals(slot(wire)), 'byte for byte')
    assert.strictEqual(item.toNetwork(bot.registry, it, { stackId: 99 }).stack_id, 99)
    assert.strictEqual(item.fromNetwork(bot.registry, item.EMPTY_NETWORK_ITEM), null)
    assert.deepStrictEqual(item.toNetwork(bot.registry, null), { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })
    assert.strictEqual(bot._bedrock.ids.itemName(wire.network_id), 'diamond_pickaxe')
    assert.strictEqual(bot._bedrock.ids.itemNetworkId('minecraft:diamond_pickaxe'), wire.network_id)
  })
})
