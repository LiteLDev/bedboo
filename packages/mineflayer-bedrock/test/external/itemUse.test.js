// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * Item use against BDS 1.26.51.1 (Bedrock extra, the plan's "bow / firework / snowball use"): projectiles through the
 * mineflayer API, observed through U7's entitySpawn / entity velocity.
 * - bow: activateItem (item_use click_air, the draw) … deactivateItem (item_release) → an `arrow` flying the look way,
 *   one arrow used, the bow worn;
 * - snowball: activateItem → a `snowball` flying the look way (like upstream's activateItem test, both directions);
 * - firework rocket: like Java, using it in the air while not gliding does nothing; activateBlock on the ground (the
 *   vanilla client's click on a block) launches a `fireworks_rocket` straight up.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('itemUse', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    await ctx.bot.test.becomeCreative()
    await ctx.bot.test.killAllEntities?.()
  })

  const give = (slot, name, count = 1) => ctx.bot.test.setInventorySlot(slot, new (require('prismarine-item')(ctx.bot.registry))(ctx.bot.registry.itemsByName[name].id, count, 0))
  async function survival () {
    await ctx.bot.test.becomeSurvival()
    ctx.bot.creative.stopFlying()
    await ctx.bot.test.wait(250)
  }

  /** the velocity the server gave the entity (it can come in its own packet right after the spawn) */
  async function launchVelocity (entity) {
    for (let i = 0; i < 40 && entity.velocity.norm() === 0; i++) await ctx.bot.test.wait(50)
    return entity.velocity.clone()
  }

  it('bow: activateItem draws, deactivateItem shoots an arrow the way the bot looks', async () => {
    const { bot } = ctx
    await give(36, 'bow')
    await give(9, 'arrow', 8)
    await survival()
    bot.setQuickBarSlot(0)
    await bot.look(Math.PI, 0, true) // south (+z)
    await bot.test.wait(250)
    const spawned = onceWithCleanup(bot, 'entitySpawn', { timeout: 5000, checkCondition: (e) => e.name === 'arrow' })
    bot.activateItem()
    assert.strictEqual(bot.usingHeldItem, true)
    await bot.test.wait(1100) // a full draw is 20 ticks
    bot.deactivateItem()
    assert.strictEqual(bot.usingHeldItem, false)
    const [arrow] = await spawned
    const v = await launchVelocity(arrow)
    assert.ok(v.z > 2 && Math.abs(v.x) < 0.5, `a fully drawn arrow flies south fast, got ${v}`)
    if (bot.inventory.count(bot.registry.itemsByName.arrow.id) !== 7) {
      await onceWithCleanup(bot.inventory, 'updateSlot', { timeout: 5000, checkCondition: () => bot.inventory.count(bot.registry.itemsByName.arrow.id) === 7 })
    }
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.arrow.id), 7)
    assert.strictEqual(bot.heldItem.durabilityUsed, 1, 'the bow wears')
  })

  it('snowball: activateItem throws one the way the bot looks (south, then east)', async () => {
    const { bot } = ctx
    await give(36, 'snowball', 4)
    await survival()
    bot.setQuickBarSlot(0)
    async function throwTowards (yaw) {
      await bot.look(yaw, 0, true)
      await bot.test.wait(250)
      const spawned = onceWithCleanup(bot, 'entitySpawn', { checkCondition: e => /snowball/i.test(e.name), timeout: 5000 })
      bot.activateItem()
      const [snowball] = await spawned
      return launchVelocity(snowball)
    }
    const south = await throwTowards(Math.PI)
    assert(south.z > 0 && Math.abs(south.x) < Math.abs(south.z), `expected a southward throw, got ${south}`)
    const east = await throwTowards(Math.PI * 3 / 2)
    assert(east.x > 0 && Math.abs(east.z) < Math.abs(east.x), `expected an eastward throw, got ${east}`)
    if (bot.heldItem?.count !== 2) await onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.count === 2 })
    assert.strictEqual(bot.heldItem.count, 2)
  })

  it('firework rocket: nothing in the air without gliding (like Java), activateBlock on the ground launches it', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await give(36, 'firework_rocket', 3)
    await survival()
    bot.setQuickBarSlot(0)
    const rockets = []
    const onSpawn = (e) => { if (e.name === 'fireworks_rocket') rockets.push(e) }
    bot.on('entitySpawn', onSpawn)
    try {
      bot.activateItem()
      await bot.test.wait(1000)
      bot.deactivateItem()
      assert.deepStrictEqual(rockets, [], 'no rocket from a use in the air')
      assert.strictEqual(bot.heldItem.count, 3)

      const launched = onceWithCleanup(bot, 'entitySpawn', { timeout: 5000, checkCondition: (e) => e.name === 'fireworks_rocket' })
      await bot.activateBlock(bot.blockAt(new Vec3(2, g - 1, 0)))
      const [rocket] = await launched
      assert.ok(rocket.position.distanceTo(new Vec3(2.5, g, 0.5)) < 1.5, `launched from the clicked block: ${rocket.position}`)
      // it rises (BDS spawns it nearly still, then moves it with move_entity packets)
      const start = rocket.position.y
      for (let i = 0; i < 30 && rocket.position.y < start + 1; i++) await bot.test.wait(50)
      assert.ok(rocket.position.y >= start + 1, `it flies up: ${start} → ${rocket.position.y}`)
      if (bot.heldItem?.count !== 2) await onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.count === 2 })
      assert.strictEqual(bot.heldItem.count, 2)
    } finally {
      bot.removeListener('entitySpawn', onSpawn)
    }
  })
})
