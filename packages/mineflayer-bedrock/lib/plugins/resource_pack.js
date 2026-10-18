// owner: U4 (core runtime; bedrock-protocol patch holds the resource pack response)
// Upstream: mineflayer 4.39.0 lib/plugins/resource_pack.js
// Surface: bot.acceptResourcePack(), bot.denyResourcePack()
// Events: 'resourcePack' (url, hash, uuid)
// Bedrock: resource_packs_info / resource_pack_stack; bedrock-protocol auto-completes them today —
//   U4 patches it to hold the response until accept/deny when a listener is attached.
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.acceptResourcePack = stubSync('U4', 'bot.acceptResourcePack', 0)
  bot.denyResourcePack = stubSync('U4', 'bot.denyResourcePack', 0)
}
