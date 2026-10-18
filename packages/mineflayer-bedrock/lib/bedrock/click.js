// owner: U8 (inventory, windows, creative & item use)
'use strict'

/**
 * mineflayer `clickWindow(slot, mouseButton, mode)` emulation: Java (vanilla 1.21 AbstractContainerMenu.doClick /
 * quickMoveStack) click semantics turned into Bedrock item stack request STEPS. A step addresses Java slots of the
 * clicked window (or `'cursor'`); lib/bedrock/inventory_model.js turns steps into actions (stack ids, slot infos)
 * and predicts the result. Pure functions, unit-tested without a server.
 *
 * Steps:
 *   { type: 'take' | 'place', count, src, dst }   move `count` items (take = towards the cursor, by convention)
 *   { type: 'swap', src, dst }                      exchange two stacks
 *   { type: 'drop', count, src }                    throw items out (spawns an item entity)
 *   { type: 'destroy', count, src }                 creative: delete items
 *   { type: 'creative', item, count, dst }          creative: craft_creative + place `count` from creative_output 50
 *
 * Modes (mineflayer numbering): 0 PICKUP (button 0 left / 1 right; slot -999 = outside → drop), 1 QUICK_MOVE
 * (shift), 2 SWAP (number key, button 0-8 hotbar, 40 off-hand), 3 CLONE (creative middle click), 4 THROW (drop
 * key: button 0 one item, 1 whole stack). Modes 5 (drag) and 6 (double click) are not implemented, like
 * prismarine-windows.
 */

const QUICK_BAR_COUNT = 9

const HEAD_ITEMS = /(_helmet|^turtle_helmet|^carved_pumpkin|_skull|_head)$/
const CHEST_ITEMS = /(_chestplate|^elytra)$/
const LEGS_ITEMS = /_leggings$/
const FEET_ITEMS = /_boots$/

/** Java slot of the armor slot an item equips into in the player inventory window (5 head … 8 feet), or null. */
function armorSlotFor (item) {
  if (!item) return null
  const name = item.name ?? ''
  if (HEAD_ITEMS.test(name)) return 5
  if (CHEST_ITEMS.test(name)) return 6
  if (LEGS_ITEMS.test(name)) return 7
  if (FEET_ITEMS.test(name)) return 8
  return null
}

function sameItem (Item, a, b) {
  return !!a && !!b && Item.equal(a, b, false, true)
}

/**
 * @param {object} window prismarine-windows Window (slots, selectedItem = the cursor, inventoryStart/End, hotbarStart,
 *   craftingResultSlot, type)
 * @param {number} slot Java slot, -999 = outside the window
 * @param {number} mouseButton
 * @param {number} mode
 * @param {object} opts
 * @param {object} opts.Item prismarine-item class (Item.equal)
 * @param {'inventory'|'chest'|'station'} opts.kind player inventory, chest-like container, other (furnace, …)
 * @param {(slot: number) => boolean} [opts.isCreatedOutput] a result slot that only crafting produces (Bedrock
 *   created output) — clicking it needs bot.craft (U12)
 * @param {(slot: number) => boolean} [opts.isAddressable] the slot has a Bedrock address
 * @param {(slot: number, item: object) => boolean} [opts.mayPlace] Java Slot.mayPlace (armor slots, result slots)
 * @param {(item: object) => number[]} [opts.quickMoveTargets] container slots a shift click from the player part
 *   fills (Java per-menu rules, from the window spec); default: every container slot in order
 * @param {(slot: number) => number|undefined} [opts.slotLimit] max stack size of a slot (1 for bottle slots, …)
 * @param {string} [opts.gameMode]
 * @returns {object[]} steps (empty: the click changes nothing)
 */
function planClick (window, slot, mouseButton, mode, opts) {
  switch (mode) {
    case 0: return pickup(window, slot, mouseButton, opts)
    case 1: return quickMove(window, slot, mouseButton, opts)
    case 2: return swapWithHotbar(window, slot, mouseButton, opts)
    case 3: return cloneStack(window, slot, mouseButton, opts)
    case 4: return throwItems(window, slot, mouseButton, opts)
    default: throw new Error(`clickWindow mode ${mode} (${mode === 5 ? 'drag' : 'double click'}) is not implemented`)
  }
}

function checkButton (ok, mode, button) {
  if (!ok) throw new Error(`invalid operation: mode ${mode} with mouse button ${button}`)
}

function defaultMayPlace (window, slot, opts) {
  return (s, item) => {
    if (s === window.craftingResultSlot) return false
    if (opts.isAddressable && !opts.isAddressable(s)) return false
    if (opts.mayPlace) return opts.mayPlace(s, item)
    return true
  }
}

