// owner: BEDD-1 (transport 'bedd': control RPC, tap reader, client)
'use strict'
/**
 * Be.D.D. control pipe client (docs: bedd-bedboo spec, wire protocol B).
 *
 * JSON lines over a Duplex: a request is `{ id, op, ...args }`, the reply `{ ok, id, ... }` (errors:
 * `{ ok: false, id, error, code? }`). BeDD serves one request at a time per connection, so this client keeps a
 * FIFO with exactly one request in flight; a reply whose id does not match the request in flight (the late answer
 * to a request that timed out) is dropped.
 *
 *   const rpc = createRpc({ path: '\\\\.\\pipe\\BeDD' })      // or { connect: (path) => Duplex }
 *   await rpc.open()
 *   await rpc.call('look', { yaw: 90, pitch: 0 })            // → reply object (ok: true)
 *   await rpc.probe('look')                                  // → 'present' | 'disabled' | 'absent'
 *
 * Rejections are Errors with `code` (BeDD's reply `code` — 'disabled', 'not_in_level', 'refused', 'timeout',
 * 'bad_args', 'busy' — or 'ERR_BEDD_RPC' when the reply has none, 'ERR_BEDD_RPC_TIMEOUT' when no reply came in
 * time, 'ERR_BEDD_RPC_CLOSED' when the pipe is gone), `op` and `reply` (the raw reply, when there was one).
 */
const net = require('net')
const { EventEmitter } = require('events')

/** control pipe protocol version answered by `ping` (BeDD kProtocol) */
const CONTROL_PROTOCOL = 1
const DEFAULT_TIMEOUT_MS = 5000
/** extra time over an op's own `timeoutMs` argument (look waits up to timeoutMs for convergence) */
const TIMEOUT_SLACK_MS = 2000

