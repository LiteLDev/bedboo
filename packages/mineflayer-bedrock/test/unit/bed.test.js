'use strict'
// owner: U9 (wave 3, bed state) → U14 (wave 4, sleep/wake) — bed.js on the recorded BDS join
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')

/** upstream internalTest beds (facing 2 north, 3 east, 0 south, 1 west), on the flat world's surface (y -60) */
const Y = -60
const BEDS = [
  { head: new Vec3(10, Y, 3), foot: new Vec3(10, Y, 2), facing: 2, throws: false },
  { head: new Vec3(9, Y, 4), foot: new Vec3(10, Y, 4), facing: 3, throws: true, error: 'the bed is too far' },
  { head: new Vec3(8, Y, 0), foot: new Vec3(8, Y, 1), facing: 0, throws: true, error: 'there are monsters nearby' },
  { head: new Vec3(12, Y, 0), foot: new Vec3(11, Y, 0), facing: 1, throws: false }
]

async function bedWorld () {
  const { bot, client, clock } = await createFakeBot()
  await replayJoin(bot, client)
  const Block = require('prismarine-block')(bot.registry)
  const state = (direction, head) => Block.fromProperties('bed', { direction, head_piece_bit: head ? 1 : 0, occupied_bit: 0 }, 0).stateId
  for (const bed of BEDS) {
    bot.world.setBlockStateId(bed.foot, state(bed.facing, false))
    bot.world.setBlockStateId(bed.head, state(bed.facing, true))
  }
  return { bot, client, Block, clock }
}

