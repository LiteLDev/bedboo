'use strict'
// owner: U9 (player state, world extras & dimensions) — health.js (health/food, death, the 3-step respawn, isAlive)
// on the recorded BDS join + the death / respawn packet sequences observed on BDS 1.26.51.1
const assert = require('assert')
const { createFakeBot, replayJoin } = require('./helpers/fake')

const SELF = 91n
const ZERO = { x: 0, y: 0, z: 0 }

/** BDS 1.26.51.1: what /kill sends (entity_event, death_info, text, health 0, respawn state 0 at the death position) */
function die (client) {
  client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
  client.receive('death_info', { cause: 'death.attack.generic', messages: ['U0Bot'] })
  client.receive('update_attributes', { runtime_entity_id: SELF, attributes: [{ name: 'minecraft:health', current: 0, min: 0, max: 20, default: 20, modifiers: [] }], tick: 1n })
  client.receive('respawn', { position: { x: 5.5, y: -58.38, z: 5.5 }, state: 0, runtime_entity_id: 0n })
}

/** the server's answer to the client's respawn state 2: state 0 (searching) + state 1 (ready) at the spawn */
function ready (client) {
  client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: 0n })
  client.receive('respawn', { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 1, runtime_entity_id: 0n })
}

/** the server's answer to player_action respawn */
function revived (client) {
  client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'respawn', data: 0 })
  client.receive('set_health', { health: 20 })
}

function record (bot, names) {
  const events = []
  for (const name of names) bot.on(name, () => events.push([name, bot.isAlive, bot._bedrock.lifecycle.state, bot.health]))
  return events
}

