// owner: U13 (stations)
// Adapted from mineflayer 4.39.0 lib/plugins/anvil.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): openAnvil, combine / rename (guards, cost checks, input order,
// error messages, waiting for the experience change) are kept; the name and the result are Bedrock.
// Surface: bot.openAnvil(anvilBlock) → Promise<Anvil> (window + combine(itemOne, itemTwo, name), rename(item, name))
// Bedrock (BDS 1.26.51.1): window type 'anvil' (target = ui slot 1 `anvil_input`, sacrifice = ui slot 2
//   `anvil_material`). There is no name_item packet: the new name travels in the item stack request's custom_names.
//   The operation is ONE request: optional { recipe_network_id: 0, filtered_string_index: 0 (rename) | -1 } +
//   consume the target (+ the sacrifice) + place the produced item from creative_output 50 into the inventory
//   (= upstream's putAway(2) of the result slot). BDS computes the result and charges the levels itself, but
//   neither shows the result in slot 2 nor sends it back: the client predicts it with the Bedrock anvil rules
//   (lib/bedrock/anvil.js, also the costs `Item.anvil` gives upstream — prismarine-item has none for Bedrock).
'use strict'
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { resultSteps, runStation, closeCurrentWindow } = require('../bedrock/stations')

module.exports = inject

/** Bedrock anvil names are at most 30 characters (Java: 50; upstream checks 35) */
const MAX_NAME_LENGTH = 30

function inject (bot) {
  const Item = require('prismarine-item')(bot.registry)
  const anvilResult = require('../bedrock/anvil')(bot.registry)

  const matchWindowType = window => /minecraft:(?:chipped_|damaged_)?anvil/.test(window.type)

  async function openAnvil (anvilBlock) {
    await closeCurrentWindow(bot)
    const anvil = await bot.openBlock(anvilBlock)
    if (!matchWindowType(anvil)) {
      throw new Error('Not a anvil-like window: ' + anvil.type)
    }

    function err (name) {
      anvil.close()
      throw new Error(name)
    }

    async function putInAnvil (itemOne, itemTwo) {
      await putSomething(0, itemOne.type, itemOne.metadata, itemOne.count, itemOne.nbt)
      await putSomething(1, itemTwo.type, itemTwo.metadata, itemTwo.count, itemTwo.nbt)
    }

    /**
     * Bedrock: run the anvil on what is in slots 0 / 1 and put the result into the inventory (upstream: the name is
     * typed with name_item, then putAway(2) takes the server's result).
     */
    async function useAnvil (name) {
      const one = anvil.slots[0]
      const two = anvil.slots[1] ?? null
      const creative = bot.game.gameMode === 'creative'
      const { item, usedMats } = anvilResult(one, two, creative, name, Item)
      if (!item) throw new Error('Not anvil-able, cancelling.')
      const rename = typeof name === 'string' && name !== (one.customName ?? null)
      const model = bot._bedrock.inventoryModel
      const steps = [
        { type: 'raw', action: { type_id: 'optional', recipe_network_id: 0, filtered_string_index: rename ? 0 : -1 } },
        { type: 'consume', count: one.count, src: model.keyOf(anvil, 0) }
      ]
      if (two) {
        // a tool / book sacrifice is used up, repair materials only as far as needed
        const used = two.name === one.name || two.name === 'enchanted_book' ? two.count : Math.min(two.count, usedMats || two.count)
        steps.push({ type: 'consume', count: used, src: model.keyOf(anvil, 1) })
      }
      const placed = resultSteps(model, anvil, item)
      steps.push(...placed.steps)
      await runStation(bot, anvil, steps, { what: 'anvil', customNames: rename ? [name] : [], cause: 'anvil_text' })
      if (placed.rest > 0) await bot.putSelectedItemRange(anvil.inventoryStart, anvil.inventoryEnd, anvil, null)
    }

    async function combine (itemOne, itemTwo, name) {
      if (name?.length > MAX_NAME_LENGTH) err('Name is too long.')

      assert.ok(itemOne && itemTwo)
      const creative = bot.game.gameMode === 'creative'
      const { xpCost: normalCost } = anvilResult(itemOne, itemTwo, creative, name)
      const { xpCost: inverseCost } = anvilResult(itemTwo, itemOne, creative, name)
      if (normalCost === 0 && inverseCost === 0) err('Not anvil-able (in either direction), cancelling.')

      // upstream's `smallest` is 0 whenever one direction is impossible, so it never refuses: check the cost of the
      // direction actually used (BDS would reject the request and leave the items in the anvil)
      const swap = normalCost === 0 || (inverseCost !== 0 && normalCost >= inverseCost)
      const cost = swap ? inverseCost : normalCost
      if (!creative && bot.experience.level < cost) {
        err('Player does not have enough xp to do action, cancelling.')
      }

      await clearAnvil()
      const xpPromise = creative ? Promise.resolve() : once(bot, 'experience')
      if (swap) await putInAnvil(itemTwo, itemOne)
      else await putInAnvil(itemOne, itemTwo)

      await useAnvil(name)
      await xpPromise
    }

    async function rename (item, name) {
      if (name?.length > MAX_NAME_LENGTH) err('Name is too long.')
      assert.ok(item)
      const creative = bot.game.gameMode === 'creative'
      const { xpCost: normalCost } = anvilResult(item, null, creative, name)
      if (normalCost === 0) err('Not valid rename, cancelling.')

      if (!creative && bot.experience.level < normalCost) {
        err('Player does not have enough xp to do action, cancelling.')
      }
      // upstream waits for an experience change even in creative mode, where none comes
      await clearAnvil()
      const xpPromise = creative ? Promise.resolve() : once(bot, 'experience')
      await putSomething(0, item.type, item.metadata, item.count, item.nbt)
      await useAnvil(name)
      await xpPromise
    }

    /** Bedrock: leftovers of an earlier operation (e.g. unused repair materials) would join this one */
    async function clearAnvil () {
      for (const slot of [0, 1]) {
        if (anvil.slots[slot]) await bot.putAway(slot)
      }
    }

    async function putSomething (destSlot, itemId, metadata, count, nbt) {
      const options = {
        window: anvil,
        itemType: itemId,
        metadata,
        count,
        nbt,
        sourceStart: anvil.inventoryStart,
        sourceEnd: anvil.inventoryEnd,
        destStart: destSlot,
        destEnd: destSlot + 1
      }
      await bot.transfer(options)
    }

    anvil.combine = combine
    anvil.rename = rename

    return anvil
  }

  bot.openAnvil = openAnvil
}

module.exports.MAX_NAME_LENGTH = MAX_NAME_LENGTH
