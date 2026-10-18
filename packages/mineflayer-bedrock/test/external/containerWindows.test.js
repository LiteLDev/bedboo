// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Bedrock extra (no upstream test of this name): every station container opens as its Java window type with the
 * registered slot map (lib/bedrock/windows.js), and an item placed into a container slot with bot.clickWindow is
 * accepted by BDS at that address (verified by reopening the block entity where it keeps items). This is the
 * contract wave 4 (craft, furnace, enchanting, anvil, villager) builds on. Entity containers: chest minecart
 * (bot.openEntity / bot.openContainer on an entity).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

// block, Java type, container slots, Java slot to put the probe item into (null: none), the item, keeps items
const STATIONS = [
  ['furnace', 'minecraft:furnace', 3, 0, 'raw_iron', true],
  ['furnace', 'minecraft:furnace', 3, 1, 'coal', true],
  ['blast_furnace', 'minecraft:blast_furnace', 3, 0, 'raw_iron', true],
  ['smoker', 'minecraft:smoker', 3, 0, 'beef', true],
  ['brewing_stand', 'minecraft:brewing_stand', 5, 3, 'nether_wart', true],
  ['brewing_stand', 'minecraft:brewing_stand', 5, 4, 'blaze_powder', 'consumed'], // turned into fuel at once
  ['crafter', 'minecraft:crafter_3x3', 10, 4, 'oak_planks', true],
  ['crafting_table', 'minecraft:crafting', 10, 5, 'oak_planks', false],
  ['anvil', 'minecraft:anvil', 3, 0, 'iron_sword', false],
  ['enchanting_table', 'minecraft:enchantment', 2, 0, 'iron_sword', false],
  ['enchanting_table', 'minecraft:enchantment', 2, 1, 'lapis_lazuli', false],
  ['grindstone', 'minecraft:grindstone', 3, 0, 'iron_sword', false],
  ['stonecutter_block', 'minecraft:stonecutter', 2, 0, 'stone', false],
  ['loom', 'minecraft:loom', 4, 0, 'banner', false],
  ['cartography_table', 'minecraft:cartography', 3, 0, 'paper', false],
  ['smithing_table', 'minecraft:smithing', 4, 1, 'diamond_sword', false],
  ['smithing_table', 'minecraft:smithing', 4, 0, 'netherite_upgrade_smithing_template', false],
  ['smithing_table', 'minecraft:smithing', 4, 2, 'netherite_ingot', false],
  ['beacon', 'minecraft:beacon', 1, 0, 'iron_ingot', false]
]

describe('containerWindows', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  for (const [block, javaType, size, slot, itemName, keeps] of STATIONS) {
    it(`${block}: ${javaType} (${size} container slots), an item in Java slot ${slot} is accepted`, async () => {
      const { bot } = ctx
      const Item = require('prismarine-item')(bot.registry)
      const item = bot.registry.itemsByName[itemName]
      assert.ok(item, itemName)
      await bot.test.setInventorySlot(36, new Item(item.id, 1, 0))
      await bot.test.becomeSurvival()
      const pos = new Vec3(2, bot.test.groundY, 0)
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: block })
      const window = await bot.openBlock(bot.blockAt(pos))
      assert.strictEqual(bot.currentWindow, window)
      assert.strictEqual(window.type, javaType)
      assert.strictEqual(window.inventoryStart, size)
      assert.strictEqual(window.slots.length, size + 36)
      assert.strictEqual(window.slots[window.hotbarStart]?.name, itemName)
      await bot.clickWindow(window.hotbarStart, 0, 0)
      await bot.clickWindow(slot, 0, 0) // accepted (a rejection throws)
      assert.strictEqual(window.selectedItem, null)
      if (keeps === 'consumed') {
        // the block may already have used it up (blaze powder → brewing fuel) when the response arrives
        assert.ok([itemName, undefined].includes(window.slots[slot]?.name))
        assert.strictEqual(bot.inventory.items().length, 0)
        await window.close()
      } else if (keeps) {
        assert.strictEqual(window.slots[slot]?.name, itemName)
        await window.close()
        const again = await bot.openBlock(bot.blockAt(pos))
        assert.strictEqual(again.slots[slot]?.name, itemName, 'the block entity kept the item')
        await bot.clickWindow(slot, 0, 1) // shift click back into the inventory
        assert.strictEqual(again.slots[slot], null)
        await again.close()
        assert.strictEqual(bot.inventory.slots.filter(Boolean).length, 1)
      } else {
        assert.strictEqual(window.slots[slot]?.name, itemName)
        // station slots live in the ui container: take it back, BDS confirms the move
        await bot.clickWindow(slot, 0, 1)
        assert.strictEqual(window.slots[slot], null)
        await window.close()
        assert.strictEqual(bot.inventory.items()[0]?.name, itemName)
      }
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
    })
  }

  it('closing a crafting table puts the grid items back into the inventory (Java semantics; BDS keeps them)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.oak_planks.id, 4, 0))
    const pos = new Vec3(2, bot.test.groundY, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'crafting_table' })
    const window = await bot.openBlock(bot.blockAt(pos))
    await bot.clickWindow(window.hotbarStart, 0, 0)
    await bot.clickWindow(1, 1, 0) // one plank into the grid
    await bot.clickWindow(window.hotbarStart, 0, 0) // the rest back
    assert.strictEqual(window.slots[1]?.count, 1)
    await window.close()
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.oak_planks.id), 4)
    assert.strictEqual(bot.inventory.slots[36]?.count, 4, 'merged back into the stack it came from')
    // the server agrees: reopen, the grid is empty
    const again = await bot.openBlock(bot.blockAt(pos))
    assert.strictEqual(again.containerItems().length, 0)
    await again.close()
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
  })

  it('chest minecart: openContainer(entity) → minecraft:generic_9x3, deposit and withdraw', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const boneId = bot.registry.itemsByName.bone.id
    await bot.test.setInventorySlot(36, new Item(boneId, 2, 0))
    await bot.test.setBlock({ x: 2, y: bot.test.groundY, z: 0, blockName: 'rail' })
    const cart = await bot.test.summon('chest_minecart', new Vec3(2.5, bot.test.groundY, 0.5))
    const entity = bot.entities?.[cart.id] ?? cart
    // openContainer accepts prismarine-entity Entities (U7); a summon record is opened with openEntity
    const window = entity.constructor?.name === 'Entity' ? await bot.openContainer(entity) : await bot.openEntity(entity)
    assert.strictEqual(window.type, 'minecraft:generic_9x3')
    assert.strictEqual(window.inventoryStart, 27)
    await window.deposit(boneId, null, 1)
    assert.strictEqual(window.containerCount(boneId), 1)
    await window.withdraw(boneId, null, 1)
    assert.strictEqual(bot.inventory.count(boneId), 2)
    const closed = once(bot, 'windowClose')
    await window.close()
    await closed
    await bot.test.killEntity(entity)
    await bot.test.setBlock({ x: 2, y: bot.test.groundY, z: 0, blockName: 'air' })
  })
})
