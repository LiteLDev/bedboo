'use strict'
// owner: U15 (ecosystem plugins & examples) — the pnpm patches of mineflayer-pathfinder / -tool / -auto-eat /
// -armor-manager and the core hooks they use, on a fake client with the recorded BDS join (flat world): Bedrock block
// names, doors and gates, dig-time estimates (Bedrock effect factors, `ench` enchantments), auto-eat's completion on
// completed_using_item, armor-manager's serialized equips, Java version comparisons on the Bedrock registry, the
// dig completing when mineflayer-pathfinder stops it during the breaking update. The live flows are in
// test/external/ecosystem*.test.js.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { createRegistry } = require('../../lib/registry')
const { createWorld } = require('./helpers/physics_world')

const HASTE = 3

async function spawned () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      created.clock.advance(50)
      created.bot._bedrock.input.pump()
    }
  }
  created.tick(3)
  return created
}

/** the server's update_block for `pos` (layer 0) */
function serverSets (bot, client, pos, name, props) {
  const registry = bot.registry
  const Block = require('prismarine-block')(registry)
  const stateId = props ? Block.fromProperties(name, props, 0).stateId : registry.blocksByName[name].defaultState
  client.receive('update_block', {
    position: { x: pos.x, y: pos.y, z: pos.z },
    block_runtime_id: registry.runtimeIdByStateId[stateId],
    flags: { _value: 3, neighbors: true, network: true, no_graphic: false, unused: false, priority: false },
    layer: 0
  })
}

/** bot.blockAt answers from `overlay` for the positions it was filled at (pathfinder reads blocks through it) */
function withOverlay (bot) {
  const overlay = createWorld()
  const changed = new Set()
  const blockAt = bot.blockAt
  bot.blockAt = (pos, extraInfos) => {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    return changed.has(key) ? overlay.getBlock(pos) : blockAt(pos, extraInfos)
  }
  return (x1, y1, z1, x2, y2, z2, name, props) => {
    overlay.fill(x1, y1, z1, x2, y2, z2, name, props)
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) changed.add(`${x},${y},${z}`)
  }
}

function item (bot, name, { ench } = {}) {
  const Item = require('prismarine-item')(bot.registry)
  const it = new Item(bot.registry.itemsByName[name].id, 1, 0)
  if (ench) {
    const nbt = require('prismarine-nbt')
    it.nbt = nbt.comp({ ench: nbt.list(nbt.comp(ench.map(([id, lvl]) => ({ id: nbt.short(id), lvl: nbt.short(lvl) })))) })
  }
  return it
}

describe('Java version comparisons on the Bedrock registry (bedrock-data, U15)', function () {
  it('a Java version compares numerically; Bedrock versions compare exactly as before; anything else throws', () => {
    const registry = createRegistry()
    assert.strictEqual(registry.isNewerOrEqualTo('1.9'), true)
    assert.strictEqual(registry.isOlderThan('1.9'), false)
    assert.strictEqual(registry.version['>=']('1.16'), true)
    assert.strictEqual(registry.version['<']('1.20.5'), false)
    assert.strictEqual(registry.version['>']('1.26.51'), false)
    assert.strictEqual(registry.version['==']('1.26.51'), true)
    assert.strictEqual(registry.isNewerOrEqualTo('1.21.0'), true, 'a Bedrock version')
    assert.strictEqual(registry.isOlderThan('26.3'), true, 'Java 26.x is newer than 1.26.51')
    assert.throws(() => registry.isNewerOrEqualTo('26.3-rc-1'), RangeError)
    // the require('minecraft-data')(bot.version) alias shares the comparators
    assert.strictEqual(require('minecraft-data')('1.26.51').isNewerOrEqualTo('1.9'), true)
  })
})

