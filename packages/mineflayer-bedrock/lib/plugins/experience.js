// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/experience.js
// Surface: bot.experience { level, points, progress } (null until the first update)
// Events: 'experience'
// Bedrock: update_attributes minecraft:player.level / minecraft:player.experience (progress 0..1);
//   total points derived from level + progress with the Bedrock XP curve.
'use strict'

module.exports = inject

function inject (bot) {
  bot.experience = {
    level: null,
    points: null,
    progress: null
  }
}
