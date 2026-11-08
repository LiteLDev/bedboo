'use strict'
/**
 * Feature values in which Bedrock 1.26.40 (protocol 2168, BDS 1.26.42.1 / 1.26.43.1 / 1.26.44.3) differs from the
 * base table (features.js, 1.26.51). Checked on BDS 1.26.44.3.
 */
module.exports = {
  // server.properties ships `transport=raknet` (NetherNet works when selected); minecraft-data agrees (1.26.51+)
  defaultTransportIsNethernet: false,
  // player_auth_input, inventory_transaction actions and item_stack_response carry gophertunnel's DoubleOptional: an
  // outer presence bool before the optional (bedrock-protocol 1.26.40 schema `<x>_presence`); dropped in 1.26.50
  optionalsHavePresenceFlag: true
}
