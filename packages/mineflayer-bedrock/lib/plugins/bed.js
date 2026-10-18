// owner: U9 (wave 3, bed state: isSleeping, isABed, parseBedMetadata, spawnReset) → U14 (wave 4, sleep/wake)
// Upstream: mineflayer 4.39.0 lib/plugins/bed.js
// Surface: bot.isSleeping, bot.isABed(block), bot.parseBedMetadata(bedBlock), bot.sleep(bedBlock),
//   bot.wake()
// Events: 'sleep', 'wake', 'spawnReset', entitySleep/entityWake (entities)
// Bedrock: sleeping via inventory_transaction use-on-bed; set_entity_data sleeping flag/bed position;
//   wake via player_action stop_sleeping; animate wake_up.
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.isSleeping = false
  bot.parseBedMetadata = stubSync('U9', 'bot.parseBedMetadata', 1)
  bot.isABed = stubSync('U9', 'bot.isABed', 1)
  bot.sleep = stubAsync('U14', 'bot.sleep', 1)
  bot.wake = stubAsync('U14', 'bot.wake', 0)
}
