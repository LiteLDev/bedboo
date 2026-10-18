// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/rain.js — VERBATIM test body (only the promise_utils require path
 * changes). Bedrock: level_event start_rain / stop_rain (+ thunder); extra checks for rainState / thunderState /
 * weatherUpdate and the rain level a joining bot gets from start_game.
 */
const assert = require('assert')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createTestBot } = require('./common')

const upstream = () => async (bot) => {
  if (bot.isRaining) {
    bot.test.sayEverywhere('/weather clear')
    await once(bot, 'rain')
  }
  assert.strictEqual(bot.isRaining, false)
  bot.test.sayEverywhere('/weather rain')

  await once(bot, 'rain')
  assert.strictEqual(bot.isRaining, true)
  bot.test.sayEverywhere('/weather clear')

  await once(bot, 'rain')
  assert.strictEqual(bot.isRaining, false)
}

describe('rain', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('rain', async () => {
    await upstream()(ctx.bot)
  })

  it('rain: thunder levels, weatherUpdate, a joining bot starts with the current weather (Bedrock extra)', async () => {
    const { bot, server } = ctx
    const updates = []
    const onUpdate = () => updates.push([bot.rainState, bot.thunderState])
    bot.on('weatherUpdate', onUpdate)
    try {
      const raining = onceWithCleanup(bot, 'rain', { timeout: 5000 })
      const thunder = onceWithCleanup(bot, 'weatherUpdate', { timeout: 5000, checkCondition: () => bot.thunderState > 0 })
      await bot.test.botCommand('/weather thunder')
      await raining
      await thunder
      assert.strictEqual(bot.isRaining, true)
      assert.strictEqual(bot.rainState, 1)
      assert.strictEqual(bot.thunderState, 1)

      // a second bot joining while it thunders: start_game rain/lightning levels (> 0, still fading in)
      const { bot: other } = await createTestBot({ server, username: `rainjoin${process.pid % 1000}`, botOptions: { viewDistance: 'tiny' } })
      try {
        assert.strictEqual(other.isRaining, true)
        assert.ok(other.rainState > 0 && other.rainState <= 1, `rainState ${other.rainState}`)
        assert.ok(other.thunderState > 0 && other.thunderState <= 1, `thunderState ${other.thunderState}`)
      } finally {
        other.end('test done')
      }

      const cleared = onceWithCleanup(bot, 'rain', { timeout: 5000 })
      await bot.test.botCommand('/weather clear')
      await cleared
      if (bot.thunderState !== 0) await onceWithCleanup(bot, 'weatherUpdate', { timeout: 5000, checkCondition: () => bot.thunderState === 0 })
      assert.strictEqual(bot.isRaining, false)
      assert.strictEqual(bot.rainState, 0)
      assert.strictEqual(bot.thunderState, 0)
      assert.ok(updates.length >= 4, JSON.stringify(updates))
    } finally {
      bot.removeListener('weatherUpdate', onUpdate)
    }
  })
})
