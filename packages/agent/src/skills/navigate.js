// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Navigation: mineflayer-pathfinder with Bedrock-tuned Movements, time limits, re-planning and getting unstuck.
 *
 * Skill `navigate` — args: { position: {x,y,z} | spawn: true, range?: 1, goal?: 'near'|'xz'|'block'|'y'|'lookAt'|'get',
 *                            timeout?: ms }
 *                    result: { reached: true, position, ms }
 *
 * Helpers for other skills: `goto(bot, goal, opts)`, `movements(bot, overrides)`, `ensurePathfinder(bot)`,
 * `unstick(bot)`, `goalFor(spec)`.
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, sleep, waitTicks, agentOf } = require('../skill')
const world = require('../world')
const inventory = require('../inventory')

let pathfinderModule = null
function pf () {
  pathfinderModule ??= require('mineflayer-pathfinder')
  return pathfinderModule
}

/** load mineflayer-pathfinder on the bot if nothing did yet */
function ensurePathfinder (bot) {
  if (!bot.pathfinder) bot.loadPlugin(pf().pathfinder)
  return bot.pathfinder
}

const baseMovements = new WeakMap()

/**
 * Movements tuned for a survival agent on Bedrock (docs/ecosystem.md): doors opened, no long drops, our stations and
 * containers never dug, every filler block usable for towers / bridges.
 * @param {object} bot
 * @param {object} [overrides] Movements fields to set (a fresh instance is returned when given)
 */
function movements (bot, overrides) {
  ensurePathfinder(bot)
  const { Movements } = pf()
  if (!overrides && baseMovements.has(bot)) return baseMovements.get(bot)
  const moves = new Movements(bot)
  moves.canOpenDoors = true
  moves.allowParkour = false // a missed jump in survival costs health; the gaps it saves are small
  moves.allowSprinting = true
  moves.maxDropDown = 3 // fall damage starts above 3 blocks
  moves.liquidCost = 10 // swimming is slow and long underwater stretches drown the bot
  moves.allowFreeMotion = false
  for (const name of ['crafting_table', 'furnace', 'lit_furnace', 'chest', 'trapped_chest', 'barrel', 'bed', 'wooden_door', 'spruce_door', 'birch_door', 'jungle_door', 'acacia_door', 'dark_oak_door', 'mangrove_door', 'cherry_door', 'pale_oak_door', 'poplar_door']) {
    const b = bot.registry.blocksByName[name]
    if (b) moves.blocksCantBreak.add(b.id)
  }
  const scaffold = []
  for (const name of inventory.FILLER) {
    const item = bot.registry.itemsByName[name]
    if (item) scaffold.push(item.id)
  }
  moves.scafoldingBlocks = scaffold
  // never dig through what the agent built (build skill zones)
  moves.exclusionAreasBreak.push((block) => world.isProtected(bot, block.position) ? 1000 : 0)
  if (overrides) {
    overrides = { ...overrides }
    for (const k of ['exclusionAreasBreak', 'exclusionAreasPlace', 'exclusionAreasStep']) {
      if (overrides[k]) { moves[k].push(...overrides[k]); delete overrides[k] }
    }
    Object.assign(moves, overrides)
  } else {
    baseMovements.set(bot, moves)
  }
  return moves
}

/** a pathfinder goal from a plain spec */
function goalFor ({ position, range = 1, goal = 'near' }, bot) {
  const { goals } = pf()
  const p = new Vec3(position.x, position.y ?? 0, position.z)
  switch (goal) {
    case 'xz': return range > 0 ? new goals.GoalNearXZ(p.x, p.z, range) : new goals.GoalXZ(p.x, p.z)
    case 'y': return new goals.GoalY(p.y)
    case 'block': return new goals.GoalBlock(p.x, p.y, p.z)
    case 'get': return new goals.GoalGetToBlock(p.x, p.y, p.z)
    case 'lookAt': return new goals.GoalLookAtBlock(p.floored(), bot.world, { reach: range > 1 ? range : 4.5 })
    default: return new goals.GoalNear(p.x, p.y, p.z, range)
  }
}

