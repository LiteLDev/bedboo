// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/sound.js
// Surface: none (events only)
// Events: 'soundEffectHeard' (soundName, position, volume, pitch),
//   'hardcodedSoundEffectHeard' (soundId, soundCategory, position, volume, pitch)
// Bedrock: play_sound (named) → soundEffectHeard; level_sound_event (numeric) →
//   hardcodedSoundEffectHeard (+ soundEffectHeard with the bedrock-data sound name).
'use strict'

module.exports = inject

function inject (bot) {}
