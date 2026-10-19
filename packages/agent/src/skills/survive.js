// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Survival chores.
 *
 * Skill `food` — args: { min?: 8 }: make sure the bot carries food worth `min` hunger points (hunts passive animals
 *   in sight — exploring a little for them — and picks up the meat; mineflayer-auto-eat eats it when hungry).
 *   result: { foodPoints, hunted: { [mob]: n } }
 * Skill `surface` — args: {}: get out of a mine to the open sky above (pathfinder towers / digs up; the shaft the
 *   bot came down is fine). result: { position }
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, waitTicks, agentOf } = require('../skill')
const inventory = require('../inventory')
const world = require('../world')
const data = require('../data')
const navigate = require('./navigate')

/** hunger points of the food the bot carries (raw chicken / rotten flesh do not count) */
function foodPoints (bot) {
  let n = 0
  const foods = bot.registry.foodsByName ?? {}
  for (const item of bot.inventory.items()) {
    if (!data.FOODS.includes(item.name) || item.name === 'chicken') continue
    n += (foods[item.name]?.foodPoints ?? 2) * item.count
  }
  return n
}

const PREY = ['cow', 'pig', 'sheep', 'mooshroom', 'chicken', 'rabbit']

function nearestPrey (bot, radius = 64) {
  const { preyOk } = require('./obtain')
  return bot.nearestEntity((e) => PREY.includes(e.name) && preyOk(bot, e) && e.position.distanceTo(bot.entity.position) <= radius) ?? null
}

const COOKED = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit' }

/** raw meat → cooked (more than twice the food) when a furnace and fuel are at hand and there is time */
async function cook (bot, { signal, deadline }) {
  const smelt = require('./smelt')
  const stations = require('../stations')
  for (const [raw, cooked] of Object.entries(COOKED)) {
    const n = inventory.count(bot, raw)
    // 10 s per item in the furnace + placing / opening / taking the furnace back
    if (!n || Date.now() + 10000 * n + 15000 > deadline) continue
    if (!inventory.count(bot, 'furnace') && !stations.stationNear(bot, 'furnace')) return
    if (!smelt.chooseFuel(bot, { input: raw, inputCount: n })) return
    try {
      await smelt.smeltItem(bot, { item: cooked, count: n, input: raw, signal })
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `food: cooking ${raw}: ${err.message}`)
      return
    }
  }
}

async function food (bot, { min = 8, signal, timeout = 150000, explore: mayExplore = true, radius = 64 } = {}) {
  const started = Date.now()
  const hunted = {}
  const explore = require('./explore')
  const { hunt } = require('./obtain')
  // mineflayer-auto-eat eats what the hunt brings while the bot is hungry: a well-fed bot counts as done
  while (foodPoints(bot) < min && bot.food < 18) {
    checkAbort(signal)
    if (Date.now() - started > timeout) break
    let prey = nearestPrey(bot, radius)
    log(bot, `food: ${foodPoints(bot)} points carried; prey ${prey ? `${prey.name} at ${prey.position.distanceTo(bot.entity.position).toFixed(0)}` : 'none in sight'}`)
    if (!prey) {
      if (!mayExplore) break
      await surface(bot, { signal }).catch((err) => { if (isAbort(err)) throw err })
      const r = await explore.explore(bot, { until: () => nearestPrey(bot, 48), maxDistance: 160, signal, timeout: Math.max(20000, timeout - (Date.now() - started)) })
      prey = r.found ? nearestPrey(bot) : null
      if (!prey) break
    }
    const drop = prey.name === 'sheep' ? 'mutton' : prey.name === 'pig' ? 'porkchop' : prey.name === 'chicken' ? 'chicken' : prey.name === 'rabbit' ? 'rabbit' : 'beef'
    try {
      await hunt(bot, { mobs: [prey.name], item: drop, count: 1, signal, radius })
      hunted[prey.name] = (hunted[prey.name] ?? 0) + 1
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      log(bot, `food: hunting ${prey.name} failed: ${err.message}`)
    }
  }
  await cook(bot, { signal, deadline: started + timeout })
  const points = foodPoints(bot)
  progress(bot, 'food', { points, hunted })
  if (points === 0 && bot.food < 18 && !Object.keys(hunted).length) throw new SkillError('no food found', { code: 'NOT_FOUND', details: { hunted } })
  return { foodPoints: points, hunted }
}

