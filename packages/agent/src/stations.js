// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Crafting tables and furnaces: use one nearby, or place the one the bot carries (and take it back afterwards, so the
 * agent travels with its stations instead of crafting new ones everywhere).
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort } = require('./errors')
const { log, progress } = require('./skill')
const world = require('./world')
const inventory = require('./inventory')
const navigate = require('./skills/navigate')

const goals = () => require('mineflayer-pathfinder').goals
const STATION_BLOCKS = { crafting_table: ['crafting_table'], furnace: ['furnace', 'lit_furnace'] }

/** stations the bot could not reach (per bot): never offered again */
const unreachable = new WeakMap()
const posKey = (p) => `${p.x},${p.y},${p.z}`
function isUnreachable (bot, pos) {
  return unreachable.get(bot)?.has(posKey(pos)) ?? false
}
function markUnreachable (bot, pos) {
  if (!unreachable.has(bot)) unreachable.set(bot, new Set())
  unreachable.get(bot).add(posKey(pos))
}

/** a station block the bot can probably use: near, about the same height, not known unreachable */
function stationNear (bot, name, radius = 16) {
  const names = STATION_BLOCKS[name] ?? [name]
  const here = bot.entity.position
  return world.findBlocks(bot, names, {
    maxDistance: radius,
    count: 1,
    filter: (p) => !isUnreachable(bot, p) && Math.abs(p.y - here.y) <= 4
  })[0] ?? null
}

/** world cells the bot's hitbox touches (feet and head, plus neighbours it overlaps) */
function occupied (bot) {
  const p = bot.entity.position
  const half = 0.3
  const cells = []
  for (const x of [Math.floor(p.x - half), Math.floor(p.x + half)]) {
    for (const z of [Math.floor(p.z - half), Math.floor(p.z + half)]) {
      for (const y of [Math.floor(p.y), Math.floor(p.y + 1), Math.floor(p.y + 1.79)]) cells.push(new Vec3(x, y, z))
    }
  }
  return cells
}

/**
 * Cells around the bot where a block can be placed: empty (air, grass, …), outside the bot's hitbox, within reach,
 * with a solid neighbour face to click — on the ground at the feet level first. Each spot is `{ pos, ref, face }`.
 */
function placeSpots (bot, { radius = 2, avoid = () => false } = {}) {
  const feet = bot.entity.position.floored()
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const taken = occupied(bot)
  const spots = []
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = feet.offset(dx, dy, dz)
        if (taken.some((c) => c.equals(p)) || avoid(p) || world.isProtected(bot, p)) continue
        const b = bot.blockAt(p)
        if (!b || !world.isPassable(b)) continue
        if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.2) continue
        // a solid face to click: below first (stands on the ground), then the sides, then above
        let ref = null
        let face = null
        for (const dir of [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]) {
          const r = bot.blockAt(p.plus(dir))
          if (r && world.isSolid(r) && !/chest|furnace|crafting_table|door|bed/.test(r.name)) { ref = r; face = dir.scaled(-1); break }
        }
        if (!ref) continue
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.7 + (face.y === 1 ? 0 : 1.5)
        spots.push({ pos: p, ref, face, d })
      }
    }
  }
  spots.sort((a, b) => a.d - b.d)
  return spots
}

/**
 * Place the block item `name` next to the bot. In a 1×1 shaft / tunnel with no room, a side cell at the feet is dug
 * out first. @returns {Promise<object>} the placed block
 */
async function placeNear (bot, name, { signal, avoid } = {}) {
  const item = inventory.find(bot, name)
  if (!item) throw new SkillError(`no ${name} to place`, { code: 'MISSING' })
  const names = STATION_BLOCKS[name] ?? [name]
  let lastErr = null
  for (let round = 0; round < 2; round++) {
    for (const spot of placeSpots(bot, { avoid }).slice(0, 6)) {
      checkAbort(signal)
      try {
        await inventory.equip(bot, name)
        await bot.placeBlock(spot.ref, spot.face)
      } catch (err) {
        lastErr = err
      }
      const placed = bot.blockAt(spot.pos)
      if (placed && names.includes(placed.name)) {
        progress(bot, 'place', { block: placed.name, at: { x: spot.pos.x, y: spot.pos.y, z: spot.pos.z } })
        return placed
      }
    }
    if (round === 0 && !(await digRoom(bot, signal, avoid))) break
  }
  throw new SkillError(`could not place ${name} near ${navigate.fmt(bot.entity.position)}${lastErr ? `: ${lastErr.message}` : ''}`, { code: 'FAILED', cause: lastErr })
}

/** dig a solid cell beside the feet (no liquid behind it) to make room for a block */
async function digRoom (bot, signal, avoid = () => false) {
  const feet = bot.entity.position.floored()
  for (const d of world.HORIZONTAL) {
    for (const dy of [0, 1]) {
      const p = feet.plus(d).offset(0, dy, 0)
      const b = bot.blockAt(p)
      if (!b || world.isPassable(b) || avoid(p) || !world.safeToDig(bot, p) || world.exposesLiquid(bot, p)) continue
      try {
        await navigate.digSafe(bot, b, signal)
        log(bot, `made room for a station at ${navigate.fmt(p)}`)
        return true
      } catch (err) {
        if (err.code === 'ABORTED') throw err
      }
    }
  }
  return false
}

/**
 * A usable station block: one within `radius` (walks to it), else the carried one placed next to the bot.
 * @returns {Promise<{ block: object, placed: boolean }>}
 */
async function ensureStation (bot, name, { signal, radius = 24, avoid } = {}) {
  const names = STATION_BLOCKS[name] ?? [name]
  const found = world.findBlocks(bot, names, { maxDistance: radius, count: 4, filter: (p) => !avoid?.(p) && !isUnreachable(bot, p) })
  for (const pos of found) {
    try {
      await navigate.goto(bot, new (goals().GoalLookAtBlock)(pos, bot.world, { reach: 4 }), { signal, timeout: 30000, attempts: 2 })
      const block = bot.blockAt(pos)
      if (block && names.includes(block.name)) return { block, placed: false }
    } catch (err) {
      if (err.code === 'ABORTED') throw err
      markUnreachable(bot, pos)
      log(bot, `${name} at ${navigate.fmt(pos)} unreachable: ${err.message}`)
    }
  }
  if (inventory.count(bot, name) > 0) return { block: await placeNear(bot, name, { signal, avoid }), placed: true }
  throw new SkillError(`no ${name} nearby and none carried`, { code: 'MISSING' })
}

/** dig a station the agent placed and pick it up again (best effort) */
async function pickUp (bot, block, { signal } = {}) {
  const dig = require('./dig')
  const current = bot.blockAt(block.position)
  const names = Object.values(STATION_BLOCKS).flat()
  if (!current || !names.includes(current.name)) return false
  const item = current.name === 'lit_furnace' ? 'furnace' : current.name
  try {
    await dig.mineAt(bot, current.position, { signal, item })
    return true
  } catch (err) {
    if (err.code === 'ABORTED') throw err
    log(bot, `could not take the ${item} back: ${err.message}`)
    return false
  }
}

module.exports = { ensureStation, placeNear, placeSpots, digRoom, pickUp, occupied, stationNear, markUnreachable, isUnreachable, STATION_BLOCKS }
