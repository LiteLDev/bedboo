// owner: U8 (inventory, windows, creative & item use)
'use strict'
const { stubSync, stubAsync } = require('./errors')

/**
 * Server-authoritative inventory: item_stack_request / item_stack_response manager, exposed as
 * `bot._bedrock.stackRequests`.
 *
 * Requests are sent through the input queue (`bot._bedrock.input.queueItemStackRequest`, at most one
 * per tick, inside player_auth_input) or as a standalone `item_stack_request` packet — U8 decides and
 * documents which. Every request gets a unique negative-or-positive `request_id`; the response is
 * matched by id. On `status: 'ok'` the manager applies the returned container slot states
 * (new `stack_id`s); on error it re-syncs from the server's `inventory_content`.
 *
 * Action shapes are bedrock-protocol `ItemStackRequest.actions[]` entries, e.g.
 *   { type_id: 'take', count, source: { slot_type, slot, stack_id }, destination: { … } }
 *   { type_id: 'place' | 'swap' | 'drop' | 'destroy' | 'consume' | 'craft_recipe' | 'results_deprecated' … }
 * Slot descriptors come from `slots.resolve(window, javaSlot)`.
 *
 * @typedef {object} StackRequestManager
 * @property {(actions: object[], opts?: { customNames?: string[], filterCause?: number }) =>
 *   { request: object, response: Promise<object> }} create
 *   build a request (assigning request_id) without sending it; `response` settles when the
 *   matching item_stack_response arrives (rejects on error status / timeout)
 * @property {(actions: object[], opts?: object) => Promise<object>} send create + send, resolves with the response
 */

/** @returns {StackRequestManager} */
function createStackRequestManager (bot) {
  return {
    create: stubSync('U8', 'bot._bedrock.stackRequests.create', 1),
    send: stubAsync('U8', 'bot._bedrock.stackRequests.send', 1)
  }
}

module.exports = { createStackRequestManager }
