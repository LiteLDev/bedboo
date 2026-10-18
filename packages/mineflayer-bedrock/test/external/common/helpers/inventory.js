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
   * any gamemode; NBT such as enchantments is not applied).
   */
  t.setInventorySlot = async (targetSlot, item) => {
    if (item && item.name === 'unknown') throw new Error(`item should not be unknown ${JSON.stringify(item)}`)
    const { slotType, index, window } = replaceItemSlot(targetSlot)
    const spec = item ? `${item.name} ${item.count ?? 1} ${item.metadata ?? 0}` : 'air'
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
