// owner: U5 (physics & movement)
'use strict'
/**
 * player_auth_input movement fields and edge flags from mineflayer control states.
 *
 * Bedrock reports the WASD state as a move vector (x = left − right, z = forward − back; ±1 on a keyboard) plus
 * `input_data` flags. Level flags are sent every tick while the state holds, edge flags (`start_*`, `stop_*`,
 * `*_pressed_raw`, `*_released_raw`) on the tick the state changes:
 *
 * | state                | level flags                                   | edges                                  |
 * |----------------------|-----------------------------------------------|----------------------------------------|
 * | forward/back/left/right | up / down / left / right                   |                                        |
 * | jump key             | jump_down, jumping, want_up, jump_current_raw | jump_pressed_raw, jump_released_raw    |
 * | jump performed       |                                               | start_jumping (the tick it leaves the ground) |
 * | sprint key           | sprint_down                                   |                                        |
 * | sprinting            | sprinting                                     | start_sprinting, stop_sprinting        |
 * | sneak key            | sneak_down, sneaking, want_down, sneak_current_raw | start_sneaking, stop_sneaking, sneak_pressed_raw, sneak_released_raw |
 * | swimming             |                                               | start_swimming, stop_swimming          |
 * | gliding (elytra)     |                                               | start_gliding, stop_gliding            |
 * | flying (abilities)   | (ascend / descend with jump / sneak)          | start_flying, stop_flying              |
 * | collisions           | vertical_collision, horizontal_collision      |                                        |
 *
 * `move_vector` is the processed vector (normalized, × 0.3 while sneaking on the ground, like the vanilla
 * client), `raw_move_vector` the unprocessed key state; BDS normalizes the processed vector, clamps it to ±0.3 while
 * sneaking and scales it by 0.98 (the engine does the same, see engine.js `simulatePlayer`).
 */

const MOVE_KEYS = [['forward', 'up'], ['back', 'down'], ['left', 'left'], ['right', 'right']]

/** @returns {{x:number,z:number}} raw key move vector (x = left − right, z = forward − back) */
function rawMoveVector (control) {
  return { x: (control.left ? 1 : 0) - (control.right ? 1 : 0), z: (control.forward ? 1 : 0) - (control.back ? 1 : 0) }
}

const DIAGONAL = Math.fround(Math.SQRT1_2)

/**
 * @returns {{x:number,z:number}} processed move vector: normalized (a diagonal is (±0.7071, ±0.7071), like the
 *   vanilla client — BDS normalizes it too), × 0.3 while sneaking (unless flying)
 */
function moveVector (control, { sneakScale = 0.3, flying = false } = {}) {
  const raw = rawMoveVector(control)
  let x = raw.x
  let z = raw.z
  if (x !== 0 && z !== 0) {
    x = Math.sign(x) * DIAGONAL
    z = Math.sign(z) * DIAGONAL
  }
  if (control.sneak && !flying) {
    x = Math.fround(x * sneakScale)
    z = Math.fround(z * sneakScale)
  }
  return { x: x + 0, z: z + 0 }
}

/**
 * @param {object} prev  the previous tick's input ({ control, sprinting, sneaking, swimming, gliding, flying })
 * @param {object} cur   this tick's input (same shape) + results: { jumped, onGround, collidedHorizontally,
 *                       collidedVertically }
 * @returns {string[]} input_data flag names
 */
function buildFlags (prev, cur) {
  const flags = []
  const c = cur.control
  const p = prev?.control ?? {}
  for (const [control, flag] of MOVE_KEYS) if (c[control]) flags.push(flag)

  if (c.jump) flags.push('jump_down', 'jumping', 'want_up', 'jump_current_raw')
  if (c.jump && !p.jump) flags.push('jump_pressed_raw')
  if (!c.jump && p.jump) flags.push('jump_released_raw')
  if (cur.jumped) flags.push('start_jumping')

  if (c.sprint) flags.push('sprint_down')
  if (cur.sprinting) flags.push('sprinting')
  if (cur.sprinting && !prev?.sprinting) flags.push('start_sprinting')
  if (!cur.sprinting && prev?.sprinting) flags.push('stop_sprinting')

  if (c.sneak) flags.push('sneak_down', 'want_down', 'sneak_current_raw')
  if (cur.sneaking) flags.push('sneaking')
  if (c.sneak && !p.sneak) flags.push('sneak_pressed_raw')
  if (!c.sneak && p.sneak) flags.push('sneak_released_raw')
  if (cur.sneaking && !prev?.sneaking) flags.push('start_sneaking')
  if (!cur.sneaking && prev?.sneaking) flags.push('stop_sneaking')

  if (cur.swimming && !prev?.swimming) flags.push('start_swimming')
  if (!cur.swimming && prev?.swimming) flags.push('stop_swimming')
  if (cur.gliding && !prev?.gliding) flags.push('start_gliding')
  if (!cur.gliding && prev?.gliding) flags.push('stop_gliding')
  if (cur.flying && !prev?.flying) flags.push('start_flying')
  if (!cur.flying && prev?.flying) flags.push('stop_flying')
  if (cur.flying && c.jump) flags.push('ascend')
  if (cur.flying && c.sneak) flags.push('descend')

  if (cur.collidedVertically || cur.onGround) flags.push('vertical_collision')
  if (cur.collidedHorizontally) flags.push('horizontal_collision')
  return flags
}

module.exports = { rawMoveVector, moveVector, buildFlags }
