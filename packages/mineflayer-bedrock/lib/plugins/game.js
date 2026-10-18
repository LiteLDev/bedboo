// owner: U4 (wave 2) → U9 (wave 3)
// Upstream: mineflayer 4.39.0 lib/plugins/game.js
// Surface: bot.game { levelType, hardcore, gameMode, dimension, minY, height, difficulty,
//   maxPlayers, enableRespawnScreen?, serverViewDistance?, serverBrand }
// Events: 'login' (start_game), 'game' (start_game, gamemode/difficulty/dimension changes).
// Bedrock: start_game, set_player_game_type / update_player_game_type, set_difficulty,
//   change_dimension (U9), game_rules_changed (U9). No brand channel (serverBrand stays undefined).
'use strict'

module.exports = inject

function inject (bot, options) {
  bot.game = {}
}
