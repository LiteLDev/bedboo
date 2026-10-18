// owner: U12 (crafting)
// Upstream: mineflayer 4.39.0 lib/plugins/craft.js
// Surface: bot.craft(recipe, count, craftingTable), bot.recipesFor(itemType, metadata, minResultCount,
//   craftingTable), bot.recipesAll(itemType, metadata, craftingTable)
// Bedrock: recipes from crafting_data (lib/bedrock/recipes.js); crafting via item_stack_request
//   craft_recipe + results_deprecated + consume + place (2x2 inventory grid or crafting table).
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.craft = stubAsync('U12', 'bot.craft', 3)
  bot.recipesFor = stubSync('U12', 'bot.recipesFor', 4)
  bot.recipesAll = stubSync('U12', 'bot.recipesAll', 3)
}
