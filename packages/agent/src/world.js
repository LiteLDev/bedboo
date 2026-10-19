// owner: U17 (agent core & overworld milestones)
'use strict'
/** World queries over the public mineflayer API (`bot.blockAt`, `bot.findBlocks`). */
const { Vec3 } = require('vec3')
const { agentOf } = require('./skill')

const FACES = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(0, 0, -1), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(1, 0, 0)]
const HORIZONTAL = [new Vec3(1, 0, 0), new Vec3(0, 0, 1), new Vec3(-1, 0, 0), new Vec3(0, 0, -1)]

const LAVA = new Set(['lava', 'flowing_lava'])
const WATER = new Set(['water', 'flowing_water', 'bubble_column'])
const FALLING = new Set(['sand', 'red_sand', 'gravel', 'suspicious_sand', 'suspicious_gravel', 'pointed_dripstone', 'anvil', 'concrete_powder'])
const PROTECTED = new Set(['bedrock', 'chest', 'trapped_chest', 'barrel', 'spawner', 'mob_spawner', 'end_portal_frame', 'portal', 'end_portal', 'reinforced_deepslate'])

const isLava = (b) => !!b && LAVA.has(b.name)
const isWater = (b) => !!b && (WATER.has(b.name) || b.isWaterlogged === true)
const isLiquid = (b) => isLava(b) || isWater(b)
const isAir = (b) => !!b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air')
/** walk-through: no collision box and no liquid (air, grass, flowers, torches, …) */
const isPassable = (b) => !!b && b.boundingBox === 'empty' && !isLiquid(b)
/** something to stand on */
const isSolid = (b) => !!b && b.boundingBox === 'block' && !isLiquid(b)
const isFalling = (b) => !!b && (FALLING.has(b.name) || /concrete_powder$/.test(b.name))

/** registry ids of block names (unknown names skipped) */
function blockIds (bot, names) {
  const out = []
  for (const name of [].concat(names)) {
    const b = bot.registry.blocksByName[name]
    if (b) out.push(b.id)
  }
  return out
}

/**
 * Positions of blocks named `names` around `point` (default: the bot), nearest first.
 * @param {object} bot
 * @param {string|string[]} names
 * @param {{ maxDistance?: number, count?: number, point?: Vec3, filter?: (pos: Vec3) => boolean }} [opts]
 * @returns {Vec3[]}
 */
function findBlocks (bot, names, { maxDistance = 64, count = 64, point, filter } = {}) {
  const ids = blockIds(bot, names)
  if (!ids.length) return []
  const found = bot.findBlocks({ matching: ids, maxDistance, count: filter ? Math.max(count * 8, 256) : count, point })
  return (filter ? found.filter(filter) : found).slice(0, count)
}

/** neighbours of `pos` holding lava (any face) */
function lavaAround (bot, pos) {
  return FACES.some((f) => isLava(bot.blockAt(pos.plus(f))))
}

/** whether digging `pos` lets a liquid flow in (a liquid on a side or above; below does not flow up) */
function exposesLiquid (bot, pos, { ignore = [] } = {}) {
  for (const f of FACES) {
    if (f.y === -1) continue
    const p = pos.plus(f)
    if (ignore.some((q) => q.equals(p))) continue
    if (isLiquid(bot.blockAt(p))) return true
  }
  return false
}

/**
 * Safe to dig `pos`: diggable, not protected, no liquid flowing in, and no lava right below it.
 * @param {object} bot
 * @param {Vec3} pos
 */
function safeToDig (bot, pos, opts = {}) {
  const block = bot.blockAt(pos)
  if (!block) return false
  if (isAir(block) || isPassable(block)) return true
  if (!block.diggable || PROTECTED.has(block.name) || isLiquid(block)) return false
  if (isProtected(bot, pos)) return false
  if (exposesLiquid(bot, pos, opts)) return false
  if (isLava(bot.blockAt(pos.offset(0, -1, 0)))) return false
  return true
}

/** whether the bot can stand at `pos` (feet): solid below, the feet and head cells passable */
function standable (bot, pos) {
  return isSolid(bot.blockAt(pos.offset(0, -1, 0))) && isPassable(bot.blockAt(pos)) && isPassable(bot.blockAt(pos.offset(0, 1, 0)))
}

/** y of the highest standable cell (feet) of column x, z between `top` and `bottom`, or null */
function surfaceY (bot, x, z, { top = 320, bottom = -64, ground = isGround } = {}) {
  for (let y = top; y > bottom; y--) {
    const b = bot.blockAt(new Vec3(x, y, z))
    if (b && ground(b)) return y + 1
  }
  return null
}

/** natural ground: solid, not leaves / logs (tree parts are not ground) */
function isGround (b) {
  return isSolid(b) && !/leaves|_log$|_wood$/.test(b.name)
}

/** blocks of the bot's current column (feet cell) */
function feet (bot) {
  return bot.entity.position.floored()
}

/** inside a zone the agent must not dig (its builds: the Agent's `state.protectedZones`, filled by the build skill) */
function isProtected (bot, pos) {
  const zones = agentOf(bot)?.state?.protectedZones ?? []
  return zones.some((z) => pos.x >= z.min.x && pos.x <= z.max.x && pos.y >= z.min.y && pos.y <= z.max.y && pos.z >= z.min.z && pos.z <= z.max.z)
}

/** horizontal distance */
function distXZ (a, b) {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

/** the cardinal direction (unit Vec3) closest to `from → to` */
function cardinalTowards (from, to) {
  const dx = to.x - from.x
  const dz = to.z - from.z
  if (Math.abs(dx) >= Math.abs(dz)) return new Vec3(Math.sign(dx) || 1, 0, 0)
  return new Vec3(0, 0, Math.sign(dz) || 1)
}

/** the biome name at a position (null when unknown) */
function biomeAt (bot, pos) {
  const b = bot.blockAt(pos)
  return b?.biome?.name ?? null
}

/**
 * Loaded positions (sampled every `step` blocks around the bot, at its height) whose biome is one of `biomes`,
 * nearest first.
 */
function findBiome (bot, biomes, { radius = 160, step = 8 } = {}) {
  const want = new Set(biomes)
  const origin = bot.entity.position.floored()
  const out = []
  for (let dx = -radius; dx <= radius; dx += step) {
    for (let dz = -radius; dz <= radius; dz += step) {
      if (dx * dx + dz * dz > radius * radius) continue
      const p = new Vec3(origin.x + dx, Math.max(-60, Math.min(300, origin.y)), origin.z + dz)
      const name = biomeAt(bot, p)
      if (name && want.has(name)) out.push(p)
    }
  }
  out.sort((a, b) => distXZ(a, origin) - distXZ(b, origin))
  return out
}

module.exports = {
  FACES,
  HORIZONTAL,
  LAVA,
  WATER,
  FALLING,
  PROTECTED,
  isLava,
  isWater,
  isLiquid,
  isAir,
  isPassable,
  isSolid,
  isFalling,
  isGround,
  blockIds,
  findBlocks,
  lavaAround,
  exposesLiquid,
  safeToDig,
  standable,
  surfaceY,
  feet,
  isProtected,
  distXZ,
  cardinalTowards,
  biomeAt,
  findBiome
}
