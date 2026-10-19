'use strict'
// owner: U16b (seeded combat library; the combat skill itself is U18's) — no server: a fake mineflayer bot
const assert = require('assert')
const { EventEmitter } = require('events')
const { Vec3 } = require('vec3')
const combat = require('../src/skills/combat')

/** a minimal mineflayer-shaped bot: walks 0.25 block/tick towards its yaw while `forward` is held */
function fakeBot ({ position = new Vec3(0, 0, 0), items = [] } = {}) {
  const bot = new EventEmitter()
  bot.entity = { position, yaw: 0, pitch: 0, eyeHeight: 1.62, height: 1.8, width: 0.6, type: 'player', isCollidedHorizontally: false }
  bot.entities = { 0: bot.entity }
  bot.health = 20
  bot.controlState = { forward: false, back: false, left: false, right: false, sprint: false, jump: false, sneak: false }
  bot.setControlState = (c, on) => { bot.controlState[c] = on }
  bot.clearControlStates = () => { for (const c of Object.keys(bot.controlState)) bot.controlState[c] = false }
  bot.inventory = { slots: new Array(46).fill(null), items: () => items }
  bot.heldItem = null
  bot.equip = async (item, dest) => { if (dest === 'hand') bot.heldItem = item }
  bot.look = async (yaw, pitch) => { bot.entity.yaw = yaw; bot.entity.pitch = pitch }
  bot.lookAt = async (p) => {
    const d = p.minus(bot.entity.position.offset(0, 1.62, 0))
    bot.entity.yaw = Math.atan2(-d.x, -d.z)
    bot.entity.pitch = Math.atan2(d.y, Math.hypot(d.x, d.z))
  }
  bot.attacks = []
  bot.attack = (target) => { bot.attacks.push(target); bot.emit('_attack', target) }
  bot.activateItem = () => {}
  bot.deactivateItem = () => {}
  bot.nearestEntity = (match) => {
    let best = null
    for (const e of Object.values(bot.entities)) {
      if (e === bot.entity || !match(e)) continue
      if (!best || e.position.distanceTo(bot.entity.position) < best.position.distanceTo(bot.entity.position)) best = e
    }
    return best
  }
  bot.waitForTicks = async (n) => {
    for (let i = 0; i < n; i++) {
      if (bot.controlState.forward) {
        const step = bot.controlState.sprint ? 0.28 : 0.22
        bot.entity.position = bot.entity.position.offset(-Math.sin(bot.entity.yaw) * step, 0, -Math.cos(bot.entity.yaw) * step)
      }
      await new Promise((resolve) => setImmediate(resolve))
    }
  }
  return bot
}

function mob (id, name, position, extra = {}) {
  return { id, name, type: 'hostile', kind: 'Hostile mobs', position, width: 0.6, height: 1.9, ...extra }
}

