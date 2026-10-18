// owner: U12 (crafting)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/crafting.js (verbatim body): 2×2 crafting (birch log → birch planks,
 * Bedrock's flattened names: features blockSchemeIsFlat / oneBlockForSeveralVariations), then a ladder at a crafting
 * table found with findBlock, from `/give @p stick 7` sent by the bot. The table is set with the console helper
 * (setBlock), as upstream does. Bedrock crafts with item stack requests (docs/differences/U12.md#craft-request); the
 * test additionally checks the result against the server's own inventory.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('crafting', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  /** the server's view of the inventory (raw packets) after a console no-op that resends it */
  async function serverInventory (bot) {
    const raw = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'offhand', 10000)
    await bot.test.ctx.consoleOutput(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 8 keep air`)
    await raw.promise
    return bot.test.rawInventory()
  }

  it('crafting', async () => {
    const { bot } = ctx
    const { blocksByName, itemsByName } = bot.registry
    const Item = require('prismarine-item')(bot.registry)

    let populateBlockInventory
    let craftItem
    if (bot.supportFeature('oneBlockForSeveralVariations')) {
      populateBlockInventory = blocksByName.log
      craftItem = 'planks'
    } else if (bot.supportFeature('blockSchemeIsFlat')) {
      populateBlockInventory = itemsByName.birch_log
      craftItem = 'birch_planks'
    }

    function findCraftingTable () {
      const cursor = new Vec3(0, 0, 0)
      for (cursor.x = bot.entity.position.x - 4; cursor.x < bot.entity.position.x + 4; cursor.x++) {
        for (cursor.y = bot.entity.position.y - 4; cursor.y < bot.entity.position.y + 4; cursor.y++) {
          for (cursor.z = bot.entity.position.z - 4; cursor.z < bot.entity.position.z + 4; cursor.z++) {
            const block = bot.blockAt(cursor)
            if (block.type === blocksByName.crafting_table.id) return block
          }
        }
      }
    }

    async function craft (amount, name) {
      const item = itemsByName[name]
      const craftingTable = findCraftingTable()
      const wbText = craftingTable ? 'with a crafting table, ' : 'without a crafting table, '
      if (item == null) {
        bot.test.sayEverywhere(`${wbText}unknown item: ${name}`)
        throw new Error(`${wbText}unknown item: ${name}`)
      } else {
        const recipes = bot.recipesFor(item.id, null, 1, craftingTable) // doesn't check if it's possible to do it amount times
        if (recipes.length) {
          bot.test.sayEverywhere(`${wbText}I can make ${item.name}`)
          await bot.craft(recipes[0], amount, craftingTable)
          bot.test.sayEverywhere(`did the recipe for ${item.name} ${amount} times`)
        } else {
          bot.test.sayEverywhere(`${wbText}I can't make ${item.name}`)
          throw new Error(`${wbText}I can't make ${item.name}`)
        }
      }
    }

    // Test 2x2 crafting (log → planks)
    await bot.test.setInventorySlot(36, new Item(populateBlockInventory.id, 1, 0))
    await bot.test.becomeSurvival()
    await craft(1, craftItem)
    await bot.test.setBlock({ x: 1, y: 0, z: 0, relative: true, blockName: 'crafting_table' })
    bot.chat('/give @p stick 7')
    await once(bot.inventory, 'updateSlot')
    await bot.test.wait(500)
    const craftingTable = bot.findBlock({ matching: blocksByName.crafting_table.id })
    await bot.craft(bot.recipesFor(itemsByName.ladder.id, null, null, true)[0], 1, craftingTable)

    // Bedrock extra: the model agrees with the server (4 birch planks, 3 ladders, no stick left)
    const names = (items) => items.filter(Boolean).map(it => `${it.name}x${it.count}`).sort()
    assert.deepStrictEqual(names(bot.inventory.items()), ['birch_planksx4', 'ladderx3'])
    assert.deepStrictEqual(names((await serverInventory(bot)).inventory), ['birch_planksx4', 'ladderx3'])
    assert.strictEqual(bot.currentWindow, null, 'the crafting table window is closed again')
  })
})
