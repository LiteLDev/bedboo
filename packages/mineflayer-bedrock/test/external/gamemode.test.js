// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/gamemode.js.
 * - 'change': VERBATIM.
 * - 'after respawn': ADAPTED. Upstream kills a creative bot and checks it respawns creative. BDS refuses to kill
 *   creative players ("Players cannot be killed while they are in Creative mode", not even by /damage or the void),
 *   so bot.test.selfKill() switches a creative bot to survival first, and a game mode cannot be set on a dead player
 *   either. The same property — the respawned bot keeps a non-default game mode — is checked with adventure mode
 *   (selfKill keeps it; the world default is survival). docs/differences/U9.md#creative-death
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('gamemode', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('gamemode change', async () => {
    const bot = ctx.bot
    await bot.test.becomeSurvival()
    assert.strictEqual(bot.game.gameMode, 'survival', 'Wrong gamemode after switching gamemode')
    await bot.test.becomeCreative()
    assert.strictEqual(bot.game.gameMode, 'creative', 'Wrong gamemode after switching gamemode')
  })

  it('gamemode after respawn', async () => {
    const bot = ctx.bot
    // Bedrock (adapted): adventure instead of creative — creative players cannot be killed on BDS
    await bot.test.setGameMode('adventure')
    assert.strictEqual(bot.game.gameMode, 'adventure')
    const respawned = onceWithCleanup(bot, 'respawn', { timeout: 5000 })
    const spawned = onceWithCleanup(bot, 'spawn', { timeout: 10000 })
    bot.test.selfKill()
    await respawned
    // Respawn packets send the gamemode. If the bot is in creative mode, it should respawn in creative mode. Tested <1.20
    assert.strictEqual(bot.game.gameMode, 'adventure', 'Wrong gamemode after respawn')
    await spawned
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot.game.gameMode, 'adventure', 'Wrong gamemode after the respawn completed')
  })
})
