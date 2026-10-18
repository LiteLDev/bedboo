'use strict'
// owner: U8 (inventory, windows, creative & item use) — inventory plugin + model on a fake client: Bedrock inventory
// packets → Java-layout windows, held item, clickWindow → item stack requests (prediction, response, rollback),
// the inventory screen, creative, item use, and the internalTest heldItemChanged / activateItem analogs
const assert = require('assert')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick } = require('./helpers/inventory_server')
const { toNotchianYaw, toNotchianPitch } = require('mineflayer/lib/conversions')

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.server = serveInventory(created.bot, created.client)
  created.Item = require('prismarine-item')(created.bot.registry)
  return created
}

let serializer
function serialize (name, params) {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = serializer ?? createSerializer('1.26.51')
  return serializer.createPacketBuffer({ name, params })
}

const names = (window) => window.slots.map((it, i) => it ? `${i}:${it.name}x${it.count}` : null).filter(Boolean).join(' ')

describe('inventory: packets → bot.inventory, held item (U8)', function () {
  this.timeout(30000)

  it('inventory_content of the inventory / armor / off-hand / ui windows → Java slots, cursor, stack ids', async () => {
    const { bot, client } = await joined()
    assert.strictEqual(bot.quickBarSlot, 0, 'player_hotbar at join selects slot 0')
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 5], 8: ['dirt', 1], 9: ['apple', 3], 35: ['bone', 2] }, { firstStackId: 20 }))
    client.receive('inventory_content', inventoryContent(bot, { 0: ['iron_helmet', 1], 3: ['iron_boots', 1] }, { window: 'armor', size: 5, firstStackId: 30 }))
    client.receive('inventory_content', inventoryContent(bot, { 0: ['shield', 1] }, { window: 'offhand', size: 1, firstStackId: 40 }))
    client.receive('inventory_content', inventoryContent(bot, { 0: ['arrow', 7], 28: ['oak_planks', 1] }, { window: 'ui', size: 54, firstStackId: 50 }))
    assert.strictEqual(names(bot.inventory), '1:oak_planksx1 5:iron_helmetx1 8:iron_bootsx1 9:applex3 35:bonex2 36:stonex5 44:dirtx1 45:shieldx1')
    assert.deepStrictEqual([bot.inventory.slots[36].stackId, bot.inventory.slots[9].stackId, bot.inventory.slots[45].stackId], [20, 22, 40])
    assert.strictEqual(bot.inventory.selectedItem.name, 'arrow', 'ui slot 0 is the cursor')
    assert.strictEqual(bot.heldItem.name, 'stone')
    assert.deepStrictEqual(bot.entity.equipment.map(i => i?.name ?? null), ['stone', 'shield', 'iron_boots', null, null, 'iron_helmet'])
    // an identical resend fires no updateSlot (BDS resends every window after each command / rejection)
    let events = 0
    bot.inventory.on('updateSlot', () => events++)
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 5], 8: ['dirt', 1], 9: ['apple', 3], 35: ['bone', 2] }, { firstStackId: 20 }))
    assert.strictEqual(events, 0)
    // a server-driven inventory_transaction (e.g. /give, pickup) applies its new items with their stack ids
    client.receive('inventory_transaction', { transaction: { legacy: { legacy_request_id: 0 }, transaction_type: 'normal', actions: [{ source_type: 'container', window_id: 0, slot: 2, old_item: wireItem(bot, null), new_item: wireItem(bot, 'stick', 4, 61) }] } })
    assert.strictEqual(bot.inventory.slots[38].stackId, 61)
  })

  it('held item: player_hotbar forces the slot, setQuickBarSlot sends mob_equipment, heldNetworkItem is the exact server copy', async () => {
    const { bot, client } = await joined()
    // the recorded /give (diamond_pickaxe, stack id 15) from the capture
    for (const { name, params } of afterSpawnRecords()) {
      if (name === 'inventory_content' && params.window_id === 'inventory') { client.receive(name, params); break }
    }
    const wire = afterSpawnRecords().find(r => r.name === 'inventory_content' && r.params.window_id === 'inventory').params.input[0]
    const bytes = (item) => serialize('inventory_slot', { window_id: 'inventory', slot: 0, container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null), item })
    assert.ok(bytes(bot._bedrock.heldNetworkItem()).equals(bytes(wire)), 'byte for byte the server copy')
    assert.strictEqual(bot._bedrock.heldNetworkItem().stack_id, 15)
    assert.strictEqual(bot._bedrock.heldNetworkItem.selectedSlot(), 0)
    assert.strictEqual(bot._bedrock.heldNetworkItem.slots.length, 36)
    const changes = []
    bot.on('heldItemChanged', (item) => changes.push(item?.name ?? null))
    client.receive('player_hotbar', { selected_slot: 4, window_id: 'inventory', select_slot: true })
    assert.strictEqual(bot.quickBarSlot, 4)
    client.receive('player_hotbar', { selected_slot: 6, window_id: 'inventory', select_slot: false })
    assert.strictEqual(bot.quickBarSlot, 4, 'select_slot false: only informative')
    client.clearSent()
    bot.setQuickBarSlot(0)
    assert.deepStrictEqual(changes, [null, 'diamond_pickaxe'])
    const [equipment] = client.sent('mob_equipment')
    assert.ok(bytes(equipment.item).equals(bytes(wire)))
    assert.deepStrictEqual({ ...equipment, item: null }, { runtime_entity_id: bot.entity.runtimeId, item: null, slot: 0, selected_slot: 0, window_id: 'inventory' })
    serialize('mob_equipment', equipment)
    bot.setQuickBarSlot(0)
    assert.strictEqual(client.sent('mob_equipment').length, 1, 'same slot: nothing sent')
    assert.throws(() => bot.setQuickBarSlot(9))
  })

  it('internalTest › heldItemChanged › via inventory_slot', async () => {
    const { bot, client } = await joined()
    const changed = new Promise(resolve => bot.once('heldItemChanged', resolve))
    client.receive('inventory_slot', { window_id: 'inventory', slot: 0, item: wireItem(bot, 'stone', 1, 9), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const item = await changed
    assert.ok(item, 'heldItemChanged should provide the new item')
    assert.strictEqual(item.type, bot.registry.itemsByName.stone.id)
  })

  it('internalTest › heldItemChanged › emits heldItemChanged via updateSlot on the inventory', async () => {
    const { bot, Item } = await joined()
    const stoneId = bot.registry.itemsByName.stone.id
    const changed = new Promise(resolve => bot.once('heldItemChanged', resolve))
    bot.inventory.updateSlot(0 + bot.inventory.hotbarStart, new Item(stoneId, 1))
    const item = await changed
    assert.ok(item, 'heldItemChanged should provide the new item')
    assert.strictEqual(item.type, stoneId)
  })
})

