// owner: U4 (wave 2, stationary stub with the full surface) → U5 (wave 3, Bedrock engine)
// Upstream: mineflayer 4.39.0 lib/plugins/physics.js (MIT, Copyright (c) 2013 Andrew Kelley) — control states,
//   look/lookAt (sensitivity rounding), waitForTicks, elytraFly checks and the physicTick deprecation warning are
//   kept verbatim.
// Surface: bot.physics (Physics() object: Bedrock values of the upstream fields + simulatePlayer +
//   adjustPositionHeight), bot.physicsEnabled (options.physicsEnabled ?? true), bot.jumpQueued, bot.jumpTicks,
//   bot.controlState {forward, back, left, right, jump, sprint, sneak} (getters/setters → setControlState),
//   bot.setControlState(control, state), bot.getControlState(control), bot.clearControlStates(),
//   bot.look(yaw, pitch, force), bot.lookAt(point, force), bot.waitForTicks(ticks), bot.elytraFly(),
//   bot.moveVehicle(left, forward) (when entities.js still has the stub)
//   options: physicsEnabled, maxCatchupTicks
// Events: 'physicsTick' + deprecated 'physicTick' (every simulated tick), 'move' (oldPos), 'forcedMove'
// Bedrock (lib/bedrock/input_queue.js): one player_auth_input per server tick, built here by the input provider:
//   - one engine step (lib/physics/engine.js) per tick from the control states, then the packet fields: EYE-level
//     position, yaw/pitch/head_yaw (degrees), `delta` = velocity at the end of the tick, move vectors, camera
//     orientation and every level/edge input flag (lib/physics/input.js);
//   - history of the last `rewind_history_size` (+ margin) ticks: correct_player_move_prediction rewinds to the
//     corrected tick, takes the server state and replays the recorded inputs up to now;
//   - move_player for the local player = teleport (handled_teleport in the next input) / rotation;
//   - set_entity_motion for the local player = knockback, applied to the input after its `tick` (rewinding when that
//     input was already sent);
//   - creative / abilities flight (start_flying / stop_flying), elytra gliding (start_gliding / stop_gliding),
//     vehicles (client_predicted_vehicle via input.setVehicle).
// Hooks (bot._bedrock.physics): setPosition(pos, { forced, handledTeleport = forced }), setFlying(on), isFlying(),
//   flyTo(destination) → Promise (speed-limited flight path, used by bot.creative.flyTo), moveVehicle(left, forward),
//   history() (recorded ticks, tests/debugging), simulate(state) (one engine step with this bot's world).
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { isStub } = require('../bedrock/errors')
const { Physics, PlayerState } = require('../physics')
const { moveVector, rawMoveVector, buildFlags } = require('../physics/input')
const conv = require('../bedrock/conversions')
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const DEFAULT_REWIND_HISTORY = 40
const HISTORY_MARGIN = 20
/** creative flyTo: blocks per tick (BDS accepts creative flight at this speed without corrections) */
const FLY_TO_SPEED = 0.5

module.exports = inject

