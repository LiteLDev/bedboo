// owner: U4 (core runtime)
// Upstream: mineflayer 4.39.0 lib/plugins/kick.js
// Surface: bot.quit(reason = 'disconnect.quitting') → bot.end(reason)
// Events: 'kicked' (reason, loggedIn) — Bedrock `disconnect` packet (bedrock-protocol then emits 'kick'
//   and closes the connection, which the loader turns into 'end').
//   `reason` is the Bedrock disconnect message string (e.g. 'Kicked by an operator.' or a translation key
//   such as 'disconnectionScreen.serverFull'); with hide_disconnect_reason it is the reason code name
//   (docs/differences/U4.md#kick-reason). `loggedIn` is true once start_game was received (Java: kicked in the
//   play state) and false during the login/resource-pack phase.
'use strict'

module.exports = inject

function inject (bot) {
  bot._client.on('disconnect', (packet) => {
    const reason = packet.hide_disconnect_reason ? String(packet.reason) : (packet.message || String(packet.reason))
    const loggedIn = !!bot._bedrock?.startGame
    bot.emit('kicked', reason, loggedIn)
  })
  bot.quit = (reason) => {
    reason = reason ?? 'disconnect.quitting'
    bot.end(reason)
  }
}
