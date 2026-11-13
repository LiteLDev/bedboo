// shared by every bedd unit test (free to reuse and extend additively)
'use strict'
/**
 * A fake Be.D.D. v2: the WebSocket endpoint of the bedd-bedboo wire protocol (`ws://127.0.0.1:<port>/v1`, token
 * auth, JSON text frames for the control ops, the tap as binary messages after `{ op: 'tap', action: 'subscribe' }`),
 * so `transport: 'bedd'` runs without the game. The RFC 6455 server side is the minimal codec below (node:http
 * upgrade, no extensions), like the mod's own.
 *
 *   const { createFakeBedd } = require('./helpers/fake_bedd')
 *   const fake = await createFakeBedd({ live: 'join_flat' })          // HELLO, empty replay, then join_flat live
 *   const bot = createBot({ transport: 'bedd', bedd: fake.botOptions(), hideErrors: true, logErrors: false })
 *   …
 *   fake.callsOf('look')                // control calls received: [{ op, args, conn, at }]
 *   fake.linkDown('left the world')     // LINK_DOWN marker (the bot ends)
 *   fake.writeRunFile(home)             // <home>/run/<pid>.json announcing this endpoint (discovery tests)
 *   await fake.close()
 *
 * Handshake: path `/v1`, `?token=` or `Authorization: Bearer` must equal `fake.token` (else HTTP 401), a request
 * carrying `Origin` gets 403 (as BeDD with an empty allowOrigins). `fake.handshakes` records every attempt.
 *
 * Control (text frames `{ id, op, ...args }` → `{ ok, id, ... }`): every op of the spec answers like BeDD
 * (no-argument read form and action form); `caps: { op: 'present' | 'disabled' | 'absent' }` turns an op off or
 * removes it (an absent op is also left out of `ping.modes`), `handlers: { op: (args, fake, conn) => reply |
 * Promise<reply> }` overrides one (throw an Error with `code` for `{ ok: false, error, code }`; return
 * `fake.NO_REPLY` to never answer). Several connections may be open at once; `fake.controlClients` holds the ones
 * that did not subscribe to the tap (`conn.destroy()` drops one).
 *
 * Tap (one subscriber; a second gets `code: 'busy'`, `tap: false` answers `code: 'disabled'`): after `{ ok: true }`
 * the connection receives HELLO (`hello` overrides fields), REPLAY_BEGIN, the `journal` frames (flag replay;
 * `duringReplay` frames are interleaved without the flag, as live frames racing the replay), REPLAY_END
 * (`journalComplete`), then the `live` frames unless `autoLive: false`, one binary message per frame. Records are
 * fixture records (`{ dir: 'in' | 'out', name, buffer }`: 'in' → CLIENTBOUND, 'out' → SERVERBOUND_ECHO; login,
 * handshakes and request_network_settings are never echoed, as BeDD) or raw frames `{ kind, flags?, payload }`; the
 * string 'join_flat' means every record of that capture. `onTap(fake, conn)` replaces the whole sequence.
 * The subscribe request is not recorded in `fake.calls` (`fake.tapConnections` counts subscriptions).
 */
const crypto = require('crypto')
const fs = require('fs')
const http = require('http')
const path = require('path')
const { EventEmitter, once } = require('events')
const fixtures = require('../../fixtures')
const { encodeFrame, packetIdOf, KIND, FLAG } = require('../../../lib/bedd/tap')
const { PROTOCOL_VERSION } = require('../../../lib/bedrock/constants')
const { TEST_VERSION, TEST_PROTOCOL, TEST_BDS_BUILD } = require('../../version')

