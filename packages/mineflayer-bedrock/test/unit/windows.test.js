'use strict'
// owner: U8 (inventory, windows, creative & item use) — the window registry (lib/bedrock/windows.js), every slot
// map (lib/bedrock/slots.js), container_open → windows, and the internalTest window analogs
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick } = require('./helpers/inventory_server')
const { createWindowRegistry, windowKey, CONTAINER_SPECS, slotMapOf, javaTypeOf, containerSize } = require('../../lib/bedrock/windows')
const slots = require('../../lib/bedrock/slots')
const { normalizeAction } = require('../../lib/bedrock/stack_request')

let serializer
function serialize (name, params) {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = serializer ?? createSerializer('1.26.51')
  return serializer.createPacketBuffer({ name, params })
}

/** a Java-layout window for `key` as the inventory plugin builds it */
function windowFor (bot, key, size) {
  const spec = bot._bedrock.windows.get(key)
  return bot._bedrock.inventoryModel.createWindow({ key, spec, id: 7, rawId: 7, windowType: key, size: containerSize(spec, size) })
}

const ALL_TYPES = ['inventory', 'container', 'chest', 'trapped_chest', 'copper_chest', 'ender_chest', 'barrel', 'shulker_box',
  'minecart_chest', 'chest_boat', 'dispenser', 'dropper', 'hopper', 'minecart_hopper', 'crafter', 'furnace', 'blast_furnace',
  'smoker', 'brewing_stand', 'workbench', 'enchantment', 'anvil', 'grindstone', 'stonecutter', 'loom', 'cartography',
  'smithing_table', 'beacon', 'trading', 'horse', 'lectern']

