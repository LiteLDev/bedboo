// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Small helpers shared by U18's skills (combat, portal, nether, end). Public mineflayer API + mineflayer-pathfinder
 * only (no `bot._client`, no commands): everything here runs unchanged on mineflayer (Java) as well.
 */
const { Vec3 } = require('vec3')

/** blocks the bot may pillar / bridge with (Bedrock names; Java names where they differ) */
const SCAFFOLD_BLOCKS = ['dirt', 'cobblestone', 'netherrack', 'cobbled_deepslate', 'end_stone', 'stone', 'andesite', 'diorite', 'granite', 'tuff', 'blackstone', 'basalt', 'deepslate', 'sandstone', 'grass_block']

function vec (p) {
  return p instanceof Vec3 ? p : new Vec3(p.x, p.y, p.z)
}

/** a plain `{x,y,z}` (JSON-serialisable) */
function plain (p) {
  return p ? { x: p.x, y: p.y, z: p.z } : null
}

/**
 * Progress log of the agent: emitted as `agent_log` on the bot (scenario harnesses collect it) and printed when
 * `BEDBOO_AGENT_LOG` is set.
 */
function log (bot, ...parts) {
  const msg = parts.map((p) => typeof p === 'string' ? p : JSON.stringify(p)).join(' ')
  try { bot.emit('agent_log', msg) } catch {}
  if (process.env.BEDBOO_AGENT_LOG) console.log(`      [agent ${new Date().toISOString().slice(11, 19)}] ${msg}`)
}

class AbortedError extends Error {
  constructor (message = 'aborted') {
    super(message)
    this.name = 'AbortError'
  }
}

function throwIfAborted (signal) {
  if (signal?.aborted) throw new AbortedError()
}

/** setTimeout as a promise that rejects when `signal` aborts */
function sleep (ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new AbortedError())
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve() }, ms)
    const onAbort = () => { clearTimeout(timer); reject(new AbortedError()) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** Poll `predicate` every `interval` ms until truthy (resolves with its value) or `timeout` (rejects). */
async function waitFor (predicate, { timeout = 10000, interval = 100, signal, message = 'condition' } = {}) {
  const until = Date.now() + timeout
  while (true) {
    const v = await predicate()
    if (v) return v
    if (Date.now() > until) throw new Error(`timed out after ${timeout} ms waiting for ${message}`)
    await sleep(interval, signal)
  }
}

/** Resolve with the first `event` of `emitter` whose args satisfy `check` (rejects on timeout / abort). */
function onceEvent (emitter, event, { check = () => true, timeout = 10000, signal } = {}) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer)
      emitter.removeListener(event, listener)
      signal?.removeEventListener('abort', onAbort)
    }
    const listener = (...args) => {
      let ok
      try { ok = check(...args) } catch (err) { cleanup(); return reject(err) }
      if (ok) { cleanup(); resolve(args) }
    }
    const onAbort = () => { cleanup(); reject(new AbortedError()) }
    const timer = setTimeout(() => { cleanup(); reject(new Error(`timed out after ${timeout} ms waiting for ${event}`)) }, timeout)
    emitter.on(event, listener)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// ---------------------------------------------------------------------------------------------------------------
// inventory

/** number of `name` items in the inventory (hotbar + main; worn armor / off-hand excluded) */
function count (bot, name) {
  const def = bot.registry.itemsByName[name]
  if (!def) return 0
  return bot.inventory.items().filter((i) => i.type === def.id).reduce((n, i) => n + i.count, 0)
}

/** first inventory item matching a name, a list of names (in preference order) or a predicate */
function findItem (bot, match) {
  const items = bot.inventory.items()
  if (typeof match === 'function') return items.find(match) ?? null
  const names = Array.isArray(match) ? match : [match]
  for (const name of names) {
    const item = items.find((i) => i.name === name)
    if (item) return item
  }
  return null
}

