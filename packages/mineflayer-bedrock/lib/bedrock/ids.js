// owner: U4 (core runtime)
'use strict'

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
 * @property {(startGame: object) => void} setSelf remember the local player's ids (the loader calls it on start_game)
 * @property {() => bigint|null} selfRuntimeId local player runtime id (null before start_game)
 * @property {() => bigint|null} selfUniqueId local player unique id (null before start_game)
 * @property {(runtimeId: bigint|number|null|undefined) => boolean} isSelf whether a runtime id is the local player
 * @property {(uniqueId: bigint|number|null|undefined) => boolean} isSelfUnique whether a unique id is the local player
 */

/** @returns {BedrockIds} */
function createIds () {
  const runtimeToUnique = new Map()
  const uniqueToRuntime = new Map()
  const itemNames = new Map() // network id → name without namespace
  const itemIds = new Map() // name (with and without `minecraft:`) → network id
  let selfRuntime = null
  let selfUnique = null

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
    setSelf (startGame) {
      selfRuntime = BigInt(startGame.runtime_entity_id)
      selfUnique = BigInt(startGame.entity_id)
    },
    selfRuntimeId () {
      return selfRuntime
    },
    selfUniqueId () {
      return selfUnique
    },
    isSelf (runtimeId) {
      return selfRuntime !== null && runtimeId !== undefined && runtimeId !== null && BigInt(runtimeId) === selfRuntime
    },
    isSelfUnique (uniqueId) {
      return selfUnique !== null && uniqueId !== undefined && uniqueId !== null && BigInt(uniqueId) === selfUnique
    },
    itemName (networkId) {
      return itemNames.get(Number(networkId))
    },
    itemNetworkId (name) {
      return itemIds.get(String(name))
    },
    /** item_registry (or a start_game carrying `itemstates`): `{ itemstates: [{ name, runtime_id }] }` */
    loadItemRegistry (packet) {
      for (const state of packet?.itemstates ?? []) {
        const name = String(state.name).replace(/^minecraft:/, '')
        itemNames.set(state.runtime_id, name)
        itemIds.set(name, state.runtime_id)
        itemIds.set(String(state.name), state.runtime_id)
      }
    }
  }
}

module.exports = { createIds }
