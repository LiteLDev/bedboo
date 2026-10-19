// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Nether skill: through the bot's own portal into the Nether, mine nether quartz ore, nether gold ore and ancient
 * debris with a diamond pickaxe, and come back through the same portal. Cheat-free (public mineflayer API +
 * mineflayer-pathfinder).
 *
 * - The ores are located in the chunks the server sent (mineflayer `findBlocks`, like every mineflayer mining bot)
 *   and reached with mineflayer-pathfinder, which digs its way through netherrack and never breaks a block next to a
 *   liquid; ores with lava within a block (two for ancient debris) are skipped. Ancient debris (y 8–119) must be
 *   buried in rock up to the bot's level (no open cavern / lava above it) and within 64 blocks of the home portal;
 *   the band above the lava ocean (y ≥ 32) first, then the y 8–22 band (the big veins, mostly under the lava ocean);
 *   when none is in range the bot goes down to y 15 and branch-mines (a straight tunnel) until one shows up.
 *   Nether gold comes last and never in sight of a piglin (mining gold angers them).
 * - Safety: a gold armor piece (golden helmet/boots/…) is worn when the bot has one, so piglins stay neutral;
 *   combat.defend() guards the whole trip: it retaliates against any mob that hurt the bot (piglins, hoglins,
 *   zombified piglins only then), fights hostiles that come close (hoglins, magma cubes, …), knocks ghast fireballs back,
 *   eats; ghasts are never chased without a bow. Fights never step into lava (combat.hazardAhead).
 * - Home: the arrival portal (remembered by portal.enterPortal, or `args.home`); the bot walks back to it and goes
 *   through.
 *
 * args:   { targets?: { quartz_ore?: n, nether_gold_ore?: n, ancient_debris?: n }, returnHome?: boolean (true),
 *           portal?: {x,y,z} (overworld portal to enter when not in the nether), home?: {x,y,z},
 *           debrisY?: [min, max] (preferred ancient debris band, [32, 119]: above the lava ocean; then y 8–22;
 *           null: any) } (+ `signal`)
 * result: { mined: { [block]: n }, items: { quartz, gold_nugget, ancient_debris }, returned: boolean,
 *           home: {x,y,z}, guard: { killed, … }, timings: { [phase]: ms } }
 */
const { Vec3 } = require('vec3')
const u = require('../dims/util')
const memory = require('../dims/memory')
const combat = require('./combat')
const portal = require('./portal')

const DEFAULT_TARGETS = { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 }
/**
 * mining order: quartz, then ancient debris, nether gold last — mining gold angers the piglins that see it, which then
 * shoot at the bot (gold armor or not) for the rest of the trip
 */
const ORDER = ['quartz_ore', 'ancient_debris', 'nether_gold_ore']
const DROPS = { quartz_ore: 'quartz', nether_gold_ore: 'gold_nugget', ancient_debris: 'ancient_debris' }
const GOLD_ARMOR = [['golden_helmet', 'head'], ['golden_boots', 'feet'], ['golden_leggings', 'legs'], ['golden_chestplate', 'torso']]
const ARMOR_SLOT = { head: 5, torso: 6, legs: 7, feet: 8 }
const DEBRIS_Y = 15

/** wear one gold armor piece when the bot has one (piglins stay neutral); returns its name or null */
async function wearGold (bot) {
  for (const [name, dest] of GOLD_ARMOR) {
    if (bot.inventory.slots[ARMOR_SLOT[dest]]?.name === name) return name
  }
  for (const [name, dest] of GOLD_ARMOR) {
    const item = u.findItem(bot, name)
    if (item) {
      await bot.equip(item, dest)
      return name
    }
  }
  return null
}

/** an ore worth going for: no lava next to it (debris: within 2), inside the nether's walls */
function safeOre (bot, block, { lavaRadius = 1 } = {}) {
  const p = block.position
  if (p.y <= 4 || p.y >= 123) return false
  return !u.nearLava(bot, p, lavaRadius)
}

/**
 * Buried in rock up to `topY`: no lava and at most `maxAir` open blocks in the column above `p` — a target under one
 * of the Nether's huge open caverns (the lava ocean) would have the pathfinder bridge and pillar through the void.
 */
function buried (bot, p, topY, { maxAir = 6 } = {}) {
  let air = 0
  for (let y = p.y + 1; y <= topY; y++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (!b) return false
    if (u.isLava(b)) return false
    if (b.boundingBox === 'empty' && ++air > maxAir) return false
  }
  return true
}

