// owner: U14 (survival interactions)
// Adapted from mineflayer 4.39.0 lib/plugins/fishing.js (MIT, Copyright (c) 2013 Andrew Kelley): the same fishing
//   task (one at a time, a new bot.fish() cancels the previous one), cast + reel in with bot.activateItem(), the
//   same resolve / reject points and error messages.
// Surface: bot.fish() → resolves when a fish bites (the bot reels it in), rejects with 'Fishing cancelled' when the
//   bobber disappears first, 'Fishing cancelled due to calling bot.fish() again' when called again.
// Bedrock (BDS 1.26.51.1, verified live — docs/differences/U14.md#fishing):
// - cast / reel in = item use click_air with the rod (bot.activateItem); the bobber is an add_entity
//   `minecraft:fishing_hook` (entity name `fishing_hook`) whose `owner_eid` metadata is the bot's unique id;
// - while waiting the hook sends entity_event fish_hook_tease / fish_hook_position (fish approaching); the bite is
//   entity_event `fish_hook_hook` on the hook (Java: 6 fishing / bubble particles next to the bobber), the window to
//   reel in is short, so the bot reels in at once like upstream;
// - the catch is an add_item_entity flying to the bot, collected with take_item_entity (playerCollect); the hook is
//   removed with remove_entity (entityGone).
'use strict'
const { createDoneTask, createTask } = require('mineflayer/lib/promise_utils')

module.exports = inject

function inject (bot) {
  let fishingTask = createDoneTask()
  let lastBobber = null

  /** the bobber was cast by the bot (Bedrock: owner_eid = the bot's unique id); unknown owner → accepted */
  function castByBot (entity) {
    const owner = entity.metadata?.owner_eid
    if (owner === undefined || owner === null) return true
    const ids = bot._bedrock?.ids
    if (!ids?.selfUniqueId) return true
    try {
      return BigInt(owner) === BigInt(ids.selfUniqueId())
    } catch {
      return true
    }
  }

  // upstream: spawn_entity of the bobber type while fishing
  bot.on('entitySpawn', (entity) => {
    if (entity.name === 'fishing_hook' && !fishingTask.done && !lastBobber && castByBot(entity)) {
      lastBobber = entity
    }
  })

  // upstream: world_particles (6 fishing bubbles next to the bobber); Bedrock: entity_event fish_hook_hook
  bot._client.on('entity_event', (packet) => {
    if (!lastBobber || fishingTask.done) return
    if (packet.event_id !== 'fish_hook_hook') return
    if (Number(packet.runtime_entity_id) !== lastBobber.id) return
    bot.activateItem()
    lastBobber = undefined
    fishingTask.finish()
  })

  // upstream: entity_destroy of the bobber
  bot.on('entityGone', (entity) => {
    if (!lastBobber) return
    if (entity === lastBobber || entity.id === lastBobber.id) {
      lastBobber = undefined
      fishingTask.cancel(new Error('Fishing cancelled'))
    }
  })

  async function fish () {
    if (!fishingTask.done) {
      fishingTask.cancel(new Error('Fishing cancelled due to calling bot.fish() again'))
    }

    fishingTask = createTask()

    bot.activateItem()

    await fishingTask.promise
  }

  bot.fish = fish
}