function rpcError (message, code, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

/**
 * @param {object} opts
 * @param {string} [opts.path] control pipe path (`\\.\pipe\<name>` on Windows, a unix socket path elsewhere)
 * @param {(path: string) => import('stream').Duplex} [opts.connect] stream factory (default `net.connect`)
 * @param {number} [opts.timeoutMs] default per-request timeout (5000)
 */
function createRpc ({ path, connect, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const rpc = new EventEmitter()
  const queue = [] // { id, op, line, timeoutMs, resolve, reject }
  let stream = null
  let inFlight = null
  let timer = null
  let nextId = 1
  let buffer = ''
  let closed = false
  let opening = null

  rpc.path = path
  rpc.connected = false

  /** connect the stream; resolves once connected, rejects on a connection error */
  rpc.open = function open () {
    if (opening) return opening
    opening = new Promise((resolve, reject) => {
      if (closed) return reject(rpcError('BeDD control pipe closed', 'ERR_BEDD_RPC_CLOSED'))
      let failed = false
      let connectTimer = null
      const onConnectError = (err) => {
        if (failed) return
        failed = true
        clearTimeout(connectTimer)
        closed = true
        failAll(rpcError(`BeDD control pipe ${path}: ${err.message}`, 'ERR_BEDD_RPC_CLOSED', { cause: err }))
        stream?.destroy?.()
        reject(Object.assign(err, { path }))
      }
      let s
      try {
        s = (connect ?? net.connect)(path)
      } catch (err) {
        return onConnectError(err)
      }
      stream = s
      s.setEncoding?.('utf8')
      const onConnect = () => {
        if (failed || closed) return
        clearTimeout(connectTimer)
        rpc.connected = true
        s.on('close', onClose)
        s.on('data', onData)
        resolve(rpc)
        pump()
      }
      // errors after the connect are warnings (the 'close' that follows fails the pending calls)
      s.on('error', (err) => {
        if (!rpc.connected) return onConnectError(err)
        rpc.emit('warning', rpcError(`BeDD control pipe: ${err.message}`, 'ERR_BEDD_RPC_CLOSED', { cause: err }))
      })
      // a pipe whose instances are all busy can keep a Windows connect waiting: bound it like a request
      connectTimer = setTimeout(() => onConnectError(rpcError(`connect timed out after ${timeoutMs} ms`, 'ERR_BEDD_RPC_TIMEOUT')), timeoutMs)
      connectTimer.unref?.()
      whenConnected(s, onConnect)
    })
    return opening
  }

  function onData (chunk) {
    buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8')
    let nl
    while ((nl = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, nl).trim()
      buffer = buffer.slice(nl + 1)
      if (!line) continue
      let reply
      try {
        reply = JSON.parse(line)
      } catch {
        rpc.emit('warning', rpcError(`BeDD control pipe: bad reply line ${JSON.stringify(line.slice(0, 200))}`, 'ERR_BEDD_RPC'))
        continue
      }
      onReply(reply)
    }
  }

  function onReply (reply) {
    if (!inFlight || reply?.id !== inFlight.id) return // late answer to a request that timed out
    const req = inFlight
    finish()
    if (reply.ok) {
      req.resolve(reply)
    } else {
      const message = typeof reply.error === 'string' ? reply.error : `BeDD op '${req.op}' failed`
      req.reject(rpcError(message, reply.code || 'ERR_BEDD_RPC', { op: req.op, reply }))
    }
    pump()
  }

  function finish () {
    clearTimeout(timer)
    timer = null
    inFlight = null
  }

  function pump () {
    if (inFlight || !rpc.connected || closed || queue.length === 0) return
    const req = queue.shift()
    inFlight = req
    timer = setTimeout(() => {
      if (inFlight !== req) return
      finish()
      req.reject(rpcError(`BeDD op '${req.op}' timed out after ${req.timeoutMs} ms`, 'ERR_BEDD_RPC_TIMEOUT', { op: req.op }))
      pump()
    }, req.timeoutMs)
    timer.unref?.()
    stream.write(req.line)
  }

  function failAll (err) {
    const pending = inFlight ? [inFlight, ...queue] : [...queue]
    finish()
    queue.length = 0
    for (const req of pending) req.reject(Object.assign(new Error(err.message), { code: err.code, op: req.op, cause: err.cause }))
  }

  function onClose () {
    const wasClosed = closed
    closed = true
    rpc.connected = false
    failAll(rpcError('BeDD control pipe closed', 'ERR_BEDD_RPC_CLOSED'))
    if (!wasClosed) rpc.emit('close')
  }

  /**
   * Send `{ id, op, ...args }`; resolves with the reply when `ok`, rejects otherwise (see the module comment).
   * @param {string} op
   * @param {object} [args]
   * @param {{ timeoutMs?: number }} [opts]
   */
  rpc.call = function call (op, args = {}, opts = {}) {
    return new Promise((resolve, reject) => {
      if (closed) return reject(rpcError('BeDD control pipe closed', 'ERR_BEDD_RPC_CLOSED', { op }))
      const id = nextId++
      const line = JSON.stringify({ ...args, id, op }) + '\n'
      const opTimeout = typeof args?.timeoutMs === 'number' ? args.timeoutMs + TIMEOUT_SLACK_MS : 0
      const ms = opts.timeoutMs ?? Math.max(timeoutMs, opTimeout)
      queue.push({ id, op, line, timeoutMs: ms, resolve, reject })
      if (!opening) rpc.open().catch(() => {}) // lazily connect; the failure rejects the queued request
      pump()
    })
  }

  /**
   * Capability negotiation: call `op` with no arguments. `ok` → 'present'; `code: 'disabled'` → 'disabled'
   * (present but off in BeDD's config.json); `unknown op` (or no answer / no pipe) → 'absent'. Any other error
   * (e.g. 'not_in_level') means the op exists → 'present'.
   * @param {string} op
   * @returns {Promise<'present'|'disabled'|'absent'>}
   */
  rpc.probe = async function probe (op, opts) {
    try {
      await rpc.call(op, {}, opts)
      return 'present'
    } catch (err) {
      return probeResult(err)
    }
  }

  /** detach: close the stream (BeDD releases the keys, buttons and move override this connection holds) */
  rpc.close = function close () {
    if (closed && !stream) return
    closed = true
    rpc.connected = false
    failAll(rpcError('BeDD control pipe closed', 'ERR_BEDD_RPC_CLOSED'))
    const s = stream
    stream = null
    if (s) {
      s.removeListener('data', onData)
      s.on('error', () => {})
      s.end?.()
      s.destroy?.()
    }
  }

  return rpc
}

/**
 * Run `fn` once `stream` is connected: a connecting net.Socket emits 'connect'; any other Duplex (an injected,
 * already connected stream) counts as connected on the next turn.
 */
function whenConnected (stream, fn) {
  if (stream.connecting === true) stream.once('connect', fn)
  else setImmediate(fn)
}

/** @returns {'present'|'disabled'|'absent'} the capability a probe error means */
function probeResult (err) {
  if (err?.code === 'disabled') return 'disabled'
  if (/unknown op/i.test(err?.message ?? '')) return 'absent'
  if (err?.code === 'ERR_BEDD_RPC_TIMEOUT' || err?.code === 'ERR_BEDD_RPC_CLOSED' || err?.reply === undefined) return 'absent'
  return 'present'
}

module.exports = { createRpc, probeResult, whenConnected, CONTROL_PROTOCOL, DEFAULT_TIMEOUT_MS }
