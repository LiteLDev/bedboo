// owner: U13 (stations)
// Upstream: mineflayer 4.39.0 lib/plugins/enchantment_table.js
// Surface: bot.openEnchantmentTable(block) → Promise<EnchantmentTable> (window + enchantments, xpseed,
//   targetItem, enchant(choice), takeTargetItem, putTargetItem(item), putLapis(item); event 'ready')
// Bedrock: container type enchantment; player_enchant_options; item_stack_request
//   craft_recipe_optional / enchant action with the option's net id.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.openEnchantmentTable = stubAsync('U13', 'bot.openEnchantmentTable', 1)
}
