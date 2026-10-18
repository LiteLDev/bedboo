// owner: U8 (inventory, windows, creative & item use)
// Upstream: mineflayer 4.39.0 lib/plugins/chest.js
// Surface: bot.openContainer(containerToOpen, direction, cursorPos), bot.openChest (alias),
//   bot.openDispenser (alias) → Promise<Window with deposit/withdraw>
// Bedrock: container types container/chest/barrel/shulker_box/dispenser/dropper/hopper and
//   chest/hopper minecarts (container_open with entity unique id).
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  const openContainer = stubAsync('U8', 'bot.openContainer', 3)
  bot.openContainer = openContainer
  bot.openChest = openContainer
  bot.openDispenser = openContainer
}
