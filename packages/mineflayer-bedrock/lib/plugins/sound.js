// owner: U6 (chat, commands & HUD)
// Adapted from mineflayer 4.39.0 lib/plugins/sound.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer).
// Surface: none (events only)
// Events: 'soundEffectHeard' (soundName, position, volume, pitch),
//   'hardcodedSoundEffectHeard' (soundId, soundCategory, position, volume, pitch)
// Bedrock (BDS 1.26.51.1, docs/differences/U6.md#sounds):
//   play_sound { name, coordinates (block position × 8, like Java's x/y/z), volume, pitch } — `/playsound`, scripts —
//     → 'soundEffectHeard'(name, position / 8, volume, pitch). Names are Bedrock sound definitions ('note.harp',
//     'random.click'); BDS forwards any name.
//   level_sound_event { sound_id, position, extra_data, entity_type, … } — the game's own sounds (steps, mobs,
//     blocks, item use) — → 'soundEffectHeard'(name, position, 1, pitch) with the level sound event name
//     ('armor.equip_iron', registry.sounds); an id bedrock-protocol / the registry cannot name →
//     'hardcodedSoundEffectHeard'(id, 'master', position, 1, pitch). Bedrock sends no volume (1) and no pitch
//     except for note blocks ('note': extra_data low byte = note 0..24 → Java's 2^((note-12)/12)), else 1.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

function inject (bot) {
  bot._client.on('play_sound', (packet) => {
    const c = packet.coordinates ?? { x: 0, y: 0, z: 0 }
    const pt = new Vec3(c.x / 8, c.y / 8, c.z / 8)
    bot.emit('soundEffectHeard', packet.name, pt, packet.volume, packet.pitch)
  })

  bot._client.on('level_sound_event', (packet) => {
    const p = packet.position ?? { x: 0, y: 0, z: 0 }
    const pt = new Vec3(p.x, p.y, p.z)
    const id = packet.sound_id
    let soundName
    let soundId
    if (typeof id === 'string') {
      soundName = id
    } else {
      soundId = id
      soundName = bot.registry?.sounds?.[id]?.name
    }
    const pitch = soundName === 'note' && typeof packet.extra_data === 'number' && packet.extra_data >= 0
      ? Math.pow(2, ((packet.extra_data & 0xff) - 12) / 12)
      : 1
    if (soundName) {
      bot.emit('soundEffectHeard', soundName, pt, 1, pitch)
    } else if (soundId !== null && soundId !== undefined) {
      bot.emit('hardcodedSoundEffectHeard', soundId, 'master', pt, 1, pitch)
    }
  })
}
