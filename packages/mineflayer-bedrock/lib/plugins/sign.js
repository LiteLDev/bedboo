// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/blocks.js (bot.updateSign, 'signOpen'); split into its own
//   plugin file here so blocks.js (U4) and sign editing (U9) have separate owners.
// Surface: bot.updateSign(block, text, back = false); block.signText / getSignText via
//   prismarine-block (patched by U2/U9)
// Events: 'signOpen' (block)
// Bedrock: open_sign {position, is_front}; edits are sent as block_actor_data / block_entity_data
//   with FrontText/BackText compound (Text, IgnoreLighting, …).
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.updateSign = stubSync('U9', 'bot.updateSign', 2)
}