/** whether nothing solid is above the bot's head (up to the top of the loaded column) */
function underOpenSky (bot) {
  const feet = bot.entity.position.floored()
  // leaves do not count as a roof; water does until the head is out of it (climbUp swims up)
  const roof = (b) => world.isSolid(b) && !/leaves/.test(b.name)
  const top = world.surfaceY(bot, feet.x, feet.z, { top: 319, bottom: feet.y - 1, ground: roof })
  if (top !== null && top > feet.y) return false
  if (world.isWater(bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored()))) return false
  // the bottom of an open shaft is not the surface: walled in on all four sides by ground higher than the head
  // (one high side is just a cliff)
  return !world.HORIZONTAL.every((d) => {
    const around = world.surfaceY(bot, feet.x + d.x, feet.z + d.z, { top: Math.min(319, feet.y + 24), bottom: feet.y - 1, ground: roof })
    return around !== null && around > feet.y + 2
  })
}

/**
 * Up to the open sky: climb the column the bot stands in (pillar up: dig over the head, jump, put a block under the
 * feet), a staircase step aside where liquid is above, pathfinder as the last resort.
 * @returns {Promise<{ position }>}
 */
async function surface (bot, { signal, timeout = 240000 } = {}) {
  const started = Date.now()
  if (!underOpenSky(bot)) {
    let feet = bot.entity.position.floored()
    if (columnWet(bot, feet.x, feet.z, feet.y)) {
      // a lake / an aquifer above: climbing into it ends at the bottom of the water (sand falls in, the bot drowns);
      // move under a dry column first (pathfinder tunnels on this level)
      const dry = dryColumn(bot, feet)
      if (!dry) log(bot, `surface: water above ${navigate.fmt(feet)} and no dry column within 16 blocks`)
      if (dry) {
        const { goals } = require('mineflayer-pathfinder')
        log(bot, `surface: water above ${navigate.fmt(feet)}; climbing at ${dry.x}, ${dry.z} instead`)
        await navigate.goto(bot, new goals.GoalBlock(dry.x, feet.y, dry.z), { signal, timeout: 60000, attempts: 2 })
          .catch((err) => { if (isAbort(err)) throw err; log(bot, `surface: ${err.message}`) })
        feet = bot.entity.position.floored()
      }
    }
    try {
      // staircase steps move the bot to other columns: aim again at the surface of the column it is in
      for (let i = 0; i < 6 && !underOpenSky(bot) && Date.now() - started < timeout; i++) {
        const f = bot.entity.position.floored()
        const top = world.surfaceY(bot, f.x, f.z, { top: 319, bottom: f.y, ground: (b) => world.isSolid(b) && !/leaves/.test(b.name) })
        progress(bot, 'surface', { from: f.y, to: top })
        await climbUp(bot, { targetY: top ?? f.y + 64, signal, timeout: timeout - (Date.now() - started) })
      }
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `surface: ${err.message}`)
    }
    if (!underOpenSky(bot)) {
      log(bot, 'surface: climbing did not get out; pathfinder')
      const { goals } = require('mineflayer-pathfinder')
      for (let i = 0; i < 4 && !underOpenSky(bot) && Date.now() - started < timeout; i++) {
        const f = bot.entity.position.floored()
        const t = world.surfaceY(bot, f.x, f.z, { top: 319, bottom: f.y, ground: (b) => world.isSolid(b) && !/leaves/.test(b.name) })
        await navigate.goto(bot, new goals.GoalY(Math.min(t ?? f.y + 16, f.y + 24)), { signal, timeout: Math.min(90000, timeout - (Date.now() - started)), attempts: 2 })
          .catch((e) => { if (isAbort(e)) throw e; log(bot, `surface: ${e.message}`) })
      }
    }
  }
  if (!underOpenSky(bot)) throw new SkillError(`could not reach the surface from ${navigate.fmt(bot.entity.position)}`, { code: 'NO_PATH' })
  const p = bot.entity.position
  return { position: { x: p.x, y: p.y, z: p.z } }
}

