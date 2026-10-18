// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/spawnEvent.js — ADAPTED:
 * - `require('mineflayer').createBot` → mineflayer-bedrock's createBot (same options);
 * - `/kill` of a creative bot does nothing on BDS ("Players cannot be killed while they are in Creative mode"):
 *   the bot becomes survival first (docs/differences/U9.md#creative-death);
 * - `playerLeft` is U7's (wave 3, entities): until U7's entities plugin is merged the test waits for the raw
 *   player_list removal that U7 turns into playerLeft.
 */
const { once } = require('mineflayer/lib/promise_utils')
const { useBot, implemented } = require('./common')
const mineflayer = require('../..')

describe('spawnEvent', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('spawnEvent', async () => {
    const bot = ctx.bot
    // Test spawn event on login
    const spawnBot = mineflayer.createBot({
      username: 'spawnbot',
      viewDistance: 'tiny',
      port: bot.test.port,
      host: '127.0.0.1',
      version: bot.version
    })
    await once(spawnBot, 'spawn')
    // Wait for the server to process the disconnection before killing the main bot
    const left = implemented(bot.nearestEntity)
      ? once(bot, 'playerLeft')
      : bot.test.ctx.packet('player_list', (p) => (p.records?.type ?? p.records?.[0]?.type) === 'remove', 10000).promise
    spawnBot.end()
    await left

    // Test spawn event on death
    await bot.test.becomeSurvival() // Bedrock (adapted): creative players cannot be killed
    bot.test.sayEverywhere(`/kill ${bot.username}`)
    await once(bot, 'spawn')
  })
})
