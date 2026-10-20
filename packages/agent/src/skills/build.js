// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Build a structure from a blueprint (src/blueprint.js): pick a flat site, obtain the materials (obtain skill),
 * clear the volume, place every block in the compiled order (`bot.placeBlock` against a solid neighbour face, walking
 * to a spot within reach with pathfinder's GoalPlaceBlock), then verify the structure block by block with
 * `bot.blockAt` and repair what is wrong: up to 3 rounds (within `repairMs`) that dig out wrong blocks, obtain the
 * materials of the missing ones again when short, and place every missing block again — after a refusal from another
 * spot (never touching the cell), against another face, once no mob stands in the cell. Only then does it fail.
 *
 * Skill `build` — args: { blueprint: 'house5x5' | object, origin?: {x,y,z}, obtain?: true, radius?: 24, repairMs?: 180000 }
 *                 result: { blueprint, origin, placed, verified, checked, mismatches, repairs, ms }
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, agentOf, waitTicks, heartbeat, withoutMeals } = require('../skill')
const { compile, verify, BLUEPRINTS } = require('../blueprint')
const world = require('../world')
const inventory = require('../inventory')
const knowledge = require('../knowledge')
const planner = require('../planner')
const navigate = require('./navigate')

const goals = () => require('mineflayer-pathfinder').goals
const FACE_ORDER = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]

/** plants and the like that a placed block replaces (no need to dig them first); flowers, saplings, torches are not */
const REPLACEABLE = new Set(['short_grass', 'tall_grass', 'fern', 'large_fern', 'deadbush', 'dead_bush', 'vine', 'snow_layer', 'fire', 'soul_fire', 'seagrass', 'tall_seagrass', 'glow_lichen', 'hanging_roots', 'leaf_litter', 'short_dry_grass', 'tall_dry_grass', 'bush', 'structure_void'])
const replaceable = (b) => !!b && (world.isAir(b) || world.isLiquid(b) || REPLACEABLE.has(b.name))
/** entities that never stand in the way of a placement */
const NON_BLOCKING = /^(item|xp_orb|xp_bottle|arrow|thrown_trident|snowball|egg|ender_pearl|fireball|small_fireball|dragon_fireball|wither_skull.*|splash_potion|lingering_potion|fishing_hook|lightning_bolt|area_effect_cloud|eye_of_ender_signal|fireworks_rocket|wind_charge_projectile|breeze_wind_charge_projectile|evocation_fang|shulker_bullet|llama_spit|painting|leash_knot)$/
/** animals that a hit sends out of the cell (they flee; anything else is waited for) */
const SHOOABLE = new Set(['sheep', 'cow', 'mooshroom', 'pig', 'chicken', 'rabbit'])

/**
 * A site for `size` (x, y, z) near the bot: ground as flat as possible, nothing much to clear, no liquid.
 * @returns {Vec3|null} origin (north-west corner of the bottom layer, on the ground)
 */
