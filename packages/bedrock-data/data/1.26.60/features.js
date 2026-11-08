'use strict'
/**
 * Feature values in which Bedrock 1.26.60 (protocol 2225, BDS 1.26.60.6 / 1.26.61.1 / 1.26.62.1 / 1.26.63.1) differs
 * from the base table (features.js, 1.26.51). Checked on BDS 1.26.60.6 – 1.26.63.1.
 */
module.exports = {
  // animate, item_use_on_entity and item_release carry the hand (u8 'main_hand' | 'off_hand'; bedrock-protocol's
  // 1.26.60 schema, gophertunnel 8c30047): without it the serializer cannot write those packets
  actionPacketsHaveHand: true,
  // item stack request actions: craft_reserved (wire 16, legacy 18) inserted, non_implemented / results_deprecated
  // are legacy 19 / 20 (gophertunnel d483610); BDS 1.26.60.6 drops the connection on a craft that sends legacy 19
  stackRequestHasCraftReserved: true
}
