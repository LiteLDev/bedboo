// owner: U6 (chat, commands & HUD)
// Adapted from mineflayer 4.39.0 lib/plugins/boss_bar.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer); BossBar class: mineflayer/lib/bossbar (subclassed for Bedrock colours).
// Surface: bot.bossBars (getter → BossBar[])
// Events: 'bossBarCreated' / 'bossBarDeleted' / 'bossBarUpdated' (bossBar)
// Bedrock (BDS 1.26.51.1, docs/differences/U6.md#boss-bars): there is no /bossbar command; boss bars belong to boss
//   entities (wither, ender dragon). boss_event { target_entity_id (boss unique id), type, title, progress, color,
//   overlay }:
//   - show_bar: the first one for an entity creates the bar ('bossBarCreated'); BDS re-sends show_bar about once a
//     second with the current progress: a later one that changes a field updates the bar ('bossBarUpdated');
//   - set_bar_progress / set_bar_title / update_properties / texture → 'bossBarUpdated'; hide_bar → 'bossBarDeleted';
//   - BDS sends no hide_bar when the boss dies or leaves the view: the client drops the bar with the entity, so
//     remove_entity of the boss (and a dimension change) → 'bossBarDeleted'.
//   BossBar fields: entityUUID = the boss entity's unique id (string), title = ChatMessage (an unnamed boss's title
//   is a translation key, e.g. entity.wither.name → "Wither"), health = progress (0..1), dividers from the overlay
//   (progress 0, notched_6/10/12/20), color = the Bedrock colour name (pink, blue, red, green, yellow, purple,
//   rebecca_purple, white), flags from the boss type when the entity is known (wither: darken sky; ender dragon:
//   dragon bar + fog).
'use strict'
const { parserFor } = require('../bedrock/text')
const { idKey } = require('../bedrock/player_list')

module.exports = inject

const OVERLAY_DIVIDERS = { progress: 0, notched_6: 1, notched_10: 2, notched_12: 3, notched_20: 4 }
const DIVISIONS = [0, 6, 10, 12, 20] // mineflayer/lib/bossbar: divider index → notches
const BEDROCK_COLORS = ['pink', 'blue', 'red', 'green', 'yellow', 'purple', 'rebecca_purple', 'white']
const BOSS_FLAGS = { wither: 0x1, ender_dragon: 0x2 | 0x4 }

function inject (bot) {
  const UpstreamBossBar = require('mineflayer/lib/bossbar')(bot.registry)
  // Bedrock has colours Java does not (rebecca_purple): keep the colour name the server sent
  class BossBar extends UpstreamBossBar {
    set color (color) {
      this._color = typeof color === 'number' ? BEDROCK_COLORS[color] : color
    }

    get color () {
      return this._color
    }
  }

  const text = parserFor(bot.registry)
  const bars = {}
  const titleOf = (title) => text.translated(title ?? '')
  const dividersOf = (overlay) => OVERLAY_DIVIDERS[overlay] ?? (typeof overlay === 'number' ? overlay : 0)
  function flagsOf (uniqueId) {
    try {
      const id = bot._bedrock?.ids?.entityIdFromUnique(BigInt(uniqueId))
      const name = id === undefined ? undefined : bot.entities?.[id]?.name
      return BOSS_FLAGS[String(name ?? '').replace(/^minecraft:/, '')] ?? 0
    } catch {
      return 0
    }
  }

  function remove (key) {
    const bar = bars[key]
    if (!bar) return
    delete bars[key]
    bot.emit('bossBarDeleted', bar)
  }

  bot._client.on('boss_event', (packet) => {
    const key = idKey(packet.target_entity_id)
    if (packet.type === 'show_bar') {
      const bar = bars[key]
      if (!bar) {
        const created = new BossBar(key, titleOf(packet.title), packet.progress, dividersOf(packet.overlay), 0, flagsOf(packet.target_entity_id))
        created.color = packet.color // the upstream constructor indexes Java's colour table
        bars[key] = created
        bot.emit('bossBarCreated', created)
        return
      }
      // BDS re-sends show_bar every second: like Java, only a change is an update
      const title = titleOf(packet.title)
      const changed = JSON.stringify(title) !== JSON.stringify(bar.title?.json) || bar.health !== packet.progress ||
        bar.dividers !== DIVISIONS[dividersOf(packet.overlay)] || bar.color !== packet.color
      if (!changed) return
      bar.title = title
      bar.health = packet.progress
      bar.dividers = dividersOf(packet.overlay)
      bar.color = packet.color
      bot.emit('bossBarUpdated', bar)
      return
    }
    if (packet.type === 'hide_bar') {
      remove(key)
      return
    }
    const bar = bars[key]
    if (!bar) return
    switch (packet.type) {
      case 'set_bar_progress':
        if (packet.progress !== undefined) bar.health = packet.progress
        break
      case 'set_bar_title':
        if (packet.title !== undefined) bar.title = titleOf(packet.title)
        break
      case 'update_properties':
      case 'texture':
        if (packet.overlay !== undefined) bar.dividers = dividersOf(packet.overlay)
        if (packet.color !== undefined) bar.color = packet.color
        break
      default: // register_player / unregister_player / query: client → server
        return
    }
    bot.emit('bossBarUpdated', bar)
  })

  bot._client.on('remove_entity', (packet) => remove(idKey(packet.entity_id_self)))
  bot._bedrock?.lifecycle?.events?.on('dimensionChange', () => {
    for (const key of Object.keys(bars)) remove(key)
  })

  Object.defineProperty(bot, 'bossBars', {
    get () {
      return Object.values(bars)
    }
  })
}
