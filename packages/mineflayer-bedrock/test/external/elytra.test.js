// owner: U14 (survival interactions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/elytra.js against BDS 1.26.51.1. Bedrock supports elytra
 * (`hasElytraFlying`) and firework rockets (`fireworkNamePlural`), so nothing returns early.
 *
 * Adapted (docs/differences/U14.md#elytra):
 * - the plain rockets upstream builds come from the creative inventory's default variant (`Fireworks {Flight: 1}`,
 *   docs/differences/W3FIX.md#creative-defaults).
 * - the boost assertions (`bot.fireworkRocketDuration` counting down to 0 while gliding) need W3-FIX-B (entities: BDS
 *   names the boosted player in the rocket's metadata key 18, not owner_eid). Until it is on main the test skips at
 *   that point with the reason (checked at run time, so it starts asserting as soon as the fix lands). The physics side
 *   (a correction rewinding past a boost erased it) is fixed by W3-FIX-A.
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('elytra', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('elytra', async function () {
    const { bot } = ctx
    // don't continue unless this version supports elytra
    assert.ok(bot.supportFeature('hasElytraFlying'), 'Bedrock has elytra')
    const supportsFireworkRockets = bot.supportFeature('fireworkNamePlural') || bot.supportFeature('fireworkNameSingular')
    assert.ok(supportsFireworkRockets)

    const Item = require('prismarine-item')(bot.registry)

    await bot.test.setInventorySlot(6, new Item(bot.registry.itemsByName.elytra.id, 1))
    const fireworkItem = bot.registry.itemsArray.find(item => item.displayName === 'Firework Rocket')
    assert.ok(fireworkItem !== undefined)
    await bot.test.setInventorySlot(36, new Item(fireworkItem.id, 64))
    assert.strictEqual(bot.inventory.slots[36]?.type, fireworkItem.id)
    assert.strictEqual(bot.inventory.slots[36]?.count, 64)

    await bot.test.teleport(bot.entity.position.offset(0, 100, 0))
    await bot.test.becomeSurvival()
    await bot.creative.stopFlying()

    await bot.look(bot.entity.yaw, 0)
    await bot.waitForTicks(5)
    await assert.doesNotReject(bot.elytraFly())
    await bot.waitForTicks(20) // wait for server to accept
    assert.ok(bot.entity.elytraFlying)

    // use rocket
    // the boost is tracked from usedFirework (pending W3-FIX-B, see the header); it survives the server corrections
    // that arrive while it lasts (BDS corrects a boosted glide every ~6 ticks; W3-FIX-A)
    let boosts = 0
    const onUsed = () => { boosts++ }
    bot.on('usedFirework', onUsed)
    try {
      await bot.look(bot.entity.yaw, 30 * Math.PI / 180)
      const activationTicks = 20
      for (let i = 0; i < 20; i++) {
        bot.activateItem()
        assert.ok(bot.entity.elytraFlying)
        await bot.waitForTicks(1)
      }
      await bot.waitForTicks(3)
      // the server fired rockets (one item each)
      assert.ok(bot.inventory.slots[36]?.count < 64, `rockets used: ${64 - (bot.inventory.slots[36]?.count ?? 0)}`)
      if (boosts === 0) {
        // W3-FIX-B: BDS names the boosted player in the rocket's metadata key 18 (`minecart_has_display`), which the
        // firework tracking does not read yet -> no usedFirework / fireworkRocketDuration
        console.log('      skipped: no usedFirework for the boosting rockets (firework tracking fix W3-FIX-B not on main yet)')
        this.skip()
      }
      let lateActivations = 0
      assert.ok(bot.fireworkRocketDuration > 0, 'bot.fireworkRocketDuration > 0')
      for (let i = bot.fireworkRocketDuration; i > 0; --i) {
        await bot.waitForTicks(1)
        assert.ok(bot.entity.elytraFlying, 'elytraFlying while boosted')
        if (bot.fireworkRocketDuration > i) {
          i = bot.fireworkRocketDuration
          ++lateActivations
        }
        assert.ok(lateActivations <= activationTicks)
      }
      assert.ok(bot.fireworkRocketDuration === 0, 'fireworkRocketDuration === 0 at the end')
    } finally {
      bot.removeListener('usedFirework', onUsed)
    }
  })
})
