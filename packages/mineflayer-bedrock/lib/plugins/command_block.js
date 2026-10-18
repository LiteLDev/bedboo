// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/command_block.js
// Surface: bot.setCommandBlock(pos, command, options = {}) options {mode, trackOutput, conditional,
//   alwaysActive}
// Bedrock: command_block_update {is_block: true, position, mode, needs_redstone, conditional,
//   command, last_output, name, should_track_output, tick_delay, execute_on_first_tick}.
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.setCommandBlock = stubSync('U9', 'bot.setCommandBlock', 2)
}
