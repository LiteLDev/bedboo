// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Nether portal skill: obtain obsidian legitimately, build a 4×5 frame, light it with flint and steel (flint from
 * gravel, iron ingot) and walk through. Cheat-free: public mineflayer API + mineflayer-pathfinder only.
 *
 *   const portal = require('@bedboo/agent/src/skills/portal')
 *   await portal(bot, { obsidian: 10, enter: true })      // the skill: everything below in a row
 *   await portal.obtainObsidian(bot, 10)                    // bucket casting next to a lava pool
 *   const frame = await portal.buildPortal(bot)             // site search, frame, scaffolding corners
 *   await portal.lightPortal(bot, frame)                    // flint and steel (crafted from gravel's flint + iron)
 *   await portal.enterPortal(bot, frame)                    // walk in, wait for the dimension change
 *
 * Obsidian ("mold" casting, method (b) of the plan): fill the empty buckets from lava sources of a pool, carry them to
 * a one-block hole dug in flat ground 5–12 blocks from the pool, pour the lava into the hole, pour water on the
 * ground next to it (the water flows over the lava source → obsidian), take the water back with the bucket, mine the
 * obsidian with a diamond pickaxe from the hole (the drop stays in the hole: no lava under it to burn it) and pick it
 * up. One water bucket is kept; every other bucket carries lava (k buckets → k casts per trip to the pool).
 *
 * Frame (10 obsidian minimum, no obsidian corners): the bottom row is sunk into the ground (dig 2 ground blocks,
 * place obsidian on the blocks below), so the portal floor is flush with the ground; the bottom corners are the
 * ground itself, the top corners scaffolding blocks (dirt, cobblestone, … — obsidian when there is enough), the top
 * middle blocks are placed against the corners' sides. Everything is placed from a spot two blocks in front of the
 * frame.
 */
const { Vec3 } = require('vec3')
const u = require('../dims/util')
const memory = require('../dims/memory')
const combat = require('./combat')

const UP = new Vec3(0, 1, 0)
const AXES = { x: new Vec3(1, 0, 0), z: new Vec3(0, 0, 1) }
/** horizontal direction perpendicular to the frame plane */
const NORMALS = { x: new Vec3(0, 0, 1), z: new Vec3(1, 0, 0) }
const DIRS = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]
const PICKAXES_FOR_OBSIDIAN = ['netherite_pickaxe', 'diamond_pickaxe']
/** blocks that must never be dug for a mold / frame site */
const PRECIOUS = /obsidian|bedrock|portal|chest|furnace|crafting_table|spawner|_ore$|ancient_debris|barrel|shulker/

// -----------------------------------------------------------------------------------------------------------------
// planners (pure: `blockAt(Vec3) → block | null`, blocks only need name / boundingBox)

/** frame cell (u along the axis, v up) → world position */
function cellPos (base, axis, cu, cv) {
  return u.vec(base).plus(AXES[axis].scaled(cu)).offset(0, cv, 0)
}

/**
 * Plan a 4×5 nether portal frame whose bottom-left corner block is `base` (the bottom row is the ground row).
 * @param {{x,y,z}} base
 * @param {'x'|'z'} axis direction of the frame's width
 * @param {{ obsidian?: number }} [opts] obsidian available: ≥12 → obsidian top corners, ≥14 → obsidian everywhere
 * @returns {{ base, axis, normal, steps: Array<{ pos, ref?, face?, block: 'obsidian'|'scaffold'|'support'|'clear', role }>,
 *   interior: Vec3[], frame: Vec3[], light: { ref: Vec3, face: Vec3 }, stand: Vec3[], obsidianNeeded: number }}
 *   `steps` in build order: every `ref` is either below the bottom row (the ground) or placed by an earlier step;
 *   `support`: any solid block (the ground; a scaffolding block when missing)
 */
function planPortalFrame (base, axis = 'x', { obsidian = 10 } = {}) {
  if (!AXES[axis]) throw new Error(`axis must be 'x' or 'z', got ${axis}`)
  const b = u.vec(base).floored()
  const a = AXES[axis]
  const at = (cu, cv) => cellPos(b, axis, cu, cv)
  const topCorner = obsidian >= 12 ? 'obsidian' : 'scaffold'
  const bottomCorner = obsidian >= 14 ? 'obsidian' : 'support'
  const steps = []
  const interior = []
  for (let cv = 1; cv <= 3; cv++) {
    for (let cu = 1; cu <= 2; cu++) {
      interior.push(at(cu, cv))
      steps.push({ pos: at(cu, cv), block: 'clear', role: 'interior' })
    }
  }
  for (const cu of [1, 2]) steps.push({ pos: at(cu, 0), ref: at(cu, -1), face: UP, block: 'obsidian', role: 'bottom' })
  for (const cu of [0, 3]) steps.push({ pos: at(cu, 0), ref: at(cu, -1), face: UP, block: bottomCorner, role: 'corner' })
  for (const cu of [0, 3]) {
    for (let cv = 1; cv <= 3; cv++) steps.push({ pos: at(cu, cv), ref: at(cu, cv - 1), face: UP, block: 'obsidian', role: 'side' })
  }
  for (const cu of [0, 3]) steps.push({ pos: at(cu, 4), ref: at(cu, 3), face: UP, block: topCorner, role: 'corner' })
  steps.push({ pos: at(1, 4), ref: at(0, 4), face: a.clone(), block: 'obsidian', role: 'top' })
  steps.push({ pos: at(2, 4), ref: at(1, 4), face: a.clone(), block: 'obsidian', role: 'top' })
  const frame = steps.filter((s) => s.block === 'obsidian').map((s) => s.pos)
  const normal = NORMALS[axis]
  // build spots: two blocks in front of / behind the frame, in front of the interior columns
  const stand = []
  for (const side of [1, -1]) for (const cu of [1, 2]) stand.push(at(cu, 1).plus(normal.scaled(2 * side)))
  return {
    base: b,
    axis,
    normal,
    steps,
    interior,
    frame,
    light: { ref: at(1, 0), face: UP.clone() },
    stand,
    obsidianNeeded: frame.length
  }
}