describe('bed state (U9)', function () {
  this.timeout(30000)

  it('internalTest › bed (parseBedMetadata: Bedrock direction / head_piece_bit / occupied_bit)', async () => {
    const { bot } = await bedWorld()
    for (const bed of BEDS) {
      const bedBlock = bot.blockAt(bed.foot)
      assert.strictEqual(bedBlock.name, 'bed')
      assert.strictEqual(bot.isABed(bedBlock), true)
      const metadata = bot.parseBedMetadata(bedBlock)
      assert.strictEqual(metadata.facing, bed.facing, 'The facing property seems to be wrong')
      assert.strictEqual(metadata.part, false, 'The part property seems to be wrong') // Is the foot
      assert.strictEqual(metadata.occupied, false)
      assert.strictEqual(bot.parseBedMetadata(bot.blockAt(bed.head)).part, true, 'the head')
    }
    // the head offsets of the four facings (upstream: south +z, west -x, north -z, east +x)
    assert.deepStrictEqual(BEDS.map(b => bot.parseBedMetadata(bot.blockAt(b.foot)).headOffset.toArray()), [[0, 0, -1], [1, 0, 0], [0, 0, 1], [-1, 0, 0]])
    assert.strictEqual(bot.isABed(bot.blockAt(new Vec3(0, -61, 0))), false)
  })

  it('occupied bed, straw_bed (cardinal direction), isSleeping/sleep/wake from the sleeping flag, spawnReset message', async () => {
    const { bot, client, Block } = await bedWorld()
    const occupied = new Vec3(5, Y, 5)
    bot.world.setBlockStateId(occupied, Block.fromProperties('bed', { direction: 1, head_piece_bit: 1, occupied_bit: 1 }, 0).stateId)
    assert.deepStrictEqual(bot.parseBedMetadata(bot.blockAt(occupied)), { part: true, occupied: true, facing: 1, headOffset: new Vec3(-1, 0, 0) })
    if (bot.registry.blocksByName.straw_bed) {
      const straw = new Vec3(6, Y, 6)
      bot.world.setBlockStateId(straw, Block.fromProperties('straw_bed', { 'minecraft:cardinal_direction': 'east', head_piece_bit: 0, occupied_bit: 0 }, 0).stateId)
      assert.strictEqual(bot.isABed(bot.blockAt(straw)), true)
      assert.strictEqual(bot.parseBedMetadata(bot.blockAt(straw)).facing, 3)
    }

    const events = []
    for (const e of ['sleep', 'wake', 'spawnReset']) bot.on(e, () => events.push(e))
    // BDS reports a sleeping player in player_flags (bit 1, U7's entity data), the entities plugin emits entitySleep
    const sleeping = (on) => client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'player_flags', type: 'byte', value: on ? 2 : 0 }], tick: 0n })
    sleeping(true)
    assert.strictEqual(bot.isSleeping, true)
    sleeping(false)
    assert.strictEqual(bot.isSleeping, false)
    // BDS after a respawn whose bed is gone (observed: rawtext translate tile.bed.notValid)
    client.receive('text', { needs_translation: false, category: 'message_only', type: 'json', message: '{"rawtext":[{"translate":"tile.bed.notValid"}]}\n', xuid: '', platform_chat_id: '', has_filtered_message: false })
    client.receive('text', { needs_translation: false, category: 'message_only', type: 'json', message: '{"rawtext":[{"translate":"tile.bed.respawnSet"}]}\n', xuid: '', platform_chat_id: '', has_filtered_message: false })
    // players cannot fake it by chatting the key
    client.receive('text', { needs_translation: false, category: 'authored', type: 'chat', source_name: 'troll', message: 'tile.bed.notValid', xuid: '', platform_chat_id: '', has_filtered_message: false })
    client.receive('text', { needs_translation: false, category: 'message_only', type: 'json', message: '{"rawtext":[{"text":"tile.bed.notValid"}]}', xuid: '', platform_chat_id: '', has_filtered_message: false })
    assert.deepStrictEqual(events, ['sleep', 'wake', 'spawnReset'])
    client.receive('text', { needs_translation: true, category: 'message_only', type: 'translation', message: 'tile.respawn_anchor.notValid', parameters: [], xuid: '', platform_chat_id: '', has_filtered_message: false })
    assert.deepStrictEqual(events, ['sleep', 'wake', 'spawnReset', 'spawnReset'])
  })

  it('internalTest › bed (sleep: a far bed / monsters nearby reject, the other beds are clicked and slept in) (U14)', async () => {
    const { bot, client, clock } = await bedWorld()
    bot.time.timeOfDay = 18000
    // upstream: the player at (10, 0, 0), a zombie at (0, 0, 0)
    bot.entity.position.set(10.5, Y, 0.5)
    client.receive('add_entity', {
      unique_id: -800n,
      runtime_id: 800n,
      entity_type: 'minecraft:zombie',
      position: { x: 0.5, y: Y, z: 0.5 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: { ints: [], floats: [] },
      links: []
    })
    assert.strictEqual(bot.entities[800].kind, 'Hostile mobs')
    const sleeping = (on) => client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'player_flags', type: 'byte', value: on ? 2 : 0 }], tick: 0n })
    for (const bed of BEDS) {
      const bedBlock = bot.blockAt(bed.foot)
      const metadata = bot.parseBedMetadata(bedBlock)
      assert.strictEqual(metadata.facing, bed.facing, 'The facing property seems to be wrong')
      assert.strictEqual(metadata.part, false, 'The part property seems to be wrong') // Is the foot
      if (bed.throws) {
        await assert.rejects(bot.sleep(bedBlock), (err) => err.message === bed.error)
        continue
      }
      // the bed is clicked (item_use click_block once the look went out), BDS answers with the sleeping flag
      client.clearSent()
      const slept = bot.sleep(bedBlock)
      for (let i = 0; i < 20 && client.sent('inventory_transaction').length === 0; i++) {
        clock.advance(50)
        bot._bedrock.input.pump()
        await new Promise((resolve) => setImmediate(resolve))
      }
      const [click] = client.sent('inventory_transaction')
      const data = click.transaction.transaction_data
      assert.strictEqual(data.action_type, 'click_block')
      // upstream's beds 0 and 3 have their "head" behind the foot (no head in front of it): sleep() clicks that part
      assert.deepStrictEqual(data.block_position, { x: bed.head.x, y: bed.head.y, z: bed.head.z })
      sleeping(true)
      await slept
      assert.strictEqual(bot.isSleeping, true)
      await assert.rejects(bot.sleep(bedBlock), /already sleeping/)
      sleeping(false)
    }
  })

  it("sleep() checks in upstream's order: day, not a bed, occupied, half a bed; 'bot is not sleeping' without an answer (U14)", async function () {
    this.timeout(10000)
    const { bot, Block, clock } = await bedWorld()
    bot.entity.position.set(10.5, Y, 0.5)
    bot.time.timeOfDay = 1000
    await assert.rejects(bot.sleep(bot.blockAt(BEDS[0].foot)), /it's not night and it's not a thunderstorm/)
    bot.isRaining = true
    bot.thunderState = 1
    await assert.rejects(bot.sleep(bot.blockAt(new Vec3(10, Y - 1, 0))), /wrong block : not a bed block/) // a thunderstorm is fine
    bot.isRaining = false
    bot.thunderState = 0
    bot.time.timeOfDay = 13000
    const occupied = new Vec3(9, Y, -1)
    bot.world.setBlockStateId(occupied, Block.fromProperties('bed', { direction: 0, head_piece_bit: 0, occupied_bit: 1 }, 0).stateId)
    await assert.rejects(bot.sleep(bot.blockAt(occupied)), /the bed is occupied/)
    const half = new Vec3(12, Y, -2)
    bot.world.setBlockStateId(half, Block.fromProperties('bed', { direction: 0, head_piece_bit: 0, occupied_bit: 0 }, 0).stateId)
    await assert.rejects(bot.sleep(bot.blockAt(half)), /there's only half bed/)
    // a whole bed nobody answers for: rejected after 3 s like upstream
    const pending = bot.sleep(bot.blockAt(BEDS[0].foot))
    const pump = setInterval(() => { clock.advance(50); bot._bedrock.input.pump() }, 50)
    try {
      await assert.rejects(pending, /bot is not sleeping/)
    } finally {
      clearInterval(pump)
    }
  })
})