/** equip the first item matching `match` (see {@link findItem}); resolves with the item, throws when missing */
async function equipItem (bot, match, destination = 'hand') {
  if (destination === 'hand' && bot.heldItem && (typeof match === 'function' ? match(bot.heldItem) : [].concat(match).includes(bot.heldItem.name))) return bot.heldItem
  const item = findItem(bot, match)
  if (!item) throw new Error(`no ${typeof match === 'function' ? 'matching item' : [].concat(match).join('/')} in the inventory`)
  await bot.equip(item, destination)
  return item
}

const FOODS = [
  'golden_carrot', 'cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'baked_potato',
  'cooked_cod', 'cooked_rabbit', 'bread', 'pumpkin_pie', 'carrot', 'apple', 'beef', 'porkchop', 'mutton', 'potato',
  'sweet_berries', 'melon_slice', 'cookie', 'chicken', 'cod', 'salmon', 'rabbit', 'dried_kelp'
]

/**
 * Eat when hungry (food < `minFood`) or hurt and not full (health < `minHealth`). Golden apples first when the health
 * is critical. Restores the previously held item. @returns {Promise<string|null>} the food eaten
 */
async function eatIfNeeded (bot, { minFood = 14, minHealth = 14, critical = 8, signal } = {}) {
  if (bot.food >= 20) return null
  const hungry = bot.food < minFood
  const hurt = bot.health < minHealth
  if (!hungry && !hurt) return null
  const order = bot.health <= critical ? ['enchanted_golden_apple', 'golden_apple', ...FOODS] : FOODS
  const food = findItem(bot, order)
  if (!food) return null
  throwIfAborted(signal)
  const previous = bot.heldItem
  await bot.equip(food, 'hand')
  try {
    await bot.consume()
  } finally {
    if (previous && previous.name !== food.name) {
      const again = findItem(bot, previous.name)
      if (again) await bot.equip(again, 'hand').catch(() => {})
    }
  }
  return food.name
}

// ---------------------------------------------------------------------------------------------------------------
// pathfinder

/**
 * Load mineflayer-pathfinder (once) and give it Bedrock-friendly movements: digging allowed, scaffolding with the
 * common building blocks, no sprint-jumping parkour over lava. @returns {{ goals: object, movements: object }}
 */
const movementsOf = new WeakMap()
function ensurePathfinder (bot, opts = {}) {
  const pf = require('mineflayer-pathfinder')
  if (!bot.pathfinder) bot.loadPlugin(pf.pathfinder)
  const cached = movementsOf.get(bot)
  if (cached && !opts.fresh && cached.dimension === bot.game?.dimension) {
    bot.pathfinder.setMovements(cached.movements)
    return { goals: pf.goals, movements: cached.movements }
  }
  // no parkour jumps over the End's void
  const { canDig = true, scaffold = SCAFFOLD_BLOCKS, allowParkour = bot.game?.dimension !== 'the_end', maxDropDown = 3 } = opts
  const movements = new pf.Movements(bot)
  movements.canDig = canDig
  movements.allowParkour = allowParkour
  movements.allow1by1towers = true
  movements.maxDropDown = maxDropDown
  // pathfinder's 'liquid' includes lava: an unlimited drop into a liquid would also be one into a lava lake
  movements.infiniteLiquidDropdownDistance = false
  movements.canOpenDoors = true
  movements.scafoldingBlocks = scaffold.map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined)
  // never dig / walk into portals or the blocks holding the bot's portal (callers add their exclusions)
  for (const name of ['portal', 'end_portal', 'end_portal_frame', 'end_gateway', 'obsidian', 'bedrock', 'magma', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow', 'pointed_dripstone']) {
    const b = bot.registry.blocksByName[name]
    if (!b) continue
    if (['portal', 'end_portal', 'end_gateway', 'magma', 'fire', 'soul_fire', 'campfire', 'soul_campfire', 'sweet_berry_bush', 'wither_rose', 'powder_snow'].includes(name)) movements.blocksToAvoid.add(b.id)
    if (['portal', 'end_portal', 'end_portal_frame', 'end_gateway', 'obsidian', 'bedrock'].includes(name)) movements.blocksCantBreak.add(b.id)
  }
  // under the End's island (its arrival platform) every tower step fails; elsewhere (gravel shafts, …) the bot is
  // usually centred well enough to tower out
  if (bot.game?.dimension === 'the_end') bedrockTowers(movements)
  // the Nether: never bridge over a drop deeper than 4 blocks (the lava ocean): a bridge of scaffolding blocks over it
  // is where a piglin's crossbow bolt or a misstep ends the trip (the End's arrival platform needs a short bridge to
  // the island: allowed there)
  if (bot.game?.dimension === 'the_nether') {
    movements.exclusionAreasPlace.push((block) => {
      const p = block.position
      for (let d = 1; d <= 4; d++) {
        const b = bot.blockAt(p.offset(0, -d, 0))
        if (!b) return 100
        if (isLava(b)) return 100
        if (b.boundingBox === 'block' || isWater(b)) return 0
      }
      return 100
    })
  }
  bot.pathfinder.setMovements(movements)
  bot.pathfinder.thinkTimeout = 10000
  movementsOf.set(bot, { movements, dimension: bot.game?.dimension })
  return { goals: pf.goals, movements }
}

