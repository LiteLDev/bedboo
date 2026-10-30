// owner: BEDD-2 (authority table + core intent router)
'use strict'
/**
 * bedd-mode intent router. In `transport: 'bedd'` every serverbound packet bedboo would send goes to
 * `client.bedd.route(name, params)` instead of the wire; this module classifies it with the authority table
 * (./authority.js) and turns what bedboo meant into Be.D.D. control-pipe ops on the real client:
 *
 * | packet                         | op (caps present)                      | fallback (cap absent/disabled)            |
 * |--------------------------------|----------------------------------------|-------------------------------------------|
 * | player_auth_input move + flags | `input {move, jump, sneak, sprint, ttlMs:300}`, resent ≥ every 100 ms | `key` down/up W A S D SPACE LSHIFT LCTRL |
 * | player_auth_input yaw/pitch    | `look {yaw, pitch}` (changes > 0.01°)   | proportional `raw` mouse loop on bot.bedrock.bedd.observed |
 * | mob_equipment                  | `slot {slot}`                           | `key` 1–9                                 |
 * | text, command_request          | `send {buf}` (bedrock-protocol bytes)   | T / SLASH, `text`, ENTER (uuid lost)      |
 * | container_close                | `key ESC`                               |                                           |
 * | interact open_inventory        | `action {name:'inventory'}`             | `key E`                                   |
 * | clientOwned                    | dropped, counted                        |                                           |
 * | unsupported / unhandled        | 'bedd_unsupported_packet' once per name, throws BeddUnsupportedError |               |
 *
 * Input ops (input, look, slot, open_inventory and the key fallbacks) only go out while the client's mouse is grabbed and
 * no screen is showing, when the `world` op is present (polled every 250 ms). ESC and chat are never gated.
 *
 * Other bedd modules plug in without editing this file through the route registry (created by whoever attaches
 * first): `client.bedd.routes.register(name, handler)` → unregister function. A registered handler is called as
 * `handler(params, ctx)` and wins over the built-in translation of that name, except for player_auth_input, whose
 * handlers run after the built-in movement/look translation. Pseudo-names for parts of player_auth_input:
 * 'block_action' (params = the block_action array) and 'item_stack_request' (params = { requests: [request] },
 * ctx.embedded = true). The registry has no other dependency, so BB3 (router_actions.js) and BB7 (inventory.js) can
 * create it before the router exists.
 */
const authority = require('./authority')
const { VERSION } = require('../bedrock/constants')

const MARK = Symbol.for('bedboo.bedd.router')
const REGISTRY_MARK = Symbol.for('bedboo.bedd.routes')

const INPUT_TTL_MS = 300
const INPUT_RESEND_MS = 100
const WORLD_POLL_MS = 250
const LOOK_EPSILON = 0.01
const LOOK_TIMEOUT_MS = 250
const RAW_DEADBAND = 0.5
const RAW_GAIN = 1
const RAW_MAX = 300
const RAW_STEP_MS = 150 // the raw loop's step interval when the echo carries no tick
const CHAT_OPEN_DELAY_MS = 150

/** movement key fallback: key name, wanted when */
const MOVE_KEYS = [
  ['W', (s) => s.move.z > 0],
  ['S', (s) => s.move.z < 0],
  ['A', (s) => s.move.x > 0],
  ['D', (s) => s.move.x < 0],
  ['SPACE', (s) => s.jump],
  ['LSHIFT', (s) => s.sneak],
  ['LCTRL', (s) => s.sprint]
]

/** The handler registry shared by every bedd module (see the header). */
function createRouteRegistry () {
  const handlers = new Map()
  return {
    [REGISTRY_MARK]: true,
    handlers,
    register (name, handler) {
      if (typeof name !== 'string' || typeof handler !== 'function') throw new TypeError('routes.register(name, handler)')
      let list = handlers.get(name)
      if (!list) handlers.set(name, (list = []))
      if (!list.includes(handler)) list.push(handler)
      return () => {
        const i = list.indexOf(handler)
        if (i >= 0) list.splice(i, 1)
      }
    },
    get (name) {
      return [...(handlers.get(name) ?? [])] // a copy: a handler may unregister during dispatch
    },
    has (name) {
      return (handlers.get(name)?.length ?? 0) > 0
    }
  }
}

