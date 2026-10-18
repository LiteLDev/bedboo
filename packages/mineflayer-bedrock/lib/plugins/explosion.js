// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/explosion.js (reusable as-is; needs entity attributes
//   `generic.armor` / `armor_toughness`, which U7 synthesizes from equipment)
// Surface: bot.getExplosionDamages(targetEntity, sourcePos, power, rawDamages = false) → number | null
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.getExplosionDamages = stubSync('U9', 'bot.getExplosionDamages', 3)
}
