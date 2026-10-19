// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Getting blocks out of the world: find, reach (walk / shaft down / tunnel), dig with the right tool, pick the drops
 * up. Shared by the `gather` (surface) and `mine` (underground) skills and by obtain's mine / gather steps.
 *
 * Reaching a block:
 * - within ~12 blocks of height: mineflayer-pathfinder `GoalLookAtBlock` (it digs / towers its way there);
 * - deeper: a **shaft** — walk to a column next to the block, check the whole column for liquids (and the cells
 *   around it), then dig straight down one block at a time (never into a cave drop deeper than 3, never next to
 *   lava or water); a staircase step sideways when the cell below is unsafe; pathfinder as the fallback.
 * Every dig is checked first: no liquid may flow into the opened cell, nothing protected is dug.
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('./errors')
const { log, progress, sleep, waitTicks, agentOf } = require('./skill')
const world = require('./world')
const inventory = require('./inventory')
const data = require('./data')
const navigate = require('./skills/navigate')
const explore = require('./skills/explore')

const goals = () => require('mineflayer-pathfinder').goals
const key = (p) => `${p.x},${p.y},${p.z}`

const isProtected = world.isProtected

/**
 * Candidate positions of `blocks`, cheapest first (walking distance, digging down, towering up; logs reachable from
 * the ground first).
 */
function candidates (bot, blocks, { maxDistance = 64, exclude = new Set(), point } = {}) {
  const here = point ?? bot.entity.position
  const usable = (p) => !exclude.has(key(p)) && !isProtected(bot, p) && !world.inTrap(bot, p) && world.safeToDig(bot, p) && !world.lavaAround(bot, p)
  const found = world.findBlocks(bot, blocks, { maxDistance, count: 48, point: here, filter: usable })
  const out = []
  for (const p of found) {
    const b = bot.blockAt(p)
    let cost = world.distXZ(p, here) + Math.max(0, here.y - p.y) * 1.2 + Math.max(0, p.y - here.y - 3) * 2
    if (/_log$|_stem$/.test(b?.name ?? '')) {
      const ground = groundBelow(bot, p)
      if (ground === null || p.y - ground > 3) cost += 30 // up in the canopy: its drop may stay in the leaves
    }
    out.push({ pos: p, cost })
  }
  out.sort((a, b) => a.cost - b.cost)
  return out.map((c) => c.pos)
}

/** y of the ground block under a tree trunk (first non-log solid block below), or null */
function groundBelow (bot, p) {
  for (let y = p.y - 1; y > p.y - 12; y--) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (!b) return null
    if (/_log$|_stem$/.test(b.name)) continue
    return world.isSolid(b) ? y : null
  }
  return null
}

/**
 * Mine / gather until the bot gained `count` × `item` (or dug `count` blocks when `item` is null).
 * @param {object} bot
 * @param {object} opts
 * @param {string|null} opts.item item to gain (drops are counted in the inventory)
 * @param {number} [opts.count=1]
 * @param {string[]} opts.blocks block names to dig
 * @param {number} [opts.maxDistance=64] search radius (findBlocks) before exploring
 * @param {number} [opts.exploreDistance=256] farthest spiral waypoint when none is loaded (0: never explore)
 * @param {string[]} [opts.biomes] biomes where the blocks generate (exploration heads there)
 * @param {number} [opts.timeout=480000]
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<{ mined: Record<string, number>, collected: Record<string, number>, ms: number }>}
 */
