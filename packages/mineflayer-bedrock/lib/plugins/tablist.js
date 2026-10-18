// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/tablist.js
// Surface: bot.tablist { header: ChatMessage, footer: ChatMessage }
// Bedrock: there is no tab-list header/footer packet; both stay empty ChatMessages (inherent
//   difference, documented in docs/differences/U6.md). The player list itself is bot.players (U7).
'use strict'

module.exports = inject

function inject (bot) {
  const ChatMessage = require('prismarine-chat')(bot.registry)
  bot.tablist = {
    header: new ChatMessage(''),
    footer: new ChatMessage('')
  }
}
