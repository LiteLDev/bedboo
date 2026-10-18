// owner: U9 (player state, world extras & dimensions)
// Upstream: mineflayer 4.39.0 lib/plugins/breath.js + entities.js `air_supply` metadata (MIT, Copyright (c) 2013
//   Andrew Kelley): bot.oxygenLevel = round(air / 15), 'breath' for every metadata update carrying the air supply.
// Surface: bot.oxygenLevel (0..20; upstream undefined until the first metadata update, typed default 20 here)
// Events: 'breath'
// Bedrock: set_entity_data of the local player, metadata key `air` (short, 0..300 ticks — the Java air_supply
//   scale). U4's entity_data.js stores the metadata on bot.entity; this plugin reads the packet itself.
'use strict'

module.exports = inject

function inject (bot) {
  bot.oxygenLevel = 20

  bot._client.on('set_entity_data', (packet) => {
    if (!bot._bedrock?.ids?.isSelf(packet.runtime_entity_id)) return
    const air = packet.metadata?.find(m => m.key === 'air')
    if (!air || air.value === undefined || air.value === null) return
    bot.oxygenLevel = Math.round(Number(air.value) / 15)
    bot.emit('breath')
  })
}