async function collectBlocks (bot, { item = null, count = 1, blocks, maxDistance = 64, exploreDistance = 256, biomes, timeout = 480000, signal } = {}) {
  if (!blocks?.length) throw new SkillError('collectBlocks needs block names', { code: 'FAILED' })
  const started = Date.now()
  const before = inventory.counts(bot)
  const startCount = item ? inventory.count(bot, item) : 0
  const mined = {}
  let dug = 0
  const tried = new Set()
  let failures = 0
  const progressDone = () => item ? inventory.count(bot, item) - startCount >= count : dug >= count
  if (!biomes) {
    const hints = blocks.map((b) => data.NATURAL[b]?.biomes).filter(Boolean)
    if (hints.length === blocks.length) biomes = [...new Set(hints.flat())]
  }
  while (!progressDone()) {
    checkAbort(signal)
    if (Date.now() - started > timeout) throw new SkillError(`collecting ${item ?? blocks.join('/')}: timed out after ${timeout} ms (${JSON.stringify(mined)})`, { code: 'TIMEOUT' })
    await agentOf(bot)?.safety?.idle(signal)
    // a full inventory picks nothing up: the ore would be dug for nothing, again and again
    if (inventory.freeSlots(bot) < 3) {
      const tossed = await inventory.declutter(bot, { minFree: 5 })
      if (Object.keys(tossed).length) log(bot, `inventory full: tossed ${JSON.stringify(tossed)}`)
    }
    let list = candidates(bot, blocks, { maxDistance, exclude: tried })
    if (!list.length) {
      if (!exploreDistance) throw new SkillError(`no ${blocks.join('/')} within ${maxDistance} blocks`, { code: 'NOT_FOUND' })
      log(bot, `no ${blocks.join('/')} loaded within ${maxDistance}: exploring${biomes ? ` (towards ${biomes.slice(0, 3).join('/')}…)` : ''}`)
      const r = await explore.explore(bot, {
        until: () => candidates(bot, blocks, { maxDistance: Math.min(maxDistance, 48), exclude: tried })[0],
        biomes,
        maxDistance: exploreDistance,
        signal,
        timeout: Math.max(30000, timeout - (Date.now() - started))
      })
      list = candidates(bot, blocks, { maxDistance, exclude: tried })
      if (!list.length) throw new SkillError(`found no ${blocks.join('/')} (explored ${r.waypoints} waypoints, ${r.distance} blocks out)`, { code: 'NOT_FOUND' })
    }
    const pos = list[0]
    const name = bot.blockAt(pos)?.name
    try {
      if (await mineAt(bot, pos, { signal, item })) {
        mined[name] = (mined[name] ?? 0) + 1
        dug++
        failures = 0
      } else {
        tried.add(key(pos)) // gone before the bot got there (or a liquid now)
        await sleep(50, signal)
      }
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED' || err.code === 'MISSING') throw err
      const safety = agentOf(bot)?.safety
      if (safety?.busy || safety?.recentlyBusy?.(3000)) {
        // a fight / flight took the controls mid-way (pathfinder stopped, "Digging aborted"): try the same block again
        log(bot, `mining ${name} interrupted (${err.message}); resuming`)
        await safety.idle(signal)
        continue
      }
      // the same pocket of ore is just as unreachable: skip its neighbours too
      for (let dx = -2; dx <= 2; dx++) for (let dy = -2; dy <= 2; dy++) for (let dz = -2; dz <= 2; dz++) tried.add(key(pos.offset(dx, dy, dz)))
      failures++
      log(bot, `could not mine ${name} at ${navigate.fmt(pos)}: ${err.message}`)
      if (failures >= 6) throw new SkillError(`collecting ${item ?? blocks.join('/')}: ${failures} failures in a row, last: ${err.message}`, { code: err.code ?? 'FAILED', cause: err })
    }
  }
  const after = inventory.counts(bot)
  const collected = {}
  for (const [n, c] of Object.entries(after)) if (c > (before[n] ?? 0)) collected[n] = c - (before[n] ?? 0)
  return { mined, collected, ms: Date.now() - started }
}

/**
 * Reach the block at `pos`, dig it with the best tool and pick up its drops.
 * @param {object} bot
 * @param {Vec3} pos
 * @param {{ signal?: AbortSignal, item?: string, pickup?: boolean }} [opts]
 */
async function mineAt (bot, pos, { signal, item, pickup = true } = {}) {
  let block = bot.blockAt(pos)
  if (!block || world.isAir(block) || world.isLiquid(block)) return false
  const harvest = inventory.harvestToolNames(bot.registry, block)
  if (harvest && !harvest.some((t) => inventory.count(bot, t) > 0)) {
    throw new SkillError(`${block.name} needs one of ${harvest.join(', ')}`, { code: 'MISSING' })
  }
  await reach(bot, pos, { signal })
  block = bot.blockAt(pos)
  if (!block || world.isAir(block) || world.isLiquid(block)) return false
  if (!world.safeToDig(bot, pos)) throw new SkillError(`${block.name} at ${navigate.fmt(pos)} is next to a liquid`, { code: 'UNSAFE' })
  const name = block.name
  if (!(await digBlock(bot, block, signal))) return false
  // only a block that is gone counts as mined (the milestones verify these events)
  for (let i = 0; i < 10 && bot.blockAt(pos)?.name === name; i++) await waitTicks(bot, 1, signal)
  if (bot.blockAt(pos)?.name === name) return false
  progress(bot, 'mine', { block: name, at: { x: pos.x, y: pos.y, z: pos.z } })
  if (pickup) await pickupNear(bot, pos.offset(0.5, 0.5, 0.5), { signal, item })
  return true
}

/**
 * Equip the best tool and dig (rejects when the block cannot be reached / is refused).
 * @returns {Promise<boolean>} false when there was nothing (left) to dig
 */
async function digBlock (bot, block, signal) {
  checkAbort(signal)
  if (!block || world.isAir(block)) return false
  const tool = inventory.bestToolFor(bot, block)
  if (tool) await inventory.equip(bot, tool)
  if (!bot.canDigBlock(block)) {
    // out of reach / not visible: look at it from closer
    await navigate.goto(bot, new (goals().GoalLookAtBlock)(block.position, bot.world, { reach: 4 }), { signal, timeout: 20000, attempts: 1 })
    block = bot.blockAt(block.position)
    if (!block || world.isAir(block) || world.isLiquid(block)) return false
  }
  await bot.dig(block, true)
  return true
}

