// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/experience.js (MIT, Copyright (c) 2013 Andrew Kelley)
// Surface: bot.experience { level, points, progress } (null until the first update)
// Events: 'experience' (once per update carrying the level or the progress)
// Bedrock: update_attributes of the local player: `minecraft:player.level` (level) and `minecraft:player.experience`
//   (progress 0..1). Bedrock sends no total: points = the XP needed for `level` + progress × the XP of the next
//   level, with the XP curve Bedrock shares with Java (docs/differences/U9.md#experience-points).
'use strict'

module.exports = inject

/** total experience needed to reach `level` (minecraft.wiki "Experience", identical on Bedrock) */
function xpForLevel (level) {
  if (level <= 16) return level * level + 6 * level
  if (level <= 31) return 2.5 * level * level - 40.5 * level + 360
  return 4.5 * level * level - 162.5 * level + 2220
}

/** experience from `level` to `level + 1` */
function xpToNextLevel (level) {
  if (level <= 15) return 2 * level + 7
  if (level <= 30) return 5 * level - 38
  return 9 * level - 158
}

/** total points from a level and the bar progress (0..1) */
function totalPoints (level, progress) {
  return Math.round(xpForLevel(level) + Math.max(0, Math.min(1, progress)) * xpToNextLevel(level))
}

function inject (bot) {
  bot.experience = {
    level: null,
    points: null,
    progress: null
  }

  bot._client.on('update_attributes', (packet) => {
    if (!bot._bedrock?.ids?.isSelf(packet.runtime_entity_id)) return
    let level
    let progress
    for (const attr of packet.attributes ?? []) {
      if (attr.name === 'minecraft:player.level') level = attr.current
      else if (attr.name === 'minecraft:player.experience') progress = attr.current
    }
    if (level === undefined && progress === undefined) return
    if (level !== undefined) bot.experience.level = Math.round(level)
    if (progress !== undefined) bot.experience.progress = progress
    bot.experience.level ??= 0
    bot.experience.progress ??= 0
    bot.experience.points = totalPoints(bot.experience.level, bot.experience.progress)
    bot.emit('experience')
  })
}

module.exports.xpForLevel = xpForLevel
module.exports.xpToNextLevel = xpToNextLevel
module.exports.totalPoints = totalPoints
