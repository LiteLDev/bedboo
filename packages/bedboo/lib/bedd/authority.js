'use strict'
/**
 * Who sends what in bedd mode (`transport: 'bedd'`). The real Minecraft client hosted by Be.D.D. is authoritative for
 * every serverbound packet; bedboo's stack still runs and whatever it would have sent is classified here:
 *
 * | class       | handling                                                                    |
 * |-------------|-----------------------------------------------------------------------------|
 * | clientOwned | the client already sends it: the router drops it (counted)                  |
 * | translated  | the router turns it into intents (`input`, `look`, `slot`, `button`, `action swing`, `settings`, …) |
 * | screens     | done on the client's screens through `ui` (lib/bedd/screens.js), or `send` when allowlisted |
 * | shared      | sent as is through the `send` op (allowlisted by BeDD)                      |
 * | allowlisted | sent as is through `send` when its id is in the send probe's `allow` (BeDD's default sendAllow has them) |
 * | unsupported | sent as is when its id is in `allow`, else throws BeddUnsupportedError (code ERR_BEDD_UNSUPPORTED) |
 *
 * Mapping of the client-owned packets bedboo's APIs would send: swingArm → `action swing` (lib/bedd/surface.js wraps
 * bot.swingArm; every animate stays the client's), quit → `join host:null`, respawn → `ui` (the death screen's
 * Respawn button). request_chunk_radius (viewDistance) is translated to `settings`.
 *
 * This table is identical to the one in Be.D.D.'s CONTRIBUTING.md (keep them in sync). Spec override: item_stack_request
 * is `translated` (routed through the `stack` op by lib/bedd/inventory.js), not unsupported.
 */

const CLIENT_OWNED = 'clientOwned'
const TRANSLATED = 'translated'
const SCREENS = 'screens'
const SHARED = 'shared'
const ALLOWLISTED = 'allowlisted'
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
  'subchunk_request',
  'serverbound_loading_screen',
  'set_local_player_as_initialized',
  'network_stack_latency',
  'tick_sync',
  'player_skin',
  'emote_list',
  'respawn',
  'animate',
  'show_credits'
])

/** Packets the router translates into intents (some only for the sub-kinds listed below). */
const translated = frozenSet([
  'player_auth_input',
  'mob_equipment',
  'inventory_transaction',
  'interact',
  'container_close',
  'item_stack_request',
  'block_pick_request',
  'request_chunk_radius'
])

/** Packets done on the client's screens (`ui`), or sent through `send` when allowlisted. */
const screens = frozenSet(['block_entity_data'])

/** Packets sent unchanged through the `send` op. */
const shared = frozenSet(['text', 'command_request'])

/** Packets BeDD's default sendAllow lets `send` send as is (the client sends them from its own screens). */
const allowlisted = frozenSet(['book_edit', 'command_block_update'])

/** Named unsupported packets (everything not classified otherwise is unsupported too). */
const unsupported = frozenSet([
  'crafting_event',
  'set_default_game_type'
])

/**
 * player_action actions the client owns (every other player_action is unsupported). `respawn` is the client's too: the
 * user clicks Respawn on the real client, and bedboo's own respawn handshake runs from a packet listener.
 */
const clientOwnedPlayerActions = frozenSet(['dimension_change_ack', 'start_item_use_on', 'stop_item_use_on', 'respawn'])
/** player_action actions done on the client's screens (stop_sleeping: the bed screen's Leave Bed). */
const screenPlayerActions = frozenSet(['stop_sleeping'])
/** interact actions: mouse_over_entity is the client's, open_inventory and leave_vehicle (a sneak tap) are translated. */
const clientOwnedInteractions = frozenSet(['mouse_over_entity'])
const translatedInteractions = frozenSet(['open_inventory', 'leave_vehicle'])
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
    if (clientOwnedPlayerActions.has(params?.action)) return CLIENT_OWNED
    return screenPlayerActions.has(params?.action) ? SCREENS : UNSUPPORTED
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
  if (screens.has(name)) return SCREENS
  if (shared.has(name)) return SHARED
  if (allowlisted.has(name)) return ALLOWLISTED
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
  SCREENS,
  SHARED,
  ALLOWLISTED,
  UNSUPPORTED,
  clientOwned,
  translated,
  screens,
  shared,
  allowlisted,
  unsupported,
  clientOwnedPlayerActions,
  screenPlayerActions,
  clientOwnedInteractions,
  translatedInteractions,
  translatedItemUse,
  translatedTransactionTypes,
  classify,
  describe
}
