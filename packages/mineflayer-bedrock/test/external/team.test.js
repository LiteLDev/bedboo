// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/team.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 *
 * n.a. (docs/differences/U6.md#no-teams): Bedrock Edition has no teams — no /team command, no
 * `/scoreboard teams`, no team packet — so teamMemberAdded can never fire. The upstream test is kept verbatim and
 * skipped; the Bedrock test checks that both team commands are refused and bot.teams / bot.teamMap stay empty.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('team', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('team', async function () {
    this.skip() // no teams on Bedrock (docs/differences/U6.md#no-teams)
    const { bot } = env
    const p = once(bot, 'teamMemberAdded')
    if (bot.supportFeature('teamUsesChatComponents')) {
      bot.test.sayEverywhere('/team add test "test"')
      bot.test.sayEverywhere('/team modify test color dark_green')
      bot.test.sayEverywhere(`/team join test ${bot.username}`)
    } else {
      bot.test.sayEverywhere('/scoreboard teams add test')
      bot.test.sayEverywhere('/scoreboard teams option test color dark_green')
      bot.test.sayEverywhere('/scoreboard teams join test')
    }

    await p

    assert.notStrictEqual(bot.teams.test, undefined)
    assert.notStrictEqual(bot.teamMap[bot.username], undefined, 'teamMap is not undefined')

    const { test } = bot.teams

    assert.strictEqual(test.name.toString(), 'test')
  })

  it('no teams on Bedrock: /team and /scoreboard teams are refused, bot.teams / bot.teamMap stay empty', async () => {
    const { bot } = env
    const team = await bot._bedrock.commands.request('/team add test "test"')
    assert.strictEqual(team.success_count, 0)
    assert.strictEqual(team.output[0].message_id, 'commands.generic.unknown')
    const legacy = await bot._bedrock.commands.request('/scoreboard teams add test')
    assert.strictEqual(legacy.success_count, 0)
    assert.match(legacy.output[0].message_id, /^commands\.generic\./)
    assert.deepStrictEqual([bot.teams, bot.teamMap], [{}, {}])
  })
})
