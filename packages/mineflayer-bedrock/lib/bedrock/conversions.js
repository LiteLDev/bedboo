// owner: U4 (core runtime)
'use strict'
const { Vec3 } = require('vec3')
const conv = require('mineflayer/lib/conversions')
const { EYE_HEIGHT } = require('./constants')

/**
 * Angle and vector conversions between mineflayer and the Bedrock wire format.
 *
 * Bedrock yaw/pitch on the wire are degrees with the same convention as Java "notchian" angles,
 * so mineflayer's `lib/conversions` helpers apply unchanged:
 *   wire yaw   = conv.toNotchianYaw(bot.entity.yaw),   bot.entity.yaw   = conv.fromNotchianYaw(wire)
 *   wire pitch = conv.toNotchianPitch(bot.entity.pitch), bot.entity.pitch = conv.fromNotchianPitch(wire)
 * mineflayer yaw/pitch are radians (yaw 0 = facing -z/north, increasing counter-clockwise).
 */

/** @param {number} yaw mineflayer radians @returns {number} Bedrock degrees */
const toBedrockYaw = (yaw) => conv.toNotchianYaw(yaw)
/** @param {number} pitch mineflayer radians @returns {number} Bedrock degrees */
const toBedrockPitch = (pitch) => conv.toNotchianPitch(pitch)
/** @param {number} yaw Bedrock degrees @returns {number} mineflayer radians */
const fromBedrockYaw = (yaw) => conv.fromNotchianYaw(yaw)
/** @param {number} pitch Bedrock degrees @returns {number} mineflayer radians */
const fromBedrockPitch = (pitch) => conv.fromNotchianPitch(pitch)

/** @param {{x:number,y:number,z:number}} v wire vec3f/BlockCoordinates @returns {Vec3} */
const vec3FromWire = (v) => new Vec3(Number(v.x), Number(v.y), Number(v.z))
/** @param {Vec3} v @returns {{x:number,y:number,z:number}} plain object for the serializer */
const vec3ToWire = (v) => ({ x: v.x, y: v.y, z: v.z })

/** Local player eye-level wire position → feet Vec3. */
const feetFromWire = (v) => new Vec3(v.x, v.y - EYE_HEIGHT, v.z)
/** Feet Vec3 → local player eye-level wire position (`{x,y,z}`, float32 rounding left to the serializer). */
const feetToWire = (v) => ({ x: v.x, y: v.y + EYE_HEIGHT, z: v.z })

/**
 * mineflayer block face numbers (0 bottom, 1 top, 2 north, 3 south, 4 west, 5 east) are identical
 * to Bedrock `face` values in player_action / inventory_transaction / auth-input block actions.
 */
const BLOCK_FACES = { BOTTOM: 0, TOP: 1, NORTH: 2, SOUTH: 3, WEST: 4, EAST: 5 }
/** Unit offset of each block face (index = face number). */
const FACE_VECTORS = Object.freeze([
  new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)
])

/**
 * Unit view direction for mineflayer yaw/pitch (radians), as mineflayer's ray_trace computes it. Used for
 * player_auth_input.camera_orientation.
 * @returns {{x:number,y:number,z:number}}
 */
function viewDirection (yaw, pitch) {
  const cosPitch = Math.cos(pitch)
  return { x: -Math.sin(yaw) * cosPitch, y: Math.sin(pitch), z: -Math.cos(yaw) * cosPitch }
}

module.exports = {
  ...conv,
  toBedrockYaw,
  toBedrockPitch,
  fromBedrockYaw,
  fromBedrockPitch,
  vec3FromWire,
  vec3ToWire,
  feetFromWire,
  feetToWire,
  BLOCK_FACES,
  FACE_VECTORS,
  viewDirection
}