describe('health / death / respawn (U9)', function () {
  this.timeout(30000)

  it('health, food and saturation from the join attributes and set_health; health event per packet', async () => {
    const { bot, client } = await createFakeBot()
    let healthEvents = 0
    bot.on('health', () => healthEvents++)
    await replayJoin(bot, client)
    assert.strictEqual(bot.health, 20)
    assert.strictEqual(bot.food, 20)
    assert.strictEqual(bot.foodSaturation, 5)
    assert.ok(healthEvents >= 2, 'update_attributes + set_health')
    healthEvents = 0
    client.receive('update_attributes', {
      runtime_entity_id: SELF,
      attributes: [
        { name: 'minecraft:player.hunger', current: 17, min: 0, max: 20, default: 20, modifiers: [] },
        { name: 'minecraft:player.saturation', current: 1.5, min: 0, max: 20, default: 5, modifiers: [] }
      ]
    })
    assert.deepStrictEqual([bot.food, bot.foodSaturation, healthEvents], [17, 1.5, 1])
    client.receive('update_attributes', { runtime_entity_id: SELF, attributes: [{ name: 'minecraft:movement', current: 0.1, modifiers: [] }] })
    assert.strictEqual(healthEvents, 1, 'no health event for other attributes')
    client.receive('update_attributes', { runtime_entity_id: 5n, attributes: [{ name: 'minecraft:health', current: 3, modifiers: [] }] })
    assert.strictEqual(bot.health, 20, 'another entity')
    client.receive('set_health', { health: 12 })
    assert.deepStrictEqual([bot.health, healthEvents, bot.isAlive], [12, 2, true])
  })

  it('death → health 0, death, auto respawn: client state 2 after the server state 0, player_action respawn after state 1, spawn once alive', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const events = record(bot, ['health', 'death', 'respawn', 'spawn', 'game'])
    client.clearSent()

    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
    assert.deepStrictEqual(events.map(e => e[0]), ['health', 'death'])
    assert.deepStrictEqual(events[1].slice(1), [false, 'dead', 0])
    assert.strictEqual(client.sent('respawn').length, 0, 'no client_ready before the server state 0 (BDS ignores it)')
    client.receive('update_attributes', { runtime_entity_id: SELF, attributes: [{ name: 'minecraft:health', current: 0, modifiers: [] }] })
    assert.strictEqual(events.filter(e => e[0] === 'death').length, 1, 'one death')
    client.receive('respawn', { position: { x: 5.5, y: -58.38, z: 5.5 }, state: 0, runtime_entity_id: 0n })
    assert.deepStrictEqual(client.sent('respawn'), [{ position: ZERO, state: 2, runtime_entity_id: SELF }])
    assert.strictEqual(bot._bedrock.lifecycle.state, 'respawning')
    assert.ok(!bot._bedrock.input.isSuspended(), 'the input keeps running while dead')

    ready(client)
    assert.strictEqual(client.sent('respawn').length, 1, 'the second state 0 is not answered again')
    assert.deepStrictEqual(client.sent('player_action'), [{ runtime_entity_id: SELF, action: 'respawn', position: ZERO, result_position: ZERO, face: -1 }])
    assert.ok(Math.abs(bot.entity.position.z - 0.5) < 1e-9, 'state 1 moved the bot (lifecycle)')
    assert.deepStrictEqual(events.map(e => e[0]).slice(-2), ['game', 'respawn'])
    assert.strictEqual(bot.isAlive, false)

    revived(client)
    const names = events.map(e => e[0])
    assert.deepStrictEqual(names.slice(names.indexOf('respawn')), ['respawn', 'health', 'spawn'])
    assert.deepStrictEqual(events[events.length - 1].slice(1), [true, 'spawned', 20])
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(client.sent('player_action').length, 1)
  })

  it('death before the death screen packet order (state 0 first) and an entity_event respawn without health still revive', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    let spawns = 0
    bot.on('spawn', () => spawns++)
    client.clearSent()
    client.receive('update_attributes', { runtime_entity_id: SELF, attributes: [{ name: 'minecraft:health', current: 0, modifiers: [] }] })
    assert.strictEqual(bot.isAlive, false)
    client.receive('respawn', { position: { x: 5.5, y: -58.38, z: 5.5 }, state: 0, runtime_entity_id: 0n })
    assert.strictEqual(client.sent('respawn').length, 1)
    ready(client)
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'respawn', data: 0 })
    assert.strictEqual(spawns, 0, 'waits for the health update first')
    await new Promise(resolve => setTimeout(resolve, 600))
    assert.strictEqual(spawns, 1, 'fallback without a health update')
    assert.strictEqual(bot.isAlive, true)
    bot.end()
  })

  it('respawn: false — stays dead (death screen) until bot.respawn(); respawn() while alive is a no-op', async () => {
    const { bot, client } = await createFakeBot({ respawn: false })
    await replayJoin(bot, client)
    client.clearSent()
    bot.respawn()
    assert.strictEqual(client.sent('respawn').length, 0, 'alive: no-op like upstream')
    die(client)
    assert.strictEqual(bot.isAlive, false)
    assert.strictEqual(client.sent('respawn').length, 0)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'dead')
    let spawned = false
    bot.on('spawn', () => { spawned = true })
    bot.respawn()
    assert.deepStrictEqual(client.sent('respawn').map(p => p.state), [2])
    bot.respawn()
    assert.strictEqual(client.sent('respawn').length, 1, 'once per death')
    ready(client)
    revived(client)
    assert.ok(spawned)
    assert.strictEqual(bot.isAlive, true)
  })

  it('the join respawn packets and the End exit respawn packets are not deaths', async () => {
    const { bot, client } = await createFakeBot()
    let deaths = 0
    bot.on('death', () => deaths++)
    await replayJoin(bot, client)
    assert.strictEqual(client.sent('player_action').filter(p => p.action === 'respawn').length, 0)
    client.clearSent()
    client.receive('respawn', { position: { x: 1, y: -58.38, z: 2 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 1, y: -58.38, z: 2 }, state: 1, runtime_entity_id: 0n })
    assert.strictEqual(client.sent('respawn').length, 0)
    assert.strictEqual(client.sent('player_action').length, 0)
    assert.strictEqual(deaths, 0)
    assert.strictEqual(bot.isAlive, true)
  })

  it('a death in the nether: change_dimension (no loading_screen_id) inside the respawn → no loading screen acks, one respawn, one spawn', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    client.receive('change_dimension', { dimension: 1, position: { x: 8.5, y: 70, z: 8.5 }, respawn: false, loading_screen_id: 3 })
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.strictEqual(bot.game.dimension, 'the_nether')
    const events = record(bot, ['death', 'respawn', 'spawn', 'game'])
    client.clearSent()
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
    client.receive('respawn', { position: { x: 8.5, y: 33.7, z: 8.5 }, state: 0, runtime_entity_id: 0n })
    assert.deepStrictEqual(client.sent('respawn').map(p => p.state), [2])
    // BDS: the overworld spawn is in another dimension
    client.receive('change_dimension', { dimension: 0, position: { x: 1, y: -60, z: 2 }, respawn: false })
    assert.strictEqual(bot._bedrock.lifecycle.state, 'changing_dimension')
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.strictEqual(client.sent('serverbound_loading_screen').length, 0, 'BDS kicks (unexpected_packet) for a loading screen ack here')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'respawning', 'the respawn resumes')
    assert.strictEqual(events.filter(e => e[0] === 'spawn').length, 0, 'no dimension spawn while dead')
    client.receive('respawn', { position: { x: 1, y: -60, z: 2 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 1, y: -58.38, z: 2 }, state: 1, runtime_entity_id: 0n })
    assert.deepStrictEqual(client.sent('player_action').map(p => p.action), ['dimension_change_ack', 'respawn'])
    revived(client)
    assert.deepStrictEqual(events.map(e => e[0]), ['death', 'game', 'respawn', 'spawn'])
    assert.strictEqual(bot.game.dimension, 'overworld')
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
  })

  it('a death during a dimension change: death is emitted, the change completes without spawn, the respawn spawns', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const events = record(bot, ['death', 'respawn', 'spawn'])
    client.receive('change_dimension', { dimension: 1, position: { x: 8.5, y: 70, z: 8.5 }, respawn: false, loading_screen_id: 5 })
    assert.strictEqual(bot.isAlive, false, 'isAlive false during the change (upstream respawn packet)')
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
    assert.deepStrictEqual(events.map(e => e[0]), ['respawn', 'death'])
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.strictEqual(events.filter(e => e[0] === 'spawn').length, 0, 'no spawn while dead')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'dead')
    assert.deepStrictEqual(client.sent('serverbound_loading_screen').slice(-2).map(p => p.loading_screen_id), [5, 5], 'the change itself is acked')
    client.receive('respawn', { position: { x: 8.5, y: 70, z: 8.5 }, state: 0, runtime_entity_id: 0n })
    ready(client)
    revived(client)
    assert.deepStrictEqual(events.map(e => e[0]), ['respawn', 'death', 'respawn', 'spawn'])
    assert.strictEqual(bot.isAlive, true)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
  })

  it('a respawn whose health arrives before the dimension_change_ack spawns after the change completed', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    let spawns = 0
    bot.on('spawn', () => spawns++)
    die(client)
    client.receive('change_dimension', { dimension: 1, position: { x: 1, y: 70, z: 2 }, respawn: false })
    ready(client)
    revived(client)
    assert.strictEqual(spawns, 0, 'still loading the dimension')
    assert.strictEqual(bot.isAlive, true)
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.strictEqual(spawns, 1)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
    assert.strictEqual(client.sent('serverbound_loading_screen').filter(p => p.loading_screen_id === undefined).length, 2, 'only the join acks have no id')
  })
})
