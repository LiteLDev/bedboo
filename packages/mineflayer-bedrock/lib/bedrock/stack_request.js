// owner: U8 (inventory, windows, creative & item use)
'use strict'
const { BeddUnsupportedError } = require('../bedd/errors')

/**
 * Server-authoritative inventory: item_stack_request / item_stack_response manager, exposed as
 * `bot._bedrock.stackRequests`. Low level: ids, packet shape, response matching, timeouts. The inventory
 * plugin's model (`bot._bedrock.inventoryModel`) builds requests from Java-slot steps, predicts the result
 * locally and applies/rolls back on the response — use that unless you need raw actions.
 *
 * Wire facts (BDS 1.26.51.1, protocol 2193):
 * - Requests go out as a standalone `item_stack_request { requests: [request] }` (queued, flushed every 20 ms);
 *   `write(request, { viaInput: true })` puts it into the next player_auth_input instead (≤ 1 per tick).
 * - `request_id`: unique, the vanilla client's odd negative sequence (-1, -3, -5, …).
 * - `legacy_type_id` repeats the action type as a byte, in the PRE-1.26.40 numbering (with the removed
 *   place_in_container/take_out_container still counted): take 0, place 1, swap 2, drop 3, destroy 4,
 *   consume 5, create 6, lab_table_combine 9, beacon_payment 10, mine_block 11, craft_recipe 12,
 *   craft_recipe_auto 13, craft_creative 14, optional 15, craft_grindstone_request 16, craft_loom_request 17,
 *   non_implemented 18, results_deprecated 19. BDS parses the action body by this byte: craft_creative with
 *   legacy 12 makes BDS DISCONNECT the client. It is filled in automatically.
 * - A malformed action (e.g. a `destroy` with count 0) also disconnects the client, so counts are validated.
 * - `StackRequestSlotInfo.stack_id`: the server stack id of the item in that slot (> 0); the id of the pending
 *   request that last changed the slot (< 0, accepted before that request's response arrived); the CURRENT
 *   request id for a slot changed by an earlier action of the same request (e.g. `creative_output` 50 after
 *   `craft_creative`); 0 for an empty slot.
 * - Response `status: 'ok'` lists `containers[].slots[]` with the resulting `count` and `item_stack_id`
 *   (absent when count is 0) per touched slot, echoing the container names of the request. Any other status
 *   (numeric BDS error code, e.g. 7 no matching screen, 49 stack id mismatch, 50 invalid slot/container) means
 *   nothing changed server side; the server does NOT resend the inventory, the client rolls back its prediction.
 * - Cursor / cross-container moves and craft_creative need an open screen (the player's own inventory:
 *   `interact open_inventory`); hotbar↔hotbar moves and hotbar drops also work without one.
 *
 * Contract:
 * - `create(actions | (requestId) => actions, opts?) → { request, response }` builds the request (normalized
 *   actions, `legacy_type_id`) and registers it as pending; `response` settles when the matching
 *   item_stack_response arrives: resolves with the ItemStackResponse on `ok`, rejects with a
 *   {@link StackRequestError} on an error status, a timeout (`opts.timeout`, default 5000 ms) or disconnect.
 *   The caller sends it (`write(request)`) right away.
 * - `send(actions, opts?) → Promise<ItemStackResponse>` = create + write.
 * - BEDD-5: with `transport: 'bedd'` and no BeDD `stack` op, `create` throws (and `send` rejects with) a
 *   BeddUnsupportedError (`code: 'ERR_BEDD_UNSUPPORTED'`, feature 'item_stack_request') before registering anything.
 * - `write(request, { viaInput })`, `nextRequestId()`, `observe(fn) → unsubscribe` (fn({ request, response,
 *   outcome: 'ok'|'error'|'timeout'|'closed', meta }) runs synchronously for every settled request, before its
 *   promise settles; an answer to a request that already timed out is reported once more as 'late-ok' /
 *   'late-error' — the promise stays rejected), `pending` (Map requestId → entry), `normalizeAction(action)`.
 *   opts: `{ customNames = [], cause = -1, timeout, meta, requestId, viaInput }`.
 *
 * @typedef {object} StackRequestManager
 * @property {(actions: object[] | ((requestId: number) => object[]), opts?: object) => { request: object, response: Promise<object> }} create
 * @property {(actions: object[] | ((requestId: number) => object[]), opts?: object) => Promise<object>} send
 */

const DEFAULT_TIMEOUT_MS = 5000

