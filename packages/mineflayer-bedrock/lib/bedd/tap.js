// owner: BEDD-1 (transport 'bedd': control RPC, tap reader, client)
'use strict'
/**
 * Be.D.D. tap pipe reader (docs: bedd-bedboo spec, wire protocol A).
 *
 * Frame (little-endian): `u32 len | u8 kind | u8 flags | u16 reserved | u64 seq | u64 tUs | payload`, where `len`
 * counts the bytes after itself (20 header bytes + payload). Kinds: 1 CLIENTBOUND and 2 SERVERBOUND_ECHO carry one
 * game packet (varint header + body, what bedrock-protocol's deserializer reads), 4 MARKER carries UTF-8 JSON.
 * Other kinds are ignored. Flags: 1 replay, 2 reserialized, 4 local link, 8 suppressed.
 *
 * Order on connect: HELLO, REPLAY_BEGIN, journal frames (flag replay), REPLAY_END, live stream. Live frames (and
 * markers) that reach the reader between REPLAY_BEGIN and REPLAY_END are held back until REPLAY_END.
 *
 *   const reader = createTapReader(stream, { version: '1.26.51', protocol: 2193 })
 *   reader.on('hello', (hello) => …)            // accepted HELLO (tap === 1, protocol matches)
 *   reader.on('marker', (marker) => …)          // every marker, HELLO and REPLAY_* included
 *   reader.on('packet', (packet) => …)          // { kind, name, params, des, buffer, seq, tUs, flags, replay, reserialized, local }
 *   reader.on('warning', (err) => …)            // a packet that did not decode (skipped; the stream goes on)
 *   reader.on('error', (err) => …)              // bad HELLO / framing: the reader closes the stream
 *   reader.on('close', () => …)
 */
const { EventEmitter } = require('events')

const KIND = Object.freeze({ CLIENTBOUND: 1, SERVERBOUND_ECHO: 2, MARKER: 4 })
const FLAG = Object.freeze({ REPLAY: 1, RESERIALIZED: 2, LOCAL: 4, SUPPRESSED: 8 })
const HEADER_BYTES = 20
/** largest `len`: 16 MiB payload + the 20 header bytes */
const MAX_LEN = 16 * 1024 * 1024 + HEADER_BYTES
/** tap protocol version in HELLO.tap */
const TAP_VERSION = 1

function tapError (message, code, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

/**
 * bedrock-protocol deserializer for tap payloads. Item-bearing packets need the `ShieldItemID` protodef variable:
 * it is set from start_game / item_registry as they pass, like bedrock-protocol's Client#readPacket (and
 * test/fixtures/index.js) do.
 * @param {string} version bedrock-protocol version ('1.26.51')
 */
function createPacketDecoder (version) {
  const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  const deserializer = createDeserializer(version)
  return {
    deserializer,
    /** @param {Buffer} buffer varint header + body → bedrock-protocol `des` ({ data: { name, params }, … }) */
    decode (buffer) {
      const des = deserializer.parsePacketBuffer(buffer)
      const name = des.data.name
      if (name === 'start_game' || name === 'item_registry') {
        for (const state of des.data.params?.itemstates ?? []) {
          if (state.name === 'minecraft:shield') deserializer.proto.setVariable('ShieldItemID', state.runtime_id)
        }
      }
      return des
    }
  }
}

/** varint packet id of a game packet buffer (low 10 bits of the header) */
function packetIdOf (buffer) {
  let value = 0
  for (let i = 0, shift = 0; i < buffer.length && i < 5; i++, shift += 7) {
    const c = buffer[i]
    value |= (c & 0x7f) << shift
    if (!(c & 0x80)) break
  }
  return value & 0x3ff
}

/**
 * Incremental frame parser: push(chunk) → complete frames.
 * @returns {{ push(chunk: Buffer): Array<{ kind: number, flags: number, seq: bigint, tUs: bigint, payload: Buffer }> }}
 */
function createFrameParser ({ maxLen = MAX_LEN } = {}) {
  const chunks = []
  let total = 0
  function take (n) {
    const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, total)
    chunks.length = 0
    const out = all.subarray(0, n)
    const rest = all.subarray(n)
    total = rest.length
    if (total) chunks.push(rest)
    return out
  }
  function peekLen () {
    if (chunks[0].length >= 4) return chunks[0].readUInt32LE(0)
    const head = Buffer.concat(chunks, total)
    chunks.length = 0
    chunks.push(head)
    return head.readUInt32LE(0)
  }
  return {
    push (chunk) {
      if (chunk.length) {
        chunks.push(chunk)
        total += chunk.length
      }
      const frames = []
      while (total >= 4) {
        const len = peekLen()
        if (len < HEADER_BYTES || len > maxLen) throw tapError(`BeDD tap: bad frame length ${len}`, 'ERR_BEDD_TAP_FRAME')
        if (total < 4 + len) break
        const frame = take(4 + len)
        frames.push({
          kind: frame.readUInt8(4),
          flags: frame.readUInt8(5),
          seq: frame.readBigUInt64LE(8),
          tUs: frame.readBigUInt64LE(16),
          payload: frame.subarray(24)
        })
      }
      return frames
    }
  }
}

/** Encode one frame (used by test fakes and tools). */
function encodeFrame (kind, flags, payload, { seq = 0n, tUs = 0n } = {}) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8')
  const frame = Buffer.alloc(4 + HEADER_BYTES + body.length)
  frame.writeUInt32LE(HEADER_BYTES + body.length, 0)
  frame.writeUInt8(kind, 4)
  frame.writeUInt8(flags, 5)
  frame.writeUInt16LE(0, 6)
  frame.writeBigUInt64LE(BigInt(seq), 8)
  frame.writeBigUInt64LE(BigInt(tUs), 16)
  body.copy(frame, 24)
  return frame
}

