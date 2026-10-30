// owner: BEDD-1 (transport 'bedd': control RPC, tap reader, client)
'use strict'
/**
 * createBeddClient: the bot's `_client` for `transport: 'bedd'` — a real Minecraft client hosted by Be.D.D. is
 * the one connected to the server; bedboo watches it through the tap pipe and asks it to act through the control
 * pipe. The object meets the same contract as bedrock-protocol's Client (and test/unit/helpers/fake.js):
 * `version`, `username`, `profile`, `options`, `startGameData`, `queue`, `write`, `disconnect`, `close`,
 * `setMaxListeners`, and the events below.
 *
 * Events
 * - 'connect', 'loggingIn' — the tap accepted HELLO, before the journal replay (the spec said REPLAY_END; but the
 *   replay can carry start_game and play_status, and mineflayer's 'connect' comes before 'login' and 'spawn').
 * - 'join' — before the first game packet.
 * - 'packet' (des), then '<packet name>' (params) — every CLIENTBOUND frame, journal replay included. `des` is
 *   bedrock-protocol's `{ data: { name, params }, buffer, fullBuffer, metadata }` plus `bedd: { seq, tUs, flags,
 *   replay, reserialized, local }`.
 * - 'spawn' — on play_status player_spawn, before the play_status event (as bedrock-protocol). Nothing is
 *   written: the real client sends set_local_player_as_initialized itself.
 * - 'serverbound' ({ name, params, reserialized, replay, local, seq, tUs }) — a packet the real client sent.
 * - 'warning' (Error) — a tap packet that did not decode (skipped), control pipe trouble, …
 * - 'kick' ({ reason, message }) + 'end' (reason) + 'close' — LINK_DOWN (the real client left the world) or
 *   DROPPED (bedboo fell too far behind); also 'error' + 'close' when the tap refuses HELLO or cannot connect.
 * - 'bedd_marker' (marker) — every tap marker (HELLO, LINK_UP, LINK_DOWN, REPLAY_BEGIN, REPLAY_END, DROPPED).
 *
 * `queue(name, params)` / `write(name, params)` hand what the bot would have sent to `client.bedd.route(name,
 * params)` (lib/bedd/index.js: drop + count until the router module replaces it). `disconnect()` / `close()` only
 * detach the pipes: the real client stays connected.
 */
const net = require('net')
const { EventEmitter } = require('events')
const { VERSION, PROTOCOL_VERSION } = require('../bedrock/constants')
const { createRpc, whenConnected } = require('./rpc')
const { createTapReader, KIND } = require('./tap')

const DEFAULT_PIPE = '\\\\.\\pipe\\BeDD'