/** item stack request action type → legacy (pre-1.26.40) ItemStackRequestActionType byte */
const LEGACY_ACTION_IDS = Object.freeze({
  take: 0,
  place: 1,
  swap: 2,
  drop: 3,
  destroy: 4,
  consume: 5,
  create: 6,
  // 7 place_in_container, 8 take_out_container (removed in 1.26.40)
  lab_table_combine: 9,
  beacon_payment: 10,
  mine_block: 11,
  craft_recipe: 12,
  craft_recipe_auto: 13,
  craft_creative: 14,
  optional: 15,
  craft_grindstone_request: 16,
  craft_loom_request: 17,
  non_implemented: 18,
  results_deprecated: 19
})

const COUNTED = new Set(['take', 'place', 'drop', 'destroy', 'consume'])
const WITH_SOURCE = new Set(['take', 'place', 'swap', 'drop', 'destroy', 'consume'])
const WITH_DESTINATION = new Set(['take', 'place', 'swap'])

class StackRequestError extends Error {
  /**
   * @param {string} message
   * @param {{ status?: string|number, outcome: string, request: object, response?: object }} info
   */
  constructor (message, { status, outcome, request, response }) {
    super(message)
    this.name = 'StackRequestError'
    this.status = status
    this.outcome = outcome
    this.request = request
    this.requestId = request?.request_id
    this.response = response
  }
}

/** `{ slot_type: { container_id }, slot, stack_id }` from either that shape or `slots.resolve()`'s */
function normalizeSlotInfo (info, what) {
  if (!info || typeof info !== 'object') throw new TypeError(`item stack request: missing ${what}`)
  const slotType = info.slot_type ?? (info.container_id !== undefined ? { container_id: info.container_id } : null)
  if (!slotType || typeof slotType.container_id !== 'string') throw new TypeError(`item stack request: ${what} needs a container_id`)
  const slot = info.slot
  if (!Number.isInteger(slot) || slot < 0 || slot > 255) throw new TypeError(`item stack request: invalid ${what} slot ${slot}`)
  const stackId = info.stack_id ?? info.stack_network_id ?? 0
  if (!Number.isInteger(stackId)) throw new TypeError(`item stack request: invalid ${what} stack id ${stackId}`)
  const normalized = { slot_type: { container_id: slotType.container_id }, slot, stack_id: stackId }
  if (slotType.dynamic_container_id !== undefined) normalized.slot_type.dynamic_container_id = slotType.dynamic_container_id
  return normalized
}

/**
 * Validate an action and fill in `legacy_type_id` (and the defaults BDS needs). Throws a TypeError for anything
 * BDS would answer with a disconnect.
 */
function normalizeAction (action) {
  if (!action || typeof action.type_id !== 'string') throw new TypeError('item stack request: action needs a type_id')
  const legacy = action.legacy_type_id ?? LEGACY_ACTION_IDS[action.type_id]
  if (!Number.isInteger(legacy)) throw new TypeError(`item stack request: unknown action type ${action.type_id}`)
  const out = { ...action, legacy_type_id: legacy }
  if (COUNTED.has(action.type_id) && (!Number.isInteger(action.count) || action.count < 1 || action.count > 255)) {
    throw new TypeError(`item stack request: ${action.type_id} count must be 1..255, got ${action.count}`)
  }
  if (WITH_SOURCE.has(action.type_id)) out.source = normalizeSlotInfo(action.source, `${action.type_id} source`)
  if (WITH_DESTINATION.has(action.type_id)) out.destination = normalizeSlotInfo(action.destination, `${action.type_id} destination`)
  if (action.type_id === 'drop') out.randomly = !!action.randomly
  if (action.type_id === 'craft_creative' || action.type_id === 'craft_recipe') out.times_crafted = action.times_crafted ?? 1
  return out
}

/**
 * @param {object} bot
 * @param {{ timeout?: number }} [options]
 * @returns {StackRequestManager & { write: Function, nextRequestId: () => number, observe: Function, pending: Map<number, object>, normalizeAction: Function }}
 */
