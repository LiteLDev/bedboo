// owner: U10 (digging)
// Upstream: mineflayer 4.39.0 lib/plugins/digging.js
// Surface: bot.targetDigBlock, bot.targetDigFace, bot.lastDigTime, bot.dig(block, forceLook, digFace),
//   bot.stopDigging() (no-op while not digging, as upstream), bot.canDigBlock(block), bot.digTime(block),
//   bot._getBlockAtEyeLevel()
// Events: 'diggingCompleted' (block), 'diggingAborted' (block)
// Bedrock: server-authoritative block breaking via player_auth_input block_action
//   (start_break / continue_break / predict_break / abort_break / stop_break) + `mine_block`;
//   creative: start_break → predict_break immediately.
'use strict'
const { stub, stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.targetDigBlock = null
  bot.targetDigFace = null
  bot.lastDigTime = null

  bot._getBlockAtEyeLevel = stubSync('U10', 'bot._getBlockAtEyeLevel', 0)
  bot.dig = stubAsync('U10', 'bot.dig', 3)
  // Upstream's idle stopDigging is a no-op (`noop(err)`); keep that so callers like pathfinder's stop() are safe.
  bot.stopDigging = stub('U10', 'bot.stopDigging', { noop: true, length: 1 })
  bot.canDigBlock = stubSync('U10', 'bot.canDigBlock', 1)
  bot.digTime = stubSync('U10', 'bot.digTime', 1)
}
