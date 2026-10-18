// owner: U4 (core runtime)
'use strict'
const { stubSync } = require('./errors')

/**
 * Id bookkeeping, exposed as `bot._bedrock.ids` (created by the loader).
 *
 * Entities: Bedrock packets reference an entity either by its *runtime* id (varint64; most
 * packets) or by its *unique* id (zigzag64; add_entity/add_player `unique_id`, set_entity_link,
 * boss_event, …). mineflayer `Entity.id` is `Number(runtimeId)`. U7 registers every entity with
 * `trackEntity` on add_* and drops it with `untrackEntity` on remove_entity (which carries the
 * unique id). The local player's ids come from start_game (`runtime_entity_id`, `entity_id`).
 *
 * Items: the network id ↔ identifier table comes from the `item_registry` packet (1.21.60+);
 * blocks use hashed runtime ids (FNV-1a of the block state, start_game `block_network_ids_are_hashes`)
 * resolved by prismarine-registry/-chunk (U2).
 *
 * @typedef {object} BedrockIds
 * @property {Map<bigint, bigint>} runtimeToUnique runtime id → unique id
 * @property {Map<bigint, bigint>} uniqueToRuntime unique id → runtime id
 * @property {(runtimeId: bigint|number, uniqueId: bigint|number) => void} trackEntity
 * @property {(uniqueOrRuntime: { uniqueId?: bigint|number, runtimeId?: bigint|number }) => number|undefined} untrackEntity
 *   forget an entity, returns its mineflayer entity id (Number(runtime id)) if known
 * @property {(runtimeId: bigint|number) => number} entityId mineflayer entity id from a runtime id
 * @property {(uniqueId: bigint|number) => number|undefined} entityIdFromUnique
 * @property {(networkId: number) => string|undefined} itemName item identifier (without `minecraft:`) from network id
 * @property {(name: string) => number|undefined} itemNetworkId network id from item name
 * @property {(itemRegistryPacket: object) => void} loadItemRegistry fill the item tables
 */

/** @returns {BedrockIds} */
function createIds () {
  const runtimeToUnique = new Map()
  const uniqueToRuntime = new Map()

  return {
    runtimeToUnique,
    uniqueToRuntime,
    trackEntity (runtimeId, uniqueId) {
      runtimeToUnique.set(BigInt(runtimeId), BigInt(uniqueId))
      uniqueToRuntime.set(BigInt(uniqueId), BigInt(runtimeId))
    },
    untrackEntity ({ uniqueId, runtimeId } = {}) {
      let runtime = runtimeId != null ? BigInt(runtimeId) : undefined
      let unique = uniqueId != null ? BigInt(uniqueId) : undefined
      if (runtime === undefined && unique !== undefined) runtime = uniqueToRuntime.get(unique)
      if (unique === undefined && runtime !== undefined) unique = runtimeToUnique.get(runtime)
      if (runtime !== undefined) runtimeToUnique.delete(runtime)
      if (unique !== undefined) uniqueToRuntime.delete(unique)
      return runtime !== undefined ? Number(runtime) : undefined
    },
    entityId (runtimeId) {
      return Number(runtimeId)
    },
    entityIdFromUnique (uniqueId) {
      const runtime = uniqueToRuntime.get(BigInt(uniqueId))
      return runtime !== undefined ? Number(runtime) : undefined
    },
    itemName: stubSync('U4', 'bot._bedrock.ids.itemName', 1),
    itemNetworkId: stubSync('U4', 'bot._bedrock.ids.itemNetworkId', 1),
    loadItemRegistry: stubSync('U4', 'bot._bedrock.ids.loadItemRegistry', 1)
  }
}

module.exports = { createIds }