/**
 * Score a frame site: null when unusable, else the number of blocks to dig (lower is better).
 * Needs: solid ground under the bottom row, the bottom row solid (dug and replaced) or obsidian, the 4×4 space
 * above it clear of liquids (plants / air; solid blocks only in the interior… are dug, counted), a clear build spot
 * on one side, no lava within 3 blocks.
 */
function scorePortalSite (blockAt, base, axis) {
  const plan = planPortalFrame(base, axis)
  const at = (cu, cv) => blockAt(cellPos(plan.base, axis, cu, cv))
  for (let cu = 0; cu < 4; cu++) {
    const below = at(cu, -1)
    const ground = at(cu, 0)
    if (!u.isSolid(below) || !ground || !(u.isSolid(ground) || ground.name === 'obsidian')) return null
    if (PRECIOUS.test(ground.name) && ground.name !== 'obsidian') return null
    for (let cv = 1; cv <= 5; cv++) if (!u.isClear(at(cu, cv))) return null
  }
  // one side with a clear walk-in: ground in front, feet/head clear for 2 blocks out
  let side = null
  for (const s of [1, -1]) {
    let ok = true
    for (let d = 1; d <= 3 && ok; d++) {
      for (let cu = 0; cu <= 3 && ok; cu++) {
        const p = cellPos(plan.base, axis, cu, 0).plus(plan.normal.scaled(d * s))
        if (!u.isSolid(blockAt(p)) || !u.isClear(blockAt(p.offset(0, 1, 0))) || !u.isClear(blockAt(p.offset(0, 2, 0)))) ok = false
      }
    }
    if (ok) { side = s; break }
  }
  if (side === null) return null
  for (let cu = -3; cu <= 6; cu++) {
    for (let cv = -2; cv <= 5; cv++) {
      for (let d = -3; d <= 3; d++) {
        const p = cellPos(plan.base, axis, cu, cv).plus(plan.normal.scaled(d))
        const blk = blockAt(p)
        if (u.isLava(blk)) return null
        if (u.isWater(blk) && Math.abs(d) <= 2 && cu >= -1 && cu <= 4) return null
      }
    }
  }
  return { cost: 0, side }
}

/**
 * Find a site for a portal frame near `center` (nearest first): `{ base, axis, side }` or null.
 * @param {(p: Vec3) => object|null} blockAt
 * @param {{x,y,z}} center feet position to search around
 * @param {{ radius?: number, groundY?: (x, z) => number|null }} [opts]
 */
function findPortalSite (blockAt, center, { radius = 16, dy = 4, keepClear = [] } = {}) {
  const c = u.vec(center).floored()
  // never build over the bot (or other given feet positions): every frame / interior cell 2+ blocks away
  const avoid = [c, ...keepClear.map((p) => u.vec(p).floored())]
  const overlaps = (base, axis) => {
    for (let cu = 0; cu < 4; cu++) {
      for (let cv = 0; cv <= 4; cv++) {
        const p = cellPos(base, axis, cu, cv)
        if (avoid.some((a) => Math.abs(a.x - p.x) <= 1 && Math.abs(a.z - p.z) <= 1 && p.y >= a.y - 1 && p.y <= a.y + 2)) return true
      }
    }
    return false
  }
  const candidates = []
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      // ground rows within ±dy of the center's feet level
      for (let y = c.y - 1 - dy; y <= c.y - 1 + dy; y++) {
        const p = new Vec3(c.x + dx, y, c.z + dz)
        if (!u.isSolid(blockAt(p)) || !u.isClear(blockAt(p.offset(0, 1, 0)))) continue
        candidates.push({ p, d: Math.abs(dx) + Math.abs(dz) + Math.abs(y - (c.y - 1)) * 2 })
      }
    }
  }
  candidates.sort((x, y) => x.d - y.d)
  for (const { p } of candidates) {
    for (const axis of ['x', 'z']) {
      if (overlaps(p, axis)) continue
      const s = scorePortalSite(blockAt, p, axis)
      if (s) return { base: p, axis, side: s.side }
    }
  }
  return null
}

/**
 * Plan a mold for bucket casting: a ground block `mold` to dig, `water` (the air cell next to the hole where the water
 * goes, on the ground block `mold + dir`), `stand` (feet position 2 blocks on the other side). The mold is 5–12 blocks
 * (horizontally) from the nearest lava, on flat solid ground so the lava stays in the hole and the water spreads
 * evenly. Returns the best candidate around `near` or null.
 * @param {(p: Vec3) => object|null} blockAt
 * @param {Vec3[]} lava lava block positions of the pool (sources and flowing)
 * @param {{ near: {x,y,z}, radius?: number, minLava?: number, maxLava?: number }} opts
 */
