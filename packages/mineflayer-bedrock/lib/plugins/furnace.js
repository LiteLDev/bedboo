// owner: U13 (stations)
// Upstream: mineflayer 4.39.0 lib/plugins/furnace.js
// Surface: bot.openFurnace(furnaceBlock) → Promise<Furnace> (window + fuel, progress, takeInput,
//   takeFuel, takeOutput, putInput, putFuel, inputItem, fuelItem, outputItem; event 'update')
// Bedrock: container types furnace / blast_furnace / smoker; container_set_data for
//   progress/fuel (tick_count, lit_time, lit_duration).
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.openFurnace = stubAsync('U13', 'bot.openFurnace', 1)
}
