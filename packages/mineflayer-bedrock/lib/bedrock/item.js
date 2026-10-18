// owner: U4 (wave 2) → U8 (wave 3)
'use strict'
const { stubSync } = require('./errors')

/**
 * Bedrock network item ↔ prismarine-item conversion.
 *
 * Wire item (bedrock-protocol `Item` / `ItemLegacy` type):
 *   { network_id, count, metadata, has_stack_id, stack_id, block_runtime_id, extra: { nbt, can_place_on, can_destroy, … } }
 * `network_id === 0` is the empty slot. `stack_id` (server stack network id) is needed by
 * item_stack_request; `block_runtime_id` must round-trip unchanged for held-item checks in
 * inventory_transaction (the server compares held_item byte-for-byte with its own copy).
 *
 * prismarine-item side: `new Item(type, count, metadata, nbt)` with `type` = registry item id,
 * plus `item.stackId` (Bedrock extra, kept on the Item) and `item.blockRuntimeId`.
 *
 * Contract:
 * - `fromNetwork(registry, wireItem) → Item | null`
 * - `toNetwork(registry, item, { stackId? }) → wireItem` (null → EMPTY_NETWORK_ITEM)
 * - `EMPTY_NETWORK_ITEM` frozen empty item
 */

const EMPTY_NETWORK_ITEM = Object.freeze({ network_id: 0 })

module.exports = {
  EMPTY_NETWORK_ITEM,
  fromNetwork: stubSync('U4', 'item.fromNetwork', 2),
  toNetwork: stubSync('U4', 'item.toNetwork', 2)
}
