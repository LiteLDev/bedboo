// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/spawn_point.js (MIT, Copyright (c) 2013 Andrew Kelley)
// Surface: bot.spawnPoint (Vec3): the world spawn ("where all compasses point to")
// Events: 'game' (when the spawn point is received or changes, like upstream)
// Bedrock (docs/differences/U9.md#spawn-point):
// - start_game.spawn_position: the world spawn at join (y = 32767 when the server has not fixed the height yet: it
//   searches the highest safe block when a player spawns there).
// - set_spawn_position { spawn_type: 'world', player_position } (/setworldspawn) → the new world spawn.
//   spawn_type 'player' is the player's own respawn point (bed, respawn anchor, /spawnpoint; coordinates
//   -2147483648 = none), which Java never sends to the client: it does not change bot.spawnPoint.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

const UNSET = -2147483648

function inject (bot) {
  bot.spawnPoint = new Vec3(0, 0, 0)

  function setSpawnPoint (pos) {
    if (!pos || pos.x === UNSET) return false
    bot.spawnPoint = new Vec3(pos.x, pos.y, pos.z)
    return true
  }

  // Java sends the spawn position right after the login ('game' again): same order here (after game.js' 'game')
  bot._client.on('start_game', (packet) => {
    if (setSpawnPoint(packet.spawn_position)) bot.emit('game')
  })

  bot._client.on('set_spawn_position', (packet) => {
    if (packet.spawn_type !== 'world' && packet.spawn_type !== 1) return
    if (setSpawnPoint(packet.player_position)) bot.emit('game')
  })
}
