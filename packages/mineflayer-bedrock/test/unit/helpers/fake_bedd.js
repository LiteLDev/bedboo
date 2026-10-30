// owner: BEDD-1 (transport 'bedd') — shared by every bedd unit test (free to reuse and extend additively)
'use strict'
/**
 * A fake Be.D.D.: both pipes of the bedd-bedboo wire protocol on an injectable local path (a unix socket in the OS
 * temp directory on Linux/macOS, `\\.\pipe\bedboo-test-<pid>-<n>` on Windows), so `transport: 'bedd'` runs without
 * the game.
 *
 *   const { createFakeBedd } = require('./helpers/fake_bedd')
 *   const fake = await createFakeBedd({ live: 'join_flat' })          // HELLO, empty replay, then join_flat live
 *   const bot = createBot({ transport: 'bedd', bedd: fake.botOptions(), hideErrors: true, logErrors: false })
 *   …
 *   fake.callsOf('look')                // control calls received: [{ op, args, conn, at }]
 *   fake.linkDown('left the world')     // LINK_DOWN marker (the bot ends)
 *   await fake.close()
 *
 * Control pipe (JSON lines `{ id, op, ...args }` → `{ ok, id, ... }`): every op of the spec answers like BeDD
 * (no-argument read form and action form); `caps: { op: 'present' | 'disabled' | 'absent' }` turns an op off or
 * removes it, `handlers: { op: (args, fake, conn) => reply | Promise<reply> }` overrides one (throw an Error with
 * `code` for `{ ok: false, error, code }`; return `fake.NO_REPLY` to never answer). Several control clients may
 * connect at once (pipeInstances).
 *
 * Tap pipe (one client): on connect it writes HELLO (`hello` overrides fields), REPLAY_BEGIN, the `journal` frames
 * (flag replay; `duringReplay` frames are interleaved without the flag, as live frames racing the replay),
 * REPLAY_END (`journalComplete`), then the `live` frames unless `autoLive: false`. Records are fixture records
 * (`{ dir: 'in' | 'out', name, buffer }`: 'in' → CLIENTBOUND, 'out' → SERVERBOUND_ECHO; login, handshakes and
 * request_network_settings are never echoed, as BeDD) or raw frames `{ kind, flags?, payload }`; the string
 * 'join_flat' means every record of that capture. `onTap(fake, socket)` replaces the whole sequence.
 */
const fs = require('fs')
const net = require('net')
const os = require('os')
const path = require('path')
const { EventEmitter, once } = require('events')
const fixtures = require('../../fixtures')
const { encodeFrame, packetIdOf, KIND, FLAG } = require('../../../lib/bedd/tap')
const { PROTOCOL_VERSION } = require('../../../lib/bedrock/constants')

const NO_REPLY = Symbol('no reply')
/** ids BeDD never echoes (login, handshakes, request_network_settings) */
const NEVER_ECHOED = new Set([1, 3, 4, 193])
/** ids `send` always refuses */
const ALWAYS_REFUSED = new Set([1, 30, 144, 147])
const SPEC_OPS = ['tap', 'world', 'look', 'input', 'slot', 'button', 'action', 'send', 'stack']
const BASE_OPS = ['ping', 'state', 'background', 'window', 'focus', 'key', 'text', 'mouse', 'raw', 'release', 'flush']

let counter = 0

/** a fresh local pipe path for this process */
function uniquePath () {
  const name = `bedboo-test-${process.pid}-${++counter}`
  return process.platform === 'win32' ? `\\\\.\\pipe\\${name}` : path.join(os.tmpdir(), `${name}.sock`)
}

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

let serializer = null
/** bedrock-protocol serializer (ShieldItemID from join_flat's item_registry) */
function getSerializer () {
  if (serializer) return serializer
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = createSerializer('1.26.51')
  const shield = fixtures.load('join_flat').first('item_registry')?.itemstates?.find(s => s.name === 'minecraft:shield')
  if (shield) serializer.proto.setVariable('ShieldItemID', shield.runtime_id)
  return serializer
}

/** packet buffer (varint header + body) for `name` + `params` */
function encodePacket (name, params) {
  return getSerializer().createPacketBuffer({ name, params })
}

function listen (server, where) {
  if (process.platform !== 'win32') {
    try { fs.unlinkSync(where) } catch {}
  }
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(where, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })
}

/**
 * @param {object} [opts] see the module comment
 */
