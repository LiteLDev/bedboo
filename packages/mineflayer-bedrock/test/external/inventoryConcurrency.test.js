// owner: W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)
'use strict'
/**
 * Bedrock extra (W3-FIX-B), against a real BDS 1.26.51.1:
 * - opening a container while another one is open: closed first (windowClose) like Java's server, never the 20 s
 *   hang of an activation BDS ignores; the same block again; a lever with a chest open does not close it;
 * - overlapping item stack requests on the same slot (clicks not awaited, a rejection in the middle, rapid
 *   transfers while tossing): the model ends equal to the server's inventory (raw packets after a resend).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('playerInventory › useChests extras: window switching and overlapping clicks (W3-FIX-B)', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  /** the server's view of the inventory (raw packets) after a console no-op that resends every window */
  async function serverInventory (bot) {
    const raw = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'offhand', 10000)
    await bot.test.ctx.consoleOutput(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 8 keep air`)
    await raw.promise
    return bot.test.rawInventory()
  }
  /** model vs server, inventory slots 0..35 (Bedrock order) + cursor + off-hand, as "name x count" */
  function modelView (bot) {
    const model = bot._bedrock.inventoryModel
    const slot = (key) => { const it = model.read(key); return it ? `${it.name} x ${it.count}` : null }
    return { inventory: Array.from({ length: 36 }, (_, i) => slot(`p:${i}`)), cursor: slot('c'), offhand: slot('o') }
  }
  function serverView (raw) {
    const fmt = (it) => it ? `${it.name} x ${it.count}` : null
    return { inventory: Array.from({ length: 36 }, (_, i) => fmt(raw.inventory?.[i])), cursor: fmt(raw.ui?.[0]), offhand: fmt(raw.offhand?.[0]) }
  }

  it('opening chest B while chest A is open closes A first (windowClose), then B opens; the same chest again; a lever keeps A open', async () => {
    const { bot } = ctx
    bot.physics.yawSpeed = bot.physics.pitchSpeed = 1e3
    const Item = require('prismarine-item')(bot.registry)
    const dirt = bot.registry.itemsByName.dirt.id
    await bot.test.setInventorySlot(36, new Item(dirt, 16, 0))
    await bot.test.becomeSurvival()
    const gy = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: gy, z: 0, blockName: 'chest' })
    await bot.test.setBlock({ x: 0, y: gy, z: 2, blockName: 'barrel' })
    await bot.test.setBlock({ x: -2, y: gy, z: 0, blockName: 'lever ["lever_direction"="up_north_south"]' })
    const log = []
    const onOpen = (w) => log.push(`open ${w.type}`)
    const onClose = (w) => log.push(`close ${w.type}`)
    bot.on('windowOpen', onOpen)
    bot.on('windowClose', onClose)
    try {
      await windowSwitch()
    } finally {
      bot.off('windowOpen', onOpen)
      bot.off('windowClose', onClose)
    }

    async function windowSwitch () {
      const a = await bot.openContainer(bot.blockAt(new Vec3(2, gy, 0)))
      await a.deposit(dirt, null, 4)
      // a lever while the chest is open: toggled, the chest stays open (Java and BDS alike)
      const toggled = bot.test.botEvent('blockUpdate', (o, n) => n?.position.equals(new Vec3(-2, gy, 0)), 5000)
      try {
        await bot.activateBlock(bot.blockAt(new Vec3(-2, gy, 0)))
      } catch (err) {
        toggled.cancel()
        throw err
      }
      assert.strictEqual((await toggled.promise)[1].getProperties().open_bit, 1)
      assert.strictEqual(bot.currentWindow, a, 'the chest stays open')
      // the barrel without closing the chest (mineflayer-collectblock's emptyInventory does this)
      const started = Date.now()
      const b = await bot.openContainer(bot.blockAt(new Vec3(0, gy, 2)))
      assert.ok(Date.now() - started < 5000, `opened in ${Date.now() - started} ms`)
      assert.strictEqual(bot.currentWindow, b)
      assert.deepStrictEqual(log, ['open minecraft:generic_9x3', 'close minecraft:generic_9x3', 'open minecraft:generic_9x3'])
      await b.deposit(dirt, null, 2)
      assert.strictEqual(b.containerCount(dirt), 2)
      // the same barrel again while it is open
      const c = await bot.openContainer(bot.blockAt(new Vec3(0, gy, 2)))
      assert.strictEqual(c.containerCount(dirt), 2)
      assert.strictEqual(bot.currentWindow, c)
      await c.close()
      // the chest kept its deposit
      const again = await bot.openContainer(bot.blockAt(new Vec3(2, gy, 0)))
      assert.strictEqual(again.containerCount(dirt), 4)
      await again.close()
      assert.strictEqual(bot.inventory.count(dirt), 10)
    }
  })

  it('a rejected click and a click planned on it (not awaited): the model ends equal to the server', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 3, 0))
    await bot.test.becomeSurvival()
    await bot.clickWindow(36, 0, 0) // dirt on the cursor
    // A: dirt into the off-hand (BDS refuses: status 55); B: planned on A's prediction, names A's request id (49)
    const a = bot.clickWindow(45, 0, 0).then(() => 'ok', e => e.message)
    const b = bot.clickWindow(45, 0, 0).then(() => 'ok', e => e.message)
    const results = await Promise.all([a, b])
    assert.ok(results.every(r => /rejected/.test(r)), results.join(' | '))
    const model = modelView(bot)
    assert.deepStrictEqual([model.cursor, model.offhand], ['dirt x 3', null], 'no phantom off-hand item, the dirt still carried')
    assert.deepStrictEqual(serverView(await serverInventory(bot)), model)
    await bot.clickWindow(36, 0, 0) // put back (the cursor's stack id is valid)
    assert.strictEqual(bot.inventory.slots[36]?.count, 3)
  })

  it('rapid clicks: concurrent shift clicks into the same slots, drops and a transfer while tossing — the model stays in sync', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const stone = bot.registry.itemsByName.stone.id
    const dirt = bot.registry.itemsByName.dirt.id
    for (let i = 0; i < 5; i++) await bot.test.setInventorySlot(36 + i, new Item(stone, 20, 0))
    await bot.test.setInventorySlot(41, new Item(dirt, 64, 0))
    await bot.test.setInventorySlot(42, new Item(dirt, 64, 0))
    await bot.test.becomeSurvival()
    // five hotbar stacks shift-clicked into the main inventory at once: each is planned on the previous prediction
    // (they merge into the same main slots), plus single drops (drop key) of dirt in between
    const clicks = []
    for (let i = 0; i < 5; i++) {
      clicks.push(bot.clickWindow(36 + i, 0, 1).then(() => 'ok', e => e.message))
      clicks.push(bot.clickWindow(41, 0, 4).then(() => 'ok', e => e.message))
    }
    const results = await Promise.all(clicks)
    assert.ok(results.every(r => r === 'ok'), results.join(' | '))
    assert.strictEqual(bot.inventory.count(stone), 100)
    assert.strictEqual(bot.inventory.count(dirt), 128 - 5)
    assert.deepStrictEqual(serverView(await serverInventory(bot)), modelView(bot))
    // a transfer of many stacks while tossing (both not awaited; the toss uses the drop key, no cursor)
    const transfer = bot.transfer({ window: bot.inventory, itemType: stone, metadata: null, count: 100, sourceStart: 9, sourceEnd: 36, destStart: 36, destEnd: 45 }).then(() => 'ok', e => e.message)
    const tosses = Array.from({ length: 6 }, () => bot.clickWindow(42, 0, 4).then(() => 'ok', e => e.message))
    const all = await Promise.all([transfer, ...tosses])
    assert.ok(all.every(r => r === 'ok'), all.join(' | '))
    await bot.test.wait(300)
    const model = modelView(bot)
    assert.deepStrictEqual(serverView(await serverInventory(bot)), model)
    assert.strictEqual(model.cursor, null)
    assert.strictEqual(bot.inventory.count(stone), 100)
  })
})
