// owner: FINAL-FIX-AGENT-A (agent core robustness)
'use strict'
/**
 * Nights. Mobs spawn on the surface at night, and a bot wandering in the dark without armor is how the chained runs
 * died. The best answer is a bed: sleeping skips the night (BDS ends the sleep after 100 ticks and moves the clock to
 * the morning). The agent carries its bed like its stations: placed where it is, slept in, taken back.
 *
 * Skill `rest` — args: { shelter?: false, timeout? }
 *   night in the overworld → sleep in a bed nearby or the carried one (placed on two free cells next to the bot,
 *   `bot.sleep`, waits for the morning, digs the bed up again); monsters nearby ("you may not rest now") are left to
 *   the safety behaviours and the sleep is tried again. Without a bed and with `shelter`: the bot's house when it is
 *   close (inside, door shut), else a sealed hole in the ground; it waits there for the morning.
 *   result: { rested: 'slept'|'sheltered'|'day'|'no bed', timeOfDay }
 *
 * Helpers: `isNight(bot)`, `restMode(bot, { shelter })`, `wearsArmor(bot)`, `placeBed(bot)`.
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, sleep, heartbeat, agentOf, waitTicks } = require('../skill')
const world = require('../world')
const inventory = require('../inventory')
const navigate = require('./navigate')

/** when the bot may sleep (Bedrock / Java: 12541–23458) — with a margin */
const NIGHT_START = 12600
const NIGHT_END = 23300

function isNight (bot) {
  const t = bot.time?.timeOfDay
  return typeof t === 'number' && t >= NIGHT_START && t <= NIGHT_END
}

/** bed items (Bedrock: one `bed` item, the colour in its metadata; Java: `<colour>_bed`) */
function bedItem (bot) {
  return bot.inventory.items().find((i) => i.name === 'bed' || /_bed$/.test(i.name)) ?? null
}

/** a bed block within `radius` (a bed head or foot; Bedrock: `bed`) */
function bedNear (bot, radius = 16) {
  const names = Object.keys(bot.registry.blocksByName).filter((n) => n === 'bed' || /_bed$/.test(n))
  const p = world.findBlocks(bot, names, { maxDistance: radius, count: 1 })[0]
  return p ? bot.blockAt(p) : null
}

/** pieces of armor worn */
function wearsArmor (bot) {
  return [5, 6, 7, 8].filter((s) => bot.inventory.slots[s]).length
}

/** what to do about the night now: 'sleep', 'shelter' or null (day, another dimension, nothing to do) */
function restMode (bot, { shelter = false } = {}) {
  if (bot.game?.dimension !== 'overworld' || !isNight(bot)) return null
  if (bedItem(bot) || bedNear(bot, 12)) return 'sleep'
  // underground the night changes nothing (caves are dark all day): a shelter only on the surface
  if (shelter && wearsArmor(bot) < 2 && require('./survive').underOpenSky(bot)) return 'shelter'
  return null
}

/**
 * Place the carried bed next to the bot: foot cell F and head cell F + d both free with solid ground, the bot standing
 * at F - d looking along d (the bed's head goes where the player faces). @returns {Promise<object>} the bed block
 */
