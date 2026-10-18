// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/complete.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 *
 * Adapted (docs/differences/U6.md#tab-complete): Bedrock has no tab-complete packet; bot.tabComplete completes from
 * the server's available_commands like the vanilla client. Bedrock's /weather also takes `query`, so the expected
 * list is clear, query, rain, thunder (same shape: tabCompleteHasAToolTip → [{ match, tooltip }]).
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('complete', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('complete', async () => {
    const { bot } = env
    bot.test.sayEverywhere('### Starting complete')
    const matches = await bot.tabComplete('/weather ')
    if (bot.supportFeature('tabCompleteHasAToolTip')) {
      assert.deepStrictEqual(matches, [
        { match: 'clear', tooltip: undefined },
        { match: 'query', tooltip: undefined }, // Bedrock: `/weather query`
        { match: 'rain', tooltip: undefined },
        { match: 'thunder', tooltip: undefined }
      ])
    } else if (bot.supportFeature('tabCompleteHasNoToolTip')) {
      assert.deepStrictEqual(matches, [
        'clear',
        'rain',
        'thunder'
      ])
    }

    if (bot.supportFeature('tabCompleteHasNoToolTip')) {
      const matches = await bot.tabComplete('/weather')
      assert.deepStrictEqual(matches, ['/weather'])
    }
  })

  it('completes command names, enum arguments, players and soft enums the server updates (Bedrock extra)', async () => {
    const { bot } = env
    assert.deepStrictEqual((await bot.tabComplete('/weather')).map(m => m.match), ['weather'])
    assert.deepStrictEqual((await bot.tabComplete('/time set n')).map(m => m.match), ['night', 'noon'])
    const targets = (await bot.tabComplete('/kill ')).map(m => m.match)
    assert.ok(targets.includes(bot.username) && targets.includes('@a'), targets.join(' '))
    // /scoreboard objectives add → update_soft_enum ScoreboardObjectives
    const out = await bot._bedrock.commands.request('/scoreboard objectives add completeme dummy')
    assert.strictEqual(out.success_count, 1)
    await bot.test.wait(200)
    assert.deepStrictEqual((await bot.tabComplete('/scoreboard objectives remove compl')).map(m => m.match), ['completeme'])
    await bot._bedrock.commands.request('/scoreboard objectives remove completeme')
  })
})
