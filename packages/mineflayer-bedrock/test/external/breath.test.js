// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/breath.js — VERBATIM test body.
 * Extra Bedrock check: under water (survival) the `air` metadata drops → 'breath' with oxygenLevel < 20, and it
 * refills on land.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  await bot.waitForChunksToLoad()
  // TODO: ** Fix in 1.17
  if (bot.oxygenLevel) assert.strictEqual(bot.oxygenLevel, 20, 'Wrong oxygen level')
}

describe('breath', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('breath', async () => {
    await upstream()(ctx.bot)
    assert.strictEqual(ctx.bot.oxygenLevel, 20)
  })

  it('breath: under water the air supply drops and refills (Bedrock extra)', async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    await bot.test.becomeSurvival()
    try {
      // a 3×3 water column over the bot, head under water
      await server.commandOutput(`fill -1 ${g} -1 1 ${g + 3} 1 water`)
      await bot.test.teleport(new (require('vec3').Vec3)(0, g, 0))
      await onceWithCleanup(bot, 'breath', { timeout: 15000, checkCondition: () => bot.oxygenLevel < 18 })
      assert.ok(bot.oxygenLevel >= 0 && bot.oxygenLevel < 18, `oxygen ${bot.oxygenLevel}`)
      assert.strictEqual(typeof bot.entity.metadata.air, 'number')
      await server.commandOutput(`fill -1 ${g} -1 1 ${g + 3} 1 air`)
      await onceWithCleanup(bot, 'breath', { timeout: 15000, checkCondition: () => bot.oxygenLevel === 20 })
    } finally {
      await server.commandOutput(`fill -1 ${g} -1 1 ${g + 3} 1 air`)
      await bot.test.becomeCreative()
    }
  })
})