/**
 * @param {import('stream').Duplex} stream the connected tap pipe
 * @param {object} opts
 * @param {string} opts.version bedrock-protocol version for the deserializer
 * @param {number} opts.protocol expected HELLO.protocol (the registry's protocol version, 2193)
 * @param {{ decode(buffer: Buffer): any }} [opts.decoder] packet decoder (default createPacketDecoder(version))
 */
function createTapReader (stream, { version, protocol, decoder } = {}) {
  const reader = new EventEmitter()
  const parser = createFrameParser()
  let hello = null
  let replaying = false
  let held = [] // live frames that arrived during the replay
  let closed = false
  decoder = decoder ?? createPacketDecoder(version)

  reader.hello = null
  reader.stream = stream

  stream.on('data', onData)
  stream.on('error', (err) => {
    if (closed) return
    reader.emit('warning', tapError(`BeDD tap: ${err.message}`, 'ERR_BEDD_TAP_CLOSED', { cause: err }))
  })
  stream.on('close', () => finish())
  stream.on('end', () => finish())

  function onData (chunk) {
    if (closed) return
    let frames
    try {
      frames = parser.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    } catch (err) {
      return fail(err)
    }
    for (const frame of frames) {
      if (closed) return
      onFrame(frame)
    }
  }

  function onFrame (frame) {
    if (!hello) {
      const marker = frame.kind === KIND.MARKER ? parseMarker(frame) : null
      if (!marker || marker.m !== 'HELLO') return fail(tapError('BeDD tap: the first frame is not HELLO', 'ERR_BEDD_HELLO'))
      if (marker.tap !== TAP_VERSION) return fail(tapError(`BeDD tap: unsupported tap version ${marker.tap} (expected ${TAP_VERSION})`, 'ERR_BEDD_HELLO', { hello: marker }))
      if (protocol !== undefined && marker.protocol !== protocol) {
        return fail(tapError(`BeDD tap: the game speaks protocol ${marker.protocol} (game ${marker.game}), bedboo needs ${protocol}`, 'ERR_BEDD_PROTOCOL', { hello: marker }))
      }
      hello = marker
      reader.hello = marker
      reader.emit('hello', marker)
      reader.emit('marker', marker)
      return
    }
    if (frame.kind === KIND.MARKER) {
      const marker = parseMarker(frame)
      if (!marker) return
      if (marker.m === 'REPLAY_BEGIN') {
        replaying = true
        return deliverMarker(marker)
      }
      if (marker.m === 'REPLAY_END') {
        replaying = false
        deliverMarker(marker)
        const backlog = held
        held = []
        for (const f of backlog) {
          if (closed) return
          deliver(f)
        }
        return
      }
      if (replaying && !(frame.flags & FLAG.REPLAY)) return held.push({ marker, frame })
      return deliverMarker(marker)
    }
    if (frame.kind !== KIND.CLIENTBOUND && frame.kind !== KIND.SERVERBOUND_ECHO) return // other kinds: ignored
    if (replaying && !(frame.flags & FLAG.REPLAY)) return held.push({ frame })
    deliverPacket(frame)
  }

  function deliver ({ marker, frame }) {
    if (marker) deliverMarker(marker)
    else deliverPacket(frame)
  }

  function deliverMarker (marker) {
    reader.emit('marker', marker)
  }

  function deliverPacket (frame) {
    let des
    try {
      des = decoder.decode(frame.payload)
    } catch (err) {
      const id = packetIdOf(frame.payload)
      reader.emit('warning', tapError(`BeDD tap: packet id ${id} (seq ${frame.seq}) did not decode: ${err.message}`, 'ERR_BEDD_TAP_DECODE', { cause: err, packetId: id, seq: frame.seq }))
      return
    }
    reader.emit('packet', {
      kind: frame.kind,
      name: des.data.name,
      params: des.data.params,
      des,
      buffer: frame.payload,
      seq: frame.seq,
      tUs: frame.tUs,
      flags: frame.flags,
      replay: !!(frame.flags & FLAG.REPLAY),
      reserialized: !!(frame.flags & FLAG.RESERIALIZED),
      local: !!(frame.flags & FLAG.LOCAL)
    })
  }

  function parseMarker (frame) {
    try {
      const marker = JSON.parse(frame.payload.toString('utf8'))
      if (marker && typeof marker === 'object' && typeof marker.m === 'string') return marker
    } catch {}
    reader.emit('warning', tapError(`BeDD tap: bad marker (seq ${frame.seq})`, 'ERR_BEDD_TAP_MARKER'))
    return null
  }

  function fail (err) {
    if (closed) return
    reader.emit('error', err)
    reader.close()
  }

  function finish () {
    if (closed) return
    closed = true
    stream.removeListener('data', onData)
    reader.emit('close')
  }

  /** stop reading and close the stream */
  reader.close = function close () {
    if (closed) return
    stream.removeListener('data', onData)
    stream.on('error', () => {})
    stream.destroy?.()
    finish()
  }

  return reader
}

module.exports = { createTapReader, createFrameParser, createPacketDecoder, encodeFrame, packetIdOf, KIND, FLAG, HEADER_BYTES, MAX_LEN, TAP_VERSION }
