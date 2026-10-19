// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/activateItem.js. Bedrock: activateItem = item_use click_air;
 * the throw direction comes from the rotation of the same tick's player_auth_input (the transaction has no
 * rotation field). The verbatim test reads the snowball through U7's entitySpawn / entity velocity; the raw analog
 * reads the same thing from add_entity / set_entity_motion.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('activateItem', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('activateItem', async function () {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    await bot.test.becomeCreative()
    await bot.test.clearInventory()
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.snowball.id, 16, 0))
    await bot.test.becomeSurvival()
    await bot.test.wait(250)

    // Throw a snowball and return the velocity the server spawned it with.
    async function throwTowards (yaw) {
      await bot.look(yaw, 0, true)
      await bot.test.wait(250)
      const spawned = onceWithCleanup(bot, 'entitySpawn', { checkCondition: e => /snowball/i.test(e.name), timeout: 5000 })
      bot.activateItem()
      const [snowball] = await spawned
      // The velocity can arrive in its own packet right after the spawn.
      for (let i = 0; i < 40 && snowball.velocity.norm() === 0; i++) await bot.test.wait(50)
      return snowball.velocity
    }

    // yaw PI is notchian 0 (south, +z): the direction a server uses if rotation is dropped.
    const south = await throwTowards(Math.PI)
    assert(south.z > 0 && Math.abs(south.x) < Math.abs(south.z), `expected a southward throw, got ${south}`)

    // yaw 3PI/2 is notchian -90 (east, +x), so this only passes if the bot's rotation reached the server.
    const east = await throwTowards(Math.PI * 3 / 2)
    assert(east.x > 0 && Math.abs(east.z) < Math.abs(east.x), `expected an eastward throw, got ${east}`)

    await bot.test.becomeCreative()
    await bot.test.clearInventory()
  })

  it('activateItem throws snowballs in the look direction (raw add_entity analog)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.snowball.id, 16, 0))
    bot.setQuickBarSlot(0)
    await bot.test.becomeSurvival()
    await bot.test.wait(250)

    async function throwTowards (yaw) {
      await bot.look(yaw, 0, true)
      await bot.test.wait(250)
      const spawned = bot.test.ctx.packet('add_entity', (p) => /snowball/.test(p.entity_type), 5000)
      const count = bot.heldItem.count
      const shrunk = onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (it) => it?.count === count - 1 })
      bot.activateItem()
      const p = await spawned.promise
      await shrunk
      return new Vec3(p.velocity.x, p.velocity.y, p.velocity.z)
    }

    const south = await throwTowards(Math.PI)
    assert(south.z > 0 && Math.abs(south.x) < Math.abs(south.z), `expected a southward throw, got ${south}`)
    const east = await throwTowards(Math.PI * 3 / 2)
    assert(east.x > 0 && Math.abs(east.z) < Math.abs(east.x), `expected an eastward throw, got ${east}`)
    assert.strictEqual(bot.heldItem.count, 14)
    // a released use (deactivateItem) is an item_release transaction and clears usingHeldItem
    bot.deactivateItem()
    assert.strictEqual(bot.usingHeldItem, false)
  })

  it('activateItem(true) / deactivateItem with a shield: Bedrock blocks by sneaking', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(45, new Item(bot.registry.itemsByName.shield.id, 1, 0))
    bot.activateItem(true)
    assert.strictEqual(bot.usingHeldItem, true)
    assert.strictEqual(bot.getControlState('sneak'), true)
    bot.deactivateItem()
    assert.strictEqual(bot.usingHeldItem, false)
    assert.strictEqual(bot.getControlState('sneak'), false)
  })
})
