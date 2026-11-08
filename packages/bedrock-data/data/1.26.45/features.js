'use strict'
/**
 * Feature values in which Bedrock 1.26.45 (protocol 2169, BDS 1.26.45.1) differs from the base table (features.js,
 * 1.26.51). Checked on BDS 1.26.45.1; see docs/reference/versions/1.26.45.md.
 */
module.exports = {
  // server.properties ships `transport=raknet` (NetherNet works when selected); minecraft-data agrees (1.26.51+)
  defaultTransportIsNethernet: false,
  // the same wire as 1.26.40: player_auth_input, transaction actions and item_stack_response carry gophertunnel's
  // DoubleOptional (an outer presence bool before the optional; bedrock-protocol 1.26.45 schema `<x>_presence`)
  optionalsHavePresenceFlag: true
}