/** hurt (a crossbow piglin, a fall): wait a little for the health to come back before going on (the guard eats) */
async function recover (bot, { guard, signal, below = 10, until = 14, maxMs = 20000 } = {}) {
  if (bot.health >= below) return
  u.log(bot, `nether: health ${bot.health}, recovering`)
  const end = Date.now() + maxMs
  while (bot.health < until && Date.now() < end) {
    if (guard) await guard.idle() // the guard eats
    else await u.eatIfNeeded(bot, { minFood: 20, minHealth: 20 }).catch(() => {})
    await u.sleep(1000, signal)
  }
}

/** one mining target: path next to it, dig with the best tool, pick the drop up */
async function mineOne (bot, block, { guard, signal, timeout = 90000 }) {
  const { goals } = u.ensurePathfinder(bot)
  const p = block.position
  const drop = DROPS[block.name]
  const before = drop ? u.count(bot, drop) : 0
  await combat.guarded(guard, () => u.goto(bot, new goals.GoalGetToBlock(p.x, p.y, p.z), { signal, timeout, retries: 2 }))
  const current = bot.blockAt(p)
  if (!current || current.name !== block.name) return false
  if (u.nearLava(bot, p, 1)) throw new Error(`lava next to ${block.name} at ${p}`)
  await combat.guarded(guard, () => u.digBlock(bot, bot.blockAt(p), { signal, requireHarvest: true }))
  await u.waitForBlock(bot, p, (b) => b.name !== block.name, { timeout: 3000, signal })
  if (drop) {
    await u.waitFor(() => u.count(bot, drop) > before, { timeout: 1500, signal }).catch(() => {})
    for (let i = 0; i < 3 && u.count(bot, drop) <= before; i++) {
      // a fight during the pickup: pick it up afterwards
      await u.collectDrops(bot, p, { radius: 3, timeout: 8000, signal }).catch(() => {})
      if (!guard?.busy && i > 0) break
      if (guard) await guard.idle()
    }
    // a drop that was not picked up (fell into lava, out of reach) does not count: mine another one
    if (u.count(bot, drop) <= before) {
      u.log(bot, `nether: the ${drop} of ${block.name} at ${p} was not picked up`)
      return false
    }
  }
  return true
}

/**
 * Move somewhere new to find more of `blockName`: a hop of `hop` blocks in the current exploration direction
 * (ancient debris: down to y 15 first, then a branch tunnel).
 */
async function explore (bot, blockName, state, { guard, signal }) {
  const { goals } = u.ensurePathfinder(bot)
  const pos = bot.entity.position
  if (blockName === 'ancient_debris' && Math.abs(pos.y - DEBRIS_Y) > 3 && !state.noDescent) {
    u.log(bot, `nether: going down to y ${DEBRIS_Y} for ancient debris`)
    try {
      await combat.guarded(guard, () => u.goto(bot, new goals.GoalY(DEBRIS_Y), { signal, timeout: 120000, retries: 1 }))
    } catch (err) {
      if (signal?.aborted) throw err
      // lava below (the pathfinder never digs next to it): branch-mine at this level, nearer veins get picked up
      u.log(bot, `nether: no way down to y ${DEBRIS_Y} here (${err.message}), mining sideways`)
      state.noDescent = true
    }
    return
  }
  state.dir = state.dir ?? (() => { const a = Math.floor(Math.random() * 4) * Math.PI / 2; return new Vec3(Math.round(Math.cos(a)), 0, Math.round(Math.sin(a))) })()
  const hop = state.hop ?? 16
  const target = pos.plus(state.dir.scaled(hop))
  u.log(bot, `nether: exploring for ${blockName} towards ${target.floored()}`)
  const goal = blockName === 'ancient_debris' && !state.noDescent
    ? new goals.GoalBlock(Math.floor(target.x), DEBRIS_Y, Math.floor(target.z))
    : new goals.GoalNearXZ(target.x, target.z, 3)
  try {
    await combat.guarded(guard, () => u.goto(bot, goal, { signal, timeout: 90000, retries: 1 }))
  } catch (err) {
    if (signal?.aborted) throw err
    // blocked (lava, a cliff): turn
    const d = state.dir
    state.dir = new Vec3(-d.z, 0, d.x)
    u.log(bot, `nether: exploration blocked (${err.message}), turning`)
  }
}

