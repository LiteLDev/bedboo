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

/**
 * fill blocks (Bedrock states) into the bot's world, so bot.blockAt — which pathfinder reads blocks through — answers
 * them like blocks the server sent (FINAL-FIX-LIB: through blocks.js, e.g. a door's upper half takes its shapes from
 * the lower half)
 */
function withOverlay (bot) {
  const overlay = createWorld()
  return (x1, y1, z1, x2, y2, z2, name, props) => {
    overlay.fill(x1, y1, z1, x2, y2, z2, name, props)
    for (let x = x1; x <= x2; x++) {
      for (let y = y1; y <= y2; y++) {
        for (let z = z1; z <= z2; z++) bot.world.setBlockStateId(new Vec3(x, y, z), overlay.getBlock(new Vec3(x, y, z)).stateId)
      }
    }
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
    // open: walked through, no click (a click would close it). BDS opens the lower half only: the upper half keeps
    // open_bit 0 (measured on 1.26.51.1), its leaf follows the lower half (FINAL-FIX-LIB)
    fill(0, g, -1, 0, g, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 0, open_bit: 1, door_hinge_bit: 0 })
    fill(0, g + 1, -1, 0, g + 1, -1, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: 1, open_bit: 0, door_hinge_bit: 0 })
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
      // BDS: only the lower half carries the open state
      for (const upper of [0, 1]) fill(1, g + upper, 0, 1, g + upper, 0, 'wooden_door', { 'minecraft:cardinal_direction': 'west', upper_block_bit: upper, open_bit: upper ? 0 : open, door_hinge_bit: 0 })
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

