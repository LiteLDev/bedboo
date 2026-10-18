// owner: U11 (placing & placement-based parity)
// Upstream: mineflayer 4.39.0 lib/plugins/generic_place.js
// Surface: bot._genericPlace(referenceBlock, faceVector, options) options {half, delta, forceLook,
//   offhand, swingArm, showHand}
// Bedrock: lib/bedrock/transactions.useItemOn (click_block wrapped in player_action
//   start_item_use_on / stop_item_use_on); sneak while placing against interactive blocks.
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot._genericPlace = stubAsync('U11', 'bot._genericPlace', 3)
}
