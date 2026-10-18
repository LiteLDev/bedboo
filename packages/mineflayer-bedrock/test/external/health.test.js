// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Health, food, death and the 3-step respawn against BDS 1.26.51.1 (Bedrock extra: mineflayer 4.39.0 tests them
 * only through gamemode / spawnEvent). Difficulty easy (damage and hunger apply), deterministic gamerules.
 * - 'health' / bot.health on /damage, bot.food / bot.foodSaturation draining under a hunger effect;
 * - death → 'health' (0) → 'death' → auto respawn: exactly one client respawn (state 2) and one player_action
 *   respawn, 'respawn' then 'spawn', isAlive false → true, lifecycle dead → respawning → spawned;
 * - `respawn: false`: the bot stays dead (no client respawn) until bot.respawn().
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createTestBot } = require('./common')

function recordSent (bot) {
  const sent = []
  const queue = bot._client.queue.bind(bot._client)
  bot._client.queue = (name, params) => { sent.push([name, params]); return queue(name, params) }
  return { sent, restore: () => { bot._client.queue = queue } }
}

describe('health', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { difficulty: 'easy' }, botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('health: /damage → health event and bot.health; hunger drains food and saturation', async () => {
    const { bot } = ctx
    await bot.test.becomeSurvival()
    try {
      assert.strictEqual(bot.health, 20)
      assert.strictEqual(bot.food, 20)
      assert.strictEqual(typeof bot.foodSaturation, 'number')
      const hurt = onceWithCleanup(bot, 'health', { timeout: 5000, checkCondition: () => bot.health < 20 })
      await bot.test.botCommand('/damage @s 5')
      await hurt
      assert.strictEqual(bot.health, 15)
      assert.strictEqual(bot.isAlive, true)

      const hungry = onceWithCleanup(bot, 'health', { timeout: 30000, checkCondition: () => bot.food < 20 })
      await bot.test.botCommand('/effect @s hunger 60 255')
      await hungry
      assert.ok(bot.food < 20, `food ${bot.food}`)
      assert.ok(bot.foodSaturation < 5, `saturation ${bot.foodSaturation}`)
    } finally {
      await bot.test.botCommand('/effect @s clear')
      await bot.test.botCommand('/effect @s instant_health 1 10')
      await bot.test.botCommand('/effect @s saturation 1 50')
      await bot.test.becomeCreative()
    }
    await onceWithCleanup(bot, 'health', { timeout: 5000, checkCondition: () => bot.food === 20 && bot.health === 20 }).catch(() => {})
  })

  it('health: death → death event → auto respawn (3-step handshake once) → respawn → spawn', async () => {
    const { bot } = ctx
    const rec = recordSent(bot)
    const events = []
    const listeners = ['health', 'death', 'respawn', 'spawn', 'game'].map(name => [name, () => events.push([name, bot.isAlive, bot._bedrock.lifecycle.state, bot.health])])
    for (const [name, fn] of listeners) bot.on(name, fn)
    try {
      const spawned = onceWithCleanup(bot, 'spawn', { timeout: 15000 })
      await bot.test.selfKill()
      await spawned
      await bot.test.wait(500)
      const names = events.map(([n]) => n)
      const death = names.indexOf('death')
      assert.ok(death >= 0, `${names}`)
      assert.strictEqual(names.filter(n => n === 'death').length, 1)
      assert.strictEqual(events[death][1], false, 'isAlive false at death')
      assert.strictEqual(events[death][3], 0, 'health 0 at death')
      assert.ok(names.lastIndexOf('health', death) >= 0 && names.lastIndexOf('health', death) < death, `health before death: ${names}`)
      const respawn = names.indexOf('respawn')
      const spawn = names.indexOf('spawn')
      assert.ok(death < respawn && respawn < spawn, `${names}`)
      assert.strictEqual(names.filter(n => n === 'respawn').length, 1)
      assert.strictEqual(names.filter(n => n === 'spawn').length, 1)
      assert.deepStrictEqual(events[spawn].slice(1, 3), [true, 'spawned'])
      assert.ok(events[spawn][3] > 0, 'health restored before spawn')
      assert.strictEqual(bot.isAlive, true)
      assert.strictEqual(bot.health, 20)
      // exactly one client_ready (state 2) and one player_action respawn — the harness no longer answers deaths
      assert.strictEqual(bot.test.ctx.raw.respawn, false)
      assert.deepStrictEqual(rec.sent.filter(([n]) => n === 'respawn').map(([, p]) => p.state), [2])
      assert.strictEqual(rec.sent.filter(([n, p]) => n === 'player_action' && p.action === 'respawn').length, 1)
    } finally {
      rec.restore()
      for (const [name, fn] of listeners) bot.removeListener(name, fn)
    }
  })

  it('health: respawn: false stays dead until bot.respawn()', async () => {
    const { server } = ctx
    const { bot } = await createTestBot({ server, username: `norespawn${process.pid % 1000}`, botOptions: { viewDistance: 'tiny', respawn: false } })
    try {
      const rec = recordSent(bot)
      const died = onceWithCleanup(bot, 'death', { timeout: 10000 })
      await bot.test.selfKill()
      await died
      await bot.test.wait(2000)
      assert.strictEqual(bot.isAlive, false)
      assert.strictEqual(bot.health, 0)
      assert.strictEqual(bot._bedrock.lifecycle.state, 'dead')
      assert.strictEqual(rec.sent.filter(([n]) => n === 'respawn').length, 0, 'no automatic respawn')
      // the input keeps running while dead (like the vanilla client on the death screen)
      assert.ok(!bot._bedrock.input.isSuspended())

      const respawned = onceWithCleanup(bot, 'respawn', { timeout: 10000 })
      const spawned = onceWithCleanup(bot, 'spawn', { timeout: 10000 })
      bot.respawn()
      await respawned
      await spawned
      assert.strictEqual(bot.isAlive, true)
      assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
      assert.deepStrictEqual(rec.sent.filter(([n]) => n === 'respawn').map(([, p]) => p.state), [2])
      bot.respawn() // alive: no-op, like upstream
      await bot.test.wait(300)
      assert.strictEqual(rec.sent.filter(([n]) => n === 'respawn').length, 1)
      rec.restore()
    } finally {
      bot.end('test done')
    }
  })
})