async function createFakeBedd (opts = {}) {
  const fake = new EventEmitter()
  const controlPath = opts.path ?? uniquePath()
  const tapPath = opts.tapPath ?? `${controlPath}-tap`
  const caps = { ...opts.caps }
  const handlers = { ...opts.handlers }
  let seq = 0n
  let tapSocket = null
  const controlClients = new Set()
  const sockets = new Set()

  fake.NO_REPLY = NO_REPLY
  fake.path = controlPath
  fake.tapPath = tapPath
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

  /** stream factory for `bedd.connect` */
  fake.connect = (where) => net.connect(where)
  /** `bedd` createBot options for this fake */
  fake.botOptions = (extra = {}) => ({ pipe: controlPath, tapPipe: tapPath, connect: fake.connect, ...extra })
  fake.callsOf = (op) => fake.calls.filter(c => c.op === op)
  fake.controlClients = controlClients

  // ---- control pipe ---------------------------------------------------------------------------------
  function defaultHandler (op, args, conn) {
    const s = fake.state
    const action = Object.keys(args).length > 0
    switch (op) {
      case 'ping': return { protocol: 1, pid: process.pid }
      case 'state': return { clients: controlClients.size, hooks: { receivePacket: true, sendInternal: true } }
      case 'tap': return { enabled: true, pipe: tapPath, attached: !!tapSocket, link: { state: 'up', type: 'remote' }, journal: { frames: 0, bytes: 0, complete: true }, counters: { in: 0, out: 0, dropped: 0 }, hooks: { receivePacket: true, sendInternal: true } }
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
    if (cap === 'disabled') return { ok: false, id, error: `${op} is disabled (config.json)`, code: 'disabled' }
    try {
      const reply = handlers[op] ? await handlers[op](args, fake, conn) : defaultHandler(op, args, conn)
      if (reply === NO_REPLY) return NO_REPLY
      if (reply === undefined) return { ok: false, id, error: `unknown op '${op}'` }
      return { ...reply, ok: true, id }
    } catch (err) {
      return { ok: false, id, error: err.message, ...(err.code ? { code: err.code } : {}) }
    }
  }

  const control = net.createServer((socket) => {
    sockets.add(socket)
    controlClients.add(socket)
    socket.on('close', () => {
      sockets.delete(socket)
      controlClients.delete(socket)
      fake.emit('controlClose', socket)
    })
    socket.on('error', () => {})
    let buffer = ''
    let chain = Promise.resolve()
    socket.setEncoding('utf8')
    socket.on('data', (chunk) => {
      buffer += chunk
      let nl
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        if (!line.trim()) continue
        // one request at a time per connection, like BeDD's serveClient
        chain = chain.then(async () => {
          let req
          try {
            req = JSON.parse(line)
          } catch {
            return socket.write(JSON.stringify({ ok: false, error: 'not a JSON object' }) + '\n')
          }
          const reply = await answer(req, socket)
          if (reply !== NO_REPLY && !socket.destroyed) socket.write(JSON.stringify(reply) + '\n')
        })
      }
    })
  })

  // ---- tap pipe -------------------------------------------------------------------------------------
  /** write one frame to the tap client (no-op without one) */
  fake.sendFrame = (kind, flags, payload) => {
    if (!tapSocket || tapSocket.destroyed) return false
    fake.framesWritten++
    return tapSocket.write(encodeFrame(kind, flags, payload, { seq: ++seq, tUs: BigInt(Date.now()) * 1000n }))
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
  /** DROPPED, then close the tap (as BeDD does past its lag cap) */
  fake.dropped = (count = 1) => {
    fake.sendMarker({ m: 'DROPPED', count })
    tapSocket?.end()
  }
  /** close the tap connection (BeDD gone) */
  fake.closeTap = () => tapSocket?.destroy()
  /** resolves once a tap client is connected and the initial sequence is written */
  fake.waitForTap = () => fake.tapReady ?? once(fake, 'tapReady')

  fake.hello = () => ({
    m: 'HELLO',
    tap: 1,
    mod: 'fake',
    game: '1.26.51.01',
    protocol: PROTOCOL_VERSION,
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

  const tap = net.createServer((socket) => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => {})
    if (tapSocket && !tapSocket.destroyed) return socket.destroy() // single client
    tapSocket = socket
    fake.tapConnections++
    socket.on('close', () => {
      if (tapSocket === socket) tapSocket = null
      fake.emit('tapClose')
    })
    Promise.resolve(opts.onTap ? opts.onTap(fake, socket) : defaultSequence()).then(() => {
      fake.tapReady = Promise.resolve()
      fake.emit('tapReady')
    })
  })

  await listen(control, controlPath)
  if (opts.tap !== false) await listen(tap, tapPath)

  /** close both pipes and every connection */
  fake.close = async () => {
    for (const s of sockets) s.destroy()
    await Promise.all([control, tap].map(server => server.listening ? new Promise(resolve => server.close(() => resolve())) : null))
    if (process.platform !== 'win32') {
      for (const p of [controlPath, tapPath]) try { fs.unlinkSync(p) } catch {}
    }
  }
  return fake
}

module.exports = { createFakeBedd, uniquePath, toFrames, encodePacket, NO_REPLY, SPEC_OPS, BASE_OPS }
