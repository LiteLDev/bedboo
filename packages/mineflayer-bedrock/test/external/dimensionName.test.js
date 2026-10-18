// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/dimensionName.js — VERBATIM. The nether / end names are asserted by
 * dimensionTravel.test.js.
 */
const assert = require('assert')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  assert.strictEqual(bot._getDimensionName(), 'minecraft:overworld')
}

describe('dimensionName', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('dimensionName', async () => {
    await upstream()(ctx.bot)
  })
})
