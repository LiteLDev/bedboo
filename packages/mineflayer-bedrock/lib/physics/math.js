// owner: U5 (physics & movement)
'use strict'
/**
 * Bedrock math helpers. The game simulates movement in single precision (float32): the engine rounds positions and
 * velocities to float32 at every step. Unlike Java (65536-entry Mth.sin table), BDS 1.26.51 takes the precise
 * sine/cosine of the yaw — measured: a diagonal walk only matches the server exactly with precise trigonometry.
 */

const f32 = Math.fround

/** float32 sine of an angle in radians */
function sin (rad) {
  return f32(Math.sin(f32(rad)))
}

/** float32 cosine of an angle in radians */
function cos (rad) {
  return f32(Math.cos(f32(rad)))
}

function clamp (min, x, max) {
  return Math.max(min, Math.min(x, max))
}

module.exports = { f32, sin, cos, clamp }