function findSite (bot, size, { radius = 24, avoid = () => false } = {}) {
  const here = bot.entity.position.floored()
  const heights = new Map()
  const groundAt = (x, z) => {
    const k = `${x},${z}`
    if (!heights.has(k)) heights.set(k, world.surfaceY(bot, x, z, { top: here.y + 12, bottom: here.y - 12 }))
    return heights.get(k)
  }
  let best = null
  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const x0 = here.x + dx
      const z0 = here.z + dz
      const hs = []
      let bad = false
      for (let x = x0; x < x0 + size.x && !bad; x++) {
        for (let z = z0; z < z0 + size.z && !bad; z++) {
          const h = groundAt(x, z)
          if (h === null) { bad = true; break }
          const below = bot.blockAt(new Vec3(x, h - 1, z))
          if (!below || world.isLiquid(below) || world.isLiquid(bot.blockAt(new Vec3(x, h, z)))) bad = true
          hs.push(h)
        }
      }
      if (bad) continue
      // the floor level costing the least: a dip (ground lower than the floor) costs far more than a bump (dug away)
      let y0 = null
      let cost = Infinity
      for (let y = Math.min(...hs); y <= Math.max(...hs); y++) {
        if (hs.some((h) => Math.abs(h - y) > 1)) continue
        const c = hs.reduce((s, h) => s + (h < y ? 12 : h > y ? 2 : 0), 0)
        if (c < cost) { cost = c; y0 = y }
      }
      if (y0 === null) continue
      const origin = new Vec3(x0, y0, z0)
      if (avoid(origin)) continue
      // things in the volume to dig (trees, tall plants are passable and cheap)
      for (let x = x0; x < x0 + size.x; x++) {
        for (let z = z0; z < z0 + size.z; z++) {
          for (let y = y0; y < y0 + size.y + 1; y++) {
            const b = bot.blockAt(new Vec3(x, y, z))
            if (!b) { cost += 50; continue }
            if (!world.isPassable(b)) cost += /_log$/.test(b.name) ? 6 : 2
            if (world.isLiquid(b)) cost += 100
          }
        }
      }
      cost += Math.hypot(dx, dz) * 0.3
      if (!best || cost < best.cost) best = { origin, cost }
    }
  }
  return best?.origin ?? null
}

/** the carried stack to place for `names` (the most abundant), or null */
function stackFor (bot, names) {
  let best = null
  for (const n of names) {
    const item = inventory.find(bot, n)
    if (item && (!best || inventory.count(bot, n) > inventory.count(bot, best.name))) best = item
  }
  return best
}

/**
 * Make sure the bot carries `count` blocks of any of `names` (the cheapest alternative is obtained).
 */
async function obtainAny (bot, names, count, { signal }) {
  const have = names.reduce((s, n) => s + inventory.count(bot, n), 0)
  if (have >= count) return
  const { obtain } = require('./obtain')
  const missing = count - have
  let choice = names[0]
  if (names.length > 1) {
    const model = knowledge.worldModel(bot)
    let bestCost = Infinity
    for (const n of names) {
      const p = planner.plan({ item: n, count: inventory.count(bot, n) + missing }, model)
      if (p.ok && p.cost < bestCost) { bestCost = p.cost; choice = n }
    }
  }
  log(bot, `build: need ${missing} more of ${names.join('/')} → obtain ${choice}`)
  await obtain(bot, { item: choice, count: inventory.count(bot, choice) + missing, signal })
}

/** Movements for building: never dig a blueprint cell, never put scaffolding inside the structure */
const buildMoves = new WeakMap()
function buildMovements (bot, compiled) {
  if (buildMoves.has(compiled)) return buildMoves.get(compiled)
  const { min, max } = compiled.bounds
  const inside = (p) => p.x >= min.x && p.x <= max.x && p.y >= min.y && p.y <= max.y + 1 && p.z >= min.z && p.z <= max.z
  // never scaffold with the blueprint's own materials
  const materials = new Set(compiled.materials.flatMap((m) => m.names))
  const scaffold = inventory.FILLER.filter((n) => !materials.has(n)).map((n) => bot.registry.itemsByName[n]?.id).filter((id) => id !== undefined)
  const moves = navigate.movements(bot, {
    exclusionAreasBreak: [(block) => inside(block.position) ? 1000 : 0],
    exclusionAreasPlace: [(block) => inside(block.position) ? 1000 : 0],
    allow1by1towers: false,
    scafoldingBlocks: scaffold
  })
  buildMoves.set(compiled, moves)
  return moves
}

/**
 * In a dip under the floor level inside the footprint (floor blocks all around, too high to jump out, and the build
 * movements may neither dig nor scaffold there): pillar one block up, which fills the dip with a filler block.
 */
