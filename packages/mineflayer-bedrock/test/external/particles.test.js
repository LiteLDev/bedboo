// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/particles.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 *
 * Adapted (docs/differences/U6.md#particles): Bedrock's `/particle <effect> [x y z]` has no offset / speed / count /
 * force arguments and spawn_particle_effect carries none, so only id, name and position are asserted. Bedrock
 * particle type ids start at 1 (`registry.particles[0]` does not exist): the first particle of
 * `registry.particlesArray` is used. The position is the bot's server-side position, compared within 0.01 block
 * (bot.entity.position comes back from eye-level float32 coordinates).
 * Bedrock extra: a real particle effect identifier (minecraft:heart_particle) keeps its identifier as id and name.
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('particles', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  const close = (a, b) => Math.abs(a - b) < 0.01

  it('particles', async () => {
    const { bot } = env
    bot.test.sayEverywhere('### Starting particles')
    const particleData = bot.registry.particlesArray[0] // upstream: bot.registry.particles[0]

    await new Promise((resolve, reject) => {
      function onParticleEvent (particle) {
        try {
          if (typeof particle.id === 'number') {
            assert.strictEqual(particle.id, particleData.id)
          } else {
            assert.strictEqual(particle.id, particleData.name)
          }
          assert.strictEqual(particle.name, particleData.name)
          assert.ok(close(particle.position.x, bot.entity.position.x), `x ${particle.position.x} vs ${bot.entity.position.x}`)
          assert.ok(close(particle.position.y, bot.entity.position.y), `y ${particle.position.y} vs ${bot.entity.position.y}`)
          assert.ok(close(particle.position.z, bot.entity.position.z), `z ${particle.position.z} vs ${bot.entity.position.z}`)
          // Bedrock: no offset / count / speed / long distance on the wire — the Particle defaults
          assert.deepStrictEqual([particle.offset.x, particle.offset.y, particle.offset.z], [0, 0, 0])
          assert.strictEqual(particle.count, 1)
          assert.strictEqual(particle.movementSpeed, 0)
          assert.strictEqual(particle.longDistanceRender, false)
          resolve()
        } catch (err) {
          reject(err)
        } finally {
          bot.off('particle', onParticleEvent)
        }
      }

      bot.on('particle', onParticleEvent)

      bot.chat(`/particle ${particleData.name} ~ ~ ~`) // upstream: `~ ~ ~ 5 5 5 0.5 100 force`
    })
  })

  it('a Bedrock particle effect identifier at an offset position (Bedrock extra)', async () => {
    const { bot } = env
    const seen = new Promise((resolve) => {
      bot.on('particle', function onParticle (particle) {
        if (particle.id !== 'minecraft:heart_particle') return
        bot.off('particle', onParticle)
        resolve(particle)
      })
    })
    bot.chat('/particle minecraft:heart_particle ~1 ~2 ~3')
    const particle = await seen
    assert.strictEqual(particle.name, 'minecraft:heart_particle')
    const expected = bot.entity.position.offset(1, 2, 3)
    assert.ok(close(particle.position.x, expected.x) && close(particle.position.y, expected.y) && close(particle.position.z, expected.z), JSON.stringify(particle.position))
  })
})
