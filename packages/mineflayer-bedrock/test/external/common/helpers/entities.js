// owner: U1 (wave 1) → U7 (wave 3)
'use strict'
/**
 * Entity helpers (upstream testCommon.js: killEntity; plus summon) over the BDS console; completion
 * is observed through raw `add_entity` / `remove_entity` packets.
 */

function install (bot, ctx) {
  const { server, state, TIMEOUT } = ctx
  const t = bot.test

  /** Bedrock unique id of a mineflayer entity (id = Number(runtime id)) or of a summon() result. */
  function uniqueIdOf (entity) {
    if (entity.uniqueId !== undefined && entity.uniqueId !== null) return BigInt(entity.uniqueId)
    const tracked = state.entities.get(entity.id)
    if (tracked) return tracked.uniqueId
    const fromIds = bot._bedrock?.ids?.runtimeToUnique?.get(BigInt(entity.id))
    return fromIds !== undefined ? BigInt(fromIds) : null
  }

  /**
   * Summon `type` (Bedrock entity name, e.g. 'zombie') at `position` (default: 2 blocks east of the
   * bot) in the bot's dimension. Resolves with `bot.entities[id]` when the entity plugin knows it,
   * else the raw descriptor `{ id, runtimeId, uniqueId, type, name, position }`.
   * @param {string} type
   * @param {{ x: number, y: number, z: number }} [position]
   * @param {{ timeout?: number }} [opts]
   */
  t.summon = async (type, position, opts = {}) => {
    const name = String(type).replace(/^minecraft:/, '')
    const pos = position ?? ctx.position()?.offset(2, 0, 0)
    if (!pos) throw new Error('summon: bot position unknown')
    const spawned = ctx.event('entitySpawn', (e) => e.name === name && e.position.distanceTo(pos) < 2, opts.timeout ?? TIMEOUT)
    spawned.catch(() => {})
    const msg = await server.commandWithOutput(`${ctx.inDimension()}summon ${name} ${pos.x} ${pos.y} ${pos.z}`,
      /successfully summoned|No targets matched|Syntax error|Unknown|Could not|Invalid|not a valid|cannot/i)
    if (!/successfully summoned/i.test(msg)) throw new Error(`summon ${name}: ${msg}`)
    const [entity] = await spawned
    return bot.entities?.[entity.id] ?? entity
  }

  /**
   * Upstream: `/kill @e[type=<entity.name>]` and resolve when this entity is gone (the death animation
   * keeps it around for about a second).
   */
  t.killEntity = async (entity) => {
    const uniqueId = uniqueIdOf(entity)
    if (uniqueId === null) throw new Error(`killEntity: unknown entity ${entity.id}`)
    const gone = ctx.packet('remove_entity', (p) => BigInt(p.entity_id_self) === uniqueId, TIMEOUT)
    gone.promise.catch(() => {})
    const type = String(entity.name ?? entity.type).replace(/^minecraft:/, '')
    const msg = await server.commandWithOutput(`${ctx.inDimension()}kill @e[type=${type}]`, /^Killed|No targets matched|Syntax error|Unknown|Invalid|not a valid/i)
    if (!/^Killed/.test(msg)) {
      gone.cancel()
      throw new Error(`killEntity(${type}): ${msg}`)
    }
    await gone.promise
  }

  /** Raw-tracked entities (Number(runtime id) → descriptor). */
  t.rawEntities = () => state.entities
}

module.exports = install