function inject (bot, { physicsEnabled }) {
  const world = { getBlock: (pos) => bot.blockAt(pos, false) }
  bot.physics = Physics(bot.registry, world)
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
  let gliding = false // client-side elytra glide request/state (server confirms with the `gliding` actor flag)
  let lastSent = null // { position: Vec3 (feet), yaw, pitch } of the last packet
  let lookingTask = createDoneTask()
  let prevInput = null // input record of the previous sent tick (edge flags)
  let pendingKnockback = null // Vec3 from set_entity_motion, applied at the start of the next tick
  let flyTarget = null // { destination: Vec3, resolve, reject }
  let vehicleInput = { left: 0, forward: 0 }
  let skipNext = false // the next input is the first one after a teleport: not simulated (BDS does the same)
  const history = [] // [{ tick, input, state, simulated }] oldest first

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

  // ---- state helpers -------------------------------------------------------------------------------

  function columnLoaded (pos) {
    return !!bot.world?.getColumnAt?.(pos)
  }

  function isDead () {
    if (bot.isAlive === false) return true
    const state = bot._bedrock?.lifecycle?.state
    return state === 'dead' || state === 'respawning'
  }

  function riding () {
    return !!bot.vehicle
  }

  // chest armor slot as the server last sent it (armor window, slot 1): elytra detection that does not depend on the
  // Java-layout bot.inventory (slot 6) being populated
  let rawChestName = null
  const isArmorWindow = (id) => id === 'armor' || id === 120
  const itemName = (item) => (item && item.network_id ? bot._bedrock?.ids?.itemName(item.network_id) ?? null : null)
  bot._client.on('inventory_content', (packet) => {
    if (isArmorWindow(packet.window_id)) rawChestName = itemName(packet.input?.[1])
  })
  bot._client.on('inventory_slot', (packet) => {
    if (isArmorWindow(packet.window_id) && packet.slot === 1) rawChestName = itemName(packet.item)
  })

  function elytraEquipped () {
    const torso = bot.inventory?.slots?.[6]
    return torso?.name === 'elytra' || rawChestName === 'elytra'
  }

  /** effective control states of this tick (Bedrock sprint: only forward, not sneaking, not flying) */
  function effectiveControls () {
    const c = { ...controlState }
    c.sprint = c.sprint && c.forward && !c.back && !c.sneak
    if (bot.jumpQueued) c.jump = true
    return c
  }

  /** snapshot of everything one engine step reads (for replay) */
  function captureInput () {
    const control = effectiveControls()
    return {
      control,
      rawControl: { ...controlState },
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      flying,
      gliding,
      sprinting: control.sprint && !flying,
      sneaking: controlState.sneak && !flying,
      swimming: false,
      moveVector: moveVector(control, { flying }),
      knockback: pendingKnockback,
      flySpeed: flySpeed(),
      elytraEquipped: elytraEquipped(),
      flyTarget: flyTarget ? flyTarget.destination.clone() : null,
      ...statusInputs()
    }
  }

  /** server-driven movement inputs (effects, movement speed attribute) as they are now */
  function statusInputs () {
    const entity = bot.entity
    const effects = entity?.effects
    const speed = entity?.attributes?.[bot.physics.movementSpeedAttribute]
    return {
      effects: {
        jumpBoost: getEffectLevel('JumpBoost', effects),
        slowFalling: getEffectLevel('SlowFalling', effects),
        levitation: getEffectLevel('Levitation', effects),
        speed: getEffectLevel('Speed', effects),
        slowness: getEffectLevel('Slowness', effects)
      },
      speedAttribute: speed ? { value: speed.value, modifiers: (speed.modifiers ?? []).slice() } : null
    }
  }

  function flySpeed () {
    return bot.abilities?.flyingSpeed ?? bot.entity?.flyingSpeed ?? 0.05
  }

  /** engine state from the bot (prismarine-physics PlayerState shape + Bedrock extras) */
  function stateFromBot (input) {
    const state = new PlayerState(bot, input.control)
    applyInputToState(state, input)
    return state
  }

  function applyInputToState (state, input) {
    state.control = input.control
    state.yaw = input.yaw
    state.pitch = input.pitch
    state.flying = input.flying
    state.flySpeed = input.flySpeed
    state.moveVector = input.moveVector
    state.elytraEquipped = input.elytraEquipped
    state.elytraFlying = input.gliding || state.elytraFlying
    state.jumpQueued = false
    if (input.effects) Object.assign(state, input.effects)
    if (input.speedAttribute) state.attributes = { [bot.physics.movementSpeedAttribute]: input.speedAttribute }
    if (input.knockback) state.vel = input.knockback.clone()
  }

  /** the mutable part of a state (what history stores) */
  function snapshot (state) {
    return {
      pos: state.pos.clone(),
      vel: state.vel.clone(),
      onGround: state.onGround,
      isInWater: state.isInWater,
      isInLava: state.isInLava,
      isInWeb: state.isInWeb,
      isCollidedHorizontally: state.isCollidedHorizontally,
      isCollidedVertically: state.isCollidedVertically,
      elytraFlying: state.elytraFlying,
      jumpTicks: state.jumpTicks,
      fireworkRocketDuration: state.fireworkRocketDuration,
      jumped: !!state.jumped
    }
  }

  function restore (state, snap) {
    state.pos = snap.pos.clone()
    state.vel = snap.vel.clone()
    state.onGround = snap.onGround
    state.isInWater = snap.isInWater
    state.isInLava = snap.isInLava
    state.isInWeb = snap.isInWeb
    state.isCollidedHorizontally = snap.isCollidedHorizontally
    state.isCollidedVertically = snap.isCollidedVertically
    state.elytraFlying = snap.elytraFlying
    state.jumpTicks = snap.jumpTicks
    state.fireworkRocketDuration = snap.fireworkRocketDuration
  }

  /** one tick of movement for `state` with `input` (engine step, or the creative flyTo path) */
  function step (state, input) {
    if (input.flyTarget) {
      const delta = input.flyTarget.minus(state.pos)
      const dist = delta.norm()
      const move = dist <= FLY_TO_SPEED ? delta : delta.scaled(FLY_TO_SPEED / dist)
      state.pos = state.pos.plus(move)
      state.vel = move.clone()
      state.onGround = false
      state.isCollidedHorizontally = false
      state.isCollidedVertically = false
      state.jumped = false
      return state
    }
    return bot.physics.simulatePlayer(state, world)
  }

  function applyState (state) {
    state.apply(bot)
    bot.jumpQueued = false
  }

  function rewindSize () {
    const size = Number(bot._bedrock?.startGame?.rewind_history_size ?? DEFAULT_REWIND_HISTORY)
    return (Number.isFinite(size) && size > 0 ? size : DEFAULT_REWIND_HISTORY) + HISTORY_MARGIN
  }

  function record (tick, input, state, simulated) {
    history.push({ tick: BigInt(tick), input, state: snapshot(state), simulated })
    const max = rewindSize()
    if (history.length > max) history.splice(0, history.length - max)
  }

  // ---- per-tick provider ---------------------------------------------------------------------------
  function provider (tick) {
    const entity = bot.entity
    if (!entity) return null
    const input = captureInput()
    pendingKnockback = null
    // BDS does not simulate the first input it processes after applying a teleport (it just takes the teleport
    // state): neither do we (see move_player below)
    input.skip = skipNext
    skipNext = false
    const active = bot.physicsEnabled && columnLoaded(entity.position) && !isDead() && !riding()
    const state = stateFromBot(input)
    let simulated = false
    if (active && !input.skip) {
      try {
        step(state, input)
        applyState(state)
        simulated = true
      } catch (err) {
        bot.emit('error', err)
      }
    } else if (input.knockback && !isDead() && !input.skip) {
      entity.velocity = input.knockback.clone()
    }
    if (!simulated) restoreFromBot(state)
    gliding = !!entity.elytraFlying && gliding
    record(tick, input, state, simulated)

    const fields = movementFields(input, state, simulated)
    prevInput = { ...input, jumped: simulated && !!state.jumped }
    if (active) {
      bot.emit('physicsTick')
      bot.emit('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (flyTarget && entity.position.distanceTo(flyTarget.destination) < 1e-3) finishFlyTo()
    return fields
  }

  /** a state that mirrors the bot (no step this tick) */
  function restoreFromBot (state) {
    const entity = bot.entity
    state.pos = entity.position.clone()
    state.vel = entity.velocity.clone()
    state.onGround = entity.onGround
    state.jumped = false
  }

  function movementFields (input, state, simulated) {
    const entity = bot.entity
    const yaw = Math.fround(conv.toNotchianYaw(entity.yaw))
    const pitch = Math.fround(conv.toNotchianPitch(entity.pitch))
    const vel = entity.velocity
    const rideInput = riding() ? { x: vehicleInput.left, z: vehicleInput.forward } : null
    const cur = {
      control: rideInput ? { forward: rideInput.z > 0, back: rideInput.z < 0, left: rideInput.x > 0, right: rideInput.x < 0 } : input.rawControl,
      sprinting: input.sprinting,
      sneaking: input.sneaking,
      swimming: input.swimming,
      gliding: input.gliding,
      flying: input.flying,
      jumped: simulated && !!state.jumped,
      onGround: entity.onGround,
      collidedHorizontally: !!entity.isCollidedHorizontally,
      collidedVertically: !!entity.isCollidedVertically
    }
    const mv = rideInput ?? input.moveVector
    const raw = rideInput ?? rawMoveVector(input.rawControl)
    return {
      position: conv.feetToWire(entity.position),
      yaw,
      pitch,
      head_yaw: yaw,
      interact_rotation: { x: pitch, z: yaw },
      camera_orientation: conv.viewDirection(entity.yaw, entity.pitch),
      delta: { x: vel.x, y: vel.y, z: vel.z },
      move_vector: { x: mv.x, z: mv.z },
      raw_move_vector: { x: raw.x, z: raw.z },
      analogue_move_vector: { x: 0, z: 0 },
      input_data: buildFlags(prevInput, cur)
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
      pendingKnockback = null
      history.length = 0
      skipNext = true
      if (handledTeleport) bot._bedrock.input.markTeleportHandled()
      emitForcedMove()
    }
  }

  function setFlying (on) {
    flying = !!on
    if (flying && bot.entity) bot.entity.velocity.y = 0
    if (!flying && flyTarget) cancelFlyTo(new Error('flight stopped'))
  }

  // ---- creative flyTo ---------------------------------------------------------------------------------
  function finishFlyTo () {
    const task = flyTarget
    flyTarget = null
    if (bot.entity) bot.entity.velocity.set(0, 0, 0)
    task?.resolve()
  }

  function cancelFlyTo (err) {
    const task = flyTarget
    flyTarget = null
    task?.reject(err)
  }

  /**
   * Fly in a straight line to `destination` (feet position) at FLY_TO_SPEED blocks per tick, flying (no gravity)
   * the whole way; resolves once the bot is there (upstream creative.flyTo semantics: the bot stays flying).
   */
  function flyTo (destination) {
    if (!bot.entity) return Promise.reject(new Error('flyTo: no bot entity'))
    if (flyTarget) cancelFlyTo(new Error('flyTo: superseded by a new destination'))
    setFlying(true)
    return new Promise((resolve, reject) => {
      flyTarget = { destination: new Vec3(destination.x, destination.y, destination.z), resolve, reject }
    })
  }

  // ---- vehicles ---------------------------------------------------------------------------------------
  function vehicleUniqueId (vehicle) {
    if (vehicle.uniqueId !== undefined && vehicle.uniqueId !== null) return BigInt(vehicle.uniqueId)
    const runtimeId = vehicle.runtimeId ?? vehicle.id
    const unique = bot._bedrock?.ids?.runtimeToUnique?.get?.(BigInt(runtimeId))
    return unique !== undefined ? BigInt(unique) : BigInt(runtimeId)
  }

  /**
   * upstream semantics: left/forward ∈ {-1, 0, 1} steer the ridden vehicle until changed. Bedrock: the rider's
   * player_auth_input carries the move vector + `client_predicted_vehicle` with the vehicle id and rotation.
   */
  function moveVehicle (left, forward) {
    vehicleInput = { left: Math.sign(left) || 0, forward: Math.sign(forward) || 0 }
    const vehicle = bot.vehicle
    if (!vehicle) return
    const rotation = { x: Math.fround(conv.toNotchianPitch(vehicle.pitch ?? 0)), z: Math.fround(conv.toNotchianYaw(vehicle.yaw ?? bot.entity.yaw)) }
    bot._bedrock.input.setVehicle(vehicleUniqueId(vehicle), rotation)
  }

  if (bot._bedrock?.physics) {
    bot._bedrock.physics.setPosition = setPosition
    bot._bedrock.physics.setFlying = setFlying
    bot._bedrock.physics.isFlying = () => flying
    bot._bedrock.physics.flyTo = flyTo
    bot._bedrock.physics.moveVehicle = moveVehicle
    bot._bedrock.physics.history = () => history.slice()
    bot._bedrock.physics.simulate = (state) => bot.physics.simulatePlayer(state, world)
  }
  if (!bot.moveVehicle || isStub(bot.moveVehicle)) bot.moveVehicle = moveVehicle
  bot.on('dismount', () => {
    vehicleInput = { left: 0, forward: 0 }
    bot._bedrock?.input?.setVehicle(null)
  })

  const isSelf = (runtimeId) => !!bot.entity && !!bot._bedrock?.ids?.isSelf(runtimeId)

  bot._client.on('move_player', (packet) => {
    if (!isSelf(packet.runtime_id)) return
    const entity = bot.entity
    entity.yaw = conv.fromNotchianYaw(packet.yaw)
    entity.pitch = conv.fromNotchianPitch(packet.pitch)
    if (packet.mode === 'rotation') return
    if (flyTarget) cancelFlyTo(new Error('flyTo: teleported'))
    applyTeleport(conv.feetFromWire(packet.position), !!packet.on_ground, packet.tick)
    if (packet.mode === 'teleport' || packet.mode === 'reset') bot._bedrock.input.markTeleportHandled()
    emitForcedMove()
  })

  /**
   * Server teleport. `move_player.tick` is the last input tick the server had processed when it teleported the
   * player. BDS takes the teleport state for the FIRST input it processes afterwards (no simulation) and simulates
   * the following ones from there; inputs already in flight are re-simulated the same way, otherwise the next
   * input is the unsimulated one.
   */
  function applyTeleport (feet, onGround, serverTick) {
    const entity = bot.entity
    entity.position.update(feet)
    entity.velocity.set(0, 0, 0)
    entity.onGround = onGround
    pendingKnockback = null
    const last = bot._bedrock?.input?.lastTick
    const at = serverTick === undefined || serverTick === null ? 0n : BigInt(serverTick)
    const inFlight = at > 0n && last !== null && last !== undefined && last - at <= BigInt(rewindSize())
      ? history.filter((h) => h.tick > at)
      : []
    history.length = 0
    if (inFlight.length === 0) {
      skipNext = true
      return
    }
    skipNext = false
    const [first, ...rest] = inFlight
    const state = stateFromBot(first.input)
    restoreFromBot(state)
    state.isCollidedHorizontally = false
    state.isCollidedVertically = false
    state.jumpTicks = 0
    first.input = { ...first.input, skip: true }
    record(first.tick, first.input, state, false)
    for (const h of rest) {
      applyInputToState(state, h.input)
      let simulated = false
      if (h.simulated) {
        step(state, h.input)
        simulated = true
      }
      record(h.tick, h.input, state, simulated)
    }
    applyState(state)
  }

  // ---- corrections: rewind to the corrected tick, then replay the recorded inputs ---------------------
  bot._client.on('correct_player_move_prediction', (packet) => {
    if (packet.prediction_type !== undefined && packet.prediction_type !== 'player') return
    const entity = bot.entity
    if (!entity) return
    const corrected = {
      pos: conv.feetFromWire(packet.position),
      vel: new Vec3(packet.delta.x, packet.delta.y, packet.delta.z),
      onGround: !!packet.on_ground
    }
    const tick = packet.tick === undefined ? null : BigInt(packet.tick)
    const index = tick === null ? -1 : history.findIndex((h) => h.tick === tick)
    if (index >= 0 && index < history.length - 1) {
      replayFrom(index, corrected)
    } else {
      entity.position.update(corrected.pos)
      entity.velocity.set(corrected.vel.x, corrected.vel.y, corrected.vel.z)
      entity.onGround = corrected.onGround
      if (index >= 0) Object.assign(history[index].state, { pos: corrected.pos.clone(), vel: corrected.vel.clone(), onGround: corrected.onGround })
    }
    bot.emit('physicsCorrection', { tick, position: corrected.pos.clone(), velocity: corrected.vel.clone(), onGround: corrected.onGround, replayed: index >= 0 ? history.length - 1 - index : 0 })
    emitForcedMove()
  })

  function replayFrom (index, corrected) {
    Object.assign(history[index].state, { pos: corrected.pos.clone(), vel: corrected.vel.clone(), onGround: corrected.onGround })
    resimulate(index + 1)
  }

  /** re-simulate the recorded inputs of history[from..] from the state after history[from − 1], then apply it */
  function resimulate (from) {
    const base = history[from - 1]
    const state = stateFromBot(base.input)
    restore(state, base.state)
    for (let i = from; i < history.length; i++) {
      const h = history[i]
      applyInputToState(state, h.input)
      if (h.simulated) {
        try {
          step(state, h.input)
        } catch (err) {
          bot.emit('error', err)
          break
        }
      } else if (h.input.skip) {
        restore(state, h.state)
      } else if (h.input.knockback) {
        state.vel = h.input.knockback.clone()
      }
      h.state = snapshot(state)
    }
    applyState(state)
  }

  // knockback / server velocity for the local player. `set_entity_motion.tick` is the last input the server had
  // processed: it applies the motion to the NEXT input (tick + 1). If that input was already sent, rewind and replay
  // with the motion at that tick (the server corrects that input with the knockback included); otherwise apply it at
  // the start of the next tick.
  bot._client.on('set_entity_motion', (packet) => {
    if (!isSelf(packet.runtime_entity_id)) return
    const v = packet.velocity
    if (!v) return
    const motion = new Vec3(v.x, v.y, v.z)
    const target = packet.tick !== undefined && packet.tick !== null && BigInt(packet.tick) > 0n ? BigInt(packet.tick) + 1n : null
    const index = target === null ? -1 : history.findIndex((h) => h.tick === target)
    if (index > 0) {
      history[index].input = { ...history[index].input, knockback: motion }
      pendingKnockback = null
      resimulate(index)
    } else {
      pendingKnockback = motion
    }
  })

  // effects / movement speed changes: like knockback, the server applies them from the input after `tick`; inputs
  // already sent from there on are re-simulated with the new values
  function onStatusChange (packet) {
    if (!bot.entity || packet.tick === undefined || packet.tick === null || BigInt(packet.tick) <= 0n) return
    const from = history.findIndex((h) => h.tick > BigInt(packet.tick))
    if (from <= 0) return
    const status = statusInputs()
    for (let i = from; i < history.length; i++) history[i].input = { ...history[i].input, ...status }
    resimulate(from)
  }
  bot._client.on('mob_effect', (packet) => {
    if (isSelf(packet.runtime_entity_id)) onStatusChange(packet)
  })
  bot._client.on('update_attributes', (packet) => {
    if (!isSelf(packet.runtime_entity_id)) return
    if ((packet.attributes ?? []).some((a) => a.name === 'minecraft:movement')) onStatusChange(packet)
  })

  // the server's `gliding` actor flag (entity_data.js keeps bot.entity.elytraFlying in sync)
  bot.on('entityElytraFlew', (entity) => {
    if (entity === bot.entity) gliding = true
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

  function getEffectLevel (effectName, effects) {
    const effectDescriptor = bot.registry.effectsByName[effectName]
    if (!effectDescriptor) return 0
    const effectInfo = effects?.[effectDescriptor.id]
    if (!effectInfo) return 0
    return effectInfo.amplifier + 1
  }

  bot.elytraFly = async () => {
    if (bot.entity.elytraFlying) {
      throw new Error('Already elytra flying')
    } else if (bot.entity.onGround) {
      throw new Error('Unable to fly from ground')
    } else if (bot.entity.isInWater) {
      throw new Error('Unable to elytra fly while in water')
    }

    if (getEffectLevel('Levitation', bot.entity.effects) > 0) {
      throw new Error('Unable to elytra fly with levitation effect')
    }

    const torsoSlot = typeof bot.getEquipmentDestSlot === 'function' && !isStub(bot.getEquipmentDestSlot) ? bot.getEquipmentDestSlot('torso') : 6
    const item = bot.inventory?.slots?.[torsoSlot]
    if ((item == null || item.name !== 'elytra') && rawChestName !== 'elytra') {
      throw new Error('Elytra must be equip to start flying')
    }
    // Bedrock: start_gliding in the next player_auth_input; the engine glides from that tick on (client prediction,
    // the server confirms with the `gliding` actor flag)
    gliding = true
    bot.entity.elytraFlying = true
  }

  bot.on('end', () => {
    if (flyTarget) cancelFlyTo(new Error('bot ended'))
  })
}