async function outOfDip (bot, compiled, signal) {
  const feet = bot.entity.position
  // half a block of margin: a dirt path / farmland / slab at floor level is no dip
  if (!insideFootprint(compiled, feet) || feet.y >= compiled.bounds.min.y - 0.5) return
  const survive = require('./survive')
  const exclude = compiled.materials.flatMap((m) => m.names)
  log(bot, `build: in a dip under the floor at ${navigate.fmt(feet)}; pillaring out`)
  for (let i = 0; i < 3 && bot.entity.position.y < compiled.bounds.min.y - 0.5; i++) {
    await survive.pillarStep(bot, signal, { exclude }).catch((err) => { if (isAbort(err)) throw err; log(bot, `build: ${err.message}`) })
  }
}

/** whether a position (feet) is within the structure's x/z footprint */
function insideFootprint (compiled, p) {
  const { min, max } = compiled.bounds
  return p.x >= min.x && p.x < max.x + 1 && p.z >= min.z && p.z < max.z + 1
}

/** the outward direction (unit, dominant axis) of the wall a door sits in */
function outward (compiled, pos) {
  const { min, max } = compiled.bounds
  const dx = pos.x + 0.5 - (min.x + max.x + 1) / 2
  const dz = pos.z + 0.5 - (min.z + max.z + 1) / 2
  return Math.abs(dx) >= Math.abs(dz) ? new Vec3(Math.sign(dx), 0, 0) : new Vec3(0, 0, Math.sign(dz))
}

/** in front of the door at `pos`: outside the footprint, on the door's side (Bedrock turns a door by the yaw) */
function inFrontOf (compiled, pos, p) {
  const dir = outward(compiled, pos)
  const ahead = (p.x - (pos.x + 0.5)) * dir.x + (p.z - (pos.z + 0.5)) * dir.z
  const aside = Math.abs((p.x - (pos.x + 0.5)) * dir.z) + Math.abs((p.z - (pos.z + 0.5)) * dir.x)
  return !insideFootprint(compiled, p) && ahead >= 0.5 && aside <= ahead + 0.5
}

/** a pathfinder goal: any node in front of the door at `pos` */
function frontGoal (compiled, pos) {
  return {
    heuristic: () => 0,
    isEnd: (node) => inFrontOf(compiled, pos, { x: node.x + 0.5, z: node.z + 0.5 }),
    hasChanged: () => false,
    isValid: () => true
  }
}

/**
 * Inside the finished structure (a repair pass, a fight): open the door and step out of it (pathfinder's door
 * opening is not relied on for the bot's own fresh door).
 */
async function leave (bot, compiled, { signal }) {
  const { min, max } = compiled.bounds
  const p = bot.entity.position
  // the interior only (on the roof or under the floor is not "inside")
  if (!insideFootprint(compiled, p) || p.y < min.y + 0.5 || p.y >= max.y) return
  const door = compiled.placements.find((pl) => pl.tall)
  if (!door || !door.names.includes(bot.blockAt(door.pos)?.name)) return
  // out through the door: the direction from the footprint centre to the door, on its dominant axis
  const dir = outward(compiled, door.pos)
  const inside = door.pos.minus(dir)
  const outside = door.pos.plus(dir).offset(0, -1, 0) // the ground level outside
  try {
    await navigate.goto(bot, new (goals().GoalBlock)(inside.x, inside.y, inside.z), { signal, timeout: 20000, attempts: 1, movements: buildMovements(bot, compiled) })
    const block = bot.blockAt(door.pos)
    if (block && !block.getProperties?.().open_bit) await bot.activateBlock(block)
    await waitTicks(bot, 5, signal)
    const out = (await navigate.stepTo(bot, door.pos, signal, { ticks: 30 })) && (await navigate.stepTo(bot, outside, signal, { ticks: 30 }))
    // shut the door behind (mobs stay out of the finished house)
    const after = bot.blockAt(door.pos)
    if (out && after?.getProperties?.().open_bit) await bot.activateBlock(after).catch(() => {})
    log(bot, out ? `build: left ${compiled.name} through its door` : `build: could not walk out of ${compiled.name}`)
  } catch (err) {
    if (isAbort(err)) throw err
    log(bot, `build: could not leave through the door: ${err.message}`)
  }
}

