// owner: U7 (entities & players)
'use strict'
/**
 * Entities against a real BDS 1.26.51.1 (Bedrock extra, U7): for every mob family (hostile, animal, ambient,
 * passive, water creature, golem, living object, vehicles, orbs, items, paintings) a summoned entity is reported with
 * its registry data and its FEET position (Bedrock per-type wire offsets removed), then entityUpdate, entityMoved
 * (teleported), entityHurt (/damage), entityDead + entityGone (/kill); effects (entityEffect / entityEffectEnd +
 * entityAttributes), equipment (entityEquip + synthesized armor attributes), name tags, itemDrop, paintings.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')
const { useItemOn } = require('../../lib/bedrock/transactions')

const GROUND = -60

describe('entities (U7): spawn / update / move / hurt / dead / gone per mob family', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  before(async () => {
    await env.server.commandOutput('time set midnight') // no burning zombies / skeletons
  })
  beforeEach(() => env.bot.test.resetState())

  const ev = (name, predicate, timeout) => env.bot.test.botEvent(name, predicate, timeout)
  /** console command, resolved once BDS ran it */
  const cmd = (command) => env.server.commandOutput(command)

  // [name, summon options, living, offset of the wire position (documented, removed by the plugin)]
  const families = [
    ['zombie', { spawnEvent: 'minecraft:as_adult' }, true],
    ['skeleton', {}, true],
    ['spider', {}, true],
    ['creeper', {}, true],
    ['pig', {}, true],
    ['chicken', {}, true],
    ['wolf', {}, true],
    ['bat', {}, true],
    ['squid', {}, true],
    ['villager_v2', {}, true],
    ['iron_golem', {}, true],
    ['armor_stand', {}, false],
    ['boat', {}, false],
    ['minecart', {}, false]
  ]

  for (const [name, opts, living] of families) {
    it(`${name}: entitySpawn (registry data, feet position), entityUpdate, entityMoved${living ? ', entityHurt, entityDead' : ''}, entityGone`, async () => {
      const { bot } = env
      const data = bot.registry.entitiesByName[name]
      const at = new Vec3(3, GROUND, 2)
      const updated = ev('entityUpdate', (e) => e.name === name)
      const entity = await bot.test.summon(name, at, opts)
      assert.strictEqual(bot.entities[entity.id], entity)
      assert.strictEqual(entity.name, name)
      assert.strictEqual(entity.displayName, data.displayName)
      assert.strictEqual(entity.type, data.type)
      assert.strictEqual(entity.kind, data.category)
      assert.strictEqual(entity.entityType, data.id)
      assert.strictEqual(entity.width, data.width)
      assert.strictEqual(entity.height, data.height)
      assert.strictEqual(typeof entity.uniqueId, 'bigint')
      assert.ok(Math.abs(entity.position.x - 3.5) < 0.75 && Math.abs(entity.position.z - 2.5) < 0.75, `${name} at ${entity.position}`)
      if (name !== 'bat') assert.ok(Math.abs(entity.position.y - GROUND) < 0.1, `${name} feet y ${entity.position.y}`)
      const [updatedEntity] = await updated.promise
      assert.strictEqual(updatedEntity, entity)

      const moved = ev('entityMoved', (e) => e === entity && e.position.distanceTo(new Vec3(6.5, GROUND, -3.5)) < 0.6)
      await cmd(`tp @e[type=${name}] 6 ${GROUND} -4`)
      await moved.promise
      if (name !== 'bat') assert.ok(Math.abs(entity.position.y - GROUND) < 0.1, `${name} feet y after the teleport ${entity.position.y}`)

      const events = []
      const listeners = ['entityHurt', 'entityDead', 'entityGone'].map((e) => [e, (target) => { if (target === entity) events.push(e) }])
      for (const [e, fn] of listeners) bot.on(e, fn)
      try {
        if (living) {
          const hurt = ev('entityHurt', (e) => e === entity)
          await cmd(`damage @e[type=${name}] 1`)
          await hurt.promise
        }
        await bot.test.killEntity(entity)
      } finally {
        for (const [e, fn] of listeners) bot.removeListener(e, fn)
      }
      assert.strictEqual(bot.entities[entity.id], undefined)
      assert.strictEqual(entity.isValid, false)
      assert.deepStrictEqual(events.slice(-1), ['entityGone'])
      if (living) {
        // /damage → entityHurt; /kill → entityHurt (the killing blow) + entityDead; then entityGone
        assert.deepStrictEqual(events.slice(-3), ['entityHurt', 'entityDead', 'entityGone'], events.join(' '))
        assert.ok(events.filter(e => e === 'entityHurt').length >= 2, events.join(' '))
      }
    })
  }

  it('entityEffect / entityEffectEnd (Bedrock effect ids) and entityAttributes (movement speed)', async () => {
    const { bot } = env
    const pig = await bot.test.summon('pig', new Vec3(2, GROUND, 3))
    const effect = ev('entityEffect', (e) => e === pig)
    const attributes = ev('entityAttributes', (e) => e === pig && Math.abs(e.attributes['minecraft:movement_speed'].current - 0.25) > 0.01)
    await cmd('effect @e[type=pig] speed 30 1')
    const [, added] = await effect.promise
    assert.deepStrictEqual(added, { id: 1, amplifier: 1, duration: 600 })
    assert.strictEqual(bot.registry.effects[added.id].name, 'Speed')
    assert.deepStrictEqual(pig.effects[1], added)
    await attributes.promise
    assert.ok(Math.abs(pig.attributes['minecraft:movement_speed'].value - 0.25) < 1e-3, 'base value (modifier removed)')
    const ended = ev('entityEffectEnd', (e) => e === pig)
    await cmd('effect @e[type=pig] clear')
    const [, removed] = await ended.promise
    assert.strictEqual(removed.id, 1)
    assert.strictEqual(pig.effects[1], undefined)
    await bot.test.killEntity(pig)
  })

  it('entityEquip: held item and armor (equipment indexes like Java) + armor attributes for getExplosionDamages', async () => {
    const { bot } = env
    const zombie = await bot.test.summon('zombie', new Vec3(2, GROUND, -3), { spawnEvent: 'minecraft:as_adult' })
    let equip = ev('entityEquip', (e) => e === zombie && e.heldItem?.name === 'iron_sword')
    await cmd('replaceitem entity @e[type=zombie] slot.weapon.mainhand 0 iron_sword')
    await equip.promise
    equip = ev('entityEquip', (e) => e === zombie && e.equipment[5]?.name === 'diamond_helmet')
    await cmd('replaceitem entity @e[type=zombie] slot.armor.head 0 diamond_helmet')
    await equip.promise
    equip = ev('entityEquip', (e) => e === zombie && e.equipment[2]?.name === 'iron_boots')
    await cmd('replaceitem entity @e[type=zombie] slot.armor.feet 0 iron_boots')
    await equip.promise
    assert.strictEqual(zombie.attributes['generic.armor'].value, 3 + 2)
    assert.strictEqual(zombie.attributes['generic.armorToughness'].value, 2)
    assert.deepStrictEqual(zombie.attributes['minecraft:armor'], { value: 5, modifiers: [] })
    await bot.test.killEntity(zombie)
  })

  it('name tags: getCustomName()', async () => {
    const { bot } = env
    const pig = await bot.test.summon('pig', new Vec3(-3, GROUND, 2), { nameTag: 'Bob' })
    const named = pig.getCustomName() ?? (await ev('entityUpdate', (e) => e === pig && e.getCustomName()).promise)[0].getCustomName()
    assert.strictEqual(named.toString(), 'Bob')
    await bot.test.killEntity(pig)
  })

  it('xp orbs and items: entitySpawn + itemDrop with getDroppedItem(), feet positions', async () => {
    const { bot } = env
    const orb = await bot.test.summon('xp_orb', new Vec3(-3, GROUND, -3))
    assert.strictEqual(orb.type, 'other')
    assert.strictEqual(orb.displayName, 'Experience Orb')
    // a destroyed block drops itself
    await bot.test.setBlock({ x: 4, y: GROUND, z: 4, blockName: 'dirt' })
    const dropped = ev('itemDrop', (e) => e.getDroppedItem()?.name === 'dirt')
    await cmd(`setblock 4 ${GROUND} 4 air destroy`)
    const [item] = await dropped.promise
    assert.strictEqual(item.name, 'item')
    assert.strictEqual(item.displayName, 'Item')
    assert.strictEqual(item.getDroppedItem().count, 1)
    assert.ok(item.position.distanceTo(new Vec3(4.5, GROUND + 0.5, 4.5)) < 0.8, `item at ${item.position}`)
    // it falls on the grass: feet at the ground (the wire position is 0.125 higher)
    const deadline = Date.now() + 5000
    while (Math.abs(item.position.y - GROUND) > 0.05 && Date.now() < deadline) await bot.test.wait(100)
    assert.ok(Math.abs(item.position.y - GROUND) < 0.3, `resting item feet y ${item.position.y}`)
    await bot.test.killAllEntities()
  })

  it('paintings: add_painting → painting entity + blockAt(…, true).painting', async () => {
    const { bot } = env
    await bot.test.setBlock({ x: 0, y: GROUND + 1, z: -4, blockName: 'stone' })
    await cmd(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 0 painting 1`)
    await bot.test.wait(500)
    const spawned = ev('entitySpawn', (e) => e.name === 'painting')
    await useItemOn(bot, { position: new Vec3(0, GROUND + 1, -4), face: 3, hotbarSlot: 0 })
    const [entity] = await spawned.promise
    assert.strictEqual(entity.displayName, 'Painting')
    const painting = bot._bedrock.world.paintings.byId[entity.id]
    assert.ok(painting, 'registered in the world')
    assert.match(painting.name, /^[a-z0-9_]+$/)
    assert.deepStrictEqual(painting.direction, new Vec3(0, 0, -1), 'hangs on the block to its north')
    assert.strictEqual(painting.position.z, -3)
    assert.strictEqual(bot.blockAt(painting.position, true).painting, painting)
    const gone = ev('entityGone', (e) => e === entity)
    await cmd('kill @e[type=painting]')
    await gone.promise
    assert.strictEqual(bot._bedrock.world.paintings.byId[entity.id], undefined)
  })
})