function planMold (blockAt, lava, { near, radius = 14, minLava = 5, maxLava = 12, preferLava = 7, exclude = new Set() } = {}) {
  const n = u.vec(near).floored()
  const lavaXZ = lava.map((p) => u.vec(p))
  const lavaDist = (p) => {
    let best = Infinity
    for (const l of lavaXZ) {
      if (Math.abs(l.y - p.y) > 8) continue
      const d = Math.hypot(l.x - p.x, l.z - p.z)
      if (d < best) best = d
    }
    return best
  }
  const solid = (p) => u.isSolid(blockAt(p))
  const clear = (p) => u.isClear(blockAt(p))
  let best = null
  for (let dx = -radius; dx <= radius; dx++) {
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dy = -4; dy <= 4; dy++) {
        const m = n.offset(dx, dy - 1, dz) // ground block
        if (exclude.has(m.toString())) continue
        const mb = blockAt(m)
        if (!u.isSolid(mb) || PRECIOUS.test(mb.name) || /sand|gravel|concrete_powder/.test(mb.name)) continue
        if (!clear(m.offset(0, 1, 0)) || !clear(m.offset(0, 2, 0))) continue
        const ld = lavaDist(m)
        if (ld < minLava || ld > maxLava) continue
        if (!solid(m.offset(0, -1, 0))) continue
        let walls = true
        for (const d of DIRS) if (!solid(m.plus(d))) walls = false
        if (!walls) continue
        // flat 5×5 ground around (the water spreads on it, the bot walks there)
        let flat = true
        for (let fx = -2; fx <= 2 && flat; fx++) {
          for (let fz = -2; fz <= 2 && flat; fz++) {
            const g = m.offset(fx, 0, fz)
            if (!solid(g) || !clear(g.offset(0, 1, 0)) || !clear(g.offset(0, 2, 0))) flat = false
            if (u.isWater(blockAt(g.offset(0, 1, 0)))) flat = false
          }
        }
        if (!flat) continue
        // the water's cell and the cell over the hole: plain air (a flower there holds the water); the bot stands
        // two blocks on the other side
        const isAir = (p) => blockAt(p)?.name === 'air'
        if (!isAir(m.offset(0, 1, 0))) continue
        const dir = DIRS.find((d) => isAir(m.plus(d).offset(0, 1, 0)))
        if (!dir) continue
        const score = Math.abs(ld - preferLava) + 0.1 * m.distanceTo(n.offset(0, -1, 0))
        if (!best || score < best.score) {
          best = { mold: m, water: m.plus(dir).offset(0, 1, 0), stand: m.minus(dir.scaled(2)).offset(0, 1, 0), dir: dir.clone(), lavaDistance: ld, score }
        }
      }
    }
  }
  return best
}

// -----------------------------------------------------------------------------------------------------------------
// skills

const worldOf = (bot) => (p) => bot.blockAt(p)

function hasObsidianPickaxe (bot) {
  return !!u.findItem(bot, PICKAXES_FOR_OBSIDIAN)
}

/** wait until `count(name)` reaches `n` (inventory updates trail the world's block updates) */
function waitCount (bot, name, n, opts = {}) {
  return u.waitFor(() => u.count(bot, name) >= n, { timeout: 5000, interval: 50, message: `${n} ${name}`, ...opts })
}

/** Fill one empty bucket from the nearest reachable source of `liquid` ('water' | 'lava'); returns the source position. */
async function fillBucket (bot, liquid, { signal, maxDistance = 128, near, skip = new Set() } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const filled = `${liquid}_bucket`
  const isSource = liquid === 'lava' ? u.isLavaSource : u.isWaterSource
  const names = liquid === 'lava' ? ['lava', 'flowing_lava'] : ['water', 'flowing_water']
  const sources = u.findBlocks(bot, names, { maxDistance, count: 2048, point: near, filter: (b) => isSource(b) && !skip.has(b.position.toString()) })
    // reachable from above: air (or the liquid's own surface) right above
    .filter((b) => u.isClear(bot.blockAt(b.position.offset(0, 1, 0))))
  if (!sources.length) throw new Error(`no ${liquid} source within ${maxDistance} blocks`)
  const me = bot.entity.position
  sources.sort((x, y) => x.position.distanceTo(me) - y.position.distanceTo(me))
  let lastErr
  for (const src of sources.slice(0, 12)) {
    u.throwIfAborted(signal)
    const p = src.position
    try {
      await u.goto(bot, new goals.GoalNear(p.x, p.y + 1, p.z, 2.5), { signal, timeout: 45000, retries: 1 })
      const block = bot.blockAt(p)
      if (!isSource(block)) { skip.add(p.toString()); continue }
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
      if (eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4.5) { skip.add(p.toString()); continue }
      const before = u.count(bot, filled)
      await u.equipItem(bot, 'bucket')
      await bot.activateBlock(block)
      await waitCount(bot, filled, before + 1, { timeout: 3000, signal })
      u.log(bot, `filled a ${filled} at ${p}`)
      return p
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
      skip.add(p.toString())
      const fire = u.findBlocks(bot, ['fire'], { maxDistance: 8, count: 64 }).length
      u.log(bot, `${liquid} source ${p}: ${err.message} (bot at ${bot.entity.position.floored()} in ${bot.blockAt(bot.entity.position.floored())?.name}, ${fire} fire blocks within 8)`)
    }
  }
  throw new Error(`could not fill a bucket with ${liquid}: ${lastErr?.message ?? 'no reachable source'}`)
}

/** a water bucket in the inventory (fills an empty bucket from the nearest water source when needed) */
async function ensureWaterBucket (bot, { signal } = {}) {
  if (u.count(bot, 'water_bucket') > 0) return
  if (u.count(bot, 'bucket') === 0) throw new Error('no bucket for water')
  await fillBucket(bot, 'water', { signal })
}

/**
 * Cast `n` obsidian (in total in the inventory) with buckets next to a lava pool and mine it with a diamond pickaxe.
 * @param {object} bot
 * @param {number} n
 * @param {{ signal?: AbortSignal, maxDistance?: number }} [opts]
 * @returns {Promise<{ obsidian: number, cast: number, mold: object, trips: number }>}
 */