function pickup (window, slot, button, opts) {
  checkButton(button === 0 || button === 1, 0, button)
  const { Item } = opts
  const carried = window.selectedItem
  if (slot === -999) {
    if (!carried) return []
    return [{ type: 'drop', count: button === 0 ? carried.count : 1, src: 'cursor' }]
  }
  assertSlot(window, slot)
  const item = window.slots[slot]
  if (opts.isCreatedOutput && opts.isCreatedOutput(slot)) {
    if (item) throw new Error(`slot ${slot} is a crafting result: on Bedrock the result is produced by the craft request (bot.craft)`)
    return []
  }
  if (opts.isAddressable && !opts.isAddressable(slot)) return []
  const mayPlace = defaultMayPlace(window, slot, opts)
  const limit = (stack) => Math.min(stack.stackSize, opts.slotLimit?.(slot) ?? Infinity)
  if (!item) {
    if (!carried || !mayPlace(slot, carried)) return []
    const n = button === 0 ? Math.min(carried.count, limit(carried)) : 1
    return [{ type: 'place', count: n, src: 'cursor', dst: slot }]
  }
  if (!carried) {
    const n = button === 0 ? item.count : Math.ceil(item.count / 2)
    return [{ type: 'take', count: n, src: slot, dst: 'cursor' }]
  }
  if (mayPlace(slot, carried)) {
    if (sameItem(Item, item, carried)) {
      const room = limit(item) - item.count
      const n = Math.min(button === 0 ? carried.count : 1, room)
      return n > 0 ? [{ type: 'place', count: n, src: 'cursor', dst: slot }] : []
    }
    if (carried.count <= limit(carried)) return [{ type: 'swap', src: 'cursor', dst: slot }]
    return []
  }
  // a result slot (furnace output, …): take into the carried stack when it is the same item
  if (sameItem(Item, item, carried)) {
    const n = Math.min(item.count, carried.stackSize - carried.count)
    return n > 0 ? [{ type: 'take', count: n, src: slot, dst: 'cursor' }] : []
  }
  return []
}

/** Java AbstractContainerMenu.moveItemStackTo over `slots` (in order), on a virtual copy of the counts. */
function moveItemStackTo (window, item, count, slots, opts, virtual) {
  const { Item } = opts
  const mayPlace = defaultMayPlace(window, -1, opts)
  const at = (s) => virtual.has(s) ? virtual.get(s) : window.slots[s]
  const max = (s, stack) => Math.min(stack.stackSize, opts.slotLimit?.(s) ?? Infinity)
  const moves = []
  let remaining = count
  if (item.stackSize > 1) {
    for (const s of slots) {
      if (remaining <= 0) break
      const there = at(s)
      if (!there || !sameItem(Item, there, item) || there.count >= max(s, there)) continue
      const n = Math.min(max(s, there) - there.count, remaining)
      moves.push({ dst: s, count: n })
      virtual.set(s, { ...there, stackSize: there.stackSize, count: there.count + n })
      remaining -= n
    }
  }
  if (remaining > 0) {
    for (const s of slots) {
      if (at(s) || !mayPlace(s, item)) continue
      const n = Math.min(remaining, max(s, item))
      moves.push({ dst: s, count: n })
      virtual.set(s, { ...item, stackSize: item.stackSize, count: n })
      remaining -= n
      break
    }
  }
  return moves
}

const span = (start, end, reverse = false) => {
  const out = []
  for (let i = start; i < end; i++) out.push(i)
  return reverse ? out.reverse() : out
}

function quickMove (window, slot, button, opts) {
  checkButton(button === 0 || button === 1, 1, button)
  if (slot === -999) return []
  assertSlot(window, slot)
  const item = window.slots[slot]
  if (!item) return []
  if (opts.isCreatedOutput && opts.isCreatedOutput(slot)) {
    throw new Error(`slot ${slot} is a crafting result: on Bedrock the result is produced by the craft request (bot.craft)`)
  }
  const virtual = new Map()
  const move = (start, end, reverse = false) => moveItemStackTo(window, item, item.count, span(start, end, reverse), opts, virtual)
  let moves
  if (opts.kind === 'inventory') {
    const armor = armorSlotFor(item)
    if (slot <= 8) {
      moves = move(9, 45, slot === 0)
    } else if (armor !== null && slot !== armor && !window.slots[armor]) {
      moves = move(armor, armor + 1)
    } else if (item.name === 'shield' && slot !== 45 && !window.slots[45]) {
      moves = move(45, 46)
    } else if (slot >= 9 && slot <= 35) {
      moves = move(36, 45)
    } else if (slot >= 36 && slot <= 44) {
      moves = move(9, 36)
    } else {
      moves = move(9, 45)
    }
  } else {
    const start = window.inventoryStart
    const end = window.inventoryEnd
    if (slot < start) {
      moves = move(start, end, opts.kind === 'chest' || slot === window.craftingResultSlot)
    } else {
      const targets = opts.quickMoveTargets ? opts.quickMoveTargets(item) : null
      moves = targets ? moveItemStackTo(window, item, item.count, targets, opts, virtual) : move(0, start)
      if (moves.length === 0 && opts.kind === 'station') {
        // furnace-like menus: main ↔ hotbar when the container does not take the item
        const hotbarStart = end - QUICK_BAR_COUNT
        moves = slot < hotbarStart ? move(hotbarStart, end) : move(start, hotbarStart)
      }
    }
  }
  return moves.map(({ dst, count }) => ({ type: 'place', count, src: slot, dst }))
}