describe('inventory: clickWindow → item stack requests (U8)', function () {
  this.timeout(30000)

  it('opens the inventory screen, predicts, sends one request per click, applies the response stack ids, closes when idle', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10], 9: ['dirt', 4] }, { firstStackId: 100 }))
    client.clearSent()
    const click = bot.clickWindow(36, 0, 0)
    assert.deepStrictEqual(client.sent('interact'), [{ action_id: 'open_inventory', target_entity_id: bot.entity.runtimeId, has_position: false }])
    assert.strictEqual(client.sent('item_stack_request').length, 0, 'waits for the screen')
    await click
    const [request] = server.requests
    assert.deepStrictEqual(request.actions, [{ type_id: 'take', legacy_type_id: 0, count: 10, source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 100 }, destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 } }])
    assert.strictEqual(bot.inventory.slots[36], null)
    assert.strictEqual(bot.inventory.selectedItem.count, 10)
    assert.ok(bot.inventory.selectedItem.stackId >= 1000, 'the response replaced the pending stack id')
    // right click into the dirt-free slot 20: one item; left click on the dirt: swap
    await bot.clickWindow(20, 1, 0)
    await bot.clickWindow(9, 0, 0)
    assert.strictEqual(names(bot.inventory), '9:stonex9 20:stonex1')
    assert.strictEqual(bot.inventory.selectedItem.name, 'dirt')
    assert.deepStrictEqual(server.requests[2].actions[0].type_id, 'swap')
    // the screen stays open while the cursor holds an item
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.strictEqual(client.sent('container_close').length, 0)
    await bot.clickWindow(36, 0, 0)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.strictEqual(client.sent('container_close').length, 1, 'closed 100 ms after the last click with an empty cursor')
    assert.strictEqual(bot._bedrock.inventoryModel.screen.isOpen(), false)
  })

  it('a rejected request is rolled back and throws mineflayer\'s message; shift click plans several places in one request', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['stone', 10], 0: ['stone', 60], 2: ['stone', 62] }, { firstStackId: 100 }))
    const before = names(bot.inventory)
    server.reject(49)
    const updates = []
    bot.inventory.on('updateSlot', (slot) => updates.push(slot))
    await assert.rejects(bot.clickWindow(9, 0, 0), /^Error: Server rejected transaction for clicking on slot 9, on window with id 0\.$/)
    assert.strictEqual(names(bot.inventory), before, 'rolled back')
    assert.strictEqual(bot.inventory.selectedItem, null)
    assert.deepStrictEqual(updates, [9, 9], 'predicted, then restored')
    const stackId = bot.inventory.slots[9].stackId
    await bot.clickWindow(9, 0, 1)
    const actions = server.requests.at(-1).actions
    assert.deepStrictEqual(actions.map(a => [a.type_id, a.count, a.source.slot, a.source.stack_id, a.destination.slot_type.container_id, a.destination.slot]),
      [['place', 4, 9, stackId, 'hotbar', 0], ['place', 2, 9, server.requests.at(-1).request_id, 'hotbar', 2], ['place', 4, 9, server.requests.at(-1).request_id, 'hotbar', 1]],
      'later actions of the same request reference the slot with the request id')
    assert.strictEqual(names(bot.inventory), '36:stonex64 37:stonex4 38:stonex64')
  })

  it('a slow server (> 100 ms) never has the inventory screen closed under an in-flight request', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 4] }, { firstStackId: 600 }))
    server.hold = true
    const click = bot.clickWindow(36, 0, 0)
    for (let i = 0; i < 5; i++) { await tick(); server.flush() } // the screen opens
    server.hold = true
    await new Promise(resolve => setTimeout(resolve, 250))
    assert.strictEqual(client.sent('container_close').length, 0, 'not closed while the request is in flight')
    assert.strictEqual(bot.inventory.selectedItem?.name, 'stone')
    server.hold = false
    server.flush()
    await click
    assert.strictEqual(bot.inventory.selectedItem?.name, 'stone')
    assert.strictEqual(server.requests.length, 1, 'no cursor return behind the click\'s back')
  })

  it('a request that timed out but is answered later is re-applied (late ok)', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 4] }, { firstStackId: 700 }))
    await bot.clickWindow(36, 0, 0) // screen open, stone on the cursor
    const mgr = bot._bedrock.stackRequests
    const create = mgr.create
    mgr.create = (actions, opts) => create(actions, { ...opts, timeout: 20 })
    server.hold = true
    await assert.rejects(bot.clickWindow(20, 0, 0), /Server didn't respond/)
    assert.strictEqual(bot.inventory.slots[20], null, 'rolled back on the timeout')
    assert.strictEqual(bot.inventory.selectedItem?.name, 'stone')
    server.hold = false
    server.flush() // the server applied it after all
    await tick()
    assert.strictEqual(bot.inventory.slots[20]?.name, 'stone', 're-applied')
    assert.ok(bot.inventory.slots[20].stackId > 0)
    assert.strictEqual(bot.inventory.selectedItem, null)
  })

  it('putAway falls back to click + place when Java\'s shift click target range is full (hotbar item, full main inventory)', async () => {
    const { bot, client, server } = await joined()
    const main = {}
    for (let i = 9; i < 36; i++) main[i] = ['dirt', 64]
    client.receive('inventory_content', inventoryContent(bot, { ...main, 0: ['stone', 3] }, { firstStackId: 800 }))
    await bot.putAway(36) // resolves (the shift click moves nothing: no updateSlot to wait for)
    // upstream's fallback: pick it up, put it into the first free slot of 9..44 — the slot it came from
    assert.deepStrictEqual(server.requests.map(r => r.actions[0].type_id), ['take', 'place'])
    assert.strictEqual(bot.inventory.slots[36]?.name, 'stone')
    assert.strictEqual(bot.inventory.selectedItem, null)
  })

  it('status 7 (no screen: BDS dropped the inventory screen) reopens it and retries once; a dimension change forgets it', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 4] }, { firstStackId: 500 }))
    await bot.clickWindow(36, 0, 0)
    assert.strictEqual(bot._bedrock.inventoryModel.screen.isOpen(), true, 'kept open: the cursor holds the stone')
    client.receive('change_dimension', { dimension: 'overworld', position: { x: 0, y: -60, z: 0 }, respawn: false, loading_screen_id: 1 })
    assert.strictEqual(bot._bedrock.inventoryModel.screen.isOpen(), false)
    client.clearSent()
    server.reject(7)
    await bot.clickWindow(36, 0, 0)
    assert.strictEqual(client.sent('interact').length, 2, 'opened after the dimension change, reopened after status 7')
    assert.strictEqual(client.sent('item_stack_request').length, 2, 'rejected once, retried once')
    assert.strictEqual(bot.inventory.slots[36]?.count, 4)
    assert.strictEqual(bot.inventory.selectedItem, null)
  })

  it('timeouts throw "Server didn\'t respond"; transfer / putAway / moveSlotItem / tossStack / equip work on the model', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['iron_boots', 1], 10: ['stone', 3] }, { firstStackId: 200 }))
    await bot.equip(bot.inventory.slots[9], 'feet')
    assert.strictEqual(bot.inventory.slots[8]?.name, 'iron_boots')
    const armorAction = server.requests.at(-1).actions[0]
    assert.deepStrictEqual([armorAction.destination.slot_type.container_id, armorAction.destination.slot], ['armor', 3])
    await bot.unequip('feet')
    assert.strictEqual(bot.inventory.slots[9]?.name, 'iron_boots')
    await bot.equip(bot.inventory.slots[10], 'hand')
    assert.strictEqual(bot.heldItem?.name, 'stone')
    await bot.tossStack(bot.heldItem)
    assert.strictEqual(bot.heldItem, null)
    assert.deepStrictEqual(server.requests.at(-1).actions.map(a => [a.type_id, a.count, a.source.slot_type.container_id]), [['drop', 3, 'cursor']])
    // a request the server never answers
    server.ignoreRequests = true
    const mgr = bot._bedrock.stackRequests
    const create = mgr.create
    mgr.create = (actions, opts) => create(actions, { ...opts, timeout: 30 })
    await assert.rejects(bot.clickWindow(9, 0, 0), /^Error: Server didn't respond to transaction for clicking on slot 9 on window with id 0\.$/)
    assert.strictEqual(bot.inventory.slots[9]?.name, 'iron_boots', 'rolled back')
  })

  it('container windows: clicks address the container, deposit/withdraw, closing returns the cursor first', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['bone', 5] }, { firstStackId: 300 }))
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 4, window_type: 'container', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 4, input: Array(27).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const chest = await opened
    client.clearSent()
    await chest.deposit(bot.registry.itemsByName.bone.id, null, 2)
    assert.strictEqual(client.sent('interact').length, 0, 'the container screen is open: no inventory screen')
    assert.strictEqual(chest.containerCount(bot.registry.itemsByName.bone.id), 2)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.bone.id), 3)
    const containers = new Set(server.requests.flatMap(r => r.actions.flatMap(a => [a.source.slot_type.container_id, a.destination?.slot_type.container_id])))
    assert.deepStrictEqual([...containers].sort(), ['container', 'cursor', 'hotbar', 'inventory'].filter(c => containers.has(c)).sort())
    assert.ok(containers.has('container'))
    await chest.withdraw(bot.registry.itemsByName.bone.id, null, 1)
    assert.strictEqual(chest.containerCount(bot.registry.itemsByName.bone.id), 1)
    await bot.clickWindow(chest.items()[0].slot, 0, 0)
    assert.ok(chest.selectedItem)
    client.clearSent()
    await bot.closeWindow(chest)
    assert.deepStrictEqual(client.written.map(([, n]) => n), ['item_stack_request', 'container_close'])
    assert.deepStrictEqual(server.requests.at(-1).actions.map(a => [a.type_id, a.source.slot_type.container_id, a.destination.slot_type.container_id, a.destination.slot]), [['place', 'cursor', 'hotbar', 0]])
    assert.strictEqual(bot.inventory.slots[36]?.count, 4, 'into the first empty slot (hotbar 0)')
    assert.strictEqual(bot.inventory.selectedItem, null)
  })
})