describe('mineflayer-pathfinder patch (Bedrock)', function () {
  this.timeout(30000)
  const { Movements } = require('mineflayer-pathfinder')
  const pfBedrock = require('mineflayer-pathfinder/lib/bedrock')

  it('Movements: Bedrock liquids (flowing_*, water-filled plants), web / fire / lava avoided, doors and gates openable', async () => {
    const { bot } = await spawned()
    const moves = new Movements(bot)
    const id = (name) => bot.registry.blocksByName[name].id
    for (const name of ['water', 'flowing_water', 'lava', 'flowing_lava', 'seagrass', 'kelp', 'bubble_column']) assert.ok(moves.liquids.has(id(name)), name)
    for (const name of ['web', 'fire', 'lava', 'flowing_lava']) assert.ok(moves.blocksToAvoid.has(id(name)), name)
    for (const name of ['flowing_water', 'flowing_lava', 'air']) assert.ok(moves.replaceables.has(id(name)), name)
    for (const name of ['wooden_door', 'spruce_door', 'copper_door', 'fence_gate', 'pale_oak_fence_gate']) assert.ok(moves.openable.has(id(name)), name)
    for (const name of ['iron_door', 'trapdoor', 'iron_trapdoor', 'oak_fence']) assert.ok(!moves.openable.has(id(name)), name)
    assert.ok(moves.interactableBlocks.has('crafting_table') && moves.interactableBlocks.has('lit_furnace') && moves.interactableBlocks.has('standing_sign'))
    assert.ok(moves.fences.has(id('oak_fence')) && moves.carpets.has(id('white_carpet')), 'shape classes from minStateId')
  })

  it('a closed wooden door is opened (useOne, its upper half kept), an open one walked through, an iron door dug', async () => {
    const { bot } = await spawned()
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder) // safeOrBreak asks bot.pathfinder.bestHarvestTool
    const fill = withOverlay(bot)
    const g = -60
    bot.entity.position = new Vec3(0.5, g, 0.5)
    // a door north of the bot (corridor along z): closed, panel spanning x
    fill(0, g, -1, 0, g, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0, open_bit: 0, door_hinge_bit: 0 })
    fill(0, g + 1, -1, 0, g + 1, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 1, open_bit: 0, door_hinge_bit: 0 })
    const node = { x: 0, y: g, z: 0, remainingBlocks: 0 }
    const north = (moves) => {
      const out = []
      moves.getMoveForward(node, { x: 0, z: -1 }, out)
      return out[0]
    }
    const closed = north(Object.assign(new Movements(bot), { canOpenDoors: true, canDig: false }))
    assert.ok(closed, 'a move through the door')
    assert.deepStrictEqual(closed.toBreak, [], 'nothing to break (the upper half opens with the door)')
    assert.deepStrictEqual(closed.toPlace.map(p => [p.x, p.y, p.z, !!p.useOne]), [[0, g, -1, true]])
    assert.ok(!north(Object.assign(new Movements(bot), { canOpenDoors: false, canDig: false })), 'closed + no digging + no opening: no way')
    // open: walked through, no click (a click would close it)
    fill(0, g, -1, 0, g, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0, open_bit: 1, door_hinge_bit: 0 })
    fill(0, g + 1, -1, 0, g + 1, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 1, open_bit: 1, door_hinge_bit: 0 })
    const open = north(Object.assign(new Movements(bot), { canOpenDoors: true, canDig: false }))
    assert.ok(open && open.toPlace.length === 0 && open.toBreak.length === 0, 'walked through the open door')
    const openGate = new Movements(bot)
    fill(0, g, -1, 0, g, -1, 'fence_gate', { 'minecraft:cardinal_direction': 'south', open_bit: 1, in_wall_bit: 0 })
    fill(0, g + 1, -1, 0, g + 1, -1, 'air')
    assert.ok(openGate.getBlock(node, 0, 0, -1).safe, 'an open gate is passable')
    // an iron door is not openable by hand: both halves dug when digging is allowed
    fill(0, g, -1, 0, g, -1, 'iron_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0, open_bit: 0, door_hinge_bit: 0 })
    fill(0, g + 1, -1, 0, g + 1, -1, 'iron_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 1, open_bit: 0, door_hinge_bit: 0 })
    const iron = north(Object.assign(new Movements(bot), { canOpenDoors: true, canDig: true }))
    assert.ok(iron && iron.toBreak.length === 2 && iron.toPlace.length === 0, 'dug')
  })

  it('dig-time estimates: Bedrock Haste factor (bot._bedrock.digging.blockDigTime) and Bedrock `ench` enchantments', async () => {
    const { bot, client } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(1, -60, 1)
    serverSets(bot, client, target, 'stone')
    const stone = bot.blockAt(target)
    const plain = item(bot, 'iron_pickaxe')
    const efficient = item(bot, 'iron_pickaxe', { ench: [[bot.registry.enchantmentsByName.efficiency.id, 3]] })
    assert.deepStrictEqual(efficient.enchants, [{ name: 'efficiency', lvl: 3 }])
    bot.entity.effects = {}
    assert.strictEqual(pfBedrock.digTimeOf(bot, stone, plain), stone.digTime(plain.type, false, false, false, [], {}), 'no effect: the same as prismarine-block')
    assert.ok(pfBedrock.digTimeOf(bot, stone, efficient) < pfBedrock.digTimeOf(bot, stone, plain), 'Efficiency counts (item.enchants)')
    bot.entity.effects = { [HASTE]: { id: HASTE, amplifier: 1, duration: 2000 } }
    const bedrock = pfBedrock.digTimeOf(bot, stone, plain)
    assert.strictEqual(bedrock, bot._bedrock.digging.blockDigTime(stone, plain.type, false, false, false, [], bot.entity.effects))
    assert.ok(bedrock < stone.digTime(plain.type, false, false, false, [], bot.entity.effects), 'Bedrock Haste II (×2.016) beats Java (×1.4)')
    // mineflayer-tool uses the same estimate
    const { Tool } = require('mineflayer-tool')
    assert.strictEqual(new Tool(bot).getDigTime(stone, plain), bedrock)
    assert.strictEqual(new Tool(bot).getDigTime(stone, efficient), pfBedrock.digTimeOf(bot, stone, efficient))
  })

  it('pathfinder.stop(): a no-op while idle (master #375); with a goal but no path walked, stops on the next tick', async () => {
    const { bot } = await spawned()
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
    const { goals } = require('mineflayer-pathfinder')
    let stopped = 0
    bot.on('path_stop', () => stopped++)
    bot.pathfinder.stop() // idle: nothing to stop
    bot.pathfinder.setGoal(new goals.GoalBlock(0, -60, 0))
    assert.strictEqual(stopped, 0, 'the new goal is not stopped')
    assert.ok(bot.pathfinder.goal)
    // a goal whose path is not being walked (here: not computed yet): stop() settles on the next tick, asynchronously
    bot.pathfinder.stop()
    assert.strictEqual(stopped, 0)
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(stopped, 1)
    assert.strictEqual(bot.pathfinder.goal, null)
    // and does not latch onto the next goal
    bot.pathfinder.setGoal(new goals.GoalBlock(0, -60, 0))
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(stopped, 1)
    assert.ok(bot.pathfinder.goal)
    bot.pathfinder.setGoal(null)
  })

  it('door leaves: passable along the edge they lie on, opened when across the way; opening uses no scaffolding block', async () => {
    const { bot } = await spawned()
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
    const fill = withOverlay(bot)
    const g = -60
    const node = { x: 0, y: g, z: 0, remainingBlocks: 0 }
    const move = (moves, dir) => {
      const out = []
      moves.getMoveForward(node, dir, out)
      return out[0]
    }
    const door = (open) => {
      for (const upper of [0, 1]) fill(1, g + upper, 0, 1, g + upper, 0, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: upper, open_bit: open, door_hinge_bit: 0 })
    }
    const moves = Object.assign(new Movements(bot), { canOpenDoors: true, canDig: false })
    // east into the door block (x 1): the closed 'west' leaf lies along x at the north edge (z 0..0.19) → walked past
    door(0)
    const pastClosed = move(moves, { x: 1, z: 0 })
    assert.ok(pastClosed && pastClosed.toPlace.length === 0 && pastClosed.toBreak.length === 0, 'squeezes past the closed leaf, no click')
    // open, the leaf lies across x (x 0.81..1): blocked eastwards (it would have to be closed again: not handled)
    door(1)
    assert.ok(!move(moves, { x: 1, z: 0 }), 'the open leaf blocks the way east')
    // a closed door across the way north (z -1, leaf along x at z 0..0.19 of that block) is opened; with no scaffolding
    // blocks the move keeps remainingBlocks at 0 (upstream counted the click as a placed block: -1)
    for (const upper of [0, 1]) fill(0, g + upper, -1, 0, g + upper, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: upper, open_bit: 0, door_hinge_bit: 0 })
    const opened = move(moves, { x: 0, z: -1 })
    assert.ok(opened && opened.toPlace.length === 1 && opened.toPlace[0].useOne)
    assert.strictEqual(opened.remainingBlocks, 0)
  })
})