const isEnd = (goal, bot) => goal.isEnd(bot.entity.position.floored()) || goal.isEnd(bot.entity.position.offset(0, 0.5, 0).floored())

/**
 * Walk to `goal` with pathfinder: per-attempt time limit, re-plan on a reset / no path, unstick when the bot stops
 * making progress, wait while the Agent's safety behaviours (fighting, fleeing) have the controls.
 *
 * @param {object} bot
 * @param {object} goal a mineflayer-pathfinder goal
 * @param {object} [opts]
 * @param {number} [opts.timeout=90000] overall ms
 * @param {number} [opts.attempts=4] re-plans after a failure
 * @param {AbortSignal} [opts.signal]
 * @param {object} [opts.movements] Movements to use (default: movements(bot))
 * @param {number} [opts.stuckMs=8000] no progress for this long → unstick
 * @param {boolean} [opts.escape=false] after two failures with a goal more than 24 blocks away while in the water or
 *   under a roof: survive.escape (out of the water, up to the sky) once, then plan again — for long walks only (a
 *   miner's goal underground must not send it to the surface)
 * @param {boolean} [opts.safety=true] wait while the Agent's safety behaviours have the controls (false: called by
 *   one of them)
 * @returns {Promise<{ reached: true, ms: number, attempts: number }>}
 */
async function goto (bot, goal, { timeout = 90000, attempts = 4, signal, movements: moves, stuckMs = 8000, legs = true, safety: waitSafety = true, escape = false } = {}) {
  ensurePathfinder(bot)
  const started = Date.now()
  // `safety: false`: called by a safety behaviour itself (it has the controls; waiting for it would deadlock)
  const safety = waitSafety ? agentOf(bot)?.safety : null
  // far away: walk there in legs (one A* search over 100+ blocks of hills runs out of think time), on the surface
  // (from deep underground pathfinder tunnels or swims through flooded caves)
  const center = goalCenter(goal)
  if (legs && center && distXZ(center, bot.entity.position) > LEG * 1.5) {
    const survive = require('./survive')
    if (!survive.underOpenSky(bot) && (center.y === undefined || center.y > bot.entity.position.y + 8)) {
      await survive.surface(bot, { signal, timeout: Math.min(180000, timeout / 2) }).catch((err) => { if (isAbort(err)) throw err; log(bot, `goto: could not surface first: ${err.message}`) })
    }
    await travel(bot, center, { signal, timeout: timeout * 0.8, movements: moves })
  }
  let failures = 0
  let shortOfGoal = 0
  let lastError = null
  let escaped = false
  for (let attempt = 0; ; attempt++) {
    checkAbort(signal)
    await safety?.idle(signal)
    if (isEnd(goal, bot)) return { reached: true, ms: Date.now() - started, attempts: attempt }
    const left = timeout - (Date.now() - started)
    if (left <= 0) throw new SkillError(`navigation timed out after ${timeout} ms at ${fmt(bot.entity.position)}${lastError ? ` (${lastError.message})` : ''}`, { code: 'TIMEOUT', cause: lastError })
    if (failures > attempts) throw new SkillError(`no path to the goal from ${fmt(bot.entity.position)}: ${lastError?.message}`, { code: 'NO_PATH', cause: lastError })
    bot.pathfinder.setMovements(moves ?? movements(bot))
    try {
      await runOnce(bot, goal, { ms: left, signal, stuckMs })
      // pathfinder resolved: at the goal by its own node test (which may differ from ours by a partial block), or
      // at the end of a partial path — go on from here, but trust pathfinder when it keeps saying "reached"
      if (isEnd(goal, bot) || ++shortOfGoal >= 3) return { reached: true, ms: Date.now() - started, attempts: attempt + 1 }
    } catch (err) {
      stopPathfinder(bot)
      if (isAbort(err)) throw err
      if (safety?.busy) continue // interrupted by a fight / flight: not a navigation failure
      lastError = err
      failures++
      log(bot, `goto: ${err.name ?? 'Error'} ${err.message} (failure ${failures})`)
      if (err.name === 'GotoTimeout') continue // out of time: the loop head reports it
      if (err.name === 'Timeout' && center && distXZ(center, bot.entity.position) > LEG / 2) {
        // pathfinder's A* ran out of think time: get closer in legs, then search again
        await travel(bot, center, { signal, timeout: Math.max(10000, timeout - (Date.now() - started)) * 0.8, movements: moves, leg: LEG / 2 })
          .catch((e) => { if (isAbort(e)) throw e })
        continue
      }
      if (err.code === 'STUCK' || err.name === 'NoPath') {
        // stuck twice in a pit / a flooded cave / the water with the goal far away: the last resort first — out of
        // the water, up to the sky (pillar / staircase), then plan again from the surface
        const far = center && distXZ(center, bot.entity.position) > 24
        if (escape && !escaped && failures >= 2 && far && waitSafety && needsEscape(bot)) {
          escaped = true
          log(bot, `goto: stuck at ${fmt(bot.entity.position)} (${err.message}); escaping (out of the water / the pit)`)
          await require('./survive').escape(bot, { signal, timeout: Math.min(150000, Math.max(30000, timeout - (Date.now() - started))) })
            .catch((e) => { if (isAbort(e)) throw e; log(bot, `goto: escape: ${e.message}`) })
          continue
        }
        await unstick(bot, { signal, toward: goalCenter(goal) }).catch((e) => { if (isAbort(e)) throw e })
      }
      await sleep(200, signal)
    }
  }
}