/**
 * solid neighbour to click for placing at `pos`: { ref, face } (below first), or null. `refused` (refKey → refusals):
 * the face refused least often first — after a refusal the next attempt clicks another face where there is one.
 */
function referenceFor (bot, pos, refused = null) {
  let best = null
  for (const dir of FACE_ORDER) {
    const ref = bot.blockAt(pos.plus(dir))
    if (!ref || !world.isSolid(ref) || /door|chest|crafting_table|furnace/.test(ref.name)) continue
    const r = { ref, face: dir.scaled(-1) }
    if (!refused) return r
    const n = refused.get(refKey(r)) ?? 0
    if (!best || n < best.n) best = { r, n }
  }
  return best?.r ?? null
}

function refKey (r) {
  return `${r.ref.position}|${r.face}`
}

/** whether the entity's bounding box reaches into the cell at `pos` (BDS refuses a block there), `margin` around it */
function inCell (e, pos, margin = 0) {
  const w = (e.width ?? 0.6) / 2 + margin
  const h = e.height ?? 1.8
  const p = e.position
  return p.x + w > pos.x && p.x - w < pos.x + 1 && p.z + w > pos.z && p.z - w < pos.z + 1 && p.y + h > pos.y - margin && p.y < pos.y + 1 + margin
}

/** mobs, players, vehicles in the cell `pos` (not the bot; items, orbs and projectiles do not block a placement) */
function entitiesIn (bot, pos) {
  return Object.values(bot.entities ?? {}).filter((e) => e && e !== bot.entity && e.position && !NON_BLOCKING.test(e.name ?? '') && inCell(e, pos, 0.05))
}

/**
 * Wait (≤ 10 s) until no mob stands in the cell `pos`; an animal in it is hit now and then (it flees). Whether the cell
 * is clear.
 */
async function clearOfMobs (bot, pos, signal) {
  for (let i = 0; i < 40; i++) {
    const mobs = entitiesIn(bot, pos)
    if (!mobs.length) return true
    const m = mobs[0]
    if (i === 0) log(bot, `build: a ${m.name} stands in ${navigate.fmt(pos)}: waiting for it to move`)
    if (SHOOABLE.has(m.name) && i % 8 === 0 && m.position.distanceTo(bot.entity.position) < 3.5) {
      try {
        await bot.lookAt(m.position.offset(0, (m.height ?? 1) / 2, 0), true)
        bot.attack(m)
      } catch {}
    }
    await waitTicks(bot, 5, signal)
  }
  return !entitiesIn(bot, pos).length
}

/** the feet cell `feet` is within a block of the cell `pos` (a hitbox there could touch it) */
function nextToCell (feet, pos) {
  return Math.abs(feet.x - pos.x) <= 1 && Math.abs(feet.z - pos.z) <= 1 && (feet.y === pos.y || feet.y === pos.y - 1)
}

/** a pathfinder goal: a node a block away from the cell `pos` (its hitbox never touches it), none of `spots` */
function awayGoal (pos, spots) {
  return {
    heuristic: () => 0,
    isEnd: (node) => !nextToCell(node, pos) && !spots.some((s) => s.x === node.x && s.y === node.y && s.z === node.z),
    hasChanged: () => false,
    isValid: () => true
  }
}

/** dig a block out of the structure's volume (in reach first; a flower too — no plant a placed block replaces) */
async function digOut (bot, block, compiled, signal) {
  checkAbort(signal)
  if (!bot.canDigBlock(block)) {
    // GoalLookAtBlock needs a block with a shape to look at (a raycast): a plant / flower is walked near instead
    const g = goals()
    const p = block.position
    const goal = world.isSolid(block) ? new g.GoalLookAtBlock(p, bot.world, { reach: 4 }) : new g.GoalNear(p.x, p.y, p.z, 2)
    await navigate.goto(bot, goal, { signal, timeout: 30000, attempts: 2, movements: buildMovements(bot, compiled) })
  }
  const current = bot.blockAt(block.position)
  if (!current || replaceable(current) || !current.diggable) return
  await navigate.digSafe(bot, current, signal, { passable: true })
  heartbeat(bot)
}

