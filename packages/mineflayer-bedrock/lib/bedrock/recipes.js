// owner: U12 (crafting)
'use strict'
const { stubSync } = require('./errors')

/**
 * Recipes from the `crafting_data` packet → prismarine-recipe compatible `Recipe` objects
 * (`result`, `inShape`, `outShape`, `ingredients`, `delta`, `requiresTable`) so `bot.recipesFor`,
 * `bot.recipesAll` and `bot.craft` keep mineflayer's semantics. Each Recipe additionally keeps its
 * Bedrock `network_id` (`recipe.bedrock = { networkId, block, … }`) needed by the `craft_recipe`
 * stack-request action.
 *
 * Contract:
 * - `parseCraftingData(registry, packet) → Recipe[]`
 * - `createRecipeBook(bot)` → `{ load(packet), recipesFor(itemType, metadata, minResultCount, craftingTable), recipesAll(itemType, metadata, craftingTable), byNetworkId(id) }`
 */

module.exports = {
  parseCraftingData: stubSync('U12', 'recipes.parseCraftingData', 2),
  createRecipeBook: stubSync('U12', 'recipes.createRecipeBook', 1)
}
