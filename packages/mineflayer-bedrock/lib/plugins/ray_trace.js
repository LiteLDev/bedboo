// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/ray_trace.js (reusable as-is once blockAt/entities work;
//   vendor it with MIT attribution — never `pnpm patch mineflayer`)
// Surface: bot.blockInSight(maxSteps = 256, vectorLength = 5 / 16), bot.blockAtCursor(maxDistance = 256,
//   matcher = null), bot.entityAtCursor(maxDistance = 3.5), bot.blockAtEntityCursor(entity = bot.entity,
//   maxDistance = 256, matcher = null)
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.blockInSight = stubSync('U9', 'bot.blockInSight', 0)
  bot.blockAtCursor = stubSync('U9', 'bot.blockAtCursor', 0)
  bot.entityAtCursor = stubSync('U9', 'bot.entityAtCursor', 0)
  bot.blockAtEntityCursor = stubSync('U9', 'bot.blockAtEntityCursor', 0)
}
