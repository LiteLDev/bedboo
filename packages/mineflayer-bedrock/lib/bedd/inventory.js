// owner: BEDD-7 (inventory routing through BeDD's `stack` op)
'use strict'

/**
 * bedd mode: bedboo's item stack requests (clickWindow, transfer, craft, equip, creative, …) are submitted by the
 * real client through BeDD's `stack` op, which hands them to the client's own ItemStackNetManager. The client assigns
 * its own request ids, so this module keeps the bedboo ↔ client request id map that lets the item_stack_response the
 * tap delivers (carrying the client's id) settle bedboo's pending request in lib/bedrock/stack_request.js.
 * bot.inventory / windows follow from the tapped clientbound packets as usual.
 *
 * Wire: `stack { buf }` with buf = base64 of a serialized item_stack_request packet (varint header + body, one
 * request) → `{ ok, via, requestIds: [clientId], map: { '<bedbooRequestId>': clientId } }`.
 * - Outgoing stack ids that name an earlier bedboo request (< 0, the pending-request convention) are rewritten to that
 *   request's client id. A stack id equal to the request's own id (a slot changed earlier in the same request) is
 *   left as bedboo's id: BeDD substitutes it with the id the client assigns (it is the key of the reply's `map`).
 * - The response can reach the tap before the `stack` reply: while a call is in flight, unknown responses are held
 *   and re-emitted once the reply names their client id; the rest (the user's own clicks in the real client) never
 *   match a bedboo request, even when their ids collide.
 * - caps.stack not 'present' (or a `disabled` / unknown-op reply) → the request is rejected with a
 *   BeddUnsupportedError (code ERR_BEDD_UNSUPPORTED); any other failure → a StackRequestError (outcome 'error').
 * - Map entries are cleared when the response arrives, or moved to a short late list on timeout (so a late answer
 *   is still reported as 'late-ok' / 'late-error').
 *
 * Registered as the `item_stack_request` route in the shared registry (./routes.js): the router dispatches a
 * standalone item_stack_request and the one embedded in player_auth_input under that name; handlers are called as
 * `handler(params, ctx)` with params = `{ requests }`.
 * All `stack` calls run one after another (the control pipe answers one request at a time, and a later request's
 * stack ids can name an earlier one, whose client id must be known first).
 */

const { VERSION } = require('../bedrock/constants')
const { StackRequestError } = require('../bedrock/stack_request')
const { ensureDispatch, handlersFor } = require('./routes')

const MAX_LATE = 64
/** a held response (tapped before the `stack` reply named its client id) is dropped after this long, or past MAX_HELD */
const HELD_MS = 10000
const MAX_HELD = 256
const MAX_HISTORY = 128
const ATTACHED = Symbol.for('bedboo.bedd.inventory')

let BeddUnsupportedError
try {
  BeddUnsupportedError = require('./errors').BeddUnsupportedError
} catch (err) {
  if (err.code !== 'MODULE_NOT_FOUND' || !String(err.message).includes('errors')) throw err
}
if (typeof BeddUnsupportedError !== 'function') {
  // minimal stand-in until lib/bedd/errors.js (BEDD-5) is present
  BeddUnsupportedError = class BeddUnsupportedError extends Error {
    constructor (feature, { missing = [], reason } = {}) {
      super(`${feature} is not supported with transport 'bedd': ${reason ?? `missing BeDD op(s) ${missing.join(', ')}`}`)
      this.name = 'BeddUnsupportedError'
      this.code = 'ERR_BEDD_UNSUPPORTED'
      this.bedd = true
      this.feature = feature
      this.missing = missing
    }
  }
}

function unsupported (reason) {
  let err
  try {
    err = new BeddUnsupportedError('item_stack_request', { missing: ['stack'], reason })
  } catch {
    err = new Error(`item_stack_request is not supported with transport 'bedd': ${reason}`)
  }
  // whatever the constructor shape, the contract fields are there
  err.code = 'ERR_BEDD_UNSUPPORTED'
  err.bedd = true
  if (typeof err.feature !== 'string') err.feature = 'item_stack_request'
  if (!Array.isArray(err.missing) || err.missing.length === 0) err.missing = ['stack']
  return err
}

const serializers = new Map()
function serialize (version, request) {
  let serializer = serializers.get(version)
  if (!serializer) {
    const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
    serializers.set(version, (serializer = createSerializer(version)))
  }
  return serializer.createPacketBuffer({ name: 'item_stack_request', params: { requests: [request] } })
}

/** rejection reply of the rpc (resolved `{ ok:false }` or thrown) → whether it means "no stack op" */
function isUnsupportedReply (reply) {
  if (!reply) return false
  return reply.code === 'disabled' || /unknown op/i.test(String(reply.error ?? reply.message ?? ''))
}

/**
 * @param {object} bot
 * @param {object} [client] the bedd client (default bot._client)
 * @returns {object|null} the routing state (also bot._bedrock.beddInventory), null without client.bedd
 */