async function obtainObsidian (bot, n = 10, { signal, maxDistance = 128, guard } = {}) {
  const have = () => u.count(bot, 'obsidian')
  const result = { obsidian: have(), cast: 0, mold: null, trips: 0 }
  if (have() >= n) return result
  if (!hasObsidianPickaxe(bot)) throw new Error('obsidian needs a diamond (or netherite) pickaxe')
  const buckets = () => u.count(bot, 'bucket') + u.count(bot, 'lava_bucket') + u.count(bot, 'water_bucket')
  if (buckets() < 2) throw new Error(`bucket casting needs two buckets (one for water, one for lava), the bot has ${buckets()}`)
  const { goals } = u.ensurePathfinder(bot)
  await ensureWaterBucket(bot, { signal })
  const skip = new Set()
  const badMolds = new Set()
  let mold = null
  let failures = 0
  while (have() < n) {
    u.throwIfAborted(signal)
    if (u.count(bot, 'bucket') === 0 && u.count(bot, 'lava_bucket') === 0) {
      throw new Error('no empty bucket left for lava (every bucket holds water)')
    }
    // a trip: fill every empty bucket (one is the water bucket's) with lava
    const wanted = Math.max(1, Math.min(u.count(bot, 'bucket'), n - have() - u.count(bot, 'lava_bucket')))
    let lastLava = null
    for (let i = 0; i < wanted && u.count(bot, 'bucket') > 0; i++) {
      lastLava = await combat.guarded(guard, () => fillBucket(bot, 'lava', { signal, maxDistance, skip, near: lastLava ?? undefined }))
    }
    result.trips++
    if (!mold) {
      const lava = u.findBlocks(bot, ['lava', 'flowing_lava'], { maxDistance: 24, count: 1024, point: lastLava ?? bot.entity.position }).map((b) => b.position)
      mold = planMold(worldOf(bot), lava, { near: lastLava ?? bot.entity.position, exclude: badMolds })
      if (!mold) throw new Error(`no flat ground for a mold near the lava at ${lastLava}`)
      result.mold = { mold: u.plain(mold.mold), water: u.plain(mold.water), stand: u.plain(mold.stand) }
      u.log(bot, `mold at ${mold.mold} (lava ${mold.lavaDistance.toFixed(1)} blocks away), water at ${mold.water}`)
    }
    while (u.count(bot, 'lava_bucket') > 0 && have() < n) {
      let interrupted = false
      const onBusy = () => { interrupted = true }
      guard?.on('busy', onBusy)
      try {
        if (guard) await guard.idle()
        await castOne(bot, mold, { signal, goals })
        result.cast++
        failures = 0
        u.log(bot, `obsidian ${have()}/${n}`)
      } catch (err) {
        if (signal?.aborted) throw err
        if (guard && (interrupted || guard.busy)) {
          // a fight interrupted the cast: not the mold's fault
          u.log(bot, `cast interrupted by a fight: ${err.message}`)
          await guard.idle()
          if (u.count(bot, 'water_bucket') === 0) await ensureWaterBucket(bot, { signal })
          continue
        }
        failures++
        u.log(bot, `cast failed (${failures}): ${err.message}`)
        if (failures >= 4) throw new Error(`bucket casting failed ${failures} times in a row: ${err.message}`)
        // the water may be gone (flowed into the hole, picked up elsewhere): refill before the next try
        if (u.count(bot, 'water_bucket') === 0) await ensureWaterBucket(bot, { signal })
        if (failures >= 2) {
          // try another spot (a hole left with lava in it stays behind: it is in the ground, it cannot spread)
          badMolds.add(mold.mold.toString())
          mold = null
        }
        if (!mold) break
      } finally {
        guard?.removeListener('busy', onBusy)
      }
    }
  }
  result.obsidian = have()
  return result
}

/** break a plant (anything walk-through that is not air or a liquid) at `pos` */
async function clearPlant (bot, pos, { signal } = {}) {
  const b = bot.blockAt(pos)
  if (!b || b.name === 'air' || b.name === 'cave_air' || u.isWater(b) || u.isLava(b) || b.boundingBox !== 'empty') return
  await u.digBlock(bot, b, { signal })
  await u.waitForBlock(bot, pos, (x) => x.name === 'air', { timeout: 3000, signal }).catch(() => {})
}

/** one cast at the mold: lava in, water next to it, water back, mine, pick up */
async function castOne (bot, mold, { signal, goals }) {
  const M = mold.mold
  const W = mold.water
  const ground = M.plus(mold.dir)
  await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 60000 })
  const before = u.count(bot, 'obsidian')
  let block = bot.blockAt(M)
  if (block.name === 'obsidian') return mineMold(bot, mold, before, { signal, goals })
  if (!u.isClear(block) && !u.isLava(block)) {
    await u.digBlock(bot, block, { signal })
    await u.waitForBlock(bot, M, (b) => b.boundingBox === 'empty', { timeout: 3000, signal })
  }
  block = bot.blockAt(M)
  if (!u.isLavaSource(block)) {
    await u.equipItem(bot, 'lava_bucket')
    await bot.placeBlock(bot.blockAt(M.offset(0, -1, 0)), UP)
    await u.waitForBlock(bot, M, (b) => u.isLava(b), { timeout: 3000, signal })
  }
  if (u.count(bot, 'water_bucket') === 0) throw new Error('no water bucket')
  // plants (flowers, grass) where the water goes would hold it / be washed away unpredictably: break them first
  for (const p of [W, M.offset(0, 1, 0)]) await clearPlant(bot, p, { signal })
  await u.equipItem(bot, 'water_bucket')
  await bot.placeBlock(bot.blockAt(ground), UP)
  try {
    await u.waitForBlock(bot, M, (b) => b.name === 'obsidian', { timeout: 5000, signal })
  } finally {
    // take the water back (the source; flowing water drains by itself)
    const water = bot.blockAt(W)
    if (u.isWaterSource(water)) {
      const buckets = u.count(bot, 'water_bucket')
      await u.equipItem(bot, 'bucket')
      await bot.activateBlock(water)
      await waitCount(bot, 'water_bucket', buckets + 1, { timeout: 3000, signal }).catch(() => {})
    }
  }
  return mineMold(bot, mold, before, { signal, goals })
}

