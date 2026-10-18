// owner: U7 (entities & players)
'use strict'
/**
 * Animal entity events against a real BDS 1.26.51.1 (Bedrock extra, U7): feeding a wolf bones (entityEat, and
 * entityTaming / entityTamed — each bone tames with a 1/3 chance), a wet wolf shaking (entityShakingOffWater), a baby
 * sheep eating grass (entityEatingGrass) and taming a horse by riding it (entityTaming when it throws the rider,
 * entityTamed). Random by nature: the tests retry until the event happens, within a bound.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const GROUND = -60

describe('animals (U7): taming, eating, shaking off water, eating grass', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  before(async () => {
    await env.server.commandOutput('time set noon')
  })
  beforeEach(() => env.bot.test.resetState())

  const ev = (event, predicate, timeout) => env.bot.test.botEvent(event, predicate, timeout)
  const cmd = (command) => env.server.commandOutput(command)

  /** record the given bot events of `entity` */
  function recorder (entity, names) {
    const seen = []
    const listeners = names.map((n) => [n, (e) => { if (e === entity) seen.push(n) }])
    for (const [n, fn] of listeners) env.bot.on(n, fn)
    seen.stop = () => { for (const [n, fn] of listeners) env.bot.removeListener(n, fn) }
    return seen
  }

  it('wolf fed with bones: entityEat, entityTaming (failed attempt) and entityTamed (owner = the bot)', async () => {
    const { bot } = env
    await bot.test.setGameMode('survival')
    await cmd(`effect ${bot.test.ctx.who()} resistance 120 255 true`)
    await cmd(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 0 bone 64`)
    await bot.test.wait(300)
    const all = []
    let tamed = false
    let taming = false
    assert.strictEqual(bot.game.gameMode, 'survival')
    // up to 6 wolves until both a failed and a successful attempt were seen (P(miss) = (1/3)^6 ≈ 1e-3)
    for (let w = 0; w < 6 && !(tamed && taming); w++) {
      const wolf = await bot.test.summon('wolf', new Vec3(0, GROUND, 2))
      const seen = recorder(wolf, ['entityEat', 'entityTaming', 'entityTamed'])
      try {
        for (let i = 0; i < 15 && !seen.includes('entityTamed'); i++) {
          await cmd(`tp @e[type=wolf,c=1] 0.5 ${GROUND} 2.5`)
          await bot.test.wait(150)
          const fed = ev('entityEat', (e) => e === wolf, 3000)
          bot.useOn(wolf)
          await fed.promise
          await bot.test.wait(450)
        }
      } finally {
        seen.stop()
      }
      all.push(...seen)
      if (seen.includes('entityTamed')) {
        tamed = true
        assert.strictEqual(BigInt(wolf.metadata.owner_eid), bot.entity.uniqueId, 'the bot owns the tamed wolf')
        assert.strictEqual(wolf.metadata.flags.tamed, true)
      }
      if (seen.includes('entityTaming')) taming = true
      await bot.test.killEntity(wolf)
    }
    assert.ok(all.includes('entityEat'), all.join(' '))
    assert.ok(tamed, `entityTamed: ${all.join(' ')}`)
    assert.ok(taming, `entityTaming: ${all.join(' ')}`)
  })

  it('wet wolf: entityShakingOffWater', async () => {
    const { bot } = env
    const wolf = await bot.test.summon('wolf', new Vec3(5, GROUND, 5))
    const shaking = ev('entityShakingOffWater', (e) => e === wolf, 30000)
    try {
      await cmd(`fill 3 ${GROUND} 3 7 ${GROUND} 7 water`)
      await cmd(`tp @e[type=wolf] 5 ${GROUND} 5`)
      await bot.test.wait(2500)
      await cmd(`fill -4 ${GROUND} -4 14 ${GROUND} 14 air`)
      await shaking.promise
    } finally {
      await cmd(`fill -4 ${GROUND} -4 14 ${GROUND} 14 air`)
      await bot.test.killEntity(wolf).catch(() => {})
    }
  })

  it('baby sheep: entityEatingGrass', async () => {
    const { bot } = env
    const eating = ev('entityEatingGrass', (e) => e.name === 'sheep', 90000)
    const sheep = await bot.test.summon('sheep', new Vec3(-4, GROUND, -4), { spawnEvent: 'minecraft:entity_born' })
    const [eater] = await eating.promise
    assert.strictEqual(eater, sheep)
    await bot.test.killEntity(sheep)
  })

  it('horse tamed by riding: entityTaming when thrown off, entityTamed', async () => {
    const { bot } = env
    await bot.test.setGameMode('survival')
    await cmd(`effect ${bot.test.ctx.who()} resistance 120 255 true`)
    const horse = await bot.test.summon('horse', new Vec3(3, GROUND, -3), { spawnEvent: 'minecraft:ageable_grow_up' })
    const seen = recorder(horse, ['entityTaming', 'entityTamed'])
    try {
      for (let i = 0; i < 12 && !seen.includes('entityTamed'); i++) {
        if (!bot.vehicle) {
          await cmd(`tp @e[type=horse] 3 ${GROUND} -3`)
          await bot.test.teleport(new Vec3(1, GROUND, -3))
          const mounted = ev('mount', () => true, 5000)
          bot.mount(horse)
          await mounted.promise
        }
        // the horse either accepts the rider (tamed) or throws it off (taming failed) after a few seconds
        const outcome = ev('entityTamed', (e) => e === horse, 8000)
        const thrown = ev('entityTaming', (e) => e === horse, 8000)
        await Promise.race([outcome.promise, thrown.promise]).catch(() => {})
        outcome.cancel()
        thrown.cancel()
        if (bot.vehicle && !seen.includes('entityTamed')) {
          const off = ev('dismount')
          bot.dismount()
          await off.promise
        }
      }
    } finally {
      seen.stop()
      if (bot.vehicle) bot.dismount()
    }
    assert.ok(seen.includes('entityTamed'), seen.join(' '))
    assert.strictEqual(horse.metadata.flags.tamed, true)
    await bot.test.killEntity(horse)
  })
})
