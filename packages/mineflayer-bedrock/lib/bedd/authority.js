// owner: BEDD-2 (authority table + core intent router)
'use strict'
/**
 * Who sends what in bedd mode (`transport: 'bedd'`). The real Minecraft client hosted by Be.D.D. is authoritative for
 * every serverbound packet; bedboo's stack still runs and whatever it would have sent is classified here:
 *
 * | class       | handling                                                                    |
 * |-------------|-----------------------------------------------------------------------------|
 * | clientOwned | the client already sends it: the router drops it (counted)                  |
 * | translated  | the router turns it into intents (`input`, `look`, `slot`, `button`, …)     |
 * | shared      | sent as is through the `send` op (allowlisted by BeDD)                      |
 * | unsupported | throws BeddUnsupportedError (code ERR_BEDD_UNSUPPORTED)                     |
 *
 * This table is identical to the one in Be.D.D.'s CONTRIBUTING.md (keep them in sync). Spec override: item_stack_request
 * is `translated` (routed through the `stack` op by lib/bedd/inventory.js), not unsupported.
 */

const CLIENT_OWNED = 'clientOwned'
const TRANSLATED = 'translated'
const SHARED = 'shared'
const UNSUPPORTED = 'unsupported'

function rejectMutation () {
  throw new TypeError('the bedd authority table is frozen')
}

/** A Set whose add/delete/clear throw (Object.freeze alone does not protect a Set's contents). */
function frozenSet (items) {
  const set = new Set(items)
  set.add = rejectMutation
  set.delete = rejectMutation
  set.clear = rejectMutation
  return Object.freeze(set)
}

/** Packets the client always sends itself (whatever their params). */
const clientOwned = frozenSet([
  'login',
  'client_to_server_handshake',
  'request_network_settings',
  'resource_pack_client_response',
  'client_cache_status',
  'client_cache_blob_status',
  'request_chunk_radius',
  'subchunk_request',
  'serverbound_loading_screen',
  'set_local_player_as_initialized',
  'network_stack_latency',
  'tick_sync',
  'player_skin',
  'emote_list',
  'respawn',
  'animate'
])

/** Packets the router translates into intents (some only for the sub-kinds listed below). */
const translated = frozenSet([
  'player_auth_input',
  'mob_equipment',
  'inventory_transaction',
  'interact',
  'container_close',
  'item_stack_request'
])

/** Packets sent unchanged through the `send` op. */
const shared = frozenSet(['text', 'command_request'])

/** Named unsupported packets (everything not classified otherwise is unsupported too). */
const unsupported = frozenSet([
  'book_edit',
  'block_pick_request',
  'crafting_event',
  'set_default_game_type'
])

/**
 * player_action actions the client owns (every other player_action is unsupported). `respawn` is the client's too: the
 * user clicks Respawn on the real client, and bedboo's own respawn handshake runs from a packet listener.
 */
const clientOwnedPlayerActions = frozenSet(['dimension_change_ack', 'start_item_use_on', 'stop_item_use_on', 'respawn'])
/** interact actions: mouse_over_entity is the client's, open_inventory is translated. */
const clientOwnedInteractions = frozenSet(['mouse_over_entity'])
const translatedInteractions = frozenSet(['open_inventory'])
/** inventory_transaction kinds that are translated (look + button). */
const translatedItemUse = frozenSet(['click_block', 'click_air'])
const translatedTransactionTypes = frozenSet(['item_release', 'item_use_on_entity'])

function transactionOf (params) {
  return params?.transaction ?? {}
}

/**
 * @param {string} name serverbound packet name
 * @param {object} [params] packet params (needed for player_action, interact and inventory_transaction)
 * @returns {'clientOwned'|'translated'|'shared'|'unsupported'}
 */
function classify (name, params) {
  if (name === 'player_action') {
    return clientOwnedPlayerActions.has(params?.action) ? CLIENT_OWNED : UNSUPPORTED
  }
  if (name === 'interact') {
    const action = params?.action_id
    if (clientOwnedInteractions.has(action)) return CLIENT_OWNED
    return translatedInteractions.has(action) ? TRANSLATED : UNSUPPORTED
  }
  if (name === 'inventory_transaction') {
    const tx = transactionOf(params)
    if (tx.transaction_type === 'item_use') return translatedItemUse.has(tx.transaction_data?.action_type) ? TRANSLATED : UNSUPPORTED
    return translatedTransactionTypes.has(tx.transaction_type) ? TRANSLATED : UNSUPPORTED
  }
  if (clientOwned.has(name)) return CLIENT_OWNED
  if (translated.has(name)) return TRANSLATED
  if (shared.has(name)) return SHARED
  return UNSUPPORTED
}

/** A short reason for an unsupported packet (for BeddUnsupportedError messages). */
function describe (name, params) {
  if (name === 'player_action') return `player_action ${params?.action}`
  if (name === 'interact') return `interact ${params?.action_id}`
  if (name === 'inventory_transaction') {
    const tx = transactionOf(params)
    return `inventory_transaction ${tx.transaction_type}${tx.transaction_data?.action_type ? ' ' + tx.transaction_data.action_type : ''}`
  }
  return name
}

module.exports = {
  CLIENT_OWNED,
  TRANSLATED,
  SHARED,
  UNSUPPORTED,
  clientOwned,
  translated,
  shared,
  unsupported,
  clientOwnedPlayerActions,
  clientOwnedInteractions,
  translatedInteractions,
  translatedItemUse,
  translatedTransactionTypes,
  classify,
  describe
}