/** the bot's running combat guard (combat.defend registers itself): movement waits while it fights */
const guards = new WeakMap()
function setGuard (bot, guard) {
  if (guard) guards.set(bot, guard)
  else guards.delete(bot)
}
function guardOf (bot) {
  return guards.get(bot) ?? null
}

/**
 * Bedrock: BDS refuses a block that overlaps the player's server-side hitbox, so a 1×1 tower step (jump, place under
 * the feet) needs the feet to rise a full block — and on Bedrock the bot is not re-centred on the pillar (the patched
 * pathfinder's fullStop no longer teleports it), so its hitbox also spans the neighbouring columns: any block two or
 * three above the feet there (a cave ceiling, the End island's underside) cuts the jump short and every placement is
 * refused (measured: 200+ place_errors in a row under the End's island). Such tower steps are not taken; the
 * pathfinder digs a staircase instead. Applied in the End only (a centred bot towers out of a 1×1 shaft fine).
 */
function bedrockTowers (movements) {
  const getMoveUp = movements.getMoveUp
  movements.getMoveUp = function (node, neighbors) {
    const before = neighbors.length
    getMoveUp.call(this, node, neighbors)
    if (neighbors.length === before) return
    const move = neighbors[neighbors.length - 1]
    if (!move.toPlace?.length) return // a ladder / vine climb: no jump-placing
    if (this.getBlock(node, 0, 3, 0).physical) { neighbors.pop(); return }
    for (let dx = -1; dx <= 1; dx++) {
      for (let dz = -1; dz <= 1; dz++) {
        if (dx === 0 && dz === 0) continue
        if (this.getBlock(node, dx, 2, dz).physical || this.getBlock(node, dx, 3, dz).physical) { neighbors.pop(); return }
      }
    }
  }
  return movements
}

/**
 * `bot.pathfinder.goto(goal)` with a timeout, abort support and retries after search timeouts / path resets
 * (knockback, block updates). Never walks while the bot's guard fights: waits for it first, and a path the guard
 * stopped is resumed after the fight (not counted as a retry). Throws the last error after `retries`.
 */