async function mineMold (bot, mold, before, { signal, goals }) {
  const M = mold.mold
  // let the flowing water drain (it would push the drop and the bot)
  const wet = () => {
    for (const d of [...DIRS, new Vec3(0, 0, 0)]) if (u.isWater(bot.blockAt(M.plus(d).offset(0, 1, 0)))) return true
    const feet = bot.entity.position.floored()
    return u.isWater(bot.blockAt(feet)) || u.isWater(bot.blockAt(feet.offset(0, 1, 0)))
  }
  await u.waitFor(() => !wet(), { timeout: 8000, interval: 100, signal }).catch(() => {})
  for (let attempt = 0; ; attempt++) {
    try {
      // standing in water / off the ground digs 5× slower: back on the stand spot first
      if (attempt > 0) await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 20000 }).catch(() => {})
      await u.digBlock(bot, bot.blockAt(M), { signal, requireHarvest: true })
      await u.waitForBlock(bot, M, (b) => b.boundingBox === 'empty', { timeout: 3000, signal })
      break
    } catch (err) {
      if (attempt >= 2 || signal?.aborted) throw err
      u.log(bot, `mining the obsidian: ${err.message}, again`)
      await u.sleep(1000, signal)
    }
  }
  // the drop lies in the hole: step in
  const until = Date.now() + 15000
  while (u.count(bot, 'obsidian') <= before && Date.now() < until) {
    await u.goto(bot, new goals.GoalBlock(M.x, M.y, M.z), { signal, timeout: 15000, retries: 1 }).catch(() => {})
    await u.sleep(250, signal)
  }
  if (u.count(bot, 'obsidian') <= before) throw new Error('the obsidian drop was not picked up')
  // back out of the hole
  await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 30000 }).catch(() => {})
}

// --- flint and steel --------------------------------------------------------------------------------------------

/** a block position next to the bot where a gravel block can be put down (on solid ground, clear above) */
function gravelSpot (bot) {
  const feet = bot.entity.position.floored()
  for (const d of [new Vec3(2, 0, 0), new Vec3(-2, 0, 0), new Vec3(0, 0, 2), new Vec3(0, 0, -2), new Vec3(2, 0, 1), new Vec3(1, 0, 2)]) {
    const p = feet.plus(d)
    if (u.isSolid(bot.blockAt(p.offset(0, -1, 0))) && u.isClear(bot.blockAt(p)) && u.isClear(bot.blockAt(p.offset(0, 1, 0))) && !u.nearLava(bot, p, 1)) return p
  }
  return null
}

/**
 * Flint from gravel: dig gravel (the nearest in the world, then the bot's own gravel put back down) until a flint
 * drops (10 % per gravel block). @returns {Promise<{ flint: number, gravelDug: number }>}
 */
async function obtainFlint (bot, { signal, maxTries = 60 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  let dug = 0
  const bad = new Set()
  while (u.count(bot, 'flint') === 0) {
    u.throwIfAborted(signal)
    if (dug >= maxTries) throw new Error(`no flint after ${dug} gravel blocks`)
    let target = null
    if (u.count(bot, 'gravel') > 0) {
      const spot = gravelSpot(bot)
      if (spot) {
        try {
          await u.equipItem(bot, 'gravel')
          await bot.placeBlock(bot.blockAt(spot.offset(0, -1, 0)), UP)
          target = await u.waitForBlock(bot, spot, (b) => b.name === 'gravel', { timeout: 3000, signal })
        } catch (err) {
          if (signal?.aborted) throw err
          u.log(bot, `placing gravel at ${spot}: ${err.message}`)
        }
      }
      if (!target) {
        // move a little and try again
        const p = bot.entity.position.offset(Math.random() * 6 - 3, 0, Math.random() * 6 - 3)
        await u.goto(bot, new goals.GoalNear(p.x, p.y, p.z, 1), { signal, timeout: 10000, retries: 0 }).catch(() => {})
        continue
      }
    } else {
      const found = u.findBlocks(bot, 'gravel', {
        maxDistance: 96,
        count: 512,
        filter: (b) => !bad.has(b.position.toString()) && !u.nearLava(bot, b.position, 2) &&
          !u.isWater(bot.blockAt(b.position.offset(0, 1, 0))) && !/gravel|sand/.test(bot.blockAt(b.position.offset(0, 1, 0))?.name ?? '')
      })
      if (!found.length) throw new Error('no gravel within 96 blocks')
      target = found[0]
      u.log(bot, `flint: gravel at ${target.position} (bot at ${bot.entity.position.floored()})`)
      try {
        await u.goto(bot, new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z), { signal, timeout: 90000 })
      } catch (err) {
        if (signal?.aborted) throw err
        bad.add(target.position.toString())
        continue
      }
    }
    const pos = target.position
    try {
      await u.digBlock(bot, bot.blockAt(pos), { signal })
      dug++
      await u.collectDrops(bot, pos, { radius: 3, names: ['flint', 'gravel'], timeout: 6000, signal })
    } catch (err) {
      if (signal?.aborted) throw err
      bad.add(pos.toString())
      u.log(bot, `gravel at ${pos}: ${err.message}`)
    }
  }
  u.log(bot, `flint after ${dug} gravel blocks (bot at ${bot.entity.position.floored()})`)
  return { flint: u.count(bot, 'flint'), gravelDug: dug }
}

