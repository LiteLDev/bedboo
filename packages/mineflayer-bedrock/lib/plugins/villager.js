// owner: U13 (stations)
// Upstream: mineflayer 4.39.0 lib/plugins/villager.js
// Surface: bot.openVillager(villagerEntity) → Promise<Villager> (window + trades; event 'ready'),
//   bot.trade(villagerInstance, tradeIndex, times)
// Bedrock: interact/open via inventory_transaction on the entity; update_trade (offers NBT);
//   item_stack_request craft_recipe (trade index) + results_deprecated.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.openVillager = stubAsync('U13', 'bot.openVillager', 1)
  bot.trade = stubAsync('U13', 'bot.trade', 3)
}