async function placeBed (bot, { signal } = {}) {
  const item = bedItem(bot)
  if (!item) throw new SkillError('no bed carried', { code: 'MISSING' })
  const here = bot.entity.position.floored()
  const free = (p) => world.isPassable(bot.blockAt(p)) && world.isPassable(bot.blockAt(p.offset(0, 1, 0)))
  const ground = (p) => world.isSolid(bot.blockAt(p.offset(0, -1, 0))) && !world.isLiquid(bot.blockAt(p.offset(0, -1, 0)))
  const spots = []
  for (let dx = -3; dx <= 3; dx++) {
    for (let dz = -3; dz <= 3; dz++) {
      for (const dy of [0, -1, 1]) {
        const stand = here.offset(dx, dy, dz)
        if (!world.standable(bot, stand) || world.isProtected(bot, stand)) continue
        for (const d of world.HORIZONTAL) {
          const foot = stand.plus(d)
          const head = foot.plus(d)
          if (!free(foot) || !free(head) || !ground(foot) || !ground(head)) continue
          if (world.isProtected(bot, foot) || world.isProtected(bot, head)) continue
          if (world.lavaAround(bot, foot) || world.lavaAround(bot, head)) continue
          spots.push({ stand, foot, head, d, cost: Math.abs(dx) + Math.abs(dz) + Math.abs(dy) * 2 })
        }
      }
    }
  }
  spots.sort((a, b) => a.cost - b.cost)
  const { goals } = require('mineflayer-pathfinder')
  for (const s of spots.slice(0, 5)) {
    checkAbort(signal)
    try {
      if (!bot.entity.position.floored().equals(s.stand)) {
        await navigate.goto(bot, new goals.GoalBlock(s.stand.x, s.stand.y, s.stand.z), { signal, timeout: 15000, attempts: 1, legs: false, escape: false })
      }
      if (!bot.entity.position.floored().equals(s.stand)) continue
      await navigate.stepTo(bot, s.stand, signal, { tolerance: 0.2, ticks: 20 })
      await inventory.equip(bot, item.name)
      // look along d first: Bedrock turns the bed by the player's yaw
      await bot.lookAt(s.foot.offset(0.5 + s.d.x, 0.5, 0.5 + s.d.z), true)
      await bot.placeBlock(bot.blockAt(s.foot.offset(0, -1, 0)), new Vec3(0, 1, 0))
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `rest: bed at ${navigate.fmt(s.foot)}: ${err.message}`)
    }
    let placed = [s.foot, s.head].map((p) => bot.blockAt(p)).find((b) => b && bot.isABed?.(b))
    if (placed) {
      // both halves arrive as separate block updates: bot.sleep refuses half a bed
      for (let i = 0; i < 20 && ![s.foot, s.head].every((p) => bot.isABed(bot.blockAt(p))); i++) await waitTicks(bot, 1, signal)
      placed = bot.blockAt(placed.position)
      progress(bot, 'place', { block: placed.name, at: { x: s.foot.x, y: s.foot.y, z: s.foot.z } })
      return placed
    }
  }
  throw new SkillError(`no room for the bed near ${navigate.fmt(bot.entity.position)}`, { code: 'FAILED' })
}

/** sleep in `bed` until the morning (tries again while monsters keep the bot awake). @returns {Promise<boolean>} slept */
async function sleepIn (bot, bed, { signal, deadline }) {
  const safety = agentOf(bot)?.safety
  const { goals } = require('mineflayer-pathfinder')
  for (let attempt = 0; Date.now() < deadline && isNight(bot); attempt++) {
    checkAbort(signal)
    await safety?.idle(signal)
    if (bot.entity.position.offset(0, 1.6, 0).distanceTo(bed.position.offset(0.5, 0.5, 0.5)) > 3) {
      await navigate.goto(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), { signal, timeout: 20000, attempts: 2, legs: false })
        .catch((err) => { if (isAbort(err)) throw err })
    }
    try {
      const woke = new Promise((resolve) => bot.once('wake', resolve))
      await bot.sleep(bot.blockAt(bed.position))
      progress(bot, 'slept', { at: { x: bed.position.x, y: bed.position.y, z: bed.position.z }, timeOfDay: bot.time?.timeOfDay })
      log(bot, `rest: asleep at ${navigate.fmt(bed.position)} (time ${bot.time?.timeOfDay})`)
      // BDS ends the sleep after 100 ticks and skips the night
      let timer
      await Promise.race([woke, new Promise((resolve) => { timer = setTimeout(resolve, 20000) })])
      clearTimeout(timer)
      if (bot.isSleeping) await bot.wake().catch(() => {})
      await sleep(1000, signal)
      return true
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `rest: cannot sleep yet: ${err.message}`)
      if (attempt >= 5) return false
      if (/monsters/i.test(err.message)) {
        // the safety behaviours deal with them (they come close); wait a little
        heartbeat(bot)
        await sleep(4000, signal)
        continue
      }
      await sleep(1500, signal)
    }
  }
  return false
}

/** dig the bed up again and pick it up */
async function takeBed (bot, bed, { signal }) {
  const dig = require('../dig')
  const block = bot.blockAt(bed.position)
  if (!block || !bot.isABed?.(block)) return
  await dig.mineAt(bot, bed.position, { signal }).catch((err) => { if (isAbort(err)) throw err; log(bot, `rest: could not take the bed back: ${err.message}`) })
  await dig.pickupNear(bot, bed.position.offset(0.5, 0.5, 0.5), { signal, radius: 4, wait: 1500 }).catch((err) => { if (isAbort(err)) throw err })
}