/** mine `n` blocks of `blockName` */
async function mineOres (bot, blockName, n, { guard, signal, maxDistance = 64, deadline, yRange, home }) {
  let mined = 0
  const bad = new Set()
  const state = {}
  let fails = 0
  let hops = 0
  let bandFails = 0
  let phase = 0
  // looking above the lava ocean: no descent to y 15 while exploring
  if (yRange && yRange[0] >= 32) state.noDescent = true
  while (mined < n) {
    u.throwIfAborted(signal)
    if (deadline && Date.now() > deadline) throw new Error(`${blockName}: ${mined}/${n} mined when the time ran out`)
    if (guard) await guard.idle()
    if (bot.game.dimension !== 'the_nether') throw new Error('left the nether while mining')
    const lavaRadius = blockName === 'ancient_debris' ? 2 : 1
    // ancient debris: the y 8–22 band first (the big veins, around y 15); after a few branch-mining hops or two
    // band targets out of reach (under the lava ocean the pathfinder never digs through), any debris in reach (the
    // small veins reach up to y 119)
    // band phases: `yRange`, then the other band, then any height (after 6 exploration hops or 2 unreachable targets)
    const bands = yRange ? [yRange, yRange[0] >= 32 ? [8, 22] : [32, 119], null] : [null]
    if (bands[phase] && (hops >= 6 || bandFails >= 2) && phase < bands.length - 1) {
      phase++
      hops = 0
      bandFails = 0
      // a low band is reached by going down (y 15) when nothing is in reach
      state.noDescent = !(bands[phase] && bands[phase][1] <= 31)
      u.log(bot, `nether: ${blockName} search band now ${bands[phase] ? bands[phase].join('–') : 'any height'}`)
    }
    const band = bands[phase]
    await recover(bot, { guard, signal })
    const debris = blockName === 'ancient_debris'
    // gold: never in sight of a piglin (it would turn on the bot)
    const piglins = blockName === 'nether_gold_ore' ? Object.values(bot.entities).filter((e) => e.name === 'piglin' || e.name === 'piglin_brute') : []
    const candidates = u.findBlocks(bot, blockName, {
      maxDistance: debris ? Math.max(maxDistance, 96) : maxDistance,
      count: 512,
      filter: (b) => !bad.has(b.position.toString()) && safeOre(bot, b, { lavaRadius }) && (!band || (b.position.y >= band[0] && b.position.y <= band[1])) &&
        !piglins.some((e) => e.position.distanceTo(b.position) < 20) &&
        // debris: buried in rock up to the bot's level, and not far from the way home
        (!debris || (buried(bot, b.position, Math.max(b.position.y, Math.floor(bot.entity.position.y))) && (!home || b.position.xzDistanceTo(u.vec(home)) <= 64)))
    })
    // debris: the nearest to the home portal first (a short way back)
    if (debris && home) candidates.sort((a, b) => a.position.distanceTo(u.vec(home)) - b.position.distanceTo(u.vec(home)))
    if (!candidates.length) {
      hops++
      await explore(bot, blockName, state, { guard, signal })
      continue
    }
    const target = candidates[0]
    try {
      u.log(bot, `nether: mining ${blockName} at ${target.position} (${mined}/${n})`)
      if (await mineOne(bot, target, { guard, signal, timeout: band && yRange && band[0] === yRange[0] ? 45000 : 90000 })) mined++
      fails = 0
    } catch (err) {
      if (signal?.aborted) throw err
      bad.add(target.position.toString())
      if (band) bandFails++
      fails++
      u.log(bot, `nether: ${blockName} at ${target.position}: ${err.message}`)
      if (fails >= 6) await explore(bot, blockName, state, { guard, signal })
    }
  }
  return mined
}

/**
 * Breadcrumbs: the bot's own way through the Nether (a standing position every 3 blocks), so it can retrace it home —
 * one long search from deep in the netherrack to the portal often runs out of the pathfinder's think time.
 */
function trackPath (bot) {
  const crumbs = [bot.entity.position.floored()]
  const onMove = () => {
    if (!bot.entity.onGround || bot.game.dimension !== 'the_nether') return
    const p = bot.entity.position.floored()
    if (p.distanceTo(crumbs[crumbs.length - 1]) >= 3) crumbs.push(p)
  }
  bot.on('move', onMove)
  return { crumbs, stop: () => bot.removeListener('move', onMove) }
}

/**
 * Walk back to the remembered nether portal: straight there when the pathfinder finds the way quickly, else back along
 * the breadcrumbs (short hops, each a quick search), then the last stretch.
 */
