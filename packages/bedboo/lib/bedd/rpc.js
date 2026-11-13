'use strict'
/**
 * Be.D.D. control connection (BeDD v2: one WebSocket, JSON text frames).
 *
 * A request is `{ id, op, ...args }`, the reply `{ ok, id, ... }` (errors: `{ ok: false, id, error, code? }`), one
 * text frame each. BeDD serves one request at a time per connection, so this client keeps a FIFO with exactly one
 * request in flight; a reply whose id does not match the request in flight (the late answer to a request that timed
 * out) is dropped.
 *
 *   const rpc = createRpc({ url: 'ws://127.0.0.1:53021/v1', token })   // or { …, WebSocket: class }
 *   await rpc.open()
 *   await rpc.call('look', { yaw: 90, pitch: 0 })            // → reply object (ok: true)
 *   await rpc.probe('look')                                  // → 'present' | 'disabled' | 'absent'
 *
 * Rejections are Errors with `code` (BeDD's reply `code` — 'disabled', 'not_in_level', 'refused', 'timeout',
 * 'bad_args', 'busy' — or 'ERR_BEDD_RPC' when the reply has none, 'ERR_BEDD_RPC_TIMEOUT' when no reply came in
 * time, 'ERR_BEDD_RPC_CLOSED' when the connection is gone or could not be made), `op` and `reply` (the raw reply,
 * when there was one).
 */
const { EventEmitter } = require('events')
const { socketUrl, redactUrl, webSocketClass, eventMessage } = require('./ws')

/** control protocol version answered by `ping` (BeDD v2: WebSocket) */
const CONTROL_PROTOCOL = 2
const DEFAULT_TIMEOUT_MS = 5000
/** extra time over an op's own `timeoutMs` argument (look waits up to timeoutMs for convergence) */
const TIMEOUT_SLACK_MS = 2000

function rpcError (message, code, extra) {
  return Object.assign(new Error(message), { code }, extra)
}

/**
 * @param {object} opts
 * @param {string} [opts.url] BeDD endpoint (`ws://127.0.0.1:<port>/v1`)
 * @param {string} [opts.token] its token (sent as `?token=`)
 * @param {Error} [opts.error] why there is no endpoint (discovery failed): open() rejects with it
 * @param {typeof WebSocket} [opts.WebSocket] WebSocket class (default Node's global one)
 * @param {number} [opts.timeoutMs] default per-request timeout (5000), also bounds the handshake
 */
function createRpc ({ url, token, error, WebSocket, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const rpc = new EventEmitter()
  const queue = [] // { id, op, text, timeoutMs, resolve, reject }
  let ws = null
  let inFlight = null
  let timer = null
  let nextId = 1
  let closed = false
  let opening = null

  rpc.url = url ? redactUrl(url) : undefined
  rpc.connected = false

  /** connect the WebSocket; resolves once open, rejects when the handshake fails */
  rpc.open = function open () {
    if (opening) return opening
    opening = new Promise((resolve, reject) => {
      if (closed) return reject(rpcError('BeDD control connection closed', 'ERR_BEDD_RPC_CLOSED'))
      let failed = false
      let connectTimer = null
      const onConnectError = (err) => {
        if (failed) return
        failed = true
        clearTimeout(connectTimer)
        closed = true
        failAll(rpcError(`BeDD control connection${rpc.url ? ` ${rpc.url}` : ''}: ${err.message}`, 'ERR_BEDD_RPC_CLOSED', { cause: err }))
        const s = ws
        ws = null
        try { s?.close() } catch {}
        reject(Object.assign(err, { url: rpc.url }))
      }
      if (error) return onConnectError(error)
      let s
      try {
        const WS = webSocketClass(WebSocket)
        s = new WS(socketUrl(url, token))
      } catch (err) {
        return onConnectError(err)
      }
      ws = s
      s.addEventListener('open', () => {
        if (failed || closed) return
        clearTimeout(connectTimer)
        rpc.connected = true
        resolve(rpc)
        pump()
      })
      s.addEventListener('message', onMessage)
      // an error after the handshake is followed by 'close', which fails the pending calls and is reported
      s.addEventListener('error', (ev) => {
        if (!rpc.connected) onConnectError(rpcError(`${eventMessage(ev)} (is the game running, is the token right?)`, 'ERR_BEDD_CONNECT'))
      })
      s.addEventListener('close', (ev) => {
        if (!rpc.connected) return onConnectError(rpcError(`closed during the handshake (code ${ev?.code})`, 'ERR_BEDD_CONNECT'))
        onClose()
      })
      connectTimer = setTimeout(() => onConnectError(rpcError(`connect timed out after ${timeoutMs} ms`, 'ERR_BEDD_RPC_TIMEOUT')), timeoutMs)
      connectTimer.unref?.()
    })
    return opening
  }

  function onMessage (ev) {
    if (typeof ev.data !== 'string') {
      rpc.emit('warning', rpcError('BeDD control connection: unexpected binary message', 'ERR_BEDD_RPC'))
      return
    }
    let reply
    try {
      reply = JSON.parse(ev.data)
    } catch {
      rpc.emit('warning', rpcError(`BeDD control connection: bad reply ${JSON.stringify(ev.data.slice(0, 200))}`, 'ERR_BEDD_RPC'))
      return
    }
    onReply(reply)
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
    try {
      ws.send(req.text)
    } catch (err) {
      finish()
      req.reject(rpcError(`BeDD op '${req.op}': ${err.message}`, 'ERR_BEDD_RPC_CLOSED', { op: req.op, cause: err }))
      pump()
    }
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
    ws = null
    failAll(rpcError('BeDD control connection closed', 'ERR_BEDD_RPC_CLOSED'))
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
      if (closed) return reject(rpcError('BeDD control connection closed', 'ERR_BEDD_RPC_CLOSED', { op }))
      const id = nextId++
      const text = JSON.stringify({ ...args, id, op })
      const opTimeout = typeof args?.timeoutMs === 'number' ? args.timeoutMs + TIMEOUT_SLACK_MS : 0
      const ms = opts.timeoutMs ?? Math.max(timeoutMs, opTimeout)
      queue.push({ id, op, text, timeoutMs: ms, resolve, reject })
      if (!opening) rpc.open().catch(() => {}) // lazily connect; the failure rejects the queued request
      pump()
    })
  }

  /**
   * Capability negotiation: call `op` with no arguments. `ok` → 'present'; `code: 'disabled'` → 'disabled'
   * (present but off in BeDD's config.json); `unknown op` (or no answer / no connection) → 'absent'. Any other
   * error (e.g. 'not_in_level') means the op exists → 'present'.
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

  /** detach: close the WebSocket (BeDD releases the keys, buttons and move override this connection holds) */
  rpc.close = function close () {
    if (closed && !ws) return
    closed = true
    rpc.connected = false
    failAll(rpcError('BeDD control connection closed', 'ERR_BEDD_RPC_CLOSED'))
    const s = ws
    ws = null
    if (s) {
      s.removeEventListener('message', onMessage)
      try { s.close(1000) } catch {}
    }
  }

  return rpc
}

/** @returns {'present'|'disabled'|'absent'} the capability a probe error means */
function probeResult (err) {
  if (err?.code === 'disabled') return 'disabled'
  if (/unknown op/i.test(err?.message ?? '')) return 'absent'
  if (err?.code === 'ERR_BEDD_RPC_TIMEOUT' || err?.code === 'ERR_BEDD_RPC_CLOSED' || err?.reply === undefined) return 'absent'
  return 'present'
}

module.exports = { createRpc, probeResult, CONTROL_PROTOCOL, DEFAULT_TIMEOUT_MS }