/** craft a flint and steel (2×2 grid) from flint (dug from gravel) and an iron ingot */
async function ensureFlintAndSteel (bot, { signal } = {}) {
  if (u.count(bot, 'flint_and_steel') > 0) return { crafted: false }
  if (u.count(bot, 'iron_ingot') === 0) throw new Error('a flint and steel needs an iron ingot')
  const flint = await obtainFlint(bot, { signal })
  const id = bot.registry.itemsByName.flint_and_steel.id
  const recipe = bot.recipesFor(id, null, 1, null)[0]
  if (!recipe) throw new Error('no flint_and_steel recipe for the inventory grid')
  await bot.craft(recipe, 1, null)
  await waitCount(bot, 'flint_and_steel', 1, { signal })
  return { crafted: true, ...flint }
}

// --- frame ----------------------------------------------------------------------------------------------------

/** the first scaffolding block of the inventory */
function scaffoldItem (bot) {
  return u.findItem(bot, u.SCAFFOLD_BLOCKS)
}

/** dig a block of dirt next to the bot for scaffolding */
async function digScaffold (bot, { signal } = {}) {
  const candidates = u.findBlocks(bot, ['dirt', 'grass_block', 'netherrack', 'stone', 'cobblestone', 'end_stone'], {
    maxDistance: 6,
    count: 64,
    filter: (b) => b.position.y < bot.entity.position.y && u.isClear(bot.blockAt(b.position.offset(0, 1, 0))) && !u.nearLava(bot, b.position, 1)
  })
  for (const b of candidates) {
    if (b.position.floored().equals(bot.entity.position.floored().offset(0, -1, 0))) continue
    await u.digBlock(bot, b, { signal })
    await u.collectDrops(bot, b.position, { radius: 3, timeout: 5000, signal })
    if (scaffoldItem(bot)) return
  }
  throw new Error('no scaffolding block and nothing to dig for one')
}

/**
 * Build a nether portal frame (10 obsidian + 2 scaffolding blocks, or more obsidian when available).
 * @param {object} bot
 * @param {{ origin?: {x,y,z}, axis?: 'x'|'z', signal?: AbortSignal, radius?: number }} [opts] `origin`: the frame's
 *   bottom-left ground block (else the nearest suitable site)
 * @returns {Promise<object>} the plan + `{ built: true }`
 */
async function buildPortal (bot, { origin, axis, side, signal, radius = 20 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const obsidian = u.count(bot, 'obsidian')
  let site
  if (origin) site = { base: u.vec(origin), axis: axis ?? 'x', side: side ?? 1 }
  else site = findPortalSite(worldOf(bot), bot.entity.position, { radius })
  if (!site) throw new Error(`no flat ${radius}-block site for a portal around ${bot.entity.position.floored()}`)
  const plan = planPortalFrame(site.base, site.axis, { obsidian })
  const missing = plan.frame.filter((p) => bot.blockAt(p)?.name !== 'obsidian').length
  if (obsidian < missing) throw new Error(`the portal frame needs ${missing} more obsidian, the bot has ${obsidian}`)
  u.log(bot, `portal site ${plan.base} axis ${plan.axis} (side ${site.side})`)
  // build spot: in front of the frame on the chosen side
  const spots = plan.stand.filter((p) => Math.sign((p.x - plan.base.x) * plan.normal.x + (p.z - plan.base.z) * plan.normal.z) === Math.sign(site.side))
  const spot = spots[0] ?? plan.stand[0]
  const goSpot = () => u.goto(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal, timeout: 60000 })
  await goSpot()
  for (const step of plan.steps) {
    u.throwIfAborted(signal)
    const current = bot.blockAt(step.pos)
    const isAir = (b) => !b || b.name === 'air' || b.name === 'cave_air'
    if (step.block === 'clear') {
      // the interior must be air for the portal to light (flowers, grass: broken)
      if (!isAir(current) && current.name !== 'portal' && current.name !== 'fire') {
        await u.digBlock(bot, current, { signal })
        await u.waitForBlock(bot, step.pos, isAir, { timeout: 3000, signal }).catch(() => {})
      }
      continue
    }
    if (step.block === 'obsidian' && current?.name === 'obsidian') continue
    if ((step.block === 'support' || step.block === 'scaffold') && u.isSolid(current)) continue
    if (!isAir(current)) {
      await u.digBlock(bot, current, { signal })
      await u.waitForBlock(bot, step.pos, isAir, { timeout: 3000, signal })
      if (!bot.entity.position.floored().equals(spot)) await goSpot()
    }
    if (step.block === 'obsidian') await u.equipItem(bot, 'obsidian')
    else {
      if (!scaffoldItem(bot)) await digScaffold(bot, { signal })
      await u.equipItem(bot, u.SCAFFOLD_BLOCKS)
      if (!bot.entity.position.floored().equals(spot)) await goSpot()
    }
    const ref = bot.blockAt(step.ref)
    await bot.placeBlock(ref, step.face)
    await u.waitForBlock(bot, step.pos, (b) => step.block === 'obsidian' ? b.name === 'obsidian' : u.isSolid(b), { timeout: 3000, signal })
  }
  const frame = plan.frame.map((p) => bot.blockAt(p)?.name)
  if (frame.some((n) => n !== 'obsidian')) throw new Error(`frame incomplete: ${frame.join(',')}`)
  return { ...plan, built: true, spot }
}

/**
 * Light a built frame with flint and steel (crafted when needed). Resolves once the 6 portal blocks are there.
 * @param {object} bot
 * @param {object} frame the result of {@link buildPortal} (or {@link planPortalFrame})
 */
