'use strict'

/**
 * Bedrock 1.26.40 (protocol 2168, BDS 1.26.42.1 – 1.26.44.3) writes some optional fields as a *double* optional: an
 * outer presence bool, then the usual optional (its own bool + value) — gophertunnel `DoubleOptionalFunc` at
 * 4794743 (1.26.44). bedrock-protocol's 1.26.40 schema spells the outer bool as a separate field (`<x>_presence`);
 * 1.26.50 dropped it again. The library builds every packet in the 1.26.51 shape, so for a family with the feature
 * `optionalsHavePresenceFlag` the outer bools of the packets bedboo writes are filled in right before serialization
 * (unset, protodef writes NaN → 0: BDS 1.26.44.3 happened to accept that in a live test, but a reader that follows
 * the schema, like gophertunnel, skips the inner optional and reads the rest of the packet shifted):
 *   - player_auth_input: transaction, item_stack_request, block_action, vehicle_rotation, predicted_vehicle and, in
 *     its transaction, actions;
 *   - every transaction action (player_auth_input and inventory_transaction): window_id, flags.
 * The outer bool is always true, also around an absent value (then the inner optional is false), which is what
 * gophertunnel writes and BDS 1.26.42.1 – 1.26.44.3 accept (walking, block actions, transactions and stack requests
 * checked live). inventory_transaction's own type and actions are an `option` in the schema: the value is the presence. Incoming packets keep the extra fields
 * (`containers_presence`, `item_stack_id_presence`, `container_presence`, …): readers ignore them.
 */

const AUTH_INPUT_PRESENCE = ['transaction', 'item_stack_request', 'block_action', 'vehicle_rotation', 'predicted_vehicle']

function withActionPresence (action) {
  if (!action || typeof action !== 'object') return action
  return { ...action, container_presence: action.container_presence ?? true, flag_presence: action.flag_presence ?? true }
}

const withActionsPresence = actions => Array.isArray(actions) ? actions.map(withActionPresence) : actions

/**
 * @param {string} name packet name
 * @param {object} params packet params in the library's (1.26.51) shape
 * @returns {object} params with the 1.26.40 outer presence bools (a copy when anything was added; `params` is not mutated)
 */
function addPresenceFlags (name, params) {
  if (!params || typeof params !== 'object') return params
  if (name === 'player_auth_input') {
    const out = { ...params }
    for (const field of AUTH_INPUT_PRESENCE) out[field + '_presence'] = params[field + '_presence'] ?? true
    if (params.transaction) {
      out.transaction = { ...params.transaction, actions_presence: params.transaction.actions_presence ?? true, actions: withActionsPresence(params.transaction.actions) }
    }
    return out
  }
  if (name === 'inventory_transaction' && params.transaction) {
    return { ...params, transaction: { ...params.transaction, actions: withActionsPresence(params.transaction.actions) } }
  }
  return params
}

const WRAPPED = Symbol('bedboo.presenceFlags')

function wrapSerializer (serializer) {
  if (!serializer || typeof serializer.createPacketBuffer !== 'function' || serializer[WRAPPED]) return
  const createPacketBuffer = serializer.createPacketBuffer.bind(serializer)
  serializer.createPacketBuffer = (packet) => {
    if (packet?.params && (packet.name === 'player_auth_input' || packet.name === 'inventory_transaction')) {
      packet = { ...packet, params: addPresenceFlags(packet.name, packet.params) }
    }
    return createPacketBuffer(packet)
  }
  serializer[WRAPPED] = true
}

/**
 * Makes a bedrock-protocol client write the outer presence bools (only for a family with `optionalsHavePresenceFlag`).
 * bedrock-protocol's createClient builds the client with `delayedInit` and creates `client.serializer` in `init()`
 * (after server discovery), so `init` is wrapped too: the serializer it creates is wrapped as soon as it exists.
 * A client without a serializer or `init` (test fakes, the BeDD client) is left alone.
 * @param {object} client bedrock-protocol Client (`serializer.createPacketBuffer({ name, params })`, `init()`)
 * @param {(name: string) => any} supportFeature the family's feature table
 * @returns {object} the client
 */
function installPresenceFlags (client, supportFeature) {
  if (!client || !supportFeature('optionalsHavePresenceFlag')) return client
  wrapSerializer(client.serializer)
  if (typeof client.init === 'function' && !client.init[WRAPPED]) {
    const init = client.init
    client.init = function (...args) {
      const out = init.apply(this, args)
      wrapSerializer(this.serializer)
      return out
    }
    client.init[WRAPPED] = true
  }
  return client
}

module.exports = { addPresenceFlags, installPresenceFlags, AUTH_INPUT_PRESENCE }
