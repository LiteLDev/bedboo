'use strict'
// owner: U9 (wave 3, bed state) → U14 (wave 4, sleep/wake) — bed.js on the recorded BDS join
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { implemented } = require('../external/common/helpers/base')

/** upstream internalTest beds (facing 2 north, 3 east, 0 south, 1 west), on the flat world's surface (y -60) */
const Y = -60
const BEDS = [
  { head: new Vec3(10, Y, 3), foot: new Vec3(10, Y, 2), facing: 2, throws: false },
  { head: new Vec3(9, Y, 4), foot: new Vec3(10, Y, 4), facing: 3, throws: true, error: 'the bed is too far' },
  { head: new Vec3(8, Y, 0), foot: new Vec3(8, Y, 1), facing: 0, throws: true, error: 'there are monsters nearby' },
  { head: new Vec3(12, Y, 0), foot: new Vec3(11, Y, 0), facing: 1, throws: false }
]

async function bedWorld () {
  const { bot, client } = await createFakeBot()
  await replayJoin(bot, client)
  const Block = require('prismarine-block')(bot.registry)
  const state = (direction, head) => Block.fromProperties('bed', { direction, head_piece_bit: head ? 1 : 0, occupied_bit: 0 }, 0).stateId
  for (const bed of BEDS) {
    bot.world.setBlockStateId(bed.foot, state(bed.facing, false))
    bot.world.setBlockStateId(bed.head, state(bed.facing, true))
  }
  return { bot, client, Block }
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
    const sleeping = (on) => client.receive('set_entity_data', { runtime_entity_id: 91n, metadata: [{ key: 'flags_extended', type: 'long', value: { sleeping: on } }], tick: 0n })
    sleeping(true)
    assert.strictEqual(bot.isSleeping, true)
    sleeping(false)
    assert.strictEqual(bot.isSleeping, false)
    // BDS after a respawn whose bed is gone (observed: rawtext translate tile.bed.notValid)
    client.receive('text', { needs_translation: false, category: 'message_only', type: 'json', message: '{"rawtext":[{"translate":"tile.bed.notValid"}]}\n', xuid: '', platform_chat_id: '', has_filtered_message: false })
    client.receive('text', { needs_translation: false, category: 'message_only', type: 'json', message: '{"rawtext":[{"translate":"tile.bed.respawnSet"}]}\n', xuid: '', platform_chat_id: '', has_filtered_message: false })
    assert.deepStrictEqual(events, ['sleep', 'wake', 'spawnReset'])
  })

  it('internalTest › bed: bot.sleep rejects a far bed / monsters nearby (U14, wave 4)', async function () {
    const { bot } = await bedWorld()
    if (!implemented(bot.sleep)) this.skip() // bot.sleep is U14's (wave 4)
    bot.time.timeOfDay = 18000
    for (const bed of BEDS.filter(b => b.throws)) {
      await assert.rejects(bot.sleep(bot.blockAt(bed.foot)), new RegExp(bed.error))
    }
  })
})