async function goHome (bot, home, { guard, signal, crumbs = [] }) {
  const { goals } = u.ensurePathfinder(bot)
  const h = u.vec(home)
  const homeGoal = new goals.GoalNear(h.x, h.y, h.z, 3)
  u.log(bot, `nether: heading home to the portal at ${h} (${crumbs.length} breadcrumbs)`)
  if (bot.entity.position.distanceTo(h) <= 32 || crumbs.length < 3) {
    try {
      await combat.guarded(guard, () => u.goto(bot, homeGoal, { signal, timeout: 45000, retries: 0, stallMs: 15000 }))
      return
    } catch (err) {
      if (signal?.aborted) throw err
      u.log(bot, `nether: no direct way home (${err.message}), retracing ${crumbs.length} breadcrumbs`)
    }
  }
  let i = crumbs.length - 1
  while (i >= 0) {
    u.throwIfAborted(signal)
    // the crumb nearest to home (in path order) still close to the bot: skip the detours
    let j = i
    for (let k = i; k >= 0; k--) if (crumbs[k].distanceTo(bot.entity.position) <= 10) j = k
    const c = crumbs[j]
    const ok = await combat.guarded(guard, () => u.goto(bot, new goals.GoalNear(c.x, c.y, c.z, 1.5), { signal, timeout: 30000, retries: 1, stallMs: 15000 }))
      .then(() => true, (err) => { if (signal?.aborted) throw err; u.log(bot, `nether: breadcrumb ${c}: ${err.message}`); return false })
    // a shortcut that failed: follow the way the bot really walked (the next crumb back)
    i = ok || j >= i ? j - 1 : i - 1
  }
  await combat.guarded(guard, () => u.goto(bot, homeGoal, { signal, timeout: 120000, retries: 3 }), { retries: 10 })
}

async function netherSkill (bot, args) {
  args = args ?? {}
  const { signal, returnHome = true } = args
  const targets = args.targets ?? DEFAULT_TARGETS
  const timings = {}
  const t0 = Date.now()
  if (bot.game.dimension !== 'the_nether') {
    const p = args.portal ?? memory.portalIn(bot, 'overworld')?.position
    await portal.enterPortal(bot, p ?? undefined, { signal })
    timings.enterMs = Date.now() - t0
  }
  if (bot.game.dimension !== 'the_nether') throw new Error(`not in the nether (${bot.game.dimension})`)
  let home = args.home ?? memory.portalIn(bot, 'the_nether')?.position ?? portal.findPortalBlock(bot, bot.entity.position, 16)?.position
  if (!home) throw new Error('no nether portal to return to')
  home = u.plain(home)
  memory.rememberPortal(bot, { dimension: 'the_nether', position: home })
  u.ensurePathfinder(bot, { fresh: true })
  const gold = await wearGold(bot)
  u.log(bot, `nether: home portal ${JSON.stringify(home)}, gold armor ${gold ?? 'none'}`)
  const guard = combat.defend(bot, {
    radius: 10,
    retaliate: true,
    // ghasts hover out of reach: only with a bow; never provoke neutral mobs
    ignore: (e) => (combat.FLYING_MOBS.has(e.name) && !combat.hasBowAndArrows(bot)),
    signal
  })
  const mined = {}
  const result = { mined, items: {}, returned: false, home, gold, guard: null, timings }
  const path = trackPath(bot)
  try {
    for (const name of ORDER) {
      const n = targets[name] ?? 0
      if (!n) continue
      const t = Date.now()
      mined[name] = await mineOres(bot, name, n, { guard, signal, home, deadline: args.deadline, yRange: name === 'ancient_debris' ? (args.debrisY ?? [32, 119]) : null })
      timings[`${name}Ms`] = Date.now() - t
      u.log(bot, `nether: ${name} done (${mined[name]}) in ${((Date.now() - t) / 1000).toFixed(0)} s`)
    }
    if (returnHome) {
      const t = Date.now()
      await goHome(bot, home, { guard, signal, crumbs: path.crumbs })
      await guard.stop()
      const back = await portal.enterPortal(bot, home, { signal })
      result.returned = back.to === 'overworld' && bot.game.dimension === 'overworld'
      result.arrival = back.arrival
      timings.returnMs = Date.now() - t
    }
  } finally {
    path.stop()
    result.guard = await guard.stop()
    for (const name of Object.keys(DROPS)) result.items[DROPS[name]] = u.count(bot, DROPS[name])
  }
  timings.totalMs = Date.now() - t0
  return result
}

module.exports = Object.assign(netherSkill, {
  wearGold,
  trackPath,
  buried,
  safeOre,
  mineOne,
  mineOres,
  explore,
  goHome,
  DEFAULT_TARGETS,
  DROPS
})
