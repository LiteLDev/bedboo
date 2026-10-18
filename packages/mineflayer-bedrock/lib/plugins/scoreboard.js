// owner: U6 (chat, commands & HUD)
// Adapted from mineflayer 4.39.0 lib/plugins/scoreboard.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer); ScoreBoard class: mineflayer/lib/scoreboard (unchanged).
// Surface: bot.scoreboards {name: ScoreBoard}, bot.scoreboard {list|sidebar|belowName: ScoreBoard} (= ScoreBoard.positions)
// Events: 'scoreboardCreated' / 'scoreboardDeleted' / 'scoreboardTitleChanged' (scoreboard),
//   'scoreUpdated' / 'scoreRemoved' (scoreboard, item), 'scoreboardPosition' (position, scoreboard, previous)
// Bedrock (BDS 1.26.51.1, docs/differences/U6.md#scoreboards): the client only learns about DISPLAYED objectives.
//   set_display_objective { display_slot: list|sidebar|belowname, objective_name, display_name, criteria_name,
//     sort_order }: an unknown objective → new ScoreBoard ('scoreboardCreated'; title = the plain display name),
//     a new display name → 'scoreboardTitleChanged', then 'scoreboardPosition' (0 list, 1 sidebar, 2 belowName —
//     Java's numbers); an empty objective name clears the slot. sort_order ascending (0) → `items` lowest first
//     (Java: always highest first). BDS then sends the objective's current scores.
//   set_score { entries: [{ entry_type: player|entity|fake_player|remove, scoreboard_id, objective_name, score,
//     entity_unique_id | custom_name }] }: change → 'scoreUpdated'; remove (`/scoreboard players reset`) →
//     'scoreRemoved'. Item names: fake players → their name; players → their username (self, player_list);
//     entities → the entity's unique id as a string. scoreboard ids are remembered per entry (remove entries
//     only carry the id), set_scoreboard_identity registers/clears them too.
//   remove_objective { objective_name } → 'scoreboardDeleted' (+ the display slots showing it are cleared).
'use strict'
const { createPlayerNames, idKey } = require('../bedrock/player_list')

module.exports = inject

const DISPLAY_SLOTS = { list: 0, sidebar: 1, belowname: 2 }
const SORT_ASCENDING = 0 // set_display_objective sort_order (1 = descending, Java's only order)
/** upstream ScoreBoard.setTitle JSON.parses the title (a Java component): wrap Bedrock's plain display name */
const titleText = (displayName) => JSON.stringify({ text: String(displayName ?? '') })

function inject (bot) {
  const ScoreBoard = require('mineflayer/lib/scoreboard')(bot)
  const scoreboards = {}
  /** scoreboard id (string) → item name */
  const identities = new Map()
  /** online players' unique ids → usernames (player_list) */
  const playerNames = createPlayerNames(bot._client)

  function playerName (uniqueId) {
    if (bot._bedrock?.ids?.isSelfUnique?.(uniqueId) && bot.username) return bot.username
    const key = idKey(uniqueId)
    const known = playerNames.byUniqueId(key)
    if (known) return known
    for (const player of Object.values(bot.players ?? {})) {
      const entity = player?.entity
      if (entity?.uniqueId !== undefined && idKey(entity.uniqueId) === key) return player.username
    }
    return key
  }

  function entryName (entry) {
    switch (entry.entry_type) {
      case 'fake_player': return entry.custom_name
      case 'player': return playerName(entry.entity_unique_id)
      case 'entity': return idKey(entry.entity_unique_id)
      default: return identities.get(idKey(entry.scoreboard_id))
    }
  }

  /** an ascending objective lists its items lowest first, like the Bedrock client shows it */
  function setSortOrder (scoreboard, sortOrder) {
    if (sortOrder === SORT_ASCENDING) {
      Object.defineProperty(scoreboard, 'items', {
        configurable: true,
        get () {
          return Object.values(this.itemsMap).sort((a, b) => a.value - b.value)
        }
      })
    } else {
      delete scoreboard.items // back to ScoreBoard.prototype.items (highest first)
    }
  }

  function clearPositions (scoreboard) {
    for (const position of Object.values(DISPLAY_SLOTS)) {
      if (ScoreBoard.positions[position] === scoreboard) delete ScoreBoard.positions[position]
    }
  }

  bot._client.on('set_display_objective', (packet) => {
    const position = DISPLAY_SLOTS[String(packet.display_slot).toLowerCase()] ?? packet.display_slot
    const name = packet.objective_name
    if (!name) {
      delete ScoreBoard.positions[position]
      return
    }
    let scoreboard = scoreboards[name]
    if (scoreboard === undefined) {
      scoreboard = new ScoreBoard({ name, displayText: titleText(packet.display_name) })
      scoreboards[name] = scoreboard
      setSortOrder(scoreboard, packet.sort_order)
      bot.emit('scoreboardCreated', scoreboard)
    } else {
      setSortOrder(scoreboard, packet.sort_order)
      if (packet.display_name !== undefined && scoreboard.title !== String(packet.display_name)) {
        scoreboard.setTitle(titleText(packet.display_name))
        bot.emit('scoreboardTitleChanged', scoreboard)
      }
    }
    bot.emit('scoreboardPosition', position, scoreboard, ScoreBoard.positions[position])
    ScoreBoard.positions[position] = scoreboard
  })

  bot._client.on('remove_objective', (packet) => {
    const name = packet.objective_name
    const scoreboard = scoreboards[name]
    if (scoreboard === undefined) return
    bot.emit('scoreboardDeleted', scoreboard)
    delete scoreboards[name]
    clearPositions(scoreboard)
  })

  bot._client.on('set_score', (packet) => {
    for (const entry of packet.entries ?? []) {
      if (entry.entry_type === 'remove') {
        const name = identities.get(idKey(entry.scoreboard_id))
        if (name === undefined) continue
        const scoreboard = entry.objective_name ? scoreboards[entry.objective_name] : undefined
        if (scoreboard !== undefined) {
          if (!(name in scoreboard.itemsMap)) continue
          bot.emit('scoreRemoved', scoreboard, scoreboard.remove(name))
          continue
        }
        for (const sb of Object.values(scoreboards)) {
          if (name in sb.itemsMap) bot.emit('scoreRemoved', sb, sb.remove(name))
        }
        continue
      }
      const name = entryName(entry)
      if (name === undefined) continue
      identities.set(idKey(entry.scoreboard_id), name)
      const scoreboard = scoreboards[entry.objective_name]
      if (scoreboard === undefined) continue
      const updated = scoreboard.add(name, entry.score)
      bot.emit('scoreUpdated', scoreboard, updated)
    }
  })

  bot._client.on('set_scoreboard_identity', (packet) => {
    for (const entry of packet.entries ?? []) {
      const key = idKey(entry.scoreboard_id)
      if (packet.action === 'clear_identity') identities.delete(key)
      else if (entry.entity_unique_id !== undefined) identities.set(key, playerName(entry.entity_unique_id))
    }
  })

  bot.scoreboards = scoreboards
  bot.scoreboard = ScoreBoard.positions
}
