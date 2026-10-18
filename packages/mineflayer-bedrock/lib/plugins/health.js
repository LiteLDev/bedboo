// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/health.js
// Surface: bot.isAlive, bot.health, bot.food, bot.foodSaturation (upstream: undefined until the first
//   update_health; typed defaults here), bot.respawn()
//   options: respawn (auto-respawn, default true)
// Events: 'health', 'death', 'respawn' — NEVER 'spawn' (only lib/bedrock/lifecycle.js emits it)
// Bedrock: set_health, update_attributes (minecraft:health, minecraft:player.hunger,
//   minecraft:player.saturation), 3-step respawn (respawn state 0 → client respawn state 2 →
//   respawn state 1 → player_action respawn) then lifecycle.markSpawned('respawn').
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot, options) {
  bot.isAlive = true
  bot.health = 20
  bot.food = 20
  bot.foodSaturation = 5
  bot.respawn = stubSync('U9', 'bot.respawn', 0)
}