/**
 * the bot's eyes are within `range` of the reference face, and the bot does not stand in the target cells — nor touch
 * them (0.05 around the hitbox: BDS refuses a block whose cell only touches the bot's server-side hitbox)
 */
function inPlaceRange (bot, pos, ref, face, tall, range = 4.3) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const faceCenter = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  if (eye.distanceTo(faceCenter) > range) return false
  for (let dy = 0; dy < (tall ? 2 : 1); dy++) {
    if (inCell({ position: bot.entity.position, width: 0.6, height: 1.8 }, pos.offset(0, dy, 0), 0.05)) return false
  }
  return true
}

/**
 * Place one blueprint cell (walks into range first); returns true when the block is there. After a refusal the next
 * attempt clicks the face refused least (another one where there is one) from another spot, a block away from the
 * cell (BDS refuses a block that touches the player's server-side hitbox), and waits a little longer; a mob standing in
 * the cell is waited for (an animal is hit, it flees).
 */
async function placeCell (bot, placement, compiled, { signal, attempts = 4 } = {}) {
  const { pos, names, tall } = placement
  const refused = new Map() // refKey → refusals
  const spots = [] // the bot's feet cells at the refusals
  for (let attempt = 0; attempt < attempts; attempt++) {
    checkAbort(signal)
    await agentOf(bot)?.safety?.idle(signal)
    await outOfDip(bot, compiled, signal)
    const current = bot.blockAt(pos)
    if (current && names.includes(current.name)) return true
    if (current && !replaceable(current)) {
      // something else is in the way (a mob-placed block, gravel, scaffolding, a flower): dig it
      await digOut(bot, current, compiled, signal).catch((err) => { if (isAbort(err)) throw err; log(bot, `build: dig ${current.name} at ${navigate.fmt(pos)}: ${err.message}`) })
      continue
    }
    const stack = stackFor(bot, names)
    if (!stack) throw new SkillError(`out of ${names.join('/')}`, { code: 'MISSING' })
    const r = referenceFor(bot, pos, refused)
    if (!r) throw new SkillError(`nothing to place ${names[0]} against at ${navigate.fmt(pos)}`, { code: 'FAILED' })
    // a door is placed from outside the footprint: the bot must not lock itself in
    const outsideNeeded = tall && !inFrontOf(compiled, pos, bot.entity.position)
    // after a refusal: from another spot, a block away from the cell
    const feet = bot.entity.position.floored()
    const elsewhere = spots.length > 0 && (nextToCell(feet, pos) || spots.some((s) => s.equals(feet)))
    if (!inPlaceRange(bot, pos, r.ref, r.face, tall) || outsideNeeded || elsewhere) {
      // within reach of the face, and never standing in (or overlapping) the cell itself
      const g = goals()
      const goal = new g.GoalCompositeAll([
        new g.GoalPlaceBlock(pos, bot.world, { range: 4, LOS: false, ...(spots.length ? { faces: [r.face.scaled(-1)] } : {}) }),
        new g.GoalInvert(new g.GoalNear(pos.x, pos.y, pos.z, 1.1)),
        ...(tall ? [new g.GoalInvert(new g.GoalNear(pos.x, pos.y + 1, pos.z, 1.1)), frontGoal(compiled, pos)] : []),
        ...(spots.length ? [awayGoal(pos, spots)] : [])
      ])
      try {
        await navigate.goto(bot, goal, { signal, timeout: 45000, attempts: 2, movements: buildMovements(bot, compiled) })
      } catch (err) {
        if (isAbort(err)) throw err
        log(bot, `build: no spot to place ${navigate.fmt(pos)} from: ${err.message}`)
      }
      if (!inPlaceRange(bot, pos, r.ref, r.face, tall, 5) || (tall && !inFrontOf(compiled, pos, bot.entity.position))) {
        log(bot, `build: still out of range / in the way of ${navigate.fmt(pos)} at ${navigate.fmt(bot.entity.position)}`)
        continue
      }
      // no other spot reached: from a refused spot (or touching the cell) only with a face not refused yet
      const at = bot.entity.position.floored()
      if (spots.length && (nextToCell(at, pos) || spots.some((s) => s.equals(at))) && (refused.get(refKey(r)) ?? 0) > 0) {
        log(bot, `build: no other spot to place ${navigate.fmt(pos)} from than ${navigate.fmt(bot.entity.position)}`)
        await waitTicks(bot, 10, signal)
        continue
      }
    }
    // a mob in the cell: BDS would refuse the block (not the face's or the spot's fault)
    if (!await clearOfMobs(bot, pos, signal)) continue
    try {
      await agentOf(bot)?.safety?.idle(signal)
      await withoutMeals(bot, async () => {
        await inventory.equip(bot, stack)
        await bot.placeBlock(r.ref, r.face)
      })
      heartbeat(bot) // work done (the stuck watchdog)
    } catch (err) {
      if (isAbort(err)) throw err
      // refused, or never answered: another face / spot next time
      if (/refused|did not answer|did not fire|timed? ?out/i.test(err.message)) {
        refused.set(refKey(r), (refused.get(refKey(r)) ?? 0) + 1)
        spots.push(bot.entity.position.floored())
      }
      log(bot, `build: place ${stack.name} at ${navigate.fmt(pos)} against ${navigate.fmt(r.ref.position)} from ${navigate.fmt(bot.entity.position)}: ${err.message}`)
      await waitTicks(bot, 4 + 4 * Math.min(spots.length, 4), signal)
    }
  }
  const b = bot.blockAt(pos)
  return !!b && names.includes(b.name)
}

