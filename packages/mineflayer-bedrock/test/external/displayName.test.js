// owner: U7 (entities & players)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/displayName.js (verbatim assertion): the bot's own player list entry
 * has its username as display name. Bedrock's player_list has no display name, so it is always the username
 * (docs/differences/U7.md#display-name).
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('displayName', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('displayName', async () => {
    const { bot } = env
    // upstream test body
    const player = bot.players[bot.username]
    assert.strictEqual(player.displayName.toString(), bot.username)
  })
})
