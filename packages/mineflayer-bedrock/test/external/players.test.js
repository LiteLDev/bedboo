// owner: U7 (entities & players)
'use strict'
/**
 * Other players against a real BDS 1.26.51.1 (Bedrock extra, U7), seen by the bot while a second
 * mineflayer-bedrock bot joins, moves, sneaks, swings, gets equipped / hurt / effects, sleeps, picks items up, rides,
 * dies and leaves: playerJoined / playerUpdated / playerLeft, entitySpawn / entityMoved / entityGone, entityCrouch /
 * entityUncrouch, entitySwingArm, entityEquip, entityEffect, entityHurt / entityDead, entitySleep / entityWake,
 * itemDrop / playerCollect, entityAttach / entityDetach.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot, createTestBot } = require('./common')
const { useItemOn } = require('../../lib/bedrock/transactions')

const GROUND = -60

describe('players (U7): a second player seen by the bot', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  const name = `u7p${process.pid % 1000}`
  let other = null // { bot, ctx, stop } of the second bot
  let otherEntity = null

  const ev = (event, predicate, timeout) => env.bot.test.botEvent(event, predicate, timeout)
  const cmd = (command) => env.server.commandOutput(command)

  before(async () => {
    await cmd('time set midnight')
  })
  after(async () => {
    try { other?.bot.end('test done') } catch {}
  })

  it('playerJoined → entitySpawn: player list entry linked to its entity (feet position)', async () => {
    const { bot } = env
    const joined = ev('playerJoined', (p) => p.username === name, 60000)
    const spawned = ev('entitySpawn', (e) => e.type === 'player' && e.username === name, 60000)
    other = await createTestBot({ server: env.server, username: name })
    const [player] = await joined.promise
    const [entity] = await spawned.promise
    otherEntity = entity
    assert.strictEqual(bot.players[name], player)
    assert.strictEqual(player.username, name)
    assert.strictEqual(player.displayName.toString(), name)
    assert.strictEqual(player.uuid, other.bot.player.uuid)
    assert.strictEqual(bot.uuidToUsername[player.uuid], name)
    assert.strictEqual(player.entity, entity)
    assert.strictEqual(entity.name, 'player')
    assert.strictEqual(entity.uuid, player.uuid)
    assert.strictEqual(entity.id, other.bot.entity.id, 'both see the same runtime id')
    assert.strictEqual(entity.height, 1.8)
    assert.strictEqual(bot.findPlayer(name), entity)
    await other.bot.test.wait(500)
    assert.ok(entity.position.distanceTo(other.bot.entity.position) < 0.2, `${entity.position} vs ${other.bot.entity.position}`)
  })

  it('entityMoved: a teleport (move_player at eye level → feet)', async () => {
    const target = new Vec3(4.5, GROUND, 4.5)
    const moved = ev('entityMoved', (e) => e === otherEntity && e.position.distanceTo(target) < 0.05)
    await cmd(`tp ${name} 4 ${GROUND} 4`)
    await moved.promise
  })

  it('playerUpdated: gamemode change', async () => {
    const updated = ev('playerUpdated', (p) => p.username === name && p.gamemode === 0)
    await cmd(`gamemode survival ${name}`)
    await updated.promise
  })

  it('entityCrouch / entityUncrouch (hitbox) from a sneaking player', async () => {
    const input = other.bot._bedrock.input
    const crouch = ev('entityCrouch', (e) => e === otherEntity)
    input.addFlags(['start_sneaking'])
    input.hold('sneaking', true)
    input.hold('sneak_down', true)
    await crouch.promise
    assert.strictEqual(otherEntity.crouching, true)
    assert.strictEqual(otherEntity.height, 1.5)
    const uncrouch = ev('entityUncrouch', (e) => e === otherEntity)
    input.addFlags(['stop_sneaking'])
    input.hold('sneaking', false)
    input.hold('sneak_down', false)
    await uncrouch.promise
    assert.strictEqual(otherEntity.crouching, false)
    assert.strictEqual(otherEntity.height, 1.8)
  })

  it('entitySwingArm: the other bot swings its arm', async () => {
    const swing = ev('entitySwingArm', (e) => e === otherEntity)
    other.bot.swingArm()
    await swing.promise
  })

  it('entityEquip: armor and held item', async () => {
    let equip = ev('entityEquip', (e) => e === otherEntity && e.equipment[4]?.name === 'diamond_chestplate')
    await cmd(`replaceitem entity ${name} slot.armor.chest 0 diamond_chestplate`)
    await equip.promise
    assert.strictEqual(otherEntity.attributes['generic.armor'].value, 8)
    assert.strictEqual(otherEntity.attributes['generic.armorToughness'].value, 2)
    equip = ev('entityEquip', (e) => e === otherEntity && e.heldItem?.name === 'iron_sword')
    await cmd(`replaceitem entity ${name} slot.hotbar 1 iron_sword`)
    await other.bot.test.wait(300)
    // select hotbar slot 1 like the vanilla client (U8's setQuickBarSlot does this)
    const ob = other.bot
    if (typeof ob.setQuickBarSlot === 'function' && !ob.setQuickBarSlot.notImplemented) ob.setQuickBarSlot(1)
    else ob._client.queue('mob_equipment', { runtime_entity_id: ob._bedrock.ids.selfRuntimeId(), item: ob._bedrock.heldNetworkItem.slot(1), slot: 1, selected_slot: 1, window_id: 'inventory' })
    await equip.promise
  })

  it('entityEffect and entityHurt of a player', async () => {
    const effect = ev('entityEffect', (e, eff) => e === otherEntity && eff.id === 1)
    await cmd(`effect ${name} speed 10 0`)
    await effect.promise
    const hurt = ev('entityHurt', (e) => e === otherEntity)
    await cmd(`damage ${name} 1`)
    await hurt.promise
  })

  it('entitySleep / entityWake: the other player sleeps in a bed', async () => {
    await cmd(`setblock 10 ${GROUND} 1 bed ["direction"=0,"head_piece_bit"=true]`)
    await cmd(`tp ${name} 11 ${GROUND} 0 facing 10 ${GROUND} 1`)
    await other.bot.test.wait(800)
    const sleep = ev('entitySleep', (e) => e === otherEntity)
    await useItemOn(other.bot, { position: new Vec3(10, GROUND, 1), face: 5 })
    await sleep.promise
    assert.strictEqual(otherEntity.sleeping, true)
    const wake = ev('entityWake', (e) => e === otherEntity)
    const ob = other.bot
    ob._client.queue('player_action', { runtime_entity_id: ob._bedrock.ids.selfRuntimeId(), action: 'stop_sleeping', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
    await wake.promise
    await cmd(`setblock 10 ${GROUND} 1 air`)
  })

  it('itemDrop + playerCollect: the other player and the bot pick up dropped items', async () => {
    const { bot } = env
    // next to the other player
    const arrived = ev('entityMoved', (e) => e === otherEntity && e.position.distanceTo(new Vec3(8.5, GROUND, 8.5)) < 0.1)
    await cmd(`tp ${name} 8 ${GROUND} 8`)
    await arrived.promise
    // the block right above the player's head: its drop falls onto the player (a block beside it may roll away)
    await cmd(`setblock 8 ${GROUND + 2} 8 dirt`)
    const dropped = ev('itemDrop', (e) => e.getDroppedItem()?.name === 'dirt')
    const anyCollect = []
    const onCollect = (collector, item) => anyCollect.push(`${collector.username ?? collector.name}:${item.getDroppedItem()?.name}`)
    bot.on('playerCollect', onCollect)
    const collected = ev('playerCollect', (collector, item) => collector === otherEntity && item.getDroppedItem()?.name === 'dirt', 15000)
    await cmd(`setblock 8 ${GROUND + 2} 8 air destroy`)
    const [item] = await dropped.promise
    try {
      const [, collectedItem] = await collected.promise
      assert.strictEqual(collectedItem, item)
    } catch (err) {
      err.message += ` (item at ${item.position}, other at ${otherEntity.position}, collects: ${anyCollect.join(' ') || 'none'})`
      throw err
    } finally {
      bot.removeListener('playerCollect', onCollect)
    }
    // next to the bot
    await bot.test.teleport(new Vec3(0, GROUND, 0))
    await cmd(`setblock 0 ${GROUND + 2} 0 cobblestone`)
    const raw = []
    const onRaw = (p) => raw.push(`${p.runtime_entity_id}->${p.target}`)
    bot._client.on('take_item_entity', onRaw)
    bot.on('playerCollect', onCollect)
    const ownDrop = ev('itemDrop', (e) => e.getDroppedItem()?.name === 'cobblestone')
    const mine = ev('playerCollect', (collector, it) => collector === bot.entity && it.getDroppedItem()?.name === 'cobblestone', 15000)
    await cmd(`setblock 0 ${GROUND + 2} 0 air destroy`)
    const [ownItem] = await ownDrop.promise
    try {
      const [, own] = await mine.promise
      assert.strictEqual(own, ownItem)
    } catch (err) {
      err.message += ` (item ${ownItem.id} at ${ownItem.position}, bot ${bot.entity.id} at ${bot.entity.position}, gamemode ${bot.game.gameMode}, collects: ${anyCollect.join(' ') || 'none'}, raw: ${raw.join(' ')})`
      throw err
    } finally {
      bot.removeListener('playerCollect', onCollect)
      bot._client.removeListener('take_item_entity', onRaw)
    }
  })

  it('entityAttach / entityDetach: the other player rides a horse', async () => {
    const { bot } = env
    const horse = await bot.test.summon('horse', new Vec3(-4, GROUND, 4), { spawnEvent: 'minecraft:ageable_grow_up' })
    const attach = ev('entityAttach', (e, v) => e === otherEntity && v === horse)
    await cmd(`ride ${name} start_riding @e[type=horse,c=1] teleport_rider`)
    await attach.promise
    assert.strictEqual(otherEntity.vehicle, horse)
    assert.ok(horse.passengers.includes(otherEntity))
    const detach = ev('entityDetach', (e, v) => e === otherEntity && v === horse)
    await cmd(`ride ${name} stop_riding`)
    await detach.promise
    assert.strictEqual(otherEntity.vehicle, null)
    assert.deepStrictEqual(horse.passengers, [])
    await bot.test.killEntity(horse)
  })

  it('entityHurt + entityDead: the other player dies (and respawns with the same entity)', async () => {
    const hurt = ev('entityHurt', (e) => e === otherEntity)
    const dead = ev('entityDead', (e) => e === otherEntity)
    await cmd(`kill ${name}`)
    await hurt.promise
    await dead.promise
    await other.bot.test.awaitRespawn()
    const moved = ev('entityMoved', (e) => e === otherEntity, 15000)
    await cmd(`tp ${name} 2 ${GROUND} 2`)
    await moved.promise
    assert.strictEqual(env.bot.players[name].entity, otherEntity)
  })

  it('entityGone + playerLeft: the other player quits', async () => {
    const { bot } = env
    const player = bot.players[name]
    const gone = ev('entityGone', (e) => e === otherEntity)
    const left = ev('playerLeft', (p) => p === player)
    other.bot.quit()
    await gone.promise
    await left.promise
    assert.strictEqual(player.entity, null)
    assert.strictEqual(bot.players[name], undefined)
    assert.strictEqual(bot.uuidToUsername[player.uuid], undefined)
    assert.strictEqual(bot.entities[otherEntity.id], undefined)
    other = null
  })
})