/** get within digging reach of `pos` (a shaft first when it is far below) */
async function reach (bot, pos, { signal } = {}) {
  const here = bot.entity.position
  const below = here.y - pos.y
  if (below > 12) await shaftTo(bot, pos, { signal })
  const goal = new (goals().GoalLookAtBlock)(pos, bot.world, { reach: 4.2 })
  if (goal.isEnd(bot.entity.position.floored())) return
  await navigate.goto(bot, goal, { signal, timeout: 120000, attempts: 3 })
}

/**
 * Dig a vertical shaft down to the level of `target` (feet at target.y), in a safe column next to it.
 * The walk to the column top happens on whatever level the bot is (pathfinder).
 */
async function shaftTo (bot, target, { signal } = {}) {
  const column = chooseColumn(bot, target)
  if (!column) {
    log(bot, `no safe shaft column next to ${navigate.fmt(target)}; pathfinder digs the way`)
    return
  }
  progress(bot, 'shaft', { column: { x: column.x, z: column.z }, to: target.y })
  if (world.distXZ(bot.entity.position.floored(), column) > 0) {
    await navigate.goto(bot, new (goals().GoalXZ)(column.x, column.z), { signal, timeout: 120000, attempts: 3 })
  }
  await digDown(bot, target.y, { signal })
}

/**
 * The best column (x, z) next to `target` to sink a shaft in: every cell from the bot's level down to target.y,
 * and the cells around them, free of liquids; few long air drops.
 */
function chooseColumn (bot, target) {
  const top = Math.floor(bot.entity.position.y)
  const options = []
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    const x = target.x + dx
    const z = target.z + dz
    const score = columnScore(bot, x, z, top, target.y)
    if (score !== null) options.push({ x, z, score: score + world.distXZ({ x, z }, bot.entity.position) * 0.1 + (Math.abs(dx) + Math.abs(dz) > 1 ? 2 : 0) })
  }
  options.sort((a, b) => a.score - b.score)
  return options[0] ? new Vec3(options[0].x, target.y, options[0].z) : null
}

/** null when the column (feet cells from `top` down to `bottom`, the floor under `bottom`) is unsafe, else a cost */
function columnScore (bot, x, z, top, bottom) {
  let cost = 0
  let air = 0
  // find where the column's surface is (the first solid block at or below `top + 1`)
  for (let y = top + 1; y >= bottom - 1; y--) {
    const p = new Vec3(x, y, z)
    const b = bot.blockAt(p)
    if (!b) return null
    if (world.isLiquid(b)) return null
    if (y >= bottom) {
      if (world.PROTECTED.has(b.name) || (!world.isPassable(b) && !b.diggable)) return null
      for (const f of world.HORIZONTAL) if (world.isLiquid(bot.blockAt(p.plus(f)))) return null
      if (world.isPassable(b)) { air++; if (air > 3 && y < top - 1) cost += 4 } else { air = 0; cost += 1 }
    } else if (!world.isSolid(b) || world.isLava(b)) return null // the floor of the shaft bottom
  }
  return cost
}

/**
 * Dig straight down until the feet are at `targetY`. Before each block: the cell below it must be solid ground (a
 * cave under it → step sideways into a staircase instead), and no liquid may touch the opened cell.
 */
async function digDown (bot, targetY, { signal, maxSteps = 400 } = {}) {
  for (let i = 0; i < maxSteps; i++) {
    checkAbort(signal)
    await agentOf(bot)?.safety?.idle(signal)
    await waitGround(bot, signal)
    const feet = bot.entity.position.floored()
    if (feet.y <= targetY) return
    const below = feet.offset(0, -1, 0)
    const blockBelow = bot.blockAt(below)
    if (world.isPassable(blockBelow)) {
      // air under the feet (we are standing on a partial block / falling): wait for gravity
      await waitTicks(bot, 4, signal)
      if (bot.entity.position.floored().y === feet.y) {
        if (!(await staircaseStep(bot, signal))) throw new SkillError(`cannot go down from ${navigate.fmt(feet)}`, { code: 'UNSAFE' })
      }
      continue
    }
    const floor = bot.blockAt(below.offset(0, -1, 0))
    const dropOk = floor && (world.isSolid(floor) || (world.isPassable(floor) && shortDrop(bot, below.offset(0, -1, 0))))
    if (!dropOk || world.isLava(floor) || !world.safeToDig(bot, below) || world.exposesLiquid(bot, below)) {
      if (!(await staircaseStep(bot, signal))) throw new SkillError(`unsafe to dig below ${navigate.fmt(feet)} and no safe step aside`, { code: 'UNSAFE' })
      continue
    }
    await digBlock(bot, blockBelow, signal)
    await waitTicks(bot, 2, signal)
  }
  throw new SkillError(`digDown: too many steps (at ${navigate.fmt(bot.entity.position)})`, { code: 'FAILED' })
}

