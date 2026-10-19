// owner: U13 (stations)
// Adapted from mineflayer 4.39.0 lib/plugins/enchantment_table.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): openEnchantmentTable, the 'ready' bookkeeping, takeTargetItem,
// putTargetItem and putLapis are kept verbatim; the options and the enchant request are Bedrock.
// Surface: bot.openEnchantmentTable(block) → Promise<EnchantmentTable> (window + enchantments, xpseed, targetItem,
//   enchant(choice), takeTargetItem, putTargetItem(item), putLapis(item); event 'ready')
// Bedrock (BDS 1.26.51.1): window type 'enchantment' (item = ui slot 14 `enchanting_input`, lapis = ui slot 15
//   `enchanting_lapis`). The server sends player_enchant_options { options: [{ cost, slot_flags, equip_enchants,
//   held_enchants, self_enchants, name, option_id }] } before the container_open (empty) and after every change of
//   the item slot: `cost` is the level requirement (Java property 0-2), the three lists are ALL the enchantments the
//   option applies (Java only hints one: `expected` = the first of them). The seed is never sent (xpseed stays -1).
//   Enchanting = one item stack request: craft_recipe { recipe_network_id: zigzag32(option_id) } +
//   results_deprecated (the predicted item) + consume (choice + 1) lapis + consume the item + place the produced
//   item from creative_output 50 back into the item slot (Java keeps the result in slot 0 too). The server applies
//   its own result (verified: a wrong results_deprecated is ignored) and charges choice + 1 levels; the response
//   carries no item, so the enchanted item is predicted from the option (equip + held + self enchantments).
'use strict'
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { zigzag32, resultDescriptor, runStation, closeCurrentWindow, onWindowGone, withNbt } = require('../bedrock/stations')

module.exports = inject

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)

  // the server sends the (empty) options right before the table's container_open
  let lastOptions = []
  bot._client.on('player_enchant_options', (packet) => { lastOptions = packet.options ?? [] })

  async function openEnchantmentTable (enchantmentTableBlock) {
    assert.strictEqual(enchantmentTableBlock.name, 'enchanting_table')
    let ready = false
    let options = []
    await closeCurrentWindow(bot)
    const enchantmentTable = await bot.openBlock(enchantmentTableBlock)
    if (!enchantmentTable.type.startsWith('minecraft:enchant')) {
      throw new Error('Expected minecraft:enchant when opening table but got ' + enchantmentTable.type)
    }

    resetEnchantmentOptions()

    enchantmentTable.enchant = enchant
    enchantmentTable.takeTargetItem = takeTargetItem
    enchantmentTable.putTargetItem = putTargetItem
    enchantmentTable.putLapis = putLapis
    enchantmentTable.targetItem = function () { return this.slots[0] }

    applyOptions(lastOptions)
    bot._client.on('player_enchant_options', onEnchantOptions)
    onWindowGone(bot, enchantmentTable, () => {
      bot._client.removeListener('player_enchant_options', onEnchantOptions)
    })

    return enchantmentTable

    function onEnchantOptions (packet) {
      if (bot.currentWindow !== enchantmentTable) return
      applyOptions(packet.options ?? [])
    }

    /** Bedrock options → upstream's three { level, expected: { enchant, level } } slots */
    function applyOptions (list) {
      options = list
      const slots = enchantmentTable.enchantments
      for (let slot = 0; slot < 3; slot++) {
        const option = list[slot]
        const first = option ? enchantsOf(option)[0] : null
        slots[slot].level = option ? option.cost : -1
        slots[slot].expected.enchant = first ? first.id : -1
        slots[slot].expected.level = first ? first.level : -1
      }

      if (slots[0].level >= 0 && slots[1].level >= 0 && slots[2].level >= 0) {
        if (!ready) {
          ready = true
          enchantmentTable.emit('ready')
        }
      } else {
        ready = false
      }
    }

    function resetEnchantmentOptions () {
      enchantmentTable.xpseed = -1
      enchantmentTable.enchantments = []
      for (let slot = 0; slot < 3; slot++) {
        enchantmentTable.enchantments.push({
          level: -1,
          expected: {
            enchant: -1,
            level: -1
          }
        })
      }
      ready = false
    }

    async function enchant (choice) {
      if (!ready) await once(enchantmentTable, 'ready')
      choice = parseInt(choice, 10) // allow string argument
      assert.notStrictEqual(enchantmentTable.enchantments[choice].level, -1)
      const option = options[choice]
      const target = enchantmentTable.targetItem()
      if (!option || !target) throw new Error('Nothing to enchant')
      const creative = bot.game.gameMode === 'creative'
      // Bedrock (like Java): option n costs n + 1 lapis and n + 1 levels; its `cost` is the level requirement
      const lapisCost = choice + 1
      const lapis = enchantmentTable.slots[1]
      if (!creative && (!lapis || lapis.count < lapisCost)) throw new Error(`Enchanting needs ${lapisCost} lapis lazuli`)
      if (!creative && bot.experience.level < option.cost) throw new Error(`Enchanting needs ${option.cost} experience levels`)
      const model = bot._bedrock.inventoryModel
      const result = enchanted(target, option)
      const steps = [
        { type: 'raw', action: { type_id: 'craft_recipe', recipe_network_id: zigzag32(option.option_id), times_crafted: 1 } },
        { type: 'raw', action: { type_id: 'results_deprecated', times_crafted: 1, result_items: [resultDescriptor(result)] } }
      ]
      if (!creative) steps.push({ type: 'consume', count: lapisCost, src: model.keyOf(enchantmentTable, 1) })
      steps.push({ type: 'consume', count: 1, src: model.keyOf(enchantmentTable, 0) })
      steps.push({ type: 'place', count: 1, src: { created: result }, dst: model.keyOf(enchantmentTable, 0) })
      await runStation(bot, enchantmentTable, steps, { what: 'enchanting' })
      return enchantmentTable.slots[0]
    }

    async function takeTargetItem () {
      const item = enchantmentTable.targetItem()
      assert.ok(item)
      await bot.putAway(item.slot)
      return item
    }

    async function putTargetItem (item) {
      await bot.moveSlotItem(item.slot, 0)
    }

    async function putLapis (item) {
      await bot.moveSlotItem(item.slot, 1)
    }
  }

  /** every enchantment an option applies (Bedrock groups them by activation: equip, held, self) */
  function enchantsOf (option) {
    return [...(option.equip_enchants ?? []), ...(option.held_enchants ?? []), ...(option.self_enchants ?? [])]
  }

  /**
   * the item the server makes of `target` with `option` (a book becomes an enchanted book). BDS also offers options
   * that apply no enchantment (a fishing rod or carrot on a stick at a table without bookshelves): it charges for them
   * and leaves the item as it was, so the prediction is the item unchanged, without an empty `ench` list (U16a).
   */
  function enchanted (target, option) {
    if (enchantsOf(option).length === 0) return withNbt(Item, target, (value) => value, { count: 1 })
    const book = target.name === 'book'
    const type = book ? bot.registry.itemsByName.enchanted_book.id : target.type
    return withNbt(Item, target, (value) => {
      value.ench = {
        type: 'list',
        value: { type: 'compound', value: enchantsOf(option).map(e => ({ id: { type: 'short', value: e.id }, lvl: { type: 'short', value: e.level } })) }
      }
      return value
    }, { type, count: 1 })
  }

  bot.openEnchantmentTable = openEnchantmentTable
}
