// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/spawn_point.js
// Surface: bot.spawnPoint (Vec3)
// Events: 'game' (on spawn point change)
// Bedrock: set_spawn_position {spawn_type: player|world, player_position, dimension, world_position},
//   start_game spawn_position.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  bot.spawnPoint = new Vec3(0, 0, 0)
}