/** whether any liquid is in the column above `y` (up to the top of the world) */
function columnWet (bot, x, z, y) {
  for (let yy = y + 2; yy < 320; yy++) {
    const b = bot.blockAt(new Vec3(x, yy, z))
    if (!b) return false
    if (world.isLiquid(b)) return true
  }
  return false
}

/** the nearest column (≤ 16 blocks) with no liquid above the bot's level */
function dryColumn (bot, feet, radius = 16) {
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      const d = Math.abs(dx) + Math.abs(dz)
      if (!d || (best && d >= best.d)) continue
      if (columnWet(bot, feet.x + dx, feet.z + dz, feet.y)) continue
      // and nothing liquid next to that column on the way up
      if ([[1, 0], [-1, 0], [0, 1], [0, -1]].some(([ax, az]) => columnWet(bot, feet.x + dx + ax, feet.z + dz + az, feet.y))) continue
      best = { x: feet.x + dx, z: feet.z + dz, d }
    }
  }
  return best
}

/**
 * Climb until the feet are at `targetY` or the sky is open: pillar steps, staircase steps where a pillar is unsafe.
 */
async function climbUp (bot, { targetY, signal, timeout = 240000, maxSteps = 400 } = {}) {
  const started = Date.now()
  for (let i = 0; i < maxSteps; i++) {
    checkAbort(signal)
    if (Date.now() - started > timeout) throw new SkillError(`still underground at ${navigate.fmt(bot.entity.position)}`, { code: 'TIMEOUT' })
    const feet = bot.entity.position.floored()
    if (underOpenSky(bot) || (feet.y >= targetY && !inWater(bot))) return
    if (inWater(bot)) {
      await swimUp(bot, signal)
      if (bot.entity.position.floored().y > feet.y) continue
    }
    try {
      await pillarStep(bot, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      if (err.code === 'MISSING' && !inventory.filler(bot)) {
        if (!(await stairStepUp(bot, signal))) throw err
        continue
      }
      log(bot, `climb: ${err.message}; staircase step`)
      if (!(await stairStepUp(bot, signal))) throw new SkillError(`cannot climb from ${navigate.fmt(feet)}: ${err.message}`, { code: 'NO_PATH' })
    }
  }
}

/** feet or head in water */
function inWater (bot) {
  const p = bot.entity.position
  return !!bot.entity.isInWater || world.isWater(bot.blockAt(p.floored())) || world.isWater(bot.blockAt(p.offset(0, 1.62, 0).floored()))
}

/** hold jump while in water until the head is out of it or the bot stops rising (≤ 6 s) */
async function swimUp (bot, signal) {
  // centred: in a 1×1 water shaft the hitbox rubbing on a wall keeps the bot down
  await navigate.stepTo(bot, bot.entity.position.floored(), signal, { tolerance: 0.15, ticks: 20 }).catch((err) => { if (isAbort(err)) throw err })
  bot.setControlState('jump', true)
  try {
    let lastY = bot.entity.position.y
    let still = 0
    for (let t = 0; t < 120; t++) {
      await waitTicks(bot, 1, signal)
      const head = bot.blockAt(bot.entity.position.offset(0, 1.62, 0).floored())
      if (!world.isWater(head) && !world.isWater(bot.blockAt(bot.entity.position.floored()))) break
      still = bot.entity.position.y > lastY + 0.01 ? 0 : still + 1
      lastY = bot.entity.position.y
      if (still > 15) break // a ceiling over the water
    }
  } finally {
    bot.setControlState('jump', false)
  }
}

/**
 * Clear `pos` (gravel / sand may keep falling in). Throws UNSAFE when lava would flow in; water is accepted (the bot
 * swims up through it).
 */
async function clearCell (bot, pos, signal) {
  for (let k = 0; k < 10; k++) {
    const b = bot.blockAt(pos)
    if (!b || world.isPassable(b) || world.isWater(b)) return
    const lavaNear = world.FACES.some((f) => f.y !== -1 && world.isLava(bot.blockAt(pos.plus(f))))
    if (!b.diggable || world.isLava(b) || lavaNear || world.isProtected(bot, pos)) throw new SkillError(`unsafe to dig ${b.name} at ${navigate.fmt(pos)}`, { code: 'UNSAFE' })
    await navigate.digSafe(bot, b, signal)
    await waitTicks(bot, 2, signal)
  }
  const after = bot.blockAt(pos)
  if (!world.isPassable(after) && !world.isWater(after)) throw new SkillError(`${navigate.fmt(pos)} keeps filling up`, { code: 'FAILED' })
}

/** one pillar step: clear the cell over the head, centre, jump, place a filler block under the feet */
async function pillarStep (bot, signal, { exclude = [] } = {}) {
  const feet = bot.entity.position.floored()
  await clearCell(bot, feet.offset(0, 2, 0), signal)
  const fill = inventory.FILLER.filter((n) => !exclude.includes(n)).map((n) => inventory.find(bot, n)).find(Boolean) ?? null
  if (!fill) throw new SkillError('no blocks to pillar with', { code: 'MISSING' })
  const ref = bot.blockAt(feet.offset(0, -1, 0))
  if (!world.isSolid(ref)) throw new SkillError('nothing solid under the feet', { code: 'FAILED' })
  // the hitbox must fit the 1×1 column, or the jump hits the neighbouring ceiling
  await navigate.stepTo(bot, feet, signal, { tolerance: 0.15, sneak: true, ticks: 40 })
  await agentOf(bot)?.safety?.idle(signal)
  await inventory.equip(bot, fill)
  bot.setControlState('jump', true)
  try {
    const wait = inWater(bot) ? 40 : 12 // swimming up is slower than a jump
    for (let t = 0; t < wait && bot.entity.position.y < feet.y + 1.05; t++) await waitTicks(bot, 1, signal)
    if (bot.entity.position.y < feet.y + 1) throw new SkillError('the jump did not clear the block', { code: 'FAILED' })
    if (bot.heldItem?.name !== fill.name) throw new SkillError(`holding ${bot.heldItem?.name ?? 'nothing'} instead of ${fill.name}`, { code: 'FAILED' })
    await bot.placeBlock(ref, new Vec3(0, 1, 0)).catch((err) => log(bot, `pillar: ${err.message}`))
  } finally {
    bot.setControlState('jump', false)
  }
  for (let t = 0; t < 20 && !bot.entity.onGround; t++) await waitTicks(bot, 1, signal)
  if (bot.entity.position.floored().y <= feet.y) throw new SkillError(`pillar block not placed at ${navigate.fmt(feet)}`, { code: 'FAILED' })
}

/** one staircase step up: onto the block beside the feet, clearing the 3 cells the move needs */
async function stairStepUp (bot, signal) {
  const feet = bot.entity.position.floored()
  for (const d of world.HORIZONTAL) {
    const step = feet.plus(d) // the block to step onto
    const dest = step.offset(0, 1, 0)
    if (!world.isSolid(bot.blockAt(step))) continue
    const cells = [feet.offset(0, 2, 0), dest, dest.offset(0, 1, 0)]
    if (cells.some((c) => world.isLava(bot.blockAt(c)) || world.lavaAround(bot, c))) continue
    try {
      for (const c of cells) await clearCell(bot, c, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      continue
    }
    if (await navigate.stepTo(bot, dest, signal, { ticks: 30 })) return true
  }
  return false
}

const foodSkill = defineSkill('food', (bot, args) => food(bot, args), { description: 'carry enough food (hunt passive animals)' })
const surfaceSkill = defineSkill('surface', (bot, args) => surface(bot, args), { description: 'climb out of a mine to the open sky' })

module.exports = { skills: { food: foodSkill, surface: surfaceSkill }, food, surface, climbUp, pillarStep, stairStepUp, swimUp, inWater, foodPoints, underOpenSky, nearestPrey, PREY }
