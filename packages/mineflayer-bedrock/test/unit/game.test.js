'use strict'
// owner: U4 (core runtime) — game.js, settings.js, kick.js on the recorded BDS join + bedrock-protocol keep-alive
const assert = require('assert')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')

describe('game / settings / kick (U4)', function () {
  this.timeout(30000)

  it('internalTest › game › dimension from start_game', async () => {
    const { bot, client } = await createFakeBot()
    const order = []
    bot.on('login', () => order.push(['login', bot.game.dimension]))
    bot.on('game', () => order.push(['game']))
    await replayJoin(bot, client)
    assert.deepStrictEqual(order.slice(0, 2), [['login', 'overworld'], ['game']])
    assert.strictEqual(bot.game.dimension, 'overworld')
    assert.strictEqual(bot.game.minY, -64)
    assert.strictEqual(bot.game.height, 384)
    assert.strictEqual(bot.game.levelType, 'flat')
    assert.strictEqual(bot.game.gameMode, 'survival', "player_gamemode 'fallback' → world_gamemode")
    assert.strictEqual(bot.game.difficulty, 'easy')
    assert.strictEqual(bot.game.hardcore, false)
    assert.strictEqual(bot.game.maxPlayers, undefined)
    assert.strictEqual(bot.game.enableRespawnScreen, true)
    assert.strictEqual(bot.game.serverBrand, 'vanilla')
    assert.strictEqual(bot.game.serverViewDistance, 10, 'chunk_radius_update')
  })

  it('update_player_game_type (own unique id) → gameMode + game; set_difficulty; set_player_game_type', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    let games = 0
    bot.on('game', () => games++)
    const recorded = afterSpawnRecords().filter(r => r.name === 'update_player_game_type').map(r => r.params)
    client.receive('update_player_game_type', recorded[0])
    assert.strictEqual(bot.game.gameMode, 'creative')
    client.receive('update_player_game_type', { ...recorded[0], gamemode: 'adventure', player_unique_id: 12345n })
    assert.strictEqual(bot.game.gameMode, 'creative', "another player's game mode")
    client.receive('set_player_game_type', { gamemode: 'creative_spectator' })
    assert.strictEqual(bot.game.gameMode, 'spectator')
    assert.strictEqual(games, 2)
    client.receive('set_difficulty', { difficulty: 3 })
    assert.strictEqual(bot.game.difficulty, 'hard')
  })

  it('internalTest › game › responds to network_stack_latency (bedrock-protocol answers with the same timestamp)', async () => {
    require('../../lib/registry').installDataOverlay()
    const { createClient } = require('../../lib/client')
    const client = createClient({ host: '127.0.0.1', port: 1, username: 'latency', connectTimeout: 60000 })
    try {
      const queued = []
      client.queue = (name, params) => queued.push([name, params])
      client.emit('network_stack_latency', { timestamp: 123456789n, needs_response: true })
      client.emit('network_stack_latency', { timestamp: 5n, needs_response: false })
      assert.deepStrictEqual(queued, [['network_stack_latency', { timestamp: 123456789n, needs_response: false }]])
    } finally {
      client.close()
    }
  })

  it('settings: view distance → client.viewDistance (join request) and request_chunk_radius after login; upstream validation', async () => {
    const { bot, client } = await createFakeBot()
    assert.strictEqual(bot.settings.viewDistance, 'far')
    assert.strictEqual(client.viewDistance, 12)
    bot.setSettings({ viewDistance: 'tiny' })
    assert.strictEqual(client.viewDistance, 6)
    assert.strictEqual(client.sent('request_chunk_radius').length, 0, 'before login bedrock-protocol sends the join request')
    await replayJoin(bot, client)
    bot.setSettings({ viewDistance: 9 })
    assert.deepStrictEqual(client.sent('request_chunk_radius'), [{ chunk_radius: 9, max_radius: 9 }])
    assert.throws(() => bot.setSettings({ chat: 'nope' }), /invalid chat setting: nope/)
    bot.settings.chat = 'enabled'
    assert.throws(() => bot.setSettings({ viewDistance: 'huge' }), /invalid view distance setting: huge/)
    bot.settings.viewDistance = 'far'
    assert.throws(() => bot.setSettings({ mainHand: 'middle' }), /invalid main hand: middle/)
    const { client: c2 } = await createFakeBot({ viewDistance: 'short' })
    assert.strictEqual(c2.viewDistance, 8)
  })

  it('kick: disconnect → kicked(reason, loggedIn) then end; quit → end("disconnect.quitting")', async () => {
    const { bot, client } = await createFakeBot()
    const kicks = []
    bot.on('kicked', (reason, loggedIn) => kicks.push([reason, loggedIn]))
    client.receive('disconnect', { reason: 'server_full', hide_disconnect_reason: false, message: 'disconnectionScreen.serverFull', filtered_message: '' })
    await replayJoin(bot, client)
    client.receive('disconnect', { reason: 'kicked', hide_disconnect_reason: false, message: 'go away', filtered_message: '' })
    client.receive('disconnect', { reason: 'server_id_conflict', hide_disconnect_reason: false, message: '', filtered_message: '' })
    client.receive('disconnect', { reason: 'kicked', hide_disconnect_reason: true })
    assert.deepStrictEqual(kicks, [['disconnectionScreen.serverFull', false], ['go away', true], ['server_id_conflict', true], ['kicked', true]])

    const { bot: bot2 } = await createFakeBot()
    const ended = new Promise(resolve => bot2.once('end', resolve))
    bot2.quit()
    assert.strictEqual(await ended, 'disconnect.quitting')
    const { bot: bot3 } = await createFakeBot()
    const ended3 = new Promise(resolve => bot3.once('end', resolve))
    bot3.quit('bye')
    assert.strictEqual(await ended3, 'bye')
  })
})
