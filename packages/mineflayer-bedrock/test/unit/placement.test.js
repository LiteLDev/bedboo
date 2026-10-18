'use strict'
// owner: U11 (placing & placement-based parity) — generic_place / place_block / place_entity and lib/bedrock/placement.js
// on a fake client fed with the recorded BDS join (flat world) and synthesized BDS answers (the update_block burst BDS
// sends for every click, set_entity_data sneaking, add_entity), as measured on BDS 1.26.51.1 (docs/differences/U11.md).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { inventoryContent } = require('./helpers/inventory_server')
const placement = require('../../lib/bedrock/placement')

const EYE = 1.62
const G = -60 // flat world ground (feet) level
const UP = new Vec3(0, 1, 0)
const flags = (on = {}) => ({ _value: 0n, onfire: false, sneaking: false, sprinting: false, gliding: false, swimming: false, ...on })
const settle = () => new Promise(resolve => setImmediate(resolve))
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms))

async function spawned () {
  const created = await createFakeBot()
  const { bot, client, clock } = created
  await replayJoin(bot, client)
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50)
      bot._bedrock.input.pump()
    }
  }
  created.tick(3) // settle on the grass
  created.rid = (name, props) => {
    const block = bot.registry.blocksByName[name]
    let stateId = block.defaultState
    if (props) {
      const Block = require('prismarine-block')(bot.registry)
      for (let s = block.minStateId; s <= block.maxStateId; s++) {
        const p = Block.fromStateId(s, 0).getProperties()
        if (Object.entries(props).every(([k, v]) => p[k] === v)) { stateId = s; break }
      }
    }
    return bot.registry.runtimeIdByStateId[stateId]
  }
  created.setBlock = (pos, name, props) => client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: created.rid(name, props), flags: { _value: 3 }, layer: 0 })
  /** BDS's answer to a click on `ref` + `face`: the clicked block, the block across the face (now `destName`), … */
  created.answer = (ref, face, destName) => {
    const dest = ref.plus(face)
    created.setBlock(ref, bot.blockAt(ref).name)
    created.setBlock(dest, destName)
    created.setBlock(ref.offset(0, -1, 0), bot.blockAt(ref.offset(0, -1, 0)).name)
    created.setBlock(dest, destName)
    created.setBlock(dest.offset(0, 1, 0), bot.blockAt(dest.offset(0, 1, 0)).name)
    created.setBlock(ref, bot.blockAt(ref).name)
  }
  created.give = (slots) => client.receive('inventory_content', inventoryContent(bot, slots, { firstStackId: 40 }))
  /** the packets written since `from` as short names (player_action → its action) */
  created.names = (from = 0) => client.written.slice(from).map(([, n, p]) => n === 'player_action' ? p.action : n).filter(n => n !== 'player_auth_input')
  created.selfRuntime = bot._bedrock.ids.selfRuntimeId()
  client.clearSent()
  return created
}

