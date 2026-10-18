// owner: U14 (survival interactions)
// Upstream: mineflayer 4.39.0 lib/plugins/fishing.js
// Surface: bot.fish() → resolves when a fish is caught (bobber entity + splash), rejects if cancelled
// Bedrock: use fishing_rod (transactions.useItem); fishing_hook add_entity; entity_event
//   fish_hook_hook / fish_hook_tease / fish_hook_bubble; reel in with a second use.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.fish = stubAsync('U14', 'bot.fish', 0)
}
