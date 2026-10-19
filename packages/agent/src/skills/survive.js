// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Survival chores.
 *
 * Skill `food` — args: { min?: 8, stock?: false }: make sure the bot carries food worth `min` hunger points (hunts
 *   passive animals in sight — exploring a little for them — picks up the meat and cooks it when there is time;
 *   mineflayer-auto-eat eats it when hungry). A well-fed bot is done unless `stock` (provisions for a long trip).
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

/** food items the bot carries (raw chicken only when `cookable`: it poisons) */
function foodItems (bot, { cookable = false } = {}) {
  let n = 0
  for (const item of bot.inventory.items()) {
    if (!data.FOODS.includes(item.name) || (item.name === 'chicken' && !cookable)) continue
    n += item.count
  }
  return n
}

const PREY = ['cow', 'pig', 'sheep', 'mooshroom', 'chicken', 'rabbit']

function nearestPrey (bot, radius = 64, filter = () => true) {
  const { preyOk } = require('./obtain')
  const dead = require('./combat').deadEntities(bot) // a dying animal stays in bot.entities for a second
  return bot.nearestEntity((e) => PREY.includes(e.name) && !dead.has(e) && preyOk(bot, e) && e.position.distanceTo(bot.entity.position) <= radius && filter(e)) ?? null
}

const COOKED = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', mutton: 'cooked_mutton', chicken: 'cooked_chicken', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon' }

