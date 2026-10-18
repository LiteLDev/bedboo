// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * `bot.test.placeBlock(slot, position)` on the real API (installed after world.js, see ../index.js).
 *
 * Upstream: mineflayer 4.39.0 test/externalTests/plugins/testCommon.js (MIT, Copyright (c) 2013 Andrew Kelley):
 * select hotbar `slot - 36`, then `bot.placeBlock(<block below position>, (0, 1, 0))` — the item is consumed (in
 * survival), the promise resolves with the server's block update (blockPlaced) and rejects like bot.placeBlock (the
 * server refused, an entity in the way, …).
 * Raw bots (or a bot whose placeBlock is still a stub) keep the console version from world.js
 * (`execute as <bot> at @s run setblock …`, the item is not consumed).
 */
const { Vec3 } = require('vec3')

function install (bot, ctx) {
  const t = bot.test
  const usesPlaceApi = () => !bot._rawBot && ctx.implemented(bot.placeBlock) && ctx.implemented(bot.setQuickBarSlot)

  const consolePlaceBlock = t.placeBlock
  t.placeBlock = async (slot, position) => {
    if (!usesPlaceApi()) return consolePlaceBlock(slot, position)
    bot.setQuickBarSlot(slot - 36)
    // always place the block on the top of the block below it, i guess.
    const referenceBlock = bot.blockAt(new Vec3(position.x, position.y, position.z).plus(new Vec3(0, -1, 0)))
    return bot.placeBlock(referenceBlock, new Vec3(0, 1, 0))
  }
  /** the console placement (setblock as the bot, item not consumed) for staging */
  t.setblockAsBot = consolePlaceBlock
}

module.exports = install