/** in the water, or under a roof (a pit, a cave, a flooded tunnel) */
function needsEscape (bot) {
  const survive = require('./survive')
  return survive.inWater(bot) || !survive.underOpenSky(bot)
}

function goalCenter (goal) {
  if (goal.pos) return goal.pos
  if (goal.x !== undefined && goal.z !== undefined) return new Vec3(goal.x, goal.y ?? 0, goal.z)
  if (Array.isArray(goal.goals)) {
    for (const g of goal.goals) {
      const c = goalCenter(g)
      if (c) return c
    }
  }
  return null
}

const LEG = 32
const distXZ = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)

/**
 * Walk towards `target` (x, z) in legs of `leg` blocks (GoalNearXZ: pathfinder picks the height), until within
 * `leg` of it. A leg that fails is retried once 16 blocks to the side (around a lake / a cliff).
 */
async function travel (bot, target, { signal, timeout = 120000, movements: moves, leg = LEG } = {}) {
  const { goals } = pf()
  const started = Date.now()
  let sideways = 0
  while (distXZ(target, bot.entity.position) > leg) {
    checkAbort(signal)
    if (Date.now() - started > timeout) return false
    const here = bot.entity.position
    const d = distXZ(target, here)
    const dir = { x: (target.x - here.x) / d, z: (target.z - here.z) / d }
    const side = sideways ? (sideways % 2 ? 1 : -1) * 16 : 0
    // the leg's end on dry land (a waypoint in a lake leaves the bot swimming at a shore it may not climb)
    const wp = dryNear(bot, { x: here.x + dir.x * leg - dir.z * side, z: here.z + dir.z * leg + dir.x * side }) ??
      { x: here.x + dir.x * leg - dir.z * side, z: here.z + dir.z * leg + dir.x * side }
    try {
      await goto(bot, new goals.GoalNearXZ(wp.x, wp.z, 4), { signal, timeout: Math.min(60000, timeout - (Date.now() - started)), attempts: 1, movements: moves, legs: false, escape: true })
      sideways = 0
    } catch (err) {
      if (isAbort(err)) throw err
      if (++sideways > 2) return false
      log(bot, `travel: leg to ${fmt(new Vec3(wp.x, here.y, wp.z))} failed (${err.message}); trying aside`)
    }
  }
  return true
}

/**
 * What the top of column x, z is: 'water' / 'lava' / 'dry' (solid ground under open air), or null when the column is
 * not loaded. Scans down from `top` (leaves and logs are skipped: a tree stands on the ground).
 */
