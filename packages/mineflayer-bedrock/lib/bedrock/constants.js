// owner: U4 (core runtime)
'use strict'

/**
 * Shared Bedrock constants. Pure data — safe to require from anywhere.
 *
 * Coordinate contract: `bot.entity.position` is the FEET position (as in mineflayer). Every
 * position on the wire for the local player (start_game.player_position, move_player,
 * player_auth_input.position, respawn.position, correct_player_move_prediction.position) is at
 * EYE level: `wire.y = feet.y + EYE_HEIGHT`. Convert only with {@link toWireY}/{@link fromWireY}.
 */

/** Bedrock version string used for bedrock-protocol and minecraft-data (`bedrock_<VERSION>`). */
const VERSION = '1.26.51'
/** Network protocol number of {@link VERSION}. */
const PROTOCOL_VERSION = 2193
/** The BDS build we test against. */
const BDS_VERSION = '1.26.51.1'

/** Player eye height above the feet (standing). Wire positions of the local player are at eye level. */
const EYE_HEIGHT = 1.62
/** Player bounding box. */
const PLAYER_HEIGHT = 1.8
const PLAYER_WIDTH = 0.6
/** Sneaking bounding box / eye height (Bedrock values; U5 verifies). */
const SNEAK_HEIGHT = 1.5
const SNEAK_EYE_HEIGHT = 1.27

/** One server tick. */
const TICK_MS = 50
const TICKS_PER_SECOND = 20

/** Bedrock dimension ids (start_game/change_dimension `dimension`) → mineflayer names. */
const DIMENSION_NAMES = { 0: 'overworld', 1: 'the_nether', 2: 'the_end' }
/** mineflayer dimension name → Bedrock dimension id. */
const DIMENSION_IDS = { overworld: 0, the_nether: 1, the_end: 2 }
/** World height data per dimension (blocks). */
const DIMENSION_HEIGHTS = {
  overworld: { minY: -64, height: 384 },
  the_nether: { minY: 0, height: 128 },
  the_end: { minY: 0, height: 256 }
}

/** Bedrock gamemode values (start_game.player_gamemode, set_player_game_type). */
const GAME_MODES = ['survival', 'creative', 'adventure', 'survival_spectator', 'creative_spectator', 'fallback', 'spectator']
/** Difficulty ids. */
const DIFFICULTY_NAMES = ['peaceful', 'easy', 'normal', 'hard']

/** @param {number} feetY @returns {number} eye-level wire y */
const toWireY = (feetY) => feetY + EYE_HEIGHT
/** @param {number} wireY eye-level wire y @returns {number} feet y */
const fromWireY = (wireY) => wireY - EYE_HEIGHT

module.exports = {
  VERSION,
  PROTOCOL_VERSION,
  BDS_VERSION,
  EYE_HEIGHT,
  PLAYER_HEIGHT,
  PLAYER_WIDTH,
  SNEAK_HEIGHT,
  SNEAK_EYE_HEIGHT,
  TICK_MS,
  TICKS_PER_SECOND,
  DIMENSION_NAMES,
  DIMENSION_IDS,
  DIMENSION_HEIGHTS,
  GAME_MODES,
  DIFFICULTY_NAMES,
  toWireY,
  fromWireY
}
