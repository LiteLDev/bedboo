'use strict'
// owner: U9 (player state, world extras & dimensions) — abilities, experience, breath, spawn point, command block,
// ray trace and explosion plugins on the recorded BDS join
const assert = require('assert')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const { xpForLevel, xpToNextLevel, totalPoints } = require('../../lib/plugins/experience')
const { toBigInt } = require('../../lib/plugins/abilities')

const SELF = 91n

describe('player state (U9)', function () {
  this.timeout(30000)

  it('abilities: update_abilities layers at join (li64 unique id), derived per game mode, entity.flying', async () => {
    const { bot, client } = await createFakeBot()
    const seen = []
    bot.on('abilities', (a) => seen.push({ ...a }))
    await replayJoin(bot, client)
    assert.strictEqual(toBigInt([-3, 37]), -12884901851n, 'li64 [high, low] = start_game.entity_id')
    // the capture has two update_abilities: ours ([-3, 37]) and another player's ([-3, 32])
    assert.strictEqual(seen.length, 1, 'only the local player\'s update_abilities')
    assert.deepStrictEqual(
      [bot.abilities.invulnerable, bot.abilities.flying, bot.abilities.mayFly, bot.abilities.instantBuild],
      [false, false, false, false])
    assert.ok(Math.abs(bot.abilities.flyingSpeed - 0.05) < 1e-6)
    assert.ok(Math.abs(bot.abilities.walkingSpeed - 0.1) < 1e-6)
    // a creative player's base layer (BDS: enabled 3583 = invulnerable, may_fly, instant_build), another player's
    const allowedAll = { build: true, mine: true, invulnerable: true, flying: true, may_fly: true, instant_build: true, fly_speed: true, walk_speed: true }
    client.receive('update_abilities', { entity_unique_id: [-3, 38], permission_level: 'member', command_permission: 'normal', abilities: [{ type: 'base', allowed: allowedAll, enabled: { invulnerable: true, may_fly: true, instant_build: true }, fly_speed: 0.05, vertical_fly_speed: 1, walk_speed: 0.1 }] })
    assert.strictEqual(seen.length, 1, 'not ours')
    client.receive('update_abilities', { entity_unique_id: [-3, 37], permission_level: 'operator', command_permission: 'operator', abilities: [{ type: 'base', allowed: allowedAll, enabled: { invulnerable: true, may_fly: true, instant_build: true }, fly_speed: 0.1, vertical_fly_speed: 1, walk_speed: 0.2 }] })
    assert.deepStrictEqual(seen[1], { invulnerable: true, flying: false, mayFly: true, instantBuild: true, flyingSpeed: 0.1, walkingSpeed: 0.2 })
    // a higher layer overrides the flags it allows
    client.receive('update_abilities', {
      entity_unique_id: -12884901851n,
      permission_level: 'operator',
      command_permission: 'operator',
      abilities: [
        { type: 'spectator', allowed: { flying: true }, enabled: { flying: true }, fly_speed: 0, vertical_fly_speed: 0, walk_speed: 0 },
        { type: 'base', allowed: allowedAll, enabled: { may_fly: true }, fly_speed: 0.05, vertical_fly_speed: 1, walk_speed: 0.1 }
      ]
    })
    assert.deepStrictEqual([bot.abilities.flying, bot.abilities.mayFly, bot.abilities.invulnerable], [true, true, false])
    assert.strictEqual(bot.entity.flying, true)

    // game modes (BDS sends no update_abilities for /gamemode): the Java GameType.updatePlayerAbilities rules
    const mode = (gamemode) => client.receive('update_player_game_type', { gamemode, player_unique_id: -12884901851n, tick: 0n })
    mode('survival')
    assert.deepStrictEqual([bot.abilities.flying, bot.abilities.mayFly, bot.abilities.invulnerable, bot.abilities.instantBuild], [false, false, false, false])
    mode('creative')
    assert.deepStrictEqual([bot.abilities.flying, bot.abilities.mayFly, bot.abilities.invulnerable, bot.abilities.instantBuild], [false, true, true, true])
    mode('spectator')
    assert.deepStrictEqual([bot.abilities.flying, bot.abilities.mayFly, bot.abilities.invulnerable, bot.abilities.instantBuild], [true, true, true, false])
    client.receive('update_player_game_type', { gamemode: 'creative', player_unique_id: 1n, tick: 0n })
    assert.strictEqual(bot.abilities.flying, true, "another player's mode")
    assert.strictEqual(seen.length, 6)
  })

  it('experience: level + progress from update_attributes, points from the XP curve, experience event', async () => {
    const { bot, client } = await createFakeBot()
    let events = 0
    bot.on('experience', () => events++)
    assert.deepStrictEqual(bot.experience, { level: null, points: null, progress: null })
    await replayJoin(bot, client)
    assert.deepStrictEqual(bot.experience, { level: 0, points: 0, progress: 0 })
    events = 0
    // the capture's /xp: level 3, progress 3/13
    for (const { name, params } of afterSpawnRecords()) {
      if (name === 'update_attributes' && params.attributes.some(a => a.name === 'minecraft:player.level')) client.receive(name, params)
    }
    assert.strictEqual(events, 1)
    assert.strictEqual(bot.experience.level, 3)
    assert.ok(Math.abs(bot.experience.progress - 3 / 13) < 1e-6)
    assert.strictEqual(bot.experience.points, 30)
    // the curve (minecraft.wiki; identical on Bedrock)
    assert.deepStrictEqual([0, 1, 15, 16, 17, 30, 31, 32, 100].map(xpForLevel), [0, 7, 315, 352, 394, 1395, 1507, 1628, 30970])
    assert.deepStrictEqual([0, 15, 16, 30, 31].map(xpToNextLevel), [7, 37, 42, 112, 121])
    assert.strictEqual(totalPoints(1, 1 / 3), 10)
    client.receive('update_attributes', { runtime_entity_id: SELF, attributes: [{ name: 'minecraft:player.experience', current: 0.5, modifiers: [] }] })
    assert.deepStrictEqual(bot.experience, { level: 3, points: 27 + 7, progress: 0.5 })
    client.receive('update_attributes', { runtime_entity_id: 7n, attributes: [{ name: 'minecraft:player.level', current: 50, modifiers: [] }] })
    assert.strictEqual(bot.experience.level, 3, 'another entity')
  })

  it('breath: the air metadata of the local player → oxygenLevel + breath', async () => {
    const { bot, client } = await createFakeBot()
    const levels = []
    bot.on('breath', () => levels.push(bot.oxygenLevel))
    await replayJoin(bot, client)
    assert.deepStrictEqual(levels, [20], 'join metadata: air 300')
    client.receive('set_entity_data', { runtime_entity_id: SELF, metadata: [{ key: 'air', type: 'short', value: 164 }], tick: 0n })
    client.receive('set_entity_data', { runtime_entity_id: SELF, metadata: [{ key: 'flags', type: 'long', value: { sneaking: false } }], tick: 0n })
    client.receive('set_entity_data', { runtime_entity_id: 8n, metadata: [{ key: 'air', type: 'short', value: 0 }], tick: 0n })
    assert.deepStrictEqual(levels, [20, 11])
    assert.strictEqual(bot.oxygenLevel, 11)
  })

  it('spawn point: start_game world spawn, set_spawn_position world → spawnPoint + game; the player spawn type is not it', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    // start_game.spawn_position (0, 32767, 0): the spawn search height, resolved (U17) to the spawn column's ground once
    // the column is loaded — the flat world's grass at y -61 → -60
    assert.ok(bot.spawnPoint.equals(new Vec3(0, -60, 0)), `start_game.spawn_position ${bot.spawnPoint}`)
    let games = 0
    bot.on('game', () => games++)
    client.receive('set_spawn_position', { spawn_type: 'world', player_position: { x: 1, y: -60, z: 2 }, dimension: 0, world_position: { x: -2147483648, y: -2147483648, z: -2147483648 } })
    assert.ok(bot.spawnPoint.equals(new Vec3(1, -60, 2)))
    assert.strictEqual(games, 1)
    client.receive('set_spawn_position', { spawn_type: 'player', player_position: { x: 40, y: -60, z: 40 }, dimension: 0, world_position: { x: 42, y: -60, z: 40 } })
    assert.ok(bot.spawnPoint.equals(new Vec3(1, -60, 2)))
    assert.strictEqual(games, 1)
  })

  it('setCommandBlock: command_block_update with the Bedrock mode names; creative + command block checks', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const pos = new Vec3(1, -60, 1)
    const Block = require('prismarine-block')(bot.registry)
    bot.world.setBlockStateId(pos, Block.fromProperties('command_block', {}, 0).stateId)
    assert.throws(() => bot.setCommandBlock(pos, '/say hi', false), /creative mode/, 'the fixture world is survival')
    client.receive('set_player_game_type', { gamemode: 'creative' })
    client.clearSent()
    bot.setCommandBlock(pos, '/say hi', false) // upstream's test passes `false`
    bot.setCommandBlock(pos, '/say ho', { mode: 1, alwaysActive: true, trackOutput: true, conditional: true })
    bot.setCommandBlock(pos, '/say hu', { mode: 0 })
    const sent = client.sent('command_block_update')
    assert.deepStrictEqual(sent[0], { is_block: true, position: { x: 1, y: -60, z: 1 }, mode: 'impulse', needs_redstone: true, conditional: false, command: '/say hi', last_output: '', name: '', filtered_name: '', should_track_output: false, tick_delay: 0, execute_on_first_tick: false })
    assert.deepStrictEqual([sent[1].mode, sent[1].needs_redstone, sent[1].conditional, sent[1].should_track_output], ['repeat', false, true, true])
    assert.strictEqual(sent[2].mode, 'chain')
    assert.throws(() => bot.setCommandBlock(pos.offset(0, 1, 0), '/say x', {}), /isn't a command block/)
    // fields Java's packet does not carry keep the block's values (custom name, tick delay, first tick, output)
    client.receive('block_entity_data', { position: { x: 1, y: -60, z: 1 }, nbt: nbt.comp({ id: nbt.string('CommandBlock'), Command: nbt.string('/say hi'), CustomName: nbt.string('Named'), TickDelay: nbt.int(20), ExecuteOnFirstTick: nbt.byte(1), LastOutput: nbt.string('commands.say.ok') }) })
    client.clearSent()
    bot.setCommandBlock(pos, '/say kept')
    const [kept] = client.sent('command_block_update')
    assert.deepStrictEqual([kept.name, kept.tick_delay, kept.execute_on_first_tick, kept.last_output], ['Named', 20, true, 'commands.say.ok'])
  })

  it('ray trace + explosion (vendored upstream plugins) on the flat world', async () => {
    const { bot, client } = await createFakeBot()
    await replayJoin(bot, client)
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    await bot.lookAt(bot.entity.position.offset(0, -3, 0), true)
    const hit = bot.blockAtCursor()
    assert.ok(hit.position.equals(below.position))
    assert.strictEqual(hit.face, 1)
    assert.ok(bot.blockInSight().position.equals(below.position))
    // a level look (pitch 0) facing north (yaw 0) — the default orientation — at a wall (upstream returned null)
    bot.world.setBlockStateId(new Vec3(0, -59, -2), bot.registry.blocksByName.stone.defaultState)
    await bot.look(0, 0, true)
    const wall = bot.blockAtCursor(5)
    assert.ok(wall && wall.name === 'stone' && wall.position.equals(new Vec3(0, -59, -2)), `${wall?.name} ${wall?.position}`)
    await bot.lookAt(bot.entity.position.offset(0, 3, 0), true)
    assert.strictEqual(bot.blockAtCursor(), null)
    assert.strictEqual(bot.blockInSight(), undefined)
    assert.strictEqual(bot.entityAtCursor(), null)

    const pos = bot.entity.position
    assert.strictEqual(bot.getExplosionDamages(bot.entity, pos.offset(0, 0, 20), 4), 0, 'out of range')
    const raw = bot.getExplosionDamages(bot.entity, pos.offset(0, 0, 1), 4, true)
    assert.strictEqual(raw, Math.floor((0.875 * 0.875 + 0.875) * 7 * 4 + 1), 'fully exposed')
    // survival world, difficulty easy (×0.5), no armor attribute on Bedrock → unarmored (upstream: null)
    assert.strictEqual(bot.game.difficulty, 'easy')
    assert.strictEqual(bot.getExplosionDamages(bot.entity, pos.offset(0, 0, 1), 4), Math.floor(raw * 0.5))
    // an armor attribute (U7 synthesizes generic.armor) absorbs damage
    const armored = { ...bot.entity, position: pos, type: 'player', attributes: { 'generic.armor': { value: 20, modifiers: [] }, 'generic.armorToughness': { value: 8, modifiers: [] } } }
    assert.ok(bot.getExplosionDamages(armored, pos.offset(0, 0, 1), 4) < Math.floor(raw * 0.5))
    assert.strictEqual(bot.getExplosionDamages({ position: pos, attributes: {} }, pos.offset(0, 0, 1), 4), null, 'not living: null like upstream')
  })
})
