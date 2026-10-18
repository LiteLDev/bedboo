// owner: U6 (chat, commands & HUD)
'use strict'
const { stubSync } = require('./errors')

/**
 * Bedrock text → prismarine-chat `ChatMessage`.
 *
 * Bedrock `text` packets carry either plain strings with `§` formatting codes (`raw`, `chat`,
 * `whisper`, `announcement`, `system`, `tip`, `popup`), translation keys + parameters
 * (`translation`, `needs_translation`), or JSON rawtext (`json`, `json_whisper`, `json_announcement`).
 * U4 provides the minimal chat core; U6 completes all types.
 *
 * Contract:
 * - `toChatMessage(registry, textPacket) → { message: ChatMessage, position: 'chat'|'system'|'game_info', sender?: string }`
 * - `fromRawText(registry, rawtextJson) → ChatMessage`
 * - `fromFormattedString(registry, str) → ChatMessage` (`§` codes → JSON components)
 */

module.exports = {
  toChatMessage: stubSync('U6', 'text.toChatMessage', 2),
  fromRawText: stubSync('U6', 'text.fromRawText', 2),
  fromFormattedString: stubSync('U6', 'text.fromFormattedString', 2)
}