function createStackRequestManager (bot, { timeout: defaultTimeout = DEFAULT_TIMEOUT_MS } = {}) {
  let lastId = 1
  const pending = new Map()
  const observers = new Set()
  // requests that timed out, kept briefly: a late answer is reported as 'late-ok' / 'late-error'
  const expired = new Map()
  const MAX_EXPIRED = 64

  function notify (event) {
    for (const fn of [...observers]) {
      try {
        fn(event)
      } catch (err) {
        bot.emit('error', err)
      }
    }
  }

  function nextRequestId () {
    lastId -= 2
    if (lastId < -0x7ffffff0) lastId = -1
    return lastId
  }

  function settle (entry, response, outcome) {
    if (!pending.has(entry.request.request_id) || pending.get(entry.request.request_id) !== entry) return
    pending.delete(entry.request.request_id)
    clearTimeout(entry.timer)
    if (outcome === 'timeout') {
      expired.set(entry.request.request_id, entry)
      if (expired.size > MAX_EXPIRED) expired.delete(expired.keys().next().value)
    }
    notify({ request: entry.request, response, outcome, meta: entry.meta })
    if (outcome === 'ok') {
      entry.resolve(response)
      return
    }
    const status = response?.status
    const message = outcome === 'timeout'
      ? `item stack request ${entry.request.request_id}: no item_stack_response from the server`
      : outcome === 'closed'
        ? `item stack request ${entry.request.request_id}: the connection closed`
        : `item stack request ${entry.request.request_id} rejected by the server (status ${status})`
    entry.reject(new StackRequestError(message, { status, outcome, request: entry.request, response }))
  }

  // BEDD-5: with transport 'bedd' the real client owns item_stack_request; it can only go through BeDD's `stack` op
  // (lib/bedd/inventory.js). Without that op every request is refused before it is registered or predicted (the public
  // inventory APIs are refused earlier still, before any screen opens: lib/bedd/surface.js).
  function beddUnsupported () {
    const bedd = bot._client?.bedd
    if (!bedd || (bot._bedrock?.mode !== undefined && bot._bedrock.mode !== 'bedd')) return null
    if (bedd.caps?.stack === 'present') return null
    return new BeddUnsupportedError('item_stack_request', { missing: ['stack'] })
  }

  function create (actions, opts = {}) {
    const unsupported = beddUnsupported()
    if (unsupported) throw unsupported
    const requestId = opts.requestId ?? nextRequestId()
    if (pending.has(requestId)) throw new Error(`item stack request id ${requestId} is already pending`)
    const list = typeof actions === 'function' ? actions(requestId) : actions
    if (!Array.isArray(list) || list.length === 0) throw new TypeError('item stack request: at least one action is needed')
    const request = {
      request_id: requestId,
      actions: list.map(normalizeAction),
      custom_names: opts.customNames ?? [],
      cause: opts.cause ?? -1
    }
    let settleOk, settleError
    const response = new Promise((resolve, reject) => { settleOk = resolve; settleError = reject })
    response.catch(() => {}) // callers that never await the response must not cause an unhandled rejection
    const entry = { request, resolve: settleOk, reject: settleError, meta: opts.meta, timer: null }
    pending.set(requestId, entry)
    entry.timer = setTimeout(() => settle(entry, null, 'timeout'), opts.timeout ?? defaultTimeout)
    entry.timer.unref?.()
    return { request, response }
  }

  function write (request, { viaInput = false } = {}) {
    if (viaInput) bot._bedrock.input.queueItemStackRequest(request)
    else bot._client.queue('item_stack_request', { requests: [request] })
  }

  function send (actions, opts = {}) {
    const unsupported = beddUnsupported()
    if (unsupported) return Promise.reject(unsupported)
    const { request, response } = create(actions, opts)
    write(request, opts)
    return response
  }

  bot._client.on('item_stack_response', (packet) => {
    for (const response of packet.responses ?? []) {
      const ok = response.status === 'ok' || response.status === 0
      const entry = pending.get(response.request_id)
      if (entry) {
        settle(entry, response, ok ? 'ok' : 'error')
        continue
      }
      const late = expired.get(response.request_id)
      if (late) {
        expired.delete(response.request_id)
        notify({ request: late.request, response, outcome: ok ? 'late-ok' : 'late-error', meta: late.meta })
      }
    }
  })
  const closeAll = () => {
    for (const entry of [...pending.values()]) settle(entry, null, 'closed')
  }
  bot._client.on('close', closeAll)
  bot._client.on('end', closeAll)

  return {
    create,
    send,
    write,
    nextRequestId,
    normalizeAction,
    observe (fn) {
      observers.add(fn)
      return () => observers.delete(fn)
    },
    get pending () { return pending },
    LEGACY_ACTION_IDS
  }
}

module.exports = { createStackRequestManager, normalizeAction, StackRequestError, LEGACY_ACTION_IDS, DEFAULT_TIMEOUT_MS }
