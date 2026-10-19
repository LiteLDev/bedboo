// owner: U12 (crafting)
// Adapted from mineflayer 4.39.0 lib/plugins/craft.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): craft's argument checks, error wrapping and crafting-table window
// handling, and recipesFor / recipesAll / requirementsMetForRecipe are kept verbatim; recipes come from the
// server's crafting_data and each craft is one Bedrock item stack request instead of window clicks.
// Surface: bot.craft(recipe, count, craftingTable), bot.recipesFor(itemType, metadata, minResultCount,
//   craftingTable), bot.recipesAll(itemType, metadata, craftingTable)
// Bedrock:
// - recipes: crafting_data → prismarine-recipe Recipes with the Bedrock `networkId` (lib/bedrock/recipes.js; item
//   tags from lib/bedrock/item_tags.js), also `bot.registry.recipes` in minecraft-data's Java shape;
//   unlocked_recipes + gamerule doLimitedCrafting filter them like the server does. Book: `bot._bedrock.recipes`.
// - craft: BDS only crafts from the crafting grid (2×2 = ui crafting_input 28-31 in the player's inventory screen,
//   crafting table = ui 32-40), so one request per batch: place the ingredients into the grid, craft_recipe
//   { recipe_network_id, times_crafted } + results_deprecated + consume each grid cell, then [create
//   { result_slot_id } per result when there are several] + place from the created output (50) into the inventory
//   (upstream putSelectedItemRange order; what does not fit is carried and tossed like upstream's tossLeftover).
//   Batches: `count` crafts in as few requests as possible (a request makes at most one stack of each result).
//   docs/differences/U12.md
'use strict'
const assert = require('assert')
const { createRecipeBook, planCraft } = require('../bedrock/recipes')
const { fromNetwork } = require('../bedrock/item')

module.exports = inject

// milliseconds to wait for the server's item_stack_response to a craft
const CRAFT_TIMEOUT = 5000

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const book = createRecipeBook(bot)
  bot._bedrock.recipes = book
  bot._client.on('crafting_data', (packet) => book.load(packet))
  bot._client.on('unlocked_recipes', (packet) => book.unlock(packet))
  let windowCraftingTable

  async function craft (recipe, count, craftingTable) {
    assert.ok(recipe)
    count = parseInt(count ?? 1, 10)
    if (recipe.requiresTable && !craftingTable) {
      throw new Error('Recipe requires craftingTable, but one was not supplied: ' + JSON.stringify(recipe))
    }

    try {
      // Bedrock: several crafts per request (upstream: one craftOnce per craft)
      let remaining = count
      while (remaining > 0) {
        remaining -= await craftBatch(recipe, remaining, craftingTable)
      }

      if (windowCraftingTable) {
        // The last put-away click is unconfirmed; closing on a wrong model
        // leaves items the server never placed.
        await bot._syncWindow(windowCraftingTable)
        await bot.closeWindow(windowCraftingTable)
        windowCraftingTable = undefined
      }
    } catch (err) {
      if (windowCraftingTable) {
        bot.closeWindow(windowCraftingTable)
        windowCraftingTable = undefined
      }
      throw new Error(err)
    }
  }

  /** the crafting table window for `craftingTable` (reuses an open one, closes any other window first) */
  async function openCraftingTable (craftingTable) {
    const current = bot.currentWindow
    const at = current?.bedrock?.coordinates
    const pos = craftingTable?.position
    if (current && current.type?.startsWith('minecraft:crafting') && at && pos && at.x === pos.x && at.y === pos.y && at.z === pos.z) {
      return current
    }
    // BDS ignores a container activation while another window is open
    if (current) await bot.closeWindow(current)
    return bot.openBlock(craftingTable)
  }

  /** @returns {Promise<number>} the number of crafts done (≥ 1) */
  async function craftBatch (recipe, remaining, craftingTable) {
    const model = bot._bedrock.inventoryModel
    let window
    let width
    if (craftingTable) {
      if (!windowCraftingTable) {
        windowCraftingTable = await openCraftingTable(craftingTable)
      }
      if (!windowCraftingTable.type.startsWith('minecraft:crafting')) {
        throw new Error('crafting: non craftingTable used as craftingTable: ' + windowCraftingTable.type)
      }
      window = windowCraftingTable
      width = 3
    } else {
      // the 2×2 grid lives in the player's inventory screen, which a container window replaces
      if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
      window = bot.inventory
      width = 2
    }
    const grid = Array.from({ length: width * width }, (_, i) => model.keyOf(window, 1 + i))

    // the book's Recipe (a Recipe from an older crafting_data, prismarine-recipe's Recipe.find or user code is matched
    // by result and ingredients) and the Bedrock recipe to name in craft_recipe
    const target = book.resolve(recipe)
    const bedrock = target && book.bedrockFor(target)
    if (!bedrock) throw new Error('crafting: no recipe of the server matches ' + JSON.stringify(recipe))

    // items left in the grid (an interrupted craft, or put there by clicks) go back first
    const leftovers = grid.filter(key => model.read(key))
    if (leftovers.length > 0) await model.returnItems(window, leftovers)

    // planned when the request is built: after the inventory screen opened for the 2×2 grid (a pickup meanwhile can
    // fill the slot the result was planned for) and again on the status-7 retry; `plan` is the one that was sent (U16a)
    let plan = null
    const replan = () => {
      plan = planCraft({
        registry: bot.registry,
        Item,
        recipe: target,
        bedrock,
        read: (key) => model.read(key),
        grid,
        width,
        remaining,
        created: (wire) => fromNetwork(bot.registry, { ...wire, has_stack_id: false })
      })
      return plan.steps
    }
    await model.execute(window, replan, { timeout: CRAFT_TIMEOUT })
    // the result did not fit into the inventory: toss what is carried, like upstream's putSelectedItemRange
    if (plan.overflow && model.cursor) await model.returnCursor(window)
    return plan.times
  }

  function recipesFor (itemType, metadata, minResultCount, craftingTable) {
    minResultCount = minResultCount ?? 1
    const results = []
    book.find(itemType, metadata).forEach((recipe) => {
      if (requirementsMetForRecipe(recipe, minResultCount, craftingTable)) {
        results.push(recipe)
      }
    })
    return results
  }

  function recipesAll (itemType, metadata, craftingTable) {
    const results = []
    book.find(itemType, metadata).forEach((recipe) => {
      if (!recipe.requiresTable || craftingTable) {
        results.push(recipe)
      }
    })
    return results
  }

  function requirementsMetForRecipe (recipe, minResultCount, craftingTable) {
    if (recipe.requiresTable && !craftingTable) return false

    // how many times we have to perform the craft to achieve minResultCount
    const craftCount = Math.ceil(minResultCount / recipe.result.count)

    // false if not enough inventory to make all the ones that we want
    for (let i = 0; i < recipe.delta.length; ++i) {
      const d = recipe.delta[i]
      if (bot.inventory.count(d.id, d.metadata) + d.count * craftCount < 0) return false
    }

    // otherwise true
    return true
  }

  bot.craft = craft
  bot.recipesFor = recipesFor
  bot.recipesAll = recipesAll
}
