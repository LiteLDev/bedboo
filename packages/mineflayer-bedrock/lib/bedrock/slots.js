// owner: U8 (inventory, windows, creative & item use)
'use strict'
const { stubSync } = require('./errors')

/**
 * Java-layout slot ↔ Bedrock container slot mapping.
 *
 * mineflayer (and every ecosystem plugin) addresses slots with the Java window layout
 * (player inventory: 0 crafting result, 1-4 crafting grid, 5-8 armor head..feet, 9-35 main,
 * 36-44 hotbar, 45 off-hand; container windows: container slots first, then 27 main + 9 hotbar).
 * Bedrock addresses `{ container_id (ContainerSlotType / slot_type), slot }` per container plus the
 * item's current `stack_network_id`.
 *
 * Contract:
 * - `resolve(window, javaSlot) → { container_id, slot, stack_network_id }`
 *     uses the slot map registered for `window`'s Bedrock container type (windows.js)
 * - `toJava(window, containerId, slot) → number | null` inverse mapping
 *     (inventory_slot / inventory_content / item_stack_response → Java slot)
 */

module.exports = {
  resolve: stubSync('U8', 'slots.resolve', 2),
  toJava: stubSync('U8', 'slots.toJava', 3)
}
