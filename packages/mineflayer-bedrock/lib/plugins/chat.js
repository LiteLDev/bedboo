// owner: U4 (wave 2, core: bot.chat, message/messagestr/chat) → U6 (wave 3, everything else)
// Upstream: mineflayer 4.39.0 lib/plugins/chat.js
// Surface: bot.chat(message), bot.whisper(username, message), bot.chatAddPattern(pattern, type),
//   bot.addChatPattern(name, pattern, opts), bot.addChatPatternSet(name, patterns, opts),
//   bot.removeChatPattern(name), bot.awaitMessage(...args) → Promise<string>,
//   bot.tabComplete(text, assumeCommand, sendBlockInSight, timeout) → Promise<string[]>
//   options: chatLengthLimit, defaultChatPatterns
// Events: 'message' (jsonMsg, position, sender, verified), 'messagestr' (str, position, jsonMsg),
//   'chat' / 'whisper' (username, message, translate, jsonMsg, matches), 'actionBar' (jsonMsg),
//   'chat:<name>' (matches), 'unmatchedMessage'
// Bedrock: `text` packets (lib/bedrock/text.js); '/'-prefixed messages → command_request
//   {origin:{type:'player', player_entity_id:0n}, version:'latest'} correlated with command_output.
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot, options) {
  bot.chat = stubSync('U4', 'bot.chat', 1)
  bot.whisper = stubSync('U6', 'bot.whisper', 2)
  bot.chatAddPattern = stubSync('U6', 'bot.chatAddPattern', 2)
  bot.addChatPattern = stubSync('U6', 'bot.addChatPattern', 2)
  bot.addChatPatternSet = stubSync('U6', 'bot.addChatPatternSet', 2)
  bot.removeChatPattern = stubSync('U6', 'bot.removeChatPattern', 1)
  bot.awaitMessage = stubAsync('U6', 'bot.awaitMessage', 0)
  bot.tabComplete = stubAsync('U6', 'bot.tabComplete', 1)
}
