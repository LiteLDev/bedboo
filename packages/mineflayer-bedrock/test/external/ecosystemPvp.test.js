// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-pvp 1.3.2 (unpatched) with mineflayer-pathfinder on BDS 1.26.51.1 (Bedrock extra, docs/ecosystem.md):
 * the bot (survival, diamond sword, iron armor; a shield in the off-hand in one run) kills a summoned zombie and a skeleton
 * (difficulty easy, at night so they do not burn). Random (mob AI, knockback): the gate is ≥ 4/5 runs.
 * Bedrock: no attack cooldown (pvp's Java cooldown timing is merely slower than needed); the shield is raised with
 * `activateItem(true)`, which mineflayer-bedrock maps to sneaking (docs/differences/U8.md).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('ecosystemPvp', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })

  before(async () => {
    const { bot } = ctx
    bot.loadPlugin(require('mineflayer-pathfinder').pathfinder)
    bot.loadPlugin(require('mineflayer-pvp').plugin)
    assert.ok(bot.pvp && bot.pathfinder)
    await bot.test.ctx.consoleOutput('time set midnight')
  })
  beforeEach(async function () {
    const { bot } = ctx
    await bot.test.resetState()
    await bot.test.ctx.consoleOutput('kill @e[type=!player]')
    bot.setQuickBarSlot(0)
    const Item = require('prismarine-item')(bot.registry)
    const set = (slot, name) => bot.test.setInventorySlot(slot, new Item(bot.registry.itemsByName[name].id, 1, 0))
    await set(36, 'diamond_sword')
    await set(5, 'iron_helmet')
    await set(6, 'iron_chestplate')
    await set(7, 'iron_leggings')
    await set(8, 'iron_boots')
    if (this.currentTest?.title.includes('shield')) await set(45, 'shield')
    await bot.test.ctx.consoleOutput(`effect ${bot.username} instant_health 1 10 true`)
    await bot.test.becomeSurvival()
  })
  afterEach(async () => {
    const { bot } = ctx
    bot.pvp.forceStop()
    bot.pathfinder.setGoal(null)
    bot.clearControlStates()
    await bot.test.ctx.consoleOutput('kill @e[type=!player]')
    await bot.test.becomeCreative()
  })

  async function fight (type, at) {
    const { bot } = ctx
    const mob = await bot.test.summon(type, at)
    const entity = bot.entities[mob.id] ?? mob
    let attacks = 0
    let sneaked = false
    const onAttack = () => { attacks++ }
    const onTick = () => { if (bot.getControlState('sneak')) sneaked = true }
    bot.on('attackedTarget', onAttack)
    bot.on('physicsTick', onTick)
    // diagnostics printed when the fight fails: path events and the state every second
    const trace = []
    const on = {
      path_reset: (r) => trace.push(`reset ${r} at ${bot.entity.position.floored()}`),
      path_update: (r) => trace.push(`path ${r.status} ${r.path.length}`),
      path_stop: () => trace.push('path_stop'),
      goal_updated: (g) => trace.push(`goal_updated ${g?.constructor?.name}`)
    }
    for (const [name, fn] of Object.entries(on)) bot.on(name, fn)
    const sampler = setInterval(() => trace.push(`bot ${bot.entity.position.floored()} mob ${entity.position.floored()} goal ${bot.pathfinder.goal?.constructor?.name} moving ${bot.pathfinder.isMoving()} inRange ${bot.pvp.wasInRange}`), 1000)
    const t0 = Date.now()
    try {
      const dead = new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${type} still alive after 60 s (health ${bot.health}, ${attacks} attacks, mob at ${entity.position}, bot at ${bot.entity.position})`)), 60000)
        const onGone = (e) => {
          if (e !== entity) return
          clearTimeout(timer)
          bot.removeListener('entityGone', onGone)
          resolve()
        }
        bot.on('entityGone', onGone)
      })
      bot.pvp.attack(entity)
      await dead
    } catch (err) {
      console.log(trace.slice(-80).join('\n'))
      throw err
    } finally {
      clearInterval(sampler)
      for (const [name, fn] of Object.entries(on)) bot.removeListener(name, fn)
      bot.removeListener('attackedTarget', onAttack)
      bot.removeListener('physicsTick', onTick)
    }
    console.log(`      ${type}: dead after ${((Date.now() - t0) / 1000).toFixed(1)} s, ${attacks} attacks, bot health ${bot.health}, shield raised ${sneaked}`)
    assert.ok(attacks > 0, 'the bot attacked')
    assert.ok(bot.health > 0, 'the bot survived')
    return { attacks, sneaked }
  }

  it('kills a zombie (pvp.attack: GoalFollow + melee)', async () => {
    const g = ctx.bot.test.groundY
    await fight('zombie', new Vec3(6, g, 0))
  })

  it('kills a zombie with a shield in the off-hand (raised = sneaking between attacks)', async () => {
    const g = ctx.bot.test.groundY
    const { sneaked } = await fight('zombie', new Vec3(-6, g, 0))
    assert.ok(sneaked, 'the shield was raised (sneak) between attacks')
  })

  it('fights a creeper with a shield (a fusing creeper — Bedrock `ignited` flag — raises it)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    let ignited = false
    const onMeta = (entity) => { if (entity.name === 'creeper' && entity.metadata?.flags?.ignited) ignited = true }
    bot.on('entityUpdate', onMeta)
    try {
      const { sneaked } = await fight('creeper', new Vec3(0, g, -4))
      console.log(`      creeper: ignited ${ignited}, shield raised ${sneaked}`)
      if (ignited) assert.ok(sneaked, 'the shield was raised against the fusing creeper')
    } finally {
      bot.removeListener('entityUpdate', onMeta)
    }
  })

  it('kills a skeleton (ranged mob; followRange 1)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    // a skeleton backs off while shooting: with pvp's default followRange 2, GoalFollow lets it drift 2 blocks before
    // re-planning while the bot stops 2 blocks short of where it was — 4 blocks, out of the 3.5 attack range for good
    // (the same on Java). followRange 1 keeps it within reach (docs/ecosystem.md)
    bot.pvp.followRange = 1
    try {
      await fight('skeleton', new Vec3(0, g, 7))
    } finally {
      bot.pvp.followRange = 2
    }
  })
})
