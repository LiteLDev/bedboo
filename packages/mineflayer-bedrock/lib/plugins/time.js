// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/time.js
// Surface: bot.time { doDaylightCycle, bigTime, time, timeOfDay, day, isDay, moonPhase, bigAge, age,
//   clocks } (null until the first update)
// Events: 'time'
// Bedrock: BDS 1.26.51 sends NO set_time packet (not even for /time set): world time comes from
//   `sync_world_clocks` (and start_game `current_tick`/day cycle gamerule `dodaylightcycle`) — see the
//   U0 fixture test/fixtures/1.26.51/join_flat.jsonl.gz.
'use strict'

module.exports = inject

function inject (bot) {
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null,
    clocks: {}
  }
}