/** raw meat / fish → cooked (more than twice the food) when a furnace and fuel are at hand and there is time */
async function cook (bot, { signal, deadline }) {
  const smelt = require('./smelt')
  const stations = require('../stations')
  for (const [raw, cooked] of Object.entries(COOKED)) {
    const n = inventory.count(bot, raw)
    // 10 s per item in the furnace (up to 3 furnaces for a big batch) + placing / opening / taking the furnace back
    if (!n || Date.now() + 10000 * Math.ceil(n / (n >= 12 ? 3 : 1)) + 20000 > deadline) continue
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

/**
 * Carry food: `min` hunger points and `items` food items (provisions for a trip: `stock`). Hunts passive animals in
 * sight (exploring for them when allowed), cooks the meat; when no animal is left and `fishing` is set, fishes (a rod
 * carried or made from 2 carried string) — mineflayer-auto-eat eats when hungry.
 */
async function food (bot, { min = 8, items = 0, stock = false, signal, timeout = 150000, explore: mayExplore = true, radius = 64, fishing = false } = {}) {
  const started = Date.now()
  const hunted = {}
  const explore = require('./explore')
  const { hunt } = require('./obtain')
  const stations = require('../stations')
  // raw chicken is not eaten (food poisoning): it only counts — and chickens are only worth hunting — when it can be
  // cooked afterwards (a furnace carried or nearby)
  const canCook = () => inventory.count(bot, 'furnace') > 0 || !!stations.stationNear(bot, 'furnace')
  const carried = () => foodPoints(bot) + (canCook() ? 2 * inventory.count(bot, 'chicken') : 0)
  const count = () => foodItems(bot, { cookable: canCook() })
  // mineflayer-auto-eat eats what the hunt brings while the bot is hungry: a well-fed bot counts as done (unless it is
  // stocking up for a long trip)
  const enough = () => (carried() >= min && count() >= items) || (!stock && bot.food >= 18)
  let fished = 0
  while (!enough()) {
    checkAbort(signal)
    if (Date.now() - started > timeout) break
    // from a mine, the animals on the surface far above are out of reach (the chase does not dig)
    let open = underOpenSky(bot)
    const cooking = canCook()
    const inReach = (e) => (cooking || e.name !== 'chicken') && (open || Math.abs(e.position.y - bot.entity.position.y) < 8)
    let prey = nearestPrey(bot, radius, inReach)
    log(bot, `food: ${foodPoints(bot)} points carried; prey ${prey ? `${prey.name} at ${prey.position.distanceTo(bot.entity.position).toFixed(0)}` : 'none in sight'}`)
    if (!prey && mayExplore) {
      await surface(bot, { signal }).catch((err) => { if (isAbort(err)) throw err })
      const until = () => {
        open = underOpenSky(bot)
        return nearestPrey(bot, 48, inReach)
      }
      // half of what is left at most: fishing needs time too
      const r = await explore.explore(bot, { until, maxDistance: 160, signal, timeout: Math.max(20000, (timeout - (Date.now() - started)) * (fishing ? 0.5 : 1)) })
      open = underOpenSky(bot)
      prey = r.found ? nearestPrey(bot, radius, inReach) : null
    }
    if (!prey) {
      // no animal left around: fish (a rod carried, or made from 2 string + 3 sticks)
      const left = timeout - (Date.now() - started)
      if (!fishing || left < 45000 || fished > 0) break
      try {
        const r = await fish(bot, { count: Math.max(2, items - count()), signal, timeout: left - 25000, obtainRod: true })
        fished += r.caught
      } catch (err) {
        if (isAbort(err) || err.code === 'DIED') throw err
        log(bot, `food: fishing: ${err.message}`)
      }
      fished = Math.max(fished, 1) // one fishing trip per call
      continue
    }
    const drop = prey.name === 'sheep' ? 'mutton' : prey.name === 'pig' ? 'porkchop' : prey.name === 'chicken' ? 'chicken' : prey.name === 'rabbit' ? 'rabbit' : 'beef'
    try {
      await hunt(bot, { mobs: [prey.name], item: drop, count: 1, signal, radius, filter: inReach })
      hunted[prey.name] = (hunted[prey.name] ?? 0) + 1
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      log(bot, `food: hunting ${prey.name} failed: ${err.message}`)
      await waitTicks(bot, 10, signal)
    }
  }
  await cook(bot, { signal, deadline: started + timeout })
  const points = foodPoints(bot)
  const n = foodItems(bot)
  progress(bot, 'food', { points, items: n, hunted, fished })
  if (points === 0 && bot.food < 18 && !Object.keys(hunted).length) throw new SkillError('no food found', { code: 'NOT_FOUND', details: { hunted } })
  return { foodPoints: points, items: n, hunted, fished }
}

// ---- fishing --------------------------------------------------------------------------------------------------------

const FISH = ['cod', 'salmon', 'tropical_fish', 'pufferfish']

/**
 * A spot to fish from: a dry, standable cell on a shore next to open water (a water surface cell with air above, at
 * least 2 deep, whose neighbours towards the open water are water too), nearest first. @returns {{ stand, water }|null}
 */
function fishingSpot (bot, { maxDistance = 48 } = {}) {
  const found = world.findBlocks(bot, ['water'], { maxDistance, count: 400 })
  let best = null
  for (const w of found) {
    if (!world.isPassable(bot.blockAt(w.offset(0, 1, 0)))) continue // the surface only
    if (!world.isWater(bot.blockAt(w.offset(0, -1, 0)))) continue // ≥ 2 deep
    for (const d of world.HORIZONTAL) {
      // the bot on the bank behind the water cell; open water 2 and 3 cells ahead of it
      const stand = w.minus(d).offset(0, 1, 0)
      if (!world.standable(bot, stand) || world.isWater(bot.blockAt(stand.offset(0, -1, 0)))) continue
      if (![1, 2].every((k) => world.isWater(bot.blockAt(w.plus(d.scaled(k)))) && world.isPassable(bot.blockAt(w.plus(d.scaled(k)).offset(0, 1, 0))))) continue
      const cost = stand.distanceTo(bot.entity.position)
      if (!best || cost < best.cost) best = { stand, water: w.plus(d.scaled(2)), cost }
    }
  }
  return best
}

/**
 * Fish `count` catches (cod / salmon count; junk and treasure are kept but not counted) with `bot.fish()`. A rod is
 * obtained first when `obtainRod` (2 string + 3 sticks). Each cast waits ≤ 40 s for a bite (BDS: ~6–32 s), then
 * reels in and casts again.
 * @returns {Promise<{ caught: number, casts: number, ms: number }>}
 */
async function fish (bot, { count = 3, timeout = 180000, signal, obtainRod = false, maxDistance = 64 } = {}) {
  const started = Date.now()
  const { heartbeat } = require('../skill')
  if (!inventory.count(bot, 'fishing_rod')) {
    if (!obtainRod) throw new SkillError('no fishing rod', { code: 'MISSING' })
    // only when the string is already there: string comes from spiders / cobwebs, not worth a trip of its own
    if (inventory.count(bot, 'string') < 2) throw new SkillError(`no fishing rod and ${inventory.count(bot, 'string')} string`, { code: 'MISSING' })
    await require('./obtain').obtain(bot, { item: 'fishing_rod', count: 1, signal })
  }
  let spot = fishingSpot(bot, { maxDistance })
  if (!spot && !underOpenSky(bot)) {
    await surface(bot, { signal }).catch((err) => { if (isAbort(err)) throw err })
    spot = fishingSpot(bot, { maxDistance })
  }
  if (!spot) throw new SkillError(`no open water within ${maxDistance} blocks`, { code: 'NOT_FOUND' })
  const { goals } = require('mineflayer-pathfinder')
  await navigate.goto(bot, new goals.GoalBlock(spot.stand.x, spot.stand.y, spot.stand.z), { signal, timeout: 60000, attempts: 3 })
  log(bot, `fish: on the shore at ${navigate.fmt(spot.stand)}`)
  // what each bite brought (a hungry bot may eat a raw fish right away: it still counts)
  let fishCaught = 0
  const caught = () => fishCaught
  let casts = 0
  while (caught() < count && Date.now() - started < timeout) {
    checkAbort(signal)
    await agentOf(bot)?.safety?.idle(signal)
    await inventory.equip(bot, 'fishing_rod')
    await bot.lookAt(spot.water.offset(0.5, 0.9, 0.5), true)
    casts++
    const cast = bot.fish()
    cast.catch(() => {})
    let timer
    const bite = await Promise.race([
      cast.then(() => true, () => false),
      new Promise((resolve) => { timer = setTimeout(() => resolve(null), Math.min(40000, Math.max(5000, timeout - (Date.now() - started)))) })
    ])
    clearTimeout(timer)
    if (bite === null) {
      // no bite in time (or the bobber landed on the shore): reel in (the bobber's removal ends the cast)
      bot.activateItem()
      let wait
      await Promise.race([cast.catch(() => {}), new Promise((resolve) => { wait = setTimeout(resolve, 5000) })])
      clearTimeout(wait)
    }
    heartbeat(bot)
    if (bite) {
      // the catch flies to the bot
      const had = inventory.counts(bot)
      for (let i = 0; i < 30; i++) {
        await waitTicks(bot, 2, signal)
        if (!Object.values(bot.entities).some((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) < 8)) break
      }
      const got = Object.entries(inventory.counts(bot)).filter(([n, c]) => c > (had[n] ?? 0)).map(([n, c]) => `${c - (had[n] ?? 0)} ${n}`)
      fishCaught += Object.entries(inventory.counts(bot)).filter(([n]) => FISH.slice(0, 2).includes(n)).reduce((k, [n, c]) => k + Math.max(0, c - (had[n] ?? 0)), 0)
      progress(bot, 'caught', { got, total: caught() })
    }
  }
  log(bot, `fish: ${caught()} caught in ${casts} casts`)
  return { caught: caught(), casts, ms: Date.now() - started }
}

// ---- getting out of trouble -----------------------------------------------------------------------------------------

/**
 * Last-resort unstick (the stuck watchdog, navigation that failed twice in a pit): out of the water onto the nearest
 * bank, up to the open sky (pillar / staircase, around water above), then a few blocks away from `away` (the spot the
 * bot was stuck at) on dry land. Best effort; throws only on abort.
 * @returns {Promise<{ position, surfaced: boolean }>}
 */
async function escape (bot, { signal, timeout = 150000, away } = {}) {
  const started = Date.now()
  const left = () => timeout - (Date.now() - started)
  const { goals } = require('mineflayer-pathfinder')
  navigate.stopPathfinder(bot)
  if (inWater(bot)) {
    await swimUp(bot, signal).catch((err) => { if (isAbort(err)) throw err })
    const bank = nearestBank(bot, 12)
    if (bank) {
      log(bot, `escape: out of the water onto ${navigate.fmt(bank)}`)
      await navigate.goto(bot, new goals.GoalBlock(bank.x, bank.y, bank.z), { signal, timeout: Math.min(40000, left()), attempts: 2, legs: false, escape: false })
        .catch((err) => { if (isAbort(err)) throw err; log(bot, `escape: ${err.message}`) })
    }
    if (inWater(bot)) await navigate.unstick(bot, { signal }).catch((err) => { if (isAbort(err)) throw err })
  }
  const deep = bot.entity.position.y < 40 && !inWater(bot)
  if (!underOpenSky(bot) && left() > 10000 && deep) {
    // deep in a mine (the task works down here): out of the pit only — 8 blocks up the column, not all the way
    log(bot, `escape: up out of the pit at ${navigate.fmt(bot.entity.position)}`)
    await climbUp(bot, { targetY: Math.floor(bot.entity.position.y) + 8, signal, timeout: Math.min(60000, left()) })
      .catch((err) => { if (isAbort(err)) throw err; log(bot, `escape: ${err.message}`) })
  } else if (!underOpenSky(bot) && left() > 10000) {
    log(bot, `escape: up to the sky from ${navigate.fmt(bot.entity.position)}`)
    await surface(bot, { signal, timeout: left() }).catch((err) => { if (isAbort(err)) throw err; log(bot, `escape: ${err.message}`) })
  }
  // a few blocks away from the spot, on dry land (the same pit / shore would catch the next attempt again)
  if (left() > 10000 && underOpenSky(bot)) {
    const here = bot.entity.position
    const from = away ? new Vec3(away.x, here.y, away.z) : null
    let dir = from && from.xzDistanceTo(here) > 0.5 ? here.minus(from) : new Vec3(Math.cos(Date.now() % 628 / 100), 0, Math.sin(Date.now() % 628 / 100))
    dir = new Vec3(dir.x, 0, dir.z)
    dir = dir.scaled(1 / Math.max(1e-6, Math.hypot(dir.x, dir.z)))
    const target = { x: here.x + dir.x * 10, z: here.z + dir.z * 10 }
    const dry = navigate.dryNear(bot, target) ?? target
    await navigate.goto(bot, new goals.GoalNearXZ(dry.x, dry.z, 3), { signal, timeout: Math.min(40000, left()), attempts: 2, legs: false, escape: false })
      .catch((err) => { if (isAbort(err)) throw err; log(bot, `escape: ${err.message}`) })
  }
  const p = bot.entity.position
  return { position: { x: p.x, y: p.y, z: p.z }, surfaced: underOpenSky(bot) }
}

/** the nearest dry standable cell (≤ radius) next to the water, about the water's height */
function nearestBank (bot, radius = 12) {
  const here = bot.entity.position.floored()
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -1; dy <= 3; dy++) {
        const p = here.offset(dx, dy, dz)
        if (!world.standable(bot, p) || world.isWater(bot.blockAt(p.offset(0, -1, 0)))) continue
        const d = Math.hypot(dx, dz) + Math.abs(dy) * 0.5
        if (!best || d < best.d) best = { p, d }
      }
    }
  }
  return best?.p ?? null
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
        await navigate.goto(bot, new goals.GoalBlock(dry.x, feet.y, dry.z), { signal, timeout: 60000, attempts: 2, escape: false })
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
        await navigate.goto(bot, new goals.GoalY(Math.min(t ?? f.y + 16, f.y + 24)), { signal, timeout: Math.min(90000, timeout - (Date.now() - started)), attempts: 2, escape: false })
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
  // eat before the climb (standing still), not in the middle of a jump
  await require('../skill').eatNow(bot, { below: 18 })
  let interrupted = 0
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
      // a fight in the middle of the jump (the sword in the hand now, the bot knocked aside): the same step again
      const safety = agentOf(bot)?.safety
      if ((safety?.recentlyIntervened?.(3000) || /holding/.test(err.message)) && interrupted++ < 10) {
        log(bot, `climb: ${err.message}; again`)
        await safety?.idle(signal)
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
async function pillarStep (bot, signal, opts = {}) {
  // the block in the hand from the equip to the placement: no meal swapped in halfway
  return require('../skill').withoutMeals(bot, () => pillarStepOnce(bot, signal, opts))
}

async function pillarStepOnce (bot, signal, { exclude = [] } = {}) {
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
const fishSkill = defineSkill('fish', (bot, args) => fish(bot, args), { description: 'fish with a rod on a shore (bot.fish)' })
const escapeSkill = defineSkill('escape', (bot, args) => escape(bot, args), { description: 'out of the water, up to the sky, away from a spot (last-resort unstick)' })

module.exports = { skills: { food: foodSkill, surface: surfaceSkill, fish: fishSkill, escape: escapeSkill }, food, surface, escape, fish, fishingSpot, nearestBank, climbUp, pillarStep, stairStepUp, swimUp, inWater, foodPoints, foodItems, underOpenSky, nearestPrey, PREY, COOKED }
