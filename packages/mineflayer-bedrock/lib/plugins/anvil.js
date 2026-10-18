// owner: U13 (stations)
// Upstream: mineflayer 4.39.0 lib/plugins/anvil.js
// Surface: bot.openAnvil(anvilBlock) → Promise<Anvil> (window + combine(itemOne, itemTwo, name),
//   rename(item, name))
// Bedrock: container type anvil; item_stack_request craft_recipe_optional (filtered string index
//   for the new name) + results_deprecated.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.openAnvil = stubAsync('U13', 'bot.openAnvil', 1)
}
