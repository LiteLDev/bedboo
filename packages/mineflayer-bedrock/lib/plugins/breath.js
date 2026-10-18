// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/breath.js (+ entities.js air_supply metadata)
// Surface: bot.oxygenLevel (0..20; upstream undefined until the first metadata update)
// Events: 'breath'
// Bedrock: set_entity_data `air_supply` (0..300 ticks; oxygenLevel = round(air / 15)) for the local
//   runtime id — applied through lib/bedrock/entity_data.js (U4) which emits 'breath'.
'use strict'

module.exports = inject

function inject (bot) {
  bot.oxygenLevel = 20
}