/** dig everything in the volume that is neither the planned block nor air */
async function clearVolume (bot, compiled, { signal }) {
  const want = new Map(compiled.checks.map((c) => [`${c.pos.x},${c.pos.y},${c.pos.z}`, c.names]))
  const cells = []
  const { min, max } = compiled.bounds
  for (let y = max.y + 1; y >= min.y; y--) {
    for (let x = min.x; x <= max.x; x++) {
      for (let z = min.z; z <= max.z; z++) cells.push(new Vec3(x, y, z))
    }
  }
  let dug = 0
  for (const p of cells) {
    checkAbort(signal)
    const b = bot.blockAt(p)
    // plants a placed block replaces are left (verify takes them for air; GoalLookAtBlock never ends at one: no shape)
    if (!b || replaceable(b)) continue
    const names = want.get(`${p.x},${p.y},${p.z}`)
    if (names?.includes(b.name)) continue
    if (!b.diggable) continue
    try {
      await digOut(bot, b, compiled, signal)
      dug++
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `build: could not clear ${b.name} at ${navigate.fmt(p)}: ${err.message}`)
    }
  }
  return dug
}

async function build (bot, args) {
  const { signal } = args
  const started = Date.now()
  const bp = typeof args.blueprint === 'string' ? BLUEPRINTS[args.blueprint] : args.blueprint
  if (!bp) throw new SkillError(`unknown blueprint ${args.blueprint}`, { code: 'FAILED' })
  const probe = compile(bp, { x: 0, y: 0, z: 0 })
  const agent = agentOf(bot)
  const home = args.origin ? new Vec3(args.origin.x, args.origin.y, args.origin.z) : bot.entity.position.floored()
  // a site given up front is protected right away (obtaining materials must not dig its ground)
  const early = args.origin ? compile(bp, home) : null
  const zone = early ? { name: early.name, min: early.bounds.min, max: early.bounds.max } : null
  if (agent && zone) agent.state.protectedZones.push(zone)

  // 1. materials first (the site is picked afterwards, so no station placed while crafting ends up inside it)
  if (args.obtain !== false) {
    // crafted pieces (chest, door, table) first: crafting them eats planks the roof needs; then re-check everything
    const order = probe.materials.slice().sort((a, b) => a.count - b.count)
    const short = () => order.filter((m) => m.names.reduce((n, name) => n + inventory.count(bot, name), 0) < m.count)
    for (let pass = 0; pass < 3 && short().length; pass++) {
      for (const m of order) await obtainAny(bot, m.names, m.count, { signal })
    }
    if (short().length) throw new SkillError(`materials still missing: ${short().map((m) => m.item).join(', ')}`, { code: 'MISSING' })
  }
  // 2. back to where the build was asked for (obtaining may have taken the bot far away), pick the site there
  await navigate.goto(bot, new (goals().GoalNear)(home.x, home.y, home.z, 3), { signal, timeout: 180000 })
  let origin = args.origin ? home : null
  if (!origin) {
    origin = findSite(bot, probe.size, { radius: args.radius ?? 24 })
    if (!origin) throw new SkillError(`no site for ${bp.name} within ${args.radius ?? 24} blocks`, { code: 'NOT_FOUND' })
  }
  const compiled = compile(bp, origin)
  progress(bot, 'build-site', { blueprint: compiled.name, origin: { x: origin.x, y: origin.y, z: origin.z } })
  // our structure is off limits for every later dig (mine / gather / pathfinder through the Agent's movements)
  if (agent && !zone) agent.state.protectedZones.push({ name: compiled.name, min: compiled.bounds.min, max: compiled.bounds.max })

  // 3. clear the volume, fill dips under the floor, place, verify
  const cleared = await clearVolume(bot, compiled, { signal })
  await fillUnder(bot, compiled, { signal })
  let placed = 0
  const placeAll = async () => {
    for (const p of compiled.placements) {
      const before = bot.blockAt(p.pos)
      if (before && p.names.includes(before.name)) continue
      try {
        if (await placeCell(bot, p, compiled, { signal })) placed++
        else log(bot, `build: ${p.names[0]} at ${navigate.fmt(p.pos)} not placed`)
      } catch (err) {
        if (isAbort(err) || err.code === 'MISSING' || err.code === 'DIED') throw err
        log(bot, `build: ${p.names[0]} at ${navigate.fmt(p.pos)}: ${err.message}`)
      }
    }
  }
  await placeAll()
  let v = verify(compiled, (pos) => bot.blockAt(pos))
  // repair: block by block, until the structure verifies (≤ 3 rounds, within repairMs)
  const repairs = []
  const repairUntil = Date.now() + (args.repairMs ?? 180000)
  for (let round = 1; !v.ok && round <= 3 && Date.now() < repairUntil; round++) {
    log(bot, `build: ${v.mismatches.length} mismatch(es), repair round ${round}: ${v.mismatches.map((m) => `${m.actual ?? '?'} for ${m.expected[0]} at ${navigate.fmt(m.pos)}`).join(', ')}`)
    await repair(bot, compiled, v.mismatches, { signal, round, deadline: repairUntil })
    v = verify(compiled, (pos) => bot.blockAt(pos))
    repairs.push(v.mismatches.length)
  }
  progress(bot, 'build-verified', { ok: v.ok, checked: v.checked, mismatches: v.mismatches.length, repairs })
  // a house (a structure with a door): the Agent's shelter for the night when it has no bed (skills/rest.js)
  const door = compiled.placements.find((pl) => pl.tall)
  if (agent && v.ok && door) {
    const inside = door.pos.minus(outward(compiled, door.pos))
    agent.state.home = { name: compiled.name, door: { x: door.pos.x, y: door.pos.y, z: door.pos.z }, inside: { x: inside.x, y: inside.y, z: inside.z } }
  }
  await leave(bot, compiled, { signal })
  const result = {
    blueprint: compiled.name,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    placed,
    cleared,
    verified: v.ok,
    checked: v.checked,
    mismatches: v.mismatches.map((m) => ({ pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z }, expected: m.expected, actual: m.actual })),
    repairs,
    ms: Date.now() - started
  }
  if (!v.ok) throw new SkillError(`${compiled.name}: ${v.mismatches.length} block(s) wrong after ${repairs.length} repair round(s): ${result.mismatches.map((m) => `${m.actual ?? '?'} for ${m.expected[0]} at (${m.pos.x}, ${m.pos.y}, ${m.pos.z})`).join(', ')}`, { code: 'FAILED', details: result })
  return result
}

