// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/dimensionData.js — VERBATIM test body. Bedrock has no dimension codec
 * (dimensionDataInCodec is false): minY/height come from the fixed per-dimension table, and the Bedrock values are
 * asserted on top (overworld -64/384 like Java 1.18+); the other dimensions are checked by dimensionTravel.test.js.
 */
const assert = require('assert')
const { useBot } = require('./common')

const upstream = () => {
  const tests = []

  function addTest (name, f) {
    tests[name] = (bot) => f(bot)
  }

  addTest('overworld properties', async (bot) => {
    // After spawn, bot.game.dimension should be set to 'overworld'
    assert.ok(bot.game.dimension, 'bot.game.dimension should be set after spawn')
    assert.strictEqual(bot.game.dimension, 'overworld', 'Dimension should be overworld on spawn')

    // minY and height should be populated from the dimension codec
    assert.strictEqual(typeof bot.game.minY, 'number', 'bot.game.minY should be a number')
    assert.strictEqual(typeof bot.game.height, 'number', 'bot.game.height should be a number')
    assert.ok(bot.game.height > 0, 'Height should be positive')

    // Overworld in modern versions has minY=-64, height=384; older versions have minY=0, height=256
    if (bot.supportFeature('dimensionDataInCodec')) {
      assert.strictEqual(bot.game.minY, -64, 'Overworld minY should be -64 for 1.18+')
      assert.strictEqual(bot.game.height, 384, 'Overworld height should be 384 for 1.18+')
    } else {
      assert.ok(bot.game.minY <= 0, 'minY should be <= 0')
      assert.ok(bot.game.height >= 256, 'Height should be at least 256')
    }
  })

  return tests
}

describe('dimensionData', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  for (const [name, fn] of Object.entries(upstream())) {
    it(`dimensionData ${name}`, async () => {
      await fn(ctx.bot)
      // Bedrock: the overworld is -64..319 (no codec, same values as Java 1.18+)
      assert.strictEqual(ctx.bot.game.minY, -64)
      assert.strictEqual(ctx.bot.game.height, 384)
      assert.strictEqual(ctx.bot.world.getColumnAt(ctx.bot.entity.position).minY, -64)
    })
  }
})
