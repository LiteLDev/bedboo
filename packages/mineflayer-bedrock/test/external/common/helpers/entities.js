// owner: U1 (wave 1) → U7 (wave 3)
'use strict'
/**
 * Entity helpers (upstream testCommon.js: killEntity; plus summon) over the BDS console. Completion is observed
 * through the entities plugin (`entitySpawn` / `entityGone` with real mineflayer entities) once it is implemented,
 * else through the raw `add_entity` / `remove_entity` tracker.
 */

/** registry (entity identifier) name → the name `/summon` accepts, where they differ */
const SUMMON_NAMES = { villager_v2: 'villager', zombie_villager_v2: 'zombie_villager' }

function install (bot, ctx) {
  const { state, TIMEOUT, implemented } = ctx
  const t = bot.test

  /** the entities plugin (U7) is real: bot.entities holds mineflayer entities */
  const realEntities = () => implemented(bot.nearestEntity)

  /** Wait for a bot event (arm before triggering). @returns {{ promise: Promise<any[]>, cancel: () => void }} */
  function botEvent (name, predicate = () => true, timeout = TIMEOUT) {
    let cancel
    const promise = new Promise((resolve, reject) => {
      const fn = (...args) => {
        let ok
        try { ok = predicate(...args) } catch (err) { done(); return reject(err) }
        if (ok) { done(); resolve(args) }
      }
      const timer = setTimeout(() => { done(); reject(new Error(`timed out after ${timeout} ms waiting for ${name}`)) }, timeout)
      function done () {
        clearTimeout(timer)
        bot.removeListener(name, fn)
      }
      cancel = () => { done(); resolve(null) }
      bot.on(name, fn)
    })
    return { promise, cancel }
  }

  /** Bedrock unique id of a mineflayer entity (id = Number(runtime id)) or of a summon() result. */
  function uniqueIdOf (entity) {
    if (entity.uniqueId !== undefined && entity.uniqueId !== null) return BigInt(entity.uniqueId)
    const tracked = state.entities.get(entity.id)
    if (tracked) return tracked.uniqueId
    const fromIds = bot._bedrock?.ids?.runtimeToUnique?.get(BigInt(entity.id))
    return fromIds !== undefined ? BigInt(fromIds) : null
  }

  /**
   * Summon `type` (Bedrock entity name, e.g. 'zombie', or the registry name such as 'villager_v2') at `position`
   * (default: 2 blocks east of the bot) in the bot's dimension. Resolves with `bot.entities[id]` when the entity plugin knows it,
   * else the raw descriptor `{ id, runtimeId, uniqueId, type, name, position }`.
   * @param {string} type
   * @param {{ x: number, y: number, z: number }} [position]
   * @param {{ timeout?: number, spawnEvent?: string, nameTag?: string }} [opts] `spawnEvent`: the entity's spawn
   *   event (e.g. 'minecraft:as_adult', 'minecraft:entity_born' for babies), `nameTag`: its name tag
   */
  t.summon = async (type, position, opts = {}) => {
    const given = String(type).replace(/^minecraft:/, '')
    const name = Object.keys(SUMMON_NAMES).find((n) => SUMMON_NAMES[n] === given) ?? given // as reported (registry name)
    const summonName = SUMMON_NAMES[name] ?? name
    const pos = position ?? ctx.position()?.offset(2, 0, 0)
    if (!pos) throw new Error('summon: bot position unknown')
    const match = (e) => e.name === name && e.position.distanceTo(pos) < 2
    const timeout = opts.timeout ?? TIMEOUT
    let spawned
    if (realEntities()) {
      const ev = botEvent('entitySpawn', match, timeout)
      spawned = ev.promise
      spawned.cancel = ev.cancel
    } else {
      spawned = ctx.event('entitySpawn', match, timeout)
    }
    spawned.catch(() => {})
    let extra = ''
    if (opts.spawnEvent || opts.nameTag) extra = ` 0 0 ${opts.spawnEvent ?? 'minecraft:entity_spawned'}${opts.nameTag ? ` ${JSON.stringify(opts.nameTag)}` : ''}`
    try {
      await ctx.consoleExpect(`${ctx.inDimension()}summon ${summonName} ${pos.x} ${pos.y} ${pos.z}${extra}`, /successfully summoned/i, `summon ${summonName}`)
    } catch (err) {
      spawned.cancel?.()
      throw err
    }
    const [entity] = await spawned
    return bot.entities?.[entity.id] ?? entity
  }

  /**
   * Upstream: `/kill @e[type=<entity.name>]` and resolve when this entity is gone (the death animation
   * keeps it around for about a second).
   */
  t.killEntity = async (entity) => {
    const type = String(entity.name ?? entity.type).replace(/^minecraft:/, '') // selectors take the identifier (villager_v2)
    let gone
    if (realEntities() && bot.entities?.[entity.id]) {
      gone = botEvent('entityGone', (e) => e.id === entity.id, TIMEOUT)
    } else {
      const uniqueId = uniqueIdOf(entity)
      if (uniqueId === null) throw new Error(`killEntity: unknown entity ${entity.id}`)
      gone = ctx.packet('remove_entity', (p) => BigInt(p.entity_id_self) === uniqueId, TIMEOUT)
    }
    gone.promise.catch(() => {})
    try {
      await ctx.consoleExpect(`${ctx.inDimension()}kill @e[type=${type}]`, /^Killed/, `killEntity(${type})`)
    } catch (err) {
      gone.cancel()
      throw err
    }
    await gone.promise
  }

  /** Kill every non-player entity around (staging cleanup); resolves once the console answered. */
  t.killAllEntities = async () => {
    await ctx.consoleOutput(`${ctx.inDimension()}kill @e[type=!player]`)
  }

  /** Raw-tracked entities (Number(runtime id) → descriptor). */
  t.rawEntities = () => state.entities

  /** Wait for a bot event: `bot.test.botEvent(name, predicate, timeout) → { promise, cancel }` (arm before triggering). */
  t.botEvent = botEvent
}

module.exports = install