function columnTop (bot, x, z, top) {
  for (let y = top; y > top - 96; y--) {
    const b = bot.blockAt(new Vec3(Math.floor(x), y, Math.floor(z)))
    if (!b) return null
    if (world.isWater(b)) return 'water'
    if (world.isLava(b)) return 'lava'
    if (world.isPassable(b) || /leaves|_log$/.test(b.name)) continue
    return 'dry'
  }
  return null
}

/**
 * `wp` itself when its column's top is dry land (or not loaded), else the nearest dry column within 12 blocks of it
 * (null when there is none).
 */
function dryNear (bot, wp) {
  const top = Math.min(319, Math.floor(bot.entity.position.y) + 40)
  const first = columnTop(bot, wp.x, wp.z, top)
  if (first === null || first === 'dry') return wp
  let best = null
  for (let r = 2; r <= 12 && !best; r += 2) {
    for (let dx = -r; dx <= r; dx += 2) {
      for (let dz = -r; dz <= r; dz += 2) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue
        const p = { x: wp.x + dx, z: wp.z + dz }
        if (columnTop(bot, p.x, p.z, top) !== 'dry') continue
        const d = Math.hypot(dx, dz)
        if (!best || d < best.d) best = { ...p, d }
      }
    }
  }
  return best ? { x: best.x, z: best.z } : null
}

function stopPathfinder (bot) {
  try { bot.pathfinder.setGoal(null) } catch {}
  try { bot.clearControlStates() } catch {}
}

/** one pathfinder.goto bounded by `ms`, the signal and a no-progress watchdog */
function runOnce (bot, goal, { ms, signal, stuckMs, noProgressMs = 30000 }) {
  return new Promise((resolve, reject) => {
    let done = false
    let lastPos = bot.entity.position.clone()
    let lastMove = Date.now()
    // progress towards the goal: moving around (swimming in place, a path that keeps resetting) is not progress
    const center = goalCenter(goal)
    const distance = () => center ? bot.entity.position.distanceTo(center) : 0
    let best = distance()
    let lastProgress = Date.now()
    const finish = (err) => {
      if (done) return
      done = true
      clearTimeout(timer)
      clearInterval(watch)
      signal?.removeEventListener('abort', onAbort)
      if (err) reject(err)
      else resolve()
    }
    const onAbort = () => { stopPathfinder(bot); finish(new SkillError('aborted', { code: 'ABORTED' })) }
    const timer = setTimeout(() => { stopPathfinder(bot); finish(Object.assign(new Error(`pathfinder did not finish within ${ms} ms`), { name: 'GotoTimeout' })) }, ms)
    const watch = setInterval(() => {
      const pos = bot.entity.position
      const busy = bot.pathfinder.isMining?.() || bot.pathfinder.isBuilding?.()
      if (pos.distanceTo(lastPos) > 0.5) {
        lastPos = pos.clone()
        lastMove = Date.now()
      } else if (Date.now() - lastMove > (busy ? Math.max(stuckMs, 25000) : stuckMs)) {
        stopPathfinder(bot)
        finish(Object.assign(new SkillError(`stuck at ${fmt(pos)}`, { code: 'STUCK' }), { name: 'Stuck' }))
        return
      }
      if (center) {
        const d = distance()
        if (d < best - 1) { best = d; lastProgress = Date.now() } else if (Date.now() - lastProgress > noProgressMs) {
          stopPathfinder(bot)
          finish(Object.assign(new SkillError(`no progress towards ${fmt(center)} for ${noProgressMs / 1000} s (at ${fmt(pos)})`, { code: 'STUCK' }), { name: 'Stuck' }))
        }
      }
    }, 500)
    signal?.addEventListener('abort', onAbort, { once: true })
    bot.pathfinder.goto(goal).then(() => finish(), (err) => finish(err))
  })
}

/**
 * Get out of a spot pathfinder cannot leave: jump out of liquids, dig out of a 1×1 hole / a block at the head, else
 * step sideways. Best effort; never throws except on abort.
 */
