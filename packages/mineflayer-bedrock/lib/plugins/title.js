// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/title.js
// Surface: none (events only)
// Events: 'title' (text, 'title'|'subtitle'), 'title_times' (fadeIn, stay, fadeOut), 'title_clear'
// Bedrock: set_title {type: set_title|set_subtitle|action_bar_message|clear|reset|set_durations, …}
//   (action bar → chat plugin 'actionBar').
'use strict'

module.exports = inject

function inject (bot) {}
