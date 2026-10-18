// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/heldItem.js (verbatim body; the upstream assertion
 * `bot.heldItem.id === bot.stoneId` compares two undefined values, so the item type is asserted too).
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('heldItem', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('heldItem', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    await bot.test.becomeCreative()
    await bot.test.clearInventory()
    await bot.test.wait(100)
    assert.equal(bot.heldItem, null)

    const stoneId = bot.registry.itemsByName.stone.id
    await bot.test.setInventorySlot(36, new Item(stoneId, 1))
    assert.strictEqual(bot.heldItem.id, bot.stoneId)
    assert.strictEqual(bot.heldItem.type, stoneId)

    await bot.tossStack(bot.heldItem)
    assert.equal(bot.heldItem, null)
  })
})
