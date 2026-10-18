// owner: U4 (wave 2, stationary stub with the full surface) → U5 (wave 3, Bedrock engine)
// Upstream: mineflayer 4.39.0 lib/plugins/physics.js (MIT, Copyright (c) 2013 Andrew Kelley) — control states,
//   look/lookAt (sensitivity rounding), waitForTicks and the physicTick deprecation warning are kept verbatim.
// Surface: bot.physics (Physics() object: default fields + simulatePlayer), bot.physicsEnabled
//   (options.physicsEnabled ?? true), bot.jumpQueued, bot.jumpTicks, bot.controlState
//   {forward, back, left, right, jump, sprint, sneak} (getters/setters → setControlState),
//   bot.setControlState(control, state), bot.getControlState(control), bot.clearControlStates(),
//   bot.look(yaw, pitch, force), bot.lookAt(point, force), bot.waitForTicks(ticks), bot.elytraFly()
//   options: physicsEnabled, maxCatchupTicks
// Events: 'physicsTick' + deprecated 'physicTick' (every tick), 'move' (oldPos), 'forcedMove'
// Bedrock: player_auth_input every server tick via bot._bedrock.input (eye-level wire positions),
//   move_player (teleport → handled_teleport), correct_player_move_prediction (snap).
//
// U4 STUB (wave 2) — what it does:
// - registers the tick provider of bot._bedrock.input: one "physics step" per server tick, then the movement
//   fields of that tick's player_auth_input (current position at eye level, yaw/pitch, velocity as delta,
//   camera orientation, `vertical_collision` when on ground). Controls are recorded but do NOT move the bot.
// - the step is stationary + simple gravity: when nothing solid is under the feet (and the column is loaded,
//   not flying) the bot falls with Java constants (vy = (vy − 0.08) × 0.98) and lands on the top of the first
//   colliding block; the server stays authoritative (corrections snap).
// - 'physicsTick' + 'physicTick' after each step while physicsEnabled and the bot's column is loaded (upstream:
//   no physics without a chunk); 'move' (old position) whenever a sent packet changes position or look.
// - forcedMove: move_player for the local player (mode teleport/reset/normal: feet = wire − 1.62, velocity 0,
//   yaw/pitch, handled_teleport flag for teleport/reset) and correct_player_move_prediction (prediction_type
//   player: snap position, velocity = delta, on_ground); mode 'rotation' only turns the head.
// - look/lookAt are effective in the next player_auth_input (no gradual yaw like Java's notchian client);
//   without `force` they resolve once that packet was sent.
// - bot._bedrock.physics.setPosition(pos, { forced, handledTeleport = forced }) and .setFlying(on) (no gravity).
// What it does NOT do (U5): walking/sprinting/sneaking/jumping/swimming/climbing, collisions, step-up, knockback,
//   rewind + replay of corrections, vehicles, elytra, creative flight movement.
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { stubAsync } = require('../bedrock/errors')
const { Physics } = require('../physics')
const conv = require('../bedrock/conversions')
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const GRAVITY = 0.08
const AIR_DRAG = Math.fround(1 - 0.02)
const TERMINAL_VELOCITY = -3.92
const EPSILON = 1e-4

module.exports = inject