function attach (bot, client = bot._client) {
  const bedd = client?.bedd
  if (!bedd || !bot._bedrock?.stackRequests) return null
  if (bot._bedrock[ATTACHED]) return bot._bedrock[ATTACHED]
  const mgr = bot._bedrock.stackRequests
  const version = bot.version ?? client.version ?? VERSION

  const toClient = new Map() // bedboo id → client id, until the response
  const toBedboo = new Map() // client id → bedboo id, until the response
  const late = new Map() // client id → bedboo id of a request that timed out
  const history = new Map() // bedboo id → client id, recent (stack id references in later requests)
  let held = [] // { response, at }: responses that arrived while a `stack` call was in flight, not matched yet
  let inflight = 0
  let chain = Promise.resolve()
  const stats = { sent: 0, ok: 0, unsupported: 0, failed: 0, held: 0, foreign: 0 }

  const remember = (map, key, value, max) => {
    map.set(key, value)
    if (map.size > max) map.delete(map.keys().next().value)
  }
  const forget = (bedbooId) => {
    const clientId = toClient.get(bedbooId)
    toClient.delete(bedbooId)
    if (clientId !== undefined) toBedboo.delete(clientId)
    return clientId
  }

  function responseId (response) {
    const id = response.request_id
    if (toBedboo.has(id)) {
      const bedbooId = toBedboo.get(id)
      forget(bedbooId)
      return bedbooId
    }
    if (late.has(id)) {
      const bedbooId = late.get(id)
      late.delete(id)
      return bedbooId
    }
    if (inflight > 0) {
      held.push({ response, at: Date.now() })
      if (held.length > MAX_HELD) held.shift()
      stats.held++
    } else {
      stats.foreign++
    }
    return undefined
  }

  function releaseHeld () {
    if (held.length === 0) return
    const known = (h) => toBedboo.has(h.response.request_id) || late.has(h.response.request_id)
    const matched = held.filter(known)
    // still waiting for a reply: keep the unmatched ones (up to HELD_MS); otherwise they were someone else's
    const oldest = Date.now() - HELD_MS
    held = inflight > 0 ? held.filter(h => !known(h) && h.at >= oldest) : []
    for (const { response } of matched) mgr.receive({ responses: [response] })
  }

  /** the request as the client must see it: references to earlier bedboo requests → their client ids */
  function translate (request) {
    const fix = (info) => {
      if (!info || !(info.stack_id < 0) || info.stack_id === request.request_id) return info
      const clientId = toClient.get(info.stack_id) ?? history.get(info.stack_id)
      return clientId === undefined ? info : { ...info, stack_id: clientId }
    }
    return { ...request, actions: request.actions.map(a => ({ ...a, ...(a.source && { source: fix(a.source) }), ...(a.destination && { destination: fix(a.destination) }) })) }
  }

  async function submit (request) {
    const bedbooId = request.request_id
    if (!mgr.pending.has(bedbooId)) return // timed out / aborted while queued: never reaches the client
    if (bedd.caps?.stack !== 'present') {
      stats.unsupported++
      mgr.abort(bedbooId, unsupported(`caps.stack is ${bedd.caps?.stack ?? 'absent'}`))
      return
    }
    let buf
    try {
      buf = serialize(version, translate(request)).toString('base64')
    } catch (err) {
      stats.failed++
      mgr.abort(bedbooId, err)
      return
    }
    inflight++
    stats.sent++
    try {
      await call(request, buf)
    } finally {
      inflight--
      releaseHeld()
    }
  }

  async function call (request, buf) {
    const bedbooId = request.request_id
    let reply
    try {
      reply = await bedd.rpc.call('stack', { buf })
    } catch (err) {
      reply = { ok: false, error: err.message, code: err.code, cause: err }
    }
    const map = reply?.map ?? {}
    let clientId = map[String(bedbooId)]
    if (clientId === undefined && reply?.requestIds?.length === 1) clientId = reply.requestIds[0]
    if (typeof clientId === 'string' && clientId.trim() !== '') clientId = Number(clientId)
    if (reply?.ok !== false && Number.isInteger(clientId)) {
      stats.ok++
      remember(history, bedbooId, clientId, MAX_HISTORY)
      if (mgr.pending.has(bedbooId)) {
        toClient.set(bedbooId, clientId)
        toBedboo.set(clientId, bedbooId)
      } else {
        remember(late, clientId, bedbooId, MAX_LATE) // timed out meanwhile
      }
    } else if (reply?.ok !== false || !isUnsupportedReply(reply)) {
      stats.failed++
      const why = reply?.ok === false ? (reply.error ?? reply.code ?? 'error') : 'no valid client request id in the reply'
      const err = new StackRequestError(`item stack request ${bedbooId}: BeDD stack op failed (${why})`, { status: reply?.code, outcome: 'error', request })
      if (reply?.cause) err.cause = reply.cause
      mgr.abort(bedbooId, err)
    } else {
      stats.unsupported++
      mgr.abort(bedbooId, unsupported(reply.error ?? reply.code))
    }
  }

  function onRoute (params) {
    for (const request of params?.requests ?? []) {
      chain = chain.then(() => submit(request)).catch((err) => bot.emit('error', err))
    }
  }

  mgr.observe(({ request, outcome }) => {
    if (outcome === 'ok') return
    const clientId = forget(request.request_id)
    if (outcome === 'timeout' && clientId !== undefined) remember(late, clientId, request.request_id, MAX_LATE)
  })
  const reset = () => {
    toClient.clear()
    toBedboo.clear()
    late.clear()
    history.clear()
    held = []
  }
  client.on('close', reset)
  client.on('end', reset)

  mgr.bedd = { responseId }
  const routes = ensureDispatch(bedd, { warn: (err) => client.emit('warning', err) })
  routes.register('item_stack_request', onRoute)

  const state = {
    stats,
    get map () { return new Map(toClient) },
    get inflight () { return inflight },
    /** resolves when every queued `stack` call has been answered */
    idle: () => chain
  }
  bot._bedrock[ATTACHED] = state
  bot._bedrock.beddInventory = state
  return state
}

module.exports = { attach, handlersFor, HELD_MS }