/** from an air cell `p`: the first solid block below within 3 cells, and no liquid on the way */
function shortDrop (bot, p) {
  for (let d = 0; d < 4; d++) {
    const b = bot.blockAt(p.offset(0, -d, 0))
    if (!b || world.isLiquid(b)) return false
    if (world.isSolid(b)) return d >= 1
  }
  return false
}

async function waitGround (bot, signal) {
  for (let i = 0; i < 40 && !bot.entity.onGround; i++) await waitTicks(bot, 1, signal)
}

/**
 * One staircase step down: to the side cell one lower (digging its 3 cells), into a safe direction.
 * @returns {Promise<boolean>} whether a step was made
 */
async function staircaseStep (bot, signal) {
  const feet = bot.entity.position.floored()
  for (const d of world.HORIZONTAL) {
    const dest = feet.plus(d).offset(0, -1, 0)
    const cells = [dest.offset(0, 2, 0), dest.offset(0, 1, 0), dest]
    const ignore = [feet, feet.offset(0, 1, 0), ...cells]
    if (!cells.every((c) => world.safeToDig(bot, c) && !world.exposesLiquid(bot, c, { ignore }))) continue
    const floor = bot.blockAt(dest.offset(0, -1, 0))
    if (!world.isSolid(floor) || world.isLava(floor)) continue
    for (const c of cells) {
      for (let k = 0; k < 8; k++) { // gravel / sand keeps falling into the cell
        const b = bot.blockAt(c)
        if (!b || world.isPassable(b)) break
        await digBlock(bot, b, signal)
        await waitTicks(bot, 3, signal)
      }
    }
    if (await navigate.stepTo(bot, dest, signal)) return true
  }
  return false
}

/**
 * Pick up item entities around `center` (drops of a block just dug). Walks onto each and waits for the pickup.
 * @param {object} bot
 * @param {Vec3} center
 * @param {{ signal?: AbortSignal, radius?: number, wait?: number, timeout?: number, item?: string }} [opts]
 */
async function pickupNear (bot, center, { signal, radius = 3, wait = 900, timeout = 9000, item } = {}) {
  const started = Date.now()
  const before = item ? inventory.count(bot, item) : 0
  const skip = new Set()
  await sleep(150, signal)
  while (Date.now() - started < timeout) {
    checkAbort(signal)
    if (item && inventory.count(bot, item) > before && !nearbyDrops(bot, center, radius, skip, item).length) return true
    const drops = nearbyDrops(bot, center, radius, skip, item)
    if (!drops.length) {
      if (Date.now() - started > wait) return item ? inventory.count(bot, item) > before : true
      await sleep(100, signal)
      continue
    }
    const drop = drops[0]
    try {
      await walkOnto(bot, drop, signal)
    } catch (err) {
      if (isAbort(err)) throw err
      skip.add(drop.id)
    }
    if (bot.entities[drop.id]) skip.add(drop.id) // still there: unreachable (or not ours to take)
  }
  return item ? inventory.count(bot, item) > before : true
}

function nearbyDrops (bot, center, radius, skip, want) {
  // junk and surplus (cobblestone beyond what the agent keeps, saplings, tossed stuff) stay where they are
  const unwanted = (e) => {
    let name = null
    try { name = e.getDroppedItem?.()?.name ?? null } catch {}
    return name !== want && inventory.unwanted(bot, name)
  }
  return Object.values(bot.entities)
    .filter((e) => e.name === 'item' && !skip.has(e.id) && e.position.distanceTo(center) <= radius && !unwanted(e))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))
}

/** walk to an item entity until it is collected / gone (≤ 6 s) */
async function walkOnto (bot, entity, signal) {
  const deadline = Date.now() + 6000
  while (bot.entities[entity.id] && Date.now() < deadline) {
    checkAbort(signal)
    const p = entity.position
    if (bot.entity.position.distanceTo(p) < 0.9) { await waitTicks(bot, 3, signal); continue }
    const goal = new (goals().GoalNear)(p.x, p.y, p.z, 0.8)
    await navigate.goto(bot, goal, { signal, timeout: Math.max(1000, deadline - Date.now()), attempts: 1 }).catch((err) => { if (isAbort(err)) throw err })
    await waitTicks(bot, 2, signal)
  }
}

module.exports = { collectBlocks, mineAt, digBlock, reach, shaftTo, chooseColumn, digDown, staircaseStep, pickupNear, candidates, isProtected }