describe('windows: registry and slot maps (U8)', function () {
  this.timeout(30000)

  it('the registry holds every Bedrock container type; register/get/has/types', () => {
    const registry = createWindowRegistry()
    assert.deepStrictEqual(registry.types().sort(), [...ALL_TYPES].sort())
    for (const type of ALL_TYPES) assert.ok(registry.has(type) && registry.get(type).javaType, type)
    assert.throws(() => registry.register('x', {}), /needs a javaType/)
    registry.register('furnace', { javaType: 'minecraft:furnace', slotMap: [] })
    assert.deepStrictEqual(registry.get('furnace').slotMap, [], 'a later unit may refine a spec')
    assert.strictEqual(registry.get('nope'), undefined)
  })

  it('Java layouts equal prismarine-windows\' Java 1.21 windows (smithing: the 1.20+ 4-slot layout)', () => {
    const java = require('prismarine-windows')('1.21.1')
    for (const [key, spec] of Object.entries(CONTAINER_SPECS)) {
      if (key === 'inventory' || key === 'horse') continue
      const size = containerSize(spec, spec.size ?? (key === 'container' || key.endsWith('chest') ? 27 : null))
      const type = javaTypeOf(spec, size)
      const ref = java.createWindow(1, type, 't')
      assert.ok(ref, `${key}: ${type} is a Java window type`)
      if (type === 'minecraft:smithing') {
        assert.deepStrictEqual([size, spec.craftingResultSlot], [4, 3], 'template, base, addition, result')
        continue
      }
      assert.strictEqual(size + 36, ref.slots.length, `${key} slots`)
      assert.strictEqual(size, ref.inventoryStart, `${key} inventoryStart`)
      assert.strictEqual(spec.craftingResultSlot, ref.craftingResultSlot, `${key} craftingResultSlot`)
    }
    assert.strictEqual(javaTypeOf(CONTAINER_SPECS.chest, 54), 'minecraft:generic_9x6')
    assert.strictEqual(javaTypeOf(CONTAINER_SPECS.chest, 27), 'minecraft:generic_9x3')
    assert.strictEqual(slotMapOf(CONTAINER_SPECS.horse, 17).length, 17)
  })

  it('every slot map address is a valid StackRequestSlotInfo (bedrock-protocol ContainerSlotType names)', () => {
    for (const [key, spec] of Object.entries(CONTAINER_SPECS)) {
      const map = slotMapOf(spec, containerSize(spec, 27))
      for (const ref of map) {
        if (!ref) continue
        const action = normalizeAction({ type_id: 'take', count: 1, source: { slot_type: { container_id: ref.container_id }, slot: ref.slot, stack_id: 1 }, destination: { slot_type: { container_id: 'cursor' }, slot: 0, stack_id: 0 } })
        assert.ok(serialize('item_stack_request', { requests: [{ request_id: -1, actions: [action], custom_names: [], cause: -1 }] }).length > 0, `${key} ${ref.container_id}`)
      }
    }
  })

  it('windowKey: window_type, and for `container` the block / entity', () => {
    const open = (type) => ({ window_type: type })
    assert.strictEqual(windowKey(open('furnace')), 'furnace')
    assert.strictEqual(windowKey(open('workbench')), 'workbench')
    assert.strictEqual(windowKey(open('container'), { blockName: 'chest' }), 'chest')
    assert.strictEqual(windowKey(open('container'), { blockName: 'minecraft:barrel' }), 'barrel')
    assert.strictEqual(windowKey(open('container'), { blockName: 'red_shulker_box' }), 'shulker_box')
    assert.strictEqual(windowKey(open('container'), { blockName: 'undyed_shulker_box' }), 'shulker_box')
    assert.strictEqual(windowKey(open('container'), { blockName: 'waxed_copper_chest' }), 'copper_chest')
    assert.strictEqual(windowKey(open('container'), { blockName: 'ender_chest' }), 'ender_chest')
    assert.strictEqual(windowKey(open('container'), { entityName: 'chest_minecart' }), 'minecart_chest')
    assert.strictEqual(windowKey(open('container'), { entityName: 'oak_chest_boat' }), 'chest_boat')
    assert.strictEqual(windowKey(open('container'), {}), 'container')
  })

  it('player inventory: every Java slot ↔ Bedrock container slot (offhand on the wire is slot 1)', async () => {
    const { bot } = await createFakeBot()
    const inv = bot.inventory
    assert.strictEqual(inv.slots.length, 46)
    assert.deepStrictEqual([inv.inventoryStart, inv.inventoryEnd, inv.hotbarStart, inv.craftingResultSlot], [9, 45, 36, 0])
    const expected = {
      0: ['creative_output', 50],
      1: ['crafting_input', 28],
      4: ['crafting_input', 31],
      5: ['armor', 0],
      8: ['armor', 3],
      9: ['inventory', 9],
      35: ['inventory', 35],
      36: ['hotbar', 0],
      44: ['hotbar', 8],
      45: ['offhand', 1]
    }
    for (const [java, [container, slot]] of Object.entries(expected)) {
      const r = slots.resolve(inv, Number(java))
      assert.deepStrictEqual([r.container_id, r.slot, r.stack_network_id], [container, slot, 0], `java ${java}`)
    }
    for (let j = 5; j <= 45; j++) {
      const r = slots.resolve(inv, j)
      assert.strictEqual(slots.toJava(inv, r.container_id, r.slot), j, `inverse of ${j}`)
    }
    assert.strictEqual(slots.toJava(inv, 'hotbar_and_inventory', 3), 39)
    assert.strictEqual(slots.toJava(inv, 'hotbar_and_inventory', 20), 20)
    assert.strictEqual(slots.toJava(inv, 'offhand', 0), 45, 'content index 0 is the off-hand too')
    assert.strictEqual(slots.toJava(inv, 'cursor', 0), 'cursor')
    assert.strictEqual(slots.resolve(inv, -999), null)
    assert.deepStrictEqual(slots.resolve(inv, 'cursor'), { container_id: 'cursor', slot: 0, stack_network_id: 0 })
  })

  it('container windows: container part from the slot map, then 27 main + 9 hotbar; contents and ui slots map back', async () => {
    const { bot } = await createFakeBot()
    for (const key of ALL_TYPES.filter(k => k !== 'inventory')) {
      const w = windowFor(bot, key, 27)
      const map = w.bedrock.slotMap
      for (let j = 0; j < w.slots.length; j++) {
        const r = slots.resolve(w, j)
        if (j < w.inventoryStart) {
          if (!map[j]) { assert.strictEqual(r, null, `${key} ${j} unaddressable`); continue }
          assert.deepStrictEqual([r.container_id, r.slot], [map[j].container_id, map[j].slot], `${key} ${j}`)
          if (r.container_id !== 'creative_output') assert.strictEqual(slots.toJava(w, r.container_id, r.slot), j, `${key} inverse ${j}`)
          if (map[j].content !== null && map[j].content !== undefined) assert.strictEqual(slots.contentToJava(w, map[j].content), j)
          if (map[j].ui) assert.strictEqual(slots.uiToJava(w, map[j].slot), j)
        } else {
          const offset = j - w.inventoryStart
          const expected = offset < 27 ? ['inventory', offset + 9] : ['hotbar', offset - 27]
          assert.deepStrictEqual([r.container_id, r.slot], expected, `${key} player ${j}`)
          assert.strictEqual(slots.toJava(w, r.container_id, r.slot), j)
        }
      }
    }
    // brewing stand: Java 0-2 bottles / 3 ingredient / 4 fuel ↔ Bedrock content 1-3 / 0 / 4
    const brewing = windowFor(bot, 'brewing_stand')
    assert.deepStrictEqual([0, 1, 2, 3, 4].map(i => slots.contentToJava(brewing, i)), [3, 0, 1, 2, 4])
    // anvil: ui 1/2 = input/material, the result is the created output
    const anvil = windowFor(bot, 'anvil')
    assert.deepStrictEqual([slots.uiToJava(anvil, 1), slots.uiToJava(anvil, 2), slots.resolve(anvil, 2).container_id], [0, 1, 'creative_output'])
    // crafting table grid = ui 32-40
    const table = windowFor(bot, 'workbench')
    assert.deepStrictEqual([slots.resolve(table, 1).slot, slots.resolve(table, 9).slot], [32, 40])
  })
})

