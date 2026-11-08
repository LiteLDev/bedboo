'use strict'
// join / dimension / respawn lifecycle (lib/bedrock/lifecycle.js), the only 'spawn'
// emitter
const { describe, it } = require('node:test')
const assert = require('assert')
const { createFakeBot, replayJoin } = require('./helpers/fake')

describe('lifecycle (join, dimension change, respawn hooks)', () => {
  it('join: respawn state 1 → client state 2, player_spawn → loading screen 1 then 2 → login, game, spawn in order', async () => {
    const { bot, client, errors } = await createFakeBot()
    const events = []
    for (const e of ['login', 'game', 'spawn', 'forcedMove']) bot.on(e, () => events.push(e))
    let stateAtSpawn
    bot.on('spawn', () => { stateAtSpawn = bot._bedrock.lifecycle.state })
    assert.strictEqual(bot._bedrock.lifecycle.state, 'connecting')
    await replayJoin(bot, client)
    assert.deepStrictEqual(errors, [])
    assert.deepStrictEqual(events.slice(0, 2), ['login', 'game'])
    assert.ok(events.indexOf('spawn') > events.indexOf('login'))
    assert.strictEqual(events.filter(e => e === 'spawn').length, 1)
    assert.ok(events.indexOf('forcedMove') < events.indexOf('spawn'), 'the position is known before spawn')
    assert.strictEqual(stateAtSpawn, 'spawned')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')

    const respawns = client.sent('respawn')
    assert.strictEqual(respawns.length, 1, 'exactly one client respawn (state 2)')
    assert.strictEqual(respawns[0].state, 2)
    assert.strictEqual(respawns[0].runtime_entity_id, 91n)
    assert.ok(Math.abs(respawns[0].position.y + 58.38) < 1e-4, 'echoes the eye-level spawn position')

    const order = client.written.map(([, n, p]) => n === 'serverbound_loading_screen' ? `loading_screen_${p.type}` : n)
      .filter(n => ['set_local_player_as_initialized', 'loading_screen_1', 'loading_screen_2'].includes(n))
    assert.deepStrictEqual(order, ['set_local_player_as_initialized', 'loading_screen_1', 'loading_screen_2'])

    // spawn position: the real eye-level spawn of respawn state 1, as feet
    assert.ok(Math.abs(bot.entity.position.y - -60) < 1e-3, `feet y ${bot.entity.position.y}`)
    assert.strictEqual(bot.entity.position.x, 0.5)
    // the tick clock is anchored on start_game.current_tick and running
    assert.ok(bot._bedrock.input.isRunning())
    assert.ok(!bot._bedrock.input.isSuspended())
    assert.ok(bot._bedrock.input.currentTick() >= 57846n)
  })

  it('no player_auth_input before the spawn (input suspended while loading)', async () => {
    const { bot, client, clock } = await createFakeBot()
    await replayJoin(bot, client, { until: (name, p) => name === 'play_status' && p.status === 'player_spawn' })
    assert.strictEqual(bot._bedrock.lifecycle.state, 'loading')
    assert.ok(bot._bedrock.input.isSuspended())
    clock.advance(500)
    assert.strictEqual(bot._bedrock.input.pump(), 0)
    assert.strictEqual(client.sent('player_auth_input').length, 0)
  })

  it('markSpawned validates its reason, join spawns once, waitFor resolves / times out', async () => {
    const { bot, client } = await createFakeBot()
    const { lifecycle } = bot._bedrock
    assert.throws(() => lifecycle.markSpawned('nope'), /reason must be one of/)
    assert.throws(() => lifecycle.setState('nope'), /unknown lifecycle state/)
    const waiting = lifecycle.waitFor('spawned', { timeout: 5000 })
    // handled below; when replayJoin throws (a family without a capture: the test is skipped) it must not reject unobserved
    waiting.catch(() => {})
    await replayJoin(bot, client)
    await waiting
    let spawns = 0
    bot.on('spawn', () => spawns++)
    lifecycle.markSpawned('join')
    assert.strictEqual(spawns, 0, "a second 'join' spawn is ignored")
    await assert.rejects(lifecycle.waitFor('dead', { timeout: 20 }), /timed out/)
  })

  it('respawn hooks: dead keeps the input running, markSpawned("respawn") emits spawn again', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const { lifecycle, input } = bot._bedrock
    let spawns = 0
    bot.on('spawn', () => spawns++)
    lifecycle.setState('dead')
    assert.ok(!input.isSuspended())
    lifecycle.setState('respawning')
    // respawn state 1 after a death moves the bot (no client answer: that is bot.respawn's)
    client.clearSent()
    client.receive('respawn', { position: { x: 0.5, y: -58.38, z: 7.5 }, state: 1, runtime_entity_id: 0n })
    assert.strictEqual(client.sent('respawn').length, 0)
    assert.strictEqual(bot.entity.position.z, 7.5)
    lifecycle.markSpawned('respawn')
    assert.strictEqual(spawns, 1)
    assert.strictEqual(lifecycle.state, 'spawned')
  })

  it('dimension change: change_dimension → ack + world reset + suspended; server dimension_change_ack → loading screen + spawn', async () => {
    const { bot, client, clock } = await createFakeBot()
    await replayJoin(bot, client)
    const { lifecycle, input } = bot._bedrock
    const states = []
    lifecycle.events.on('state', s => states.push(s))
    let spawns = 0
    let unloads = 0
    bot.on('spawn', () => spawns++)
    bot.on('chunkColumnUnload', () => unloads++)
    const loadedBefore = Object.keys(bot.world.async.columns).length
    client.clearSent()
    client.receive('change_dimension', { dimension: 1, position: { x: 0.5, y: 70, z: 0.5 }, respawn: false, loading_screen_id: 2 })
    assert.strictEqual(lifecycle.state, 'changing_dimension')
    assert.ok(input.isSuspended())
    assert.strictEqual(bot.game.dimension, 'the_nether')
    assert.strictEqual(bot.game.minY, 0)
    assert.strictEqual(bot.game.height, 128)
    assert.strictEqual(bot._getDimensionName(), 'minecraft:the_nether')
    assert.strictEqual(Object.keys(bot.world.async.columns).length, 0)
    assert.strictEqual(unloads, loadedBefore)
    assert.strictEqual(bot.entity.position.y, 70, 'change_dimension positions are feet level')
    const [ack] = client.sent('player_action')
    assert.strictEqual(ack.action, 'dimension_change_ack')
    assert.strictEqual(ack.runtime_entity_id, 91n)
    clock.advance(200)
    assert.strictEqual(input.pump(), 0)

    client.receive('player_action', { runtime_entity_id: 91n, action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
    assert.deepStrictEqual(client.sent('serverbound_loading_screen'), [{ type: 1, loading_screen_id: 2 }, { type: 2, loading_screen_id: 2 }])
    assert.strictEqual(spawns, 1)
    assert.strictEqual(lifecycle.state, 'spawned')
    assert.deepStrictEqual(states, ['changing_dimension', 'spawned'])
    clock.advance(50)
    assert.strictEqual(input.pump(), 1)
  })

  it('end: state ended, input stopped, waitFor rejects at once', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    bot.end('bye')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'ended')
    assert.ok(!bot._bedrock.input.isRunning())
    await assert.rejects(bot._bedrock.lifecycle.waitFor('spawned'), /ended/)
  })

  it('play_status player_spawn racing ahead of start_game still spawns (after the start_game listeners)', async () => {
    const { bot, client } = await createFakeBot()
    const { joinRecords } = require('./helpers/fake')
    const records = joinRecords()
    const spawnRecord = records.find(r => r.name === 'play_status' && r.params.status === 'player_spawn')
    let entityAtSpawn
    bot.on('spawn', () => { entityAtSpawn = bot.entity })
    client.receive('play_status', spawnRecord.params)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'connecting')
    for (const { name, params } of records) {
      if (name === 'play_status' && params.status === 'player_spawn') continue
      client.receive(name, params)
      if (name === 'start_game') await new Promise(resolve => process.nextTick(resolve))
    }
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
    assert.ok(entityAtSpawn, 'bot.entity existed when spawn was emitted')
    assert.deepStrictEqual(client.sent('serverbound_loading_screen').map(p => p.type), [1, 2])
  })

  it('dimension change: game + world switch before the new position (forcedMove sees the new dimension)', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const seen = []
    bot.on('game', () => seen.push(['game', bot.game.dimension]))
    bot.on('forcedMove', () => seen.push(['forcedMove', bot.game.dimension, Object.keys(bot.world.async.columns).length, bot._getDimensionName()]))
    client.receive('change_dimension', { dimension: 2, position: { x: 0.5, y: 64, z: 0.5 }, respawn: false, loading_screen_id: 7 })
    assert.deepStrictEqual(seen, [['game', 'the_end'], ['forcedMove', 'the_end', 0, 'minecraft:the_end']])
  })
})
