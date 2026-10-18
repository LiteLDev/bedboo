// owner: U4 (wave 2, stationary stub with the full surface) → U5 (wave 3, Bedrock engine)
// Upstream: mineflayer 4.39.0 lib/plugins/physics.js
// Surface: bot.physics (Physics() object: default fields + simulatePlayer), bot.physicsEnabled
//   (options.physicsEnabled ?? true), bot.jumpQueued, bot.jumpTicks, bot.controlState
//   {forward, back, left, right, jump, sprint, sneak} (getters/setters → setControlState),
//   bot.setControlState(control, state), bot.getControlState(control), bot.clearControlStates(),
//   bot.look(yaw, pitch, force), bot.lookAt(point, force), bot.waitForTicks(ticks), bot.elytraFly()
//   options: physicsEnabled, maxCatchupTicks
// Events: 'physicsTick' + deprecated 'physicTick' (every tick), 'move' (oldPos), 'forcedMove'
// Bedrock: player_auth_input every server tick via bot._bedrock.input (eye-level wire positions),
//   move_player (teleport → handled_teleport), correct_player_move_prediction (rewind + replay).
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')
const { Physics } = require('../physics')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

module.exports = inject

function inject (bot, { physicsEnabled }) {
  const world = { getBlock: (pos) => bot.blockAt(pos, false) }
  bot.physics = Physics(bot.registry, world)
  bot.physicsEnabled = physicsEnabled ?? true
  bot.jumpQueued = false
  bot.jumpTicks = 0

  bot.setControlState = stubSync('U4', 'bot.setControlState', 2)
  bot.getControlState = stubSync('U4', 'bot.getControlState', 1)
  bot.clearControlStates = stubSync('U4', 'bot.clearControlStates', 0)

  // Same shape as upstream: accessors that delegate to get/setControlState.
  bot.controlState = {}
  for (const control of CONTROLS) {
    Object.defineProperty(bot.controlState, control, {
      get () { return bot.getControlState(control) },
      set (state) { bot.setControlState(control, state) }
    })
  }

  bot.look = stubAsync('U4', 'bot.look', 3)
  bot.lookAt = stubAsync('U4', 'bot.lookAt', 2)
  bot.waitForTicks = stubAsync('U4', 'bot.waitForTicks', 1)
  bot.elytraFly = stubAsync('U5', 'bot.elytraFly', 0)
}
