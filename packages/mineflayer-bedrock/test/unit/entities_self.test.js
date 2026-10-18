'use strict'
// owner: U4 (core runtime) — the local player entity (entities.js self part + lib/bedrock/entity_data.js)
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const { baseValue } = require('../../lib/bedrock/entity_data')

async function joined () {
  const created = await createFakeBot()
  const spawned = []
  created.bot.on('entitySpawn', (e) => spawned.push(e))
  await replayJoin(created.bot, created.client)
  created.spawned = spawned
  return created
}

const flags = (on) => ({ _value: 0n, onfire: false, sneaking: false, sprinting: false, gliding: false, swimming: false, ...on })

describe('local player entity (U4)', function () {
  this.timeout(30000)

  it('internalTest › entities › entity id from start_game', async () => {
    const { bot, spawned } = await joined()
    assert.strictEqual(bot.entity.id, 91, 'Number(start_game.runtime_entity_id)')
    assert.strictEqual(bot.entity.uniqueId, -12884901851n)
    assert.strictEqual(bot.entities[91], bot.entity)
    assert.strictEqual(bot.entity.type, 'player')
    assert.strictEqual(bot.entity.name, 'player')
    assert.strictEqual(bot.entity.username, 'U0Bot')
    assert.strictEqual(bot.username, 'U0Bot')
    assert.strictEqual(bot.entity.height, 1.8)
    assert.strictEqual(bot.entity.width, 0.6)
    assert.strictEqual(bot.entity.eyeHeight, 1.62)
    assert.ok(bot.entity.velocity instanceof Vec3)
    assert.deepStrictEqual(spawned, [bot.entity], "entitySpawn(bot.entity) on 'spawn'")
    // self player record from player_list
    assert.strictEqual(bot.player, bot.players.U0Bot)
    assert.strictEqual(bot.player.uuid, '103594cd-1da0-2ec6-fb7c-32af2c646f85')
    assert.strictEqual(bot.player.entity, bot.entity)
    assert.strictEqual(bot.player.displayName.toString(), 'U0Bot')
    assert.strictEqual(bot.uuidToUsername[bot.player.uuid], 'U0Bot')
    assert.ok(Array.isArray(bot.entity.equipment) && bot.entity.equipment.length === 6)
  })

  it('update_attributes → attributes keyed by Java resource names, base values (modifiers removed), entityAttributes', async () => {
    const { bot } = await joined()
    const attrs = bot.entity.attributes
    assert.ok(Math.abs(attrs['minecraft:movement_speed'].value - 0.1) < 1e-6)
    assert.strictEqual(attrs['minecraft:max_health'].value, 20)
    assert.strictEqual(attrs['minecraft:follow_range'].value, 16)
    assert.ok(attrs['minecraft:underwater_movement'], 'Bedrock-only attributes keep their Bedrock name')
    let updates = 0
    bot.on('entityAttributes', (e) => { assert.strictEqual(e, bot.entity); updates++ })
    const speed = afterSpawnRecords().find(r => r.name === 'update_attributes' && r.params.attributes[0].name === 'minecraft:movement').params
    bot._client.receive('update_attributes', speed) // Speed II: current 0.14 with a +40 % multiply_total modifier
    assert.strictEqual(updates, 1)
    const movement = attrs['minecraft:movement_speed']
    assert.ok(Math.abs(movement.value - 0.1) < 1e-6, `base ${movement.value}`)
    assert.ok(Math.abs(movement.current - 0.14) < 1e-6)
    assert.deepStrictEqual(movement.modifiers.map(m => [m.operation, Math.round(m.amount * 10) / 10]), [[2, 0.4]])
    assert.strictEqual(movement.modifiers[0].uuid, '91aeaa56-376b-4498-935b-2f7f68070635')
    assert.ok(Math.abs(baseValue(1.5, [{ operation: 0, amount: 0.5 }]) - 1) < 1e-9)
    assert.ok(Math.abs(baseValue(3, [{ operation: 1, amount: 0.5 }, { operation: 0, amount: 1 }]) - 1) < 1e-9)
    // other entities are U7's
    bot._client.receive('update_attributes', { ...speed, runtime_entity_id: 5n })
    assert.strictEqual(updates, 1)
  })

  it('mob_effect → effects keyed by Bedrock id (registry.effects names), entityEffect / entityEffectEnd', async () => {
    const { bot, client } = await joined()
    const events = []
    bot.on('entityEffect', (e, effect) => events.push(['add', effect]))
    bot.on('entityEffectEnd', (e, effect) => events.push(['end', effect]))
    const recorded = afterSpawnRecords().find(r => r.name === 'mob_effect').params
    client.receive('mob_effect', recorded)
    assert.deepStrictEqual(bot.entity.effects[1], { id: 1, amplifier: 1, duration: 600 })
    assert.strictEqual(bot.registry.effects[1].name, 'Speed')
    client.receive('mob_effect', { ...recorded, event_id: 'remove' })
    assert.strictEqual(bot.entity.effects[1], undefined)
    client.receive('mob_effect', { ...recorded, event_id: 'remove', effect_id: 4 })
    assert.deepStrictEqual(events, [['add', { id: 1, amplifier: 1, duration: 600 }], ['end', { id: 1, amplifier: 1, duration: 600 }], ['end', { id: 4, amplifier: -1, duration: -1 }]])
  })

  it('set_entity_data → metadata (Bedrock keys) and flags: crouching, elytraFlying, sprinting, sleeping events', async () => {
    const { bot, client } = await joined()
    const events = []
    for (const e of ['entityUpdate', 'entityCrouch', 'entityUncrouch', 'entityElytraFlew', 'entitySleep', 'entityWake']) bot.on(e, () => events.push(e))
    client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true, sprinting: true }) }, { key: 'air', type: 'short', value: 300 }], tick: 1n })
    assert.strictEqual(bot.entity.crouching, true)
    assert.strictEqual(bot.entity.sprinting, true)
    assert.strictEqual(bot.entity.metadata.air, 300)
    client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'flags', type: 'long', value: flags({ gliding: true }) }], tick: 2n })
    assert.strictEqual(bot.entity.crouching, false)
    assert.strictEqual(bot.entity.elytraFlying, true)
    client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'flags_extended', type: 'long', value: { _value: 0n, sleeping: true } }], tick: 3n })
    client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'flags_extended', type: 'long', value: { _value: 0n, sleeping: false } }], tick: 4n })
    assert.deepStrictEqual(events, ['entityUpdate', 'entityCrouch', 'entityUpdate', 'entityUncrouch', 'entityElytraFlew', 'entityUpdate', 'entitySleep', 'entityUpdate', 'entityWake'])
    client.receive('set_entity_data', { runtime_entity_id: 7n, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true }) }], tick: 5n })
    assert.strictEqual(bot.entity.crouching, false, "another entity's metadata")
  })

  it('set_entity_motion → velocity; set_health → entity.health', async () => {
    const { bot, client } = await joined()
    client.receive('set_entity_motion', { runtime_entity_id: 91n, velocity: { x: 0.1, y: 0.4, z: -0.2 }, tick: 1n })
    assert.deepStrictEqual(bot.entity.velocity, new Vec3(0.1, 0.4, -0.2))
    client.receive('set_entity_motion', { runtime_entity_id: 92n, velocity: { x: 9, y: 9, z: 9 }, tick: 1n })
    assert.deepStrictEqual(bot.entity.velocity, new Vec3(0.1, 0.4, -0.2))
    client.receive('set_health', { health: 13 })
    assert.strictEqual(bot.entity.health, 13)
  })
})
