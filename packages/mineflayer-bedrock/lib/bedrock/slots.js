// owner: U8 (inventory, windows, creative & item use)
'use strict'
const { PLAYER_INVENTORY } = require('./windows')

/**
 * Java-layout slot ↔ Bedrock container slot mapping.
 *
 * mineflayer (and every ecosystem plugin) addresses slots with the Java window layout:
 * - player inventory (bot.inventory, `minecraft:inventory`): 0 crafting result, 1-4 crafting grid, 5-8 armor
 *   head..feet, 9-35 main, 36-44 hotbar, 45 off-hand;
 * - container windows: the container slots first (lib/bedrock/windows.js slot maps), then 27 main + 9 hotbar.
 * Bedrock addresses `{ container_id (ContainerSlotType), slot }` per container plus the item's stack network id.
 *
 * Player slots on the wire (verified on BDS 1.26.51.1): hotbar = `hotbar` 0-8, main = `inventory` 9-35 (absolute
 * indexes; `hotbar_and_inventory` 0-35 is accepted too), armor = `armor` 0-3, off-hand = `offhand` slot **1**
 * (slot 0 is rejected; inventory_content/inventory_slot still use index 0), cursor = `cursor` 0, 2×2 crafting grid
 * = `crafting_input` (ui) 28-31, crafting/created results = `creative_output` 50.
 *
 * Contract:
 * - `resolve(window, javaSlot) → { container_id, slot, stack_network_id } | null` (null: the Java slot has no
 *   Bedrock address, e.g. -999). `javaSlot` may be `'cursor'`. `stack_network_id` = the stack id the next
 *   request must send for that slot: the item's `stackId` (positive server id, or the negative id of the pending
 *   request that last changed it — lib/bedrock/stack_request.js sets it), 0 for an empty slot.
 * - `toJava(window, containerId, slot) → number | null` inverse mapping (item_stack_response → Java slot);
 *   `'cursor'` for the cursor, null when the address is not part of `window`.
 * - `contentToJava(window, index)` / `uiToJava(window, uiSlot)` map the open window's own inventory_content
 *   index / a `ui` container index to its Java slot (null if unmapped).
 * - `slotInfo(ref, stackId)` → bedrock-protocol StackRequestSlotInfo `{ slot_type: { container_id }, slot, stack_id }`.
 */

const PLAYER_CONTAINERS = new Set(['hotbar', 'inventory', 'hotbar_and_inventory'])
const OFFHAND_REQUEST_SLOT = 1
const CURSOR = Object.freeze({ container_id: 'cursor', slot: 0 })

function isPlayerInventory (window) {
  return window?.bedrock?.key === 'inventory' || window?.type === 'minecraft:inventory'
}

/** the container slot map of a window (bedrock metadata, else a generic chest-like `container` map) */
function slotMapOf (window) {
  if (window?.bedrock?.slotMap) return window.bedrock.slotMap
  if (isPlayerInventory(window)) return PLAYER_INVENTORY.slotMap
  return Array.from({ length: window?.inventoryStart ?? 0 }, (_, i) => ({ container_id: 'container', slot: i, content: i }))
}

/** Bedrock player-inventory index (0-8 hotbar, 9-35 main) of a Java slot of `window`, or null. */
function playerIndex (window, javaSlot) {
  if (isPlayerInventory(window)) {
    if (javaSlot >= 36 && javaSlot <= 44) return javaSlot - 36
    if (javaSlot >= 9 && javaSlot <= 35) return javaSlot
    return null
  }
  const offset = javaSlot - window.inventoryStart
  if (offset < 0 || offset >= 36) return null
  return offset < 27 ? offset + 9 : offset - 27
}

/** Java slot of a Bedrock player-inventory index (0-35) in `window`. */
function javaOfPlayerIndex (window, index) {
  if (index < 0 || index > 35) return null
  if (isPlayerInventory(window)) return index < 9 ? 36 + index : index
  return index < 9 ? window.inventoryStart + 27 + index : window.inventoryStart + index - 9
}

/** StackRequestSlotInfo address of a player-inventory index */
function playerRef (index) {
  return { container_id: index < 9 ? 'hotbar' : 'inventory', slot: index }
}

/**
 * Address (without stack id) of a Java slot.
 * @returns {{ container_id: string, slot: number } | null}
 */
function refOf (window, javaSlot) {
  if (javaSlot === 'cursor') return { ...CURSOR }
  if (typeof javaSlot !== 'number' || javaSlot < 0) return null
  const index = playerIndex(window, javaSlot)
  if (index !== null) return playerRef(index)
  if (isPlayerInventory(window)) {
    if (javaSlot === 45) return { container_id: 'offhand', slot: OFFHAND_REQUEST_SLOT }
    const ref = PLAYER_INVENTORY.slotMap[javaSlot]
    return ref ? { container_id: ref.container_id, slot: ref.slot } : null
  }
  const ref = slotMapOf(window)[javaSlot]
  return ref ? { container_id: ref.container_id, slot: ref.slot } : null
}

/**
 * @param {object} window prismarine-windows Window (bot.inventory or a window opened by the inventory plugin)
 * @param {number|'cursor'} javaSlot
 * @returns {{ container_id: string, slot: number, stack_network_id: number } | null}
 */
function resolve (window, javaSlot) {
  const ref = refOf(window, javaSlot)
  if (!ref) return null
  const item = javaSlot === 'cursor' ? window.selectedItem : window.slots[javaSlot]
  return { ...ref, stack_network_id: item ? (item.stackId ?? 0) : 0 }
}

/**
 * @param {object} window
 * @param {string} containerId ContainerSlotType name (as echoed by item_stack_response)
 * @param {number} slot
 * @returns {number | 'cursor' | null}
 */
function toJava (window, containerId, slot) {
  if (containerId === 'cursor') return 'cursor'
  if (PLAYER_CONTAINERS.has(containerId)) {
    if (containerId === 'hotbar' && slot > 8) return null
    return javaOfPlayerIndex(window, slot)
  }
  if (isPlayerInventory(window)) {
    if (containerId === 'offhand') return 45
    if (containerId === 'armor') return slot >= 0 && slot <= 3 ? 5 + slot : null
  }
  const map = slotMapOf(window)
  for (let i = 0; i < map.length; i++) {
    const ref = map[i]
    if (ref && ref.container_id === containerId && ref.slot === slot) return i
  }
  return null
}

/** Java slot of index `index` of the open window's own inventory_content, or null. */
function contentToJava (window, index) {
  const map = slotMapOf(window)
  for (let i = 0; i < map.length; i++) {
    if (map[i] && map[i].content === index) return i
  }
  return null
}

/** Java slot of `ui` container index `uiSlot` in `window`, or null (0 = cursor, see `CURSOR`). */
function uiToJava (window, uiSlot) {
  const map = slotMapOf(window)
  for (let i = 0; i < map.length; i++) {
    if (map[i] && map[i].ui && map[i].slot === uiSlot) return i
  }
  return null
}

/** bedrock-protocol StackRequestSlotInfo */
function slotInfo (ref, stackId = 0) {
  return { slot_type: { container_id: ref.container_id }, slot: ref.slot, stack_id: stackId ?? 0 }
}

module.exports = {
  resolve,
  toJava,
  refOf,
  contentToJava,
  uiToJava,
  slotInfo,
  playerIndex,
  javaOfPlayerIndex,
  playerRef,
  isPlayerInventory,
  PLAYER_CONTAINERS,
  OFFHAND_REQUEST_SLOT,
  CURSOR
}
