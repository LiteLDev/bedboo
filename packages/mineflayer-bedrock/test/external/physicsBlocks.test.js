// owner: U5 (physics & movement)
'use strict'
/**
 * Bedrock movement through liquids, climbables and special blocks, falls, knockback and effects against BDS 1.26.51.1
 * (Bedrock extra). Acceptance (tiered, plan U5): at most 2 consecutive corrections, and after 10 idle ticks the bot is
 * within 0.1 block of the server's position (querytarget).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const { commands, correctionRecorder, serverPosition, idle, place, sleep } = require('./physics_util')

const EAST = -Math.PI / 2

describe('physics: liquids, climbables, special blocks, falls, knockback, effects (U5)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'survival' } })
  let rec

  beforeEach(async () => {
    const { bot } = env
    await bot.test.becomeSurvival()
    rec = correctionRecorder(bot)
  })
  afterEach(() => rec.stop())

  /** clear a 20 × 20 area at x0 and rebuild the flat ground */
  async function area (x0, extra = []) {
    await commands(env.server, [
      `fill ${x0 - 2} -60 -6 ${x0 + 17} -30 6 air`,
      `fill ${x0 - 2} -61 -6 ${x0 + 17} -61 6 grass_block`,
      `fill ${x0 - 2} -64 -6 ${x0 + 17} -62 6 dirt`,
      ...extra
    ])
  }

  async function settle (start) {
    const { bot } = env
    await place(bot, start, 800)
    rec.reset()
  }

  async function walk (controls, ms, yaw = EAST) {
    const { bot } = env
    await bot.look(yaw, 0, true)
    for (const c of controls) bot.setControlState(c, true)
    await sleep(ms)
    bot.clearControlStates()
  }

  async function verify (label) {
    const { bot, server } = env
    await idle(bot, 10)
    const pos = await serverPosition(bot, server)
    assert.ok(pos, 'querytarget')
    const d = pos.distanceTo(bot.entity.position)
    console.log(`      ${label}: ${rec.count} corrections (max ${rec.maxConsecutive()} consecutive, ${rec.mispredictions().length} mispredictions), |Δpos| ${d.toFixed(4)}`)
    assert.ok(d <= 0.1, `${label}: |Δpos| ${d.toFixed(4)} (client ${bot.entity.position}, server ${pos})`)
    assert.ok(rec.maxConsecutive() <= 2, `${label}: ${rec.count} corrections, ${rec.maxConsecutive()} consecutive: ${JSON.stringify(rec.list.map((c) => [String(c.tick), c.error && +c.error.toFixed(4)]))}`)
  }

  it('water: walk in, sink, swim up, walk out', async () => {
    const x = 0
    await area(x, [`fill ${x + 3} -63 -3 ${x + 9} -61 3 water`])
    await settle(new Vec3(x + 1.5, -60, 0.5))
    await walk(['forward'], 2000)
    assert.ok(env.bot.entity.isInWater, 'isInWater')
    await sleep(1500)
    await walk(['jump'], 1500)
    await walk(['forward', 'jump'], 3000)
    await verify('water')
  })

  it('lava (fire resistance): walk in, swim, walk out', async () => {
    const x = 20
    await area(x, [`effect ${env.bot.username} fire_resistance 60 0 true`, `fill ${x + 3} -63 -3 ${x + 9} -61 3 lava`])
    await settle(new Vec3(x + 1.5, -60, 0.5))
    await walk(['forward'], 2000)
    assert.ok(env.bot.entity.isInLava, 'isInLava')
    await walk(['jump'], 1500)
    await walk(['forward', 'jump'], 3500)
    await verify('lava')
    await commands(env.server, [`fill ${x + 3} -63 -3 ${x + 9} -61 3 dirt`])
  })

  it('ladder and vine: climb against them, jump-climb, sneak to hold, slide down', async () => {
    const x = 40
    await area(x, [
      `fill ${x + 3} -60 -1 ${x + 3} -50 1 stone`,
      `fill ${x + 2} -60 0 ${x + 2} -51 0 ladder ["facing_direction"=4]`,
      `fill ${x + 3} -60 4 ${x + 3} -50 5 stone`,
      `fill ${x + 2} -60 4 ${x + 2} -51 4 vine ["vine_direction_bits"=8]`
    ])
    await settle(new Vec3(x + 0.5, -60, 0.5))
    await walk(['forward'], 1500)
    assert.ok(env.bot.entity.position.y > -58, `climbed the ladder: ${env.bot.entity.position}`)
    await walk(['sneak'], 800)
    await walk([], 600)
    await walk(['jump'], 800)
    await walk([], 2500) // slide down to the ground: compare at rest
    await verify('ladder')
    await settle(new Vec3(x + 0.5, -60, 4.5))
    await walk(['forward', 'jump'], 1500)
    assert.ok(env.bot.entity.position.y > -58, `climbed the vine: ${env.bot.entity.position}`)
    await walk(['sneak'], 800)
    await walk([], 2500)
    await verify('vine')
  })

  it('cobweb, soul sand, honey, powder snow: walking through / over them', async () => {
    const x = 60
    await area(x, [
      `fill ${x + 3} -60 -1 ${x + 5} -59 -1 web`,
      `fill ${x + 3} -61 1 ${x + 12} -61 1 soul_sand`,
      `fill ${x + 3} -61 3 ${x + 12} -61 3 honey_block`,
      `fill ${x + 3} -63 5 ${x + 8} -61 5 powder_snow`
    ])
    for (const [z, label] of [[-0.5, 'cobweb'], [1.5, 'soul sand'], [3.5, 'honey'], [5.5, 'powder snow']]) {
      await settle(new Vec3(x + 1.5, -60, z))
      await walk(['forward'], 2500)
      await walk(['forward', 'jump'], 1500)
      await verify(label)
    }
  })

  it('slime: walking slowdown, falling from 8 blocks bounces', async () => {
    const x = 80
    await area(x, [`fill ${x + 3} -61 -1 ${x + 12} -61 1 slime`])
    await settle(new Vec3(x + 1.5, -60, 0.5))
    await walk(['forward'], 2500)
    await settle(new Vec3(x + 6.5, -52, 0.5))
    let bounced = false
    const onMove = () => { if (env.bot.entity.velocity.y > 0.3) bounced = true }
    env.bot.on('move', onMove)
    await sleep(3000)
    env.bot.removeListener('move', onMove)
    assert.ok(bounced, 'bounced')
    // sneaking ends the bouncing (no bounce while sneaking), then compare at rest
    await walk(['sneak'], 2500)
    await verify('slime')
  })

  it('bubble columns: carried up (soul sand), pulled down (magma)', async () => {
    const x = 100
    // two columns: soul sand (x + 4) and magma (x + 8), base block first, then the water
    await area(x, [
      `fill ${x + 3} -63 -1 ${x + 9} -40 1 glass`,
      `setblock ${x + 4} -63 0 soul_sand`,
      `setblock ${x + 8} -63 0 magma`,
      `fill ${x + 4} -62 0 ${x + 4} -41 0 water`,
      `fill ${x + 8} -62 0 ${x + 8} -41 0 water`
    ])
    await sleep(3000)
    await settle(new Vec3(x + 4.5, -62, 0.5))
    await sleep(3000)
    assert.ok(env.bot.entity.position.y > -50, `carried up: ${env.bot.entity.position}`)
    await verify('bubble up')
    await settle(new Vec3(x + 8.5, -45, 0.5))
    await sleep(3000)
    assert.ok(env.bot.entity.position.y < -55, `pulled down: ${env.bot.entity.position}`)
    await verify('bubble down')
  })

  it('falls: 3 blocks without damage, 10 blocks with damage; landing where the server lands', async () => {
    const { bot } = env
    const x = 120
    await area(x)
    // Bedrock reports health as the minecraft:health attribute (set_health is not sent for damage)
    const hurt = []
    const onHealth = (p) => {
      if (!bot._bedrock.ids.isSelf(p.runtime_entity_id)) return
      const health = p.attributes.find((a) => a.name === 'minecraft:health')
      if (health && health.current < health.max) hurt.push(health.current)
    }
    bot._client.on('update_attributes', onHealth)
    await settle(new Vec3(x + 0.5, -57, 0.5))
    await sleep(1500)
    await verify('3-block fall')
    assert.deepStrictEqual(hurt, [], 'no fall damage from 3 blocks')
    await bot.test.teleport(new Vec3(x + 0.5, -50, 0.5))
    await sleep(2500)
    assert.ok(hurt.some((h) => h < 20), `fall damage from 10 blocks: ${hurt}`)
    await verify('10-block fall')
    bot._client.removeListener('update_attributes', onHealth)
    await commands(env.server, [`effect ${bot.username} instant_health 1 10 true`])
  })

  it('knockback from /damage (set_entity_motion) while standing and walking', async () => {
    const { bot, server } = env
    const x = 140
    await area(x, ['difficulty normal', `summon pig ${x + 3} -60 0.5`])
    await settle(new Vec3(x + 0.5, -60, 0.5))
    try {
      for (let i = 0; i < 2; i++) {
        await commands(server, [`damage ${bot.username} 1 entity_attack entity @e[type=pig,c=1]`])
        await sleep(1500)
      }
      await bot.look(EAST, 0, true)
      bot.setControlState('forward', true)
      await sleep(300)
      await commands(server, [`damage ${bot.username} 1 entity_attack entity @e[type=pig,c=1]`])
      await sleep(1000)
      bot.clearControlStates()
      assert.ok(bot.entity.position.x < x + 0.5, `knocked back west: ${bot.entity.position}`)
      // corrections for the inputs already in flight carry exactly our rewound state: none is a misprediction
      assert.deepStrictEqual(rec.mispredictions().map((c) => c.error), [])
      await verify('knockback')
    } finally {
      await commands(server, ['kill @e[type=pig]', 'difficulty peaceful', `effect ${bot.username} instant_health 1 10 true`])
    }
  })

  it('effects: slow falling, levitation, jump boost, speed', async () => {
    const { bot, server } = env
    const x = 160
    await area(x)
    await commands(server, [`effect ${bot.username} slow_falling 10 0 true`])
    await settle(new Vec3(x + 0.5, -50, 0.5))
    await sleep(3000)
    await verify('slow falling')
    await commands(server, [`effect ${bot.username} clear`, `effect ${bot.username} levitation 2 1 true`])
    await sleep(4000)
    await verify('levitation')
    await commands(server, [`effect ${bot.username} jump_boost 10 1 true`])
    await walk(['jump'], 2000)
    await commands(server, [`effect ${bot.username} speed 10 1 true`])
    await walk(['forward'], 2000)
    await commands(server, [`effect ${bot.username} clear`])
    await verify('jump boost + speed')
  })
})