function swapWithHotbar (window, slot, button, opts) {
  checkButton((button >= 0 && button <= 8) || button === 40, 2, button)
  if (slot === -999 || window.selectedItem) return []
  assertSlot(window, slot)
  let hotbarSlot
  if (button === 40) {
    if (opts.kind !== 'inventory') throw new Error('clickWindow mode 2 button 40 (off-hand swap) is only supported in the player inventory window')
    hotbarSlot = 45
  } else {
    hotbarSlot = window.hotbarStart + button
  }
  if (hotbarSlot === slot) return []
  if (opts.isCreatedOutput && opts.isCreatedOutput(slot)) {
    if (window.slots[slot]) throw new Error(`slot ${slot} is a crafting result: on Bedrock the result is produced by the craft request (bot.craft)`)
    return []
  }
  const mayPlace = defaultMayPlace(window, slot, opts)
  const a = window.slots[slot]
  const b = window.slots[hotbarSlot]
  if (a && b) return mayPlace(slot, b) ? [{ type: 'swap', src: slot, dst: hotbarSlot }] : []
  if (a) return [{ type: 'place', count: a.count, src: slot, dst: hotbarSlot }]
  if (b) return mayPlace(slot, b) ? [{ type: 'place', count: Math.min(b.count, b.stackSize), src: hotbarSlot, dst: slot }] : []
  return []
}

function cloneStack (window, slot, button, opts) {
  checkButton(button === 2, 3, button)
  if (slot === -999 || window.selectedItem || opts.gameMode !== 'creative') return []
  assertSlot(window, slot)
  const item = window.slots[slot]
  if (!item) return []
  return [{ type: 'creative', item, count: item.stackSize, dst: 'cursor' }]
}

function throwItems (window, slot, button, opts) {
  checkButton(button === 0 || button === 1, 4, button)
  if (slot === -999 || window.selectedItem) return []
  assertSlot(window, slot)
  const item = window.slots[slot]
  if (!item) return []
  if (opts.isCreatedOutput && opts.isCreatedOutput(slot)) {
    throw new Error(`slot ${slot} is a crafting result: on Bedrock the result is produced by the craft request (bot.craft)`)
  }
  return [{ type: 'drop', count: button === 0 ? 1 : item.count, src: slot }]
}

function assertSlot (window, slot) {
  const ok = Number.isInteger(slot) && slot >= 0 && slot < window.slots.length
  if (!ok) throw new Error(`invalid operation: slot ${slot} is not part of window ${window.id} (${window.type})`)
}

/**
 * Java `Inventory.placeItemBackInInventory` order (where a carried item goes when a window closes): the selected
 * hotbar slot and the off-hand if they hold the same item with room, then player slots 0-35 (hotbar first) with
 * room, then the first empty player slot; the rest is dropped.
 * @param {object} Item prismarine-item class
 * @param {(index: number) => object|null} playerItem Bedrock player-inventory index (0-35, 'offhand') → item
 * @param {object} item the carried item
 * @param {number} selected selected hotbar slot (0-8)
 * @returns {{ moves: Array<{ index: number|'offhand', count: number }>, rest: number }}
 */
function placeBackPlan (Item, playerItem, item, selected) {
  const moves = []
  let remaining = item.count
  const counts = new Map()
  const at = (i) => counts.has(i) ? counts.get(i) : (playerItem(i)?.count ?? 0)
  const fits = (i) => {
    const there = playerItem(i)
    return there && sameItem(Item, there, item) ? there.stackSize - at(i) : 0
  }
  const candidates = [selected, 'offhand', ...span(0, 36)]
  for (const i of candidates) {
    if (remaining <= 0) break
    const room = fits(i)
    if (room <= 0) continue
    const n = Math.min(room, remaining)
    moves.push({ index: i, count: n })
    counts.set(i, at(i) + n)
    remaining -= n
  }
  for (let i = 0; i < 36 && remaining > 0; i++) {
    if (playerItem(i) || counts.has(i)) continue
    const n = Math.min(remaining, item.stackSize)
    moves.push({ index: i, count: n })
    counts.set(i, n)
    remaining -= n
  }
  return { moves, rest: remaining }
}

module.exports = { planClick, moveItemStackTo, placeBackPlan, armorSlotFor, sameItem }