async function goto (bot, goal, { signal, timeout = 90000, retries = 3, movements, stallMs = 30000 } = {}) {
  if (!bot.pathfinder) ensurePathfinder(bot)
  if (movements) bot.pathfinder.setMovements(movements)
  const deadline = Date.now() + timeout
  const distance = () => typeof goal.heuristic === 'function' ? goal.heuristic(bot.entity.position.floored()) : 0
  let lastErr
  let interruptions = 0
  let partials = 0
  let deadline2 = deadline
  const waitGuard = async (guard) => {
    // time spent waiting for a fight does not count against the walk
    const t = Date.now()
    await guard.idle()
    deadline2 += Date.now() - t
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    throwIfAborted(signal)
    const guard = guardOf(bot)
    if (guard?.busy) await waitGuard(guard)
    if (goal.isEnd(bot.entity.position.floored())) return
    if (Date.now() >= deadline2) break
    let timer
    let stallTimer
    const onAbort = () => bot.pathfinder.stop()
    signal?.addEventListener('abort', onAbort, { once: true })
    const searches = []
    const onUpdate = (r) => { if (searches.length < 50) searches.push(`${r.status}:${r.visitedNodes}n/${Math.round(r.time)}ms/${r.path.length}`) }
    if (process.env.BEDBOO_AGENT_DEBUG) bot.on('path_update', onUpdate)
    try {
      await Promise.race([
        bot.pathfinder.goto(goal),
        new Promise((resolve, reject) => {
          timer = setTimeout(() => {
            bot.pathfinder.stop()
            reject(new Error(`goto timed out after ${timeout} ms (at ${bot.entity.position.floored()})`))
          }, Math.max(1000, deadline2 - Date.now()))
          // no progress (the search keeps failing, the bot is stuck): give up early
          let last = bot.entity.position.clone()
          let lastMoveAt = Date.now()
          stallTimer = setInterval(() => {
            if (guardOf(bot)?.busy) { lastMoveAt = Date.now(); return }
            if (bot.entity.position.distanceTo(last) > 1) {
              last = bot.entity.position.clone()
              lastMoveAt = Date.now()
            } else if (Date.now() - lastMoveAt > stallMs) {
              bot.pathfinder.stop()
              reject(new Error(`goto stalled: no progress for ${stallMs} ms (at ${bot.entity.position.floored()})`))
            }
          }, 1000)
        })
      ])
      return
    } catch (err) {
      lastErr = err
      if (signal?.aborted) throw new AbortedError()
      if (process.env.BEDBOO_AGENT_DEBUG) debugStuck(bot, goal, err, searches)
      const guard = guardOf(bot)
      if (guard && (guard.busy || err.name === 'PathStopped' || err.name === 'GoalChanged') && interruptions < 20) {
        // the guard stopped the path for a fight: walk on afterwards
        interruptions++
        attempt--
        await waitGuard(guard)
        continue
      }
      if (err.name === 'NoPath' && attempt >= 1) break
      if (/timed out after|stalled/.test(err.message)) break
      if (err.name === 'Timeout' && partials < 40) {
        // the search ran out of think time (a long way): pathfinder walks its best partial path; re-plan from where
        // it ends — an attempt only when that brought the bot no closer
        partials++
        const before = distance()
        await walkingDone(bot, deadline2, signal)
        if (before - distance() >= 2) attempt--
        continue
      }
      await sleep(300, signal)
    } finally {
      clearTimeout(timer)
      clearInterval(stallTimer)
      signal?.removeEventListener('abort', onAbort)
      bot.removeListener('path_update', onUpdate)
    }
  }
  throw lastErr
}

/** BEDBOO_AGENT_DEBUG: why a goto failed — the searches and the blocks around the bot */
function debugStuck (bot, goal, err, searches) {
  const p = bot.entity.position.floored()
  const rows = []
  for (let dy = 2; dy >= -2; dy--) {
    const row = []
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) row.push((bot.blockAt(p.offset(dx, dy, dz))?.name ?? '?').replace('netherrack', 'NR').slice(0, 8))
    rows.push(`dy${dy}: ${row.join(' ')}`)
  }
  const scaffold = movementsOf.get(bot)?.movements.countScaffoldingItems()
  log(bot, `goto debug: ${err.name} ${err.message} at ${bot.entity.position} onGround ${bot.entity.onGround} goal ${JSON.stringify({ x: goal.x, y: goal.y, z: goal.z })} searches [${searches.join(', ')}] scaffold ${scaffold} | ${rows.join(' | ')}`)
}