describe('mineflayer-pathfinder: a failed equip / placement never hangs the path (FINAL-ROUND)', function () {
  this.timeout(30000)
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
  const g = -60 // the flat world's feet level (grass at -61)
  const settle = () => new Promise((resolve) => setImmediate(resolve))

  /**
   * The bot at (0.5, g, 0.5) on the east rim of a gap 3 wide (x 1..3, every layer down to the void), the goal across
   * it (4, g, 0): every path places scaffolding (no digging, parkour or sprinting; search radius 6, so no way around).
   * The placements need no walk to the edge (LOSWhenPlacingBlocks off): the first one is due at once.
   */
  async function bridgeSetup () {
    const created = await spawned()
    const { bot } = created
    bot.game.gameMode = 'survival'
    withOverlay(bot)(1, -64, -12, 3, -61, 12, 'air')
    bot.inventory.updateSlot(36, item(bot, 'dirt'))
    bot.inventory.slots[36].count = 64
    bot.loadPlugin(pathfinder)
    const moves = Object.assign(new Movements(bot), { canDig: false, allowParkour: false, allowSprinting: false, allow1by1towers: false })
    bot.pathfinder.setMovements(moves)
    bot.pathfinder.LOSWhenPlacingBlocks = false
    bot.pathfinder.searchRadius = 6
    const resets = []
    bot.on('path_reset', (reason) => resets.push(reason))
    /** physics ticks (each runs the pathfinder's monitorMovement) until `until()` or `max` ticks; the ticks it took */
    const ticks = async (max, until = () => false) => {
      for (let i = 1; i <= max; i++) {
        created.tick(1)
        await settle()
        await new Promise((resolve) => setTimeout(resolve, 2)) // goto settles in a setTimeout(0)
        if (until()) return i
      }
      return max
    }
    return { ...created, moves, resets, ticks, goal: new goals.GoalBlock(4, g, 0) }
  }

  /** the outcome of a goto promise, without awaiting it: { state: 'pending' | 'resolved' | 'rejected', error } */
  function track (promise) {
    const out = { state: 'pending', error: null }
    promise.then(() => { out.state = 'resolved' }, (err) => { out.state = 'rejected'; out.error = err })
    return out
  }

  it('bot.equip rejecting: the equip lock is released, the cell is retried once then avoided, goto rejects (NoPath) within a bound', async () => {
    const { bot, resets, ticks, goal } = await bridgeSetup()
    let equips = 0
    let pending = 0
    let overlapped = false
    bot.equip = async () => {
      equips++
      if (pending++ > 0) overlapped = true
      await settle()
      pending--
      throw new Error('equip refused')
    }
    const placed = []
    bot.placeBlock = async (ref, face) => { placed.push(ref.position.plus(face)) }
    const run = track(bot.pathfinder.goto(goal))
    const took = await ticks(200, () => run.state !== 'pending')
    assert.strictEqual(run.state, 'rejected', `goto settled (after ${took} ticks, ${equips} equips, resets ${resets})`)
    assert.strictEqual(run.error.name, 'NoPath')
    assert.match(run.error.message, /6 placements failed in a row/)
    assert.ok(took < 100, `rejected after ${took} ticks`)
    assert.strictEqual(equips, bot.pathfinder.maxPlaceFailures, 'one equip per failed placement (upstream: one, then the lock was held for good)')
    assert.ok(!overlapped, 'never two equips at once')
    assert.deepStrictEqual(placed, [], 'nothing placed without the block in hand')
    assert.ok(resets.filter((r) => r === 'equip_error').length >= bot.pathfinder.maxPlaceFailures - 1, `resets ${resets}`)
    // each cell was tried twice before the searches avoided it (maxPlaceRetries 1)
    assert.ok(bot.pathfinder.refusedPlacements.size >= 2, `refused ${[...bot.pathfinder.refusedPlacements]}`)
    assert.ok(bot.pathfinder.refusedPlacements.has('1,-61,0'), 'the first cell of the bridge')
    assert.ok(!bot.pathfinder.isBuilding() && !bot.pathfinder.isMoving())
    // the given-up goal is dropped and not searched again: no more equips
    assert.strictEqual(bot.pathfinder.goal, null)
    await ticks(20)
    assert.strictEqual(equips, bot.pathfinder.maxPlaceFailures)
    // the same goal again (a caller's retry) keeps what failed: no placement at a refused cell, given up at once
    const refused = [...bot.pathfinder.refusedPlacements]
    const retry = track(bot.pathfinder.goto(goal))
    await ticks(100, () => retry.state !== 'pending')
    assert.strictEqual(retry.state, 'rejected')
    assert.strictEqual(retry.error.name, 'NoPath')
    assert.ok(refused.every((k) => bot.pathfinder.refusedPlacements.has(k)), 'the refused cells are still avoided')
    assert.ok(equips <= bot.pathfinder.maxPlaceFailures + 1, `at most one more equip: ${equips}`)
    // a new goal tries every cell again, and the lock is free: the equip works now, the placements go out
    bot.equip = async () => {}
    const again = track(bot.pathfinder.goto(new goals.GoalBlock(4, g, 0)))
    await ticks(10, () => placed.length > 0)
    assert.ok(placed.length > 0, 'placing again for the new goal')
    assert.strictEqual(bot.pathfinder.refusedPlacements.size, 0)
    bot.pathfinder.setGoal(null)
    await ticks(5, () => again.state !== 'pending')
    assert.strictEqual(again.state, 'rejected')
    assert.strictEqual(again.error.name, 'GoalChanged')
  })

  it('a refused placement: retried once, then the search goes another way (a neighbouring column of the bridge)', async () => {
    const { bot, resets, ticks, goal } = await bridgeSetup()
    bot.equip = async () => {}
    const tries = new Map()
    bot.placeBlock = async (ref, face) => {
      const dest = ref.position.plus(face)
      tries.set(dest.toString(), (tries.get(dest.toString()) ?? 0) + 1)
      // the server refuses the bridge's first cell; we stop at the first placement elsewhere
      if (dest.equals(new Vec3(1, -61, 0))) throw new Error(`Server refused to place dirt at ${dest}: the block is still air`)
      bot.pathfinder.stop()
    }
    const run = track(bot.pathfinder.goto(goal))
    await ticks(100, () => run.state !== 'pending')
    assert.strictEqual(run.state, 'rejected')
    assert.strictEqual(run.error.name, 'PathStopped', 'stopped by the test at the first placement elsewhere')
    assert.strictEqual(tries.get(new Vec3(1, -61, 0).toString()), 2, `the refused cell was tried twice: ${[...tries]}`)
    assert.ok([...tries.keys()].some((k) => k !== new Vec3(1, -61, 0).toString()), `then another cell: ${[...tries]}`)
    assert.deepStrictEqual(resets.filter((r) => r === 'place_error'), ['place_error', 'place_error'])
  })

  it('stop() settles on the next tick while a placement never answers; a late answer changes nothing', async () => {
    const { bot, ticks, goal } = await bridgeSetup()
    bot.equip = async () => {}
    let answer = null
    let placements = 0
    bot.placeBlock = () => { placements++; return new Promise((resolve) => { answer = resolve }) }
    const run = track(bot.pathfinder.goto(goal))
    await ticks(20, () => placements > 0)
    assert.strictEqual(placements, 1)
    assert.ok(bot.pathfinder.isBuilding())
    await ticks(5)
    assert.strictEqual(placements, 1, 'one placement at a time (upstream equipped again on every tick of it)')
    bot.pathfinder.stop()
    const took = await ticks(5, () => run.state !== 'pending')
    assert.strictEqual(run.state, 'rejected', 'goto settled')
    assert.strictEqual(run.error.name, 'PathStopped')
    assert.ok(took <= 2, `settled after ${took} ticks`)
    assert.ok(!bot.pathfinder.isBuilding() && bot.pathfinder.goal === null)
    // the orphaned placement answers late: the next goal is not disturbed by it
    const resets = []
    bot.on('path_reset', (r) => resets.push(r))
    bot.placeBlock = async () => { placements++ }
    const next = track(bot.pathfinder.goto(goal))
    answer()
    await ticks(10, () => placements > 1)
    assert.ok(placements > 1, 'the next goal places')
    assert.ok(!resets.includes('place_error'))
    bot.pathfinder.stop()
    await ticks(5, () => next.state !== 'pending')
  })

  it('a bot leaning out over the edge (its centre over the gap) searches from the block it stands on', async () => {
    const { bot, ticks, goal } = await bridgeSetup()
    bot.equip = async () => {}
    const refs = []
    bot.placeBlock = (ref, face) => {
      refs.push([ref.position.toString(), ref.name])
      bot.pathfinder.stop()
      return new Promise(() => {})
    }
    // standing on the grass at x 0 by the east 0.1 of its hitbox (sneaking to the edge left it there)
    bot.entity.position = new Vec3(1.2, g, 0.5)
    bot.entity.onGround = true
    bot.pathfinder.setGoal(goal)
    await ticks(10, () => refs.length > 0)
    // upstream started from (1, g, 0) — over the gap — and placed against the air under it
    assert.deepStrictEqual(refs[0], [new Vec3(0, -61, 0).toString(), 'grass_block'])
  })

  it('a placement that never settles times out (placeTimeout) and is tried again; a hung equip too', async () => {
    const { bot, resets, ticks, goal } = await bridgeSetup()
    bot.pathfinder.placeTimeout = 300
    let equips = 0
    bot.equip = () => { equips++; return new Promise(() => {}) } // never answers
    const run = track(bot.pathfinder.goto(goal))
    const t0 = Date.now()
    await ticks(2500, () => equips >= 3 || Date.now() - t0 > 5000)
    assert.ok(equips >= 3, `equipped again after each timeout: ${equips}`)
    assert.ok(resets.includes('place_timeout'), `resets ${resets}`)
    while (Date.now() - t0 < 10000 && run.state === 'pending') await ticks(1)
    assert.strictEqual(run.state, 'rejected', 'given up after maxPlaceFailures timeouts in a row')
    assert.strictEqual(run.error.name, 'NoPath')
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