describe('combat library (U16b seed of skills/combat.js)', () => {
  it('keeps the skill a U18 stub but exposes the helpers', async () => {
    assert.strictEqual(combat.notImplemented, true)
    await assert.rejects(combat({}, {}), (err) => err.notImplemented && err.unit === 'U18')
    for (const fn of ['fight', 'fightAll', 'nearestHostile', 'equipForCombat', 'bowAim', 'hitboxDistance']) assert.strictEqual(typeof combat[fn], 'function', fn)
  })

  it('isHostile: hostile families, not players or passive mobs; neutral mobs only when asked', () => {
    assert.ok(combat.isHostile({ name: 'zombie', type: 'hostile' }))
    assert.ok(combat.isHostile({ name: 'ghast', type: 'mob', kind: 'Hostile mobs' }))
    assert.ok(!combat.isHostile({ name: 'pig', type: 'animal', kind: 'Passive mobs' }))
    assert.ok(!combat.isHostile({ name: 'Steve', type: 'player' }))
    assert.ok(!combat.isHostile({ name: 'enderman', type: 'hostile' }))
    assert.ok(combat.isHostile({ name: 'enderman', type: 'hostile' }, { includeNeutral: true }))
  })

  it('hitboxDistance: eyes to the closest point of the target box', () => {
    const bot = fakeBot()
    assert.ok(Math.abs(combat.hitboxDistance(bot, mob(1, 'zombie', new Vec3(3, 0, 0))) - 2.7) < 1e-9)
    // a target above: measured to its feet
    assert.ok(Math.abs(combat.hitboxDistance(bot, mob(1, 'phantom', new Vec3(0, 5.62, 0), { width: 0.9, height: 0.5 })) - 4) < 1e-9)
  })

  it('bowAim: a level shot aims slightly up, higher targets need more pitch, out of range → null', () => {
    const near = combat.bowAim(10, 0)
    assert.ok(near.pitch > 0 && near.pitch < 0.1, `pitch ${near.pitch}`)
    assert.ok(near.ticks >= 3 && near.ticks <= 5, `${near.ticks} ticks`)
    const far = combat.bowAim(40, 0)
    assert.ok(far.pitch > near.pitch)
    assert.ok(combat.bowAim(10, 5).pitch > near.pitch)
    assert.ok(combat.bowAim(10, -5).pitch < near.pitch)
    assert.strictEqual(combat.bowAim(400, 0), null)
  })

  it('nearestHostile skips the dead, passive mobs and players; names select neutral mobs too', () => {
    const bot = fakeBot()
    const pig = { id: 1, name: 'pig', type: 'animal', position: new Vec3(1, 0, 0) }
    const zombie = mob(2, 'zombie', new Vec3(4, 0, 0))
    const skeleton = mob(3, 'skeleton', new Vec3(6, 0, 0))
    const enderman = mob(4, 'enderman', new Vec3(2, 0, 0))
    Object.assign(bot.entities, { 1: pig, 2: zombie, 3: skeleton, 4: enderman })
    assert.strictEqual(combat.nearestHostile(bot), zombie)
    bot.emit('entityDead', zombie)
    assert.strictEqual(combat.nearestHostile(bot), skeleton)
    assert.strictEqual(combat.nearestHostile(bot, { radius: 5 }), null)
    assert.strictEqual(combat.nearestHostile(bot, { names: ['enderman'] }), enderman)
  })

  it('fight: approaches, attacks every 10 ticks, reports a kill by the bot', async () => {
    const sword = { name: 'diamond_sword' }
    const bot = fakeBot({ items: [sword] })
    const zombie = mob(2, 'zombie', new Vec3(6, 0, 0))
    bot.entities[2] = zombie
    let hits = 0
    const ticksAtHit = []
    let tick = 0
    const wait = bot.waitForTicks
    bot.waitForTicks = async (n) => { tick += n; return wait(n) }
    bot.on('_attack', (target) => {
      ticksAtHit.push(tick)
      bot.emit('entityHurt', target)
      if (++hits === 3) setImmediate(() => bot.emit('entityDead', target))
    })
    const r = await combat.fight(bot, zombie, { bow: false, timeout: 5000 })
    assert.strictEqual(r.outcome, 'killed')
    assert.strictEqual(r.byBot, true)
    assert.strictEqual(r.attacks, 3)
    assert.strictEqual(bot.heldItem, sword, 'the sword was equipped')
    assert.ok(combat.hitboxDistance(bot, zombie) <= 3, 'walked into reach')
    for (let i = 1; i < ticksAtHit.length; i++) assert.ok(ticksAtHit[i] - ticksAtHit[i - 1] >= 10, `attack interval ${ticksAtHit}`)
    assert.ok(Object.values(bot.controlState).every((on) => !on), 'controls released')
  })

  it('fight: a creeper is hit from the edge of the reach, then the bot backs off', async () => {
    const bot = fakeBot({ items: [{ name: 'diamond_sword' }] })
    const creeper = mob(5, 'creeper', new Vec3(2.95, 0, 0), { height: 1.8 })
    bot.entities[5] = creeper
    const controlsAtHit = []
    bot.on('_attack', (target) => {
      controlsAtHit.push({ ...bot.controlState })
      setImmediate(() => bot.emit('entityHurt', target))
      if (controlsAtHit.length === 2) setImmediate(() => bot.emit('entityDead', target))
    })
    let backing = 0
    const wait = bot.waitForTicks
    bot.waitForTicks = async (n) => { if (bot.controlState.back) backing++; return wait(n) }
    const r = await combat.fight(bot, creeper, { bow: false, timeout: 5000 })
    assert.strictEqual(r.outcome, 'killed')
    assert.ok(backing > 0, 'backed off after a hit')
  })

  it('fight: the bot dying ends the fight with outcome died (even when the target dies too)', async () => {
    const bot = fakeBot({ items: [] })
    const zombie = mob(2, 'zombie', new Vec3(2, 0, 0))
    bot.entities[2] = zombie
    setTimeout(() => { bot.emit('death'); bot.emit('entityDead', zombie) }, 20)
    const r = await combat.fight(bot, zombie, { bow: false, timeout: 5000 })
    assert.strictEqual(r.outcome, 'died')
    assert.strictEqual(r.targetDied, true)
  })

  it('fight: no physics ticks while dead (waitForTicks rejects) does not throw', async () => {
    const bot = fakeBot({ items: [] })
    const zombie = mob(2, 'zombie', new Vec3(2, 0, 0))
    bot.entities[2] = zombie
    let dead = false
    const wait = bot.waitForTicks
    bot.waitForTicks = (n) => dead ? Promise.reject(new Error('Timeout waiting for 1 ticks')) : wait(n)
    setTimeout(() => { dead = true; bot.emit('death') }, 20)
    const r = await combat.fight(bot, zombie, { bow: false, timeout: 5000 })
    assert.strictEqual(r.outcome, 'died')
  })

  it('equipForCombat: wears the best armor it has, upgrading a worse worn piece', async () => {
    const leather = { name: 'leather_chestplate' }
    const diamond = { name: 'diamond_chestplate' }
    const items = [diamond, { name: 'iron_sword' }, { name: 'shield' }]
    const bot = fakeBot({ items })
    bot.inventory.slots[6] = leather
    const equipped = []
    bot.equip = async (item, dest) => { equipped.push([item.name, dest]); if (dest === 'hand') bot.heldItem = item; if (dest === 'torso') bot.inventory.slots[6] = item }
    const out = await combat.equipForCombat(bot)
    assert.deepStrictEqual(out.armor, ['diamond_chestplate'])
    assert.strictEqual(out.weapon, 'iron_sword')
    assert.strictEqual(out.shield, true)
    assert.deepStrictEqual(equipped, [['diamond_chestplate', 'torso'], ['shield', 'off-hand'], ['iron_sword', 'hand']])
    // already the best: nothing to do
    equipped.length = 0
    items.splice(0, 1)
    assert.deepStrictEqual((await combat.equipForCombat(bot)).armor, ['diamond_chestplate'])
    assert.deepStrictEqual(equipped.filter(([, dest]) => dest === 'torso'), [])
  })

  it('fight: shulkers and endermen are never shot', async () => {
    for (const name of ['shulker', 'enderman']) {
      const bot = fakeBot({ items: [{ name: 'bow' }, { name: 'arrow' }, { name: 'diamond_sword' }] })
      const target = mob(7, name, new Vec3(10, 0, 0))
      bot.entities[7] = target
      let shots = 0
      bot.activateItem = () => { shots++ }
      bot.on('_attack', (t) => { bot.emit('entityHurt', t); setImmediate(() => bot.emit('entityDead', t)) })
      const r = await combat.fight(bot, target, { timeout: 5000 })
      assert.strictEqual(r.outcome, 'killed', name)
      assert.strictEqual(shots, 0, name)
    }
  })
})
