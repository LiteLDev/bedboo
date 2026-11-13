'use strict'
/**
 * WebSocket plumbing shared by the control connection (rpc.js) and the tap subscription (tap.js).
 *
 * BeDD v2 serves `ws://127.0.0.1:<port>/v1` and authenticates with `?token=<token>` (or `Authorization: Bearer`);
 * it refuses any handshake that carries an `Origin` header. Node's global WebSocket (undici, Node ≥ 22) sends none,
 * so no dependency is needed. `WebSocket` can be injected (tests, other runtimes).
 */

/** `url` with `?token=` set */
function socketUrl (url, token) {
  const u = new URL(url)
  if (token) u.searchParams.set('token', token)
  return u.href
}

/** `url` without its token, for messages */
function redactUrl (url) {
  try {
    const u = new URL(url)
    if (u.searchParams.has('token')) u.searchParams.set('token', '…')
    return u.href
  } catch {
    return String(url)
  }
}

/** the WebSocket class to use: injected, else Node's global one */
function webSocketClass (injected) {
  const WS = injected ?? globalThis.WebSocket
  if (typeof WS !== 'function') throw Object.assign(new Error('no WebSocket implementation: bedboo needs Node.js 24'), { code: 'ERR_BEDD_CONNECT' })
  return WS
}

/** the text of a WebSocket error event */
function eventMessage (ev) {
  return ev?.error?.message || ev?.message || 'connection failed'
}

/** Buffer from a message's binary data (ArrayBuffer, a view, or a Buffer) */
function toBuffer (data) {
  if (Buffer.isBuffer(data)) return data
  if (data instanceof ArrayBuffer) return Buffer.from(data)
  if (ArrayBuffer.isView(data)) return Buffer.from(data.buffer, data.byteOffset, data.byteLength)
  return Buffer.from(String(data), 'utf8')
}

module.exports = { socketUrl, redactUrl, webSocketClass, eventMessage, toBuffer }
