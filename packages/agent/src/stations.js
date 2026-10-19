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
 * Positions next to the bot where a block can be placed on the ground: air (or grass), solid below, outside the
 * bot's hitbox, nearest first.
 */
function placeSpots (bot, { radius = 2, avoid = () => false } = {}) {
  const feet = bot.entity.position.floored()
  const taken = occupied(bot)
  const spots = []
  for (let dy = 0; dy >= -1; dy--) {
    for (let dx = -radius; dx <= radius; dx++) {
      for (let dz = -radius; dz <= radius; dz++) {
        const p = feet.offset(dx, dy, dz)
        if (taken.some((c) => c.equals(p))) continue
        if (avoid(p)) continue
        const b = bot.blockAt(p)
        const below = bot.blockAt(p.offset(0, -1, 0))
        if (!b || !world.isPassable(b) || !world.isSolid(below)) continue
        if (world.isLiquid(bot.blockAt(p.offset(0, 1, 0)))) continue
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
        if (d < 1) continue
        spots.push({ p, d })
      }
    }
  }
  spots.sort((a, b) => a.d - b.d)
  return spots.map((s) => s.p)
}

/**
 * Place the block item `name` next to the bot. @returns {Promise<object>} the placed block
 */
async function placeNear (bot, name, { signal, avoid } = {}) {
  const item = inventory.find(bot, name)
  if (!item) throw new SkillError(`no ${name} to place`, { code: 'MISSING' })
  let lastErr = null
  for (const p of placeSpots(bot, { avoid }).slice(0, 6)) {
    checkAbort(signal)
    try {
      await inventory.equip(bot, name)
      const ref = bot.blockAt(p.offset(0, -1, 0))
      await bot.placeBlock(ref, new Vec3(0, 1, 0))
    } catch (err) {
      lastErr = err
    }
    const placed = bot.blockAt(p)
    if (placed && (STATION_BLOCKS[name] ?? [name]).includes(placed.name)) {
      progress(bot, 'place', { block: placed.name, at: { x: p.x, y: p.y, z: p.z } })
      return placed
    }
  }
  throw new SkillError(`could not place ${name} near ${navigate.fmt(bot.entity.position)}${lastErr ? `: ${lastErr.message}` : ''}`, { code: 'FAILED', cause: lastErr })
}

/**
 * A usable station block: one within `radius` (walks to it), else the carried one placed next to the bot.
 * @returns {Promise<{ block: object, placed: boolean }>}
 */
async function ensureStation (bot, name, { signal, radius = 24, avoid } = {}) {
  const names = STATION_BLOCKS[name] ?? [name]
  const found = world.findBlocks(bot, names, { maxDistance: radius, count: 4, filter: (p) => !avoid?.(p) })
  for (const pos of found) {
    try {
      await navigate.goto(bot, new (goals().GoalLookAtBlock)(pos, bot.world, { reach: 4 }), { signal, timeout: 30000, attempts: 2 })
      const block = bot.blockAt(pos)
      if (block && names.includes(block.name)) return { block, placed: false }
    } catch (err) {
      if (err.code === 'ABORTED') throw err
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

module.exports = { ensureStation, placeNear, placeSpots, pickUp, occupied, STATION_BLOCKS }
