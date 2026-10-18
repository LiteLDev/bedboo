// owner: U8 (inventory, windows, creative & item use; flight delegates to U5's physics hook)
// Upstream: mineflayer 4.39.0 lib/plugins/creative.js
// Surface: bot.creative { setInventorySlot(slot, item, waitTimeout = 400), clearSlot(slot),
//   clearInventory(), flyTo(destination), startFlying(), stopFlying() }
// Bedrock: item_stack_request `craft_creative` + `place`/`destroy` (creative_content network ids);
//   flight via bot._bedrock.physics.setFlying (U5) / auth-input start_flying/stop_flying flags.
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.creative = {
    setInventorySlot: stubAsync('U8', 'bot.creative.setInventorySlot', 2),
    flyTo: stubAsync('U8', 'bot.creative.flyTo', 1),
    startFlying: stubSync('U8', 'bot.creative.startFlying', 0),
    stopFlying: stubSync('U8', 'bot.creative.stopFlying', 0),
    clearSlot: stubAsync('U8', 'bot.creative.clearSlot', 1),
    clearInventory: stubAsync('U8', 'bot.creative.clearInventory', 0)
  }
}
