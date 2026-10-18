'use strict'
// owner: U5 (physics & movement) — contract: mineflayer-pathfinder's lib/physics.js (simulateUntil, canStraightLine,
// canWalkJump / canSprintJump, …) runs unchanged on a mineflayer-bedrock bot: it builds prismarine-physics'
// own PlayerState (require('minecraft-data')(bot.version) → the Bedrock data) and steps it with
// bot.physics.simulatePlayer (the Bedrock engine) on the recorded flat world (test/fixtures join_flat) plus an overlay.
const assert = require('assert')
const { Vec3 } = require('vec3')
const PathfinderPhysics = require('mineflayer-pathfinder/lib/physics')
const { PlayerState } = require('prismarine-physics')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { createWorld } = require('./helpers/physics_world')

async function pathfinderBot () {
  const { bot, client, clock } = await createFakeBot()
  await replayJoin(bot, client)
  for (let i = 0; i < 3; i++) { clock.advance(50); bot._bedrock.input.pump() }
  // overlay blocks on top of the decoded flat world (bot.blockAt is what pathfinder's world reads)
  const overlay = createWorld()
  const changed = new Set()
  const blockAt = bot.blockAt
  bot.blockAt = (pos, extraInfos) => {
    const key = `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`
    return changed.has(key) ? overlay.getBlock(pos) : blockAt(pos, extraInfos)
  }
  bot.overlay = (x1, y1, z1, x2, y2, z2, name, props) => {
    overlay.fill(x1, y1, z1, x2, y2, z2, name, props)
    for (let x = x1; x <= x2; x++) for (let y = y1; y <= y2; y++) for (let z = z1; z <= z2; z++) changed.add(`${x},${y},${z}`)
  }
  return bot
}

describe('mineflayer-pathfinder lib/physics.js on the Bedrock engine (U5 contract)', function () {
  this.timeout(30000)

  it('builds prismarine-physics PlayerStates from the bot and simulates them with bot.physics.simulatePlayer', async () => {
    const bot = await pathfinderBot()
    const physics = new PathfinderPhysics(bot)
    const state = physics.simulateUntilNextTick()
    assert.ok(state instanceof PlayerState, 'upstream class (prismarine-physics, pinned single copy)')
    assert.strictEqual(state.onGround, true)
    assert.ok(Math.abs(state.pos.y - -60) < 1e-6)
    bot.entity.position = new Vec3(0.5, -55, 0.5)
    bot.entity.onGround = false
    const landed = physics.simulateUntilOnGround(40)
    assert.strictEqual(landed.onGround, true)
    assert.strictEqual(landed.pos.y, -60)
  })

  it('simulateUntil with a controller walks to a goal; canStraightLine on flat ground', async () => {
    const bot = await pathfinderBot()
    const physics = new PathfinderPhysics(bot)
    const goal = new Vec3(4.5, -60, 0.5)
    const reached = physics.getReached([goal])
    const state = physics.simulateUntil(reached, physics.getController(goal, false, false), 60)
    assert.ok(reached(state), `${state.pos}`)
    assert.strictEqual(physics.canStraightLine([goal]), true)
    assert.strictEqual(physics.canStraightLine([goal], true), true, 'sprinting')
    assert.strictEqual(physics.canStraightLineBetween(new Vec3(0.5, -60, 0.5), new Vec3(3.5, -60, 0.5)), true)
  })

  it('jumps: a 1-high step needs a walk-jump, a 2-block gap a sprint-jump (Bedrock 0.42 jump, 0.5625 step)', async () => {
    const bot = await pathfinderBot()
    const physics = new PathfinderPhysics(bot)
    bot.overlay(2, -60, -1, 2, -60, 1, 'stone') // a 1-block step up at x=2
    const onStep = new Vec3(2.5, -59, 0.5)
    assert.strictEqual(physics.canStraightLine([onStep]), true, 'with a delayed jump (upstream semantics)')
    assert.strictEqual(physics.canWalkJump([onStep], 0), false, 'jumping against the step from the start is too slow')
    assert.strictEqual(physics.canWalkJump([onStep], 2), true)

    const gapBot = await pathfinderBot()
    const gap = new PathfinderPhysics(gapBot)
    gapBot.overlay(1, -64, -2, 2, -61, 2, 'air') // 2-wide hole in the ground at x=1..2
    const across = new Vec3(3.5, -60, 0.5)
    gapBot.entity.position = new Vec3(0.5, -60, 0.5)
    assert.strictEqual(gap.canSprintJump([across]), true, 'sprint-jump crosses the gap')
    assert.strictEqual(gap.canWalkJump([across]), false, 'a walk-jump falls in')
  })
})