function beddError (message, code, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

/** resolved `bedd` options: pipe paths and the stream factory */
function beddOptions (options) {
  const given = options.bedd ?? {}
  if (typeof given !== 'object') throw new TypeError('bedd options must be an object')
  const pipe = given.pipe ?? process.env.BEDBOO_BEDD_PIPE ?? DEFAULT_PIPE
  return {
    ...given,
    pipe,
    tapPipe: given.tapPipe ?? `${pipe}-tap`,
    connect: given.connect ?? ((path) => net.connect(path))
  }
}

/**
 * @param {object} options createBot options (`bedd: { pipe, tapPipe?, connect?, timeoutMs?, modules? }`, `version`,
 *   `username` — the fallback name until the game's player_list names the local player)
 * @param {{ createApi: (client, ctx) => object }} hooks builds `client.bedd` (lib/bedd/index.js)
 */
function createBeddClient (options = {}, { createApi } = {}) {
  const bedd = beddOptions(options)
  const version = options.version || VERSION
  const client = new EventEmitter()
  client.setMaxListeners(0)
  client.version = version
  client.username = undefined // set from player_list (the local player's entry) once known
  client.profile = undefined
  client.options = { ...options, version, transport: 'bedd', bedd }
  client.startGameData = null
  client.entityId = undefined
  client.status = 'idle'

  const rpc = createRpc({ path: bedd.pipe, connect: bedd.connect, timeoutMs: bedd.timeoutMs })
  rpc.on('warning', (err) => client.emit('warning', err))
  let tap = null
  let started = false
  let closed = false
  let joined = false
  let selfUnique = null
  let lastDisconnect = null
  const names = new Map() // player_list: unique id (string) → { username, uuid, xuid }

  client.bedd = createApi(client, { rpc, options, bedd })

  client.queue = (name, params) => client.bedd.route(name, params)
  client.write = (name, params) => client.bedd.route(name, params)
  /** detach only: the real client stays in its world */
  client.disconnect = () => client.close()
  client.close = () => {
    if (closed) return
    closed = true
    client.status = 'closed'
    rpc.close()
    tap?.close()
    client.emit('close')
  }

  /** emit without letting a throwing listener stop the tap stream */
  function safeEmit (event, ...args) {
    try {
      client.emit(event, ...args)
    } catch (err) {
      if (event === 'error') throw err
      client.emit('error', err)
    }
  }

  function end (reason, kick) {
    if (closed) return
    if (kick) safeEmit('kick', kick)
    safeEmit('end', reason)
    client.close()
  }

  function fail (err) {
    if (closed) return
    client.emit('error', err)
    client.close()
  }

  /** Probe the control pipe, then connect the tap (idempotent; called by attach() or on the next turn). */
  client.start = function start () {
    if (started || closed) return client.bedd.ready
    started = true
    client.status = 'connecting'
    client.bedd.negotiate().then(() => { if (!closed) connectTap() }, (err) => fail(err))
    return client.bedd.ready
  }

  function connectTap () {
    let stream
    try {
      stream = bedd.connect(bedd.tapPipe)
    } catch (err) {
      return fail(beddError(`BeDD tap pipe ${bedd.tapPipe}: ${err.message}`, 'ERR_BEDD_CONNECT', { cause: err }))
    }
    let connected = false
    stream.on('error', (err) => {
      // after the connect, the tap reader reports errors (and the close that follows ends the client)
      if (!connected) fail(beddError(`BeDD tap pipe ${bedd.tapPipe}: ${err.message} (is the game running with config tap:true?)`, 'ERR_BEDD_CONNECT', { cause: err }))
    })
    const onConnect = () => {
      if (closed) return stream.destroy?.()
      connected = true
      tap = createTapReader(stream, { version, protocol: PROTOCOL_VERSION })
      tap.on('hello', onHello)
      tap.on('marker', onMarker)
      tap.on('packet', onPacket)
      tap.on('warning', (err) => safeEmit('warning', err))
      tap.on('error', (err) => fail(err))
      tap.on('close', () => end('bedd_tap_closed'))
    }
    whenConnected(stream, onConnect)
  }

  function onHello (hello) {
    client.bedd.hello = hello
    if (hello.link) client.bedd.link = { ...hello.link }
    client.bedd.journal = hello.journal ?? null
    client.status = 'connected'
    safeEmit('connect')
    safeEmit('loggingIn')
  }

  function onMarker (marker) {
    switch (marker.m) {
      case 'LINK_UP':
        client.bedd.link = { state: 'up', type: marker.type, address: marker.address }
        break
      case 'LINK_DOWN':
        client.bedd.link = { ...client.bedd.link, state: 'down', reason: marker.reason }
        break
      case 'REPLAY_END':
        client.bedd.replayed = { complete: marker.complete !== false }
        if (marker.complete === false) safeEmit('warning', beddError('BeDD tap: the join journal is incomplete (complete:false): chunks are missing until the player re-enters them', 'ERR_BEDD_JOURNAL_INCOMPLETE'))
        break
    }
    safeEmit('bedd_marker', marker)
    if (marker.m === 'LINK_DOWN') {
      const message = lastDisconnect ?? String(marker.reason ?? 'link down')
      end(`bedd_link_down: ${message}`, { reason: 'bedd_link_down', message })
    } else if (marker.m === 'DROPPED') {
      const message = `BeDD tap dropped ${marker.count} frames (bedboo fell too far behind)`
      end(`bedd_dropped: ${message}`, { reason: 'bedd_dropped', message })
    }
  }

  function onPacket (packet) {
    if (closed) return
    const info = {
      seq: packet.seq,
      tUs: packet.tUs,
      flags: packet.flags,
      replay: packet.replay,
      reserialized: packet.reserialized,
      local: packet.local
    }
    if (packet.kind === KIND.SERVERBOUND_ECHO) {
      safeEmit('serverbound', { name: packet.name, params: packet.params, ...info })
      return
    }
    if (!joined) {
      joined = true
      safeEmit('join')
    }
    const { name, params } = packet
    if (name === 'player_list') trackPlayerList(params)
    else if (name === 'start_game') onStartGame(params)
    else if (name === 'disconnect') lastDisconnect = params.hide_disconnect_reason ? String(params.reason) : (params.message || String(params.reason))
    safeEmit('packet', { ...packet.des, bedd: info })
    if (name === 'play_status' && params.status === 'player_spawn') {
      client.status = 'initialized'
      safeEmit('spawn')
    }
    safeEmit(name, params)
  }

  function onStartGame (params) {
    client.startGameData = params
    client.entityId = params.runtime_entity_id
    selfUnique = String(params.entity_id)
    const self = names.get(selfUnique)
    if (self) setSelf(self)
  }

  function trackPlayerList (params) {
    // same shapes as entities.js: an array of records carrying `type`, or { type, records }
    const list = Array.isArray(params.records) ? params.records : (params.records?.records ?? [])
    for (const record of list) {
      if ((record.type ?? params.records?.type) !== 'add' || record.entity_unique_id === undefined) continue
      const entry = { username: record.username, uuid: record.uuid, xuid: record.xbox_user_id }
      const key = String(record.entity_unique_id)
      names.set(key, entry)
      if (key === selfUnique) setSelf(entry)
    }
  }

  function setSelf ({ username, uuid, xuid }) {
    if (!username) return
    const previous = client.username
    client.username = username
    client.options.username = username
    client.profile = { name: username, uuid, xuid: xuid || 0 }
    // on a server the local player's player_list entry comes after start_game: the bot took a fallback name there
    if (previous !== username) safeEmit('bedd_self', { username, uuid, xuid })
  }

  return client
}

module.exports = { createBeddClient, beddOptions, DEFAULT_PIPE }
