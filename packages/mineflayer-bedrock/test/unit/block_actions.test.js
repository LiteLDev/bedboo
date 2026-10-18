'use strict'
// owner: U9 (player state, world extras & dimensions) — block_actions.js, block entities (blocks.js), sign.js and the
// prismarine-block / prismarine-chunk patches, on the recorded BDS join + packets observed on BDS 1.26.51.1
const assert = require('assert')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')

async function world () {
  const { bot, client } = await createFakeBot()
  await replayJoin(bot, client)
  const Block = require('prismarine-block')(bot.registry)
  const set = (pos, name, props = {}) => bot.world.setBlockStateId(pos, Block.fromProperties(name, props, 0).stateId)
  return { bot, client, Block, set }
}

const pistonArm = (pos, state, sticky = 0) => ({
  position: pos,
  nbt: nbt.comp({
    id: nbt.string('PistonArm'),
    NewState: nbt.byte(state),
    State: nbt.byte(state),
    Progress: nbt.float(state === 2 ? 1 : 0),
    Sticky: nbt.byte(sticky),
    x: nbt.int(pos.x),
    y: nbt.int(pos.y),
    z: nbt.int(pos.z)
  })
})

describe('block actions, block entities, signs (U9)', function () {
  this.timeout(30000)

  it('noteHeard: block_event { type: instrument, data: pitch } on a note block (bell = 6, harp = 0 → "sound")', async () => {
    const { bot, client, set } = await world()
    const pos = new Vec3(3, -60, 3)
    set(pos, 'noteblock')
    const heard = []
    bot.on('noteHeard', (block, instrument, pitch) => heard.push([block.position.toString(), instrument.name, pitch]))
    client.receive('block_event', { position: { x: 3, y: -60, z: 3 }, type: 6, data: 0 })
    client.receive('block_event', { position: { x: 3, y: -60, z: 3 }, type: 'sound', data: 12 })
    client.receive('block_event', { position: { x: 3, y: -60, z: 3 }, type: 'change_state', data: 24 })
    assert.deepStrictEqual(heard, [['(3, -60, 3)', 'bell', 0], ['(3, -60, 3)', 'harp', 12], ['(3, -60, 3)', 'basedrum', 24]])
  })

  it('pistonMove: PistonArm NewState 1 → push, 3 → pull, with the Java direction of facing_direction', async () => {
    const { bot, client, set } = await world()
    const moves = []
    bot.on('pistonMove', (block, isPulling, direction) => moves.push([block.name, isPulling, direction]))
    const pos = { x: 6, y: -60, z: 3 }
    set(new Vec3(6, -60, 3), 'piston', { facing_direction: 2 })
    for (const state of [0, 1, 2, 2, 3, 0]) client.receive('block_entity_data', pistonArm(pos, state))
    assert.deepStrictEqual(moves, [['piston', 0, 3], ['piston', 1, 3]], 'Bedrock piston facing 2 = south = Java 3')
    const sticky = { x: 9, y: -60, z: 3 }
    set(new Vec3(9, -60, 3), 'sticky_piston', { facing_direction: 5 })
    client.receive('block_entity_data', pistonArm(sticky, 1, 1))
    assert.deepStrictEqual(moves[2], ['sticky_piston', 0, 4], 'facing 5 = west = Java 4')
    // the piston's block entity is stored too
    assert.strictEqual(bot.blockAt(new Vec3(6, -60, 3)).blockEntity.id, 'PistonArm')
  })

  it('chestLidMove: open count per change; a double chest (pairx/pairz) gives block2 and one event for the pair', async () => {
    const { bot, client, set } = await world()
    const lids = []
    bot.on('chestLidMove', (block, isOpen, block2) => lids.push([block.position.toString(), isOpen, block2?.position.toString() ?? null]))
    set(new Vec3(1, -60, 2), 'chest')
    client.receive('block_event', { position: { x: 1, y: -60, z: 2 }, type: 'change_state', data: 1 })
    client.receive('block_event', { position: { x: 1, y: -60, z: 2 }, type: 'change_state', data: 1 })
    client.receive('block_event', { position: { x: 1, y: -60, z: 2 }, type: 'change_state', data: 0 })
    assert.deepStrictEqual(lids, [['(1, -60, 2)', 1, null], ['(1, -60, 2)', 0, null]])

    lids.length = 0
    set(new Vec3(4, -60, 4), 'chest')
    set(new Vec3(5, -60, 4), 'chest')
    const chestNbt = (x, pairx, lead) => ({ position: { x, y: -60, z: 4 }, nbt: nbt.comp({ id: nbt.string('Chest'), pairlead: nbt.byte(lead), pairx: nbt.int(pairx), pairz: nbt.int(4), x: nbt.int(x), y: nbt.int(-60), z: nbt.int(4) }) })
    client.receive('block_entity_data', chestNbt(4, 5, 1))
    client.receive('block_entity_data', chestNbt(5, 4, 0))
    client.receive('block_event', { position: { x: 4, y: -60, z: 4 }, type: 'change_state', data: 1 })
    client.receive('block_event', { position: { x: 5, y: -60, z: 4 }, type: 'change_state', data: 1 })
    client.receive('block_event', { position: { x: 5, y: -60, z: 4 }, type: 'change_state', data: 0 })
    client.receive('block_event', { position: { x: 4, y: -60, z: 4 }, type: 'change_state', data: 0 })
    assert.deepStrictEqual(lids, [['(4, -60, 4)', 1, '(5, -60, 4)'], ['(5, -60, 4)', 0, '(4, -60, 4)']], 'a close reported for both halves: one event')
  })

  it('break progress: level_event start / speed / stop → blockBreakProgressObserved stages, blockBreakProgressEnd; own digging skipped', async () => {
    const { bot, client, set } = await world()
    set(new Vec3(4, -60, 0), 'stone')
    const observed = []
    const ended = []
    bot.on('blockBreakProgressObserved', (block, stage, entity) => observed.push([block.name, stage, entity]))
    bot.on('blockBreakProgressEnd', (block, entity) => ended.push([block.name, entity]))
    const ev = (event, data) => client.receive('level_event', { event, position: { x: 4, y: -60, z: 0 }, data })
    ev('block_start_break', Math.ceil(65535 / 10)) // 10 ticks to break: a stage per tick
    assert.deepStrictEqual(observed, [['stone', 0, undefined]])
    await new Promise(resolve => setTimeout(resolve, 330))
    ev('block_break_speed', Math.ceil(65535 / 10))
    assert.ok(observed.length >= 4, `${observed.length} stages`)
    assert.deepStrictEqual(observed.map(o => o[1]), [...observed.map(o => o[1])].sort((a, b) => a - b))
    ev('block_stop_break', 0)
    assert.deepStrictEqual(ended, [['stone', undefined]])
    const count = observed.length
    await new Promise(resolve => setTimeout(resolve, 120))
    assert.strictEqual(observed.length, count, 'no stage after the end')

    // the block breaking: the update ends it too
    ev('block_start_break', 1000)
    bot._updateBlockState(new Vec3(4, -60, 0), bot.registry.blocksByName.air.defaultState)
    assert.strictEqual(ended.length, 2)

    // a new break over an entry whose stop_break was lost restarts at stage 0; a stale break ends by itself
    set(new Vec3(4, -60, 0), 'stone')
    observed.length = 0
    ev('block_start_break', 30000)
    await new Promise(resolve => setTimeout(resolve, 120))
    ev('block_start_break', 30000)
    assert.deepStrictEqual(observed.filter(o => o[1] === 0).length, 2, 'stage 0 again')
    const endedBefore = ended.length
    await new Promise(resolve => setTimeout(resolve, 400)) // 30000/65535 per tick: done after ~3 ticks, stale after ~4
    assert.strictEqual(ended.length, endedBefore + 1, 'the lost stop_break is assumed after 150 % of the time')

    // the bot's own digging (BDS sends these to the breaker too): skipped
    set(new Vec3(4, -60, 0), 'stone')
    bot.targetDigBlock = bot.blockAt(new Vec3(4, -60, 0))
    observed.length = 0
    ev('block_start_break', 1000)
    assert.strictEqual(observed.length, 0)
    bot.targetDigBlock = null
    bot.end()
  })

  it('block entities: block_entity_data → blockEntityData + block.blockEntity; replaced blocks lose it; late data for air ignored', async () => {
    const { bot, client, set } = await world()
    const pos = new Vec3(2, -60, 5)
    set(pos, 'standing_sign')
    const events = []
    bot.on('blockEntityData', (block) => events.push(block))
    const signNbt = (front, back) => nbt.comp({
      id: nbt.string('Sign'),
      FrontText: nbt.comp({ Text: nbt.string(front), TextOwner: nbt.string('') }),
      BackText: nbt.comp({ Text: nbt.string(back), TextOwner: nbt.string('') }),
      IsWaxed: nbt.byte(0),
      LockedForEditingBy: nbt.long(-1n),
      x: nbt.int(2),
      y: nbt.int(-60),
      z: nbt.int(5)
    })
    client.receive('block_entity_data', { position: { x: 2, y: -60, z: 5 }, nbt: signNbt('1\n2\n3', 'back') })
    assert.strictEqual(events.length, 1)
    assert.ok(events[0].position.equals(pos))
    assert.strictEqual(events[0].signText, '1\n2\n3')
    assert.deepStrictEqual(bot.blockAt(pos).getSignText(), ['1\n2\n3', 'back'])
    assert.strictEqual(bot.blockAt(pos).blockEntity.FrontText.Text, '1\n2\n3')

    // signOpen + updateSign → block_entity_data with the whole sign compound, one side changed
    let opened
    bot.on('signOpen', (block) => { opened = block })
    client.receive('open_sign', { position: { x: 2, y: -60, z: 5 }, is_front: true })
    assert.ok(opened.position.equals(pos))
    client.clearSent()
    bot.updateSign(opened, 'a\nb')
    bot.updateSign(opened, 'other side', true)
    const [front, back] = client.sent('block_entity_data')
    assert.deepStrictEqual(front.position, { x: 2, y: -60, z: 5 })
    assert.strictEqual(front.nbt.value.FrontText.value.Text.value, 'a\nb')
    assert.strictEqual(front.nbt.value.BackText.value.Text.value, 'back')
    assert.strictEqual(front.nbt.value.id.value, 'Sign')
    assert.strictEqual(front.nbt.value.LockedForEditingBy.value, -1n)
    assert.strictEqual(front.nbt.value.FrontText.value.PersistFormatting.value, 1, 'missing side fields filled in')
    assert.strictEqual(back.nbt.value.BackText.value.Text.value, 'other side')
    assert.strictEqual(back.nbt.value.FrontText.value.Text.value, '1\n2\n3', 'the stored front text, not the unsent edit')
    // the payload serializes
    assert.ok(nbt.writeUncompressed(front.nbt, 'littleVarint').length > 0)
    const errors = []
    bot.on('error', (err) => errors.push(err.message))
    bot.updateSign(opened, '1\n2\n3\n4\n5')
    bot.updateSign(opened, 'x'.repeat(46))
    assert.deepStrictEqual(errors, ['too many lines for sign text', 'Signs have a maximum of 45 characters per line'])
    assert.strictEqual(client.sent('block_entity_data').length, 2)

    // a sign without block entity yet (setblock before its data): default compound
    const fresh = new Vec3(3, -60, 5)
    set(fresh, 'standing_sign')
    client.clearSent()
    bot.updateSign(bot.blockAt(fresh), 'hi')
    const [packet] = client.sent('block_entity_data')
    assert.deepStrictEqual([packet.nbt.value.FrontText.value.Text.value, packet.nbt.value.BackText.value.Text.value, packet.nbt.value.x.value], ['hi', '', 3])

    // the block replaced by another type: its block entity goes (after 'blockUpdate', whose old block still has it);
    // a stale block_entity_data for air is dropped
    let oldSign
    bot.once('blockUpdate:(2, -60, 5)', (oldBlock) => { oldSign = oldBlock })
    client.receive('update_block', { position: { x: 2, y: -60, z: 5 }, block_runtime_id: Number(Object.keys(bot.registry.blocksByRuntimeId).find(id => bot.registry.blocksByRuntimeId[id].name === 'stone')), flags: {}, layer: 0 })
    assert.strictEqual(bot.blockAt(pos).name, 'stone')
    assert.strictEqual(bot.blockAt(pos).blockEntity, undefined)
    assert.strictEqual(oldSign.signText, '1\n2\n3', 'blockUpdate: the old block keeps its block entity')
    const airId = Number(Object.keys(bot.registry.blocksByRuntimeId).find(id => bot.registry.blocksByRuntimeId[id].name === 'air'))
    client.receive('update_block', { position: { x: 2, y: -60, z: 5 }, block_runtime_id: airId, flags: {}, layer: 0 })
    const before = events.length
    client.receive('block_entity_data', { position: { x: 2, y: -60, z: 5 }, nbt: signNbt('late', '') })
    assert.strictEqual(events.length, before)
    assert.strictEqual(bot.blockAt(pos).blockEntity, undefined)
  })

  it('prismarine-block patch: Bedrock signText / getSignText / setSignText on FrontText / BackText', async () => {
    const { bot } = await world()
    const Block = require('prismarine-block')(bot.registry)
    const sign = Block.fromStateId(bot.registry.blocksByName.standing_sign.defaultState, 0)
    assert.strictEqual(sign.signText, '')
    assert.deepStrictEqual(sign.getSignText(), ['', ''])
    sign.setSignText(['a', 'b'], 'c')
    assert.deepStrictEqual(sign.getSignText(), ['a\nb', 'c'])
    sign.signText = 'x'
    assert.strictEqual(sign.signText, 'x')
    assert.strictEqual(sign.blockEntity.FrontText.SignTextColor, -16777216)
    // pre-1.19.80 sign entity (top-level Text)
    sign.entity = nbt.comp({ id: nbt.string('Sign'), Text: nbt.string('old') })
    assert.deepStrictEqual(sign.getSignText(), ['old', ''])
  })

  it('prismarine-chunk patch: biomes of copied (0xff) biome sections and of all-air sub-chunks', async () => {
    const { bot } = await world()
    // the fixture world: one explicit plains section, the rest copies; most sub-chunks are all air
    for (const y of [-64, -61, -40, 0, 100, 319]) {
      const block = bot.blockAt(new Vec3(3, y, 3))
      assert.strictEqual(bot.registry.biomes[block.biome.id]?.name, 'plains', `y ${y}: ${block.biome.id}`)
    }
  })
})
