// owner: U7 (entities & players)
'use strict'
/**
 * Mob fights against a real BDS 1.26.51.1 (Bedrock extra, U7): a survival bot on difficulty easy kills a zombie, a
 * spider, a skeleton and a creeper with bare-handed `bot.attack` (item_use_on_entity attack transactions + arm
 * swings). Resistance V and Strength keep the fights short; the mob is teleported back in front of the bot before
 * each hit since the physics plugin does not walk yet (U5). Random by nature (AI, knockback, creeper fuse): the gate
 * is ≥ 4/5 runs (docs/parity/U7.md).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const GROUND = -60

describe('mob fights (U7): bare-handed attacks kill zombie, spider, skeleton, creeper', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'survival', difficulty: 'easy' } })
  const cmd = (command) => env.server.commandOutput(command)

  before(async () => {
    await cmd('time set midnight') // no burning in daylight
  })
  beforeEach(async () => {
    const { bot } = env
    await bot.test.resetState()
    await bot.test.setGameMode('survival')
    const who = bot.test.ctx.who()
    await cmd(`effect ${who} resistance 600 4 true`)
    await cmd(`effect ${who} strength 600 2 true`)
    await cmd(`effect ${who} instant_health 1 10 true`)
  })

  const fights = [
    ['zombie', { spawnEvent: 'minecraft:as_adult' }],
    ['spider', {}],
    ['skeleton', {}],
    ['creeper', {}]
  ]

  for (const [name, opts] of fights) {
    it(`bare-handed attacks kill a ${name}`, async () => {
      const { bot } = env
      const mob = await bot.test.summon(name, new Vec3(3, GROUND, 0), opts)
      const state = { hurts: 0, dead: false, gone: false }
      const onHurt = (e) => { if (e === mob) state.hurts++ }
      const onDead = (e) => { if (e === mob) state.dead = true }
      const onGone = (e) => { if (e === mob) state.gone = true }
      bot.on('entityHurt', onHurt)
      bot.on('entityDead', onDead)
      bot.on('entityGone', onGone)
      let attacks = 0
      try {
        const deadline = Date.now() + 30000
        while (!state.dead && !state.gone && Date.now() < deadline) {
          // in front of the bot (east), facing it
          const p = bot.entity.position
          await cmd(`tp @e[type=${name}] ${(p.x + 1.8).toFixed(2)} ${GROUND} ${p.z.toFixed(2)} facing ${p.x.toFixed(2)} ${(p.y + 1.6).toFixed(2)} ${p.z.toFixed(2)}`)
          await bot.test.wait(150)
          if (state.dead || state.gone) break
          bot.attack(mob)
          attacks++
          await bot.test.wait(550) // the mob's hurt cooldown is 10 ticks
        }
        const goneAt = Date.now() + 5000
        while (!state.gone && Date.now() < goneAt) await bot.test.wait(100)
      } finally {
        bot.removeListener('entityHurt', onHurt)
        bot.removeListener('entityDead', onDead)
        bot.removeListener('entityGone', onGone)
        if (!state.gone) await bot.test.killEntity(mob).catch(() => {})
      }
      const { hurts, dead, gone } = state
      console.log(`      ${name}: ${attacks} attack(s), ${hurts} entityHurt, dead ${dead}, gone ${gone}`)
      assert.ok(dead, `${name} died (entityDead) — ${attacks} attacks, ${hurts} hurts, gone ${gone}`)
      assert.ok(hurts >= 1, 'entityHurt')
      assert.ok(gone, 'entityGone after the death animation')
      assert.strictEqual(bot.entities[mob.id], undefined)
      assert.ok(bot.test.ctx.state.alive, 'the bot survived')
    })
  }
})
