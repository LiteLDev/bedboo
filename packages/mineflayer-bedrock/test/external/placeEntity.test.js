// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/placeEntity.js (upstream excludes it from its runs; here it runs) — the
 * four upstream tests VERBATIM (end crystal, boat on water, armor stand; the zombie spawn egg ADAPTED: its Java
 * version chain `registry.isOlderThan('1.9')` … throws for the Bedrock registry, so the newest branch is taken); the
 * entity names come from the same features (ender_crystal, boat, armor_stand, zombie).
 * Server: difficulty easy (a zombie spawn egg spawns nothing in peaceful on Bedrock; with the deterministic profile no
 * other mob spawns).
 * Bedrock extras: minecart on a rail (upstream asserts 'Unimplemented'), a chest boat on land, a villager spawn egg
 * (entity villager_v2), entityPlaced, the 'Unimplemented' assertion and the 5 s 'Failed to place entity'.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('placeEntity', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.killAllEntities?.())

  // ---------------------------------------------------------------- upstream (verbatim)
  const upstream = ((version) => {
    async function runTest (bot, testFunction) {
      await testFunction(bot)
    }

    const tests = []

    function addTest (name, f) {
      tests[name] = bot => runTest(bot, f)
    }

    addTest('place crystal', async (bot) => {
      if (!bot.registry.itemsByName.end_crystal) return // unsupported
      await bot.test.setBlock({ z: 1, relative: true, blockName: 'obsidian' })
      await bot.test.awaitItemReceived(`/give ${bot.username} end_crystal`)
      const crystal = await bot.placeEntity(bot.blockAt(bot.entity.position.offset(0, 0, 1)), new Vec3(0, 1, 0))
      assert(crystal !== null)
      let name = 'EnderCrystal'
      if (bot.supportFeature('enderCrystalNameEndsInErNoCaps')) {
        name = 'ender_crystal'
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        name = 'endercrystal'
      } else if (bot.supportFeature('enderCrystalNameNoCapsWithUnderscore')) {
        name = 'end_crystal'
      }
      const entity = bot.nearestEntity(o => o.name === name)
      assert(entity?.name === name)
      bot.attack(entity)
      await once(bot, 'entityGone')
      await bot.test.setBlock({ z: 1, blockName: 'air', relative: true })
    })

    addTest('place boat', async (bot) => {
      async function placeBlocksForTest (blockName) {
        for (let z = -1; z >= -3; z--) {
          const y = -1
          for (let x = -1; x <= 1; x++) {
            await bot.test.setBlock({ x, y, z, blockName, relative: true })
          }
        }
      }

      await placeBlocksForTest('water')
      await bot.test.awaitItemReceived(`/give ${bot.username} ${bot.registry.oak_boat ? 'oak_boat' : 'boat'}`)
      const boat = await bot.placeEntity(bot.blockAt(bot.entity.position.offset(0, -1, -2)), new Vec3(0, -1, 0))
      assert(boat !== null)
      const name = bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'Boat' : 'boat'
      const entity = bot.nearestEntity(o => o.name === name)
      assert(entity?.name === name)
      await placeBlocksForTest('air')
      bot.attack(entity)
      await once(bot, 'entityGone')
    })

    addTest('place summon egg', async (bot) => {
      // ADAPTED: minecraft-data throws for Java version strings on the Bedrock registry; Bedrock 1.26 takes the newest
      // branch (`isOlderThan` false, like experience.test.js)
      const isOlderThan = (version) => { try { return bot.registry.isOlderThan(version) } catch { return false } }
      let command
      if (isOlderThan('1.9')) {
        command = '/give @p spawn_egg 1 54' // 1.8
      } else if (isOlderThan('1.11')) {
        command = '/give @p spawn_egg 1 0 {EntityTag:{id:Zombie}}' // 1.9 / 1.10
      } else if (isOlderThan('1.12')) {
        command = '/give @p spawn_egg 1 0 {EntityTag:{id:minecraft:zombie}}' // 1.11
      } else if (isOlderThan('1.13')) {
        command = '/give @p spawn_egg 1 0 {EntityTag:{id:zombie}}' // 1.12
      } else {
        command = '/give @p zombie_spawn_egg 1' // >1.12
      }
      await bot.test.awaitItemReceived(command)
      const zombie = await bot.placeEntity(bot.blockAt(bot.entity.position.offset(0, 0, 1)), new Vec3(0, 1, 0))
      assert(zombie !== null)
      const name = bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'Zombie' : 'zombie'
      const entity = bot.nearestEntity(o => o.name === name)
      assert(entity?.name === name)
      await bot.test.killEntity(entity)
    })

    addTest('place armor stand', async (bot) => {
      await bot.test.awaitItemReceived(`/give ${bot.username} armor_stand`)
      const armorStand = await bot.placeEntity(bot.blockAt(bot.entity.position.offset(0, 0, 1)), new Vec3(0, 1, 0))
      assert(armorStand !== null)
      let name
      if (bot.supportFeature('entityNameUpperCaseNoUnderscore')) {
        name = 'ArmorStand'
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        name = 'armorstand'
      } else {
        name = 'armor_stand'
      }
      const entity = bot.nearestEntity(o => o.name === name)
      assert(entity?.name === name)
      bot.attack(entity)
      await once(bot, 'entityGone')
    })

    return tests
  })()

  for (const name of Object.keys(upstream)) {
    it(name, () => upstream[name](ctx.bot))
  }

  // ---------------------------------------------------------------- Bedrock extras
  const give = (slot, name, count = 1) => ctx.bot.test.setInventorySlot(slot, new (require('prismarine-item')(ctx.bot.registry))(ctx.bot.registry.itemsByName[name].id, count, 0))

  it('minecart on a rail, entityPlaced, survival uses the item', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'rail' })
    await give(36, 'minecart')
    await bot.test.becomeSurvival()
    bot.setQuickBarSlot(0)
    const announced = onceWithCleanup(bot, 'entityPlaced', { timeout: 5000 })
    const cart = await bot.placeEntity(bot.blockAt(new Vec3(2, g, 0)), new Vec3(0, 1, 0))
    const [placed] = await announced
    assert.strictEqual(placed, cart)
    assert.strictEqual(cart.name, 'minecart')
    assert.ok(cart.position.distanceTo(new Vec3(2.5, g, 0.5)) < 1, `minecart at ${cart.position}`)
    assert.strictEqual(bot.heldItem, null)
  })

  it('chest boat on land (Bedrock places boats on land too), villager spawn egg → villager_v2', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await give(36, 'oak_chest_boat')
    bot.setQuickBarSlot(0)
    const boat = await bot.placeEntity(bot.blockAt(new Vec3(0, g - 1, 3)), new Vec3(0, 1, 0))
    assert.strictEqual(boat.name, 'chest_boat')
    await give(36, 'villager_spawn_egg')
    const villager = await bot.placeEntity(bot.blockAt(new Vec3(3, g - 1, 0)), new Vec3(0, 1, 0))
    assert.match(villager.name, /^villager/)
  })

  it('upstream checks: nothing held, an item that places no entity', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await assert.rejects(bot.placeEntity(bot.blockAt(new Vec3(1, g - 1, 0)), new Vec3(0, 1, 0)), /^Error: must be holding an item to place an entity$/)
    await give(36, 'dirt')
    bot.setQuickBarSlot(0)
    await assert.rejects(bot.placeEntity(bot.blockAt(new Vec3(1, g - 1, 0)), new Vec3(0, 1, 0)), /Unimplemented/)
  })

  it("a spawn egg the server refuses (peaceful: no hostile mob) rejects with upstream's 'Failed to place entity'", async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    await server.commandOutput('difficulty peaceful')
    try {
      await give(36, 'zombie_spawn_egg')
      bot.setQuickBarSlot(0)
      const start = Date.now()
      await assert.rejects(bot.placeEntity(bot.blockAt(new Vec3(1, g - 1, 1)), new Vec3(0, 1, 0)), /^Error: Failed to place entity$/)
      assert.ok(Date.now() - start >= 4900, 'after upstream\'s 5 s')
    } finally {
      await server.commandOutput('difficulty easy')
    }
  })
})
