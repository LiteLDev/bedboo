// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * Pathfinder-critical placements against BDS 1.26.51.1 (Bedrock extra), in survival with gravity:
 * - pillar up: jump, place under the feet while airborne — as soon as the feet left the ground, like
 *   mineflayer-pathfinder (its canPlace check); bot._genericPlace holds the click until an input with the hitbox above
 *   the destination went out (BDS refuses a block inside the player), so no placement is refused;
 * - bridge: sneak backwards to the edge (sneak edge avoidance keeps the bot on the block), place against the side of
 *   the block below, step onto it;
 * - the same through mineflayer-pathfinder 2.4.5 itself (allow1by1towers, scaffolding from the inventory).
 * Server corrections (correct_player_move_prediction) are counted and logged for each scenario
 * (docs/differences/U11.md#scaffolding): the manual pillar and bridge get none that moves the bot; pathfinder's bridge
 * gets small ones
 * from its own client-side recentering (fullStop moves bot.entity.position, which a server-authoritative BDS corrects).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('scaffold', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  let corrections = []
  let unsubscribe = null
  beforeEach(async () => {
    await ctx.bot.test.resetState()
    corrections = []
    unsubscribe = ctx.bot._bedrock.physics.onCorrection((c) => corrections.push(c))
  })
  afterEach(async () => {
    const { bot } = ctx
    unsubscribe?.()
    bot.pathfinder?.stop()
    bot.clearControlStates()
    await bot.test.becomeCreative()
    await bot.test.ctx.consoleExpect(`fill -6 ${bot.test.groundY} -6 10 ${bot.test.groundY + 10} 6 air`, /blocks? filled/i)
  })

  const give = (slot, name, count) => ctx.bot.test.setInventorySlot(slot, new (require('prismarine-item')(ctx.bot.registry))(ctx.bot.registry.itemsByName[name].id, count, 0))
  async function survival () {
    await ctx.bot.test.becomeSurvival()
    ctx.bot.creative.stopFlying()
    await ctx.bot.test.wait(500)
  }
  function report (title) {
    const errors = corrections.map(c => c.error ?? 0)
    console.log(`      ${title}: ${corrections.length} correction(s)${errors.length ? `, max error ${Math.max(...errors).toFixed(3)}` : ''}`)
  }
  const ticks = (n) => ctx.bot.waitForTicks(n)
  /** corrections that moved the bot (a correction to the very position we predicted changes nothing) */
  const significant = () => corrections.filter(c => c.error === null || c.error > 0.01)

  it('pillar up 4: jump, place under the feet as soon as they left the ground (pathfinder timing), no refusal', async () => {
    const { bot } = ctx
    await give(36, 'dirt', 8)
    await survival()
    bot.setQuickBarSlot(0)
    const startY = bot.entity.position.floored().y
    for (let i = 0; i < 4; i++) {
      const feet = bot.entity.position.floored()
      bot.setControlState('jump', true)
      while (!(bot.entity.position.y > feet.y + 0.001)) await ticks(1)
      await bot.placeBlock(bot.blockAt(feet.offset(0, -1, 0)), new Vec3(0, 1, 0))
      bot.setControlState('jump', false)
      while (!bot.entity.onGround) await ticks(1)
      await ticks(2)
      assert.strictEqual(bot.blockAt(feet).name, 'dirt')
    }
    await ticks(10)
    assert.ok(Math.abs(bot.entity.position.y - (startY + 4)) < 0.01, `on top of the pillar: ${bot.entity.position}`)
    assert.strictEqual(bot.heldItem.count, 4)
    report('manual pillar')
    assert.deepStrictEqual(significant(), [])
  })

  it('bridge 4: sneak backwards to the edge, place against the side of the block below, step on', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const Y = g + 4
    await bot.test.ctx.consoleExpect(`fill 0 ${Y - 1} 0 0 ${Y - 1} 0 stone`, /blocks? filled/i)
    await bot.test.teleport(new Vec3(0, Y, 0))
    await give(36, 'dirt', 8)
    await survival()
    bot.setQuickBarSlot(0)
    for (let x = 0; x < 4; x++) {
      // face west, walk back (east) while sneaking until the edge stops us
      await bot.look(Math.PI / 2, -1.2, true)
      bot.setControlState('sneak', true)
      bot.setControlState('back', true)
      let last = -Infinity
      for (let i = 0; i < 80; i++) {
        await ticks(1)
        if (bot.entity.position.x - last < 0.001) break
        last = bot.entity.position.x
      }
      bot.setControlState('back', false)
      assert.ok(bot.entity.position.x > x + 1, `at the east edge of block ${x}: ${bot.entity.position}`)
      assert.ok(bot.entity.onGround, 'sneaking kept us on the block')
      await bot.placeBlock(bot.blockAt(new Vec3(x, Y - 1, 0)), new Vec3(1, 0, 0))
      assert.strictEqual(bot.blockAt(new Vec3(x + 1, Y - 1, 0)).name, 'dirt')
      bot.setControlState('sneak', false)
      // step onto the new block (to its centre)
      bot.setControlState('back', true)
      while (bot.entity.position.x < x + 1.5) await ticks(1)
      bot.setControlState('back', false)
      await ticks(10)
    }
    assert.ok(bot.entity.position.x > 4 && Math.abs(bot.entity.position.y - Y) < 0.01, `on the bridge: ${bot.entity.position}`)
    report('manual bridge')
    assert.deepStrictEqual(significant(), [])
  })

  it('mineflayer-pathfinder: pillar up 5 (allow1by1towers), then bridge 5 across the air', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
    if (!bot.pathfinder) bot.loadPlugin(pathfinder)
    await give(36, 'dirt', 32)
    await survival()
    const moves = new Movements(bot)
    moves.allow1by1towers = true
    moves.canDig = false
    bot.pathfinder.setMovements(moves)
    const resets = []
    const onReset = (reason) => resets.push(reason)
    bot.on('path_reset', onReset)
    try {
      await bot.pathfinder.goto(new goals.GoalBlock(0, g + 5, 0))
      assert.deepStrictEqual(bot.entity.position.floored(), new Vec3(0, g + 5, 0))
      for (let y = g; y < g + 5; y++) assert.strictEqual(bot.blockAt(new Vec3(0, y, 0)).name, 'dirt')
      assert.ok(!resets.includes('place_error'), `no refused placement while pillaring: ${resets}`)
      report('pathfinder pillar')
      assert.deepStrictEqual(significant(), [])
      corrections = []

      await bot.pathfinder.goto(new goals.GoalBlock(5, g + 5, 0))
      assert.deepStrictEqual(bot.entity.position.floored(), new Vec3(5, g + 5, 0))
      for (let x = 1; x <= 5; x++) assert.strictEqual(bot.blockAt(new Vec3(x, g + 4, 0)).name, 'dirt')
      assert.ok(!resets.includes('place_error'), `no refused placement while bridging: ${resets}`)
      report('pathfinder bridge')
      const maxError = Math.max(0, ...corrections.map(c => c.error ?? 0))
      assert.ok(maxError < 1, `corrections stay small (pathfinder's recentering): ${maxError}`)
    } finally {
      bot.removeListener('path_reset', onReset)
    }
  })
})
