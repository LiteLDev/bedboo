// owner: W3-FIX-A (wave-3 gate fix-ups: movement, flight, lifecycle, abilities)
'use strict'
/**
 * Live checks of the wave-3 fix-ups against BDS 1.26.51.1 (Bedrock extra):
 * - sneak, then click at once: the click follows the player_auth_input that carries the sneak, so a stone is placed
 *   on a chest instead of opening it (upstream sends the sneak inside setControlState);
 * - a raised shield (activateItem(true) with an off-hand shield: a plain sneak on Bedrock) walks exactly like a sneak,
 *   without mispredictions (no item-use clamp);
 * - elytra + firework rocket: entityElytraFlew for the bot, plain rockets from the creative inventory, and the boost
 *   kept across rewinds for its whole flight (no rubber-banding, the client lands where the server does).
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')
const { commands, correctionRecorder, serverPosition, idle, place, sleep, Vec3 } = require('./physics_util')
const transactions = require('../../lib/bedrock/transactions')

const EAST = -Math.PI / 2

describe('physics: clicks after sneak, raised shield, firework boost (W3-FIX-A)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  function item (name, count = 1) {
    const Item = require('prismarine-item')(env.bot.registry)
    return new Item(env.bot.registry.itemsByName[name].id, count)
  }

  it('sneak, then useItemOn at once: the stone is placed on the chest (not opened)', async () => {
    const { bot, server } = env
    await bot.test.becomeCreative()
    if (bot._bedrock.physics.isFlying()) bot.creative.stopFlying()
    const chest = new Vec3(3, -60, 0)
    await commands(server, ['fill -2 -60 -3 6 -56 3 air', `setblock ${chest.x} ${chest.y} ${chest.z} chest`])
    await place(bot, new Vec3(0.5, -60, 0.5), 800)
    await bot.test.setInventorySlot(36, item('stone', 16))
    bot.setQuickBarSlot(0)
    // already aimed at the chest's top (no look change before the click: no tick passes)
    await bot.lookAt(chest.offset(0.5, 1, 0.5), true)
    await idle(bot, 5)
    let opened = false
    const onOpen = () => { opened = true }
    bot.on('windowOpen', onOpen)
    const placed = onceWithCleanup(bot, `blockUpdate:${chest.offset(0, 1, 0)}`, { timeout: 5000, checkCondition: (o, n) => n?.name === 'stone' })
    try {
      bot.setControlState('sneak', true)
      await transactions.useItemOn(bot, { position: chest, face: 1 })
      await placed
      await sleep(300)
      assert.strictEqual(opened, false, 'the chest opened: the click went out before the sneak')
      assert.strictEqual(bot.blockAt(chest.offset(0, 1, 0)).name, 'stone')
    } finally {
      bot.removeListener('windowOpen', onOpen)
      bot.setControlState('sneak', false)
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow)
      await commands(server, ['fill -2 -60 -3 6 -56 3 air'])
    }
  })

  it('a raised shield (activateItem(true)) walks like a plain sneak: same distance, no mispredictions', async () => {
    const { bot, server } = env
    await bot.test.becomeSurvival()
    await commands(server, ['fill -3 -60 -3 30 -56 3 air'])
    await bot.test.setInventorySlot(45, item('shield'))
    await sleep(300)
    assert.strictEqual(bot.inventory.slots[45]?.name, 'shield')
    async function walk (label, setup, teardown) {
      await place(bot, new Vec3(0.5, -60, 0.5), 800)
      await bot.look(EAST, 0, true)
      await idle(bot, 10)
      setup()
      await bot.waitForTicks(10)
      const rec = correctionRecorder(bot)
      const start = bot.entity.position.clone()
      bot.setControlState('forward', true)
      await bot.waitForTicks(60)
      bot.setControlState('forward', false)
      const moved = bot.entity.position.distanceTo(start)
      await idle(bot, 20)
      const server_ = await serverPosition(bot, server)
      rec.stop()
      teardown()
      await idle(bot, 10)
      console.log(`      ${label}: ${moved.toFixed(3)} blocks in 60 ticks, ${rec.mispredictions().length} mispredictions`)
      return { moved, rec, server: server_, client: bot.entity.position.clone() }
    }
    try {
      const sneak = await walk('sneak', () => bot.setControlState('sneak', true), () => bot.setControlState('sneak', false))
      const shield = await walk('shield raised', () => bot.activateItem(true), () => bot.deactivateItem())
      assert.strictEqual(shield.rec.mispredictions().length, 0, JSON.stringify(shield.rec.list.map((c) => c.error)))
      // a sneak covers 0.065 blocks per tick: one tick of timer jitter at most (the old item-use clamp: 1.05 vs 3.81)
      assert.ok(Math.abs(shield.moved - sneak.moved) < 0.15, `shield ${shield.moved} vs sneak ${sneak.moved}`)
      assert.ok(shield.server.distanceTo(shield.client) < 0.01, `client ${shield.client} server ${shield.server}`)
    } finally {
      await bot.test.setInventorySlot(45, null)
      await bot.test.becomeCreative()
    }
  })

  it('elytra + a plain firework rocket: entityElytraFlew, the boost lasts its whole flight, the client lands with the server', async () => {
    const { bot, server } = env
    await bot.test.becomeCreative()
    // a plain rocket (the creative inventory only lists NBT variants: Fireworks {Flight 1} is the default)
    await bot.creative.setInventorySlot(36, item('firework_rocket', 8))
    assert.strictEqual(bot.inventory.slots[36]?.name, 'firework_rocket')
    await bot.creative.setInventorySlot(6, item('elytra'))
    bot.setQuickBarSlot(0)
    await bot.test.becomeSurvival()
    try {
      await place(bot, new Vec3(0.5, -42, 20.5), 300)
      await bot.look(EAST, -0.25, true)
      await bot.waitForTicks(2)
      const flew = onceWithCleanup(bot, 'entityElytraFlew', { timeout: 5000, checkCondition: (e) => e === bot.entity })
      await bot.elytraFly()
      await flew
      await bot.waitForTicks(5)
      const rec = correctionRecorder(bot)
      const used = onceWithCleanup(bot, 'usedFirework', { timeout: 5000 })
      used.catch(() => {})
      // BDS names the boosted player in the rocket's `minecart_has_display` actor data (its unique id), not in
      // owner_eid (-1); until entities.js reads it (W3-FIX-B), start the boost like upstream's
      // handleBotUsedFireworkRocket here — this suite checks the physics side of the boost
      const rocket = new Promise((resolve) => {
        const onAdd = (p) => {
          if (p.entity_type !== 'minecraft:fireworks_rocket') return
          const attached = p.metadata?.find((m) => m.key === 'minecart_has_display')?.value
          if (attached === undefined || BigInt(attached) !== bot._bedrock.ids.selfUniqueId()) return
          bot._client.removeListener('add_entity', onAdd)
          resolve()
        }
        bot._client.on('add_entity', onAdd)
      })
      let usedFirework = false
      bot.once('usedFirework', () => { usedFirework = true })
      const start = bot.entity.position.clone()
      bot.activateItem()
      await Promise.race([used, rocket.then(() => {
        if (!usedFirework) bot.fireworkRocketDuration = 10 * (1 + 1) + Math.floor(Math.random() * 6) + Math.floor(Math.random() * 7)
      })])
      const durations = []
      for (let i = 0; i < 12; i++) {
        await bot.waitForTicks(1)
        durations.push(bot.fireworkRocketDuration)
      }
      bot.deactivateItem()
      const flown = bot.entity.position.distanceTo(start)
      console.log(`      boosted glide: ${flown.toFixed(1)} blocks, durations ${durations.join(',')}, ${rec.count} corrections (max ${rec.maxConsecutive()} consecutive)`)
      assert.ok(durations.every((d) => d > 0), `the boost counts down, never erased: ${durations}`)
      for (let i = 1; i < durations.length; i++) assert.ok(durations[i] <= durations[i - 1], `${durations}`)
      assert.ok(rec.maxConsecutive() <= 3, `rubber-banding: ${JSON.stringify(rec.list.map((c) => [String(c.tick), c.error]))}`)
      // land (within the loaded chunks)
      await bot.look(EAST, 1.2, true)
      for (let i = 0; i < 60 && !bot.entity.onGround; i++) await sleep(250)
      await idle(bot, 10)
      const pos = await serverPosition(bot, server)
      rec.stop()
      assert.ok(pos.distanceTo(bot.entity.position) <= 0.1, `client ${bot.entity.position} server ${pos}`)
    } finally {
      await commands(server, [`replaceitem entity ${bot.username} slot.armor.chest 0 air`])
      await bot.test.becomeCreative()
    }
  })
})