/** `bedd.routes`, created if missing (idempotent). */
function ensureRoutes (bedd) {
  if (!bedd.routes) bedd.routes = createRouteRegistry()
  return bedd.routes
}

/** Handlers registered for `name`, whatever registry shape another module created. */
function handlersFor (routes, name) {
  if (!routes) return []
  let found
  if (typeof routes.get === 'function') found = routes.get(name)
  else if (routes.handlers instanceof Map) found = routes.handlers.get(name)
  else found = routes[name]
  if (typeof found === 'function') return [found]
  return Array.isArray(found) ? found.filter(fn => typeof fn === 'function') : []
}

/** Signed difference a − b in degrees, in [-180, 180). */
function angleDiff (a, b) {
  return ((((a - b) % 360) + 540) % 360) - 180
}

function clamp (v, lo, hi) {
  return Math.min(hi, Math.max(lo, v))
}

const serializers = new Map()
/** bedrock-protocol bytes (varint header + body) of a serverbound packet, exactly what BeDD's `send` reads. */
function serializePacket (name, params, version = VERSION) {
  let serializer = serializers.get(version)
  if (!serializer) {
    const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
    serializer = createSerializer(version)
    serializers.set(version, serializer)
  }
  return serializer.createPacketBuffer({ name, params })
}

/** BeddUnsupportedError from lib/bedd/errors.js (BB5) when it is installed, otherwise an equivalent Error. */
function unsupportedError (feature) {
  let ErrorClass = null
  try {
    ErrorClass = require('./errors').BeddUnsupportedError
  } catch (err) {
    if (err?.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes("'./errors'")) throw err
  }
  let err = null
  if (typeof ErrorClass === 'function') {
    try {
      err = new ErrorClass(feature)
    } catch {}
  }
  if (!(err instanceof Error)) err = new Error(`${feature} is not supported in bedd mode: the real client owns it`)
  if (!err.code) err.code = 'ERR_BEDD_UNSUPPORTED'
  err.bedd = true
  if (!err.feature) err.feature = feature
  if (!Array.isArray(err.missing)) err.missing = []
  return err
}

/** Intent of one player_auth_input: the key-level movement state. */
function inputIntent (packet) {
  const flags = new Set(packet.input_data ?? [])
  let x = (flags.has('left') ? 1 : 0) - (flags.has('right') ? 1 : 0)
  let z = (flags.has('up') ? 1 : 0) - (flags.has('down') ? 1 : 0)
  if (x === 0 && z === 0) {
    // no key flags (analog input): the unprocessed vector, then the processed one
    const v = (packet.raw_move_vector && (packet.raw_move_vector.x || packet.raw_move_vector.z)) ? packet.raw_move_vector : packet.move_vector
    if (v) {
      x = clamp(Number(v.x) || 0, -1, 1)
      z = clamp(Number(v.z) || 0, -1, 1)
    }
  }
  return {
    move: { x: x + 0, z: z + 0 },
    jump: flags.has('jump_down') || flags.has('jumping'),
    sneak: flags.has('sneak_down') || flags.has('sneaking'),
    sprint: flags.has('sprint_down') || flags.has('sprinting')
  }
}

function isIdle (s) {
  return s.move.x === 0 && s.move.z === 0 && !s.jump && !s.sneak && !s.sprint
}

function sameInput (a, b) {
  return a.move.x === b.move.x && a.move.z === b.move.z && a.jump === b.jump && a.sneak === b.sneak && a.sprint === b.sprint
}

/**
 * @param {object} opts
 * @param {{ call: (op: string, args?: object) => Promise<any>, supports?: (op: string) => boolean }} opts.rpc
 * @param {Record<string, 'present'|'disabled'|'absent'>|(() => Record<string, string>)} [opts.caps] read on every use
 * @param {object} [opts.bot] for bot.bedrock.bedd.observed and 'bedd_unsupported_packet'
 * @param {import('events').EventEmitter} [opts.client] 'warning' events
 * @param {object} [opts.routes] the route registry (default: a new one)
 * @param {() => number} [opts.now]
 * @param {{ setInterval: Function, clearInterval: Function, setTimeout: Function }} [opts.timers]
 * @param {string} [opts.version] bedrock-protocol version for `send`
 * @param {number} [opts.lookGain] raw mouse counts per degree of the look fallback
 */
