// owner: U1 (wave 1) → U8 (wave 3 upgrade)
'use strict'
/**
 * Inventory helpers (upstream testCommon.js: setInventorySlot, clearInventory, awaitItemReceived)
 * over the BDS console (`replaceitem`, `clear`, `give`); completion is observed through raw
 * `inventory_content` / `inventory_slot` packets (BDS 1.26.51 answers /give, /replaceitem and /clear
 * with `inventory_content`; armor replaceitem with `inventory_slot`).
 */

/**
 * Java player-inventory slot → Bedrock `replaceitem` slot type + index and the window that updates.
 * 36–44 hotbar, 9–35 main inventory, 5–8 armor (head, chest, legs, feet), 45 off-hand.
 */
function replaceItemSlot (javaSlot) {
  if (javaSlot >= 36 && javaSlot <= 44) return { slotType: 'slot.hotbar', index: javaSlot - 36, window: 'inventory' }
  if (javaSlot >= 9 && javaSlot <= 35) return { slotType: 'slot.inventory', index: javaSlot - 9, window: 'inventory' }
  const armor = { 5: 'slot.armor.head', 6: 'slot.armor.chest', 7: 'slot.armor.legs', 8: 'slot.armor.feet' }
  if (armor[javaSlot]) return { slotType: armor[javaSlot], index: 0, window: 'armor' }
  if (javaSlot === 45) return { slotType: 'slot.weapon.offhand', index: 0, window: 'offhand' }
  throw new Error(`setInventorySlot: Java slot ${javaSlot} has no Bedrock replaceitem equivalent`)
}

/** Static bedrock_1.26.51 data (raw-client bots have no bot.registry); item durability does not depend on the server. */
const staticRegistry = () => {
  require('@bedboo/bedrock-data').install()
  return require('minecraft-data')('bedrock_1.26.51')
}

/**
 * What `replaceitem` cannot express: NBT (enchantments, custom name/lore, book pages, …) and the ItemV4
 * can_place_on / can_destroy lists. The one exception is a damageable item's `Damage` (prismarine-item
 * `durabilityUsed`; new tools carry `Damage: 0`): BDS 1.26.51 stores replaceitem's data value of a tool as
 * `Damage` (metadata stays 0), so it is sent as the data value (see replaceItemSpec).
 * @returns {{ nbt: string[], lists: string[] } | null} what cannot be set, or null if replaceitem places
 *   the item exactly
 */
function unsupportedItemData (item, registry = staticRegistry()) {
  const value = item.nbt?.value ?? {}
  const nbt = Object.keys(value).filter((key) => !(key === 'Damage' && damageAsData(item, registry) !== null))
  const lists = []
  if (item.canPlaceOn?.length) lists.push('can_place_on')
  if (item.canDestroy?.length) lists.push('can_destroy')
  return nbt.length || lists.length ? { nbt, lists } : null
}

/** The `Damage` replaceitem can set through its data value (a damageable item with metadata 0), else null. */
function damageAsData (item, registry = staticRegistry()) {
  const damage = item.nbt?.value?.Damage
  if (!damage || !['int', 'short'].includes(damage.type) || (item.metadata ?? 0) !== 0) return null
  const maxDurability = item.maxDurability ?? registry?.itemsByName?.[item.name]?.maxDurability
  return maxDurability > 0 ? damage.value : null
}

/** `<name> <count> <data>` for replaceitem (`air` for an empty slot). */
function replaceItemSpec (item, registry = staticRegistry()) {
  if (!item) return 'air'
  return `${item.name} ${item.count ?? 1} ${damageAsData(item, registry) ?? item.metadata ?? 0}`
}

/** The error for an item replaceitem cannot place exactly. */
function unsupportedItemError (item, { nbt, lists }) {
  const what = [nbt.length ? `NBT ${nbt.join(', ')}` : null, ...lists].filter(Boolean).join(' + ')
  const subject = nbt.length ? 'NBT' : lists.join('/')
  return new Error(`setInventorySlot: ${subject} cannot be set with replaceitem; use bot.creative.setInventorySlot (U8) — ${item.name} carries ${what}`)
}

