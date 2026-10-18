// owner: U6 (chat, commands & HUD)
// Adapted from mineflayer 4.39.0 lib/plugins/particle.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer).
// Surface: none (events only)
// Events: 'particle' (Particle)
// Bedrock (BDS 1.26.51.1, docs/differences/U6.md#particles): spawn_particle_effect (`/particle <effect> [x y z]`,
//   scripts) and level_event `add_particle_*` (particles the game spawns) → 'particle' with the Bedrock-adapted
//   Particle (lib/bedrock/particle.js): id/name + position; no offset/count/speed on Bedrock.
'use strict'

module.exports = inject

function inject (bot) {
  const Particle = require('../bedrock/particle')(bot.registry)

  bot._client.on('spawn_particle_effect', (packet) => {
    bot.emit('particle', Particle.fromNetwork(packet))
  })

  bot._client.on('level_event', (packet) => {
    const particle = Particle.fromNetwork(packet)
    if (particle) bot.emit('particle', particle)
  })
}