function inject (bot, { physicsEnabled }) {
  const world = { getBlock: (pos) => bot.blockAt(pos, false) }
  bot.physics = Physics(bot.registry, world)
  // stub engine (U5 replaces): no-op player simulation, simple ground search
  bot.physics.simulatePlayer = function simulatePlayer (playerState, world) { return playerState }
  bot.physics.adjustPositionHeight = function adjustPositionHeight (pos) {
    const top = groundTop(pos.x, pos.y, pos.z, pos.y - 4)
    if (top !== null) pos.y = top
  }
  bot.physicsEnabled = physicsEnabled ?? true
  bot.jumpQueued = false
  bot.jumpTicks = 0

  const controlState = {
    forward: false,
    back: false,
    left: false,
    right: false,
    jump: false,
    sprint: false,
    sneak: false
  }
  let flying = false
  let lastSent = null // { position: Vec3 (feet), yaw, pitch } of the last packet
  let lookingTask = createDoneTask()

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'jump' && state) bot.jumpQueued = true
  }

  bot.getControlState = (control) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    return controlState[control]
  }

  bot.clearControlStates = () => {
    for (const control in controlState) {
      bot.setControlState(control, false)
    }
  }

  // Same shape as upstream: accessors that delegate to get/setControlState.
  bot.controlState = {}
  for (const control of CONTROLS) {
    Object.defineProperty(bot.controlState, control, {
      get () { return controlState[control] },
      set (state) {
        bot.setControlState(control, state)
        return state
      }
    })
  }

  // remove this when 'physicTick' is removed
  bot.on('newListener', (name) => {
    if (name === 'physicTick') console.warn('Mineflayer detected that you are using a deprecated event (physicTick)! Please use this event (physicsTick) instead.')
  })

  // ---- simple gravity -------------------------------------------------------------------------------
  const HALF_WIDTH = 0.3 - 0.001
  const FOOTPRINT = [[-HALF_WIDTH, -HALF_WIDTH], [-HALF_WIDTH, HALF_WIDTH], [HALF_WIDTH, -HALF_WIDTH], [HALF_WIDTH, HALF_WIDTH]]

  /** top y of the highest colliding block surface in [minY, fromY] under one point, or null */
  function surfaceUnder (x, fromY, z, minY) {
    for (let by = Math.floor(fromY); by >= Math.floor(minY); by--) {
      const block = bot.world.getBlock(new Vec3(x, by, z))
      if (!block) return null
      if (!block.shapes || block.shapes.length === 0) continue
      let top = -Infinity
      for (const shape of block.shapes) top = Math.max(top, shape[4])
      const surface = by + top
      if (surface <= fromY + EPSILON) return surface
    }
    return null
  }

  /** highest colliding surface in [minY, fromY] under the player's footprint (0.6 × 0.6), or null */
  function groundTop (x, fromY, z, minY) {
    let best = null
    for (const [dx, dz] of FOOTPRINT) {
      const surface = surfaceUnder(x + dx, fromY, z + dz, minY)
      if (surface !== null && (best === null || surface > best)) best = surface
    }
    return best
  }

  function columnLoaded (pos) {
    return !!bot.world.getColumnAt(pos)
  }

  function stepGravity () {
    const entity = bot.entity
    const pos = entity.position
    const vel = entity.velocity
    if (flying) {
      entity.onGround = false
      return
    }
    // standing inside a colliding block (e.g. /tp into the ground): stay, the server resolves it
    const feetBlock = bot.world.getBlock(pos)
    if (feetBlock?.shapes?.some(s => pos.y - Math.floor(pos.y) < s[4] - EPSILON && pos.y - Math.floor(pos.y) >= s[1] - EPSILON)) {
      vel.set(0, 0, 0)
      entity.onGround = true
      return
    }
    const support = groundTop(pos.x, pos.y, pos.z, pos.y - 0.01)
    if (support !== null && pos.y - support <= EPSILON && vel.y <= 0) {
      vel.y = 0
      entity.onGround = true
      return
    }
    vel.y = Math.max(TERMINAL_VELOCITY, (vel.y - GRAVITY) * AIR_DRAG)
    const target = pos.y + vel.y
    const landing = groundTop(pos.x, pos.y, pos.z, target)
    if (landing !== null && landing >= target) {
      pos.y = landing
      vel.y = 0
      entity.onGround = true
    } else {
      pos.y = target
      entity.onGround = false
    }
  }

  // ---- per-tick provider ---------------------------------------------------------------------------
  function provider (tick) {
    const entity = bot.entity
    if (!entity) return null
    if (bot.physicsEnabled && columnLoaded(entity.position)) {
      try {
        stepGravity()
      } catch (err) {
        bot.emit('error', err)
      }
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    const yaw = Math.fround(conv.toNotchianYaw(entity.yaw))
    const pitch = Math.fround(conv.toNotchianPitch(entity.pitch))
    const vel = entity.velocity
    return {
      position: conv.feetToWire(entity.position),
      yaw,
      pitch,
      head_yaw: yaw,
      interact_rotation: { x: pitch, z: yaw },
      camera_orientation: conv.viewDirection(entity.yaw, entity.pitch),
      delta: { x: vel.x, y: vel.y, z: vel.z },
      input_data: entity.onGround ? ['vertical_collision'] : []
    }
  }

  function onSent () {
    const entity = bot.entity
    if (!entity) return
    const position = entity.position
    const changed = !lastSent || !lastSent.position.equals(position) || lastSent.yaw !== entity.yaw || lastSent.pitch !== entity.pitch
    const oldPos = lastSent ? lastSent.position : position.clone()
    lastSent = { position: position.clone(), yaw: entity.yaw, pitch: entity.pitch }
    if (changed) bot.emit('move', oldPos)
    if (!lookingTask.done) lookingTask.finish()
  }

  if (bot._bedrock?.input) {
    bot._bedrock.input.setProvider(provider)
    bot._bedrock.input.onSent(onSent)
  }

  // ---- server-forced moves --------------------------------------------------------------------------
  function emitForcedMove () {
    const entity = bot.entity
    const oldPos = lastSent ? lastSent.position : entity.position.clone()
    lastSent = { position: entity.position.clone(), yaw: entity.yaw, pitch: entity.pitch }
    bot.jumpTicks = 0
    bot.emit('move', oldPos)
    bot.emit('forcedMove')
  }

  function setPosition (pos, { forced = false, handledTeleport = forced } = {}) {
    const entity = bot.entity
    if (!entity) return
    entity.position.set(pos.x, pos.y, pos.z)
    if (forced) {
      entity.velocity.set(0, 0, 0)
      if (handledTeleport) bot._bedrock.input.markTeleportHandled()
      emitForcedMove()
    }
  }

  function setFlying (on) {
    flying = !!on
    if (flying && bot.entity) bot.entity.velocity.y = 0
  }

  if (bot._bedrock?.physics) {
    bot._bedrock.physics.setPosition = setPosition
    bot._bedrock.physics.setFlying = setFlying
    bot._bedrock.physics.isFlying = () => flying
  }

  const isSelf = (runtimeId) => !!bot.entity && !!bot._bedrock?.ids?.isSelf(runtimeId)

  bot._client.on('move_player', (packet) => {
    if (!isSelf(packet.runtime_id)) return
    const entity = bot.entity
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    if (packet.mode === 'rotation') return
    entity.position.update(conv.feetFromWire(packet.position))
    entity.velocity.set(0, 0, 0)
    entity.onGround = !!packet.on_ground
    if (packet.mode === 'teleport' || packet.mode === 'reset') bot._bedrock.input.markTeleportHandled()
    emitForcedMove()
  })

  bot._client.on('correct_player_move_prediction', (packet) => {
    if (packet.prediction_type !== undefined && packet.prediction_type !== 'player') return
    const entity = bot.entity
    if (!entity) return
    entity.position.update(conv.feetFromWire(packet.position))
    entity.velocity.set(packet.delta.x, packet.delta.y, packet.delta.z)
    entity.onGround = !!packet.on_ground
    emitForcedMove()
  })

  bot.look = async (yaw, pitch, force) => {
    if (!lookingTask.done) {
      lookingTask.finish() // finish the previous one
    }
    lookingTask = createTask()

    // this is done to bypass certain anticheat checks that detect the player's sensitivity
    // by calculating the gcd of how much they move the mouse each tick
    const sensitivity = conv.fromNotchianPitch(0.15) // this is equal to 100% sensitivity in vanilla
    const yawChange = Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity
    const pitchChange = Math.round((pitch - bot.entity.pitch) / sensitivity) * sensitivity

    if (yawChange === 0 && pitchChange === 0) {
      lookingTask.finish()
      return
    }

    bot.entity.yaw += yawChange
    bot.entity.pitch += pitchChange

    if (force) {
      lookingTask.finish()
      return
    }

    // effective in the next player_auth_input (onSent finishes the task)
    await lookingTask.promise
  }

  bot.lookAt = async (point, force) => {
    const delta = point.minus(bot.entity.position.offset(0, bot.entity.eyeHeight, 0))
    const yaw = Math.atan2(-delta.x, -delta.z)
    const groundDistance = Math.sqrt(delta.x * delta.x + delta.z * delta.z)
    const pitch = Math.atan2(delta.y, groundDistance)
    await bot.look(yaw, pitch, force)
  }

  bot.waitForTicks = async function (ticks) {
    if (ticks <= 0) return
    await new Promise((resolve, reject) => {
      // Assuming 20 ticks per second, add extra time for lag
      const timeout = setTimeout(() => {
        bot.removeListener('physicsTick', tickListener)
        reject(new Error(`Timeout waiting for ${ticks} ticks after ${(ticks * 50 + 5000)}ms`))
      }, ticks * 50 + 5000) // 50ms per tick + 5s buffer

      const tickListener = () => {
        ticks--
        if (ticks === 0) {
          clearTimeout(timeout)
          bot.removeListener('physicsTick', tickListener)
          resolve()
        }
      }

      bot.on('physicsTick', tickListener)
    })
  }

  bot.elytraFly = stubAsync('U5', 'bot.elytraFly', 0)
}
