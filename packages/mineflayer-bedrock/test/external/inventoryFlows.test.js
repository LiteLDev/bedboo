// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Bedrock extra: the flows of mineflayer's examples/inventory.js (exampleInventory: list, equip off-hand / hand /
 * feet, toss, unequip — the crafting step is U12's) and every simple_inventory / inventory member that has no
 * upstream test of its own (getEquipmentDestSlot, simpleClick, putAway, moveSlotItem, transfer, updateHeldItem,
 * clickWindow modes 1/2/4, closeWindow(bot.inventory), the rejection error), each checked against the server's
 * raw inventory packets.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('inventoryFlows', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  /** the server's view of the inventory (raw packets) after a console no-op that resends it */
  async function serverInventory (bot) {
    // `replaceitem … keep` never replaces an occupied slot, but BDS resends every inventory window
    const raw = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'offhand', 10000)
    await bot.test.ctx.consoleOutput(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 8 keep air`)
    await raw.promise
    return bot.test.rawInventory()
  }
  const names = (window) => window.slots.map((it, i) => it ? `${i}:${it.name}x${it.count}` : null).filter(Boolean)
  const list = (bot) => bot.inventory.items().map(it => `${it.name} x ${it.count}`).join(', ')

  it('exampleInventory flows: list, equip off-hand / hand, toss, equip feet, toss, unequip', async () => {
    const { bot } = ctx
    // the example's starting inventory (console /give, like the upstream test) + arrows: Bedrock's off-hand only
    // takes off-hand items (arrows, shields, totems, …), so the example's "equip off-hand dirt" uses arrows
    await bot.test.give('dirt', 64)
    await bot.test.give('stick', 7)
    await bot.test.give('iron_ore', 64)
    await bot.test.give('diamond_boots', 1)
    await bot.test.give('arrow', 16)
    await bot.test.becomeSurvival()
    assert.strictEqual(list(bot), 'dirt x 64, stick x 7, iron_ore x 64, diamond_boots x 1, arrow x 16')

    const item = (name) => bot.inventory.items().find(it => it.name === name)
    await bot.equip(item('arrow'), 'off-hand')
    assert.strictEqual(bot.inventory.slots[45]?.name, 'arrow')
    assert.strictEqual(list(bot), 'dirt x 64, stick x 7, iron_ore x 64, diamond_boots x 1')

    await bot.equip(item('dirt'), 'hand')
    assert.strictEqual(bot.heldItem?.name, 'dirt')
    await bot.toss(bot.registry.itemsByName.dirt.id, null, 64)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.dirt.id), 0)

    await bot.equip(item('diamond_boots'), 'feet')
    assert.strictEqual(bot.inventory.slots[bot.getEquipmentDestSlot('feet')]?.name, 'diamond_boots')
    assert.strictEqual(bot.entity.equipment[2]?.name, 'diamond_boots')
    await bot.tossStack(item('iron_ore'))
    await bot.unequip('feet')
    assert.strictEqual(bot.inventory.slots[8], null)
    // Java InventoryMenu: an armor slot shift-clicks into the first free slot of 9..44 (main inventory first)
    assert.strictEqual(bot.inventory.slots[9]?.name, 'diamond_boots')
    assert.strictEqual(list(bot), 'diamond_boots x 1, stick x 7')

    const server = await serverInventory(bot)
    assert.deepStrictEqual(server.armor.slice(0, 4).map(i => i?.name ?? null), [null, null, null, null])
    assert.strictEqual(server.offhand[0]?.name, 'arrow')
    assert.deepStrictEqual(server.inventory.filter(Boolean).map(i => `${i.name} x ${i.count}`).sort(), ['diamond_boots x 1', 'stick x 7'])
  })

  it('getEquipmentDestSlot, setQuickBarSlot / equip(hand) from the main inventory, unequip(hand)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    assert.deepStrictEqual(['head', 'torso', 'legs', 'feet', 'off-hand'].map(d => bot.getEquipmentDestSlot(d)), [5, 6, 7, 8, 45])
    bot.setQuickBarSlot(3)
    assert.strictEqual(bot.getEquipmentDestSlot('hand'), 39)
    assert.throws(() => bot.getEquipmentDestSlot('tail'), /invalid destination/)
    await bot.test.setInventorySlot(20, new Item(bot.registry.itemsByName.iron_pickaxe.id, 1, 0))
    await bot.equip(bot.inventory.slots[20], 'hand')
    assert.strictEqual(bot.heldItem?.name, 'iron_pickaxe')
    assert.strictEqual(bot.inventory.slots[20], null)
    await bot.unequip('hand')
    assert.strictEqual(bot.heldItem, null)
    bot.setQuickBarSlot(0)
  })

  it('simpleClick, putAway, moveSlotItem, transfer, updateHeldItem', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.cobblestone.id, 10, 0))
    await bot.simpleClick.rightMouse(36) // take half (5)
    assert.strictEqual(bot.inventory.selectedItem?.count, 5)
    await bot.simpleClick.leftMouse(12)
    assert.strictEqual(bot.inventory.slots[12]?.count, 5)
    await bot.putAway(12) // shift click main → hotbar: merges into slot 36
    assert.strictEqual(bot.inventory.slots[36]?.count, 10)
    assert.strictEqual(bot.inventory.slots[12], null)
    await bot.moveSlotItem(36, 30)
    assert.strictEqual(bot.inventory.slots[30]?.count, 10)
    await bot.transfer({ window: bot.inventory, itemType: bot.registry.itemsByName.cobblestone.id, metadata: null, count: 3, sourceStart: 9, sourceEnd: 36, destStart: 36, destEnd: 45 })
    assert.strictEqual(bot.inventory.slots[36]?.count, 3)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.cobblestone.id), 10)
    const changed = onceWithCleanup(bot, 'heldItemChanged', { timeout: 1000 })
    bot.updateHeldItem()
    const [held] = await changed
    assert.strictEqual(held?.count, 3)
    const server = await serverInventory(bot)
    assert.strictEqual(server.inventory[0]?.count, 3)
    assert.strictEqual(server.inventory.filter(Boolean).reduce((n, i) => n + i.count, 0), 10)
  })

  it('clickWindow modes: number key swap (2), drop key (4), shift click armor (1); closeWindow(bot.inventory)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(15, new Item(bot.registry.itemsByName.gold_ingot.id, 6, 0))
    await bot.test.setInventorySlot(37, new Item(bot.registry.itemsByName.iron_helmet.id, 1, 0))
    await bot.clickWindow(15, 3, 2) // swap slot 15 with hotbar 3 (empty)
    assert.strictEqual(bot.inventory.slots[39]?.name, 'gold_ingot')
    assert.strictEqual(bot.inventory.slots[15], null)
    await bot.clickWindow(39, 1, 2) // swap hotbar 3 with hotbar 1 (helmet)
    assert.strictEqual(bot.inventory.slots[37]?.name, 'gold_ingot')
    assert.strictEqual(bot.inventory.slots[39]?.name, 'iron_helmet')
    await bot.clickWindow(37, 0, 4) // drop one
    assert.strictEqual(bot.inventory.slots[37]?.count, 5)
    await bot.clickWindow(37, 1, 4) // drop the stack
    assert.strictEqual(bot.inventory.slots[37], null)
    await bot.clickWindow(39, 0, 1) // shift click an armor piece: equips it
    assert.strictEqual(bot.inventory.slots[5]?.name, 'iron_helmet')
    await bot.clickWindow(5, 0, 1) // and back into the inventory
    assert.strictEqual(bot.inventory.slots[5], null)
    assert.ok(bot.inventory.items().some(i => i.name === 'iron_helmet'))
    // an item left on the cursor goes back when the inventory closes
    await bot.clickWindow(bot.inventory.items()[0].slot, 0, 0)
    assert.ok(bot.inventory.selectedItem)
    await bot.closeWindow(bot.inventory)
    assert.strictEqual(bot.inventory.selectedItem, null)
    assert.ok(bot.inventory.items().some(i => i.name === 'iron_helmet'))
    const server = await serverInventory(bot)
    assert.deepStrictEqual(server.inventory.filter(Boolean).map(i => i.name), ['iron_helmet'])
    assert.strictEqual(server.ui[0], null, 'cursor empty server side')
  })

  it('a click the server rejects throws and is rolled back', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 3, 0))
    const before = names(bot.inventory)
    // dirt cannot go into the off-hand on Bedrock (Java allows any item there)
    await bot.clickWindow(36, 0, 0)
    await assert.rejects(bot.clickWindow(45, 0, 0), /Server rejected transaction for clicking on slot 45, on window with id 0\./)
    assert.strictEqual(bot.inventory.slots[45], null, 'rolled back')
    assert.strictEqual(bot.inventory.selectedItem?.name, 'dirt')
    await bot.clickWindow(36, 0, 0)
    assert.deepStrictEqual(names(bot.inventory), before)
  })
})