describe('placement (U11): bot._genericPlace, placeBlock, placeEntity over Bedrock click_block', function () {
  this.timeout(30000)

  it('_genericPlace: look, start_item_use_on → item_use click_block (exact held item, runtime id, click point, eye position) → stop_item_use_on', async () => {
    const { bot, client, give, rid, names } = await spawned()
    give({ 0: ['dirt', 5] })
    const ref = bot.blockAt(new Vec3(1, G - 1, 0))
    client.clearSent()
    const pos = await bot._genericPlace(ref, UP, { forceLook: true, swingArm: 'right' })
    assert.ok(pos.equals(ref.position))
    assert.deepStrictEqual(names(), ['animate', 'start_item_use_on', 'inventory_transaction'])
    const [start] = client.sent('player_action')
    assert.deepStrictEqual(start.position, { x: 1, y: G - 1, z: 0 })
    assert.deepStrictEqual(start.result_position, { x: 1, y: G, z: 0 })
    assert.strictEqual(start.face, 1)
    const t = client.sent('inventory_transaction')[0].transaction
    assert.strictEqual(t.transaction_type, 'item_use')
    const d = t.transaction_data
    assert.strictEqual(d.action_type, 'click_block')
    assert.strictEqual(d.trigger_type, 'player_input')
    assert.deepStrictEqual(d.block_position, { x: 1, y: G - 1, z: 0 })
    assert.strictEqual(d.face, 1)
    assert.deepStrictEqual(d.click_pos, { x: 0.5, y: 1, z: 0.5 })
    assert.strictEqual(d.hotbar_slot, 0)
    assert.strictEqual(d.hand, 'main_hand')
    assert.deepStrictEqual(d.held_item, bot._bedrock.heldNetworkItem(), 'the exact server copy (stack id)')
    assert.strictEqual(d.held_item.stack_id, 40)
    assert.strictEqual(d.block_runtime_id, rid('grass_block'))
    assert.ok(Math.abs(d.player_pos.y - (bot.entity.position.y + EYE)) < 1e-9, 'eye level')
    assert.strictEqual(d.client_prediction, 'success')
    // looked at the center of the face
    const eye = bot.entity.position.offset(0, EYE, 0)
    const dir = new Vec3(1.5, G, 0.5).minus(eye)
    assert.ok(Math.abs(bot.entity.pitch - Math.atan2(dir.y, Math.hypot(dir.x, dir.z))) < 0.01)

    // the next click sends the pending stop first; half: top → upper half of the side face
    await bot._genericPlace(bot.blockAt(new Vec3(2, G - 1, 0)), new Vec3(-1, 0, 0), { forceLook: true, half: 'top' })
    assert.deepStrictEqual(names(), ['animate', 'start_item_use_on', 'inventory_transaction', 'stop_item_use_on', 'start_item_use_on', 'inventory_transaction'])
    const stop = client.sent('player_action')[1]
    assert.deepStrictEqual(stop.position, { x: 1, y: G, z: 0 }, 'stop: the block across the face')
    const second = client.sent('inventory_transaction')[1].transaction.transaction_data
    assert.strictEqual(second.face, 4)
    assert.deepStrictEqual(second.click_pos, { x: 0, y: 0.75, z: 0.5 })
    // delta overrides the click point; the stop goes out 150 ms after the click
    await bot._genericPlace(bot.blockAt(new Vec3(2, G - 1, 0)), UP, { forceLook: 'ignore', delta: new Vec3(0.2, 1, 0.8) })
    assert.deepStrictEqual(client.sent('inventory_transaction')[2].transaction.transaction_data.click_pos, { x: 0.2, y: 1, z: 0.8 })
    await sleep(200)
    assert.deepStrictEqual(names().slice(-1), ['stop_item_use_on'])
  })

  it('_genericPlace: without forceLook the click follows the input that carries the new rotation', async () => {
    const { bot, client, give, tick } = await spawned()
    give({ 0: ['dirt', 5] })
    client.clearSent()
    const done = bot._genericPlace(bot.blockAt(new Vec3(-2, G - 1, 1)), UP, {})
    await settle()
    assert.strictEqual(client.sent('inventory_transaction').length, 0)
    tick()
    await done
    const order = client.written.map(([, n]) => n)
    assert.ok(order.indexOf('player_auth_input') < order.indexOf('inventory_transaction'))
  })

  it("_genericPlace: upstream's checks (nothing held, empty off-hand, invalid face); the off-hand click carries the off-hand item", async () => {
    const { bot, client, give } = await spawned()
    const ref = bot.blockAt(new Vec3(1, G - 1, 0))
    await assert.rejects(bot._genericPlace(ref, UP, { forceLook: true }), /^Error: must be holding an item to place$/)
    await assert.rejects(bot._genericPlace(ref, UP, { forceLook: true, offhand: true }), /^Error: must be holding an item in the off-hand to place$/)
    give({ 0: ['dirt', 1] })
    await assert.rejects(bot._genericPlace(ref, new Vec3(0, 0, 0), { forceLook: true }), /invalid direction vector/)
    client.receive('inventory_content', inventoryContent(bot, { 0: ['cobblestone', 2] }, { window: 'offhand', size: 1, firstStackId: 70 }))
    client.clearSent()
    await bot._genericPlace(ref, UP, { forceLook: true, offhand: true })
    const d = client.sent('inventory_transaction')[0].transaction.transaction_data
    assert.strictEqual(d.hand, 'off_hand')
    assert.strictEqual(d.held_item.stack_id, 70)
  })

  it('_genericPlace against an interactive block: holds sneak, clicks after the sneaking input and its acknowledgement, releases', async () => {
    const { bot, client, give, setBlock, tick, selfRuntime } = await spawned()
    bot.creative.stopFlying?.()
    bot._bedrock.physics.setFlying(false, { request: false })
    give({ 0: ['dirt', 5] })
    const chest = new Vec3(2, G, 0)
    setBlock(chest, 'chest')
    client.clearSent()
    const done = bot._genericPlace(bot.blockAt(chest), UP, { forceLook: true })
    await settle()
    assert.strictEqual(bot.getControlState('sneak'), true)
    tick()
    await settle()
    const sneakInput = client.sent('player_auth_input').at(-1)
    assert.ok(sneakInput.input_data.includes('sneaking') && sneakInput.input_data.includes('start_sneaking'))
    assert.strictEqual(client.sent('inventory_transaction').length, 0, 'waits for the server to acknowledge')
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true }) }], tick: 1n })
    await done
    assert.strictEqual(client.sent('inventory_transaction').length, 1)
    const order = client.written.map(([, n]) => n)
    assert.ok(order.lastIndexOf('player_auth_input') < order.indexOf('inventory_transaction'))
    assert.strictEqual(bot.getControlState('sneak'), false, 'released after the click')
    // two placements in flight share the sneak: it is released after the last click only
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: false }) }], tick: 2n })
    const sneakAtClick = []
    const queue = client.queue
    client.queue = (name, params) => {
      if (name === 'inventory_transaction') sneakAtClick.push(bot.getControlState('sneak'))
      return queue(name, params)
    }
    const first = bot._genericPlace(bot.blockAt(chest), UP, { forceLook: true })
    const second = bot._genericPlace(bot.blockAt(chest), UP, { forceLook: true })
    await settle()
    tick()
    await settle()
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true }) }], tick: 3n })
    tick()
    await Promise.all([first, second])
    client.queue = queue
    assert.deepStrictEqual(sneakAtClick, [true, true], 'the first release does not drop the second placement\'s sneak')
    assert.strictEqual(bot.getControlState('sneak'), false)
    // a sneak the caller holds (mineflayer-pathfinder) stays held; a plain block needs none
    bot.setControlState('sneak', true)
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime, metadata: [{ key: 'flags', type: 'long', value: flags({ sneaking: true }) }], tick: 4n })
    const again = bot._genericPlace(bot.blockAt(chest), UP, { forceLook: true })
    tick()
    await again
    assert.strictEqual(bot.getControlState('sneak'), true)
    bot.setControlState('sneak', false)
    const before = client.sent('inventory_transaction').length
    await bot._genericPlace(bot.blockAt(new Vec3(1, G - 1, 0)), UP, { forceLook: true })
    assert.strictEqual(client.sent('inventory_transaction').length, before + 1, 'a plain block: clicked at once')
    assert.strictEqual(bot.getControlState('sneak'), false)
  })

  it('_genericPlace while jumping out of the destination (pathfinder pillar): the click follows the first input clear of it', async () => {
    const { bot, client, give, tick } = await spawned()
    bot._bedrock.physics.setFlying(false, { request: false })
    bot.physics.gravity = 0.08
    give({ 0: ['dirt', 5] })
    const feet = bot.entity.position.floored()
    bot.setControlState('jump', true)
    tick()
    assert.ok(bot.entity.position.y > feet.y, 'airborne')
    client.clearSent()
    const done = bot._genericPlace(bot.blockAt(feet.offset(0, -1, 0)), UP, { forceLook: true })
    for (let i = 0; i < 10 && client.sent('inventory_transaction').length === 0; i++) {
      await settle()
      tick()
      await settle()
    }
    await done
    bot.setControlState('jump', false)
    const order = client.written.map(([, n, p]) => [n, p])
    const at = order.findIndex(([n]) => n === 'inventory_transaction')
    const input = order.slice(0, at).filter(([n]) => n === 'player_auth_input').at(-1)[1]
    assert.ok(input.position.y - EYE >= feet.y + 1, `the input before the click has the feet above the block: ${input.position.y - EYE}`)
    assert.ok(order.slice(0, at).filter(([n]) => n === 'player_auth_input').some(([, p]) => p.position.y - EYE < feet.y + 1), 'it waited')
  })

  it('placeBlock: resolves on the update of the destination after the reference block (blockPlaced), rejects a refusal like upstream', async () => {
    const { bot, give, answer, setBlock, tick } = await spawned()
    give({ 0: ['dirt', 5] })
    const placed = []
    const look = async () => { await settle(); tick(); await settle() } // placeBlock looks at the face first
    bot.on('blockPlaced', (oldBlock, newBlock) => placed.push([oldBlock.name, newBlock.name, newBlock.position.toString()]))
    // an update of the destination before the reference one (sent before the server saw the click) does not settle it
    let settled = false
    const ok = bot.placeBlock(bot.blockAt(new Vec3(-1, G - 1, 0)), UP).then(() => { settled = true })
    await look()
    setBlock(new Vec3(-1, G, 0), 'air')
    await settle()
    assert.strictEqual(settled, false)
    answer(new Vec3(-1, G - 1, 0), UP, 'dirt')
    await ok
    assert.deepStrictEqual(placed.at(-1), ['air', 'dirt', `(-1, ${G}, 0)`])

    const refused = bot.placeBlock(bot.blockAt(new Vec3(2, G - 1, 0)), UP)
    await look()
    answer(new Vec3(2, G - 1, 0), UP, 'air')
    await assert.rejects(refused, /^Error: Server refused to place dirt at \(2, -60, 0\): the block is still air$/)
  })

  it('placeEntity: armor stand / spawn egg / end crystal / minecart / boat on water → the spawned entity, entityPlaced; Unimplemented', async () => {
    const { bot, client, give, setBlock, tick } = await spawned()
    let nextRuntime = 500n
    const addEntity = (type, position) => {
      const runtimeId = nextRuntime++
      client.receive('add_entity', { unique_id: -runtimeId, runtime_id: runtimeId, entity_type: `minecraft:${type}`, position, velocity: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0, body_yaw: 0, attributes: [], metadata: [{ key: 'flags', type: 'long', value: flags() }], properties: { ints: [], floats: [] }, links: [] })
    }
    const announced = []
    bot.on('entityPlaced', (e) => announced.push(e))
    async function place (item, ref, face, spawn) {
      give({ 0: [item, 1] })
      const p = bot.placeEntity(bot.blockAt(ref), face)
      await settle()
      tick() // the look
      await settle()
      for (const [type, pos] of spawn) addEntity(type, pos)
      return p
    }
    // another entity spawning first does not stop the wait (upstream bug)
    const stand = await place('armor_stand', new Vec3(1, G - 1, 0), UP, [['item', { x: 1.5, y: G, z: 0.5 }], ['armor_stand', { x: 1.5, y: G, z: 0.5 }]])
    assert.strictEqual(stand.name, 'armor_stand')
    assert.deepStrictEqual(announced, [stand])
    const zombie = await place('zombie_spawn_egg', new Vec3(2, G - 1, 0), UP, [['zombie', { x: 2.5, y: G, z: 0.5 }]])
    assert.strictEqual(zombie.name, 'zombie')
    const villager = await place('villager_spawn_egg', new Vec3(2, G - 1, 1), UP, [['villager_v2', { x: 2.5, y: G, z: 1.5 }]])
    assert.strictEqual(villager.name, 'villager_v2')
    setBlock(new Vec3(-2, G, 0), 'obsidian')
    const crystal = await place('end_crystal', new Vec3(-2, G, 0), UP, [['ender_crystal', { x: -1.5, y: G + 1, z: 0.5 }]])
    assert.strictEqual(crystal.name, 'ender_crystal')
    setBlock(new Vec3(3, G, 0), 'rail')
    const cart = await place('minecart', new Vec3(3, G, 0), UP, [['minecart', { x: 3.5, y: G + 0.35, z: 0.5 }]])
    assert.strictEqual(cart.name, 'minecart')
    // a boat on water (upstream: the water block with the face below): a click on the water's top face
    setBlock(new Vec3(0, G - 1, -2), 'water')
    client.clearSent()
    const boat = await place('oak_boat', new Vec3(0, G - 1, -2), new Vec3(0, -1, 0), [['boat', { x: 0.5, y: G + 0.375, z: -1.5 }]])
    assert.strictEqual(boat.name, 'boat')
    const d = client.sent('inventory_transaction')[0].transaction.transaction_data
    assert.deepStrictEqual([d.block_position, d.face], [{ x: 0, y: G - 1, z: -2 }, 1])
    assert.strictEqual(announced.length, 6)

    give({ 0: ['dirt', 1] })
    await assert.rejects(bot.placeEntity(bot.blockAt(new Vec3(1, G - 1, 0)), UP), /Unimplemented/)
    give({})
    await assert.rejects(bot.placeEntity(bot.blockAt(new Vec3(1, G - 1, 0)), UP), /^Error: must be holding an item to place an entity$/)
  })

  it('item use on the looked-at block (buckets, boats: BDS ignores their click_air): useOnLookedAtBlock raycasts like the client', async () => {
    const { bot, client, give, setBlock } = await spawned()
    setBlock(new Vec3(0, G, -2), 'water')
    give({ 0: ['bucket', 1] })
    await bot.lookAt(new Vec3(0.5, G + 0.5, -1.5), true)
    client.clearSent()
    assert.strictEqual(bot._bedrock.placement.useOnLookedAtBlock(bot.heldItem), true)
    let d = client.sent('inventory_transaction')[0].transaction.transaction_data
    assert.deepStrictEqual(d.block_position, { x: 0, y: G, z: -2 }, 'an empty bucket targets the water source')
    // a filled bucket goes through the water to the block behind it
    give({ 0: ['water_bucket', 1] })
    client.clearSent()
    assert.strictEqual(bot._bedrock.placement.useOnLookedAtBlock(bot.heldItem), true)
    d = client.sent('inventory_transaction')[0].transaction.transaction_data
    assert.notDeepStrictEqual(d.block_position, { x: 0, y: G, z: -2 })
    assert.ok(bot.blockAt(new Vec3(d.block_position.x, d.block_position.y, d.block_position.z)).boundingBox === 'block')
    // milk is drunk (click_air), a snowball thrown: not block targets
    assert.strictEqual(bot._bedrock.placement.useOnLookedAtBlock(bot.registry.itemsByName.milk_bucket), false)
    assert.strictEqual(bot._bedrock.placement.useOnLookedAtBlock(bot.registry.itemsByName.snowball), false)
    // nothing in reach: false (the caller sends its click_air)
    await bot.look(0, Math.PI / 2, true)
    assert.strictEqual(bot._bedrock.placement.useOnLookedAtBlock(bot.heldItem), false)
  })

  it('lib/bedrock/placement: interactive blocks are Bedrock block names; liquids; item targets', async () => {
    const { bot } = await spawned()
    for (const name of placement.INTERACTIVE_BLOCKS) assert.ok(bot.registry.blocksByName[name], `${name} is a Bedrock block`)
    for (const name of ['chest', 'white_shulker_box', 'undyed_shulker_box', 'wooden_door', 'spruce_trapdoor', 'fence_gate', 'stone_button',
      'standing_sign', 'oak_hanging_sign', 'birch_wall_sign', 'bed', 'candle_cake', 'copper_chest', 'oak_shelf', 'lever', 'barrel']) {
      assert.ok(bot.registry.blocksByName[name], name)
      assert.strictEqual(placement.isInteractive({ name }), true, name)
    }
    for (const name of ['dirt', 'stone', 'grass_block', 'iron_door', 'iron_trapdoor', 'obsidian', 'water', 'air']) {
      assert.strictEqual(placement.isInteractive({ name }), false, name)
    }
    assert.strictEqual(placement.isInteractive(null), false)
    assert.deepStrictEqual(placement.blockTargetOf('bucket'), { liquids: 'source' })
    assert.deepStrictEqual(placement.blockTargetOf('lava_bucket'), { liquids: 'none' })
    assert.deepStrictEqual(placement.blockTargetOf('oak_chest_boat'), { liquids: 'any' })
    assert.deepStrictEqual(placement.blockTargetOf('bamboo_raft'), { liquids: 'any' })
    assert.strictEqual(placement.blockTargetOf('milk_bucket'), null)
    assert.strictEqual(placement.blockTargetOf('dirt'), null)
    assert.strictEqual(placement.isLiquid({ name: 'flowing_lava' }), true)
  })
})