const NO_REPLY = Symbol('no reply')
/** ids BeDD never echoes (login, handshakes, request_network_settings) */
const NEVER_ECHOED = new Set([1, 3, 4, 193])
/** ids `send` always refuses */
const ALWAYS_REFUSED = new Set([1, 30, 144, 147])
const SPEC_OPS = ['tap', 'world', 'look', 'input', 'slot', 'button', 'action', 'send', 'stack']
const BASE_OPS = ['ping', 'state', 'window', 'focus', 'key', 'text', 'mouse', 'raw', 'release', 'flush']
/** BeDD v2 `ping.modes` */
const MODES = Object.freeze({
  bedboo: ['world', 'look', 'input', 'slot', 'action', 'button', 'send', 'stack', 'timescale', 'join', 'tap'],
  input: ['key', 'text', 'mouse', 'raw', 'release', 'flush', 'focus', 'window', 'screenshot'],
  ui: ['ui']
})
const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** fixture records ('join_flat' or a list) → frames */
function toFrames (records, { flags = 0 } = {}) {
  if (!records) return []
  if (typeof records === 'string') records = fixtures.load(records).records
  const frames = []
  for (const r of records) {
    if (r.kind !== undefined) {
      frames.push({ kind: r.kind, flags: (r.flags ?? 0) | flags, payload: r.payload })
      continue
    }
    const kind = r.dir === 'out' ? KIND.SERVERBOUND_ECHO : KIND.CLIENTBOUND
    if (kind === KIND.SERVERBOUND_ECHO && NEVER_ECHOED.has(packetIdOf(r.buffer))) continue
    frames.push({ kind, flags: (r.flags ?? 0) | flags, payload: r.buffer })
  }
  return frames
}

/**
 * Server side of one WebSocket (RFC 6455 subset: text, binary, ping/pong, close, fragmentation; client frames
 * must be masked). Events: 'text' (string), 'binary' (Buffer), 'close'.
 * @param {import('net').Socket} socket the upgraded socket
 * @param {Buffer} head bytes read past the handshake
 */
function createWsConnection (socket, head) {
  const conn = new EventEmitter()
  let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0)
  let fragments = null
  let fragmentOpcode = 0
  let closeSent = false
  let closeTimer = null

  socket.setNoDelay?.(true)
  socket.on('data', (d) => {
    buf = buf.length ? Buffer.concat([buf, d]) : d
    parse()
  })
  socket.on('error', () => {})
  socket.on('close', () => {
    clearTimeout(closeTimer)
    conn.emit('close')
  })

  function parse () {
    while (buf.length >= 2) {
      const b0 = buf[0]
      const b1 = buf[1]
      let len = b1 & 0x7f
      let off = 2
      if (len === 126) {
        if (buf.length < 4) return
        len = buf.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (buf.length < 10) return
        len = Number(buf.readBigUInt64BE(2))
        off = 10
      }
      if (!(b1 & 0x80)) return fail(1002) // client frames are masked
      if (buf.length < off + 4 + len) return
      const mask = buf.subarray(off, off + 4)
      const payload = Buffer.from(buf.subarray(off + 4, off + 4 + len))
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      buf = buf.subarray(off + 4 + len)
      onFrame(!!(b0 & 0x80), b0 & 0x0f, payload)
      if (socket.destroyed) return
    }
  }

  function onFrame (fin, opcode, payload) {
    switch (opcode) {
      case 0x8: // close: answer it, then end the TCP connection
        if (!closeSent) writeFrame(0x8, payload.subarray(0, 2))
        closeSent = true
        socket.end()
        return
      case 0x9: return writeFrame(0xa, payload)
      case 0xa: return
      case 0x0:
        if (!fragments) return fail(1002)
        fragments.push(payload)
        if (fin) {
          const whole = Buffer.concat(fragments)
          fragments = null
          deliver(fragmentOpcode, whole)
        }
        return
      case 0x1:
      case 0x2:
        if (!fin) {
          fragments = [payload]
          fragmentOpcode = opcode
          return
        }
        return deliver(opcode, payload)
      default:
        return fail(1002)
    }
  }

  function deliver (opcode, payload) {
    if (opcode === 0x1) conn.emit('text', payload.toString('utf8'))
    else conn.emit('binary', payload)
  }

  function writeFrame (opcode, payload) {
    if (socket.destroyed || socket.writableEnded) return false
    const n = payload.length
    const header = n < 126 ? Buffer.alloc(2) : n < 65536 ? Buffer.alloc(4) : Buffer.alloc(10)
    header[0] = 0x80 | opcode
    if (n < 126) {
      header[1] = n
    } else if (n < 65536) {
      header[1] = 126
      header.writeUInt16BE(n, 2)
    } else {
      header[1] = 127
      header.writeBigUInt64BE(BigInt(n), 2)
    }
    return socket.write(Buffer.concat([header, payload]))
  }

  function fail (code) {
    buf = Buffer.alloc(0)
    conn.close(code)
  }

  conn.socket = socket
  Object.defineProperty(conn, 'destroyed', { get: () => socket.destroyed })
  /** send a text message */
  conn.send = (text) => writeFrame(0x1, Buffer.from(text, 'utf8'))
  /** send a binary message */
  conn.sendBinary = (data) => writeFrame(0x2, data)
  /** close handshake: send close, end the socket once the peer answers (or after 1 s) */
  conn.close = (code = 1000, reason = '') => {
    if (closeSent) return
    closeSent = true
    const payload = Buffer.alloc(2 + Buffer.byteLength(reason))
    payload.writeUInt16BE(code, 0)
    payload.write(reason, 2)
    writeFrame(0x8, payload)
    closeTimer = setTimeout(() => socket.destroy(), 1000)
    closeTimer.unref?.()
  }
  /** drop the TCP connection without a close frame (BeDD gone) */
  conn.destroy = () => socket.destroy()
  return conn
}

