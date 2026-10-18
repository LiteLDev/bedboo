// owner: U5 (physics & movement)
'use strict'
const { NotImplementedError, stubSync } = require('../bedrock/errors')

/**
 * In-repo Bedrock physics engine (placeholder).
 *
 * U5 forks prismarine-physics (MIT, keep its header + attribution) into this directory as a
 * Bedrock engine, keeping the upstream module shape because mineflayer-pathfinder uses both:
 *   const { Physics, PlayerState } = require('mineflayer-bedrock/lib/physics')
 *   const physics = Physics(registry, world)        // world: { getBlock(pos) }
 *   physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
 * `bot.physics` (physics.js plugin) is the object returned by `Physics()`; its fields keep the
 * upstream names (gravity, airdrag, yawSpeed, pitchSpeed, playerSpeed, sprintSpeed, sneakSpeed,
 * stepHeight, …) with Bedrock values.
 *
 * U0 placeholder: `Physics()` returns prismarine-physics' default (Java) field values and stub
 * `simulatePlayer` / `adjustPositionHeight`; `PlayerState` throws.
 */

/** Upstream prismarine-physics 1.11.1 default fields (Java values); U5 replaces with Bedrock values. */
function defaultPhysicsFields () {
  return {
    gravity: 0.08,
    airdrag: Math.fround(1 - 0.02),
    yawSpeed: 3.0,
    pitchSpeed: 3.0,
    playerSpeed: 0.1,
    sprintSpeed: 0.3,
    sneakSpeed: 0.3,
    stepHeight: 0.6,
    negligeableVelocity: 0.003,
    soulsandSpeed: 0.4,
    honeyblockSpeed: 0.4,
    honeyblockJumpSpeed: 0.4,
    ladderMaxSpeed: 0.15,
    ladderClimbSpeed: 0.2,
    playerHalfWidth: 0.3,
    playerHeight: 1.8,
    waterInertia: 0.8,
    lavaInertia: 0.5,
    liquidAcceleration: 0.02,
    airborneInertia: 0.91,
    airborneAcceleration: 0.02,
    defaultSlipperiness: 0.6,
    outOfLiquidImpulse: 0.3,
    autojumpCooldown: 10,
    bubbleColumnSurfaceDrag: { down: 0.03, maxDown: -0.9, up: 0.1, maxUp: 1.8 },
    bubbleColumnDrag: { down: 0.03, maxDown: -0.3, up: 0.06, maxUp: 0.7 },
    slowFalling: 0.125,
    movementSpeedAttribute: 'minecraft:movement_speed',
    sprintingUUID: '662a6b8d-da3e-4c1c-8813-96ea6097278d',
    waterGravity: 0.005,
    lavaGravity: 0.02
  }
}

/**
 * @param {object} registry prismarine-registry instance
 * @param {{ getBlock(pos): object|null }} world
 */
function Physics (registry, world) {
  return {
    ...defaultPhysicsFields(),
    adjustPositionHeight: stubSync('U5', 'bot.physics.adjustPositionHeight', 1),
    simulatePlayer: stubSync('U5', 'bot.physics.simulatePlayer', 2)
  }
}

class PlayerState {
  constructor (bot, control) {
    throw new NotImplementedError('U5', 'PlayerState')
  }
}
PlayerState.notImplemented = true

module.exports = { Physics, PlayerState, defaultPhysicsFields }
