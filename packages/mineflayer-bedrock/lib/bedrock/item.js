// owner: U4 (wave 2) → U8 (wave 3)
'use strict'

/**
 * Bedrock network item ↔ prismarine-item conversion.
 *
 * Wire item (bedrock-protocol `ItemV4` type, 1.26.40+):
 *   { network_id, count, metadata, has_stack_id, stack_id, block_runtime_id, extra: { has_nbt, nbt, can_place_on, can_destroy, blocking_tick? } }
 * `network_id === 0` is the empty slot. `stack_id` (server stack network id) is needed by
 * item_stack_request; `block_runtime_id` must round-trip unchanged for held-item checks in
 * inventory_transaction (the server compares held_item with its own copy).
 *
 * prismarine-item (patched by U2, see docs/differences/U2.md) does the conversion: `Item.fromNotch(wire)`
 * keeps `item.stackId`, `item.blockRuntimeId`, `canPlaceOn`/`canDestroy` and the NBT, and `Item.toNotch(item)`
 * re-serializes every captured BDS inventory packet byte for byte.
 *
 * Contract:
 * - `fromNetwork(registry, wireItem) → Item | null`
 * - `toNetwork(registry, item, { stackId? }) → wireItem` (null → EMPTY_NETWORK_ITEM; `stackId` overrides the item's)
 * - `EMPTY_NETWORK_ITEM` frozen empty item (all ItemV4 fields, as BDS sends it)
 */

const EMPTY_NETWORK_ITEM = Object.freeze({ network_id: 0, count: 0, metadata: 0, has_stack_id: false, block_runtime_id: 0 })

const itemClasses = new WeakMap()
function ItemFor (registry) {
  let Item = itemClasses.get(registry)
  if (!Item) {
    Item = require('prismarine-item')(registry)
    itemClasses.set(registry, Item)
  }
  return Item
}

/**
 * @param {object} registry the bot's registry (after start_game + item_registry)
 * @param {object|null} wireItem bedrock-protocol ItemV4
 * @returns {import('prismarine-item').Item|null}
 */
function fromNetwork (registry, wireItem) {
  if (!wireItem || !wireItem.network_id) return null
  return ItemFor(registry).fromNotch(wireItem)
}

/**
 * @param {object} registry
 * @param {import('prismarine-item').Item|null} item
 * @param {{ stackId?: number }} [opts]
 * @returns {object} bedrock-protocol ItemV4
 */
function toNetwork (registry, item, { stackId } = {}) {
  if (!item || !item.type) return { ...EMPTY_NETWORK_ITEM }
  const wire = ItemFor(registry).toNotch(item)
  if (stackId !== undefined && stackId !== null) {
    wire.has_stack_id = true
    wire.stack_id = stackId
  }
  return wire
}

module.exports = {
  EMPTY_NETWORK_ITEM,
  fromNetwork,
  toNetwork
}