/** wait in a safe place until the morning (or the deadline), heartbeats for the stuck watchdog */
async function waitForDay (bot, { signal, deadline }) {
  while (isNight(bot) && Date.now() < deadline) {
    checkAbort(signal)
    heartbeat(bot)
    await sleep(2000, signal)
  }
}

/**
 * A sealed hole: down 3 blocks where the bot stands (dig.digDown checks for liquids and caves), a block over the
 * head; after the night, out again (survive.surface). @returns {Promise<boolean>}
 */
async function dugShelter (bot, { signal, deadline }) {
  const dig = require('../dig')
  const survive = require('./survive')
  const top = bot.entity.position.floored()
  await dig.digDown(bot, top.y - 3, { signal })
  const feet = bot.entity.position.floored()
  if (feet.y > top.y - 3) return false
  const seal = feet.offset(0, 2, 0)
  const fill = inventory.filler(bot)
  if (fill && world.isPassable(bot.blockAt(seal))) {
    for (const d of world.HORIZONTAL) {
      const ref = bot.blockAt(seal.plus(d))
      if (!world.isSolid(ref)) continue
      try {
        await inventory.equip(bot, fill)
        await bot.placeBlock(ref, d.scaled(-1))
        break
      } catch (err) {
        if (isAbort(err)) throw err
      }
    }
  }
  log(bot, `rest: sheltered at ${navigate.fmt(feet)} (sealed: ${!world.isPassable(bot.blockAt(seal))})`)
  progress(bot, 'slept', { shelter: true, at: { x: feet.x, y: feet.y, z: feet.z } })
  await waitForDay(bot, { signal, deadline })
  await survive.surface(bot, { signal, timeout: 60000 }).catch((err) => { if (isAbort(err)) throw err; log(bot, `rest: ${err.message}`) })
  return true
}

async function rest (bot, { shelter = false, signal, timeout = 150000 } = {}) {
  const deadline = Date.now() + timeout - 5000
  const how = restMode(bot, { shelter })
  if (!how) return { rested: isNight(bot) ? 'no bed' : 'day', timeOfDay: bot.time?.timeOfDay ?? null }
  if (how === 'sleep') {
    let bed = bedNear(bot, 12)
    let placed = false
    if (!bed) {
      bed = await placeBed(bot, { signal })
      placed = true
    }
    try {
      const slept = await sleepIn(bot, bed, { signal, deadline })
      if (!slept && isNight(bot)) throw new SkillError(`could not sleep (time ${bot.time?.timeOfDay})`, { code: 'FAILED' })
    } finally {
      if (placed && !signal?.aborted) await takeBed(bot, bed, { signal }).catch(() => {})
    }
    return { rested: 'slept', timeOfDay: bot.time?.timeOfDay ?? null }
  }
  // no bed: the house (M4) when it is close, else a hole in the ground
  const home = agentOf(bot)?.state?.home
  if (home && bot.entity.position.distanceTo(new Vec3(home.inside.x, home.inside.y, home.inside.z)) < 64) {
    const { goals } = require('mineflayer-pathfinder')
    await navigate.goto(bot, new goals.GoalBlock(home.inside.x, home.inside.y, home.inside.z), { signal, timeout: 60000, attempts: 2 })
    // shut the door behind
    const door = bot.blockAt(new Vec3(home.door.x, home.door.y, home.door.z))
    if (door && door.getProperties?.().open_bit) await bot.activateBlock(door).catch(() => {})
    await waitTicks(bot, 4, signal)
    progress(bot, 'slept', { shelter: 'house' })
    await waitForDay(bot, { signal, deadline })
    return { rested: 'sheltered', where: 'house', timeOfDay: bot.time?.timeOfDay ?? null }
  }
  if (!(await dugShelter(bot, { signal, deadline }))) return { rested: 'no shelter', timeOfDay: bot.time?.timeOfDay ?? null }
  return { rested: 'sheltered', where: 'hole', timeOfDay: bot.time?.timeOfDay ?? null }
}

const skill = defineSkill('rest', (bot, args) => rest(bot, args), { description: 'get through the night: sleep in a (carried) bed, or shelter' })

module.exports = Object.assign(skill, { rest, isNight, restMode, bedItem, bedNear, wearsArmor, placeBed, sleepIn, takeBed, NIGHT_START, NIGHT_END })
