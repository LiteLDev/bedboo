// owner: W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)
'use strict'
/**
 * Bedrock extra (W3-FIX-B), against a real BDS 1.26.51.1: `bot.activateItem()` with a bucket. BDS ignores the
 * click_air of buckets (and boats); like the vanilla client, the bot clicks the looked-at block or liquid instead
 * (U11's `bot._bedrock.placement.useOnLookedAtBlock`): a water bucket looking at the ground places water, an empty
 * bucket looking at water fills it.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('itemUse › activateItem with buckets (W3-FIX-B)', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('a water bucket looking at the ground places water; an empty bucket looking at the water fills it', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const gy = bot.test.groundY
    // a 1×1 pit in a glass floor, the bot on the glass next to it (the look line passes over the rim)
    const target = new Vec3(0, gy, 1)
    await bot.test.ctx.consoleOutput(`fill -1 ${gy} 0 1 ${gy} 2 glass`)
    for (let i = 0; i < 40 && bot.blockAt(target)?.name !== 'glass'; i++) await bot.test.wait(50) // the fill reached the bot
    await bot.test.setBlock({ x: 0, y: gy, z: 1, blockName: 'air' })
    await bot.test.teleport(new Vec3(0.5, gy + 1, 0.5))
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.water_bucket.id, 1, 0))
    bot.setQuickBarSlot(0)
    await bot.test.becomeSurvival()
    bot.creative.stopFlying()
    await bot.test.wait(500)
    // look at the bottom of the pit
    await bot.lookAt(new Vec3(0.5, gy, 1.5), true)
    await bot.waitForTicks(2)
    const placed = bot.test.botEvent('blockUpdate', (o, n) => n?.position.equals(target) && /water/.test(n.name), 10000)
    bot.activateItem()
    await placed.promise
    for (let i = 0; i < 40 && bot.heldItem?.name !== 'bucket'; i++) await bot.test.wait(50)
    assert.strictEqual(bot.heldItem?.name, 'bucket', 'the water left the bucket')
    // the empty bucket at the water source
    await bot.lookAt(new Vec3(0.5, gy + 0.5, 1.5), true)
    await bot.waitForTicks(2)
    const filled = bot.test.botEvent('blockUpdate', (o, n) => n?.position.equals(target) && n.name === 'air', 10000)
    bot.activateItem()
    await filled.promise
    for (let i = 0; i < 40 && bot.heldItem?.name !== 'water_bucket'; i++) await bot.test.wait(50)
    assert.strictEqual(bot.heldItem?.name, 'water_bucket', 'the bucket was filled')
    assert.strictEqual(bot.blockAt(target).name, 'air')
  })
})
