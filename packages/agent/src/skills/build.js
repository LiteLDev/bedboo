// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Build a structure from a blueprint (src/blueprint.js): pick a flat site, obtain the materials (obtain skill),
 * clear the volume, place every block in the compiled order (`bot.placeBlock` against a solid neighbour face, walking
 * to a spot within reach with pathfinder's GoalPlaceBlock), then verify the structure block by block with
 * `bot.blockAt` (one repair pass for mismatches).
 *
 * Skill `build` — args: { blueprint: 'house5x5' | object, origin?: {x,y,z}, obtain?: true, radius?: 24 }
 *                 result: { blueprint, origin, placed, verified, checked, mismatches, ms }
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, agentOf, waitTicks } = require('../skill')
const { compile, verify, BLUEPRINTS } = require('../blueprint')
const world = require('../world')
const inventory = require('../inventory')
const knowledge = require('../knowledge')
const planner = require('../planner')
const navigate = require('./navigate')

const goals = () => require('mineflayer-pathfinder').goals
const FACE_ORDER = [new Vec3(0, -1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1), new Vec3(0, 1, 0)]

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
      const counts = {}
      for (const h of hs) counts[h] = (counts[h] ?? 0) + 1
      const y0 = Number(Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0])
      if (hs.some((h) => Math.abs(h - y0) > 2)) continue
      const origin = new Vec3(x0, y0, z0)
      if (avoid(origin)) continue
      let cost = hs.reduce((s, h) => s + Math.abs(h - y0) * 2, 0)
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

/** solid neighbour to click for placing at `pos`: { ref, face } (below first), or null */
function referenceFor (bot, pos) {
  for (const dir of FACE_ORDER) {
    const ref = bot.blockAt(pos.plus(dir))
    if (ref && world.isSolid(ref) && !/door|chest|crafting_table|furnace/.test(ref.name)) return { ref, face: dir.scaled(-1) }
  }
  return null
}

/** the bot's eyes are within `range` of the reference face, and the bot does not stand in the target cells */
function inPlaceRange (bot, pos, ref, face, tall, range = 4.3) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
  const faceCenter = ref.position.offset(0.5 + face.x * 0.5, 0.5 + face.y * 0.5, 0.5 + face.z * 0.5)
  if (eye.distanceTo(faceCenter) > range) return false
  const p = bot.entity.position
  for (let dy = 0; dy < (tall ? 2 : 1); dy++) {
    const c = pos.offset(0, dy, 0)
    if (p.x + 0.3 > c.x && p.x - 0.3 < c.x + 1 && p.z + 0.3 > c.z && p.z - 0.3 < c.z + 1 && p.y < c.y + 1 && p.y + 1.8 > c.y) return false
  }
  return true
}

