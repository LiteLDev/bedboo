// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/experience.js — ADAPTED commands: Bedrock's /xp syntax is
 * `/xp <amount> <player>` (points) and `/xp <amount>L <player>` (levels), the pre-1.13 Java syntax upstream picks
 * with `registry.isOlderThan('1.13')` (false for the Bedrock registry). Everything else is verbatim.
 * Bedrock: update_attributes player.level / player.experience; points derived with the shared XP curve.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')
const { totalPoints } = require('../../lib/plugins/experience')

const upstream = () => async (bot) => {
  await bot.test.becomeSurvival()
  await bot.test.wait(1000)

  // Initial state
  const initialState = {
    level: bot.experience.level,
    points: bot.experience.points,
    progress: bot.experience.progress
  }
  assert(initialState.level >= 0, 'Initial experience level should be non-negative')
  assert(initialState.points >= 0, 'Initial experience points should be non-negative')
  assert(initialState.progress >= 0 && initialState.progress <= 1, 'Initial experience progress should be between 0 and 1')

  // Test experience points
  // Bedrock (adapted): `/xp <amount> <player>`
  const xpCommand = `/xp 10 ${bot.username}`

  await bot.chat(xpCommand)
  await once(bot, 'experience')

  // Verify after points
  assert(bot.experience.points >= 10, 'Experience points should be at least 10 after adding points')
  assert(bot.experience.level >= initialState.level, 'Experience level should not decrease after adding points')
  assert(bot.experience.progress >= 0 && bot.experience.progress <= 1, 'Experience progress should be between 0 and 1 after adding points')

  // Test experience levels
  // Bedrock (adapted): `/xp <amount>L <player>`
  const levelCommand = `/xp 100L ${bot.username}`

  await bot.chat(levelCommand)
  await once(bot, 'experience')

  // Verify after levels
  assert(bot.experience.level >= 100, 'Experience level should be at least 100 after adding levels')
  assert(bot.experience.points > 0, 'Experience points should be positive after adding levels')
  assert(bot.experience.progress >= 0 && bot.experience.progress <= 1, 'Experience progress should be between 0 and 1 after adding levels')
}

describe('experience', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('experience', async () => {
    const { bot } = ctx
    await upstream()(bot)
    // Bedrock extra: the derived total matches the XP curve exactly
    await bot.test.botCommand(`/xp -1000L ${bot.username}`)
    await bot.test.wait(300)
    const gained = once(bot, 'experience')
    await bot.test.botCommand(`/xp 10 ${bot.username}`)
    await gained
    assert.strictEqual(bot.experience.level, 1)
    assert.ok(Math.abs(bot.experience.progress - 3 / 9) < 1e-5, `progress ${bot.experience.progress}`)
    assert.strictEqual(bot.experience.points, 10)
    assert.strictEqual(totalPoints(30, 0), 1395)
    assert.strictEqual(totalPoints(17, 0), 394)
  })
})