/** resolves once mineflayer-pathfinder stopped walking / digging / building (two quiet polls) or at `deadline` */
async function walkingDone (bot, deadline, signal) {
  let quiet = 0
  while (Date.now() < deadline && quiet < 2) {
    await sleep(250, signal)
    const pf = bot.pathfinder
    const busy = pf.isMoving?.() || pf.isMining?.() || pf.isBuilding?.()
    quiet = busy ? 0 : quiet + 1
  }
}

/** stop pathfinder and every movement control (safe to call any time) */
function stopMoving (bot) {
  try { bot.pathfinder?.stop() } catch {}
  try { bot.pathfinder?.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
}

// ---------------------------------------------------------------------------------------------------------------
// world

/** liquid_depth state (Bedrock) / level (Java) of a liquid block: 0 = source */
function liquidLevel (block) {
  if (!block) return null
  const props = block.getProperties?.() ?? {}
  if (props.liquid_depth !== undefined) return Number(props.liquid_depth)
  if (props.level !== undefined) return Number(props.level)
  return block.metadata ?? null
}

function isLava (block) {
  return !!block && (block.name === 'lava' || block.name === 'flowing_lava')
}
function isWater (block) {
  return !!block && (block.name === 'water' || block.name === 'flowing_water' || block.isWaterlogged === true)
}
function isLavaSource (block) {
  return isLava(block) && liquidLevel(block) === 0
}
function isWaterSource (block) {
  return !!block && (block.name === 'water' || block.name === 'flowing_water') && liquidLevel(block) === 0
}

/** a full, solid block the bot can stand on / place against */
function isSolid (block) {
  return !!block && block.boundingBox === 'block' && !isLava(block) && !isWater(block) && !/leaves|_log$|fence|wall$|_slab$|stairs/.test(block.name)
}

/** something the bot can stand on (full blocks, stairs, slabs, frames, …; not fences / walls) */
function isStandable (block) {
  return !!block && block.boundingBox === 'block' && !isLava(block) && !/fence|wall$|_wall_|cobblestone_wall|magma|campfire|cactus/.test(block.name)
}

/** air or a plant the bot walks through / a placement replaces */
function isClear (block) {
  return !!block && (block.boundingBox === 'empty') && !isLava(block) && !isWater(block) && !/fire|portal|cobweb|^web$|sweet_berry|powder_snow/.test(block.name)
}

/** within `radius` (Chebyshev) of a lava block? */
function nearLava (bot, p, radius = 1) {
  const c = vec(p)
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dz = -radius; dz <= radius; dz++) {
        if (isLava(bot.blockAt(c.offset(dx, dy, dz)))) return true
      }
    }
  }
  return false
}

/** Blocks by names around the bot (or `point`), nearest first, filtered. */
function findBlocks (bot, names, { maxDistance = 64, count = 256, point, filter = () => true } = {}) {
  const ids = [].concat(names).map((n) => bot.registry.blocksByName[n]?.id).filter((id) => id !== undefined)
  if (!ids.length) return []
  return bot.findBlocks({ matching: ids, maxDistance, count, point: point ? vec(point) : undefined })
    .map((p) => bot.blockAt(p))
    .filter((b) => b && filter(b))
}

/** best tool for a block from the inventory (pathfinder's Bedrock-aware pick), or null for the hand */
function bestTool (bot, block) {
  if (bot.pathfinder?.bestHarvestTool) return bot.pathfinder.bestHarvestTool(block)
  let best = null
  let bestTime = Infinity
  for (const item of bot.inventory.items()) {
    if (block.harvestTools && !block.harvestTools[item.type]) continue
    const t = block.digTime(item.type, false, false, false, [], [])
    if (t < bestTime) { best = item; bestTime = t }
  }
  return best
}

