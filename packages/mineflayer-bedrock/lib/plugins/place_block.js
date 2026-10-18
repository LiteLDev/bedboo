// owner: U11 (placing & placement-based parity)
// Upstream: mineflayer 4.39.0 lib/plugins/place_block.js (reusable on top of _genericPlace)
// Surface: bot.placeBlock(referenceBlock, faceVector), bot._placeBlockWithOptions(referenceBlock,
//   faceVector, options)
// Events: 'blockPlaced' (oldBlock, newBlock)
'use strict'
const { stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.placeBlock = stubAsync('U11', 'bot.placeBlock', 2)
  bot._placeBlockWithOptions = stubAsync('U11', 'bot._placeBlockWithOptions', 3)
}