/** place one blueprint cell (walks into range first); returns true when the block is there */
async function placeCell (bot, placement, compiled, { signal }) {
  const { pos, names, tall } = placement
  for (let attempt = 0; attempt < 4; attempt++) {
    checkAbort(signal)
    await agentOf(bot)?.safety?.idle(signal)
    const current = bot.blockAt(pos)
    if (current && names.includes(current.name)) return true
    if (current && !world.isPassable(current)) {
      // something else is in the way (a mob-placed block, gravel, scaffolding): dig it
      await navigate.digSafe(bot, current, signal).catch((err) => { if (isAbort(err)) throw err })
      continue
    }
    const stack = stackFor(bot, names)
    if (!stack) throw new SkillError(`out of ${names.join('/')}`, { code: 'MISSING' })
    const r = referenceFor(bot, pos)
    if (!r) throw new SkillError(`nothing to place ${names[0]} against at ${navigate.fmt(pos)}`, { code: 'FAILED' })
    if (!inPlaceRange(bot, pos, r.ref, r.face, tall)) {
      // within reach of the face, and never standing in (or overlapping) the cell itself
      const g = goals()
      const goal = new g.GoalCompositeAll([
        new g.GoalPlaceBlock(pos, bot.world, { range: 4, LOS: false }),
        new g.GoalInvert(new g.GoalNear(pos.x, pos.y, pos.z, 1.1)),
        ...(tall ? [new g.GoalInvert(new g.GoalNear(pos.x, pos.y + 1, pos.z, 1.1))] : [])
      ])
      try {
        await navigate.goto(bot, goal, { signal, timeout: 45000, attempts: 2, movements: buildMovements(bot, compiled) })
      } catch (err) {
        if (isAbort(err)) throw err
        log(bot, `build: no spot to place ${navigate.fmt(pos)} from: ${err.message}`)
      }
      if (!inPlaceRange(bot, pos, r.ref, r.face, tall, 5)) {
        log(bot, `build: still out of range / in the way of ${navigate.fmt(pos)} at ${navigate.fmt(bot.entity.position)}`)
        continue
      }
    }
    try {
      await agentOf(bot)?.safety?.idle(signal)
      await inventory.equip(bot, stack)
      await bot.placeBlock(r.ref, r.face)
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `build: place ${stack.name} at ${navigate.fmt(pos)}: ${err.message}`)
      await waitTicks(bot, 4, signal)
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
    if (!b || world.isAir(b)) continue
    const names = want.get(`${p.x},${p.y},${p.z}`)
    if (names?.includes(b.name)) continue
    if (world.isLiquid(b) || !b.diggable) continue
    try {
      if (!bot.canDigBlock(b)) await navigate.goto(bot, new (goals().GoalLookAtBlock)(p, bot.world, { reach: 4 }), { signal, timeout: 30000, attempts: 2, movements: buildMovements(bot, compiled) })
      await navigate.digSafe(bot, bot.blockAt(p), signal)
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
  let origin = args.origin ? new Vec3(args.origin.x, args.origin.y, args.origin.z) : null
  if (!origin) {
    origin = findSite(bot, probe.size, { radius: args.radius ?? 24 })
    if (!origin) throw new SkillError(`no site for ${bp.name} within ${args.radius ?? 24} blocks`, { code: 'NOT_FOUND' })
  }
  const compiled = compile(bp, origin)
  progress(bot, 'build-site', { blueprint: compiled.name, origin: { x: origin.x, y: origin.y, z: origin.z } })
  // our structure is off limits for every later dig (mine / gather / pathfinder through the Agent's movements)
  if (agent) agent.state.protectedZones.push({ name: compiled.name, min: compiled.bounds.min, max: compiled.bounds.max })

  if (args.obtain !== false) {
    // crafted pieces (chest, door, table) first: crafting them eats planks the roof needs; then re-check everything
    const order = compiled.materials.slice().sort((a, b) => a.count - b.count)
    const short = () => order.filter((m) => m.names.reduce((n, name) => n + inventory.count(bot, name), 0) < m.count)
    for (let pass = 0; pass < 3 && short().length; pass++) {
      for (const m of order) await obtainAny(bot, m.names, m.count, { signal })
    }
    if (short().length) throw new SkillError(`materials still missing: ${short().map((m) => m.item).join(', ')}`, { code: 'MISSING' })
  }
  // back to the site (obtaining may have taken the bot far away)
  const center = origin.offset(Math.floor(compiled.size.x / 2), 0, compiled.size.z + 1)
  await navigate.goto(bot, new (goals().GoalNear)(center.x, center.y, center.z, 3), { signal, timeout: 180000 })
  const cleared = await clearVolume(bot, compiled, { signal })
  let placed = 0
  for (const p of compiled.placements) {
    const before = bot.blockAt(p.pos)
    if (before && p.names.includes(before.name)) continue
    if (await placeCell(bot, p, compiled, { signal })) placed++
    else log(bot, `build: ${p.names[0]} at ${navigate.fmt(p.pos)} not placed`)
  }
  let v = verify(compiled, (pos) => bot.blockAt(pos))
  if (!v.ok) {
    log(bot, `build: ${v.mismatches.length} mismatch(es), repairing`)
    await clearVolume(bot, compiled, { signal })
    for (const p of compiled.placements) await placeCell(bot, p, compiled, { signal }).catch((err) => { if (isAbort(err)) throw err })
    v = verify(compiled, (pos) => bot.blockAt(pos))
  }
  progress(bot, 'build-verified', { ok: v.ok, checked: v.checked, mismatches: v.mismatches.length })
  const result = {
    blueprint: compiled.name,
    origin: { x: origin.x, y: origin.y, z: origin.z },
    placed,
    cleared,
    verified: v.ok,
    checked: v.checked,
    mismatches: v.mismatches.map((m) => ({ pos: { x: m.pos.x, y: m.pos.y, z: m.pos.z }, expected: m.expected, actual: m.actual })),
    ms: Date.now() - started
  }
  if (!v.ok) throw new SkillError(`${compiled.name}: ${v.mismatches.length} block(s) wrong after the repair pass`, { code: 'FAILED', details: result })
  return result
}

const skill = defineSkill('build', build, { description: 'build a blueprint (materials obtained, verified block by block)' })

module.exports = Object.assign(skill, { build, findSite, placeCell, clearVolume, referenceFor, obtainAny })
