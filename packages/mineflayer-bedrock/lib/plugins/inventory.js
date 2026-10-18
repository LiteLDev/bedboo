// owner: U8 (inventory, windows, creative & item use)
// Upstream: mineflayer 4.39.0 lib/plugins/inventory.js
// Surface: bot.inventory (prismarine-windows Window, Java 46-slot player layout), bot.currentWindow,
//   bot.quickBarSlot, bot.heldItem (getter), bot.usingHeldItem, bot.entity.equipment (getter, set on spawn),
//   bot.activateBlock(block, direction, cursorPos), bot.activateEntity(entity),
//   bot.activateEntityAt(entity, position), bot.consume(), bot.activateItem(offHand = false),
//   bot.deactivateItem(), bot.clickWindow(slot, mouseButton, mode), bot.putSelectedItemRange(start, end,
//   window, slot), bot.putAway(slot), bot.closeWindow(window), bot.transfer(options),
//   bot.openBlock(block, direction, cursorPos), bot.openEntity(entity), bot.moveSlotItem(source, dest),
//   bot.updateHeldItem(), bot._setSlot(slot, item, window), bot._syncWindow(window)
// Events: 'windowOpen' (window), 'windowClose' (window), 'heldItemChanged' (item),
//   window 'updateSlot' / 'updateSlot:<n>' (slot, oldItem, newItem)
// Bedrock: inventory_content / inventory_slot (BDS 1.26.51 uses inventory_content even for /give),
//   container_open / container_close, mob_equipment, player_hotbar, item_stack_request/response
//   (lib/bedrock/stack_request.js), inventory_transaction (lib/bedrock/transactions.js).
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  const windows = require('prismarine-windows')(bot.registry)

  // 0-8, null = uninitialized
  bot.quickBarSlot = null
  bot.inventory = windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  bot.currentWindow = null
  bot.usingHeldItem = false

  Object.defineProperty(bot, 'heldItem', {
    get: function () {
      return bot.inventory.slots[bot.QUICK_BAR_START + bot.quickBarSlot]
    }
  })

  bot.activateBlock = stubAsync('U8', 'bot.activateBlock', 3)
  bot.activateEntity = stubAsync('U8', 'bot.activateEntity', 1)
  bot.activateEntityAt = stubAsync('U8', 'bot.activateEntityAt', 2)
  bot.consume = stubAsync('U8', 'bot.consume', 0)
  bot.activateItem = stubSync('U8', 'bot.activateItem', 0)
  bot.deactivateItem = stubSync('U8', 'bot.deactivateItem', 0)
  bot.clickWindow = stubAsync('U8', 'bot.clickWindow', 3)
  bot.putSelectedItemRange = stubAsync('U8', 'bot.putSelectedItemRange', 4)
  bot.putAway = stubAsync('U8', 'bot.putAway', 1)
  bot.closeWindow = stubSync('U8', 'bot.closeWindow', 1)
  bot.transfer = stubAsync('U8', 'bot.transfer', 1)
  bot.openBlock = stubAsync('U8', 'bot.openBlock', 3)
  bot.openEntity = stubAsync('U8', 'bot.openEntity', 1)
  bot.moveSlotItem = stubAsync('U8', 'bot.moveSlotItem', 2)
  bot.updateHeldItem = stubSync('U8', 'bot.updateHeldItem', 0)
  bot._setSlot = stubSync('U8', 'bot._setSlot', 2)
  bot._syncWindow = stubAsync('U8', 'bot._syncWindow', 1)
}
