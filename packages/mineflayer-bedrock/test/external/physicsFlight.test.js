// owner: U5 (physics & movement)
'use strict'
/**
 * Creative flight (request_ability + start/stop_flying, measured flight physics), the flyTo path that
 * bot.creative.flyTo delegates to, and elytra gliding (elytraFly) against BDS 1.26.51.1 (Bedrock extra).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const { commands, correctionRecorder, serverPosition, idle, place, sleep } = require('./physics_util')

describe('physics: creative flight, flyTo, elytra (U5)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  function waitFlying (bot, on, timeout = 5000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { bot._client.removeListener('update_abilities', onAbilities); reject(new Error(`server flying != ${on}`)) }, timeout)
      function onAbilities (p) {
        const base = p.abilities.find((l) => l.type === 'base')
        if (!!base?.enabled?.flying === on) {
          clearTimeout(timer)
          bot._client.removeListener('update_abilities', onAbilities)
          resolve()
        }
      }
      bot._client.on('update_abilities', onAbilities)
    })
  }

  it('hovers 15 s and flies to two destinations with zero corrections; stops flying on request', async () => {
    const { bot, server } = env
    await bot.test.becomeCreative()
    await commands(server, ['fill -5 -60 -5 20 -40 20 air'])
    // start flying in mid-air (taking off from the ground: see docs/differences/U5.md#residuals)
    await place(bot, new Vec3(0.5, -55, 0.5), 50)
    const flying = waitFlying(bot, true)
    bot._bedrock.physics.setFlying(true)
    await flying
    await sleep(1000)
    const rec = correctionRecorder(bot)
    const phases = { hover: String(bot._bedrock.input.lastTick) }
    try {
      const start = bot.entity.position.clone()
      await sleep(15000)
      phases.flyTo1 = String(bot._bedrock.input.lastTick)
      assert.ok(bot.entity.position.distanceTo(start) < 0.05, `hovering: ${bot.entity.position}`)
      const first = new Vec3(12.5, -48, 9.5)
      await bot._bedrock.physics.flyTo(first)
      assert.ok(bot.entity.position.distanceTo(first) <= 0.3, `${bot.entity.position}`)
      const second = new Vec3(-3.5, -56, 14.5)
      phases.flyTo2 = String(bot._bedrock.input.lastTick)
      await bot._bedrock.physics.flyTo(second)
      assert.ok(bot.entity.position.distanceTo(second) <= 0.3, `${bot.entity.position}`)
      await idle(bot, 10)
      console.log(`      15 s hover + 2 flyTo (${String(bot._bedrock.input.lastTick - BigInt(phases.hover))} ticks): ${rec.count} corrections`)
      assert.strictEqual(rec.count, 0, `phases ${JSON.stringify(phases)} corrections: ${JSON.stringify(rec.list.map((c) => [String(c.tick), c.error, String(c.position), String(c.predicted), String(c.velocity)]))}`)
      const pos = await serverPosition(bot, server)
      assert.ok(pos.distanceTo(bot.entity.position) < 0.01, `client ${bot.entity.position} server ${pos}`)
      const landed = waitFlying(bot, false)
      bot._bedrock.physics.setFlying(false)
      await landed
      await sleep(2500)
      assert.strictEqual(bot.entity.onGround, true)
      assert.ok(rec.maxConsecutive() <= 2)
    } finally {
      rec.stop()
    }
  })

  it('elytraFly: glides from a jump press with an elytra, lands; refuses without one', async () => {
    const { bot, server } = env
    if (bot._bedrock.physics.isFlying()) {
      const landed = waitFlying(bot, false)
      bot._bedrock.physics.setFlying(false)
      await landed
    }
    await bot.test.becomeSurvival()
    await commands(server, ['fill -5 -60 -10 80 -20 10 air', `replaceitem entity ${bot.username} slot.armor.chest 0 air`])
    await place(bot, new Vec3(0.5, -25, 0.5), 300)
    await assert.rejects(bot.elytraFly(), /Elytra must be equip/)
    await commands(server, [`replaceitem entity ${bot.username} slot.armor.chest 0 elytra`])
    await place(bot, new Vec3(0.5, -25, 0.5), 300)
    await bot.look(-Math.PI / 2, -0.2, true)
    const rec = correctionRecorder(bot)
    const flags = []
    const onData = (p) => {
      const f = bot._bedrock.ids.isSelf(p.runtime_entity_id) && p.metadata?.find((m) => m.key === 'flags')?.value
      if (f) flags.push([String(p.tick), !!f.gliding])
    }
    bot._client.on('set_entity_data', onData)
    try {
      await bot.elytraFly()
      await sleep(2000)
      assert.strictEqual(bot.entity.elytraFlying, true, `gliding flags ${JSON.stringify(flags)}, at ${bot.entity.position}`)
      assert.ok(bot.entity.position.x > 8, `glided east: ${bot.entity.position}`)
      await sleep(2000)
      assert.ok(rec.maxConsecutive() <= 2, `corrections ${JSON.stringify(rec.list.map((c) => [String(c.tick), c.error]))}`)
      // land: the glide ends on the ground
      await bot.look(-Math.PI / 2, 0.8, true)
      for (let i = 0; i < 40 && !bot.entity.onGround; i++) await sleep(250)
      assert.strictEqual(bot.entity.elytraFlying, false)
      await idle(bot, 10)
      const pos = await serverPosition(bot, server)
      assert.ok(pos.distanceTo(bot.entity.position) <= 0.1, `client ${bot.entity.position} server ${pos}`)
    } finally {
      rec.stop()
      bot._client.removeListener('set_entity_data', onData)
      await commands(server, [`replaceitem entity ${bot.username} slot.armor.chest 0 air`])
    }
  })
})
