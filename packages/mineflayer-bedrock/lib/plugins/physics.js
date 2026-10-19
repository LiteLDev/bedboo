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
//   history() (recorded ticks, tests/debugging), simulate(state) (one engine step with this bot's world),
//   onCorrection(fn) / stats() (server corrections, tests and diagnostics),
//   controlsPending() / controlsSent() → Promise / afterControlsSent(fn) (W3-FIX-A: a sneak / sprint change reaches
//   the server only with the next player_auth_input; clicks that depend on it wait for that packet).
// Flight state: bot.abilities (abilities.js, the only parser of update_abilities) is the server's view; this plugin
//   follows its 'abilities' event and reads flyingSpeed / mayFly from it.
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { isStub } = require('../bedrock/errors')
const { Physics, PlayerState } = require('../physics')
const { getEffectLevel: effectLevel } = require('../physics/engine')
const { moveVector, rawMoveVector, buildFlags } = require('../physics/input')
const conv = require('../bedrock/conversions')
const { toBigInt } = require('./abilities')
const { resetGliding } = require('../bedrock/entity_data')
const { EYE_HEIGHT } = require('../bedrock/constants')
const { POSITION_OFFSETS } = require('./entities')
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils')

const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']
const DEFAULT_REWIND_HISTORY = 40
const HISTORY_MARGIN = 20
/** creative flyTo: arrival tolerance (blocks), lookahead ticks, ticks without progress before giving up */
const FLY_TO_TOLERANCE = 0.15
const FLY_TO_LOOKAHEAD = 6
const FLY_TO_STALL_TICKS = 60
const FLY_TO_JUMP_REPRESS = 12
/** creative flyTo: never press forward again within this many ticks of releasing it (a double-tapped forward sprints) */
const FLY_TO_FORWARD_REPRESS = 10
/** BDS only starts gliding when start_gliding comes with a jump press (measured) */
const GLIDE_START_FLAGS = ['jump_down', 'jumping', 'want_up', 'jump_current_raw', 'jump_pressed_raw', 'start_jumping']
/** a glide the server has not confirmed after this many ticks is dropped */
const GLIDE_CONFIRM_TICKS = 20
/** a flight request the server has not answered (update_abilities) after this many ticks is dropped */
const FLIGHT_CONFIRM_TICKS = 20

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
  let glideRequestTick = null // tick of the input that carried start_gliding (until the server confirms)
  let lastSent = null // { position: Vec3 (feet), yaw, pitch } of the last packet
  let lookingTask = createDoneTask()
  let prevInput = null // input record of the previous sent tick (edge flags)
  // creative flyTo key timing across consecutive flyTo calls (U15): ticks captured, last jump press, last forward release
  const keyEdges = { tick: 0, jumpPressed: -Infinity, forwardReleased: -Infinity }
  let pendingKnockback = null // Vec3 from set_entity_motion, applied at the start of the next tick
  let flyTarget = null // { destination: Vec3, resolve, reject }
  let vehicleInput = { left: 0, forward: 0 }
  let pendingFlightRequest = null // request_ability flying value to send with the next input
  let flightRequestTick = null // tick of the input after the last request_ability, until update_abilities answers
  let abilitiesKnown = false // abilities.js reported the server's abilities at least once
  let skipNext = false // the next input is the first one after a teleport: not simulated (BDS does the same)
  const history = [] // [{ tick, input, state, simulated }] oldest first
  const correctionListeners = new Set()
  const stats = { corrections: 0, last: null }
  // sneak / sprint reach the server with the next player_auth_input: generation of the control change, of the input
  // being built and of the last input sent, the sent key states and the clicks waiting for them (afterControlsSent)
  let controlGen = 0
  let builtControlGen = 0
  let sentControlGen = 0
  let builtControls = null
  let sentControls = { sneak: false, sprint: false }
  let controlWaiters = [] // [{ gen, fn, reject? }]
  let built = null // { position, yaw, pitch } written into the packet being built (look/lookAt resolution, 'move')
  let fireworkSeen = 0 // bot.fireworkRocketDuration as physics last left it: another value = set from outside (a rocket)
  let rocketStarted = false // 'usedFirework' since the last tick (a rocket may set the very value the countdown had)
  let clickAirUse = false // a click_air was queued since the bot last stopped using an item (server item use)
  const listenerErrors = [] // errors thrown by physicsTick listeners, reported once the input is sent

  bot.setControlState = (control, state) => {
    assert.ok(control in controlState, `invalid control: ${control}`)
    assert.ok(typeof state === 'boolean', `invalid state: ${state}`)
    if (controlState[control] === state) return
    controlState[control] = state
    if (control === 'sneak' || control === 'sprint') controlGen++
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

  // ---- item use as the server sees it ------------------------------------------------------------------
  // The server only enters item use (eating, drawing a bow, …: ±0.1225 impulse clamp, no sprint) on a click_air
  // transaction. bot.usingHeldItem is also true while a shield is raised, which Bedrock does by sneaking without any
  // click_air (inventory.js, docs/differences/U8.md#item-use): BDS then simulates a plain sneak (measured, W3-FIX-A).
  // The outgoing click_air / item_release transactions are observed here, whoever queues them.
  const rawQueue = bot._client.queue
  if (typeof rawQueue === 'function') {
    bot._client.queue = function queue (name, params) {
      if (name === 'inventory_transaction') noteTransaction(params)
      return rawQueue.apply(this, arguments)
    }
  }
  function noteTransaction (params) {
    const tx = params?.transaction
    if (tx?.transaction_type === 'item_use' && tx.transaction_data?.action_type === 'click_air') clickAirUse = true
    else if (tx?.transaction_type === 'item_release') clickAirUse = false
  }
  bot._client.on('completed_using_item', () => { clickAirUse = false })
  // inventory.js ends a use on a held-stack change (its listener runs after this one)
  bot.on('heldItemChanged', () => process.nextTick(() => { if (!bot.usingHeldItem) clickAirUse = false }))

  function itemInUse () {
    if (!bot.usingHeldItem) {
      clickAirUse = false
      return false
    }
    return clickAirUse
  }

  /**
   * effective control states of this tick (Bedrock sprint: only forward, not sneaking, not flying, not while using an
   * item — BDS drops the sprint modifier as soon as an item is in use; measured)
   */
  function effectiveControls (usingItem = itemInUse()) {
    const c = { ...controlState }
    c.sprint = c.sprint && c.forward && !c.back && !c.sneak && !usingItem
    if (bot.jumpQueued) c.jump = true
    return c
  }

  /** snapshot of everything one engine step reads (for replay) */
  function captureInput () {
    const usingItem = itemInUse()
    let control = effectiveControls(usingItem)
    let rawControl = { ...controlState, jump: controlState.jump || bot.jumpQueued }
    keyEdges.tick++
    if (flyTarget && flying) {
      const plan = flyToPlan()
      bot.entity.yaw = plan.yaw
      control = plan.control
      rawControl = { ...plan.control }
    }
    if (rawControl.jump && !prevInput?.rawControl?.jump) keyEdges.jumpPressed = keyEdges.tick
    if (!rawControl.forward && prevInput?.rawControl?.forward) keyEdges.forwardReleased = keyEdges.tick
    return {
      control,
      rawControl,
      yaw: bot.entity.yaw,
      pitch: bot.entity.pitch,
      flying,
      gliding,
      sprinting: control.sprint && !flying,
      sneaking: controlState.sneak && !flying,
      swimming: false,
      moveVector: moveVector(control, { flying }),
      knockback: pendingKnockback,
      fireworkStart: pendingRocket() ?? undefined,
      flySpeed: flySpeed(),
      elytraEquipped: elytraEquipped(),
      usingItem, // the move vector is clamped to ±0.1225 while using an item (eating, bow, …)
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
    return bot.abilities?.flyingSpeed ?? 0.05
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
    state.elytraFlying = !!input.gliding
    state.usingItem = !!input.usingItem
    state.jumpQueued = false
    if (input.effects) Object.assign(state, input.effects)
    if (input.speedAttribute) state.attributes = { [bot.physics.movementSpeedAttribute]: input.speedAttribute }
    if (input.knockback) state.vel = input.knockback.clone()
    if (input.fireworkStart !== undefined) state.fireworkRocketDuration = input.fireworkStart
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

  /** one tick of movement for `state` with `input` */
  function step (state, input) {
    return bot.physics.simulatePlayer(state, world)
  }

  /** the provider's step: the state of this tick becomes the bot's; the queued jump was consumed */
  function applyState (state) {
    state.apply(bot)
    bot.jumpQueued = false
  }

  // ---- firework boosts (W3-FIX-A) -------------------------------------------------------------------------------
  // entities.js starts a boost between ticks by setting bot.fireworkRocketDuration (+ 'usedFirework'); a new rocket may
  // also shorten it. The start is recorded in the next tick's input (fireworkStart) so that replays from an earlier
  // tick boost from that tick on, and a replay before that input keeps it.
  bot.on('usedFirework', () => { rocketStarted = true })

  /** bot.fireworkRocketDuration when it was set from outside since physics last left it, else null */
  function pendingRocket () {
    const duration = bot.fireworkRocketDuration ?? 0
    return rocketStarted || duration !== fireworkSeen ? duration : null
  }

  /** the tick consumed the pending rocket (if any) */
  function settleRocket () {
    fireworkSeen = bot.fireworkRocketDuration ?? 0
    rocketStarted = false
  }

  /**
   * the result of a replay (correction, knockback / effect / glide resimulation, teleport) becomes the bot's state.
   * It keeps what happened after the last recorded input: a jump queued for the next tick (setControlState('jump')
   * pressed and released between ticks) and a firework rocket that started since the last tick.
   */
  function applyReplayedState (state) {
    const jumpQueued = bot.jumpQueued
    const rocket = pendingRocket()
    state.apply(bot)
    bot.jumpQueued = jumpQueued
    fireworkSeen = bot.fireworkRocketDuration ?? 0
    if (rocket !== null) bot.fireworkRocketDuration = rocket // still pending (rocketStarted kept)
  }

  function rewindSize () {
    const size = Number(bot._bedrock?.startGame?.rewind_history_size ?? DEFAULT_REWIND_HISTORY)
    return (Number.isFinite(size) && size > 0 ? size : DEFAULT_REWIND_HISTORY) + HISTORY_MARGIN
  }

  function record (tick, input, state, simulated) {
    const entry = { tick: BigInt(tick), input, state: snapshot(state), simulated }
    // never two entries for one tick (a corrections' findIndex would pick a stale one)
    if (history.length && history[history.length - 1].tick === entry.tick) history[history.length - 1] = entry
    else history.push(entry)
    const max = rewindSize()
    if (history.length > max) history.splice(0, history.length - max)
  }

  // ---- per-tick provider ---------------------------------------------------------------------------
  function provider (tick) {
    const entity = bot.entity
    if (!entity) return null
    if (pendingFlightRequest !== null) {
      bot._client.queue('request_ability', { ability: 'flying', value_type: 'bool', bool_value: pendingFlightRequest, float_val: 0 })
      pendingFlightRequest = null
      flightRequestTick = BigInt(tick)
    } else if (flightRequestTick !== null && BigInt(tick) - flightRequestTick > FLIGHT_CONFIRM_TICKS) {
      // no update_abilities answered the request: the server keeps the previous flight state
      flightRequestTick = null
      setFlying(!flying, { request: false })
    }
    if (riding()) {
      updateVehicleInput()
      followSeat()
    }
    const input = captureInput()
    builtControlGen = controlGen
    builtControls = { sneak: controlState.sneak, sprint: controlState.sprint }
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
    settleRocket()
    gliding = !!entity.elytraFlying && gliding
    if (input.gliding && !prevInput?.gliding) glideRequestTick = BigInt(tick)
    record(tick, input, state, simulated)
    if (gliding && glideRequestTick !== null && BigInt(tick) - glideRequestTick > GLIDE_CONFIRM_TICKS) stopGliding(glideRequestTick - 1n)

    const fields = movementFields(input, state, simulated)
    prevInput = { ...input, jumped: simulated && !!state.jumped }
    if (active) {
      // a throwing listener must not abort the tick (the input is recorded and must be sent): its error is reported
      // once the packet is queued (onSent)
      emitTickEvent('physicsTick')
      emitTickEvent('physicTick') // Deprecated, only exists to support old plugins. May be removed in the future
    }
    if (flyTarget) checkFlyTo()
    return fields
  }

  function emitTickEvent (name) {
    try {
      bot.emit(name)
    } catch (err) {
      listenerErrors.push(err)
    }
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
    built = { position: entity.position.clone(), yaw: entity.yaw, pitch: entity.pitch }
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
      input_data: buildFlags(prevInput, cur).concat(input.gliding && !prevInput?.gliding ? GLIDE_START_FLAGS : [], rideInput ? paddlingFlags() : [])
    }
  }

  function onSent () {
    const entity = bot.entity
    const sent = built
    built = null
    if (sent && builtControls) {
      sentControlGen = builtControlGen
      sentControls = builtControls
    }
    if (entity) {
      // what the packet carried (a physicsTick listener may have turned the bot after the fields were built: that
      // rotation goes out with the next input, and its look() resolves then — upstream resolves once the sent
      // rotation matches the entity's)
      const position = sent?.position ?? entity.position.clone()
      const yaw = sent?.yaw ?? entity.yaw
      const pitch = sent?.pitch ?? entity.pitch
      const changed = !lastSent || !lastSent.position.equals(position) || lastSent.yaw !== yaw || lastSent.pitch !== pitch
      const oldPos = lastSent ? lastSent.position : position.clone()
      lastSent = { position, yaw, pitch }
      if (changed) bot.emit('move', oldPos)
      if (!lookingTask.done && yaw === entity.yaw && pitch === entity.pitch) lookingTask.finish()
    }
    runControlWaiters()
    for (const err of listenerErrors.splice(0)) {
      try {
        bot.emit('error', err)
      } catch (unhandled) {
        // no 'error' listener: uncaught, like upstream's throwing listener in its physics interval — once the tick is
        // complete
        process.nextTick(() => { throw unhandled })
      }
    }
  }

  // ---- control changes before a click (W3-FIX-A) ------------------------------------------------------------
  // Upstream sends sneak / sprint changes (entity_action / player_input) inside setControlState, so a click right
  // after `setControlState('sneak', true)` is handled while sneaking (placing against a chest, sprint knockback).
  // On Bedrock they travel in the next player_auth_input: clicks that depend on them wait until it was queued.

  /** a sneak / sprint change is not in a sent player_auth_input yet (and one will be sent) */
  function controlsPending () {
    if (controlGen === sentControlGen) return false
    if (controlState.sneak === sentControls.sneak && controlState.sprint === sentControls.sprint) return false
    const input = bot._bedrock?.input
    if (!input || input.isSuspended?.() || input.isRunning?.() === false) return false
    return !!bot.entity
  }

  /**
   * run `fn` now when no sneak / sprint change is pending, else right after the next player_auth_input is queued (at
   * once if the input gets suspended first — loading screen, dimension change —; never once the bot ended)
   */
  function afterControlsSent (fn) {
    if (!controlsPending()) return fn()
    controlWaiters.push({ gen: controlGen, fn })
  }

  /** resolves once the current sneak / sprint state was sent (at once when nothing is pending); rejects on 'end' */
  function controlsSent () {
    return new Promise((resolve, reject) => {
      if (!controlsPending()) return resolve()
      controlWaiters.push({ gen: controlGen, fn: resolve, reject })
    })
  }

  function runControlWaiters (all = false) {
    if (controlWaiters.length === 0) return
    const ready = all ? controlWaiters : controlWaiters.filter((w) => w.gen <= sentControlGen)
    if (ready.length === 0) return
    controlWaiters = all ? [] : controlWaiters.filter((w) => w.gen > sentControlGen)
    for (const { fn } of ready) {
      try {
        fn()
      } catch (err) {
        bot.emit('error', err)
      }
    }
  }

  // the input clock stops (loading screen, dimension change): the change cannot be sent before the click any more
  bot._bedrock?.lifecycle?.events?.on?.('state', () => {
    if (bot._bedrock.input?.isSuspended?.() && bot._bedrock.lifecycle.state !== 'ended') runControlWaiters(true)
  })

  if (bot._bedrock?.input) {
    bot._bedrock.input.setProvider(provider)
    bot._bedrock.input.onSent(onSent)
  }

  // ---- server-forced moves --------------------------------------------------------------------------
  /** `move` + `forcedMove`; teleports reset the jump cooldown like upstream, corrections keep the replayed one */
  function emitForcedMove ({ resetJump = true } = {}) {
    const entity = bot.entity
    const oldPos = lastSent ? lastSent.position : entity.position.clone()
    lastSent = { position: entity.position.clone(), yaw: entity.yaw, pitch: entity.pitch }
    if (resetJump) bot.jumpTicks = 0
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

  /**
   * Creative / abilities flight on or off. A change requested by the client is sent to the server as
   * `request_ability flying` (BDS ignores the auth-input start_flying flag alone; measured) plus the
   * start_flying / stop_flying edge flags; the server confirms with update_abilities (handled below).
   */
  function setFlying (on, { request = true } = {}) {
    const next = !!on
    if (next === flying) return
    flying = next
    if (!flying && flyTarget) cancelFlyTo(new Error('flight stopped'))
    // sent right before the next player_auth_input (same batch): BDS applies the ability on receipt and the input
    // that follows is the first one simulated with the new flight state, like ours
    if (request) {
      pendingFlightRequest = flying
      flightRequestTick = null
    }
  }

  // the server's view of our flight: bot.abilities (abilities.js parses update_abilities — gamemode changes, /ability,
  // answers to our requests — and derives a game mode's abilities). Followed without a request_ability: the server
  // already decided (BDS would answer a request with more update_abilities).
  function followAbilities ({ answered = false } = {}) {
    const abilities = bot.abilities
    if (!abilities) return
    abilitiesKnown = true
    if (answered) flightRequestTick = null // the server answered a pending request_ability
    // the layered value: a spectator flies with may_fly cleared
    const serverFlying = !!abilities.flying
    if (serverFlying !== flying) setFlying(serverFlying, { request: false })
  }
  bot.on('abilities', () => followAbilities())
  // an update_abilities that changes nothing emits no 'abilities' (abilities.js) but still answers a pending flight
  // request (e.g. refused in survival): follow bot.abilities once abilities.js handled the packet (same self check)
  bot._client.on('update_abilities', (packet) => {
    const ids = bot._bedrock?.ids
    if (packet.entity_unique_id !== undefined && ids?.isSelfUnique && !ids.isSelfUnique(toBigInt(packet.entity_unique_id))) return
    queueMicrotask(() => followAbilities({ answered: true }))
  })

  function mayFly () {
    if (abilitiesKnown) return !!(bot.abilities?.mayFly || bot.abilities?.flying)
    const mode = bot.game?.gameMode
    return mode === undefined || mode === 'creative' || mode === 'spectator'
  }

  // ---- creative flyTo ---------------------------------------------------------------------------------
  // Bedrock movement is server-authoritative, so flyTo cannot move the bot by setting its position like upstream:
  // every tick it picks the flight inputs (forward toward the destination × jump / sneak / nothing) whose outcome,
  // simulated with the engine (this tick, then idle until stopped), ends closest to the destination. The server
  // simulates the same inputs, so the path needs no corrections.
  function flyToPlan () {
    const entity = bot.entity
    const target = flyTarget.destination
    const dx = target.x - entity.position.x
    const dz = target.z - entity.position.z
    const yaw = Math.hypot(dx, dz) > 1e-3 ? Math.atan2(-dx, -dz) : entity.yaw
    // BDS toggles flight on a double-tapped jump: never press jump again within FLY_TO_JUMP_REPRESS ticks — also across
    // consecutive flyTo calls (U15); and it sprint-flies (≈ twice as fast as the engine's flight) after a double-tapped
    // forward: never press forward again within FLY_TO_FORWARD_REPRESS ticks of releasing it
    const jumpHeld = !!prevInput?.rawControl?.jump
    const forwardHeld = !!prevInput?.rawControl?.forward
    const mayPressJump = jumpHeld || keyEdges.tick - keyEdges.jumpPressed >= FLY_TO_JUMP_REPRESS
    const mayPressForward = forwardHeld || keyEdges.tick - keyEdges.forwardReleased >= FLY_TO_FORWARD_REPRESS
    let best = null
    for (const forward of [false, true]) {
      if (forward && !mayPressForward) continue
      for (const vertical of [null, 'jump', 'sneak']) {
        if (vertical === 'jump' && !mayPressJump) continue
        const control = { forward, back: false, left: false, right: false, jump: vertical === 'jump', sprint: false, sneak: vertical === 'sneak' }
        const outcome = predictFlight(control, yaw, target)
        // touching the ground ends creative flight on Bedrock (BDS answers flying: false, which rejects the flyTo):
        // never land anywhere but at the destination (U15: examples/bee.js flew into the ground)
        const score = outcome.pos.distanceTo(target) + (outcome.landsAway ? 1e3 : 0) + (forward ? 1e-9 : 0) + (vertical ? 1e-9 : 0)
        if (!best || score < best.score) best = { score, control, yaw }
      }
    }
    flyTarget.ticks++
    return best
  }

  const IDLE_CONTROL = { forward: false, back: false, left: false, right: false, jump: false, sprint: false, sneak: false }

  /** the position after this tick's `control` and FLY_TO_LOOKAHEAD idle ticks; landsAway: touched the ground away from `target` */
  function predictFlight (control, yaw, target) {
    const entity = bot.entity
    const state = {
      pos: entity.position.clone(),
      vel: entity.velocity.clone(),
      onGround: entity.onGround,
      control,
      yaw,
      pitch: entity.pitch,
      flying: true,
      flySpeed: flySpeed(),
      jumpTicks: 0,
      moveVector: moveVector(control, { flying: true })
    }
    bot.physics.simulatePlayer(state, world)
    state.control = IDLE_CONTROL
    state.moveVector = { x: 0, z: 0 }
    const away = () => state.onGround && state.pos.distanceTo(target) > FLY_TO_TOLERANCE
    let landsAway = away()
    for (let i = 0; i < FLY_TO_LOOKAHEAD; i++) {
      bot.physics.simulatePlayer(state, world)
      landsAway = landsAway || away()
    }
    return { pos: state.pos, landsAway }
  }

  function checkFlyTo () {
    const entity = bot.entity
    const distance = entity.position.distanceTo(flyTarget.destination)
    if (distance < flyTarget.best - 1e-3) {
      flyTarget.best = distance
      flyTarget.stalled = 0
    } else {
      flyTarget.stalled++
    }
    if (distance <= FLY_TO_TOLERANCE && entity.velocity.norm() < 0.01) return finishFlyTo()
    if (flyTarget.stalled > FLY_TO_STALL_TICKS) {
      if (distance <= FLY_TO_TOLERANCE * 2) return finishFlyTo()
      cancelFlyTo(new Error(`flyTo: blocked ${distance.toFixed(2)} blocks from the destination`))
    }
  }

  function finishFlyTo () {
    const task = flyTarget
    flyTarget = null
    task?.resolve()
  }

  function cancelFlyTo (err) {
    const task = flyTarget
    flyTarget = null
    task?.reject(err)
  }

  /**
   * Fly to `destination` (feet position) with creative flight (requests flight first) and resolve once the bot
   * stopped within FLY_TO_TOLERANCE of it (upstream creative.flyTo semantics: the bot stays flying). Rejects when the
   * flight is stopped, the bot is teleported, or an obstacle blocks the way.
   */
  function flyTo (destination) {
    if (!bot.entity) return Promise.reject(new Error('flyTo: no bot entity'))
    if (!mayFly()) return Promise.reject(new Error('flyTo: flying is not allowed (game mode)'))
    if (flyTarget) cancelFlyTo(new Error('flyTo: superseded by a new destination'))
    setFlying(true)
    return new Promise((resolve, reject) => {
      flyTarget = { destination: new Vec3(destination.x, destination.y, destination.z), resolve, reject, best: Infinity, stalled: 0, ticks: 0 }
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
   * upstream semantics: left/forward in {-1, 0, 1} steer the ridden vehicle until changed. Bedrock: while riding, every
   * player_auth_input carries that move vector (+ boat paddling flags) and `client_predicted_vehicle` with the vehicle
   * id and rotation (refreshed each tick by the provider).
   */
  function moveVehicle (left, forward) {
    vehicleInput = { left: Math.sign(left) || 0, forward: Math.sign(forward) || 0 }
    updateVehicleInput()
  }

  function updateVehicleInput () {
    const vehicle = bot.vehicle
    if (!vehicle) return
    const rotation = { x: Math.fround(conv.toNotchianPitch(vehicle.pitch ?? 0)), z: Math.fround(conv.toNotchianYaw(vehicle.yaw ?? bot.entity.yaw)) }
    bot._bedrock.input.setVehicle(vehicleUniqueId(vehicle), rotation)
  }

  /** boat paddles: forward = both, turning left = right paddle, turning right = left paddle */
  function paddlingFlags () {
    if (!/boat/.test(bot.vehicle?.name ?? '')) return []
    const { left, forward } = vehicleInput
    const flags = []
    if (forward > 0 || left < 0) flags.push('paddling_left')
    if (forward > 0 || left > 0) flags.push('paddling_right')
    return flags
  }

  if (bot._bedrock?.physics) {
    bot._bedrock.physics.setPosition = setPosition
    bot._bedrock.physics.setFlying = setFlying
    bot._bedrock.physics.isFlying = () => flying
    bot._bedrock.physics.flyTo = flyTo
    bot._bedrock.physics.moveVehicle = moveVehicle
    bot._bedrock.physics.history = () => history.slice()
    /** fn({ tick, position, velocity, onGround, predicted, error, replayed }) for every server correction; → unsubscribe */
    bot._bedrock.physics.onCorrection = (fn) => {
      correctionListeners.add(fn)
      return () => correctionListeners.delete(fn)
    }
    bot._bedrock.physics.stats = () => ({ ...stats })
    bot._bedrock.physics.simulate = (state) => bot.physics.simulatePlayer(state, world)
    bot._bedrock.physics.controlsPending = controlsPending
    bot._bedrock.physics.controlsSent = controlsSent
    bot._bedrock.physics.afterControlsSent = afterControlsSent
  }
  if (!bot.moveVehicle || isStub(bot.moveVehicle)) bot.moveVehicle = moveVehicle
  bot.on('mount', updateVehicleInput)
  // ---- the rider's position (W3-FIX-A) ----------------------------------------------------------------------
  // BDS keeps a rider at its vehicle's seat: vehicle wire position + the rider_seat_position actor data (rotated by
  // the vehicle's yaw), at eye level (measured: boat seat (0, 1.02, 0) → feet 0.225 below the boat's feet, horse
  // (0, 2.32, -0.2) → feet 0.7 above, 0.2 behind). The client does not predict vehicle physics: the vehicle position is
  // the latest of its move_entity (bot.vehicle.position) and BDS's vehicle corrections (every 6 ticks). Every input
  // reports that seat and bot.entity.position follows it, so a dismount without a server teleport (boats) leaves the
  // rider next to the vehicle, not where it mounted.
  let vehicleBase = null // { vehicle, entityPos: vehicle.position it was taken from, pos: vehicle wire position }

  function followSeat () {
    const vehicle = bot.vehicle
    const seat = bot.entity?.metadata?.rider_seat_position
    if (!vehicle?.position || !seat || typeof seat.y !== 'number') return
    if (!vehicleBase || vehicleBase.vehicle !== vehicle || !vehicle.position.equals(vehicleBase.entityPos)) {
      vehicleBase = { vehicle, entityPos: vehicle.position.clone(), pos: vehicle.position.offset(0, POSITION_OFFSETS[vehicle.name] ?? 0, 0) }
    }
    // local frame: +z forward, +x left (mineflayer yaw: 0 = north)
    const yaw = vehicle.yaw ?? 0
    const x = seat.x ?? 0
    const z = seat.z ?? 0
    const dx = -Math.sin(yaw) * z - Math.cos(yaw) * x
    const dz = -Math.cos(yaw) * z + Math.sin(yaw) * x
    const entity = bot.entity
    const base = vehicleBase.pos
    entity.position.set(base.x + dx, base.y + seat.y - EYE_HEIGHT, base.z + dz)
    entity.velocity.set(0, 0, 0)
  }

  bot.on('dismount', () => {
    vehicleBase = null
    // the next vehicle's seat comes with its own set_entity_data (sent before the link)
    if (bot.entity?.metadata) delete bot.entity.metadata.rider_seat_position
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
    // the firework boost left at the server's tick (the in-flight inputs are replayed from there)
    const base = inFlight.length ? history.findLast((h) => h.tick <= at) : null
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
    if (base) state.fireworkRocketDuration = first.input.fireworkStart ?? base.state.fireworkRocketDuration
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
    applyReplayedState(state)
  }

  // ---- corrections: rewind to the corrected tick, then replay the recorded inputs ---------------------
  bot._client.on('correct_player_move_prediction', (packet) => {
    if (packet.prediction_type === 'vehicle') {
      // the server's state of the ridden vehicle (wire position): the seat follows it until the next move_entity
      if (bot.vehicle?.position && packet.position) {
        vehicleBase = { vehicle: bot.vehicle, entityPos: bot.vehicle.position.clone(), pos: new Vec3(packet.position.x, packet.position.y, packet.position.z) }
      }
      return
    }
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
    const predicted = index >= 0 ? history[index].state.pos.clone() : null
    if (index >= 0 && index < history.length - 1) {
      replayFrom(index, corrected)
    } else {
      entity.position.update(corrected.pos)
      entity.velocity.set(corrected.vel.x, corrected.vel.y, corrected.vel.z)
      entity.onGround = corrected.onGround
      if (index >= 0) Object.assign(history[index].state, { pos: corrected.pos.clone(), vel: corrected.vel.clone(), onGround: corrected.onGround })
    }
    const info = {
      tick,
      position: corrected.pos.clone(),
      velocity: corrected.vel.clone(),
      onGround: corrected.onGround,
      predicted, // our position for that tick before the correction (null: not in the history)
      error: predicted ? predicted.distanceTo(corrected.pos) : null,
      replayed: index >= 0 ? history.length - 1 - index : 0
    }
    stats.corrections++
    stats.last = info
    for (const fn of correctionListeners) {
      try { fn(info) } catch (err) { bot.emit('error', err) }
    }
    emitForcedMove({ resetJump: false })
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
    applyReplayedState(state)
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

  // the server's `gliding` actor flag decides: it confirms our start_gliding, or ends / refuses the glide (from the
  // input after its `tick`; inputs already sent are re-simulated without gliding)
  bot._client.on('set_entity_data', (packet) => {
    if (!isSelf(packet.runtime_entity_id)) return
    const flags = packet.metadata?.find((m) => m.key === 'flags')?.value
    if (!flags || typeof flags !== 'object') return
    const at = packet.tick !== undefined && packet.tick !== null && BigInt(packet.tick) > 0n ? BigInt(packet.tick) : null
    if (flags.gliding) {
      glideRequestTick = null
      if (!gliding) gliding = true
      return
    }
    if (!gliding) return
    if (glideRequestTick !== null && (at === null || at < glideRequestTick)) return // our request is not processed yet
    stopGliding(at)
  })

  function stopGliding (afterTick) {
    gliding = false
    glideRequestTick = null
    if (bot.entity) bot.entity.elytraFlying = false
    const from = afterTick === null ? -1 : history.findIndex((h) => h.tick > afterTick)
    if (from <= 0) return
    for (let i = from; i < history.length; i++) history[i].input = { ...history[i].input, gliding: false }
    resimulate(from)
  }

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
    return effectLevel(bot.registry, effectName, effects)
  }

  // a glide does not survive a death / dimension change: the server's next gliding flag starts a new one
  // (entityElytraFlew), even without a gliding = false in between
  bot.on('death', () => resetGliding(bot.entity))
  bot.on('respawn', () => resetGliding(bot.entity))

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
    // the server confirms with the `gliding` actor flag); actor data older than that input does not cancel it
    gliding = true
    glideRequestTick = (bot._bedrock.input.lastTick ?? 0n) + 1n
    bot.entity.elytraFlying = true
  }

  bot.on('end', () => {
    if (flyTarget) cancelFlyTo(new Error('bot ended'))
    // nothing will be sent any more: waiting clicks are dropped (controlsSent() rejects)
    const waiters = controlWaiters
    controlWaiters = []
    for (const { reject } of waiters) reject?.(new Error('bot ended before the sneak / sprint change was sent'))
  })
}
