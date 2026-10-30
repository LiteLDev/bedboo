// owner: U4 (wave 2: clock + stationary sender) → U5 (wave 3: drain/tick, physics integration); BEDD-4 (external tick clock)
'use strict'
const { TICK_MS } = require('./constants')

/**
 * Tick clock + per-tick `player_auth_input` input queue, exposed as `bot._bedrock.input`.
 *
 * Bedrock movement is always server-authoritative with rewind: from spawn on, the client must send
 * one `player_auth_input` per server tick. The clock is anchored on `start_game.current_tick` (by
 * lib/bedrock/lifecycle.js) and may be re-anchored (U5: `correct_player_move_prediction.tick`):
 *
 *     tick = anchorTick + round((now - anchorTime) / 50)
 *
 * Sending (`start()` → a 50 ms timer calling `pump()`): every pump sends exactly one packet per server
 * tick elapsed since the last packet — zero when no tick elapsed, several after a late timer — with the
 * catch-up capped at `maxCatchupTicks` (older ticks are skipped, never sent late). Tick numbers only grow.
 * For each tick the movement provider (`setProvider(fn)`, the physics plugin: one physics step) returns
 * the movement fields, and the queue drains its producers into that tick's packet:
 *
 * - `addFlags(flags)`            one-shot input_data flag names for the next packet, e.g. ['start_sprinting']
 * - `hold(flag, on)`             level flags sent every tick while held, e.g. hold('sneaking', true)
 * - `queueBlockAction(action)`   { action, position, face } (server-auth digging; U10) — all queued actions go
 *                                into the next packet's `block_action` (+ flag `block_action`)
 * - `queueItemStackRequest(req)` one ItemStackRequest per tick at most (U8) (+ flag `item_stack_request`)
 * - `setVehicle(id, rotation)`   predicted vehicle unique id + vehicle rotation (U14) or (null) to clear
 *                                (`predicted_vehicle`, `vehicle_rotation`, flag `client_predicted_vehicle`)
 * - `suspend(reason)` / `resume(reason)` stop/restart sending (loading screen, death, dimension change);
 *   sending resumes only when every reason has been resumed. While suspended nothing is sent and the clock
 *   keeps running (no catch-up burst on resume).
 * - `markTeleportHandled()`      adds `handled_teleport` to the next packet (after a move_player teleport)
 *
 * External clock (BEDD-4, transport 'bedd' only): the real Minecraft client owns the server's tick, so
 * `setExternalClock(true)` stops the 50 ms timer (start() then only marks the queue running) and the physics follower
 * calls `pumpTo(tick)` once per echoed client tick: exactly one packet for that tick (never older than the last one
 * sent), the clock re-anchored on it. The packet still goes through `_client.queue('player_auth_input')`, where the
 * bedd router turns it into intents. Without setExternalClock nothing changes.
 *
 * Packet shape (bedrock-protocol 1.26.51, protocol 2193): `input_data` is an array of flag names; `delta`
 * is the velocity; `camera_orientation` the view direction; `interact_rotation` {x: pitch, z: yaw};
 * `move_vector`/`raw_move_vector`/`analogue_move_vector` the WASD input. Positions are EYE level.
 *
 * @typedef {object} MovementFields what a provider returns for one tick (every field optional)
 * @property {{x:number,y:number,z:number}} position eye-level wire position
 * @property {number} pitch degrees
 * @property {number} yaw degrees
 * @property {number} head_yaw degrees
 * @property {{x:number,y:number,z:number}} delta velocity (blocks/tick)
 * @property {{x:number,z:number}} move_vector
 * @property {{x:number,z:number}} raw_move_vector
 * @property {{x:number,z:number}} analogue_move_vector
 * @property {{x:number,y:number,z:number}} camera_orientation
 * @property {{x:number,z:number}} interact_rotation
 * @property {string[]} input_data flags of this tick (merged with held + one-shot flags)
 *
 * @typedef {object} InputQueue
 * @property {(tick: bigint|number, at?: number) => void} anchor  (re)anchor the clock
 * @property {(now?: number) => bigint} currentTick server tick estimate for `now` (ms, performance-like clock)
 * @property {(flags: string[]) => void} addFlags
 * @property {(flag: string, on: boolean) => void} hold
 * @property {(action: { action: string, position: {x:number,y:number,z:number}, face: number }) => void} queueBlockAction
 * @property {(request: object) => void} queueItemStackRequest
 * @property {(vehicleRuntimeId: bigint|number|null, rotation?: {x:number,z:number}) => void} setVehicle
 * @property {(reason: string) => void} suspend
 * @property {(reason: string) => void} resume
 * @property {() => boolean} isSuspended
 * @property {() => void} markTeleportHandled
 * @property {(fn: (tick: bigint) => MovementFields|null) => void} setProvider one call per sent tick, before the packet is built
 * @property {(fn: (packet: object, tick: bigint) => void) => () => void} onSent called after each packet was queued; returns an unsubscribe
 * @property {() => void} start start the 50 ms timer (idempotent; with an external clock: only mark the queue running)
 * @property {() => void} stop
 * @property {() => boolean} isRunning
 * @property {(now?: number) => number} pump send the elapsed ticks now; returns the number of packets sent (none with an
 *   external clock)
 * @property {(on: boolean) => void} setExternalClock BEDD-4: true stops the 50 ms timer (pumpTo drives the queue)
 * @property {() => boolean} isExternalClock
 * @property {(tick: bigint|number, at?: number) => number} pumpTo BEDD-4: anchor on `tick` and send exactly one packet
 *   for it (or for lastTick + 1 when `tick` is not newer); 0 while suspended or not running
 * @property {bigint|null} lastTick last tick sent (getter)
 */

