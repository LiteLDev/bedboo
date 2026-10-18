// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/consume.js. Bedrock: eating is one item_use click_air; after the
 * 32-tick use the server sends completed_using_item (Java: entity_status 9), then the shrunk stack.
 * The hunger is drained with `/effect @s hunger 1 255` (Bedrock syntax, feature effectAreNotPrefixed) and the
 * loop waits for U9's `health` event, so the part after "Food is full" needs U9's health plugin (skipped until
 * then). The golden-apple test is a Bedrock extra that needs no hunger (always consumable).
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, implemented } = require('./common')

describe('consume', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('consume', async function () {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.bread.id, 1, 0))
    await bot.test.becomeSurvival()
    // Cannot consume if bot.food === 20
    await assert.rejects(bot.consume, (err) => {
      if (!err) {
        // log the conditions that made this not throw
        console.log({ a: bot.game.gameMode !== 'creative', b: !['potion', 'milk_bucket', 'enchanted_golden_apple', 'golden_apple'].includes(bot.heldItem.name), c: bot.food === 20 })
      }
      assert.notStrictEqual(err, undefined)
      return true
    })

    // bot.food / the 'health' event come from U9's health plugin (a static stub before it lands)
    if (!implemented(bot.respawn)) this.skip()

    await bot.test.becomeSurvival()

    // Drain a little hunger so consuming is legal, waiting on the food update
    // instead of polling on a fixed sleep. One bread is enough to show the
    // consume state transitions; eating back to 20 re-runs the identical path.
    while (bot.food === 20) {
      if (bot.supportFeature('effectAreNotPrefixed')) bot.test.sayEverywhere('/effect @s hunger 1 255')
      else if (bot.supportFeature('effectAreMinecraftPrefixed')) bot.test.sayEverywhere(`/effect ${bot.username} minecraft:hunger 1 255`)
      await onceWithCleanup(bot, 'health', { timeout: 5000 })
    }

    assert.ok(!bot.usingHeldItem)
    const consume = bot.consume()
    assert.ok(bot.usingHeldItem)
    await consume
    assert.ok(!bot.usingHeldItem)
  })

  it('consume a golden apple at full hunger: completed_using_item, the stack shrinks (Bedrock extra)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.golden_apple.id, 2, 0))
    bot.setQuickBarSlot(0)
    await bot.test.becomeSurvival()
    const completed = bot.test.ctx.packet('completed_using_item', () => true, 5000)
    const shrunk = onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.count === 1 })
    assert.ok(!bot.usingHeldItem)
    const consume = bot.consume()
    assert.ok(bot.usingHeldItem)
    await consume
    assert.ok(!bot.usingHeldItem)
    const packet = await completed.promise
    assert.strictEqual(packet.use_method, 'eat')
    await shrunk
    assert.strictEqual(bot.heldItem.count, 1)
  })
})
