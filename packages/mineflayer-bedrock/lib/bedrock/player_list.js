// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Online player names from bedrock-protocol `player_list` packets, for the plugins that need a name before (or
 * without) the entities plugin: the chat plugin (tab completion of player names) and the scoreboard (player score
 * entries carry the player's unique id). `bot.players` (entities plugin) stays the public API.
 *
 * `player_list.records` is an array of records `{ type: 'add'|'remove', uuid, entity_unique_id, username, … }`
 * (BDS 1.26.51.1); the older `{ type, records }` shape is accepted too.
 */

/** the records of a player_list packet, each with its `type` */
function playerListRecords (packet) {
  const list = packet?.records
  if (Array.isArray(list)) return list
  return (list?.records ?? []).map(r => ({ type: list.type, ...r }))
}

/** canonical string key of a 64-bit id (BigInt, number, SignedBigInt-like or string) */
function idKey (id) {
  try {
    return String(BigInt(id))
  } catch {
    return String(id)
  }
}

/**
 * @param {import('events').EventEmitter} client bedrock-protocol client
 * @returns {{ names: () => string[], byUniqueId: (uniqueId) => string|undefined }}
 */
function createPlayerNames (client) {
  const byUuid = new Map() // uuid → { username, unique: string|null }
  const byUnique = new Map() // unique id key → username
  client.on('player_list', (packet) => {
    for (const record of playerListRecords(packet)) {
      const previous = byUuid.get(record.uuid)
      if (record.type === 'add' && record.username) {
        if (previous?.unique) byUnique.delete(previous.unique)
        const unique = record.entity_unique_id !== undefined ? idKey(record.entity_unique_id) : null
        byUuid.set(record.uuid, { username: record.username, unique })
        if (unique) byUnique.set(unique, record.username)
      } else if (record.type === 'remove' && previous) {
        byUuid.delete(record.uuid)
        if (previous.unique) byUnique.delete(previous.unique)
      }
    }
  })
  return {
    names: () => [...byUuid.values()].map(p => p.username),
    byUniqueId: (uniqueId) => byUnique.get(idKey(uniqueId))
  }
}

module.exports = { playerListRecords, idKey, createPlayerNames }