/**
 * One repair round after a verification found `mismatches`: wrong blocks dug out (the volume cleared again), the
 * materials of the missing blocks obtained again when the bot is short of them, then every missing block placed again
 * (more attempts each round: other spots, other faces). A door's upper half is repaired through its door.
 */
async function repair (bot, compiled, mismatches, { signal, round = 1, deadline = Infinity }) {
  await clearVolume(bot, compiled, { signal })
  const wanted = compiled.placements.filter((p) => mismatches.some((m) => m.pos.equals(p.pos) || (p.tall && m.pos.equals(p.pos.offset(0, 1, 0)))))
  const isThere = (p) => p.names.includes(bot.blockAt(p.pos)?.name) && (!p.tall || p.names.includes(bot.blockAt(p.pos.offset(0, 1, 0))?.name))
  // a door whose upper half is wrong: out with it, it is placed again whole
  for (const p of wanted) {
    if (!p.tall || isThere(p) || !p.names.includes(bot.blockAt(p.pos)?.name)) continue
    await digOut(bot, bot.blockAt(p.pos), compiled, signal).catch((err) => { if (isAbort(err)) throw err; log(bot, `build: repair: dig the door at ${navigate.fmt(p.pos)}: ${err.message}`) })
  }
  const missing = wanted.filter((p) => !isThere(p))
  // materials: the missing blocks of each kind, obtained again when short (a lost stack, a death, blocks used up)
  const kinds = new Map()
  for (const p of missing) {
    const k = p.names.join('|')
    if (!kinds.has(k)) kinds.set(k, { names: p.names, count: 0 })
    kinds.get(k).count++
  }
  for (const { names, count } of kinds.values()) {
    try {
      await obtainAny(bot, names, count, { signal })
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      log(bot, `build: repair: could not obtain ${names[0]}: ${err.message}`)
    }
  }
  for (const p of missing) {
    if (Date.now() > deadline) break
    try {
      if (await placeCell(bot, p, compiled, { signal, attempts: 4 + 2 * round })) continue
      log(bot, `build: repair: ${p.names[0]} at ${navigate.fmt(p.pos)} not placed`)
    } catch (err) {
      if (isAbort(err) || err.code === 'DIED') throw err
      log(bot, `build: repair: ${p.names[0]} at ${navigate.fmt(p.pos)}: ${err.message}`)
    }
  }
}

/** a filler block under every bottom-layer cell that has none (dips in the ground), so the floor has support */
async function fillUnder (bot, compiled, { signal }) {
  const bottom = compiled.placements.filter((p) => p.rel.y === 0)
  const materials = new Set(compiled.materials.flatMap((m) => m.names))
  const fillers = inventory.FILLER.filter((n) => !materials.has(n))
  for (const p of bottom) {
    const below = p.pos.offset(0, -1, 0)
    if (world.isSolid(bot.blockAt(below))) continue
    if (!fillers.some((n) => inventory.count(bot, n) > 0)) {
      log(bot, 'build: no filler blocks for the dips under the floor')
      return
    }
    try {
      await placeCell(bot, { pos: below, names: fillers, item: fillers[0], tall: false }, compiled, { signal })
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `build: could not fill ${navigate.fmt(below)}: ${err.message}`)
    }
  }
}

const skill = defineSkill('build', build, { description: 'build a blueprint (materials obtained, verified block by block)' })

module.exports = Object.assign(skill, { build, findSite, placeCell, clearVolume, fillUnder, referenceFor, obtainAny, leave, insideFootprint, repair, entitiesIn, inCell, nextToCell, awayGoal, replaceable })
