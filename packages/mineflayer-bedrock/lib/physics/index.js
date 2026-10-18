// owner: U5 (physics & movement)
'use strict'
/**
 * In-repo Bedrock physics engine (prismarine-physics 1.11.1 fork, see engine.js), with the upstream module shape
 * mineflayer-pathfinder relies on:
 *   const { Physics, PlayerState } = require('mineflayer-bedrock/lib/physics')
 *   const physics = Physics(registry, world)        // world: { getBlock(pos) }
 *   physics.simulatePlayer(new PlayerState(bot, controls), world).apply(bot)
 * `bot.physics` (physics.js plugin) is the object returned by `Physics()`: the 31 upstream field names with
 * Bedrock values (`defaultPhysicsFields()`), `simulatePlayer(state, world)` and `adjustPositionHeight(pos)`.
 * `simulatePlayer` also accepts prismarine-physics' own PlayerState objects (what pathfinder builds).
 */
const { Physics, PlayerState, defaultPhysicsFields, BEDROCK } = require('./engine')

module.exports = { Physics, PlayerState, defaultPhysicsFields, BEDROCK }