describe('digging: stopDigging while the breaking update is dispatched completes the dig (U15)', function () {
  this.timeout(30000)

  it("a 'blockUpdate' listener calling stopDigging (mineflayer-pathfinder) → diggingCompleted, not aborted", async () => {
    const { bot, client, tick } = await spawned()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, -60, 1)
    serverSets(bot, client, target, 'stone')
    const events = []
    bot.on('diggingCompleted', () => events.push('completed'))
    bot.on('diggingAborted', () => events.push('aborted'))
    const onUpdate = (oldBlock, newBlock) => {
      if (newBlock?.position.equals(target) && newBlock.name === 'air') bot.stopDigging()
    }
    bot.on('blockUpdate', onUpdate)
    const done = bot.dig(bot.blockAt(target))
    await new Promise((resolve) => setImmediate(resolve))
    tick(1) // the look goes out with this input
    await new Promise((resolve) => setImmediate(resolve))
    tick(3)
    serverSets(bot, client, target, 'air')
    tick(1)
    await done
    bot.removeListener('blockUpdate', onUpdate)
    assert.deepStrictEqual(events, ['completed'])
    // a real stop (the block still there) still aborts
    serverSets(bot, client, target, 'stone')
    const second = bot.dig(bot.blockAt(target))
    await new Promise((resolve) => setImmediate(resolve))
    tick(1)
    await new Promise((resolve) => setImmediate(resolve))
    tick(2)
    bot.stopDigging()
    await assert.rejects(second, /Digging aborted/)
    assert.deepStrictEqual(events, ['completed', 'aborted'])
  })
})

