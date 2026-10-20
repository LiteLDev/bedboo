// owner: POLISH-LIB (last library gaps found by the agent runs)
'use strict'
/**
 * Live regression tests (BDS 1.26.51.1, flat world; the unit-level ones are in test/unit/polish_lib.test.js):
 * - falling blocks: BDS sends update_block_synced (never update_block) when gravel / sand starts falling (the start
 *   position → air, 'create') and when it lands ('destroy'); bot.blockAt follows at once, blockUpdate fires, the client
 *   world matches the server's (testforblock), mineflayer-pathfinder re-plans and still arrives;
 * - mineflayer-auto-eat patch: a failed equip clears the eating flag (the automatic mode eats again), a failed meal
 *   emits 'eatFail' under the default strictErrors;
 * - mineflayer-tool patch: mineflayer-collectblock without a pickaxe rejects with NoItem (the process froze and ran out
 *   of memory);
 * - inventory resync: inventory_mismatch → BDS resends the inventory; a desynced slot heals by itself (a click on it,
 *   a pickup into it); fast ore digging with requests in flight on the pickup slot stays in sync (no resync needed).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const G = -60
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('polishLib (POLISH-LIB): falling blocks, auto-eat / tool patches, inventory resync on BDS', function () {
  this.timeout(180000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })

  before(async () => {
    const { bot } = env
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
    bot.loadPlugin(require('mineflayer-collectblock').plugin)
    await bot.waitForTicks(2) // collectblock loads pathfinder and tool on the next tick
    assert.ok(bot.autoEat && bot.collectBlock && bot.pathfinder && bot.tool)
  })
  beforeEach(async () => {
    const { bot } = env
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow).catch(() => {})
    bot.pathfinder.setGoal(null)
    bot.autoEat.disableAuto()
    bot.clearControlStates()
    await bot.test.becomeCreative()
    await bot.test.resetState()
  })

  const who = () => env.bot.test.ctx.who()
  const count = (name) => env.bot.inventory.count(env.bot.registry.itemsByName[name].id)
  /** the server's count of `name` in the bot's inventory (`clear … -1 0` only counts) */
  async function serverCount (name) {
    const out = await env.bot.test.ctx.consoleOutput(`clear ${who()} ${name} -1 0`)
    const m = out.join(' ').match(/has (\d+) items? that match/i)
    if (m) return Number(m[1])
    if (out.some((l) => /Could not clear|no items/i.test(l))) return 0
    throw new Error(`clear: ${out.join(' | ')}`)
  }
  /** the server's block at `pos` matches `name` (testforblock) */
  async function serverHas (pos, name) {
    const out = await env.bot.test.ctx.consoleOutput(`testforblock ${pos.x} ${pos.y} ${pos.z} ${name}`)
    return out.some((l) => /Successfully found the block/.test(l))
  }
  async function build (cmd) {
    const out = await env.bot.test.ctx.consoleOutput(cmd)
    if (!out.some((l) => /filled|placed|couldn't be placed|No blocks/i.test(l))) throw new Error(`${cmd}: ${out.join(' | ')}`)
  }
  const column = (x, z, from, to) => {
    const out = []
    for (let y = from; y <= to; y++) out.push(env.bot.blockAt(new Vec3(x, y, z))?.name)
    return out.join(',')
  }
  /** wait until `fn()` (checked every 50 ms) */
  async function until (fn, what, ms = 5000) {
    const end = Date.now() + ms
    while (!fn()) {
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
      await sleep(50)
    }
  }

  describe('falling blocks', () => {
    it('gravel set in mid-air: update_block, then update_block_synced (create → air, destroy → landed); blockAt follows each at once', async () => {
      const { bot } = env
      const start = new Vec3(3, G + 5, 3)
      const floor = new Vec3(3, G, 3)
      const synced = []
      const onSynced = (p) => {
        const pos = new Vec3(p.position.x, p.position.y, p.position.z)
        // the plugin's listener ran first (registered at createBot): the world already shows the server's update
        synced.push(`${p.transition_type} ${pos} → ${bot.blockAt(pos)?.name}`)
      }
      bot._client.on('update_block_synced', onSynced)
      const updates = []
      const onUpdate = (o, n) => { if (n && n.position.x === 3 && n.position.z === 3) updates.push(`${n.position}: ${o?.name} → ${n.name}`) }
      bot.on('blockUpdate', onUpdate)
      try {
        await build(`setblock ${start.x} ${start.y} ${start.z} gravel`)
        await until(() => synced.length >= 2, 'the gravel to land')
        await sleep(300)
      } finally {
        bot._client.removeListener('update_block_synced', onSynced)
        bot.removeListener('blockUpdate', onUpdate)
      }
      assert.deepStrictEqual(synced, [`create ${start} → air`, `destroy ${floor} → gravel`])
      assert.deepStrictEqual(updates, [`${start}: air → gravel`, `${start}: gravel → air`, `${floor}: air → gravel`])
      assert.strictEqual(column(3, 3, G, G + 5), 'gravel,air,air,air,air,air')
      assert.ok(await serverHas(floor, 'gravel'), 'the server has it there too')
    })

    it('a stack of gravel whose support is removed: every block falls, the client column matches the server', async () => {
      const { bot } = env
      await build(`setblock -3 ${G + 2} 3 dirt`)
      await build(`fill -3 ${G + 3} 3 -3 ${G + 5} 3 gravel`)
      await until(() => column(-3, 3, G + 2, G + 5) === 'dirt,gravel,gravel,gravel', 'the stack')
      await build(`setblock -3 ${G + 2} 3 air destroy`)
      await until(() => column(-3, 3, G, G + 5) === 'gravel,gravel,gravel,air,air,air', `the landed stack (now ${column(-3, 3, G, G + 5)})`)
      for (let y = G; y <= G + 2; y++) assert.ok(await serverHas(new Vec3(-3, y, 3), 'gravel'), `server gravel at y ${y}`)
      for (let y = G + 3; y <= G + 5; y++) assert.ok(await serverHas(new Vec3(-3, y, 3), 'air'), `server air at y ${y}`)
      assert.ok(bot.blockAt(new Vec3(-3, G, 3)).boundingBox === 'block')
    })

    it('survival: digging the block under two gravel — they fall into its place (blockAt + server agree)', async () => {
      const { bot } = env
      await build(`setblock 2 ${G + 1} 0 dirt`)
      await build(`fill 2 ${G + 2} 0 2 ${G + 3} 0 gravel`)
      await bot.test.becomeSurvival()
      await bot.test.give('diamond_shovel', 1)
      await bot.equip(bot.registry.itemsByName.diamond_shovel.id, 'hand')
      await until(() => column(2, 0, G, G + 3) === 'air,dirt,gravel,gravel', 'the setup')
      await bot.dig(bot.blockAt(new Vec3(2, G + 1, 0)), true)
      await until(() => column(2, 0, G, G + 3) === 'gravel,gravel,air,air', `the gravel to land (now ${column(2, 0, G, G + 3)})`)
      assert.ok(await serverHas(new Vec3(2, G, 0), 'gravel'))
      assert.ok(await serverHas(new Vec3(2, G + 1, 0), 'gravel'))
      assert.ok(await serverHas(new Vec3(2, G + 2, 0), 'air'))
    })

    it('survival: sand falling onto the bot is shown where it landed (the server pushes the bot out of it)', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await until(() => bot.entity.onGround, 'on the ground')
      await build(`setblock 0 ${G + 4} 0 sand`)
      await until(() => bot.blockAt(new Vec3(0, G, 0))?.name === 'sand', `the sand in the bot's block (column ${column(0, 0, G, G + 4)})`)
      assert.strictEqual(bot.blockAt(new Vec3(0, G + 4, 0)).name, 'air')
      assert.ok(await serverHas(new Vec3(0, G, 0), 'sand'))
      // pushed out sideways by the server; the client does not stay inside the block
      await until(() => !bot.entity.position.floored().equals(new Vec3(0, G, 0)), `out of the sand (at ${bot.entity.position})`)
    })

    it('a gravel block the bot places in mid-air: placeBlock resolves, then it falls (blockAt follows)', async () => {
      const { bot } = env
      await build(`fill 2 ${G} 2 2 ${G + 2} 2 stone`)
      await bot.test.becomeSurvival()
      await bot.test.give('gravel', 4)
      await bot.equip(bot.registry.itemsByName.gravel.id, 'hand')
      const ref = bot.blockAt(new Vec3(2, G + 2, 2))
      await bot.placeBlock(ref, new Vec3(-1, 0, 0)) // against its west face: (1, -58, 2), air below
      await until(() => bot.blockAt(new Vec3(1, G, 2))?.name === 'gravel', `the placed gravel to land (column ${column(1, 2, G, G + 2)})`)
      assert.strictEqual(bot.blockAt(new Vec3(1, G + 2, 2)).name, 'air')
      assert.ok(await serverHas(new Vec3(1, G, 2), 'gravel'))
      assert.strictEqual(count('gravel'), 3)
    })

    it('mineflayer-pathfinder: gravel landing on the path makes it re-plan (block_updated) and the bot still arrives', async () => {
      const { bot } = env
      const { goals } = require('mineflayer-pathfinder')
      await bot.test.becomeSurvival()
      await until(() => bot.entity.onGround, 'on the ground')
      // a wall of gravel (x 5, z -2..2, two high) held over the way by a stone beam above head height (y G + 2)
      await build(`fill 5 ${G + 2} -2 5 ${G + 2} 2 stone`)
      await build(`fill 5 ${G + 3} -2 5 ${G + 4} 2 gravel`)
      await until(() => bot.blockAt(new Vec3(5, G + 4, 2))?.name === 'gravel', 'the wall')
      const resets = []
      const onReset = (reason) => resets.push(reason)
      bot.on('path_reset', onReset)
      let path = null
      const onPath = (r) => { path = path ?? r.path }
      bot.on('path_update', onPath)
      try {
        // the path goes under the beam; the beam goes as soon as it is computed: the wall drops onto the way
        const walk = bot.pathfinder.goto(new goals.GoalBlock(8, G, 0))
        await until(() => path, 'the path', 10000)
        assert.ok(path.some((n) => Math.floor(n.x) === 5), 'planned through x 5')
        await build(`fill 5 ${G + 2} -2 5 ${G + 2} 2 air`)
        await walk
      } finally {
        bot.removeListener('path_reset', onReset)
        bot.removeListener('path_update', onPath)
      }
      assert.ok(resets.includes('block_updated'), `path_reset reasons: ${resets.join(', ')}`)
      assert.ok(bot.entity.position.distanceTo(new Vec3(8.5, G, 0.5)) < 1, `arrived (at ${bot.entity.position})`)
      assert.ok([-2, -1, 0, 1, 2].some((z) => bot.blockAt(new Vec3(5, G, z)).name === 'gravel'), `the gravel landed on the way: ${[-2, -1, 0, 1, 2].map((z) => column(5, z, G, G + 4)).join(' | ')}`)
    })
  })

  describe('auto-eat', () => {
    async function hungry () {
      const { bot } = env
      await bot.test.ctx.consoleExpect(`effect ${bot.username} hunger 60 255`, /effect|gave|applied/i)
      await until(() => bot.food < 15, `hunger (food ${bot.food})`, 30000)
      await bot.test.ctx.consoleOutput(`effect ${bot.username} clear`)
    }

    it('a failed equip clears the eating flag: eat() is not "Already eating!" and the automatic mode eats', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('diamond_sword', 1)
      await bot.test.give('dirt', 64 * 8) // the hotbar is full: the bread lands in the main inventory (an equip first)
      await bot.test.give('bread', 8)
      await hungry()
      const events = []
      const on = (name) => (arg) => events.push(name + (arg instanceof Error ? `: ${arg.message}` : ''))
      const listeners = ['eatStart', 'eatFail', 'eatFinish'].map((n) => [n, on(n)])
      for (const [n, fn] of listeners) bot.autoEat.on(n, fn)
      const customEquip = bot.util.inv.customEquip
      const minHunger = bot.autoEat.opts.minHunger
      try {
        bot.util.inv.customEquip = async () => false // e.g. a window open / a hand swap at the same moment
        await assert.rejects(bot.autoEat.eat(), /^Error: Failed to equip: bread!/)
        assert.strictEqual(bot.autoEat.isEating, false, 'the flag is cleared')
        bot.util.inv.customEquip = customEquip
        const food = bot.food
        bot.autoEat.setOpts({ minHunger: 15 })
        bot.autoEat.enableAuto()
        await until(() => events.includes('eatFinish') && !bot.autoEat.isEating, `an automatic meal (${events.join(', ')})`, 10000)
        await bot.waitForTicks(10)
        assert.ok(bot.food > food, `food ${food} → ${bot.food}`)
        assert.deepStrictEqual(events.slice(0, 2), ['eatStart', 'eatFinish'])
      } finally {
        bot.util.inv.customEquip = customEquip
        bot.autoEat.setOpts({ minHunger })
        bot.autoEat.disableAuto()
        for (const [n, fn] of listeners) bot.autoEat.removeListener(n, fn)
        await bot.test.ctx.consoleOutput(`effect ${bot.username} clear`)
      }
    })

    it("strictErrors (default): a meal cancelled half way emits 'eatFail' then 'eatFinish', eat() rejects", async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('cooked_beef', 4)
      await hungry()
      const events = []
      const on = (name) => (arg) => events.push(name + (arg instanceof Error ? `: ${arg.message}` : ''))
      const listeners = ['eatStart', 'eatFail', 'eatFinish'].map((n) => [n, on(n)])
      for (const [n, fn] of listeners) bot.autoEat.on(n, fn)
      try {
        assert.strictEqual(bot.autoEat.opts.strictErrors, true)
        const meal = bot.autoEat.eat()
        meal.catch(() => {})
        await until(() => events.includes('eatStart'), 'the meal to start')
        await sleep(300)
        bot.autoEat.cancelEat()
        await assert.rejects(meal, /Eating manually canceled!/)
        assert.deepStrictEqual(events, ['eatStart', 'eatFail: Eating manually canceled!', 'eatFinish'])
        assert.strictEqual(bot.autoEat.isEating, false)
        assert.strictEqual(count('cooked_beef'), 4, 'nothing eaten')
        // and the next meal works
        await bot.autoEat.eat()
        assert.strictEqual(count('cooked_beef'), 3)
      } finally {
        for (const [n, fn] of listeners) bot.autoEat.removeListener(n, fn)
        await bot.test.ctx.consoleOutput(`effect ${bot.username} clear`)
      }
    })
  })

  describe('collectblock without a pickaxe', () => {
    it('collect(coal ore) rejects with NoItem and the process stays responsive (it froze and ran out of memory)', async () => {
      const { bot } = env
      await build(`fill 2 ${G} -2 3 ${G} -2 coal_ore`)
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 16)
      const t0 = Date.now()
      const targets = bot.findBlocks({ matching: bot.registry.blocksByName.coal_ore.id, maxDistance: 8, count: 4 }).map((p) => bot.blockAt(p))
      assert.strictEqual(targets.length, 2)
      // unpatched, this call never yields again: the test (and the process) would hang until it ran out of memory
      await assert.rejects(bot.collectBlock.collect(targets), (err) => err.name === 'NoItem' && /harvestable tool/.test(err.message))
      const ms = Date.now() - t0
      assert.ok(ms < 10000, `${ms} ms`)
      await sleep(100) // timers run
      assert.strictEqual(bot.blockAt(new Vec3(2, G, -2)).name, 'coal_ore')
    })
  })

  describe('inventory resync', () => {
    it('bot.bedrock.resyncInventory(): inventory_mismatch → BDS resends the inventory; a stale slot is replaced', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('coal', 5)
      await bot.test.give('dirt', 3)
      const model = bot._bedrock.inventoryModel
      const slot = bot.inventory.findInventoryItem(bot.registry.itemsByName.coal.id).slot
      bot.inventory.updateSlot(slot, model.cloneItem(bot.inventory.slots[slot], 9, 4242)) // a desync, simulated
      assert.strictEqual(count('coal'), 9)
      const contents = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'inventory' || p.window_id === 0, 3000)
      assert.strictEqual(await bot.bedrock.resyncInventory(), true)
      await contents.promise
      assert.strictEqual(count('coal'), 5)
      assert.strictEqual(count('coal'), await serverCount('coal'))
      assert.notStrictEqual(bot.inventory.slots[slot].stackId, 4242)
      assert.strictEqual(count('dirt'), 3)
    })

    it('a click on a desynced slot: BDS rejects it (49), the model resyncs and the click goes through on the server\'s copy', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('coal', 7)
      const model = bot._bedrock.inventoryModel
      const before = model.resyncs.count
      const slot = bot.inventory.findInventoryItem(bot.registry.itemsByName.coal.id).slot
      bot.inventory.updateSlot(slot, model.cloneItem(bot.inventory.slots[slot], 11, 4243))
      await bot.moveSlotItem(slot, 20) // planned on 11 coal / stack 4243: rejected, resynced, planned again
      assert.strictEqual(model.resyncs.count, before + 1)
      assert.strictEqual(bot.inventory.slots[20]?.name, 'coal')
      assert.strictEqual(bot.inventory.slots[20]?.count, 7)
      assert.strictEqual(bot.inventory.slots[slot], null)
      assert.strictEqual(count('coal'), await serverCount('coal'))
      // the server agrees on the slot: another move goes through at once
      await bot.moveSlotItem(20, slot)
      assert.strictEqual(bot.inventory.slots[slot]?.count, 7)
      assert.strictEqual(model.resyncs.count, before + 1)
    })

    it('a pickup merging into a desynced stack (old item ≠ ours): the model resyncs by itself', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 5)
      const model = bot._bedrock.inventoryModel
      const before = model.resyncs.count
      const slot = bot.inventory.findInventoryItem(bot.registry.itemsByName.dirt.id).slot
      bot.inventory.updateSlot(slot, model.cloneItem(bot.inventory.slots[slot], 2, 4244))
      // a dirt block broken above the bot's head (by the console): its drop falls onto the bot and merges into the stack
      await build(`setblock 0 ${G + 2} 0 dirt`)
      await build(`setblock 0 ${G + 2} 0 air destroy`)
      await until(() => count('dirt') === 6 && !model.resyncs.pending, `the pickup (dirt ${count('dirt')})`)
      assert.strictEqual(model.resyncs.count, before + 1, 'resynced once')
      assert.strictEqual(count('dirt'), await serverCount('dirt'))
    })

    it('digging 16 ores per round while the pickup stack is moved by overlapping requests: client and server counts match, no resync', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('diamond_pickaxe', 1)
      await bot.test.give('coal', 2)
      await bot.equip(bot.registry.itemsByName.diamond_pickaxe.id, 'hand')
      const model = bot._bedrock.inventoryModel
      const before = model.resyncs.count
      const ring = []
      for (const dy of [0, 1]) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) ring.push(new Vec3(dx, G + dy, dz))
      for (let round = 0; round < 2; round++) {
        await bot.test.becomeCreative()
        await build(`fill -1 ${G} -1 1 ${G + 1} 1 coal_ore`)
        await build(`fill 0 ${G} 0 0 ${G + 1} 0 air`)
        await bot.test.teleport(new Vec3(0.5, G, 0.5))
        await bot.test.becomeSurvival()
        await until(() => bot.entity.onGround, 'on the ground')
        const state = { stop: false }
        let moves = 0
        const mover = (async () => {
          for (let i = 0; !state.stop; i++) {
            const coal = bot.inventory.slots.findIndex((it, s) => s >= 36 && s <= 44 && it?.name === 'coal')
            const empty = bot.inventory.slots.findIndex((it, s) => s >= 38 && s <= 44 && !it)
            if (coal >= 0 && empty >= 0 && coal !== bot.quickBarSlot + 36) {
              const p = bot.moveSlotItem(coal, empty).then(() => moves++, () => {})
              if (i % 3 === 0) await p // the others overlap
            }
            await sleep(60)
          }
        })()
        for (const p of ring) {
          const b = bot.blockAt(p)
          if (b?.name === 'coal_ore') await bot.dig(b, true)
        }
        state.stop = true
        await mover
        await sleep(1500) // the last drops
        const server = await serverCount('coal')
        assert.strictEqual(count('coal'), server, `round ${round}: client ${count('coal')}, server ${server} (${moves} moves)`)
        assert.ok(moves > 5, `${moves} moves`)
      }
      assert.ok(await serverCount('coal') > 2 + 16, 'drops were picked up')
      assert.strictEqual(model.resyncs.count, before, 'never out of date')
    })
  })
})
