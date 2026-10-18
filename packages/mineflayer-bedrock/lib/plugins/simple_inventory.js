// owner: U8 (inventory, windows, creative & item use)
// Upstream: mineflayer 4.39.0 lib/plugins/simple_inventory.js
// Surface: bot.QUICK_BAR_START (36), bot.equip(item, destination), bot.unequip(destination),
//   bot.toss(itemType, metadata, count), bot.tossStack(item), bot.setQuickBarSlot(slot),
//   bot.getEquipmentDestSlot(destination), bot.simpleClick { leftMouse(slot), rightMouse(slot) }
// Bedrock: mob_equipment (hotbar selection), item_stack_request take/place/swap/drop actions.
'use strict'
const { stubSync, stubAsync } = require('../bedrock/errors')

const QUICK_BAR_START = 36

module.exports = inject

function inject (bot) {
  bot.equip = stubAsync('U8', 'bot.equip', 2)
  bot.unequip = stubAsync('U8', 'bot.unequip', 1)
  bot.toss = stubAsync('U8', 'bot.toss', 3)
  bot.tossStack = stubAsync('U8', 'bot.tossStack', 1)
  bot.setQuickBarSlot = stubSync('U8', 'bot.setQuickBarSlot', 1)
  bot.getEquipmentDestSlot = stubSync('U8', 'bot.getEquipmentDestSlot', 1)
  bot.simpleClick = {
    leftMouse: stubAsync('U8', 'bot.simpleClick.leftMouse', 1),
    rightMouse: stubAsync('U8', 'bot.simpleClick.rightMouse', 1)
  }
  bot.QUICK_BAR_START = QUICK_BAR_START
}
