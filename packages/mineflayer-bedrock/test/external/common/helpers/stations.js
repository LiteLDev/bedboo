// owner: U13 (stations)
'use strict'
/**
 * Station helpers (Bedrock extras without an upstream testCommon counterpart), console + raw packets only:
 *
 * - `resyncInventory()` — make BDS resend the player's inventory and resolve once it arrived: the server's own copy
 *   of items the client had to predict (enchanting, anvil and trade results are never sent back by the item stack
 *   response). A command that changes nothing (e.g. `clear` of an item the bot lacks) sends nothing, so a barrier
 *   is given and cleared again (`give` / `clear` both answer with `inventory_content` of every window).
 * - `setExperienceLevel(level)` — Bedrock has no `/xp set`: `xp -100000L <bot>` then `xp <level>L <bot>`; resolves on
 *   the level's update_attributes (`player.level`).
 * - `enchantInventorySlot(slot, item, enchants)` — an enchanted item (Bedrock creative only creates catalogue items):
 *   the plain `item` goes to hotbar `slot` (36-44), which is selected, then console `/enchant <bot> <name> <lvl>` per
 *   `{ name, lvl }`; resolves after the last inventory update.
 * - `keepStill(entity)` — slowness 255 for a summoned mob (villagers and traders wander off otherwise).
 */

function install (bot, ctx) {
  const t = bot.test

  const inventoryUpdate = (timeout = 10000) =>
    ctx.packet(['inventory_content', 'inventory_slot'], (p) => String(p.window_id) === 'inventory', timeout)

  t.resyncInventory = async () => {
    const given = inventoryUpdate()
    given.promise.catch(() => {})
    try {
      await ctx.consoleExpect(`give ${ctx.who()} barrier 1`, /^Gave /, 'resyncInventory (give)')
    } catch (err) {
      given.cancel()
      throw err
    }
    await given.promise
    const cleared = inventoryUpdate()
    cleared.promise.catch(() => {})
    try {
      await ctx.consoleExpect(`clear ${ctx.who()} barrier`, /^Cleared the inventory/, 'resyncInventory (clear)')
    } catch (err) {
      cleared.cancel()
      throw err
    }
    await cleared.promise
    await t.wait(50) // the other windows of the same batch
  }

  t.setExperienceLevel = async (level) => {
    const levelIs = (wanted) => ctx.packet('update_attributes', (p) =>
      bot._bedrock?.ids?.isSelf?.(p.runtime_entity_id) !== false &&
      (p.attributes ?? []).some(a => a.name === 'minecraft:player.level' && Math.round(a.current) === wanted), 10000)
    if (bot.experience?.level !== 0) {
      const zero = levelIs(0)
      zero.promise.catch(() => {})
      await ctx.consoleExpect(`xp -100000L ${ctx.who()}`, /level|experience/i, 'setExperienceLevel (reset)')
      await zero.promise.catch(() => {}) // already 0: no update
    }
    if (level > 0) {
      const set = levelIs(level)
      set.promise.catch(() => {})
      await ctx.consoleExpect(`xp ${level}L ${ctx.who()}`, /^Gave/, 'setExperienceLevel')
      await set.promise
    }
    await t.wait(50)
  }

  t.enchantInventorySlot = async (slot, item, enchants) => {
    if (!(slot >= 36 && slot <= 44)) throw new Error('enchantInventorySlot: /enchant needs a hotbar slot (36-44)')
    await t.setInventorySlot(slot, item)
    bot.setQuickBarSlot(slot - 36)
    await t.wait(100) // mob_equipment reaches the server
    for (const { name, lvl } of enchants) {
      // BDS reports the enchanted item with a server inventory_transaction (normal, window 0) only
      const update = ctx.packet('inventory_transaction', (p) => p.transaction?.transaction_type === 'normal' &&
        (p.transaction.actions ?? []).some(a => a.source_type === 'container' && Number(a.window_id) === 0 && a.slot === slot - 36), 10000)
      update.promise.catch(() => {})
      try {
        await ctx.consoleExpect(`enchant ${ctx.who()} ${name} ${lvl}`, /^Enchanting succeeded/, `enchant ${name} ${lvl}`)
      } catch (err) {
        update.cancel()
        throw err
      }
      await update.promise
    }
  }

  t.keepStill = async (entity) => {
    const type = String(entity.name ?? entity.type).replace(/^minecraft:/, '')
    await ctx.consoleExpect(`${ctx.inDimension()}effect @e[type=${type}] slowness 1000 255 true`, /^Gave/, `keepStill(${type})`)
  }
}

module.exports = install