async function unstick (bot, { signal, toward } = {}) {
  progress(bot, 'unstick', { at: fmt(bot.entity.position) })
  const pos = bot.entity.position.floored()
  // a closed door right next to the bot (its own house): open it and walk through (when that leads towards the goal)
  if (await throughDoor(bot, pos, signal, toward)) return
  const head = bot.blockAt(pos.offset(0, 1, 0))
  // something solid in the head cell (a placed block, gravel): dig it
  if (head && !world.isPassable(head) && world.safeToDig(bot, head.position) && bot.canDigBlock(head)) {
    await digSafe(bot, head, signal)
    return
  }
  const dirs = world.HORIZONTAL.slice()
  if (toward) {
    const d = world.cardinalTowards(pos, toward)
    dirs.sort((a, b) => (b.equals(d) ? 1 : 0) - (a.equals(d) ? 1 : 0))
  }
  // in water at a shore (land one block up): swim-jump onto it, towards the goal first — pathfinder's move out of the
  // water stalls there at times (the bot stays put, the search keeps restarting)
  if (world.isWater(bot.blockAt(pos))) {
    for (const d of dirs) {
      // the nearest dry cell 1–3 blocks along d, up to two above the feet (swimming up a submerged bank on the way)
      let landing = null
      for (let k = 1; k <= 3 && !landing; k++) {
        const c = pos.plus(d.scaled(k))
        landing = [c, c.offset(0, 1, 0), c.offset(0, 2, 0)].find((p) => world.standable(bot, p) && !world.isWater(bot.blockAt(p))) ?? null
      }
      if (landing && await climbOnto(bot, landing, signal)) return
    }
  }
  // walled in: open the side towards the goal (or any safe side) at feet + head height
  for (const d of dirs) {
    const feet = pos.plus(d)
    const cells = [feet.offset(0, 1, 0), feet]
    if (!cells.every((c) => world.safeToDig(bot, c))) continue
    if (!world.isSolid(bot.blockAt(feet.offset(0, -1, 0))) && !world.isSolid(bot.blockAt(feet.offset(0, -2, 0)))) continue
    for (const c of cells) {
      const b = bot.blockAt(c)
      if (b && !world.isPassable(b)) await digSafe(bot, b, signal)
    }
    await stepTo(bot, feet, signal)
    return
  }
  // last resort: jump in place a few ticks
  bot.setControlState('jump', true)
  await waitTicks(bot, 10, signal).finally(() => bot.setControlState('jump', false))
}

