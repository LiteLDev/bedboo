'use strict'
// owner: U7 (entities & players) — every other entity and player (lib/plugins/entities.js, lib/bedrock/paintings.js,
// the prismarine-entity patch), on a fake client fed with the recorded BDS join (test/fixtures join_flat) and
// synthesized Bedrock packets. The upstream internalTest analogs keep their names (docs/parity/U3-internal-tests.md).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const paintings = require('../../lib/bedrock/paintings')
const { POSITION_OFFSETS, armorTotals } = require('../../lib/plugins/entities')

const EMPTY_ITEM = { network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
const flags = (on = {}) => ({ _value: 0n, onfire: false, sneaking: false, sprinting: false, gliding: false, swimming: false, ...on })
const SELF_RUNTIME = 91n
const SELF_UNIQUE = -12884901851n

async function joined () {
  const created = await createFakeBot()
  const events = []
  created.events = events
  created.record = (...names) => {
    for (const name of names) created.bot.on(name, (...args) => events.push([name, ...args]))
  }
  await replayJoin(created.bot, created.client)
  return created
}

function wireItem (bot, name, count = 1, nbt) {
  const item = { network_id: bot.registry.itemsByName[name].id, count, metadata: 0, has_stack_id: false, block_runtime_id: 0 }
  item.extra = nbt ? { has_nbt: true, nbt: { version: 1, nbt }, can_place_on: [], can_destroy: [] } : { has_nbt: 0, can_place_on: [], can_destroy: [] }
  return item
}

function addEntity (client, { runtimeId, uniqueId, type, position = { x: 1.5, y: -60, z: 1.5 }, yaw = 0, pitch = 0, headYaw = 0, health, metadata = [], links = [] }) {
  const attributes = health === undefined ? [] : [{ name: 'minecraft:health', min: 0, value: health, max: health }, { name: 'minecraft:movement', min: 0, value: 0.25, max: 3.4e38 }]
  client.receive('add_entity', {
    unique_id: uniqueId ?? -runtimeId,
    runtime_id: runtimeId,
    entity_type: `minecraft:${type}`,
    position,
    velocity: { x: 0, y: 0, z: 0 },
    pitch,
    yaw,
    head_yaw: headYaw,
    body_yaw: yaw,
    attributes,
    metadata: [{ key: 'flags', type: 'long', value: flags() }, { key: 'nametag', type: 'string', value: '' }, ...metadata],
    properties: { ints: [], floats: [] },
    links
  })
}

function addPlayer (client, { runtimeId, uniqueId, uuid, username, position = { x: 3.5, y: -60, z: 3.5 }, heldItem = EMPTY_ITEM, metadata = [] }) {
  client.receive('add_player', {
    uuid,
    username,
    runtime_id: runtimeId,
    platform_chat_id: '',
    position,
    velocity: { x: 0, y: 0, z: 0 },
    pitch: 0,
    yaw: 90,
    head_yaw: 90,
    held_item: heldItem,
    gamemode: 'fallback',
    metadata: [{ key: 'flags', type: 'long', value: flags() }, ...metadata],
    properties: { ints: [], floats: [] },
    unique_id: uniqueId, // li64: [high, low]
    permission_level: 'member',
    command_permission: 'normal',
    abilities: [],
    links: [],
    device_id: '',
    device_os: 'Win10'
  })
}

function playerRecord (uuid, username, uniqueId) {
  return { type: 'add', legacy_type: 0, uuid, entity_unique_id: uniqueId, username, xbox_user_id: '', platform_chat_id: '', build_platform: 7, skin_data: {}, is_teacher: false, is_host: false, is_subclient: false, player_color: 0 }
}

const near = (a, b, eps = 1e-4) => Math.abs(a - b) < eps
const nearVec = (v, x, y, z, eps = 1e-4) => near(v.x, x, eps) && near(v.y, y, eps) && near(v.z, z, eps)

describe('entities & players (U7)', function () {
  this.timeout(30000)

  it('internalTest › entity effects', async () => {
    const { bot, client, events, record } = await joined()
    record('entityEffect', 'entityEffectEnd')
    addEntity(client, { runtimeId: 1000n, type: 'creeper', health: 20 })
    const creeper = bot.entities[1000]
    client.receive('mob_effect', { runtime_entity_id: 1000n, event_id: 'add', effect_id: 10, amplifier: 1, particles: true, duration: 200, tick: 0n, ambient: false })
    assert.deepStrictEqual(events, [['entityEffect', creeper, { id: 10, amplifier: 1, duration: 200 }]])
    assert.deepStrictEqual(creeper.effects[10], { id: 10, amplifier: 1, duration: 200 })
    assert.strictEqual(bot.registry.effects[10].name, 'Regeneration')
    client.receive('mob_effect', { runtime_entity_id: 1000n, event_id: 'remove', effect_id: 10, amplifier: 1, particles: true, duration: 0, tick: 0n, ambient: false })
    assert.deepStrictEqual(events[1], ['entityEffectEnd', creeper, { id: 10, amplifier: 1, duration: 200 }])
    assert.strictEqual(creeper.effects[10], undefined)
    assert.strictEqual(bot.entity.effects[10], undefined, "another entity's effect")
  })

  it('internalTest › entities › player displayName', async () => {
    const { bot, client, events, record } = await joined()
    record('playerJoined', 'entitySpawn')
    const uuid = '1f0b6a52-0000-4000-8000-000000000001'
    client.receive('player_list', { records: [playerRecord(uuid, 'Steve', -4294967300n)] })
    const player = bot.players.Steve
    assert.ok(player, 'players[username]')
    assert.strictEqual(player.displayName.toString(), 'Steve')
    assert.strictEqual(player.uuid, uuid)
    assert.strictEqual(bot.uuidToUsername[uuid], 'Steve')
    assert.strictEqual(player.ping, 0)
    assert.strictEqual(player.gamemode, 0, "the world's default (survival in the capture) until add_player / update_player_game_type")
    assert.strictEqual(player.entity, undefined, 'no entity before add_player (like upstream)')
    assert.deepStrictEqual(events, [['playerJoined', player]])
    addPlayer(client, { runtimeId: 1001n, uniqueId: [-2, -4], uuid, username: 'Steve', heldItem: wireItem(bot, 'iron_sword') })
    const entity = bot.entities[1001]
    assert.strictEqual(player.entity, entity)
    assert.deepStrictEqual(events[1], ['entitySpawn', entity])
    assert.strictEqual(entity.type, 'player')
    assert.strictEqual(entity.name, 'player')
    assert.strictEqual(entity.username, 'Steve')
    assert.strictEqual(entity.uuid, uuid)
    assert.strictEqual(entity.uniqueId, -4294967300n, 'li64 [high, low] → BigInt')
    assert.strictEqual(entity.runtimeId, 1001n)
    assert.ok(nearVec(entity.position, 3.5, -60, 3.5), 'add_player is feet level')
    assert.strictEqual(entity.height, 1.8)
    assert.strictEqual(entity.eyeHeight, 1.62)
    assert.strictEqual(entity.heldItem.name, 'iron_sword')
    assert.ok(near(entity.yaw, Math.PI / 2), `yaw ${entity.yaw}`)
    assert.strictEqual(bot.findPlayer('steve'), entity)
    assert.deepStrictEqual(bot.findPlayers(/^St/), [entity])
    assert.deepStrictEqual(bot.findPlayers((e) => e.username === 'nobody'), [])
    assert.strictEqual(bot._playerFromUUID(uuid), player)
  })

  it('internalTest › entities › player_list skin data does not crash', async () => {
    const { bot, client } = await joined() // the capture's player_list carries real skins (raw images)
    assert.strictEqual(bot.players.U0Bot.skinData, undefined)
    assert.strictEqual(bot.players.SmokeT3969.skinData, undefined)
    const malformed = { ...playerRecord('1f0b6a52-0000-4000-8000-000000000002', 'Skinless', -4294967301n), skin_data: { skin_data: { width: 0, height: 0, data: Buffer.alloc(3) }, skin_resource_pack: '{not json' } }
    assert.doesNotThrow(() => client.receive('player_list', { records: [malformed, { type: 'add', uuid: '1f0b6a52-0000-4000-8000-000000000003' }] }))
    assert.strictEqual(bot.players.Skinless.skinData, undefined)
    assert.strictEqual(bot._playerFromUUID('1f0b6a52-0000-4000-8000-000000000003'), undefined, 'a truncated last record (maybeIncompleteArray) is ignored')
  })

  it('internalTest › entities › sets players[player].entity to null upon despawn', async () => {
    const { bot, client, events, record } = await joined()
    // join_flat: SmokeT3969 is in the player list (before start_game for us) and spawned with add_player
    const smoke = bot.players.SmokeT3969
    const entity = bot.entities[70]
    assert.ok(smoke && entity, 'player + entity from the capture')
    assert.strictEqual(smoke.entity, entity)
    assert.strictEqual(entity.uniqueId, -12884901856n)
    record('entityGone', 'playerLeft')
    const rest = afterSpawnRecords()
    for (const { name, params } of rest.slice(0, rest.findIndex(r => r.name === 'player_list') + 1)) client.receive(name, params)
    assert.deepStrictEqual(events.map(e => e[0]), ['entityGone', 'playerLeft'])
    assert.strictEqual(events[0][1], entity)
    assert.strictEqual(events[1][1], smoke)
    assert.strictEqual(smoke.entity, null)
    assert.strictEqual(entity.isValid, false)
    assert.strictEqual(bot.entities[70], undefined)
    assert.strictEqual(bot.players.SmokeT3969, undefined)
    assert.strictEqual(bot.uuidToUsername[smoke.uuid], undefined)
  })

  it('internalTest › entities › metadata', async () => {
    const { bot, client, events, record } = await joined()
    record('entitySpawn', 'entityUpdate')
    addEntity(client, { runtimeId: 1002n, type: 'creeper', health: 20, metadata: [{ key: 'variant', type: 'int', value: 0 }] })
    const creeper = bot.entities[1002]
    assert.deepStrictEqual(events, [['entitySpawn', creeper]])
    assert.strictEqual(creeper.displayName, 'Creeper')
    assert.strictEqual(creeper.name, 'creeper')
    assert.strictEqual(creeper.type, 'hostile')
    assert.strictEqual(creeper.kind, 'Hostile mobs')
    assert.strictEqual(creeper.entityType, bot.registry.entitiesByName.creeper.id)
    assert.strictEqual(creeper.metadata.variant, 0)
    client.receive('set_entity_data', { runtime_entity_id: 1002n, metadata: [{ key: 'creeper_swell', type: 'int', value: 1 }, { key: 'nametag', type: 'string', value: '§aBoom' }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.deepStrictEqual(events[1], ['entityUpdate', creeper])
    assert.strictEqual(creeper.metadata.variant, 0, 'merged')
    assert.strictEqual(creeper.metadata.creeper_swell, 1)
    assert.strictEqual(creeper.getCustomName().toString(), 'Boom')
    assert.strictEqual(creeper.getCustomName().toMotd(), '§aBoom')
    client.receive('set_entity_data', { runtime_entity_id: 1002n, metadata: [{ key: 'nametag', type: 'string', value: '{"text":"Bob"}' }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.strictEqual(creeper.getCustomName().toString(), '{"text":"Bob"}', 'Bedrock name tags are plain text, never JSON')
    client.receive('set_entity_data', { runtime_entity_id: 1002n, metadata: [{ key: 'nametag', type: 'string', value: '' }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.strictEqual(creeper.getCustomName(), null, "'' is no custom name")
  })

  it("internalTest › entities › 'itemDrop' event", async () => {
    const { bot, client, events, record } = await joined()
    record('entitySpawn', 'itemDrop')
    client.receive('add_item_entity', {
      entity_id_self: -7000n,
      runtime_entity_id: 1003n,
      item: wireItem(bot, 'diamond', 5),
      position: { x: 4.25, y: -59.875, z: -3.5 },
      velocity: { x: 0, y: 0.2, z: 0 },
      metadata: [{ key: 'flags', type: 'long', value: flags() }],
      is_from_fishing: false
    })
    const item = bot.entities[1003]
    assert.deepStrictEqual(events, [['entitySpawn', item], ['itemDrop', item]])
    assert.strictEqual(item.name, 'item')
    assert.strictEqual(item.displayName, 'Item')
    assert.ok(nearVec(item.position, 4.25, -60, -3.5), `items are 0.125 above their feet on the wire: ${item.position}`)
    const dropped = item.getDroppedItem()
    assert.strictEqual(dropped.name, 'diamond')
    assert.strictEqual(dropped.count, 5)
    assert.strictEqual(bot.entity.getDroppedItem(), null, 'not an item')
  })

  it('positions: add_entity offsets, move_entity / move_entity_delta (absolute, optional, byte rotations), move_player eye level', async () => {
    const { bot, client, events, record } = await joined()
    record('entityMoved')
    addEntity(client, { runtimeId: 1004n, type: 'boat', position: { x: 6.7, y: -59.625, z: 6.7 } })
    addEntity(client, { runtimeId: 1005n, type: 'zombie', health: 20, position: { x: 2.5, y: -60, z: 0.5 }, yaw: 90, pitch: -10, headYaw: 45 })
    addEntity(client, { runtimeId: 1006n, type: 'tnt', position: { x: 0.5, y: -59.51, z: 0.5 } })
    const boat = bot.entities[1004]
    const zombie = bot.entities[1005]
    assert.strictEqual(POSITION_OFFSETS.boat, 0.375)
    assert.ok(nearVec(boat.position, 6.7, -60, 6.7), `boat ${boat.position}`)
    assert.ok(nearVec(bot.entities[1006].position, 0.5, -60, 0.5), 'tnt +0.49')
    assert.ok(nearVec(zombie.position, 2.5, -60, 0.5))
    assert.ok(near(zombie.yaw, Math.PI / 2) && near(zombie.pitch, 10 * Math.PI / 180) && near(zombie.headYaw, Math.PI * 3 / 4))
    client.receive('move_entity_delta', { runtime_entity_id: 1005n, x: 3, z: 1, rot_y: 128, on_ground: true, force_move: false, force_move_local_entity: false, force_completion: false, ticks: 0n })
    assert.ok(nearVec(zombie.position, 3, -60, 1), 'y unchanged when absent')
    assert.ok(near(zombie.yaw, 0), `rot_y 128 = 180° → yaw 0 (${zombie.yaw})`)
    assert.ok(near(zombie.pitch, 10 * Math.PI / 180), 'pitch unchanged')
    client.receive('move_entity_delta', { runtime_entity_id: 1004n, y: -59.125, on_ground: false, force_move: false, force_move_local_entity: false, force_completion: false, ticks: 0n })
    assert.ok(nearVec(boat.position, 6.7, -59.5, 6.7), 'boat delta y − 0.375')
    client.receive('move_entity', { runtime_entity_id: 1005n, flags: 1, position: { x: 5.5, y: -59, z: -4.5 }, rotation: { yaw: 270, pitch: 0, head_yaw: 270 } })
    assert.ok(nearVec(zombie.position, 5.5, -59, -4.5) && zombie.onGround && near(zombie.yaw, Math.PI * 3 / 2))
    // another player: move_player is eye level
    client.receive('player_list', { records: [playerRecord('1f0b6a52-0000-4000-8000-000000000004', 'Alex', -4294967302n)] })
    addPlayer(client, { runtimeId: 1007n, uniqueId: [-2, -6], uuid: '1f0b6a52-0000-4000-8000-000000000004', username: 'Alex' })
    client.receive('move_player', { runtime_id: 1007, position: { x: 3.5, y: -57.38, z: 3.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'normal', on_ground: true, ridden_runtime_id: 0, tick: 5n })
    assert.ok(nearVec(bot.entities[1007].position, 3.5, -59, 3.5), `player feet ${bot.entities[1007].position}`)
    assert.deepStrictEqual(events.map(e => e[1].id), [1005, 1004, 1005, 1007])
    // the local player and unknown ids are not ours / ignored
    const before = bot.entity.position.clone()
    client.receive('move_entity_delta', { runtime_entity_id: SELF_RUNTIME, x: 99, on_ground: true, force_move: false, force_move_local_entity: false, force_completion: false, ticks: 0n })
    client.receive('move_entity_delta', { runtime_entity_id: 4242n, x: 99, on_ground: true, force_move: false, force_move_local_entity: false, force_completion: false, ticks: 0n })
    assert.deepStrictEqual(bot.entity.position, before)
    assert.strictEqual(bot.entities[4242], undefined, 'no ghost entities')
    assert.strictEqual(events.length, 4)
  })

  it('entity_event / animate → hurt, dead (+ the killing blow), taming, tamed, shaking, eating grass, eat, swing, wake, critical', async () => {
    const { bot, client, events, record } = await joined()
    record('entityHurt', 'entityDead', 'entityTaming', 'entityTamed', 'entityShakingOffWater', 'entityEatingGrass', 'entityEat', 'entitySwingArm', 'entityWake', 'entityCriticalEffect', 'entityMagicCriticalEffect')
    addEntity(client, { runtimeId: 1010n, type: 'wolf', health: 8 })
    const wolf = bot.entities[1010]
    const ev = (id, data = 0) => client.receive('entity_event', { runtime_entity_id: 1010n, event_id: id, data })
    ev('hurt_animation', 2)
    ev('tame_fail')
    ev('tame_success')
    ev('shake_wet')
    ev('eat_grass_animation')
    ev('eating_item', 27394048)
    ev('arm_swing')
    ev('love_particles') // not a mineflayer event
    client.receive('animate', { action_id: 'critical_hit', runtime_entity_id: 1010n, data: 0, has_swing_source: false })
    client.receive('animate', { action_id: 'magic_critical_hit', runtime_entity_id: 1010n, data: 0, has_swing_source: false })
    client.receive('animate', { action_id: 'swing_arm', runtime_entity_id: 1010n, data: 0, has_swing_source: true, swing_source: 'attack' })
    client.receive('animate', { action_id: 'wake_up', runtime_entity_id: 1010n, data: 0, has_swing_source: false })
    ev('hurt_animation')
    ev('death_animation') // same packet batch (server tick) as the hurt: no extra entityHurt
    assert.deepStrictEqual(events.map(e => e[0]), ['entityHurt', 'entityTaming', 'entityTamed', 'entityShakingOffWater', 'entityEatingGrass', 'entityEat',
      'entitySwingArm', 'entityCriticalEffect', 'entityMagicCriticalEffect', 'entitySwingArm', 'entityWake', 'entityHurt', 'entityDead'])
    assert.ok(events.every(e => e[1] === wolf))
    // a killing blow alone (BDS: death_animation only, a batch after the last hurt) → entityHurt, entityDead
    events.length = 0
    addEntity(client, { runtimeId: 1011n, type: 'zombie', health: 20 })
    client.receive('entity_event', { runtime_entity_id: 1011n, event_id: 'hurt_animation', data: 2 })
    await new Promise(resolve => setImmediate(resolve)) // next packet batch
    client.receive('entity_event', { runtime_entity_id: 1011n, event_id: 'death_animation', data: 0 })
    assert.deepStrictEqual(events.map(e => [e[0], e[1].id]), [['entityHurt', 1011], ['entityHurt', 1011], ['entityDead', 1011]])
    // the local player: hurt / dead yes, its own swing is never echoed (Java does not send it)
    events.length = 0
    client.receive('animate', { action_id: 'swing_arm', runtime_entity_id: SELF_RUNTIME, data: 0, has_swing_source: true, swing_source: 'interact' })
    client.receive('entity_event', { runtime_entity_id: SELF_RUNTIME, event_id: 'hurt_animation', data: -1 })
    assert.deepStrictEqual(events, [['entityHurt', bot.entity]])
  })

  it('set_entity_data of others: crouch / uncrouch (hitbox), elytra, sleep (player_flags) / wake, sprinting', async () => {
    const { bot, client, events, record } = await joined()
    record('entityCrouch', 'entityUncrouch', 'entityElytraFlew', 'entitySleep', 'entityWake')
    client.receive('player_list', { records: [playerRecord('1f0b6a52-0000-4000-8000-000000000005', 'Sneaky', -4294967303n)] })
    addPlayer(client, { runtimeId: 1012n, uniqueId: [-2, -7], uuid: '1f0b6a52-0000-4000-8000-000000000005', username: 'Sneaky' })
    const p = bot.entities[1012]
    const data = (metadata) => client.receive('set_entity_data', { runtime_entity_id: 1012n, metadata, properties: { ints: [], floats: [] }, tick: 0n })
    data([{ key: 'flags', type: 'long', value: flags() }])
    assert.deepStrictEqual(events, [], 'no uncrouch for a player that never crouched')
    data([{ key: 'flags', type: 'long', value: flags({ sneaking: true, sprinting: true }) }])
    assert.strictEqual(p.crouching, true)
    assert.strictEqual(p.sprinting, true)
    assert.strictEqual(p.height, 1.5)
    assert.strictEqual(p.eyeHeight, 1.27)
    data([{ key: 'flags', type: 'long', value: flags({ gliding: true }) }])
    assert.strictEqual(p.crouching, false)
    assert.strictEqual(p.height, 1.8)
    assert.strictEqual(p.elytraFlying, true)
    data([{ key: 'player_flags', type: 'byte', value: 2 }, { key: 'flags_extended', type: 'long', value: { _value: 0n, sleeping: false } }])
    assert.strictEqual(p.sleeping, true)
    data([{ key: 'flags_extended', type: 'long', value: { _value: 0n, sleeping: false } }])
    assert.strictEqual(p.sleeping, true, 'flags_extended does not decide for players')
    data([{ key: 'player_flags', type: 'byte', value: 0 }])
    client.receive('animate', { action_id: 'wake_up', runtime_entity_id: 1012n, data: 0, has_swing_source: false }) // already reported
    // upstream order within one metadata packet: elytra state, then crouch
    assert.deepStrictEqual(events.map(e => e[0]), ['entityCrouch', 'entityElytraFlew', 'entityUncrouch', 'entitySleep', 'entityWake'])
    // a fox uses the same sneaking flag (stalking): events, but its registry hitbox stays
    addEntity(client, { runtimeId: 1015n, type: 'fox', health: 20 })
    const fox = bot.entities[1015]
    const height = fox.height
    client.receive('set_entity_data', { runtime_entity_id: 1015n, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true }) }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.strictEqual(fox.crouching, true)
    assert.strictEqual(fox.height, height)
    assert.strictEqual(fox.eyeHeight, undefined)
  })

  it('update_attributes / set_entity_motion of others; synthesized armor attributes from equipment', async () => {
    const { bot, client, events, record } = await joined()
    record('entityAttributes', 'entityEquip')
    addEntity(client, { runtimeId: 1013n, type: 'zombie', health: 20 })
    const zombie = bot.entities[1013]
    assert.strictEqual(zombie.health, 20)
    assert.strictEqual(zombie.attributes['minecraft:max_health'].value, 20)
    assert.deepStrictEqual(zombie.attributes['generic.armor'], { value: 0, modifiers: [] })
    client.receive('update_attributes', { runtime_entity_id: 1013n, attributes: [{ min: 0, max: 20, current: 13, default_min: 0, default_max: 20, default: 20, name: 'minecraft:health', modifiers: [] }], tick: 0n })
    assert.strictEqual(zombie.health, 13)
    assert.deepStrictEqual(events, [['entityAttributes', zombie]])
    client.receive('set_entity_motion', { runtime_entity_id: 1013n, velocity: { x: 0.1, y: 0.3, z: 0 }, tick: 0n })
    assert.deepStrictEqual(zombie.velocity, new Vec3(0.1, 0.3, 0))
    client.receive('mob_equipment', { runtime_entity_id: 1013n, item: wireItem(bot, 'iron_sword'), slot: 0, selected_slot: 0, window_id: 'inventory' })
    client.receive('mob_equipment', { runtime_entity_id: 1013n, item: wireItem(bot, 'shield'), slot: 1, selected_slot: 1, window_id: 'offhand' })
    client.receive('mob_armor_equipment', { runtime_entity_id: 1013n, helmet: wireItem(bot, 'diamond_helmet'), chestplate: wireItem(bot, 'iron_chestplate'), leggings: EMPTY_ITEM, boots: wireItem(bot, 'leather_boots'), body: EMPTY_ITEM })
    assert.deepStrictEqual(events.slice(1).map(e => e[0]), ['entityEquip', 'entityEquip', 'entityEquip'])
    assert.strictEqual(zombie.heldItem.name, 'iron_sword')
    assert.strictEqual(zombie.equipment[1].name, 'shield')
    assert.deepStrictEqual(zombie.equipment.slice(2).map(i => i?.name ?? null), ['leather_boots', null, 'iron_chestplate', 'diamond_helmet', null])
    assert.strictEqual(zombie.attributes['generic.armor'].value, 3 + 6 + 1)
    assert.strictEqual(zombie.attributes['generic.armorToughness'].value, 2)
    assert.strictEqual(zombie.attributes['minecraft:armor'].value, 10)
    assert.deepStrictEqual(armorTotals([]), { armor: 0, toughness: 0 })
    // the local player's armor comes from its (live) equipment view
    assert.deepStrictEqual(bot.entity.attributes['generic.armor'], { value: 0, modifiers: [] })
    // non-living entities have no armor attribute (upstream explosion returns null for them)
    addEntity(client, { runtimeId: 1014n, type: 'boat' })
    assert.strictEqual(bot.entities[1014].attributes['generic.armor'], undefined)
  })

  it('set_entity_link → entityAttach / entityDetach, bot.vehicle + mount / dismount, vehicle gone', async () => {
    const { bot, client, events, record } = await joined()
    record('entityAttach', 'entityDetach', 'mount', 'dismount')
    addEntity(client, { runtimeId: 1020n, uniqueId: -8000n, type: 'boat' })
    addEntity(client, { runtimeId: 1021n, uniqueId: -8001n, type: 'pig', health: 10 })
    const boat = bot.entities[1020]
    const pig = bot.entities[1021]
    const link = (ridden, rider, type) => client.receive('set_entity_link', { link: { ridden_entity_id: ridden, rider_entity_id: rider, type, immediate: false, rider_initiated: true, angular_velocity: 0 } })
    link(-8000n, -8001n, 1)
    assert.strictEqual(pig.vehicle, boat)
    assert.deepStrictEqual(boat.passengers, [pig])
    link(-8000n, SELF_UNIQUE, 2)
    assert.strictEqual(bot.vehicle, boat)
    assert.deepStrictEqual(boat.passengers, [pig, bot.entity])
    link(-8000n, SELF_UNIQUE, 2) // repeated
    link(-8000n, SELF_UNIQUE, 0)
    assert.strictEqual(bot.vehicle, null)
    assert.strictEqual(bot.entity.vehicle, null)
    assert.deepStrictEqual(boat.passengers, [pig])
    assert.deepStrictEqual(events.map(e => e[0]), ['entityAttach', 'entityAttach', 'mount', 'entityDetach', 'dismount'])
    assert.deepStrictEqual(events[1].slice(1), [bot.entity, boat])
    assert.deepStrictEqual(events[3].slice(1), [bot.entity, boat])
    assert.deepStrictEqual(events[4].slice(1), [boat])
    // the vehicle is removed while the bot rides it → dismount(vehicle)
    events.length = 0
    link(-8000n, SELF_UNIQUE, 1)
    client.receive('remove_entity', { entity_id_self: -8000n })
    assert.strictEqual(bot.vehicle, null)
    assert.strictEqual(pig.vehicle, null)
    assert.deepStrictEqual(events.map(e => e[0]), ['entityAttach', 'mount', 'dismount'])
    // links of add_entity: spawned riding
    events.length = 0
    addEntity(client, { runtimeId: 1022n, uniqueId: -8002n, type: 'minecart' })
    addEntity(client, { runtimeId: 1023n, uniqueId: -8003n, type: 'zombie', health: 20, links: [{ ridden_entity_id: -8002n, rider_entity_id: -8003n, type: 1, immediate: true, rider_initiated: false, angular_velocity: 0 }] })
    assert.strictEqual(bot.entities[1023].vehicle, bot.entities[1022])
    assert.deepStrictEqual(events.map(e => e[0]), ['entityAttach'])
  })

  it('take_item_entity → playerCollect(collector, collected) with the dropped item; remove_entity → entityGone', async () => {
    const { bot, client, events, record } = await joined()
    record('playerCollect', 'entityGone')
    client.receive('add_item_entity', { entity_id_self: -7100n, runtime_entity_id: 1030n, item: wireItem(bot, 'dirt', 3), position: { x: 0.5, y: -59.875, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, metadata: [], is_from_fishing: false })
    const item = bot.entities[1030]
    client.receive('take_item_entity', { runtime_entity_id: 1030n, target: Number(SELF_RUNTIME) })
    client.receive('remove_entity', { entity_id_self: -7100n })
    assert.deepStrictEqual(events.map(e => e[0]), ['playerCollect', 'entityGone'])
    assert.strictEqual(events[0][1], bot.entity)
    assert.strictEqual(events[0][2], item)
    assert.strictEqual(events[0][2].getDroppedItem().count, 3)
    assert.strictEqual(bot._bedrock.ids.uniqueToRuntime.has(-7100n), false, 'unique ↔ runtime forgotten')
  })

  it('add_painting → painting entity + mineflayer Painting in the world (blockAt(…, true).painting); removal', async () => {
    const { bot, client, events, record } = await joined()
    record('entitySpawn', 'entityGone')
    client.receive('add_painting', { entity_id_self: -7200n, runtime_entity_id: 1040n, coordinates: { x: 0.5, y: -58.5, z: -2.96875 }, direction: 0, title: 'SkullAndRoses' })
    const entity = bot.entities[1040]
    assert.strictEqual(entity.name, 'painting')
    const painting = bot._bedrock.world.paintings.byId[1040]
    assert.strictEqual(painting.name, 'skull_and_roses')
    assert.deepStrictEqual(painting.position, new Vec3(0, -59, -3))
    assert.deepStrictEqual(painting.direction, new Vec3(0, 0, -1))
    assert.strictEqual(bot.blockAt(new Vec3(0, -59, -3), true).painting, painting)
    client.receive('remove_entity', { entity_id_self: -7200n })
    assert.strictEqual(bot._bedrock.world.paintings.byId[1040], undefined)
    assert.deepStrictEqual(events.map(e => e[0]), ['entitySpawn', 'entityGone'])
    assert.strictEqual(paintings.motiveName('Kebab'), 'kebab')
    assert.strictEqual(paintings.motiveName('DonkeyKong'), 'donkey_kong')
    assert.strictEqual(paintings.motiveName('prairie_ride'), 'prairie_ride')
    assert.strictEqual(paintings.fromAddPainting({ runtime_entity_id: 5n, coordinates: { x: 1, y: 2.5, z: 3.03 }, direction: 3, title: 'Pool' }).direction.x, 1)
  })

  it('player_list: before start_game (applied after the reset), playerUpdated, gamemode updates, playerLeft', async () => {
    const created = await createFakeBot()
    const { bot, client } = created
    const joinedPlayers = []
    bot.on('playerJoined', (p) => joinedPlayers.push(p.username))
    await replayJoin(bot, client)
    // the capture: U0Bot's record before start_game, then U0Bot + SmokeT3969
    assert.deepStrictEqual(joinedPlayers, ['U0Bot', 'SmokeT3969'])
    assert.strictEqual(bot.player, bot.players.U0Bot)
    assert.strictEqual(bot.player.entity, bot.entity)
    const updated = []
    bot.on('playerUpdated', (p) => updated.push([p.username, p.gamemode]))
    client.receive('update_player_game_type', { gamemode: 'survival', player_unique_id: -12884901856n, tick: 0n })
    client.receive('update_player_game_type', { gamemode: 'adventure', player_unique_id: SELF_UNIQUE, tick: 0n })
    assert.deepStrictEqual(updated, [['SmokeT3969', 0], ['U0Bot', 2]])
    const left = []
    bot.on('playerLeft', (p) => left.push(p.username))
    client.receive('player_list', { records: [{ type: 'remove', legacy_type: 0, uuid: bot.player.uuid }] })
    assert.deepStrictEqual(left, [], 'the bot itself never leaves')
  })

  it('actions: attack / useOn / mount / dismount / swingArm packets', async () => {
    const { bot, client } = await joined()
    addEntity(client, { runtimeId: 1050n, type: 'zombie', health: 20, position: { x: 2.5, y: -60, z: 0.5 } })
    const zombie = bot.entities[1050]
    client.clearSent()
    bot.attack(zombie)
    const sent = client.written.map(([, name, params]) => [name, params])
    assert.deepStrictEqual(sent.map(s => s[0]), ['animate', 'interact', 'inventory_transaction'])
    assert.deepStrictEqual(sent[0][1], { action_id: 'swing_arm', runtime_entity_id: SELF_RUNTIME, data: 0, has_swing_source: true, swing_source: 'attack' })
    assert.strictEqual(sent[1][1].action_id, 'mouse_over_entity')
    assert.strictEqual(sent[1][1].target_entity_id, 1050n)
    const tx = sent[2][1].transaction
    assert.strictEqual(tx.transaction_type, 'item_use_on_entity')
    assert.strictEqual(tx.transaction_data.action_type, 'attack')
    assert.strictEqual(tx.transaction_data.entity_runtime_id, 1050n)
    assert.ok(near(tx.transaction_data.click_pos.y, zombie.height / 2), 'clicked position relative to the feet')
    assert.ok(near(bot.entity.yaw, -Math.PI / 2, 0.01), `the bot faces the target (${bot.entity.yaw})`)
    client.clearSent()
    bot.attack(zombie, false)
    assert.deepStrictEqual(client.written.map(w => w[1]), ['inventory_transaction'], 'no swing, no repeated hover')
    client.clearSent()
    bot.useOn(zombie)
    bot.mount(zombie)
    assert.deepStrictEqual(client.sent('inventory_transaction').map(p => p.transaction.transaction_data.action_type), ['interact', 'interact'])
    client.clearSent()
    bot.swingArm()
    bot.swingArm('left', false)
    assert.deepStrictEqual(client.sent('animate'), [
      { action_id: 'swing_arm', runtime_entity_id: SELF_RUNTIME, data: 0, has_swing_source: false },
      { action_id: 'swing_arm', runtime_entity_id: SELF_RUNTIME, data: 0, has_swing_source: false }
    ])
    // dismount
    const errors = []
    bot.on('error', (err) => errors.push(err.message))
    bot.dismount()
    assert.deepStrictEqual(errors, ['dismount: not mounted'])
    addEntity(client, { runtimeId: 1051n, uniqueId: -8100n, type: 'boat' })
    client.receive('set_entity_link', { link: { ridden_entity_id: -8100n, rider_entity_id: SELF_UNIQUE, type: 1, immediate: false, rider_initiated: true, angular_velocity: 0 } })
    client.clearSent()
    bot.dismount()
    assert.deepStrictEqual(client.sent('interact'), [{ action_id: 'leave_vehicle', target_entity_id: 1051n, has_position: false }])
    assert.strictEqual(bot.attack.length, 1)
    assert.strictEqual(bot.swingArm.length, 0)
    // moveVehicle is the physics plugin's (U5, input.setVehicle; tested in physics.test.js)
    assert.ok(!bot.moveVehicle.notImplemented && bot.moveVehicle.length === 2, 'moveVehicle is implemented by the physics plugin (U5)')
  })

  it('nearestEntity skips the bot; unknown entity types; xp orbs; dimension change drops the entities', async () => {
    const { bot, client, events, record } = await joined()
    addEntity(client, { runtimeId: 1060n, type: 'xp_orb', position: { x: 0.6, y: -60, z: 0.5 }, metadata: [{ key: 'experience_value', type: 'int', value: 7 }] })
    addEntity(client, { runtimeId: 1061n, type: 'pig', health: 10, position: { x: 0.5, y: -60, z: 4 } })
    client.receive('add_entity', { unique_id: -1062n, runtime_id: 1062n, entity_type: 'mypack:dragon', position: { x: 1, y: -60, z: 1 }, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0, body_yaw: 0, attributes: [], metadata: [], properties: { ints: [], floats: [] }, links: [] })
    assert.strictEqual(bot.entities[1060].count, 7)
    assert.strictEqual(bot.entities[1060].name, 'xp_orb')
    assert.strictEqual(bot.nearestEntity(), bot.entities[70], 'the capture\'s SmokeT3969 stands on the spawn like the bot (never the bot itself)')
    assert.strictEqual(bot.nearestEntity(e => e.type !== 'player'), bot.entities[1060])
    assert.strictEqual(bot.nearestEntity(e => e.name === 'pig'), bot.entities[1061])
    const dragon = bot.entities[1062]
    assert.deepStrictEqual([dragon.type, dragon.name, dragon.displayName, dragon.entityType], ['other', 'unknown', 'unknown', 'mypack:dragon'])
    record('entityGone')
    bot._bedrock.lifecycle.events.emit('dimensionChange', { dimension: 'the_nether' })
    assert.ok(events.length >= 3)
    assert.deepStrictEqual(Object.values(bot.entities), [bot.entity])
    assert.strictEqual(bot._bedrock.ids.isSelf(SELF_RUNTIME), true)
    assert.strictEqual(bot._bedrock.ids.entityIdFromUnique(SELF_UNIQUE), Number(SELF_RUNTIME))
  })

  it('fireworks boosting the bot while it glides → usedFirework + fireworkRocketDuration', async () => {
    const { bot, client, events, record } = await joined()
    record('usedFirework')
    const nbt = { type: 'compound', name: '', value: { Fireworks: { type: 'compound', value: { Flight: { type: 'byte', value: 2 }, Explosions: { type: 'list', value: { type: 'end', value: [] } } } } } }
    const rocket = (runtimeId) => addEntity(client, { runtimeId, type: 'fireworks_rocket', metadata: [{ key: 'owner_eid', type: 'long', value: SELF_UNIQUE }, { key: 'minecart_display_block', type: 'compound', value: nbt }] })
    rocket(1070n)
    assert.deepStrictEqual(events, [], 'not gliding: a fired rocket, not a boost')
    client.receive('set_entity_data', { runtime_entity_id: SELF_RUNTIME, metadata: [{ key: 'flags', type: 'long', value: flags({ gliding: true }) }], properties: { ints: [], floats: [] }, tick: 0n })
    rocket(1071n)
    assert.deepStrictEqual(events, [['usedFirework', 1071]])
    assert.ok(bot.fireworkRocketDuration >= 30 && bot.fireworkRocketDuration <= 41, `duration ${bot.fireworkRocketDuration}`)
    client.receive('set_entity_data', { runtime_entity_id: 1071n, metadata: [{ key: 'owner_eid', type: 'long', value: SELF_UNIQUE }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.strictEqual(events.length, 1, 'once per rocket')
  })
})
