// owner: U4 (core runtime)
// Upstream: mineflayer 4.39.0 lib/plugins/settings.js (MIT, Copyright (c) 2013 Andrew Kelley) — same
//   settings object, defaults, validation and error messages.
// Surface: bot.settings {chat, colorsEnabled, viewDistance, difficulty, skinParts, mainHand,
//   enableTextFiltering, enableServerListing, particleStatus}, bot.setSettings(options)
//   options: chat, colorsEnabled, viewDistance, difficulty, skinParts, mainHand, enableTextFiltering,
//   enableServerListing
// Bedrock: only viewDistance has a wire effect: request_chunk_radius { chunk_radius, max_radius } in chunks
//   ('far' 12, 'normal' 10, 'short' 8, 'tiny' 6, or a number). The join request is bedrock-protocol's (it reads
//   `client.viewDistance`, kept in sync here); later setSettings calls send their own request. The server
//   answers with chunk_radius_update (→ bot.game.serverViewDistance). Other settings are kept locally
//   (docs/differences/U4.md#settings).
'use strict'
const assert = require('assert')

module.exports = inject

const chatToBits = {
  enabled: 0,
  commandsOnly: 1,
  disabled: 2
}

const handToBits = {
  left: 0,
  right: 1
}

const viewDistanceToBits = {
  far: 12,
  normal: 10,
  short: 8,
  tiny: 6
}

function inject (bot, options) {
  let loggedIn = false

  function setSettings (settings) {
    extend(bot.settings, settings)

    // chat
    const chatBits = chatToBits[bot.settings.chat]
    assert.ok(chatBits != null, `invalid chat setting: ${bot.settings.chat}`)

    // view distance
    let viewDistanceBits = null
    if (typeof bot.settings.viewDistance === 'string') {
      viewDistanceBits = viewDistanceToBits[bot.settings.viewDistance]
    } else if (typeof bot.settings.viewDistance === 'number' && bot.settings.viewDistance > 0) { // Make sure view distance is a valid # || should be 2 or more
      viewDistanceBits = bot.settings.viewDistance
    }
    assert.ok(viewDistanceBits != null, `invalid view distance setting: ${bot.settings.viewDistance}`)

    // hand
    const handBits = handToBits[bot.settings.mainHand]
    assert.ok(handBits != null, `invalid main hand: ${bot.settings.mainHand}`)

    // bedrock-protocol sends the join request_chunk_radius from client.viewDistance
    bot._client.viewDistance = viewDistanceBits
    if (loggedIn) {
      bot._client.queue('request_chunk_radius', { chunk_radius: viewDistanceBits, max_radius: Math.min(viewDistanceBits, 255) })
    }
  }

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

  // upstream sends its settings on login; here the join radius request is bedrock-protocol's (500 ms after the
  // resource packs), so only client.viewDistance is set now
  try {
    setSettings({})
  } catch (err) {
    bot.emit('error', err)
  }
  bot._client.on('start_game', () => { loggedIn = true })

  bot.setSettings = setSettings
}

const hasOwn = {}.hasOwnProperty
function extend (obj, src) {
  for (const key in src) {
    if (hasOwn.call(src, key)) obj[key] = src[key]
  }
  return obj
}