/** out of the water onto the land cell `landing` (feet) close by: forward + jump (3 s at most); whether it worked */
async function climbOnto (bot, landing, signal) {
  const target = landing.offset(0.5, 0, 0.5)
  try {
    for (let i = 0; i < 60; i++) {
      checkAbort(signal)
      const here = bot.entity.position
      if (here.y >= landing.y - 0.01 && Math.hypot(here.x - target.x, here.z - target.z) < 0.5 && bot.entity.onGround) break
      await bot.lookAt(target.offset(0, bot.entity.eyeHeight ?? 1.62, 0), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', true)
      await waitTicks(bot, 1, signal)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
  const ok = bot.entity.position.floored().equals(landing)
  log(bot, ok ? `unstick: climbed out of the water onto ${fmt(landing)}` : `unstick: could not climb out of the water onto ${fmt(landing)}`)
  return ok
}

/** a wooden door / fence gate beside the feet: open it if closed, step into it and out the other side */
async function throughDoor (bot, pos, signal, toward) {
  for (const d of world.HORIZONTAL) {
    const cell = pos.plus(d)
    const door = bot.blockAt(cell)
    if (!door || !isDoorName(door.name)) continue
    const beyond = cell.plus(d)
    const landing = [beyond, beyond.offset(0, -1, 0)].find((c) => world.standable(bot, c))
    if (!landing) continue
    if (toward && world.distXZ(landing, toward) >= world.distXZ(pos, toward)) continue // leads away from the goal
    try {
      if (!door.getProperties?.().open_bit) await bot.activateBlock(door)
      await waitTicks(bot, 5, signal)
      if (!(await stepTo(bot, cell, signal, { ticks: 25 })) || !(await stepTo(bot, landing, signal, { ticks: 25 }))) {
        log(bot, `unstick: could not get through the ${door.name} at ${fmt(cell)}`)
        continue
      }
      log(bot, `unstick: went through the ${door.name} at ${fmt(cell)}`)
      return true
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `unstick: door at ${fmt(cell)}: ${err.message}`)
    }
  }
  return false
}

/** hand-openable doors and fence gates (never iron ones) */
function isDoorName (name) {
  return !name.includes('iron') && !name.endsWith('trapdoor') && (name.endsWith('_door') || name.endsWith('fence_gate'))
}

/** dig `block` with the best tool (no-op when it is gone) */
async function digSafe (bot, block, signal) {
  checkAbort(signal)
  const current = bot.blockAt(block.position)
  if (!current || world.isPassable(current)) return
  const tool = inventory.bestToolFor(bot, current)
  if (tool) await inventory.equip(bot, tool)
  await bot.dig(current, true)
}

/** walk onto the centre of the cell `pos` (feet) with plain controls (for one-block moves) */
async function stepTo (bot, pos, signal, { ticks = 30, tolerance = 0.25, sneak = false } = {}) {
  const target = pos.offset(0.5, 0, 0.5)
  try {
    if (sneak) bot.setControlState('sneak', true)
    for (let i = 0; i < ticks; i++) {
      checkAbort(signal)
      const here = bot.entity.position
      if (here.floored().equals(pos) && Math.hypot(here.x - target.x, here.z - target.z) < tolerance) break
      await bot.lookAt(target.offset(0, bot.entity.eyeHeight ?? 1.62, 0), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', pos.y > here.y + 0.5 && bot.entity.onGround)
      await waitTicks(bot, 1, signal)
      // close to the centre: let go for a tick so the momentum does not carry the bot past it
      if (Math.hypot(bot.entity.position.x - target.x, bot.entity.position.z - target.z) < tolerance * 2) {
        bot.setControlState('forward', false)
        await waitTicks(bot, 2, signal)
      }
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
    if (sneak) bot.setControlState('sneak', false)
  }
  await waitTicks(bot, 4, signal)
  return bot.entity.position.floored().equals(pos)
}

function fmt (p) {
  return p ? `(${p.x.toFixed(1)}, ${p.y.toFixed(1)}, ${p.z.toFixed(1)})` : '?'
}

/**
 * The goal spec of the navigate skill's args. `spawn: true` is the world spawn (bot.spawnPoint): a column (the bot
 * spawns on its top), so x / z only unless a goal kind is asked for; a height outside the world (BDS's spawn search
 * height y 32767 before the column was loaded) means nothing either: a GoalNear at y 32767 makes pathfinder pillar up
 * with every block the bot carries.
 * @returns {{ position: object, goal: string|undefined, range: number|undefined }}
 */
function targetSpec (bot, args) {
  const position = args.spawn ? bot.spawnPoint : args.position
  if (!position) throw new SkillError('navigate needs args.position (or spawn: true)', { code: 'FAILED' })
  const minY = bot.game?.minY ?? -64
  const maxY = minY + (bot.game?.height ?? 384)
  const xzOnly = (args.spawn && !args.goal) || !(position.y >= minY && position.y < maxY)
  return { position, goal: xzOnly ? 'xz' : args.goal, range: xzOnly ? Math.max(args.range ?? 1, 2) : args.range }
}

const navigate = defineSkill('navigate', async (bot, args) => {
  const goal = goalFor({ ...args, ...targetSpec(bot, args) }, bot)
  // a walk somewhere far (back to the spawn): a pit / a lake shore on the way is escaped from as a last resort
  const r = await goto(bot, goal, { timeout: args.timeout ?? 120000, signal: args.signal, escape: args.escape ?? true })
  const p = bot.entity.position
  return { reached: true, position: { x: p.x, y: p.y, z: p.z }, ms: r.ms }
}, { description: 'walk to a position with mineflayer-pathfinder (re-plans, unsticks)' })

module.exports = Object.assign(navigate, { goto, travel, throughDoor, isDoorName, movements, goalFor, ensurePathfinder, unstick, digSafe, stepTo, stopPathfinder, fmt, dryNear, columnTop, targetSpec })