describe('windows: container_open → windowOpen / windowClose (U8)', function () {
  this.timeout(30000)

  async function joined () {
    const created = await createFakeBot()
    await replayJoin(created.bot, created.client)
    created.server = serveInventory(created.bot, created.client)
    return created
  }

  it('container_open + inventory_content → a generic_9x3 window with the contents and the player part; close', async () => {
    const { bot, client } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 5], 12: ['dirt', 3] }))
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 4, window_type: 'container', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    assert.strictEqual(bot.currentWindow, null, 'waits for the contents like upstream waits for window_items')
    client.receive('inventory_content', { window_id: 4, input: [wireItem(bot, 'bone', 2, 90), ...Array(26).fill(wireItem(bot, null))], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const window = await opened
    assert.strictEqual(bot.currentWindow, window)
    assert.deepStrictEqual([window.id, window.type, window.slots.length, window.inventoryStart], [4, 'minecraft:generic_9x3', 63, 27])
    assert.strictEqual(window.slots[0].name, 'bone')
    assert.strictEqual(window.slots[0].stackId, 90)
    assert.strictEqual(window.slots[window.hotbarStart].name, 'stone', 'hotbar 0 → last 9 slots')
    assert.strictEqual(window.slots[27 + 3].name, 'dirt', 'main 12 → 27 + 3')
    assert.strictEqual(typeof window.deposit, 'function')
    assert.strictEqual(typeof window.withdraw, 'function')
    // a player inventory update reaches both views
    client.receive('inventory_slot', { window_id: 'inventory', slot: 1, item: wireItem(bot, 'apple', 4, 91) })
    assert.strictEqual(bot.inventory.slots[37].name, 'apple')
    assert.strictEqual(window.slots[window.hotbarStart + 1].name, 'apple')
    assert.notStrictEqual(window.slots[window.hotbarStart + 1], bot.inventory.slots[37], 'each window has its own Item objects')
    const closed = new Promise(resolve => bot.once('windowClose', resolve))
    const windowClosed = new Promise(resolve => window.once('close', resolve))
    client.clearSent()
    const done = window.close()
    assert.strictEqual(await closed, window)
    await windowClosed
    await done
    assert.strictEqual(bot.currentWindow, null)
    assert.deepStrictEqual(client.sent('container_close'), [{ window_id: 4, window_type: 'container', server: false }])
  })

  it('internalTest › game › closeWindow sends container_close only', async () => {
    const { bot, client } = await joined()
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 9, window_type: 'dispenser', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 9, input: Array(9).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const window = await opened
    assert.strictEqual(window.type, 'minecraft:generic_3x3')
    client.clearSent()
    await bot.closeWindow(window)
    // the pre-1.17 Java no-op click does not exist on Bedrock: only the close (no item_stack_request)
    assert.deepStrictEqual(client.written.map(([, name]) => name), ['container_close'])
  })

  it('internalTest › windows › early inventory_content for a reused window id', async () => {
    const { bot, client } = await joined()
    // window 5 opens and closes
    let opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 5, window_type: 'container', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 5, input: [wireItem(bot, 'stone', 1, 50), ...Array(26).fill(wireItem(bot, null))], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const first = await opened
    await bot.closeWindow(first)
    // the next window reuses id 5 and its contents arrive BEFORE its container_open
    client.receive('inventory_content', { window_id: 5, input: [wireItem(bot, 'diamond', 7, 51), ...Array(26).fill(wireItem(bot, null))], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 5, window_type: 'container', coordinates: { x: 2, y: -60, z: 0 }, runtime_entity_id: -1n })
    const second = await opened
    assert.notStrictEqual(second, first)
    assert.strictEqual(second.slots[0].name, 'diamond')
    assert.strictEqual(second.slots[0].count, 7)
  })

  it('internalTest › windows › trailing player inventory sync after close', async () => {
    const { bot, client } = await joined()
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 6, window_type: 'container', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 6, input: Array(27).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const window = await opened
    await bot.closeWindow(window)
    // Bedrock syncs the player inventory as its own container: a trailing update after the close reaches bot.inventory
    client.receive('inventory_content', inventoryContent(bot, { 4: ['bone', 3] }))
    assert.strictEqual(bot.inventory.slots[40].name, 'bone')
    client.receive('inventory_slot', { window_id: 'inventory', slot: 20, item: wireItem(bot, 'stick', 2, 70) })
    assert.strictEqual(bot.inventory.slots[20].name, 'stick')
    // and a stale update for the closed window id does not resurrect it
    client.receive('inventory_slot', { window_id: 6, slot: 0, item: wireItem(bot, 'stone', 1, 71) })
    assert.strictEqual(bot.currentWindow, null)
  })

  it('a server-initiated container_close emits windowClose; workbench (ui-only) windows open at once', async () => {
    const { bot, client } = await joined()
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 8, window_type: 'workbench', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    const window = await opened
    assert.deepStrictEqual([window.type, window.slots.length, window.craftingResultSlot], ['minecraft:crafting', 46, 0])
    // grid contents live in the ui container (window 124, slots 32-40)
    client.receive('inventory_slot', { window_id: 'ui', slot: 33, item: wireItem(bot, 'oak_planks', 2, 80) })
    assert.strictEqual(window.slots[2].name, 'oak_planks')
    const closed = new Promise(resolve => bot.once('windowClose', resolve))
    client.receive('container_close', { window_id: 8, window_type: 'none', server: true })
    assert.strictEqual(await closed, window)
    assert.strictEqual(bot.currentWindow, null)
  })

  it('closeWindow: like upstream, currentWindow is cleared and windowClose fires at once; items go back before container_close', async () => {
    const { bot, client, server } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['oak_planks', 4] }))
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 8, window_type: 'workbench', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    const table = await opened
    await bot.clickWindow(table.hotbarStart, 0, 0)
    await bot.clickWindow(1, 1, 0) // one plank in the grid, three on the cursor
    let closedEvent = null
    bot.once('windowClose', (w) => { closedEvent = w })
    client.clearSent()
    const done = table.close()
    assert.strictEqual(bot.currentWindow, null, 'synchronously, like upstream')
    assert.strictEqual(closedEvent, table)
    await done
    assert.deepStrictEqual(client.written.map(([, n]) => n), ['item_stack_request', 'container_close'])
    const actions = server.requests.at(-1).actions
    assert.deepStrictEqual(actions.map(a => [a.type_id, a.count, a.source.slot_type.container_id, a.source.slot]), [['place', 3, 'cursor', 0], ['place', 1, 'crafting_input', 32]])
    assert.strictEqual(bot.inventory.slots[36]?.count, 4)
  })

  it('container_open of an entity container: runtime_entity_id is the entity UNIQUE id (chest minecart)', async () => {
    const { bot, client } = await joined()
    bot._bedrock.ids.trackEntity(55n, -123n)
    bot.entities[55] = { id: 55, name: 'chest_minecart', position: new Vec3(1, -60, 0) }
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 9, window_type: 'container', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -123n })
    client.receive('inventory_content', { window_id: 9, input: Array(27).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const window = await opened
    assert.deepStrictEqual([window.bedrock.key, window.title, window.bedrock.entityUniqueId], ['minecart_chest', 'Minecart with Chest', -123n])
  })

  it('openBlock rejects at once when activating the block fails (no 20 s wait)', async () => {
    const { bot } = await joined()
    bot.activateBlock = async () => { throw new Error('boom') }
    const started = Date.now()
    await assert.rejects(bot.openBlock({ position: new Vec3(1, -60, 0) }), /boom/)
    assert.ok(Date.now() - started < 1000)
  })

  it('openContainer(block): container types by block name, the Bedrock shulker/copper names are accepted', async () => {
    const { bot, client, clock } = await joined()
    const Block = require('prismarine-block')(bot.registry)
    /** drive the manual tick clock (lookAt resolves once the next player_auth_input is sent) until `predicate` */
    async function until (predicate) {
      for (let i = 0; i < 50 && !predicate(); i++) {
        await tick()
        clock.advance(50)
        bot._bedrock.input.pump()
      }
      assert.ok(predicate(), 'condition not reached')
    }
    const pos = new Vec3(1, -60, 0)
    for (const [name, windowType, size, javaType] of [['chest', 'container', 27, 'minecraft:generic_9x3'], ['barrel', 'container', 27, 'minecraft:generic_9x3'], ['undyed_shulker_box', 'container', 27, 'minecraft:shulker_box'], ['hopper', 'hopper', 5, 'minecraft:hopper']]) {
      const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
      block.position = pos
      bot.world.setBlock(pos, block)
      client.clearSent()
      const opening = bot.openContainer(block)
      await until(() => client.sent('inventory_transaction').length > 0)
      const click = client.sent('inventory_transaction').at(-1)
      assert.strictEqual(click.transaction.transaction_data.action_type, 'click_block')
      assert.deepStrictEqual(click.transaction.transaction_data.block_position, { x: 1, y: -60, z: 0 })
      client.receive('container_open', { window_id: 3, window_type: windowType, coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
      client.receive('inventory_content', { window_id: 3, input: Array(size).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
      const window = await opening
      assert.strictEqual(window.type, javaType, name)
      assert.strictEqual(window.bedrock.slotMap[0].container_id, { barrel: 'barrel', undyed_shulker_box: 'shulker' }[name] ?? 'container')
      await window.close()
    }
  })
})
