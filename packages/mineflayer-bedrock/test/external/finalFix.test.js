// owner: FINAL-FIX-LIB (final-acceptance review fixes)
'use strict'
/**
 * Live regression tests for the final-acceptance review findings (BDS 1.26.51.1, flat world; the unit-level ones are
 * in test/unit/final_fix.test.js):
 * - #1 placing against a replaceable block (snow layer, short grass) or the same half slab: the block goes into the
 *   clicked position, ONE click, upstream's `Server refused` rejection (no second block above it);
 * - #2 deposit / withdraw (clickWindow) while item pickups and /give land on the touched slots: no rejection;
 * - #3 a /give merging into the held stack while the click is on its way: placeBlock still places;
 * - #4 mineflayer-pathfinder walks back through a door it opened: not clicked shut, not dug;
 * - #5 mineflayer-collectblock's cancelTask() during a dig ends the collection;
 * - #6 Bedrock's sticky sprint: releasing the sprint control while walking on gets no corrections;
 * - #7 'end' after bot.quit() comes asynchronously;
 * - #8 a raised shield stays raised through clearControlStates().
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot, createTestBot } = require('./common')
const { queryTargetPosition } = require('./common/helpers/base')

const G = -60
const UP = new Vec3(0, 1, 0)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('finalFix (FINAL-FIX-LIB): final-acceptance review fixes on BDS', function () {
  this.timeout(180000)
  const env = useBot({ server: { gamemode: 'creative' } })
  let clicks = 0
  let restoreQueue = null

  before(() => {
    const { bot } = env
    const queue = bot._client.queue
    bot._client.queue = function (name, params) {
      if (name === 'inventory_transaction' && params?.transaction?.transaction_data?.action_type === 'click_block') clicks++
      return queue.apply(this, arguments)
    }
    restoreQueue = () => { bot._client.queue = queue }
  })
  after(() => restoreQueue?.())
  beforeEach(async () => {
    const { bot } = env
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow).catch(() => {})
    bot.clearControlStates()
    if (bot.usingHeldItem) bot.deactivateItem()
    if (bot.pathfinder) {
      bot.pathfinder.stop()
      bot.pathfinder.setGoal(null)
    }
    await bot.test.becomeCreative()
    await bot.test.resetState()
    clicks = 0
  })

  const count = (bot, name) => bot.inventory.count(bot.registry.itemsByName[name].id)

  async function build (cmd) {
    const out = await env.bot.test.ctx.consoleOutput(cmd)
    if (!out.some((l) => /filled|placed|couldn't be placed|No blocks/i.test(l))) throw new Error(`${cmd}: ${out.join(' | ')}`)
  }

  describe('#1 a click that replaces / merges into the clicked block', () => {
    for (const [refName, item, after] of [['snow_layer', 'dirt', 'dirt'], ['short_grass', 'dirt', 'dirt'], ['oak_slab', 'oak_slab', 'oak_double_slab']]) {
      it(`${item} against ${refName}: the block goes into it (${after}), one click, upstream's refusal, nothing above`, async () => {
        const { bot } = env
        await bot.test.becomeSurvival()
        await bot.test.give(item, 10)
        const ref = new Vec3(2, G, 0)
        await bot.test.setBlock({ ...ref, blockName: refName })
        assert.strictEqual(bot.blockAt(ref).name, refName)
        clicks = 0
        await assert.rejects(bot.placeBlock(bot.blockAt(ref), UP), new RegExp(`^Error: Server refused to place ${item} at \\(2, -59, 0\\): the block is still air$`))
        await sleep(1000) // a retry would have gone out by now
        assert.strictEqual(clicks, 1, 'one click')
        assert.strictEqual(bot.blockAt(ref).name, after, 'placed into the clicked position')
        assert.strictEqual(bot.blockAt(ref.offset(0, 1, 0)).name, 'air', 'no second block above it')
        assert.strictEqual(count(bot, item), 9, 'one item used')
      })
    }
  })

  describe('#3 / #2 server-side changes of the touched stacks while a request is on its way', () => {
    it('placeBlock: a /give merging into the held stack right before the click still places (retried once)', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 10)
      await sleep(300)
      const refs = [new Vec3(2, G - 1, 0), new Vec3(-2, G - 1, 0), new Vec3(0, G - 1, 2), new Vec3(0, G - 1, -2)]
      for (const ref of refs) {
        await bot.lookAt(ref.offset(0.5, 1, 0.5), true)
        await sleep(200)
        bot.chat('/give @s dirt 1') // BDS changes the held stack (new stack id) right before it handles the click
        await bot._placeBlockWithOptions(bot.blockAt(ref), UP, { forceLook: 'ignore', swingArm: 'right' })
        assert.strictEqual(bot.blockAt(ref.offset(0, 1, 0)).name, 'dirt', `placed on ${ref}`)
        await sleep(400)
      }
      await sleep(500)
      assert.strictEqual(count(bot, 'dirt'), 10, `10 + ${refs.length} given - ${refs.length} placed`)
    })

    it('chest deposit / withdraw loop while pickups and /give land on the stack: never rejected', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 32)
      const chestPos = new Vec3(0, G, 2)
      await bot.test.setBlock({ ...chestPos, blockName: 'chest' })
      const chest = await bot.openContainer(bot.blockAt(chestPos))
      const dirt = bot.registry.itemsByName.dirt.id
      let gives = 0
      let drops = 0
      const state = { stop: false }
      // a /give or a dropped block at the bot's feet (picked up) every ~300 ms, independent of the bot's packets
      const changer = (async () => {
        for (let i = 0; !state.stop; i++) {
          if (i % 2 === 0) {
            await server.command(`give "${bot.username}" dirt 1`)
            gives++
          } else {
            await server.command(`setblock 1 ${G} 0 dirt`)
            await server.command(`setblock 1 ${G} 0 air destroy`)
            drops++
          }
          await sleep(300)
        }
      })()
      const failures = []
      let ops = 0
      const until = Date.now() + 10000
      try {
        while (Date.now() < until) {
          try {
            await chest.deposit(dirt, null, 1)
            await chest.withdraw(dirt, null, 1)
            ops += 2
          } catch (err) {
            failures.push(err.message)
          }
        }
      } finally {
        state.stop = true
        await changer
        await chest.close()
      }
      console.log(`      ${ops} deposits / withdrawals, ${gives} gives, ${drops} drops, ${failures.length} failures`)
      assert.ok(gives >= 5 && ops >= 20, `${ops} ops, ${gives} gives`)
      assert.deepStrictEqual(failures, [])
    })

    it('rapid clickWindow / transfer in the inventory while drops are picked up: never rejected, counts add up', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 40)
      await sleep(300)
      const state = { stop: false }
      let added = 0
      const changer = (async () => {
        while (!state.stop) {
          await server.command(`setblock 1 ${G} 0 dirt`)
          await server.command(`setblock 1 ${G} 0 air destroy`)
          added++
          await sleep(250)
        }
      })()
      const failures = []
      let ops = 0
      const dirt = bot.registry.itemsByName.dirt.id
      const until = Date.now() + 8000
      try {
        while (Date.now() < until) {
          const item = bot.inventory.findInventoryItem(dirt)
          if (!item) break
          const dest = item.slot === 9 ? 10 : 9
          try {
            await bot.moveSlotItem(item.slot, dest)
            ops++
            if (bot.inventory.slots.slice(9, 36).some((it) => it?.type === dirt)) {
              await bot.transfer({ window: bot.inventory, itemType: dirt, metadata: null, count: 1, sourceStart: 9, sourceEnd: 36, destStart: 36, destEnd: 45 })
              ops++
            }
          } catch (err) {
            failures.push(err.message)
          }
        }
      } finally {
        state.stop = true
        await changer
      }
      await sleep(1500) // the last drops picked up
      await bot.test.resyncInventory?.()
      console.log(`      ${ops} clicks / transfers, ${added} drops, ${failures.length} failures, ${count(bot, 'dirt')} dirt`)
      assert.ok(ops >= 10, `${ops} operations`)
      assert.deepStrictEqual(failures, [])
    })
  })

  describe('#4 / #5 ecosystem', () => {
    it('mineflayer-pathfinder walks back through the door it opened: not clicked shut, not dug', async () => {
      const { bot } = env
      if (!bot.pathfinder) bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
      const { Movements, goals } = require('mineflayer-pathfinder')
      await bot.test.becomeSurvival()
      // a 1-wide corridor along z at x 3 with a wooden door at z -3
      await build(`fill 2 ${G - 1} 1 4 ${G + 2} -7 bedrock`)
      await build(`fill 3 ${G} 0 3 ${G + 1} -6 air`)
      await build(`setblock 3 ${G} -3 wooden_door ["minecraft:cardinal_direction"="west","upper_block_bit"=false,"open_bit"=false]`)
      await bot.test.teleport(new Vec3(3.5, G, 0.5))
      await bot.waitForTicks(10)
      let used = 0
      let dug = 0
      const activate = bot.activateBlock
      const dig = bot.dig
      bot.activateBlock = (...args) => { used++; return activate.apply(bot, args) }
      bot.dig = (...args) => { dug++; return dig.apply(bot, args) }
      const corrections = []
      const off = bot._bedrock.physics.onCorrection((c) => corrections.push(c))
      try {
        const moves = new Movements(bot) // default: canDig, canOpenDoors set below
        moves.canOpenDoors = true
        moves.allow1by1towers = false
        bot.pathfinder.setMovements(moves)
        await bot.pathfinder.goto(new goals.GoalBlock(3, G, -6))
        assert.strictEqual(used, 1, 'opened the door once')
        const lower = bot.blockAt(new Vec3(3, G, -3))
        const upper = bot.blockAt(new Vec3(3, G + 1, -3))
        assert.strictEqual(lower.getProperties().open_bit, 1, 'open')
        assert.strictEqual(upper.getProperties().open_bit, 0, 'BDS keeps the upper half\'s open_bit at 0')
        assert.deepStrictEqual(upper.shapes, lower.shapes, 'the upper half\'s leaf follows the lower half (blocks.js)')
        used = 0
        corrections.length = 0
        await bot.pathfinder.goto(new goals.GoalBlock(3, G, 0))
        assert.strictEqual(used, 0, 'not clicked (that would close it)')
        assert.strictEqual(dug, 0, 'not dug')
        assert.strictEqual(bot.blockAt(new Vec3(3, G, -3)).name, 'wooden_door')
        assert.strictEqual(bot.blockAt(new Vec3(3, G + 1, -3)).name, 'wooden_door')
        assert.strictEqual(bot.blockAt(new Vec3(3, G, -3)).getProperties().open_bit, 1, 'still open')
        const moved = corrections.filter((c) => c.error === null || c.error > 0.01)
        assert.ok(moved.length <= 1, `corrections walking through the open door: ${moved.length}`)
      } finally {
        off()
        bot.activateBlock = activate
        bot.dig = dig
        bot.pathfinder.setGoal(null)
      }
    })

    it('mineflayer-collectblock: cancelTask() while a log is dug (pathfinder idle) resolves and ends the collection', async () => {
      const { bot } = env
      if (!bot.collectBlock) {
        bot.loadPlugin(require('mineflayer-collectblock').plugin)
        await bot.waitForTicks(2)
      }
      await bot.test.becomeSurvival()
      const logs = [new Vec3(3, G, 0), new Vec3(3, G, 2), new Vec3(3, G, -2), new Vec3(-3, G, 0)]
      for (const p of logs) await bot.test.setBlock({ ...p, blockName: 'oak_log' })
      const blocks = logs.map((p) => bot.blockAt(p))
      let finished = false
      const job = bot.collectBlock.collect(blocks).then(() => { finished = true })
      try {
        for (let i = 0; i < 200 && !bot.targetDigBlock; i++) await bot.waitForTicks(1)
        assert.ok(bot.targetDigBlock, 'digging the first log')
        assert.strictEqual(bot.pathfinder.isMoving(), false, 'the pathfinder is idle while digging')
        const t0 = Date.now()
        await Promise.race([bot.collectBlock.cancelTask(), sleep(15000).then(() => { throw new Error('cancelTask did not resolve within 15 s') })])
        const ms = Date.now() - t0
        await job
        assert.ok(finished)
        const left = logs.filter((p) => bot.blockAt(p).name === 'oak_log').length
        console.log(`      cancelTask resolved after ${ms} ms, ${logs.length - left} log(s) dug`)
        assert.ok(left >= logs.length - 1, `the collection ended after the log in progress (${left} left)`)
      } finally {
        await bot.collectBlock.cancelTask().catch(() => {})
        bot.pathfinder.setGoal(null)
      }
    })
  })

  describe('#6 / #8 movement', () => {
    async function sprintRun (bot, releaseEveryTick) {
      await bot.test.becomeSurvival()
      await bot.look(-Math.PI / 2, 0, true) // east, open flat ground
      await bot.waitForTicks(5)
      const corrections = []
      const off = bot._bedrock.physics.onCorrection((c) => corrections.push(c))
      const onTick = () => bot.setControlState('sprint', false) // mineflayer-pathfinder's walking branches
      try {
        if (releaseEveryTick) {
          // a double-tapped forward (pathfinder's short moves), sprint released every tick
          bot.on('physicsTick', onTick)
          bot.setControlState('forward', true)
          await bot.waitForTicks(3)
          bot.setControlState('forward', false)
          await bot.waitForTicks(1)
          bot.setControlState('forward', true)
          await bot.waitForTicks(60)
        } else {
          bot.setControlState('forward', true)
          await bot.waitForTicks(4)
          bot.setControlState('sprint', true)
          await bot.waitForTicks(2)
          bot.setControlState('sprint', false)
          await bot.waitForTicks(80)
        }
        bot.setControlState('forward', false)
        await sleep(1000)
      } finally {
        bot.removeListener('physicsTick', onTick)
        bot.clearControlStates()
        off()
      }
      return corrections.filter((c) => c.error === null || c.error > 0.01)
    }

    it('sprint released while forward stays held: BDS keeps sprinting, the bot predicts it — no corrections', async () => {
      const { bot, server } = env
      const start = bot.entity.position.clone()
      const corrections = await sprintRun(bot, false)
      const travelled = bot.entity.position.distanceTo(start)
      assert.ok(travelled > 80 * 0.2158 * 1.2, `travelled ${travelled.toFixed(2)} blocks: sprint speed`)
      assert.strictEqual(corrections.length, 0, `corrections: ${JSON.stringify(corrections.map((c) => c.error))}`)
      const serverFeet = await queryTargetPosition(server, bot.username)
      assert.ok(serverFeet.distanceTo(bot.entity.position) < 0.1, `server ${serverFeet}, bot ${bot.entity.position}`)
    })

    it('a double-tap sprint with the sprint control released every tick (pathfinder): no corrections', async () => {
      const { bot } = env
      const corrections = await sprintRun(bot, true)
      assert.strictEqual(corrections.length, 0, `corrections: ${JSON.stringify(corrections.map((c) => c.error))}`)
    })

    it('a raised shield stays raised through clearControlStates() (the server keeps the player sneaking)', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      const Item = require('prismarine-item')(bot.registry)
      await bot.test.setInventorySlot(45, new Item(bot.registry.itemsByName.shield.id, 1, 0))
      bot.activateItem(true)
      await bot.waitForTicks(10)
      assert.strictEqual(bot.entity.crouching, true, 'raised (sneaking)')
      bot.clearControlStates() // mineflayer-pathfinder's fullStop / resetPath under mineflayer-pvp
      await bot.waitForTicks(10)
      assert.strictEqual(bot.entity.crouching, true, 'still raised')
      bot.deactivateItem()
      await bot.waitForTicks(10)
      assert.strictEqual(bot.entity.crouching, false, 'lowered')
    })
  })

  describe('#7 lifecycle', () => {
    it("bot.quit(): 'end' comes after quit() returned (a flag set right after it is seen)", async () => {
      const { server } = env
      const { bot: other, stop } = await createTestBot({ server, username: 'quitter' })
      try {
        let stopping = false
        const seen = new Promise((resolve) => other.once('end', (reason) => resolve({ reason, stopping })))
        other.quit()
        stopping = true
        const { reason, stopping: flag } = await seen
        assert.strictEqual(flag, true, "the 'end' listener saw the flag set after quit()")
        assert.strictEqual(reason, 'disconnect.quitting')
      } finally {
        await stop?.().catch?.(() => {})
      }
    })
  })
})
