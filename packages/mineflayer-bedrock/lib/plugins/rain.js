// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/rain.js (MIT, Copyright (c) 2013 Andrew Kelley): same state, 'rain'
//   once per isRaining change (zero crossings), 'weatherUpdate' per level change.
// Surface: bot.isRaining, bot.rainState (0..1), bot.thunderState (0..1)
// Events: 'rain' (isRaining toggled), 'weatherUpdate' (rain/thunder level changed)
// Bedrock (BDS 1.26.51.1, observed live; docs/differences/U9.md#weather):
// - start_game.rain_level / lightning_level (0..1, the current levels at join: BDS sends no level_event for the rain
//   that is already falling) — like the Java join (start_raining + level changes) they emit 'rain' / 'weatherUpdate'.
// - level_event start_rain (3001) / stop_rain (3003), start_thunder (3002) / stop_thunder (3004); `data` is the
//   target level × 65535 (BDS: 65535 / 0; `/weather thunder` sends start_rain + start_thunder). Bedrock clients fade
//   the level themselves; rainState / thunderState are the target level (Java: the server sends the fading levels).
'use strict'

module.exports = inject

const LEVEL_SCALE = 65535

function inject (bot) {
  bot.isRaining = false
  bot.thunderState = 0
  bot.rainState = 0

  function setRaining (isRaining) {
    if (bot.isRaining === isRaining) return
    bot.isRaining = isRaining
    bot.emit('rain')
  }

  function setRainLevel (level) {
    bot.rainState = level
    bot.emit('weatherUpdate')
  }

  function setThunderLevel (level) {
    bot.thunderState = level
    bot.emit('weatherUpdate')
  }

  const levelOf = (data) => Math.max(0, Math.min(1, (Number(data) || 0) / LEVEL_SCALE))

  bot._client.on('start_game', (packet) => {
    const rain = Math.max(0, Number(packet.rain_level) || 0)
    const thunder = Math.max(0, Number(packet.lightning_level) || 0)
    if (rain > 0) {
      setRaining(true)
      setRainLevel(rain)
      setThunderLevel(thunder)
    } else {
      setRaining(false)
      bot.rainState = 0
      bot.thunderState = thunder
    }
  })

  bot._client.on('level_event', (packet) => {
    switch (packet.event) {
      case 'start_rain':
        setRaining(true)
        setRainLevel(levelOf(packet.data) || 1)
        break
      case 'stop_rain':
        setRaining(false)
        setRainLevel(0)
        break
      case 'start_thunder':
        setThunderLevel(levelOf(packet.data) || 1)
        break
      case 'stop_thunder':
        setThunderLevel(0)
        break
    }
  })
}
