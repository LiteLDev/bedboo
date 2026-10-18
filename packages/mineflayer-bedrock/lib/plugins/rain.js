// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/rain.js
// Surface: bot.isRaining, bot.rainState (0..1), bot.thunderState (0..1)
// Events: 'rain' (isRaining toggled), 'weatherUpdate' (rain/thunder level changed)
// Bedrock: level_event start_rain/stop_rain/start_thunder/stop_thunder (data = level * 65535),
//   start_game rain_level / lightning_level.
'use strict'

module.exports = inject

function inject (bot) {
  bot.isRaining = false
  bot.thunderState = 0
  bot.rainState = 0
}