/**
 * Dig one block with the best tool (throws when it cannot be harvested and `requireHarvest`). Resolves once the
 * server broke it.
 */
async function digBlock (bot, block, { signal, requireHarvest = false } = {}) {
  throwIfAborted(signal)
  if (!block) return false
  block = bot.blockAt(block.position) ?? block
  // air and liquids cannot be dug; plants (flowers, grass: empty bounding box) can
  if (!block || ['air', 'cave_air', 'void_air', 'water', 'flowing_water', 'lava', 'flowing_lava'].includes(block.name)) return false
  const tool = bestTool(bot, block)
  if (requireHarvest && block.harvestTools && !(tool && block.harvestTools[tool.type])) {
    throw new Error(`no tool to harvest ${block.name}`)
  }
  if (tool && bot.heldItem?.type !== tool.type) await bot.equip(tool, 'hand')
  const onAbort = () => { try { bot.stopDigging() } catch {} }
  signal?.addEventListener('abort', onAbort, { once: true })
  try {
    await bot.dig(block, true)
  } finally {
    signal?.removeEventListener('abort', onAbort)
  }
  return true
}

/** dropped item entities within `radius` of `center` (optionally only of `names`) */
function dropsNear (bot, center, { radius = 4, names } = {}) {
  const c = vec(center)
  return Object.values(bot.entities).filter((e) => {
    if (e.name !== 'item') return false
    if (e.position.distanceTo(c) > radius) return false
    if (names) {
      const item = e.getDroppedItem?.()
      if (!item || !names.includes(item.name)) return false
    }
    return true
  })
}

/**
 * Walk over the drops around `center` until they are picked up or `timeout` passes.
 * @returns {Promise<number>} drops left
 */
async function collectDrops (bot, center, { radius = 4, names, timeout = 15000, signal } = {}) {
  const until = Date.now() + timeout
  const { goals } = ensurePathfinder(bot)
  await sleep(400, signal) // let the drop spawn
  while (Date.now() < until) {
    const drops = dropsNear(bot, center, { radius, names })
    if (!drops.length) return 0
    const target = drops.sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    try {
      await goto(bot, new goals.GoalBlock(target.position.x, target.position.y, target.position.z), { signal, timeout: Math.max(1000, until - Date.now()), retries: 1 })
    } catch (err) {
      if (signal?.aborted) throw err
    }
    await sleep(300, signal)
  }
  return dropsNear(bot, center, { radius, names }).length
}

/** wait for the block at `pos` to satisfy `check(block)` (blockUpdate or polling) */
async function waitForBlock (bot, pos, check, { timeout = 5000, signal } = {}) {
  const p = vec(pos)
  return waitFor(() => { const b = bot.blockAt(p); return b && check(b) ? b : null }, { timeout, interval: 50, signal, message: `block at ${p}` })
}

/** wait for the bot to spawn in `dimension` ('overworld' | 'the_nether' | 'the_end') */
function waitForDimension (bot, dimension, { timeout = 60000, signal } = {}) {
  if (bot.game.dimension === dimension) return Promise.resolve()
  return onceEvent(bot, 'spawn', { check: () => bot.game.dimension === dimension, timeout, signal })
}

module.exports = {
  SCAFFOLD_BLOCKS,
  FOODS,
  AbortedError,
  vec,
  plain,
  log,
  sleep,
  waitFor,
  onceEvent,
  throwIfAborted,
  count,
  findItem,
  equipItem,
  eatIfNeeded,
  ensurePathfinder,
  setGuard,
  guardOf,
  goto,
  stopMoving,
  liquidLevel,
  isLava,
  isWater,
  isLavaSource,
  isWaterSource,
  isSolid,
  isStandable,
  isClear,
  nearLava,
  findBlocks,
  bestTool,
  digBlock,
  dropsNear,
  collectDrops,
  waitForBlock,
  waitForDimension
}
