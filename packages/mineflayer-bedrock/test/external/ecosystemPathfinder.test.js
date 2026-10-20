// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-pathfinder 2.4.5 (+ patches/mineflayer-pathfinder@2.4.5.patch) on BDS 1.26.51.1, in survival with
 * gravity, on a seeded default world (Bedrock extra, docs/ecosystem.md).
 *
 * World: seed "2" (docs/ecosystem.md#test-world): spawn (-31, 67, 6) in a birch / oak forest with hills up to y 80 to the
 * west, a lake from z 12 to z 50 to the south and caves below. Natural-terrain goals start from the spawn area; the
 * structured scenarios (ladder, parkour, pillar, bridge, wall, door, gate) are built with the console on a stone deck
 * at y 109 north of the spawn, away from the terrain.
 *
 * Every scenario asserts: the goal is reached (goto resolves, the goal's isEnd), no correction storm (server
 * corrections that moved the bot: few, never many in a row), a time bound, and what the movement had to do (blocks
 * placed / broken / doors opened).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const SEED = '2'
const DECK_Y = 109 // the deck's blocks; the bot stands at DECK_Y + 1
const Y = DECK_Y + 1

describe('ecosystemPathfinder', function () {
  this.timeout(240000)
  const ctx = useBot({ server: { world: 'default', seed: SEED, gamemode: 'survival' } })
  const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')

  let corrections = []
  let offCorrections = null
  let resets = []
  const onReset = (reason) => resets.push(reason)

  /** console fill / setblock that must succeed (or find the blocks already there) */
  async function build (cmd) {
    const out = await ctx.bot.test.ctx.consoleOutput(cmd)
    if (!out.some((l) => /filled|placed|couldn't be placed|No blocks/i.test(l))) throw new Error(`${cmd}: ${out.join(' | ')}`)
  }
  const give = (name, count) => ctx.bot.test.give(name, count)

  before(async function () {
    this.timeout(0)
    const { bot } = ctx
    bot.loadPlugin(pathfinder)
    bot.pathfinder.thinkTimeout = 20000 // default world under a loaded host (docs/ecosystem.md: thinkTimeout)
    await bot.test.ctx.consoleOutput(`effect ${bot.username} resistance 100000 255 true`)
    bot.on('path_reset', onReset)
  })

  beforeEach(async () => {
    const { bot } = ctx
    await bot.test.clearInventory()
    corrections = []
    resets = []
    offCorrections = bot._bedrock.physics.onCorrection((c) => corrections.push(c))
  })

  afterEach(() => {
    offCorrections?.()
    ctx.bot.pathfinder.stop()
    ctx.bot.pathfinder.setGoal(null)
    ctx.bot.clearControlStates()
  })

  /** server corrections that moved the bot (a correction to the very position we predicted changes nothing) */
  const significant = () => corrections.filter(c => c.error === null || c.error > 0.01)
  function maxConsecutive (list, gap = 20) {
    let best = 0
    let run = 0
    let prev = null
    for (const c of list) {
      run = prev !== null && c.tick !== null && prev !== null && c.tick - prev < BigInt(gap) ? run + 1 : 1
      best = Math.max(best, run)
      prev = c.tick
    }
    return best
  }

  function movements (setup = {}) {
    const moves = new Movements(ctx.bot)
    Object.assign(moves, setup)
    return moves
  }

  /** teleport the bot (console) and let it settle on the ground */
  async function teleport (pos) {
    const { bot } = ctx
    await bot.test.teleport(pos)
    await bot.waitForChunksToLoad()
    for (let i = 0; i < 40 && !bot.entity.onGround; i++) await bot.waitForTicks(1)
    await bot.waitForTicks(5)
  }

  /** highest block a bot can stand on at x, z (natural terrain; leaves and logs count as obstacles, not ground) */
  function surfaceY (x, z) {
    const { bot } = ctx
    for (let y = 120; y > 40; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      if (b.boundingBox === 'block' && !/leaves|_log$/.test(b.name)) return y + 1
      if (/water/.test(b.name)) return y + 1
    }
    throw new Error(`no surface at ${x} ${z}`)
  }

  /**
   * goto(goal) with the given movements; asserts the goal is reached in time without a correction storm
   * @returns {{ ms: number, corrections: number }}
   */
  async function run (title, goal, moves, { maxMs = 60000, maxCorrections = 4 } = {}) {
    const { bot } = ctx
    bot.pathfinder.setMovements(moves)
    const t0 = Date.now()
    let timer
    const timeout = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`${title}: goal not reached within ${maxMs} ms (at ${bot.entity.position}, resets ${resets})`)), maxMs) })
    try {
      await Promise.race([bot.pathfinder.goto(goal), timeout])
    } finally {
      clearTimeout(timer)
      bot.pathfinder.setGoal(null)
    }
    const ms = Date.now() - t0
    await bot.waitForTicks(10)
    const moved = significant()
    console.log(`      ${title}: ${(ms / 1000).toFixed(1)} s, ${corrections.length} correction(s), ${moved.length} moving the bot (max ${Math.max(0, ...moved.map(c => c.error ?? 1)).toFixed(2)} block, ${maxConsecutive(moved)} in a row), resets ${JSON.stringify(resets)}`)
    assert.ok(goal.isEnd(bot.entity.position.floored()) || goal.isEnd(bot.entity.position.floored().offset(0, 1, 0)), `${title}: at the goal (${bot.entity.position})`)
    assert.ok(moved.length <= maxCorrections, `${title}: ${moved.length} corrections moved the bot: ${JSON.stringify(moved.map(c => [String(c.tick), c.error]))}`)
    assert.ok(maxConsecutive(moved) <= 2, `${title}: correction storm (${maxConsecutive(moved)} in a row)`)
    return { ms, corrections: moved.length }
  }

  // ---- natural terrain (seed 2) ---------------------------------------------------------------------------------

  it('GoalNear over the forested hills: spawn → hill top (-55, 73, -30)', async () => {
    const { bot } = ctx
    await teleport(new Vec3(-31, surfaceY(-31, 6), 6))
    const top = new Vec3(-55, surfaceY(-55, -30), -30)
    await run('hills', new goals.GoalNear(top.x, top.y, top.z, 1), movements(), { maxMs: 90000 })
    assert.ok(bot.entity.position.y >= top.y - 1)
  })

  it('GoalBlock through water: swims across the lake to its south shore', async () => {
    const { bot } = ctx
    await teleport(new Vec3(-45, surfaceY(-45, 16), 16))
    const shore = new Vec3(-60, surfaceY(-60, 50), 50)
    const moves = movements({ canDig: false })
    let swam = 0
    const onTick = () => { if (bot.entity.isInWater) swam++ }
    bot.on('physicsTick', onTick)
    try {
      await run('lake', new goals.GoalBlock(shore.x, shore.y, shore.z), moves, { maxMs: 120000, maxCorrections: 8 })
    } finally {
      bot.removeListener('physicsTick', onTick)
    }
    assert.ok(swam > 40, `swam ${swam} ticks`)
  })

  it('GoalXZ 120 blocks north (chunks load on the way), GoalY back down', async () => {
    const { bot } = ctx
    await teleport(new Vec3(-31, surfaceY(-31, 6), 6))
    const loads = []
    const onLoad = (p) => loads.push(p)
    bot.on('chunkColumnLoad', onLoad)
    try {
      await run('GoalXZ 120', new goals.GoalXZ(-31, -114), movements(), { maxMs: 150000, maxCorrections: 8 })
    } finally {
      bot.removeListener('chunkColumnLoad', onLoad)
    }
    assert.ok(loads.length > 0, 'columns loaded while walking')
    const y = Math.floor(bot.entity.position.y)
    await run('GoalY', new goals.GoalY(y - 2), movements(), { maxMs: 60000 })
  })

  // ---- structured scenarios on the deck -------------------------------------------------------------------------

  it('builds the deck', async () => {
    const { bot } = ctx
    await teleport(new Vec3(-30, surfaceY(-30, -20), -20))
    await build(`fill -64 ${DECK_Y} -60 -10 ${DECK_Y + 12} -20 air`) // ≤ 32768 blocks per fill
    await build(`fill -48 ${DECK_Y} -50 -12 ${DECK_Y} -22 stone`)
    await teleport(new Vec3(-30, Y, -30))
    assert.strictEqual(bot.blockAt(new Vec3(-30, DECK_Y, -30)).name, 'stone')
  })

  it('up a ladder (no blocks, no digging): GoalBlock on top of a 6-high pillar', async () => {
    const { bot } = ctx
    await build(`fill -46 ${Y} -46 -46 ${Y + 5} -46 stone`)
    await build(`fill -46 ${Y} -45 -46 ${Y + 5} -45 ladder ["facing_direction"=3]`)
    await teleport(new Vec3(-46, Y, -40))
    let climbed = 0
    const onTick = () => { if (bot.blockAt(bot.entity.position)?.name === 'ladder') climbed++ }
    bot.on('physicsTick', onTick)
    try {
      await run('ladder', new goals.GoalBlock(-46, Y + 6, -46), movements({ canDig: false, allow1by1towers: false }), { maxMs: 40000 })
    } finally {
      bot.removeListener('physicsTick', onTick)
    }
    assert.ok(climbed > 5, `on the ladder for ${climbed} ticks`)
  })

  it('parkour: jumps a 1-block and a 2-block gap (no blocks, no digging)', async () => {
    const { bot } = ctx
    // a walkway off the deck, x -55..-53: z -24..-26 | gap -27 | -28..-29 | gap -30..-31 | -32..-34 (goal)
    await build(`fill -55 ${DECK_Y} -24 -53 ${DECK_Y} -26 stone`)
    await build(`fill -55 ${DECK_Y} -28 -53 ${DECK_Y} -29 stone`)
    await build(`fill -55 ${DECK_Y} -32 -53 ${DECK_Y} -34 stone`)
    await teleport(new Vec3(-54, Y, -24))
    const moves = movements({ canDig: false, allow1by1towers: false, allowParkour: true, allowSprinting: true })
    await run('parkour', new goals.GoalBlock(-54, Y, -33), moves, { maxMs: 40000 })
    for (const z of [-27, -30, -31]) assert.strictEqual(bot.blockAt(new Vec3(-54, DECK_Y, z)).name, 'air', 'jumped, nothing built')
  })

  it('scaffolding: pillars 5 blocks up with dirt (allow1by1towers)', async () => {
    const { bot } = ctx
    await teleport(new Vec3(-20, Y, -26))
    await give('dirt', 16)
    await run('pillar 5', new goals.GoalBlock(-20, Y + 5, -26), movements({ canDig: false }), { maxMs: 40000, maxCorrections: 2 })
    for (let y = Y; y < Y + 5; y++) assert.strictEqual(bot.blockAt(new Vec3(-20, y, -26)).name, 'dirt')
    assert.ok(!resets.includes('place_error'), `no refused placement: ${resets}`)
    await build(`fill -20 ${Y} -26 -20 ${Y + 6} -26 air`)
  })

  it('bridging: crosses a 5-block gap placing dirt (no recentring corrections)', async () => {
    const { bot } = ctx
    // two platforms off the deck: z -24..-26 and z -32..-34 at x -62..-60 — the gap is z -27..-31
    await build(`fill -62 ${DECK_Y} -24 -60 ${DECK_Y} -26 stone`)
    await build(`fill -62 ${DECK_Y} -32 -60 ${DECK_Y} -34 stone`)
    await build(`fill -62 ${DECK_Y} -27 -60 ${DECK_Y} -31 air`)
    await teleport(new Vec3(-61, Y, -24))
    await give('dirt', 32)
    await run('bridge 5', new goals.GoalBlock(-61, Y, -33), movements({ canDig: false, allowParkour: false }), { maxMs: 60000, maxCorrections: 1 })
    let placed = 0
    for (let z = -31; z <= -27; z++) for (let x = -62; x <= -60; x++) if (bot.blockAt(new Vec3(x, DECK_Y, z)).name === 'dirt') placed++
    assert.ok(placed >= 5, `bridge blocks: ${placed}`)
  })

  // ---- failures mid-path (FINAL-ROUND): an equip / a placement that fails never hangs goto or stop() ----------------

  /** two platforms x -62..-60 (z -38..-40 and z -46..-48), a 5-block gap z -41..-45 between them; the bot on the first */
  async function gapAhead () {
    await build(`fill -62 ${DECK_Y} -38 -60 ${DECK_Y} -48 air`)
    await build(`fill -62 ${DECK_Y} -38 -60 ${DECK_Y} -40 stone`)
    await build(`fill -62 ${DECK_Y} -46 -60 ${DECK_Y} -48 stone`)
    await teleport(new Vec3(-61, Y, -38))
    await give('dirt', 32)
  }
  const bridgeGoal = () => new goals.GoalBlock(-61, Y, -47)
  const bridgeMoves = () => movements({ canDig: false, allowParkour: false, allow1by1towers: false })
  const isScaffold = (item) => item?.name === 'dirt'

  /** goto(goal), settled within maxMs either way: { ok, error, ms } */
  async function settleGoto (goal, maxMs) {
    const t0 = Date.now()
    let timer
    const bound = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error(`goto neither reached the goal nor rejected within ${maxMs} ms (at ${ctx.bot.entity.position}, resets ${resets})`)), maxMs) })
    try {
      await Promise.race([ctx.bot.pathfinder.goto(goal), bound])
      return { ok: true, ms: Date.now() - t0 }
    } catch (error) {
      if (/neither reached/.test(error.message)) throw error
      return { ok: false, error, ms: Date.now() - t0 }
    } finally {
      clearTimeout(timer)
    }
  }

  it('bot.equip rejected mid-bridge: goto rejects within a bound (no hang on the equip lock); the next goto finishes the bridge', async () => {
    const { bot } = ctx
    await gapAhead()
    bot.pathfinder.setMovements(bridgeMoves())
    const equip = bot.equip
    let scaffoldEquips = 0
    let refused = 0
    // the third scaffolding equip and every one after it is rejected (two bridge blocks go out first)
    bot.equip = function (item, ...args) {
      if (isScaffold(item) && ++scaffoldEquips > 2) { refused++; return Promise.reject(new Error('equip refused (forced by the test)')) }
      return equip.call(bot, item, ...args)
    }
    let r
    try {
      r = await settleGoto(bridgeGoal(), 60000)
    } finally {
      bot.equip = equip
    }
    console.log(`      equip refused: ${r.ok ? 'reached' : `${r.error.name} (${r.error.message})`} in ${(r.ms / 1000).toFixed(1)} s, ${refused} refused equips, resets ${JSON.stringify(resets)}`)
    assert.ok(!r.ok, 'the bridge cannot be finished without the block in hand')
    assert.strictEqual(r.error.name, 'NoPath')
    assert.ok(refused >= 2 && refused <= bot.pathfinder.maxPlaceFailures, `${refused} refused equips: bounded`)
    assert.ok(resets.includes('equip_error'), `resets ${resets}`)
    let built = 0
    for (let z = -45; z <= -41; z++) for (let x = -62; x <= -60; x++) if (bot.blockAt(new Vec3(x, DECK_Y, z)).name === 'dirt') built++
    assert.ok(built >= 1, `the bridge was begun: ${built}`)
    // nothing is left holding the pathfinder: the same goal again, the equip working, is reached
    await run('bridge after refused equips', bridgeGoal(), bridgeMoves(), { maxMs: 60000, maxCorrections: 12 }) // corrections: the whole test's
  })

  it('a placement refused mid-bridge: retried once, then the bridge goes on in the next column — goal reached', async () => {
    const { bot } = ctx
    await gapAhead()
    const placeBlock = bot.placeBlock
    const tries = new Map()
    let forced = null
    // the third bridge cell is refused (the library's refusal error), as BDS refuses a block an entity stands in
    bot.placeBlock = function (ref, face) {
      const dest = ref.position.plus(face)
      if (!forced && tries.size === 2 && !tries.has(dest.toString())) forced = dest
      tries.set(dest.toString(), (tries.get(dest.toString()) ?? 0) + 1)
      if (forced && dest.equals(forced)) return Promise.reject(new Error(`Server refused to place dirt at ${dest}: the block is still air`))
      return placeBlock.call(bot, ref, face)
    }
    let r
    try {
      r = await run('bridge with a refused cell', bridgeGoal(), bridgeMoves(), { maxMs: 60000, maxCorrections: 6 })
    } finally {
      bot.placeBlock = placeBlock
    }
    console.log(`      refused at ${forced}: tried ${tries.get(String(forced))} times; cells ${JSON.stringify([...tries])}`)
    assert.ok(forced, 'a cell was refused')
    assert.strictEqual(tries.get(forced.toString()), 2, 'the refused cell was tried twice, then avoided')
    assert.strictEqual(bot.blockAt(forced).name, 'air')
    assert.deepStrictEqual(resets.filter((x) => x === 'place_error'), ['place_error', 'place_error'])
    assert.ok(r.ms < 60000)
  })

  it('stop() while a placement never answers: goto rejects (PathStopped) at once; the next goto finishes the bridge', async () => {
    const { bot } = ctx
    await gapAhead()
    bot.pathfinder.setMovements(bridgeMoves())
    const placeBlock = bot.placeBlock
    const state = { placements: 0, hung: false }
    // the second placement never answers (a server that drops it)
    bot.placeBlock = function (ref, face) {
      if (++state.placements === 2) { state.hung = true; return new Promise(() => {}) }
      return placeBlock.call(bot, ref, face)
    }
    const goto = bot.pathfinder.goto(bridgeGoal())
    let outcome
    try {
      for (let i = 0; i < 600 && !state.hung; i++) await bot.waitForTicks(1) // ≤ 30 s
      assert.ok(state.hung, 'the second placement went out')
      await bot.waitForTicks(10)
      assert.ok(bot.pathfinder.isBuilding(), 'waiting for the placement')
      const t1 = Date.now()
      bot.pathfinder.stop()
      outcome = await Promise.race([goto.then(() => 'resolved', (err) => err.name), new Promise((resolve) => setTimeout(() => resolve('pending'), 2000))])
      console.log(`      stop() with a hung placement: goto ${outcome} after ${Date.now() - t1} ms`)
    } finally {
      bot.placeBlock = placeBlock
    }
    assert.strictEqual(outcome, 'PathStopped')
    assert.ok(!bot.pathfinder.isBuilding() && bot.pathfinder.goal === null)
    // the bot was left leaning over the edge: the next search starts from the block it stands on, not from the cell
    // over the gap (whose placement against the air under it would time out)
    const before = resets.length
    await run('bridge after a stop', bridgeGoal(), bridgeMoves(), { maxMs: 30000, maxCorrections: 8 }) // corrections: the whole test's
    assert.ok(!resets.slice(before).some((r) => r !== 'block_updated'), `resets after the stop: ${resets.slice(before)}`)
  })

  it('digging through a wall: a bedrock corridor closed by stone (canDig, iron pickaxe)', async () => {
    const { bot } = ctx
    // corridor along z at x -30 (inside: y Y..Y+1, z -24..-34), bedrock shell, a stone wall at z -29 / -30
    await build(`fill -31 ${DECK_Y} -23 -29 ${Y + 2} -35 bedrock`)
    await build(`fill -30 ${Y} -24 -30 ${Y + 1} -34 air`)
    await build(`fill -30 ${Y} -29 -30 ${Y + 1} -30 stone`)
    await teleport(new Vec3(-30, Y, -24))
    await give('iron_pickaxe', 1)
    let dug = 0
    const onDug = () => { dug++ }
    bot.on('diggingCompleted', onDug)
    try {
      await run('wall', new goals.GoalBlock(-30, Y, -34), movements({ canDig: true, allow1by1towers: false }), { maxMs: 60000 })
    } finally {
      bot.removeListener('diggingCompleted', onDug)
    }
    assert.ok(dug >= 4, `dug ${dug} blocks (diggingCompleted)`)
    for (const [y, z] of [[Y, -29], [Y + 1, -29], [Y, -30], [Y + 1, -30]]) assert.strictEqual(bot.blockAt(new Vec3(-30, y, z)).name, 'air')
    assert.strictEqual(bot.heldItem?.name, 'iron_pickaxe', 'bestHarvestTool equipped the pickaxe')
  })

  it('opening a wooden door and a fence gate (canOpenDoors, no digging)', async () => {
    const { bot } = ctx
    // corridor along z at x -36: a wooden door at z -27, a fence gate at z -31, goal at z -34
    await build(`fill -37 ${DECK_Y} -23 -35 ${Y + 2} -35 bedrock`)
    await build(`fill -36 ${Y} -24 -36 ${Y + 1} -34 air`)
    // BDS: setblock of the lower half places the whole door
    await build(`setblock -36 ${Y} -27 wooden_door ["minecraft:cardinal_direction"="west","upper_block_bit"=false,"open_bit"=false]`)
    await build(`setblock -36 ${Y} -31 fence_gate ["minecraft:cardinal_direction"="south","open_bit"=false]`)
    await teleport(new Vec3(-36, Y, -24))
    assert.strictEqual(bot.blockAt(new Vec3(-36, Y, -27)).name, 'wooden_door')
    assert.strictEqual(bot.blockAt(new Vec3(-36, Y + 1, -27)).name, 'wooden_door')
    let used = 0
    const activate = bot.activateBlock
    bot.activateBlock = (...args) => { used++; return activate.apply(bot, args) }
    try {
      await run('door + gate', new goals.GoalBlock(-36, Y, -34), movements({ canDig: false, canOpenDoors: true, allow1by1towers: false }), { maxMs: 60000 })
    } finally {
      bot.activateBlock = activate
    }
    assert.ok(used >= 2, `opened ${used} doors / gates`)
    assert.strictEqual(bot.blockAt(new Vec3(-36, Y, -27)).getProperties().open_bit, 1, 'the door is open')
    assert.strictEqual(bot.blockAt(new Vec3(-36, Y, -31)).getProperties().open_bit, 1, 'the gate is open')
  })

  it('GoalFollow: follows a second bot across the deck (dynamic goal)', async () => {
    const { bot, server } = ctx
    const { createTestBot } = require('./common')
    await teleport(new Vec3(-20, Y, -45))
    const leader = await createTestBot({ server, username: 'leader' })
    try {
      await leader.bot.test.teleport(new Vec3(-22, Y, -45))
      await bot.waitForTicks(10)
      const target = bot.players.leader?.entity
      assert.ok(target, 'the leader is visible')
      bot.pathfinder.setMovements(movements({ canDig: false, allow1by1towers: false }))
      bot.pathfinder.setGoal(new goals.GoalFollow(target, 2), true)
      for (const [x, z] of [[-26, -40], [-30, -34], [-36, -30], [-40, -26]]) {
        await leader.bot.test.teleport(new Vec3(x, Y, z))
        const t0 = Date.now()
        while (bot.entity.position.distanceTo(target.position) > 3) {
          assert.ok(Date.now() - t0 < 20000, `following: ${bot.entity.position} → leader ${target.position}`)
          await bot.waitForTicks(2)
        }
      }
      console.log(`      follow: ${corrections.length} correction(s), ${significant().length} moving the bot`)
      assert.ok(significant().length <= 4)
    } finally {
      bot.pathfinder.setGoal(null)
      leader.bot.end()
    }
  })
})
