// owner: U6 (chat, commands & HUD)
// Adapted from mineflayer 4.39.0 lib/plugins/title.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): parseTitle kept verbatim.
// Surface: none (events only)
// Events: 'title' (text, 'title'|'subtitle'), 'title_times' (fadeIn, stay, fadeOut), 'title_clear'
// Bedrock: set_title { type, text, fade_in_time, stay_time, fade_out_time } (BDS 1.26.51.1, `/title`, `/titleraw`):
//   set_title / set_subtitle (text as typed) → 'title' (parseTitle(text), 'title'|'subtitle'), so
//     `/title @a title {"text":"x"}` gives 'x' like Java;
//   set_title_json / set_subtitle_json (rawtext JSON) → 'title' with the rawtext rendered as a plain string;
//   set_durations → 'title_times' (fade in, stay, fade out — ticks, like Java);
//   clear / reset → 'title_clear';
//   action_bar_message(_json) → the chat plugin's 'actionBar' (+ 'message' at game_info).
'use strict'
const { fromRawText } = require('../bedrock/text')

module.exports = inject

function inject (bot) {
  function parseTitle (text) {
    try {
      const parsed = JSON.parse(text)
      return typeof parsed === 'string' ? parsed : (parsed.text || text)
    } catch {
      return typeof text === 'string' ? text.replace(/^"|"$/g, '') : text
    }
  }

  const rawTitle = (json) => fromRawText(bot.registry, json).toString()

  bot._client.on('set_title', (packet) => {
    try {
      onTitle(packet)
    } catch (err) {
      // malformed JSON text from a non-vanilla sender must not escape into the packet pipeline (like chat.js)
      bot.emit('error', err)
    }
  })

  function onTitle (packet) {
    switch (packet.type) {
      case 'set_title':
        bot.emit('title', parseTitle(packet.text), 'title')
        break
      case 'set_subtitle':
        bot.emit('title', parseTitle(packet.text), 'subtitle')
        break
      case 'set_title_json':
        bot.emit('title', rawTitle(packet.text), 'title')
        break
      case 'set_subtitle_json':
        bot.emit('title', rawTitle(packet.text), 'subtitle')
        break
      case 'set_durations':
        if (typeof packet.fade_in_time === 'number' && typeof packet.stay_time === 'number' && typeof packet.fade_out_time === 'number') {
          bot.emit('title_times', packet.fade_in_time, packet.stay_time, packet.fade_out_time)
        }
        break
      case 'clear':
      case 'reset':
        bot.emit('title_clear')
        break
      // action_bar_message / action_bar_message_json: chat plugin ('actionBar')
    }
  }
}
