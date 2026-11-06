// Upstream: mineflayer 4.39.0 lib/plugins/tablist.js
// Surface: bot.tablist { header: ChatMessage, footer: ChatMessage }
// Bedrock: there is no tab-list header/footer packet in protocol 2193 (the Bedrock player list has no
//   header/footer); both stay empty ChatMessages (inherent difference).
//   The player list itself is bot.players.
'use strict'

module.exports = inject

function inject (bot) {
  const ChatMessage = require('prismarine-chat')(bot.registry)
  bot.tablist = {
    header: new ChatMessage(''),
    footer: new ChatMessage('')
  }
}