function install (bot, ctx) {
  const { state } = ctx
  const t = bot.test

  /** Arm a waiter for an inventory update of `window` (inventory/armor/offhand/ui). */
  function inventoryUpdate (window, timeout = 10000) {
    return ctx.packet(['inventory_content', 'inventory_slot'], (p) => String(p.window_id) === window, timeout)
  }

  /**
   * Upstream signature `setInventorySlot(targetSlot, item)` (Java slot numbers, prismarine Item or
   * null). Bedrock: `replaceitem entity <bot> <slot type> <index> <name> <count> <metadata>` (works in
   * any gamemode). `replaceitem` cannot set NBT (enchantments, names, book contents, …): such items are
   * rejected instead of being placed without it (U8 switches this helper to bot.creative.setInventorySlot).
   * A tool's Damage is set through the data value.
   */
  t.setInventorySlot = async (targetSlot, item) => {
    if (item && item.name === 'unknown') throw new Error(`item should not be unknown ${JSON.stringify(item)}`)
    const registry = bot.registry ?? staticRegistry()
    const unsupported = item && unsupportedItemData(item, registry)
    if (unsupported) throw unsupportedItemError(item, unsupported)
    const { slotType, index, window } = replaceItemSlot(targetSlot)
    const spec = replaceItemSpec(item, registry)
    const update = inventoryUpdate(window)
    update.promise.catch(() => {})
    try {
      await ctx.consoleExpect(`replaceitem entity ${ctx.who()} ${slotType} ${index} ${spec}`, /^Replaced/,
        `setInventorySlot(${targetSlot}, ${item ? item.name : null})`)
    } catch (err) {
      update.cancel()
      throw err
    }
    await update.promise
  }

  /**
   * Empty the inventory (armor, off-hand and cursor included) with console `clear` and resolve once
   * the client received the emptied inventory.
   */
  t.clearInventory = async () => {
    const update = inventoryUpdate('inventory')
    update.promise.catch(() => {})
    try {
      // "Could not clear …, no items to remove" is fine: the server still sends the (empty) inventory
      await ctx.consoleExpect(`clear ${ctx.who()}`, /^(Cleared|Could not clear) the inventory/, 'clearInventory')
    } catch (err) {
      update.cancel()
      throw err
    }
    await update.promise
  }

  /**
   * Give `count` × `name` (console `give`) and resolve once the inventory update arrived.
   * @param {string} name Bedrock item name
   * @param {number} [count]
   * @param {number} [metadata]
   */
  t.give = async (name, count = 1, metadata = 0) => {
    const update = inventoryUpdate('inventory')
    update.promise.catch(() => {})
    try {
      await ctx.consoleExpect(`give ${ctx.who()} ${name} ${count} ${metadata}`, /^Gave /, `give ${name}`)
    } catch (err) {
      update.cancel()
      throw err
    }
    await update.promise
  }

  /**
   * Upstream: run `command` as the bot (bot.chat) and resolve on the next inventory slot update.
   * Here the command is sent as a raw command_request; resolves on the next inventory_content/slot.
   */
  t.awaitItemReceived = async (command) => {
    const update = ctx.packet(['inventory_content', 'inventory_slot'], (p) => ['inventory', 'armor', 'offhand'].includes(String(p.window_id)), 10000)
    update.promise.catch(() => {})
    const out = await ctx.botCommand(command)
    if (!out.success_count) {
      update.cancel()
      throw new Error(`awaitItemReceived(${command}): ${JSON.stringify(out.output)}`)
    }
    await update.promise
  }

  /** Items currently tracked from raw packets (debugging / raw-mode assertions). */
  t.rawInventory = () => state.inventory
}

module.exports = install
module.exports.replaceItemSlot = replaceItemSlot
module.exports.unsupportedItemData = unsupportedItemData
module.exports.replaceItemSpec = replaceItemSpec
