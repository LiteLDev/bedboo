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

/**
 * Wire dimension → mineflayer name. bedrock-protocol maps start_game.dimension to a string
 * ('overworld' | 'nether' | 'end'); change_dimension, level_chunk, subchunk(_request) carry the id.
 */
const DIMENSION_WIRE_NAMES = { overworld: 'overworld', nether: 'the_nether', end: 'the_end', the_nether: 'the_nether', the_end: 'the_end' }

/** Bedrock gamemode values (start_game.player_gamemode, set_player_game_type). */
const GAME_MODES = ['survival', 'creative', 'adventure', 'survival_spectator', 'creative_spectator', 'fallback', 'spectator']
/** Bedrock gamemode name → mineflayer `bot.game.gameMode` ('survival' | 'creative' | 'adventure' | 'spectator'). */
const GAME_MODE_NAMES = {
  survival: 'survival',
  creative: 'creative',
  adventure: 'adventure',
  survival_spectator: 'spectator',
  creative_spectator: 'spectator',
  spectator: 'spectator'
}
/** Difficulty ids. */
const DIFFICULTY_NAMES = ['peaceful', 'easy', 'normal', 'hard']

/** @param {number} feetY @returns {number} eye-level wire y */
const toWireY = (feetY) => feetY + EYE_HEIGHT
/** @param {number} wireY eye-level wire y @returns {number} feet y */
const fromWireY = (wireY) => wireY - EYE_HEIGHT

/**
 * @param {string|number|bigint} dimension wire dimension (start_game string or numeric id)
 * @returns {'overworld'|'the_nether'|'the_end'} mineflayer dimension name (unknown ids → 'overworld')
 */
function dimensionName (dimension) {
  if (typeof dimension === 'string') return DIMENSION_WIRE_NAMES[dimension.replace(/^minecraft:/, '')] ?? 'overworld'
  return DIMENSION_NAMES[Number(dimension)] ?? 'overworld'
}

/**
 * @param {string|number} dimension mineflayer name or wire value
 * @returns {number} Bedrock dimension id (0 overworld, 1 nether, 2 end)
 */
function dimensionId (dimension) {
  if (typeof dimension === 'number') return dimension
  return DIMENSION_IDS[dimensionName(dimension)]
}

/**
 * Sub-chunk index range of a dimension (what a client requests with subchunk_request).
 * @param {string|number} dimension
 * @returns {{ min: number, max: number }} inclusive sub-chunk indexes (overworld -4..19, nether 0..7, end 0..15)
 */
function subChunkRange (dimension) {
  const { minY, height } = DIMENSION_HEIGHTS[dimensionName(dimension)]
  return { min: minY >> 4, max: ((minY + height) >> 4) - 1 }
}

/**
 * @param {string} mode Bedrock gamemode name (or 'fallback')
 * @param {string} [worldMode] start_game.world_gamemode, used for 'fallback'
 * @returns {string} mineflayer game mode
 */
function gameModeName (mode, worldMode) {
  if (mode === 'fallback' || mode === undefined) mode = worldMode
  if (typeof mode === 'number') mode = GAME_MODES[mode]
  return GAME_MODE_NAMES[mode] ?? 'survival'
}

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
  DIMENSION_WIRE_NAMES,
  GAME_MODES,
  GAME_MODE_NAMES,
  DIFFICULTY_NAMES,
  toWireY,
  fromWireY,
  dimensionName,
  dimensionId,
  subChunkRange,
  gameModeName
}