async function lightPortal (bot, frame, { signal } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  if (frame.interior.every((p) => bot.blockAt(p)?.name === 'portal')) {
    memory.rememberPortal(bot, { dimension: bot.game.dimension, position: u.plain(frame.interior[0]), frame: { base: u.plain(frame.base), axis: frame.axis } })
    return { lit: true, already: true }
  }
  const crafted = await ensureFlintAndSteel(bot, { signal })
  const spot = frame.spot ?? frame.stand[0]
  await u.goto(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal, timeout: 60000 })
  await u.equipItem(bot, 'flint_and_steel')
  await bot.placeBlock(bot.blockAt(frame.light.ref), frame.light.face)
  for (const p of frame.interior) await u.waitForBlock(bot, p, (b) => b.name === 'portal', { timeout: 5000, signal })
  memory.rememberPortal(bot, { dimension: bot.game.dimension, position: u.plain(frame.interior[0]), frame: { base: u.plain(frame.base), axis: frame.axis } })
  return { lit: true, crafted: crafted.crafted, gravelDug: crafted.gravelDug ?? 0 }
}

/** a portal block of a portal near `near` (or the bot) */
function findPortalBlock (bot, near, maxDistance = 16) {
  const [block] = u.findBlocks(bot, 'portal', { maxDistance, count: 1, point: near })
  return block ?? null
}

/** a standable feet position next to (not inside) the portal at `portalPos`, preferring the open side */
function exitSpot (bot, portalPos) {
  const c = u.vec(portalPos).floored()
  let best = null
  for (let r = 1; r <= 4 && !best; r++) {
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dy = -1; dy <= 1; dy++) {
          const p = c.offset(dx, dy, dz)
          const feet = bot.blockAt(p)
          if (!feet || feet.name === 'portal' || !u.isClear(feet) || !u.isClear(bot.blockAt(p.offset(0, 1, 0))) || !u.isStandable(bot.blockAt(p.offset(0, -1, 0)))) continue
          if (u.nearLava(bot, p, 1)) continue
          const d = Math.abs(dx) + Math.abs(dz) + Math.abs(dy)
          if (!best || d < best.d) best = { p, d }
        }
      }
    }
  }
  return best?.p ?? null
}

/**
 * Walk into a lit nether portal and wait until the bot spawned in the other dimension; then step out of the arrival
 * portal. Remembers both portals.
 * @param {object} bot
 * @param {object|{x,y,z}} [portal] a frame (buildPortal result), a portal block position, or nothing (nearest)
 * @returns {Promise<{ from: string, to: string, arrival: {x,y,z}, ms: number }>}
 */
async function enterPortal (bot, portal, { signal, timeout = 120000 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const from = bot.game.dimension
  const to = from === 'the_nether' ? 'overworld' : 'the_nether'
  let target
  if (portal?.interior) target = u.vec(portal.interior[0])
  else if (portal && portal.x !== undefined) target = u.vec(portal)
  if (!target || bot.blockAt(target)?.name !== 'portal') {
    let block = findPortalBlock(bot, target ?? bot.entity.position, target ? 8 : 32)
    // a portal put out (a ghast fireball, a block update): light the frame again with the bot's flint and steel
    if (!block && target && bot.blockAt(target.offset(0, -1, 0))?.name === 'obsidian' && u.count(bot, 'flint_and_steel') > 0) {
      u.log(bot, `portal at ${target} is out: relighting it`)
      const spot = exitSpot(bot, target)
      if (spot) await u.goto(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal, timeout: 60000 }).catch(() => {})
      await u.equipItem(bot, 'flint_and_steel')
      await bot.placeBlock(bot.blockAt(target.offset(0, -1, 0)), UP).catch((err) => u.log(bot, `relight: ${err.message}`))
      await u.waitForBlock(bot, target, (b) => b.name === 'portal', { timeout: 3000, signal }).catch(() => {})
      block = findPortalBlock(bot, target, 8)
    }
    if (!block) throw new Error(`no lit portal near ${target ?? bot.entity.position.floored()}`)
    target = block.position
  }
  // the lowest portal block of that column
  while (bot.blockAt(target.offset(0, -1, 0))?.name === 'portal') target = target.offset(0, -1, 0)
  memory.rememberPortal(bot, { dimension: from, position: u.plain(target) })
  const started = Date.now()
  // walk next to it, then step in (pathfinder avoids portal blocks)
  const outside = exitSpot(bot, target)
  if (outside) await u.goto(bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal, timeout: 60000 }).catch(() => {})
  const arrived = u.waitForDimension(bot, to, { timeout, signal })
  arrived.catch(() => {})
  const inside = () => bot.blockAt(bot.entity.position.floored())?.name === 'portal' || bot.blockAt(bot.entity.position.offset(0, 1, 0).floored())?.name === 'portal'
  for (let attempt = 0; attempt < 3 && bot.game.dimension === from; attempt++) {
    if (attempt > 0) {
      // out and in again (a portal that does not take the bot: it was not inside long enough, or pushed about)
      u.log(bot, `portal: still in ${from} after standing in ${target} (at ${bot.entity.position.floored()}), stepping out and in again`)
      bot.clearControlStates()
      if (outside) await u.goto(bot, new goals.GoalBlock(outside.x, outside.y, outside.z), { signal, timeout: 20000, retries: 0 }).catch(() => {})
      if (bot.game.dimension !== from) break // it took the bot after all
      await u.sleep(1500, signal)
      if (bot.game.dimension !== from) break
    }
    for (let i = 0; i < 80 && !inside() && bot.game.dimension === from; i++) {
      await bot.lookAt(target.offset(0.5, 1.6, 0.5), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', bot.entity.isCollidedHorizontally || target.y > bot.entity.position.y + 0.5)
      await bot.waitForTicks(1)
    }
    bot.setControlState('jump', false)
    // stand still in the centre of the portal block (pushing forward could walk through it)
    for (let i = 0; i < 10 && bot.game.dimension === from; i++) {
      const c = target.offset(0.5, 0, 0.5)
      const d = c.minus(bot.entity.position)
      if (Math.hypot(d.x, d.z) < 0.25) break
      await bot.lookAt(c.offset(0, bot.entity.eyeHeight, 0), true)
      await bot.waitForTicks(1)
    }
    bot.setControlState('forward', false)
    if (!inside() && bot.game.dimension === from) continue
    // a survival player crosses after ≈4 s in the portal
    const until = Date.now() + 12000
    while (bot.game.dimension === from && inside() && Date.now() < until) await u.sleep(200, signal)
  }
  if (bot.game.dimension === from && !inside()) throw new Error(`could not walk into the portal at ${target} (at ${bot.entity.position})`)
  await arrived
  await Promise.resolve(bot.waitForChunksToLoad?.()).catch(() => {})
  await u.sleep(500, signal)
  const arrivalBlock = findPortalBlock(bot, bot.entity.position, 4)
  let arrival = arrivalBlock ? arrivalBlock.position : bot.entity.position.floored()
  // remember the lowest portal block of the column (its frame block below is what a relight clicks)
  if (arrivalBlock) {
    while (bot.blockAt(arrival.offset(0, -1, 0))?.name === 'portal') arrival = arrival.offset(0, -1, 0)
  }
  memory.rememberPortal(bot, { dimension: to, position: u.plain(arrival) })
  // step out of the arrival portal (otherwise the next skill's first move may take it back)
  const out = exitSpot(bot, arrival)
  if (out) await u.goto(bot, new goals.GoalBlock(out.x, out.y, out.z), { signal, timeout: 20000, retries: 1 }).catch((err) => u.log(bot, `leaving the arrival portal: ${err.message}`))
  return { from, to, arrival: u.plain(arrival), departure: u.plain(target), ms: Date.now() - started }
}