let serializer = null
/** bedrock-protocol serializer (ShieldItemID from join_flat's item_registry, when the family has that capture) */
function getSerializer () {
  if (serializer) return serializer
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = createSerializer(TEST_VERSION)
  const shield = fixtures.has('join_flat') && fixtures.load('join_flat').first('item_registry')?.itemstates?.find(s => s.name === 'minecraft:shield')
  if (shield) serializer.proto.setVariable('ShieldItemID', shield.runtime_id)
  return serializer
}

/** packet buffer (varint header + body) for `name` + `params` */
function encodePacket (name, params) {
  return getSerializer().createPacketBuffer({ name, params })
}

/** reject an upgrade request with an HTTP status */
function refuse (socket, status, text) {
  socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`)
}

/**
 * @param {object} [opts] see the module comment; also `token` (default: random 64 hex), `protocol` (ping's, default 2)
 */
async function createFakeBedd (opts = {}) {
  // load named captures now: a capture missing for this family (FixtureMissingError) then rejects here, where the
  // test or hook awaiting createFakeBedd is skipped, instead of later inside the tap connection (an unhandled error
  // and a bot that never spawns)
  opts = { ...opts }
  for (const key of ['journal', 'duringReplay', 'live']) if (typeof opts[key] === 'string') opts[key] = fixtures.load(opts[key]).records
  const fake = new EventEmitter()
  const caps = { ...opts.caps }
  const handlers = { ...opts.handlers }
  let seq = 0n
  let tapConn = null
  const controlClients = new Set()
  const sockets = new Set()

  fake.NO_REPLY = NO_REPLY
  fake.token = opts.token ?? crypto.randomBytes(32).toString('hex')
  fake.url = null // set once listening
  fake.handshakes = []
  fake.calls = []
  fake.caps = caps
  fake.handlers = handlers
  /** game-side state the default handlers read and change */
  fake.state = {
    yaw: 0,
    pitch: 0,
    slot: 0,
    held: [],
    tick: 0,
    inLevel: true,
    mouseGrabbed: true,
    showingMenu: false,
    topScreen: 'hud_screen',
    input: null,
    sendAllow: [9, 77],
    sent: [],
    stacks: []
  }
  fake.framesWritten = 0
  fake.tapConnections = 0

  /** `bedd` createBot options for this fake */
  fake.botOptions = (extra = {}) => ({ url: fake.url, token: fake.token, ...extra })
  fake.callsOf = (op) => fake.calls.filter(c => c.op === op)
  fake.controlClients = controlClients
  /** write `<home>/run/<pid>.json` for this endpoint, as the mod does; returns the file */
  fake.writeRunFile = (home, extra = {}) => {
    const pid = extra.pid ?? process.pid
    const dir = path.join(home, 'run')
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, `${pid}.json`)
    fs.writeFileSync(file, JSON.stringify({ protocol: 2, kind: 'client', pid, url: fake.url, token: fake.token, instance: 'fake-1', instanceDir: home, label: 'fake', modVersion: 'fake', startedAt: new Date().toISOString(), ...extra }))
    return file
  }

  // ---- control --------------------------------------------------------------------------------------
  function modes () {
    const out = {}
    for (const [mode, ops] of Object.entries(MODES)) out[mode] = ops.filter(op => caps[op] !== 'absent')
    return out
  }

  function defaultHandler (op, args, conn) {
    const s = fake.state
    const action = Object.keys(args).length > 0
    switch (op) {
      case 'ping': return { protocol: opts.protocol ?? 2, pid: process.pid, defaultMode: 'bedboo', modes: modes(), hwnd: 0 }
      case 'state': return { clients: controlClients.size, hooks: { receivePacket: true, sendInternal: true } }
      case 'tap': return { enabled: opts.tap !== false, subscribed: !!tapConn, link: { state: 'up', type: 'remote' }, journal: { frames: 0, bytes: 0, complete: true }, counters: { in: 0, out: 0, dropped: 0 }, hooks: { receivePacket: true, sendInternal: true } }
      case 'world': return { inLevel: s.inLevel, levelEpoch: 1, topScreen: s.topScreen, mouseGrabbed: s.mouseGrabbed, showingMenu: s.showingMenu, inputMode: 1, player: { runtimeId: 1, eye: { x: 0, y: 0, z: 0 }, rot: { yaw: s.yaw, pitch: s.pitch }, slot: s.slot }, tick: s.tick }
      case 'look':
        if (!action) return { yaw: s.yaw, pitch: s.pitch }
        s.yaw = args.yaw
        s.pitch = args.pitch
        return { yaw: s.yaw, pitch: s.pitch, tick: ++s.tick }
      case 'input':
        if (!action) return { active: !!s.input, via: 'hooks', hooks: { raw: true, state: true } }
        s.input = args.ttlMs === 0 ? null : args
        return { tick: ++s.tick }
      case 'slot':
        if (!action) return { slot: s.slot }
        s.slot = args.slot
        return { slot: s.slot }
      case 'button':
        if (!action) return { held: [...s.held] }
        if (args.action === 'down' && !s.held.includes(args.button)) s.held.push(args.button)
        if (args.action === 'up') s.held = s.held.filter(b => b !== args.button)
        return { held: [...s.held] }
      case 'action':
        if (!action) return { names: ['drop', 'dropAll', 'inventory', 'perspective', 'pause'] }
        return {}
      case 'send': {
        if (!action) return { allow: [...s.sendAllow] }
        const id = packetIdOf(Buffer.from(args.buf, 'base64'))
        if (ALWAYS_REFUSED.has(id) || !s.sendAllow.includes(id)) throw Object.assign(new Error(`packet id ${id} is not allowed`), { code: 'refused' })
        s.sent.push(args.buf)
        return {}
      }
      case 'stack':
        if (!action) return { enabled: true }
        s.stacks.push(args.buf)
        return { requestIds: [], map: {} }
      default:
        if (BASE_OPS.includes(op)) return {}
        return undefined
    }
  }

  async function answer (req, conn) {
    const { id, op, ...args } = req
    fake.calls.push({ op, args, conn, at: Date.now() })
    fake.emit('call', { op, args, conn })
    const cap = caps[op]
    if (cap === 'absent') return { ok: false, id, error: `unknown op '${op}'` }
    if (cap === 'disabled') return { ok: false, id, error: `${op} is disabled (config.json)`, code: 'disabled', key: op }
    try {
      const reply = handlers[op] ? await handlers[op](args, fake, conn) : defaultHandler(op, args, conn)
      if (reply === NO_REPLY) return NO_REPLY
      if (reply === undefined) return { ok: false, id, error: `unknown op '${op}'` }
      return { ...reply, ok: true, id }
    } catch (err) {
      return { ok: false, id, error: err.message, ...(err.code ? { code: err.code } : {}) }
    }
  }

  /** `{ op: 'tap', action: 'subscribe' }`: the reply, then the tap stream on this connection */
  function subscribe (req, conn) {
    const { id } = req
    if (opts.tap === false || caps.tap === 'disabled') return conn.send(JSON.stringify({ ok: false, id, error: 'tap is disabled (config.json)', code: 'disabled', key: 'tap' }))
    if (caps.tap === 'absent') return conn.send(JSON.stringify({ ok: false, id, error: "unknown op 'tap'" }))
    if (tapConn && !tapConn.destroyed) return conn.send(JSON.stringify({ ok: false, id, error: 'another client is subscribed to the tap', code: 'busy' }))
    conn.send(JSON.stringify({ ok: true, id }))
    tapConn = conn
    controlClients.delete(conn)
    fake.tapConnections++
    conn.on('close', () => {
      if (tapConn === conn) tapConn = null
      fake.emit('tapClose')
    })
    Promise.resolve(opts.onTap ? opts.onTap(fake, conn) : defaultSequence()).then(() => {
      fake.tapReady = Promise.resolve()
      fake.emit('tapReady')
    })
  }

  function onConnection (conn) {
    sockets.add(conn.socket)
    controlClients.add(conn)
    conn.on('close', () => {
      sockets.delete(conn.socket)
      const wasControl = controlClients.delete(conn)
      if (wasControl) fake.emit('controlClose', conn)
    })
    let chain = Promise.resolve()
    conn.on('text', (text) => {
      // one request at a time per connection, like BeDD
      chain = chain.then(async () => {
        let req
        try {
          req = JSON.parse(text)
        } catch {
          return conn.send(JSON.stringify({ ok: false, error: 'not a JSON object' }))
        }
        if (tapConn === conn) return // the tap connection only streams
        if (req?.op === 'tap' && req.action === 'subscribe') return subscribe(req, conn)
        const reply = await answer(req, conn)
        if (reply !== NO_REPLY && !conn.destroyed) conn.send(JSON.stringify(reply))
      })
    })
  }

  const server = http.createServer((req, res) => {
    res.writeHead(426, { Connection: 'close' })
    res.end()
  })
  server.on('connection', (socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {})
    const url = new URL(req.url, 'http://127.0.0.1')
    const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '')?.[1]
    const token = url.searchParams.get('token') ?? bearer
    const attempt = { path: url.pathname, token, origin: req.headers.origin, headers: { ...req.headers } }
    fake.handshakes.push(attempt)
    if (url.pathname !== '/v1') return refuse(socket, 404, 'Not Found')
    if (req.headers.origin !== undefined) return refuse(socket, 403, 'Forbidden')
    if (token !== fake.token) return refuse(socket, 401, 'Unauthorized')
    const key = req.headers['sec-websocket-key']
    if (!key || (req.headers.upgrade ?? '').toLowerCase() !== 'websocket') return refuse(socket, 400, 'Bad Request')
    const accept = crypto.createHash('sha1').update(key + WS_GUID).digest('base64')
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`)
    onConnection(createWsConnection(socket, head))
  })

  // ---- tap ------------------------------------------------------------------------------------------
  /** send one frame to the tap subscriber (no-op without one) */
  fake.sendFrame = (kind, flags, payload) => {
    if (!tapConn || tapConn.destroyed) return false
    fake.framesWritten++
    return tapConn.sendBinary(encodeFrame(kind, flags, payload, { seq: ++seq, tUs: BigInt(Date.now()) * 1000n }))
  }
  /** a MARKER frame */
  fake.sendMarker = (marker, flags = 0) => fake.sendFrame(KIND.MARKER, flags, Buffer.from(JSON.stringify(marker), 'utf8'))
  /** frames from records (see toFrames) */
  fake.sendRecords = (records, { flags = 0 } = {}) => {
    for (const f of toFrames(records, { flags })) fake.sendFrame(f.kind, f.flags, f.payload)
  }
  /** serialize and send a clientbound packet (`dir: 'out'` → an echo) */
  fake.sendPacket = (name, params, { dir = 'in', flags = 0 } = {}) => {
    fake.sendFrame(dir === 'out' ? KIND.SERVERBOUND_ECHO : KIND.CLIENTBOUND, flags, encodePacket(name, params))
  }
  fake.linkUp = (type = 'remote', address = '127.0.0.1:19132') => fake.sendMarker({ m: 'LINK_UP', type, address })
  fake.linkDown = (reason = 'disconnected') => fake.sendMarker({ m: 'LINK_DOWN', reason })
  /** DROPPED, then close the tap connection (as BeDD does past its lag cap) */
  fake.dropped = (count = 1) => {
    fake.sendMarker({ m: 'DROPPED', count })
    tapConn?.close(1000, 'dropped')
  }
  /** drop the tap connection (BeDD gone) */
  fake.closeTap = () => tapConn?.destroy()
  /** resolves once a tap client is subscribed and the initial sequence is written */
  fake.waitForTap = () => fake.tapReady ?? once(fake, 'tapReady')

  fake.hello = () => ({
    m: 'HELLO',
    tap: 1,
    mod: 'fake',
    game: TEST_BDS_BUILD ?? TEST_VERSION + '.01',
    protocol: TEST_PROTOCOL ?? PROTOCOL_VERSION,
    pid: process.pid,
    link: { state: 'up', type: 'remote', address: '127.0.0.1:19132' },
    journal: { frames: journalFrames.length, bytes: journalFrames.reduce((n, f) => n + f.payload.length, 0), complete: opts.journalComplete !== false },
    ...opts.hello
  })

  const journalFrames = toFrames(opts.journal, { flags: FLAG.REPLAY })
  const racingFrames = toFrames(opts.duringReplay)

  async function defaultSequence () {
    fake.sendMarker(fake.hello())
    fake.sendMarker({ m: 'REPLAY_BEGIN', frames: journalFrames.length }, FLAG.REPLAY)
    const every = racingFrames.length ? Math.max(1, Math.floor(journalFrames.length / (racingFrames.length + 1))) : 0
    let raced = 0
    journalFrames.forEach((f, i) => {
      fake.sendFrame(f.kind, f.flags, f.payload)
      if (every && (i + 1) % every === 0 && raced < racingFrames.length) {
        const r = racingFrames[raced++]
        fake.sendFrame(r.kind, r.flags, r.payload)
      }
    })
    for (; raced < racingFrames.length; raced++) fake.sendFrame(racingFrames[raced].kind, racingFrames[raced].flags, racingFrames[raced].payload)
    fake.sendMarker({ m: 'REPLAY_END', complete: opts.journalComplete !== false }, FLAG.REPLAY)
    if (opts.autoLive !== false) fake.sendRecords(opts.live)
  }

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
  fake.port = server.address().port
  fake.url = `ws://127.0.0.1:${fake.port}/v1`

  /** close the endpoint and every connection */
  fake.close = async () => {
    for (const s of sockets) s.destroy()
    if (server.listening) await new Promise(resolve => server.close(() => resolve()))
  }
  return fake
}

module.exports = { createFakeBedd, createWsConnection, toFrames, encodePacket, NO_REPLY, SPEC_OPS, BASE_OPS, MODES }
