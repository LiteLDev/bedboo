// owner: U4 (core runtime)
// Upstream: mineflayer 4.39.0 lib/plugins/settings.js
// Surface: bot.settings {chat, colorsEnabled, viewDistance, difficulty, skinParts, mainHand,
//   enableTextFiltering, enableServerListing, particleStatus}, bot.setSettings(options)
//   options: chat, colorsEnabled, viewDistance, difficulty, skinParts, mainHand, enableTextFiltering,
//   enableServerListing
// Bedrock: only viewDistance has a wire effect (request_chunk_radius; 'far' 12, 'normal' 10,
//   'short' 8, 'tiny' 6 chunks). Other settings are kept locally (documented difference).
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot, options) {
  bot.settings = {
    chat: options.chat || 'enabled',
    colorsEnabled: options.colorsEnabled == null ? true : options.colorsEnabled,
    viewDistance: options.viewDistance || 'far',
    difficulty: options.difficulty == null ? 2 : options.difficulty,
    skinParts: options.skinParts == null
      ? {
          showCape: true,
          showJacket: true,
          showLeftSleeve: true,
          showRightSleeve: true,
          showLeftPants: true,
          showRightPants: true,
          showHat: true
        }
      : options.skinParts,
    mainHand: options.mainHand || 'right',
    enableTextFiltering: options.enableTextFiltering || false,
    enableServerListing: options.enableServerListing ?? true, // upstream `|| true` could never be false
    particleStatus: 'all'
  }

  bot.setSettings = stubSync('U4', 'bot.setSettings', 1)
}