/**
 * The portal skill: obsidian (bucket casting) → frame → flint and steel → light → (enter).
 * A frame that already stands at `origin` only gets its missing blocks (an intact frame is just lit). The whole skill
 * runs under combat.guardFor() (the Agent's safety, or a combat.defend() guard): mobs that come close are fought,
 * the interrupted phase resumes.
 * args: `{ obsidian?: number (10), origin?: {x,y,z}, axis?: 'x'|'z', side?: 1|-1 (build side of an `origin` frame),
 *   enter?: boolean (true), guard?: boolean (true) }`
 *   + `signal`
 * result: `{ obsidian: {...}, frame: {base, axis, blocks}, lit: true, flint, entered?: {...},
 *   portal: {overworld, the_nether}, guard, timings }`
 */
async function portalSkill (bot, args) {
  args = args ?? {}
  const { signal, origin, axis, enter = true } = args
  const timings = {}
  u.ensurePathfinder(bot, { fresh: true })
  const guard = args.guard === false ? null : combat.guardFor(bot, { radius: 8, retaliate: true, signal })
  const result = {}
  let frame
  try {
    // only what the frame still needs (an existing frame at `origin` counts): an inventory total for obtainObsidian
    let needed = args.obsidian ?? 10
    if (origin) {
      const plan = planPortalFrame(origin, axis ?? 'x', { obsidian: needed })
      needed = Math.min(needed, plan.frame.filter((p) => bot.blockAt(p)?.name !== 'obsidian').length)
    }
    let t = Date.now()
    result.obsidian = await combat.guarded(guard, () => obtainObsidian(bot, needed, { signal, guard }))
    timings.obsidianMs = Date.now() - t
    t = Date.now()
    // the site is chosen once: a retry after a fight goes on with the half-built frame
    const site = origin
      ? { base: u.vec(origin), axis: axis ?? 'x', side: args.side ?? 1 }
      : findPortalSite(worldOf(bot), bot.entity.position, { radius: 20 })
    if (!site) throw new Error(`no flat site for a portal around ${bot.entity.position.floored()}`)
    frame = await combat.guarded(guard, () => buildPortal(bot, { origin: site.base, axis: site.axis, side: site.side, signal }))
    timings.buildMs = Date.now() - t
    t = Date.now()
    const flint = { crafted: false, gravelDug: 0 }
    if (!frame.interior.every((p) => bot.blockAt(p)?.name === 'portal')) {
      await combat.guarded(guard, async () => {
        const r = await ensureFlintAndSteel(bot, { signal })
        if (r.crafted) Object.assign(flint, { crafted: true, gravelDug: r.gravelDug ?? 0 })
      })
    }
    timings.flintMs = Date.now() - t
    t = Date.now()
    const lit = await combat.guarded(guard, () => lightPortal(bot, frame, { signal }))
    timings.lightMs = Date.now() - t
    Object.assign(result, {
      frame: { base: u.plain(frame.base), axis: frame.axis, blocks: frame.frame.map(u.plain) },
      lit: lit.lit,
      flint
    })
    if (guard) await guard.idle()
  } finally {
    result.guard = guard ? await guard.stop() : null
  }
  if (enter) {
    const t = Date.now()
    result.entered = await enterPortal(bot, frame, { signal })
    timings.enterMs = Date.now() - t
  }
  result.portal = {
    overworld: memory.portalIn(bot, 'overworld')?.position ?? null,
    the_nether: memory.portalIn(bot, 'the_nether')?.position ?? null
  }
  result.timings = timings
  return result
}

module.exports = Object.assign(portalSkill, {
  planPortalFrame,
  scorePortalSite,
  findPortalSite,
  planMold,
  obtainObsidian,
  ensureWaterBucket,
  fillBucket,
  obtainFlint,
  ensureFlintAndSteel,
  buildPortal,
  lightPortal,
  enterPortal,
  findPortalBlock,
  exitSpot,
  cellPos
})
