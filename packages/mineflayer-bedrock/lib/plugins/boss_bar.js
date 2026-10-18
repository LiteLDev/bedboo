// owner: U6 (chat, commands & HUD)
// Upstream: mineflayer 4.39.0 lib/plugins/boss_bar.js (BossBar class: mineflayer/lib/bossbar)
// Surface: bot.bossBars (getter → BossBar[])
// Events: 'bossBarCreated' / 'bossBarDeleted' / 'bossBarUpdated' (bossBar)
// Bedrock: boss_event {boss_entity_id (unique id), type: show_bar|remove_bar|update_percent|
//   update_title|update_properties|texture, title, progress, color, overlay}.
'use strict'

module.exports = inject

function inject (bot) {
  const bars = {}
  Object.defineProperty(bot, 'bossBars', {
    get () {
      return Object.values(bars)
    }
  })
}
