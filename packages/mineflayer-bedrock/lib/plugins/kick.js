// owner: U4 (core runtime)
// Upstream: mineflayer 4.39.0 lib/plugins/kick.js
// Surface: bot.quit(reason = 'disconnect.quitting') → bot.end(reason)
// Events: 'kicked' (reason, loggedIn) — Bedrock `disconnect` packet (bedrock-protocol emits 'kick').
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.quit = stubSync('U4', 'bot.quit', 1)
}
