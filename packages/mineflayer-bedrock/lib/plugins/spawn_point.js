// owner: U9 (player state, world extras & dimensions); U17 minimal fix: the spawn search height is resolved;
//   POLISH-LIB: no 'game' for the join's resolution (before the first spawn)
// Adapted from mineflayer 4.39.0 lib/plugins/spawn_point.js (MIT, Copyright (c) 2013 Andrew Kelley)
// Surface: bot.spawnPoint (Vec3): the world spawn ("where all compasses point to")
// Events: 'game' (when the spawn point changes, like upstream)
// Bedrock (docs/differences/U9.md#spawn-point):
// - start_game.spawn_position: the world spawn at join (y = 32767 when the server has not fixed the height yet: it
//   searches the highest safe block when a player spawns there). U17 (docs/differences/U17.md#spawn-height): that y is
//   replaced by the height of the spawn column (highest solid block + 1) as soon as the column is loaded in the
//   overworld, so bot.spawnPoint is a real position like on Java.
// - set_spawn_position { spawn_type: 'world', player_position } (/setworldspawn) → the new world spawn.
//   spawn_type 'player' is the player's own respawn point (bed, respawn anchor, /spawnpoint; coordinates
//   -2147483648 = none), which Java never sends to the client: it does not change bot.spawnPoint.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

const UNSET = -2147483648
/** BDS's "not decided yet" spawn heights (32767 / 32768; lifecycle.js uses the same bound) */
const SEARCH_Y = 32766

function inject (bot) {
  bot.spawnPoint = new Vec3(0, 0, 0)

  function setSpawnPoint (pos) {
    if (!pos || pos.x === UNSET) return false
    bot.spawnPoint = new Vec3(pos.x, pos.y, pos.z)
    resolveHeight(false) // the caller emits 'game' for this change
    return true
  }

  /** y 32767 → highest solid block + 1 of the spawn column, once that overworld column is loaded */
  function resolveHeight (emit = true) {
    const sp = bot.spawnPoint
    if (sp.y < SEARCH_Y || bot.game?.dimension !== 'overworld' || typeof bot.blockAt !== 'function') return
    const minY = bot.game.minY ?? -64
    const top = minY + (bot.game.height ?? 384) - 1
    const x = Math.floor(sp.x)
    const z = Math.floor(sp.z)
    if (!bot.blockAt(new Vec3(x, minY, z))) return // column not loaded yet
    for (let y = top; y >= minY; y--) {
      const b = bot.blockAt(new Vec3(x, y, z))
      if (!b) continue
      // the ground: a solid block that is not foliage, or the surface of water / lava
      if ((b.boundingBox === 'block' && !/leaves/.test(b.name)) || /water|lava/.test(b.name)) {
        bot.spawnPoint = new Vec3(sp.x, y + 1, sp.z)
        if (emit) bot.emit('game') // like upstream on every spawn point change
        return
      }
    }
  }

  // the spawn column usually loads before the join's 'spawn': that resolution is part of start_game's spawn position,
  // covered by the login's 'game' (mineflayer order connect → login → game → spawn, test coreJoin); later ones (a
  // respawn, a dimension change back) emit 'game' (POLISH-LIB)
  let spawned = false
  bot.on('chunkColumnLoad', (pos) => {
    if (bot.spawnPoint.y < SEARCH_Y) return
    if (Math.floor(bot.spawnPoint.x / 16) * 16 === pos.x && Math.floor(bot.spawnPoint.z / 16) * 16 === pos.z) resolveHeight(spawned)
  })
  bot.on('spawn', () => {
    spawned = true
    resolveHeight()
  })

  // part of start_game: covered by game.js' 'game' of the login (set right after it, like Java's spawn_position)
  bot._client.on('start_game', (packet) => {
    spawned = false
    setSpawnPoint(packet.spawn_position)
  })

  bot._client.on('set_spawn_position', (packet) => {
    if (packet.spawn_type !== 'world' && packet.spawn_type !== 1) return
    if (setSpawnPoint(packet.player_position)) bot.emit('game')
  })
}