const DEFAULT_MAX_CATCHUP_TICKS = 4

/** Fields of an idle, stationary input (the U0 spike's packet, accepted by BDS 1.26.51.1). */
function idleFields () {
  return {
    pitch: 0,
    yaw: 0,
    position: { x: 0, y: 0, z: 0 },
    move_vector: { x: 0, z: 0 },
    head_yaw: 0,
    input_data: [],
    input_mode: 'mouse',
    play_mode: 'normal',
    interaction_model: 'crosshair',
    interact_rotation: { x: 0, z: 0 },
    tick: 0n,
    delta: { x: 0, y: 0, z: 0 },
    analogue_move_vector: { x: 0, z: 0 },
    camera_orientation: { x: 0, y: 0, z: 1 },
    raw_move_vector: { x: 0, z: 0 }
  }
}

/**
 * @param {object} bot
 * @param {{ now?: () => number, timers?: { setInterval: Function, clearInterval: Function }, maxCatchupTicks?: number }} [opts]
 *   injectable clock/timers for tests (defaults: performance.now, global timers, bot option maxCatchupTicks ?? 4)
 * @returns {InputQueue}
 */
function createInputQueue (bot, opts = {}) {
  const now = opts.now ?? (() => performance.now())
  const timers = opts.timers ?? { setInterval, clearInterval }
  const maxCatchupTicks = Math.max(1, opts.maxCatchupTicks ?? DEFAULT_MAX_CATCHUP_TICKS)
  let anchorTick = 0n
  let anchorTime = now()
  let lastTick = null
  let timer = null
  let running = false // start() was called (and stop() was not): with an external clock, no timer exists
  let externalClock = false
  let provider = null
  const sentListeners = new Set()
  const suspendReasons = new Set()
  const oneShotFlags = []
  // The vanilla client always reports block breaking delays as enabled (U10 may release it).
  const heldFlags = new Set(['block_breaking_delay_enabled'])
  let blockActions = []
  const itemStackRequests = []
  let vehicle = null

  function currentTick (at = now()) {
    return anchorTick + BigInt(Math.round((at - anchorTime) / TICK_MS))
  }

  function buildPacket (tick, movement) {
    const packet = idleFields()
    if (movement) {
      for (const [key, value] of Object.entries(movement)) {
        if (value !== undefined && key !== 'input_data') packet[key] = value
      }
    }
    packet.tick = tick
    const flags = new Set(movement?.input_data ?? [])
    for (const flag of heldFlags) flags.add(flag)
    for (const flag of oneShotFlags.splice(0)) flags.add(flag)
    if (blockActions.length) {
      packet.block_action = blockActions
      blockActions = []
      flags.add('block_action')
    }
    if (itemStackRequests.length) {
      packet.item_stack_request = itemStackRequests.shift()
      flags.add('item_stack_request')
    }
    if (vehicle) {
      packet.predicted_vehicle = vehicle.id
      packet.vehicle_rotation = vehicle.rotation
      flags.add('client_predicted_vehicle')
    }
    packet.input_data = [...flags]
    return packet
  }

  function sendTick (tick) {
    const movement = provider ? provider(tick) : null
    const packet = buildPacket(tick, movement)
    bot._client.queue('player_auth_input', packet)
    lastTick = tick
    for (const fn of sentListeners) {
      try {
        fn(packet, tick)
      } catch (err) {
        bot.emit('error', err)
      }
    }
  }

  function pump (at = now()) {
    if (externalClock) return 0 // BEDD-4: only pumpTo sends
    const target = currentTick(at)
    if (suspendReasons.size > 0) {
      // keep the clock moving: no catch-up burst after resume
      if (lastTick === null || target > lastTick) lastTick = target
      return 0
    }
    if (lastTick === null) lastTick = target - 1n
    let first = lastTick + 1n
    if (target < first) return 0
    if (target - first + 1n > BigInt(maxCatchupTicks)) first = target - BigInt(maxCatchupTicks) + 1n
    let sent = 0
    for (let tick = first; tick <= target; tick++) {
      if (suspendReasons.size > 0 || !bot._client) break // a provider/listener may suspend or end mid-loop
      sendTick(tick)
      sent++
    }
    return sent
  }

  function startTimer () {
    if (timer || externalClock) return
    timer = timers.setInterval(() => {
      try {
        pump()
      } catch (err) {
        bot.emit('error', err)
      }
    }, TICK_MS)
    timer?.unref?.()
  }

  function stopTimer () {
    if (timer) timers.clearInterval(timer)
    timer = null
  }

  /** external clock (BEDD-4): one packet for the client's `tick`, anchored on it */
  function pumpTo (tick, at = now()) {
    const clientTick = BigInt(tick)
    anchorTick = clientTick
    anchorTime = at
    if (suspendReasons.size > 0) {
      // keep the clock moving, like pump()
      if (lastTick === null || clientTick > lastTick) lastTick = clientTick
      return 0
    }
    if (!running || !bot._client) return 0
    // tick numbers only grow (a client tick that is not newer goes out as the next one)
    sendTick(lastTick !== null && clientTick <= lastTick ? lastTick + 1n : clientTick)
    return 1
  }

  return {
    anchor (tick, at = now()) {
      anchorTick = BigInt(tick)
      anchorTime = at
    },
    currentTick,
    get lastTick () { return lastTick },
    suspend (reason) { suspendReasons.add(reason) },
    resume (reason) { suspendReasons.delete(reason) },
    isSuspended () { return suspendReasons.size > 0 },
    suspendReasons () { return [...suspendReasons] },
    addFlags (flags) {
      for (const flag of flags) if (!oneShotFlags.includes(flag)) oneShotFlags.push(flag)
    },
    hold (flag, on) {
      if (on) heldFlags.add(flag)
      else heldFlags.delete(flag)
    },
    queueBlockAction (action) {
      const { x, y, z } = action.position ?? { x: 0, y: 0, z: 0 }
      blockActions.push({ action: action.action, position: { x, y, z }, face: action.face ?? 0 })
    },
    queueItemStackRequest (request) {
      itemStackRequests.push(request)
    },
    setVehicle (vehicleUniqueId, rotation = { x: 0, z: 0 }) {
      vehicle = vehicleUniqueId === null || vehicleUniqueId === undefined
        ? null
        : { id: BigInt(vehicleUniqueId), rotation: { x: rotation.x ?? 0, z: rotation.z ?? 0 } }
    },
    markTeleportHandled () {
      this.addFlags(['handled_teleport'])
    },
    setProvider (fn) {
      provider = fn
    },
    onSent (fn) {
      sentListeners.add(fn)
      return () => sentListeners.delete(fn)
    },
    pump,
    pumpTo,
    start () {
      running = true
      startTimer()
    },
    stop () {
      running = false
      stopTimer()
    },
    isRunning () { return timer !== null || (externalClock && running) },
    setExternalClock (on) {
      externalClock = !!on
      if (externalClock) stopTimer()
      else if (running) startTimer()
    },
    isExternalClock () { return externalClock },
    /** pending one-shot flags / held flags (tests, U5) */
    pendingFlags () { return [...oneShotFlags] },
    heldFlags () { return [...heldFlags] }
  }
}

module.exports = { createInputQueue, DEFAULT_MAX_CATCHUP_TICKS }