describe('mineflayer-auto-eat patch (Bedrock)', function () {
  this.timeout(30000)

  it('loads (util plugin on the Bedrock registry); a meal completes on completed_using_item', async () => {
    const { bot, client } = await spawned()
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
    assert.ok(bot.autoEat && bot.util, 'auto-eat + @nxg-org/mineflayer-util-plugin')
    assert.ok(bot.autoEat.foodsByName.bread, 'registry foods')
    const bread = item(bot, 'bread')
    bread.slot = 36
    let finished = false
    const done = bot.autoEat.buildEatingListener(bread, 3000).then(() => { finished = true })
    // another kind of use (a thrown snowball, an equipped armor piece) does not end the meal
    client.receive('completed_using_item', { used_item_id: bot.registry.itemsByName.snowball.id, use_method: 'throw' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.strictEqual(finished, false)
    client.receive('completed_using_item', { used_item_id: bot.registry.itemsByName.bread.id, use_method: 'eat' })
    await done
  })
})

describe('mineflayer-pvp patch', function () {
  this.timeout(30000)

  it('a fusing creeper (Bedrock `ignited` entity flag) raises the shield', async () => {
    const { bot } = await spawned()
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
    bot.loadPlugin(require('mineflayer-pvp').plugin)
    bot.inventory.updateSlot(45, item(bot, 'shield'))
    assert.strictEqual(bot.pvp.hasShield(), true)
    const raised = []
    bot.activateItem = (offHand) => raised.push(offHand)
    bot.lookAt = async () => {}
    const creeper = { name: 'creeper', position: bot.entity.position.offset(2, 0, 0), metadata: Object.assign([], { flags: { ignited: false } }) }
    bot.pvp.target = creeper
    bot.pvp.checkExplosion()
    assert.deepStrictEqual(raised, [])
    creeper.metadata.flags.ignited = true
    bot.pvp.checkExplosion()
    assert.deepStrictEqual(raised, [true])
    assert.strictEqual(bot.pvp.blockingExplosion, true)
    bot.pvp.target = undefined
  })
})

describe('mineflayer-armor-manager patch', function () {
  this.timeout(30000)

  it('pieces picked up together are equipped one at a time', async () => {
    const { bot } = await spawned()
    bot.loadPlugin(require('mineflayer-armor-manager'))
    const pieces = ['iron_helmet', 'iron_chestplate', 'iron_boots'].map((name, i) => {
      const it = item(bot, name)
      bot.inventory.updateSlot(9 + i, it)
      return it
    })
    let inFlight = 0
    let maxInFlight = 0
    const equipped = []
    bot.equip = async (it, destination) => {
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((resolve) => setTimeout(resolve, 30))
      equipped.push([it.name, destination])
      inFlight--
    }
    for (const it of pieces) bot.emit('playerCollect', bot.entity, { getDroppedItem: () => it })
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.strictEqual(maxInFlight, 1)
    assert.deepStrictEqual(equipped, [['iron_helmet', 'head'], ['iron_chestplate', 'torso'], ['iron_boots', 'feet']])
  })
})
