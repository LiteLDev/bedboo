// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/heldItemChanged.js (verbatim) plus Bedrock extras: the server
 * forcing the hotbar selection (player_hotbar) and bot.setQuickBarSlot (mob_equipment) emit heldItemChanged.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('heldItemChanged', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('heldItemChanged', async () => {
    const { bot } = ctx
    await bot.test.becomeCreative()
    await bot.test.clearInventory()
    await bot.test.wait(100)

    // Give the bot a stone in the held slot (slot 36 = first hotbar slot)
    const stoneId = bot.registry.itemsByName.stone.id
    const diamondId = bot.registry.itemsByName.diamond.id

    // Put stone in the current held slot
    await bot.test.setInventorySlot(bot.quickBarSlot + bot.inventory.hotbarStart, new (require('prismarine-item')(bot.registry))(stoneId, 1))
    await bot.test.wait(100)
    assert.strictEqual(bot.heldItem.type, stoneId, 'should be holding stone')

    // Now change the held slot contents to diamond and verify heldItemChanged fires
    const heldItemPromise = onceWithCleanup(bot, 'heldItemChanged', {
      timeout: 5000
    })
    await bot.test.setInventorySlot(bot.quickBarSlot + bot.inventory.hotbarStart, new (require('prismarine-item')(bot.registry))(diamondId, 1))

    const [newItem] = await heldItemPromise
    assert(newItem, 'heldItemChanged should fire with the new item')
    assert.strictEqual(newItem.type, diamondId, 'new item should be diamond')
    assert.strictEqual(bot.heldItem.type, diamondId, 'bot.heldItem should reflect diamond')
  })

  it('setQuickBarSlot and a console /give into the held slot emit heldItemChanged (Bedrock: mob_equipment, inventory_content)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(38, new Item(bot.registry.itemsByName.dirt.id, 2))
    const changed = onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000 })
    bot.setQuickBarSlot(2)
    const [item] = await changed
    assert.strictEqual(item.name, 'dirt')
    assert.strictEqual(bot.quickBarSlot, 2)
    assert.strictEqual(bot.heldItem.name, 'dirt')
    // the server agrees: a /give lands in the first empty slot, and the player_hotbar echo keeps slot 2 selected
    const slot = onceWithCleanup(bot.inventory, 'updateSlot:36', { timeout: 5000 })
    await bot.test.give('stick', 1)
    await slot
    assert.strictEqual(bot.quickBarSlot, 2)
    // the held stack grows → heldItemChanged with the new count
    const grown = onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (it) => it?.count === 5 })
    await bot.test.awaitItemReceived('/replaceitem entity @s slot.hotbar 2 dirt 5')
    await grown
    bot.setQuickBarSlot(0)
  })
})
