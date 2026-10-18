'use strict'
// owner: U9 (player state, world extras & dimensions) — the dimension flow (lifecycle.js + game.js + blocks.js +
// health.js) on the recorded BDS join: world switch, 'respawn' / 'game' / 'spawn', acks, End credits
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')

const SELF = 91n
const ZERO = { x: 0, y: 0, z: 0 }
const serverAck = (client) => client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })

describe('dimension changes (U9)', function () {
  this.timeout(30000)

  it('internalTest › world › switchWorld respawn', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const loaded = Object.keys(bot.world.async.columns)
    assert.ok(loaded.length > 0)
    const events = []
    for (const e of ['respawn', 'game', 'spawn', 'chunkColumnUnload']) bot.on(e, () => events.push(e))
    const blockAt = bot.blockAt(new Vec3(0, -61, 0))
    assert.strictEqual(blockAt.name, 'grass_block')
    const updates = []
    bot.on('blockUpdate:(0, -61, 0)', (oldBlock, newBlock) => updates.push([oldBlock, newBlock]))
    client.clearSent()

    client.receive('change_dimension', { dimension: 1, position: { x: 0.5, y: 70, z: 0.5 }, respawn: false, loading_screen_id: 4 })
    // the old world's columns are gone (upstream switchWorld: every column unloaded, blockUpdate: listeners released)
    assert.strictEqual(Object.keys(bot.world.async.columns).length, 0)
    assert.strictEqual(events.filter(e => e === 'chunkColumnUnload').length, loaded.length)
    assert.deepStrictEqual(updates, [[null, null]])
    assert.strictEqual(bot.listenerCount('blockUpdate:(0, -61, 0)'), 0)
    assert.strictEqual(bot.blockAt(new Vec3(0, -61, 0)), null)
    // 'respawn' like the Java respawn packet (isAlive false until the new dimension spawns), 'game' first
    assert.deepStrictEqual(events.filter(e => e !== 'chunkColumnUnload'), ['game', 'respawn'])
    assert.strictEqual(bot.isAlive, false)
    assert.strictEqual(bot.game.dimension, 'the_nether')
    assert.deepStrictEqual(client.sent('player_action').map(p => p.action), ['dimension_change_ack'])

    // a late level_chunk of the overworld is ignored; the nether's loads with nether bounds
    const overworldChunk = { x: 0, z: 0, dimension: 0, sub_chunk_count: 0, highest_subchunk_count: 1, payload: Buffer.alloc(0) }
    client.receive('level_chunk', overworldChunk)
    assert.strictEqual(client.sent('subchunk_request').length, 0)

    serverAck(client)
    assert.deepStrictEqual(events.filter(e => e !== 'chunkColumnUnload'), ['game', 'respawn', 'spawn'])
    assert.strictEqual(bot.isAlive, true)
    assert.deepStrictEqual(client.sent('serverbound_loading_screen'), [{ type: 1, loading_screen_id: 4 }, { type: 2, loading_screen_id: 4 }])
  })

  it('show_credits (End exit portal): status 0 → client show_credits status 1 at once; other players / end status ignored', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    client.clearSent()
    client.receive('show_credits', { runtime_entity_id: SELF, status: 0 })
    assert.deepStrictEqual(client.sent('show_credits'), [{ runtime_entity_id: SELF, status: 1 }])
    client.receive('show_credits', { runtime_entity_id: 7n, status: 0 })
    client.receive('show_credits', { runtime_entity_id: SELF, status: 1 })
    assert.strictEqual(client.sent('show_credits').length, 1)
    // what BDS sends next (observed): set_health, respawn state 0, change_dimension { respawn: true } with a loading
    // screen id, then the respawn packets of the arrival — the player is alive throughout
    let spawns = 0
    bot.on('spawn', () => spawns++)
    client.receive('set_health', { health: 20 })
    client.receive('respawn', { position: { x: 1, y: -58.38, z: 2 }, state: 0, runtime_entity_id: 0n })
    client.receive('change_dimension', { dimension: 0, position: { x: 1, y: -60, z: 2 }, respawn: true, loading_screen_id: 11 })
    serverAck(client)
    client.receive('respawn', { position: { x: 1, y: -60, z: 2 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 1, y: -58.38, z: 2 }, state: 1, runtime_entity_id: 0n })
    assert.strictEqual(spawns, 1)
    assert.strictEqual(bot.isAlive, true)
    assert.deepStrictEqual(client.sent('serverbound_loading_screen').map(p => p.type), [1, 2])
    assert.strictEqual(client.sent('respawn').length, 0, 'no client_ready: not a death')
    assert.strictEqual(client.sent('player_action').filter(p => p.action === 'respawn').length, 0)
  })

  it('game: dimension, minY/height per dimension; game_rules_changed → bot.bedrock.gameRules', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    assert.strictEqual(bot.bedrock.gameRules.doDayLightCycle, true, 'start_game.gamerules (fixture world)')
    assert.strictEqual(bot.bedrock.gameRules.randomTickSpeed, 1)
    client.receive('game_rules_changed', { rules: [{ name: 'keepInventory', editable: true, type: 'bool', value: true }] })
    assert.strictEqual(bot.bedrock.gameRules.keepInventory, true)
    for (const [id, name, minY, height] of [[2, 'the_end', 0, 256], [1, 'the_nether', 0, 128], [0, 'overworld', -64, 384]]) {
      client.receive('change_dimension', { dimension: id, position: { x: 0.5, y: 70, z: 0.5 }, respawn: false, loading_screen_id: id + 10 })
      assert.deepStrictEqual([bot.game.dimension, bot.game.minY, bot.game.height, bot._getDimensionName()], [name, minY, height, `minecraft:${name}`])
      serverAck(client)
    }
  })
})