function createRouter (opts = {}) {
  const { rpc, bot = null, client = null } = opts
  const routes = opts.routes ?? createRouteRegistry()
  const now = opts.now ?? Date.now
  const timers = opts.timers ?? { setInterval, clearInterval, setTimeout }
  const version = opts.version ?? VERSION
  const lookGain = opts.lookGain ?? RAW_GAIN

  const counters = { dropped: {}, translated: {}, shared: {}, unsupported: {}, gated: 0, calls: {} }
  const unsupportedSeen = new Set()
  const warned = new Set()
  const inflight = new Set()

  let world = null
  let worldPoll = null
  let worldTimer = null
  let closed = false

  let lastInput = null
  let lastInputAt = -Infinity
  const heldKeys = new Set()
  let lookTarget = null
  let lookSent = null
  let lastRawTick
  let lastRawAt = -Infinity
  let typing = 0 // chat fallback in progress: the chat box has the keyboard
  let worldFailed = false
  let pendingSlot = null

  function capsTable () {
    const caps = typeof opts.caps === 'function' ? opts.caps() : opts.caps
    return caps ?? {}
  }
  /** an op is usable only when probed 'present' (or, unprobed, when rpc.supports says so) */
  function present (op) {
    const cap = capsTable()[op]
    if (cap !== undefined) return cap === 'present'
    return rpc?.supports?.(op) === true
  }

  function warn (err) {
    if (!client || typeof client.emit !== 'function') return
    client.emit('warning', err instanceof Error ? err : new Error(String(err)))
  }
  function warnOnce (key, message) {
    if (warned.has(key)) return
    warned.add(key)
    warn(new Error(message))
  }

  function track (promise) {
    const p = Promise.resolve(promise).catch((err) => {
      if (err?.code === 'timeout') return // a look that did not converge in time: the next one supersedes it
      warn(err)
    })
    inflight.add(p)
    p.finally(() => inflight.delete(p))
    return p
  }

  async function call (op, args) {
    counters.calls[op] = (counters.calls[op] ?? 0) + 1
    const reply = await rpc.call(op, args)
    if (reply && reply.ok === false) {
      const err = new Error(`bedd ${op}: ${reply.error ?? 'failed'}`)
      if (reply.code) err.code = reply.code
      throw err
    }
    return reply
  }

  /** ordered async steps (key sequences, chat fallback) */
  let chainTail = Promise.resolve()
  function chain (fn) {
    const step = chainTail.then(() => closed ? undefined : fn())
    chainTail = step.catch(() => {}) // a failed step never blocks the next one
    return track(step)
  }

  /** at most one call in flight per lane; a newer request replaces the waiting one */
  function createLane () {
    let busy = false
    let next = null
    function pump () {
      if (busy || !next || closed) return
      const { op, args, onError } = next
      next = null
      busy = true
      track(call(op, args).catch((err) => {
        onError?.(err)
        throw err
      })).finally(() => {
        busy = false
        pump()
      })
    }
    return {
      submit (op, args, onError) {
        next = { op, args, onError }
        pump()
      }
    }
  }
  const lookLane = createLane()

  function sleep (ms) {
    return new Promise((resolve) => timers.setTimeout(resolve, ms))
  }

  function key (name, action = 'press') {
    return call('key', { key: name, action })
  }

  // --- world gate -------------------------------------------------------------------------------------------------

  function refreshWorld () {
    if (closed || !present('world')) return Promise.resolve(world)
    if (!worldPoll) {
      worldPoll = call('world')
        .then((reply) => {
          world = reply ?? null
          worldFailed = false
        })
        .catch((err) => {
          if (!worldFailed) warn(err) // once per failure streak, not every 250 ms
          worldFailed = true
        })
        .then(() => {
          worldPoll = null
          return world
        })
    }
    return worldPoll
  }

  function inputAllowed () {
    if (typing > 0) return false
    if (!present('world') || !world) return true
    return world.inLevel !== false && world.mouseGrabbed !== false && !world.showingMenu
  }

  // --- movement ---------------------------------------------------------------------------------------------------

  function routeMovement (packet) {
    const want = inputIntent(packet)
    const allowed = inputAllowed()
    if (present('input')) {
      if (!allowed) {
        if (lastInput && !isIdle(lastInput)) counters.gated++
        lastInput = null // BeDD ignores the override while a screen shows; resend once input is allowed again
        return
      }
      if (isIdle(want)) {
        if (lastInput && !isIdle(lastInput)) track(call('input', { move: { x: 0, z: 0 }, jump: false, sneak: false, sprint: false, ttlMs: 0 }))
        lastInput = want
        return
      }
      const t = now()
      if (!lastInput || !sameInput(want, lastInput) || t - lastInputAt >= INPUT_RESEND_MS) {
        track(call('input', { move: { ...want.move }, jump: want.jump, sneak: want.sneak, sprint: want.sprint, ttlMs: INPUT_TTL_MS }))
        lastInput = want
        lastInputAt = t
      }
      return
    }
    // key fallback: releases first, presses only while input is allowed (keys typed into a screen would be text)
    for (const [name, wanted] of MOVE_KEYS) {
      const down = allowed && wanted(want)
      if (down === heldKeys.has(name)) continue
      if (down) heldKeys.add(name)
      else heldKeys.delete(name)
      track(key(name, down ? 'down' : 'up'))
    }
  }

  // --- look -------------------------------------------------------------------------------------------------------

  function routeLook (packet) {
    const yaw = Number(packet.yaw)
    const pitch = Number(packet.pitch)
    if (!Number.isFinite(yaw) || !Number.isFinite(pitch)) return
    if (!lookTarget) {
      // baseline: attaching never turns the real client, only later changes are intents
      lookTarget = { yaw, pitch }
      lookSent = { yaw, pitch }
      return
    }
    if (Math.abs(angleDiff(yaw, lookTarget.yaw)) > LOOK_EPSILON || Math.abs(pitch - lookTarget.pitch) > LOOK_EPSILON) {
      lookTarget = { yaw, pitch }
      lastRawTick = undefined
    }
    if (!inputAllowed()) return
    if (present('look')) {
      if (!lookSent || Math.abs(angleDiff(lookTarget.yaw, lookSent.yaw)) > LOOK_EPSILON || Math.abs(lookTarget.pitch - lookSent.pitch) > LOOK_EPSILON) {
        const sent = (lookSent = { ...lookTarget })
        lookLane.submit('look', { yaw: sent.yaw, pitch: sent.pitch, timeoutMs: LOOK_TIMEOUT_MS }, (err) => {
          if (err?.code !== 'timeout' && lookSent === sent) lookSent = null // failed: retry on the next tick
        })
      }
      return
    }
    stepRawLook()
  }

  /** closed proportional loop on the relative `raw` mouse against the echoed rotation */
  function stepRawLook () {
    if (!present('raw')) return
    const observed = bot?.bedrock?.bedd?.observed
    if (!observed || !Number.isFinite(observed.yaw) || !Number.isFinite(observed.pitch)) {
      if (!lookSent || Math.abs(angleDiff(lookTarget.yaw, lookSent.yaw)) > LOOK_EPSILON || Math.abs(lookTarget.pitch - lookSent.pitch) > LOOK_EPSILON) {
        warnOnce('raw-look', 'bedd: the look fallback needs bot.bedrock.bedd.observed (the physics follower); look ignored')
      }
      return
    }
    // wait for the echo of the last step (by tick, or by time when the echo has no tick)
    if (observed.tick !== undefined ? observed.tick === lastRawTick : now() - lastRawAt < RAW_STEP_MS) return
    const dYaw = angleDiff(lookTarget.yaw, observed.yaw)
    const dPitch = lookTarget.pitch - observed.pitch
    if (Math.abs(dYaw) <= RAW_DEADBAND && Math.abs(dPitch) <= RAW_DEADBAND) {
      lookSent = { ...lookTarget }
      return
    }
    const dx = Math.round(clamp(dYaw * lookGain, -RAW_MAX, RAW_MAX))
    const dy = Math.round(clamp(dPitch * lookGain, -RAW_MAX, RAW_MAX))
    if (dx === 0 && dy === 0) return
    lastRawTick = observed.tick
    lastRawAt = now()
    lookLane.submit('raw', { dx, dy })
  }

  // --- slot -------------------------------------------------------------------------------------------------------

  function sendSlot (slot) {
    if (present('slot')) return track(call('slot', { slot }))
    return track(key(String(slot + 1)))
  }

  function routeSlot (packet) {
    const slot = Number(packet.selected_slot ?? packet.slot)
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) return
    if (!inputAllowed()) {
      pendingSlot = slot
      counters.gated++
      return
    }
    pendingSlot = null
    sendSlot(slot)
  }

  // --- chat -------------------------------------------------------------------------------------------------------

  function routeShared (name, params) {
    if (present('send')) {
      const buf = serializePacket(name, params, version).toString('base64')
      return track(call('send', { buf }))
    }
    let text
    let open
    if (name === 'command_request') {
      warnOnce('command-uuid', 'bedd: no `send` op, commands are typed into chat and their command_request uuid is lost')
      open = 'SLASH' // opens the chat with '/' already typed
      text = String(params.command ?? '').replace(/^\//, '')
    } else {
      open = 'T'
      text = String(params.message ?? '')
    }
    typing++ // no movement/slot keys while the chat box is open (they would be typed into it)
    for (const name of [...heldKeys]) {
      heldKeys.delete(name)
      track(key(name, 'up'))
    }
    return chain(async () => {
      try {
        await key(open)
        await sleep(CHAT_OPEN_DELAY_MS)
        await call('text', { text })
        await key('ENTER')
      } finally {
        typing--
      }
    })
  }

  // --- windows ----------------------------------------------------------------------------------------------------

  function routeContainerClose () {
    return chain(async () => {
      // ESC with nothing open would open the pause menu
      if (present('world')) {
        // a fresh snapshot (not the in-flight poll, which may predate the screen)
        const w = await call('world').catch(() => null)
        if (w) world = w
        if (w && w.showingMenu === false) return
      }
      await key('ESC')
    })
  }

  function routeOpenInventory () {
    if (!inputAllowed()) {
      counters.gated++
      return
    }
    if (present('action')) return track(call('action', { name: 'inventory' }))
    return track(key('E'))
  }

  // --- dispatch ---------------------------------------------------------------------------------------------------

  function count (table, name) {
    table[name] = (table[name] ?? 0) + 1
  }

  function ctxFor (name, extra) {
    return { name, bot, client, router, routes, call, present, key, warn, inputAllowed, world: () => world, ...extra }
  }

  function runHandlers (list, name, params, extra) {
    let result
    for (const handler of list) {
      result = handler(params, ctxFor(name, extra))
      if (result && typeof result.then === 'function') track(result)
    }
    return result
  }

  /** inside the player_auth_input tick nothing may throw: a failing handler only warns */
  function runTickHandlers (list, name, params, extra) {
    try {
      runHandlers(list, name, params, extra)
    } catch (err) {
      warn(err)
    }
  }

  function noteUnsupported (name, feature) {
    count(counters.unsupported, name)
    if (unsupportedSeen.has(name)) return
    unsupportedSeen.add(name)
    if (bot && typeof bot.emit === 'function') bot.emit('bedd_unsupported_packet', { name, feature })
  }

  function rejectUnsupported (name, params) {
    const feature = authority.describe(name, params)
    noteUnsupported(name, feature)
    throw unsupportedError(feature)
  }

  function routePlayerAuthInput (params) {
    routeMovement(params)
    routeLook(params)
    if (pendingSlot !== null && inputAllowed()) {
      const slot = pendingSlot
      pendingSlot = null
      sendSlot(slot)
    }
    // parts other modules translate; inside the tick nothing may throw, so a missing handler only reports
    const blockActions = Array.isArray(params.block_action) ? params.block_action : []
    if (blockActions.length) {
      const list = handlersFor(routes, 'block_action')
      if (list.length) runTickHandlers(list, 'block_action', blockActions, { packet: params, embedded: true })
      else if (!handlersFor(routes, 'player_auth_input').length) noteUnsupported('block_action', 'player_auth_input block_action')
    }
    if (params.item_stack_request) {
      const list = handlersFor(routes, 'item_stack_request')
      if (list.length) runTickHandlers(list, 'item_stack_request', { requests: [params.item_stack_request] }, { packet: params, embedded: true })
      else if (!handlersFor(routes, 'player_auth_input').length) noteUnsupported('item_stack_request', 'item_stack_request')
    }
    const extra = handlersFor(routes, 'player_auth_input')
    if (extra.length) runTickHandlers(extra, 'player_auth_input', params)
  }

  /**
   * client.bedd.route: called by the bedd client for every queued/written serverbound packet. Throws
   * BeddUnsupportedError for unsupported packets (and translated ones nobody handles).
   */
  function route (name, params = {}) {
    if (closed) return
    if (name === 'player_auth_input') {
      count(counters.translated, name)
      return routePlayerAuthInput(params)
    }
    // bot.end/quit only detach: never disconnect the real client
    if (name === 'disconnect') return count(counters.dropped, name)
    const cls = authority.classify(name, params)
    if (cls === authority.CLIENT_OWNED) return count(counters.dropped, name)
    const registered = handlersFor(routes, name)
    if (registered.length) {
      count(counters.translated, name)
      return runHandlers(registered, name, params)
    }
    if (cls === authority.SHARED) {
      count(counters.shared, name)
      return routeShared(name, params)
    }
    if (cls === authority.TRANSLATED) {
      if (name === 'mob_equipment') {
        count(counters.translated, name)
        return routeSlot(params)
      }
      if (name === 'container_close') {
        count(counters.translated, name)
        return routeContainerClose()
      }
      if (name === 'interact' && params.action_id === 'open_inventory') {
        count(counters.translated, name)
        return routeOpenInventory()
      }
    }
    return rejectUnsupported(name, params)
  }

  function start () {
    if (worldTimer || closed) return
    refreshWorld()
    worldTimer = timers.setInterval(refreshWorld, WORLD_POLL_MS)
    worldTimer?.unref?.()
  }

  function stop () {
    if (closed) return
    // leave the real client idle: release fallback keys and the move override (BeDD also releases on disconnect)
    for (const name of [...heldKeys]) track(key(name, 'up'))
    heldKeys.clear()
    if (lastInput && !isIdle(lastInput) && present('input')) {
      track(call('input', { move: { x: 0, z: 0 }, jump: false, sneak: false, sprint: false, ttlMs: 0 }))
    }
    lastInput = null
    closed = true
    if (worldTimer) timers.clearInterval(worldTimer)
    worldTimer = null
  }

  /** resolves once every call the router started has settled */
  async function idle () {
    while (inflight.size) await Promise.allSettled([...inflight])
  }

  const router = {
    [MARK]: true,
    route,
    routes,
    counters,
    start,
    stop,
    idle,
    refreshWorld,
    inputAllowed,
    get world () { return world },
    get heldKeys () { return [...heldKeys] }
  }
  return router
}

/**
 * Install the router on a bedd client: `client.bedd.route` becomes the dispatcher. Idempotent; returns the router
 * (null without client.bedd).
 */
function attach (bot, client = bot?._client) {
  const bedd = client?.bedd
  if (!bedd) return null
  if (bedd.router?.[MARK]) return bedd.router
  const routes = ensureRoutes(bedd)
  const options = client.options?.bedd?.router ?? {}
  const router = createRouter({
    ...options,
    rpc: bedd.rpc,
    caps: () => bedd.caps,
    bot,
    client,
    routes,
    version: client.options?.version ?? client.version ?? VERSION
  })
  bedd.router = router
  bedd.route = router.route
  router.start()
  if (bot && typeof bot.once === 'function') bot.once('end', router.stop)
  if (typeof client.once === 'function') client.once('close', router.stop)
  return router
}

module.exports = {
  attach,
  createRouter,
  createRouteRegistry,
  ensureRoutes,
  handlersFor,
  inputIntent,
  serializePacket,
  angleDiff,
  INPUT_TTL_MS,
  INPUT_RESEND_MS,
  WORLD_POLL_MS
}