describe('inventory: creative and item use (U8)', function () {
  this.timeout(30000)

  it('creative.setInventorySlot: craft_creative (creative_content entry) + place from creative_output 50; replace = destroy first; clear = destroy', async () => {
    const { bot, client, server, Item } = await joined()
    const stone = bot._bedrock.creativeItems.entryFor(new Item(bot.registry.itemsByName.stone.id, 1))
    assert.ok(stone && stone.id > 0, 'creative_content from the join capture is indexed')
    await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName.stone.id, 10))
    let actions = server.requests.at(-1).actions
    const id = server.requests.at(-1).request_id
    assert.deepStrictEqual(actions, [
      { type_id: 'craft_creative', item_id: stone.id, times_crafted: 1, legacy_type_id: 14 },
      { type_id: 'place', legacy_type_id: 1, count: 10, source: { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: id }, destination: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 0 } }
    ])
    assert.strictEqual(bot.heldItem.count, 10)
    const sid = bot.heldItem.stackId
    await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 2))
    actions = server.requests.at(-1).actions
    assert.deepStrictEqual(actions.map(a => a.type_id), ['destroy', 'craft_creative', 'place'])
    assert.deepStrictEqual([actions[0].count, actions[0].source.stack_id], [10, sid])
    assert.strictEqual(bot.heldItem.name, 'dirt')
    const n = server.requests.length
    await bot.creative.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 2))
    assert.strictEqual(server.requests.length, n, 'same item: nothing to do')
    await bot.creative.clearSlot(36)
    assert.deepStrictEqual(server.requests.at(-1).actions.map(a => a.type_id), ['destroy'])
    assert.strictEqual(bot.heldItem, null)
    // off-hand (wire slot 1) and armor
    await bot.creative.setInventorySlot(45, new Item(bot.registry.itemsByName.shield.id, 1))
    assert.deepStrictEqual(server.requests.at(-1).actions[1].destination.slot_type, { container_id: 'offhand' })
    assert.strictEqual(server.requests.at(-1).actions[1].destination.slot, 1)
    await bot.creative.setInventorySlot(6, new Item(bot.registry.itemsByName.iron_chestplate.id, 1))
    assert.deepStrictEqual([server.requests.at(-1).actions[1].destination.slot_type.container_id, server.requests.at(-1).actions[1].destination.slot], ['armor', 1])
    await bot.creative.clearInventory()
    assert.strictEqual(bot.inventory.slots.filter(Boolean).length, 0)
    assert.ok(client.sent('interact').length >= 1, 'in the inventory screen')
    // refusals: an item outside the creative inventory, the crafting result slot, an open window
    const custom = new Item(bot.registry.itemsByName.diamond_sword.id, 1)
    custom.nbt.value.display = { type: 'compound', value: { Name: { type: 'string', value: 'x' } } }
    await assert.rejects(bot.creative.setInventorySlot(37, custom), /not in the server's creative inventory/)
    await assert.rejects(bot.creative.setInventorySlot(0, new Item(1, 1)), /cannot hold items/)
    await assert.rejects(bot.creative.setInventorySlot(46, null))
  })

  it('creative flight: startFlying / stopFlying → bot._bedrock.physics.setFlying (gravity untouched with the hook); flyTo → physics.flyTo (U5)', async () => {
    const { bot } = await joined()
    const calls = []
    const physics = bot._bedrock.physics
    const setFlying = physics.setFlying
    physics.setFlying = function (on) { calls.push(['setFlying', on, this === physics]); return setFlying.call(this, on) }
    const gravity = bot.physics.gravity
    bot.creative.startFlying()
    // W3-FIX-A: the Bedrock engine flies without upstream's gravity = 0 (it would stay 0 after a flight that ends
    // without stopFlying)
    assert.strictEqual(bot.physics.gravity, gravity)
    bot.creative.stopFlying()
    assert.strictEqual(bot.physics.gravity, gravity)
    physics.flyTo = async function (destination) { calls.push(['flyTo', destination.toString(), this === physics]) }
    await bot.creative.flyTo(bot.entity.position.offset(0, 2, 0))
    assert.deepStrictEqual(calls, [['setFlying', true, true], ['setFlying', false, true], ['setFlying', true, true], ['flyTo', bot.entity.position.offset(0, 2, 0).toString(), true]])
    bot.creative.stopFlying()
  })

  it('activateEntity / activateEntityAt: look, mouse_over_entity, item_use_on_entity interact (click position relative to the entity)', async () => {
    const { bot, client, clock } = await joined()
    const { Vec3 } = require('vec3')
    const entity = { id: 77, runtimeId: 77n, position: new Vec3(3, -60, 1) }
    client.clearSent()
    const done = bot.activateEntityAt(entity, new Vec3(3.25, -59, 1.5))
    for (let i = 0; i < 20 && client.sent('inventory_transaction').length === 0; i++) {
      await tick()
      clock.advance(50)
      bot._bedrock.input.pump()
    }
    await done
    const [mouse] = client.sent('interact')
    assert.deepStrictEqual([mouse.action_id, mouse.target_entity_id, mouse.position], ['mouse_over_entity', 77n, { x: 0.25, y: 1, z: 0.5 }])
    const data = client.sent('inventory_transaction')[0].transaction.transaction_data
    assert.deepStrictEqual([data.action_type, data.entity_runtime_id, data.click_pos], ['interact', 77n, { x: 0.25, y: 1, z: 0.5 }])
    client.clearSent()
    const plain = bot.activateEntity(entity)
    for (let i = 0; i < 20 && client.sent('inventory_transaction').length === 0; i++) {
      await tick()
      clock.advance(50)
      bot._bedrock.input.pump()
    }
    await plain
    assert.deepStrictEqual(client.sent('inventory_transaction')[0].transaction.transaction_data.click_pos, { x: 0, y: 0, z: 0 })
  })

  it('_setSlot emits setSlot:<window id> and heldItemChanged; _syncWindow resolves without a packet (no client resync on Bedrock)', async () => {
    const { bot, client, Item } = await joined()
    const setSlot = new Promise(resolve => bot.once('setSlot:0', (oldItem, newItem) => resolve([oldItem, newItem])))
    const held = new Promise(resolve => bot.once('heldItemChanged', resolve))
    bot._setSlot(36, new Item(bot.registry.itemsByName.stone.id, 2))
    const [oldItem, newItem] = await setSlot
    assert.deepStrictEqual([oldItem, newItem.name], [null, 'stone'])
    assert.strictEqual((await held).name, 'stone')
    client.clearSent()
    await bot._syncWindow(bot.inventory)
    assert.strictEqual(client.written.length, 0)
  })

  it('internalTest › activateItem rotation', async () => {
    const { bot, client, clock } = await joined()
    const testYaw = 1.5
    const testPitch = -0.3
    bot.entity.yaw = testYaw
    bot.entity.pitch = testPitch
    client.clearSent()
    bot.activateItem()
    assert.strictEqual(bot.usingHeldItem, true)
    const [packet] = client.sent('inventory_transaction')
    const data = packet.transaction.transaction_data
    assert.deepStrictEqual([packet.transaction.transaction_type, data.action_type, data.hand, data.hotbar_slot], ['item_use', 'click_air', 'main_hand', 0])
    assert.ok(Math.abs(data.player_pos.y - (bot.entity.position.y + 1.62)) < 1e-6, 'eye-level player position')
    // Bedrock's use transaction has no rotation: it travels in the same tick's player_auth_input
    clock.advance(50)
    bot._bedrock.input.pump()
    const input = client.sent('player_auth_input').at(-1)
    assert.ok(Math.abs(input.yaw - toNotchianYaw(testYaw)) < 0.001, `Expected yaw ${toNotchianYaw(testYaw)}, got ${input.yaw}`)
    assert.ok(Math.abs(input.pitch - toNotchianPitch(testPitch)) < 0.001, `Expected pitch ${toNotchianPitch(testPitch)}, got ${input.pitch}`)
    bot.deactivateItem()
    assert.strictEqual(bot.usingHeldItem, false)
    assert.strictEqual(client.sent('inventory_transaction').at(-1).transaction.transaction_type, 'item_release')
  })

  it('consume: completed_using_item finishes it; off-hand use carries the off-hand item; the shield sneaks', async () => {
    const { bot, client } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['golden_apple', 2] }, { firstStackId: 400 }))
    client.receive('inventory_content', inventoryContent(bot, { 0: ['shield', 1] }, { window: 'offhand', size: 1, firstStackId: 401 }))
    const eating = bot.consume()
    assert.strictEqual(bot.usingHeldItem, true)
    await tick()
    client.receive('completed_using_item', { used_item_id: bot.registry.itemsByName.golden_apple.id, use_method: 'eat' })
    await eating
    assert.strictEqual(bot.usingHeldItem, false)
    // a heldItemChanged with another count also ends it (upstream)
    const second = bot.consume()
    client.receive('inventory_slot', { window_id: 'inventory', slot: 0, item: wireItem(bot, 'golden_apple', 1, 402) })
    await second
    client.clearSent()
    bot.activateItem(true)
    assert.strictEqual(client.sent('inventory_transaction').length, 0, 'a shield is not "used" on Bedrock')
    assert.strictEqual(bot.getControlState('sneak'), true)
    bot.deactivateItem()
    assert.strictEqual(bot.getControlState('sneak'), false)
    client.receive('inventory_content', inventoryContent(bot, { 0: ['snowball', 4] }, { window: 'offhand', size: 1, firstStackId: 403 }))
    bot.activateItem(true)
    const data = client.sent('inventory_transaction').at(-1).transaction.transaction_data
    assert.strictEqual(data.hand, 'off_hand')
    assert.strictEqual(data.held_item.stack_id, 403)
    // food is full in survival → upstream's error
    bot.game.gameMode = 'survival'
    client.receive('inventory_content', inventoryContent(bot, { 0: ['bread', 2] }, { firstStackId: 404 }))
    await assert.rejects(bot.consume(), /Food is full/)
  })
})
