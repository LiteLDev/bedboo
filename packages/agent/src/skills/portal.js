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
const shelter = require('../dims/shelter')
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

/**
 * Group block positions into connected clusters (26-neighbourhood, `gap` blocks apart at most): the lava pools / lakes
 * around. Pure. @returns {Vec3[][]} clusters (each a list of positions), largest first
 */
function clusterPositions (positions, { gap = 1 } = {}) {
  const pts = positions.map((p) => u.vec(p).floored())
  const index = new Map(pts.map((p, i) => [p.toString(), i]))
  const parent = pts.map((_, i) => i)
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i] } return i }
  pts.forEach((p, i) => {
    for (let dx = -gap; dx <= gap; dx++) {
      for (let dy = -gap; dy <= gap; dy++) {
        for (let dz = -gap; dz <= gap; dz++) {
          const j = index.get(p.offset(dx, dy, dz).toString())
          if (j !== undefined) parent[find(i)] = find(j)
        }
      }
    }
  })
  const groups = new Map()
  pts.forEach((p, i) => {
    const r = find(i)
    if (!groups.has(r)) groups.set(r, [])
    groups.get(r).push(p)
  })
  return [...groups.values()].sort((a, b) => b.length - a.length)
}

/** nothing solid in the `height` blocks above `p` (leaves do not count) */
function openSky (blockAt, p, height = 24) {
  for (let y = 1; y <= height; y++) {
    const b = blockAt(u.vec(p).offset(0, y, 0))
    if (!b) return true // above the loaded / generated world
    if (b.boundingBox === 'block' && !/leaves/.test(b.name)) return false
  }
  return true
}

/**
 * The lava pools among `lava` (positions of lava blocks, sources and flowing): per pool its sources, the sources a
 * bucket reaches (clear block above), how many of those are under the open sky, its centre and a stable key.
 * Pure (`blockAt`). @returns {Array<{ key, center, sources: Vec3[], reachable: Vec3[], sky: number, size: number }>}
 */
function lavaPools (blockAt, lava) {
  return clusterPositions(lava).map((blocks) => {
    const sources = blocks.filter((p) => u.isLavaSource(blockAt(p)))
    const reachable = sources.filter((p) => u.isClear(blockAt(p.offset(0, 1, 0))))
    const sky = reachable.filter((p) => openSky(blockAt, p)).length
    const c = blocks.reduce((a, p) => a.plus(p), new Vec3(0, 0, 0)).scaled(1 / blocks.length)
    const center = new Vec3(Math.round(c.x), Math.round(c.y), Math.round(c.z))
    const min = blocks.reduce((a, p) => (p.x < a.x || (p.x === a.x && (p.y < a.y || (p.y === a.y && p.z < a.z))) ? p : a))
    return { key: min.toString(), center, sources, reachable, sky, size: blocks.length, blocks }
  })
}

/**
 * Rank pools for bucket casting (best first): enough reachable sources for the casts still needed, under the open sky
 * (a cave pool needs a way down and back), close to `from`; `bad` pool keys are left out. Pure.
 */
function rankPools (pools, { from, need = 1, bad = new Set(), minSources = 2, minY = 40 } = {}) {
  const f = u.vec(from)
  const nearest = (pool) => Math.min(...pool.reachable.map((p) => p.distanceTo(f)))
  return pools
    .filter((p) => !bad.has(p.key) && p.reachable.length >= Math.min(minSources, need))
    // deep lava lakes (below y 40): in caves minutes of walking for no flat ground for a mold (N1M5 #3); at the bottom of
    // a ravine — open to the sky — the walk down ended in the lava (N1M5 #1, a ravine pool at y -31)
    .filter((p) => p.center.y >= minY)
    .map((p) => ({ pool: p, score: nearest(p) + (p.sky > 0 ? 0 : 96) + (p.reachable.length < need ? 24 : 0) }))
    .sort((a, b) => a.score - b.score)
    .map((x) => x.pool)
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

/** a U17 skill module when it is there (portal also runs without U17's Agent / skills) */
function optional (name) {
  try { return require(name) } catch { return null }
}

/**
 * Eat now, standing still, when mineflayer-auto-eat would (food under its `minHunger`, something it may eat is carried):
 * auto-eat starts a meal on every physics tick, and the pathfinder switching the held item to dig or to place a block
 * cancels it — a hungry bot that has to dig or tower does neither (chain run 4: 12 min at the mold, food 4, rotten flesh
 * carried). Without auto-eat (no Agent): eat like combat.defend's guard does.
 */
async function feed (bot, { signal, min: wanted } = {}) {
  const ae = bot.autoEat
  const min = wanted ?? ae?.opts?.minHunger ?? 14
  for (let i = 0; i < 4 && bot.food < min; i++) {
    u.throwIfAborted(signal)
    if (ae && typeof ae.eat === 'function') {
      const choices = typeof ae.findBestChoices === 'function' ? ae.findBestChoices(bot.inventory.items(), ae.opts?.priority ?? 'foodPoints') : []
      if (!choices.length) return
      u.stopMoving(bot)
      if (ae.isEating) {
        await u.waitFor(() => !ae.isEating, { timeout: 5000, interval: 100, signal }).catch(() => {})
        continue
      }
      const before = bot.food
      try {
        await ae.eat()
      } catch (err) {
        u.log(bot, `portal: eating ${choices[0].name}: ${err.message}`)
      }
      await u.waitFor(() => bot.food > before, { timeout: 1500, interval: 100, signal }).catch(() => {})
    } else {
      const food = await u.eatIfNeeded(bot, { minFood: min, signal }).catch(() => null)
      if (!food) return
    }
  }
}

/**
 * Up to the open sky before a search over the surface: from a mine or a mineshaft the pools and lakes the bot sees in
 * the loaded chunks are mostly out of reach (chain run 2: 13 min of walks to water sources from a mineshaft).
 * U17's survive.surface (pillar / staircase up, around water above), else a pathfinder climb. Never throws (the
 * searches that follow report what they cannot reach); aborts do.
 */
async function toSurface (bot, { signal, timeout = 180000 } = {}) {
  if (bot.game?.dimension !== 'overworld') return false
  const survive = optional('./survive')
  const feet = bot.entity.position.floored()
  const buried = typeof survive?.underOpenSky === 'function' ? !survive.underOpenSky(bot) : !openSky(worldOf(bot), feet.offset(0, 1, 0), 48)
  if (!buried) return false
  u.log(bot, `portal: under ground at ${feet}: up to the surface first`)
  try {
    if (typeof survive?.surface === 'function') {
      await survive.surface(bot, { signal, timeout })
    } else {
      const { goals } = u.ensurePathfinder(bot)
      let top = feet.y
      for (let y = feet.y + 2; y < 320; y++) {
        const b = bot.blockAt(new Vec3(feet.x, y, feet.z))
        if (!b) break
        if (b.boundingBox === 'block') top = y
      }
      await u.goto(bot, new goals.GoalY(top + 1), { signal, timeout })
    }
  } catch (err) {
    if (signal?.aborted) throw err
    u.log(bot, `portal: surfacing from ${feet}: ${err.message}`)
  } finally {
    u.ensurePathfinder(bot) // U17's skills set their own movements
  }
  u.log(bot, `portal: at ${bot.entity.position.floored()} after surfacing`)
  return true
}

/** walk to within `range` of `target`; far away with U17's navigate (legs, surfacing, unsticking) */
async function travelTo (bot, target, range, { signal, timeout = 180000 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const t = u.vec(target)
  const goal = new goals.GoalNear(t.x, t.y, t.z, range)
  const navigate = optional('./navigate')
  try {
    if (typeof navigate?.goto === 'function' && bot.entity.position.distanceTo(t) > 40) await navigate.goto(bot, goal, { signal, timeout })
    else await u.goto(bot, goal, { signal, timeout })
  } finally {
    u.ensurePathfinder(bot)
  }
}

/**
 * Hold `name` (bucket / lava_bucket / water_bucket) for a click on a liquid or a block: never while the guard fights
 * (its equipForCombat would swap the hand between the equip and the click — chain-like run N1M3 #1 poured its water
 * bucket into the lava pool after a creeper fight), and only once the hand really holds it.
 */
async function holdBucket (bot, name, { guard, signal } = {}) {
  for (let i = 0; i < 3; i++) {
    if (guard && u.busyKind(guard) === 'fight') await guard.idle()
    u.throwIfAborted(signal)
    await u.equipItem(bot, name)
    await u.tick(bot)
    if (bot.heldItem?.name === name && !(guard && u.busyKind(guard) === 'fight')) return
  }
  throw new Error(`could not hold a ${name} (holding ${bot.heldItem?.name ?? 'nothing'})`)
}

/**
 * Fill one empty bucket from a reachable source of `liquid` ('water' | 'lava'): one of `sources` (a pool's) or the
 * nearest loaded ones. Bounded: at most `tries` walks and `timeout` ms; a walk that failed slowly (stalled / timed out:
 * the bot cannot get to that edge) takes the sources within `spread` blocks of it out too. `avoid`: cell keys of the
 * pool's footprint (its sources taken since are dry holes the lava flows back into) — never a fill spot next to one.
 * @returns {Promise<Vec3>}
 */
async function fillBucket (bot, liquid, { signal, guard, maxDistance = 128, near, skip = new Set(), sources: only, tries = 6, timeout = 150000, spread = 4, avoid = null } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const filled = `${liquid}_bucket`
  const isSource = liquid === 'lava' ? u.isLavaSource : u.isWaterSource
  const names = liquid === 'lava' ? ['lava', 'flowing_lava'] : ['water', 'flowing_water']
  // reachable from above: air (or a plant) right above
  const usable = (p) => !skip.has(p.toString()) && isSource(bot.blockAt(p)) && u.isClear(bot.blockAt(p.offset(0, 1, 0)))
  // many: in a lake the nearest thousands of water blocks can all be under water (only the top layer is reachable)
  let candidates = only
    ? only.map((p) => u.vec(p))
    : u.findBlocks(bot, names, { maxDistance, count: 32768, point: near, filter: (b) => usable(b.position) }).map((b) => b.position)
  // water: a lake under the open sky first (a cave's water is a walk through the dark, next to its lava)
  if (!only && liquid === 'water') {
    const sky = candidates.slice(0, 2000).filter((p) => openSky(worldOf(bot), p))
    if (sky.length) candidates = sky
  }
  const started = Date.now()
  const failed = []
  const skipped = []
  let lastErr = null
  let walks = 0
  while (walks < tries && Date.now() - started < timeout) {
    u.throwIfAborted(signal)
    const me = bot.entity.position
    const left = candidates.filter((p) => usable(p) && !failed.some((f) => f.distanceTo(p) <= spread))
    if (!left.length) break
    left.sort((a, b) => a.distanceTo(me) - b.distanceTo(me))
    const p = left[0]
    walks++
    const t = Date.now()
    try {
      // lava: from a cell with no lava, no hole of the pool and no drop beside it (N1M3 #1 walked into the pool at 8 hp;
      // N1 seed 35 slid off a rim into a taken source's hole)
      const goal = liquid === 'lava' ? lavaSafeGoal(bot, p, goals, { avoid }) : reachGoal(p, goals)
      await u.goto(bot, goal, { signal, timeout: Math.max(5000, Math.min(45000, timeout - (Date.now() - started))), retries: 1 })
      await settle(bot, { signal })
      const block = bot.blockAt(p)
      if (!isSource(block)) {
        skip.add(p.toString())
        skipped.push(`${p} gone (${block?.name})`)
        continue
      }
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0)
      const reach = eye.distanceTo(p.offset(0.5, 0.5, 0.5))
      if (reach > 5.0) {
        skip.add(p.toString())
        skipped.push(`${p} out of reach (${reach.toFixed(1)} from ${bot.entity.position.floored()})`)
        u.log(bot, `${liquid} source ${p}: out of reach after the walk (${reach.toFixed(1)} blocks from ${bot.entity.position.floored()})`)
        continue
      }
      const before = u.count(bot, filled)
      const others = { water_bucket: u.count(bot, 'water_bucket'), lava_bucket: u.count(bot, 'lava_bucket') }
      await holdBucket(bot, 'bucket', { guard, signal })
      await bot.activateBlock(block)
      await waitCount(bot, filled, before + 1, { timeout: 3000, signal }).catch((err) => {
        // the click used another bucket (the hand changed under it): say so, it explains the liquid where it should not be
        for (const [k, n] of Object.entries(others)) if (u.count(bot, k) < n) u.log(bot, `bucket desync: a ${k} was used on ${p} instead of the empty bucket`)
        throw err
      })
      u.log(bot, `filled a ${filled} at ${p} from ${bot.entity.position.floored()}`)
      return p
    } catch (err) {
      if (signal?.aborted) throw err
      lastErr = err
      skip.add(p.toString())
      // a quick "no path" is about that one block; a walk that stalled or ran out of time is about that whole edge
      if (Date.now() - t > 10000) failed.push(p)
      const fire = u.findBlocks(bot, ['fire'], { maxDistance: 8, count: 64 }).length
      u.log(bot, `${liquid} source ${p}: ${err.message} (bot at ${bot.entity.position.floored()} in ${bot.blockAt(bot.entity.position.floored())?.name}, ${fire} fire blocks within 8)`)
    }
  }
  if (!walks) throw new Error(`no reachable ${liquid} source ${only ? 'left in the pool' : `within ${maxDistance} blocks`}`)
  throw new Error(`could not fill a bucket with ${liquid} (${walks} sources tried in ${Math.round((Date.now() - started) / 1000)} s): ${lastErr?.message ?? (skipped.slice(0, 3).join(', ') || 'none in reach')}`)
}

/** whether lava is next to (or under) a feet cell, diagonals included */
function lavaAround (bot, feet) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const dy of [-1, 0]) if (u.isLava(bot.blockAt(feet.offset(dx, dy, dz)))) return true
    }
  }
  return false
}

/**
 * A pathfinder goal: the source `p` within bucket reach of the eyes (≤ `reach` to its centre) — not just near the cell
 * above it: a pool in a dip has banks 3–4 blocks higher, and "within 2.5–3 of the cell above" stood the bot on the bank
 * 4.8–5.5 blocks from every source (N1M5 #1 / #3, N1M3 #1: "none in reach") — on a cell with no lava around it (a bot
 * at the rim walked into the pool at 8 hp: N1M3 #1).
 */
function lavaSafeGoal (bot, p, goals, { reach = 4.0, avoid = null } = {}) {
  const target = u.vec(p).offset(0.5, 0.5, 0.5)
  const goal = new goals.GoalNear(p.x, p.y + 1, p.z, 4) // its heuristic: the distance to the cell above the source
  goal.isEnd = (node) => {
    const n = new Vec3(node.x, node.y, node.z)
    return n.offset(0.5, 1.62, 0.5).distanceTo(target) <= reach && !lavaAround(bot, n) && !dropBeside(bot, n) &&
      !(avoid && nearCells(avoid, n))
  }
  return goal
}

/** a cell of `cells` (keys "(x, y, z)") at or next to the feet cell `n` or under them (diagonals included) */
function nearCells (cells, n) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const dy of [-2, -1, 0]) if (cells.has(n.offset(dx, dy, dz).toString())) return true
    }
  }
  return false
}

/**
 * A drop of 2+ blocks next to the feet cell `n` (diagonals included): the bot's momentum at the end of a walk carried
 * it off such a rim into the hole a taken source left, and lava flowed in (N1 seed 35, every run at 90 s)
 */
function dropBeside (bot, n) {
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      if (!dx && !dz) continue
      const c = n.offset(dx, 0, dz)
      if (u.isClear(bot.blockAt(c)) && !u.isSolid(bot.blockAt(c.offset(0, -1, 0))) && !u.isSolid(bot.blockAt(c.offset(0, -2, 0)))) return true
    }
  }
  return false
}

/** stop and let the bot come to rest (its momentum at the end of a walk) — at most `ms` */
async function settle (bot, { signal, ms = 600 } = {}) {
  try { bot.clearControlStates() } catch {}
  await u.waitFor(() => bot.entity.onGround && Math.hypot(bot.entity.velocity?.x ?? 0, bot.entity.velocity?.z ?? 0) < 0.02, { timeout: ms, interval: 50, signal }).catch((err) => { if (signal?.aborted) throw err })
}

/** the same reach test for water (a lake's bank) */
function reachGoal (p, goals, { reach = 4.0 } = {}) {
  const target = u.vec(p).offset(0.5, 0.5, 0.5)
  const goal = new goals.GoalNear(p.x, p.y + 1, p.z, 4)
  goal.isEnd = (node) => new Vec3(node.x + 0.5, node.y + 1.62, node.z + 0.5).distanceTo(target) <= reach
  return goal
}

/**
 * A water bucket in the inventory: the nearest reachable water (from the surface), else at the `hints` (known lakes).
 * Bounded by `timeout`.
 */
async function ensureWaterBucket (bot, { signal, guard, hints = [], timeout = 240000 } = {}) {
  if (u.count(bot, 'water_bucket') > 0) return
  if (u.count(bot, 'bucket') === 0) throw new Error('no bucket for water')
  const started = Date.now()
  const left = () => Math.max(10000, timeout - (Date.now() - started))
  let first = null
  try {
    await fillBucket(bot, 'water', { signal, guard, timeout: hints.length ? left() / 2 : left() })
    return
  } catch (err) {
    if (signal?.aborted) throw err
    first = err
  }
  for (const h of hints) {
    if (Date.now() - started > timeout) break
    u.log(bot, `portal: water at the known lake ${JSON.stringify(u.plain(h))}`)
    try {
      await travelTo(bot, h, 6, { signal, timeout: left() })
      await fillBucket(bot, 'water', { signal, guard, near: h, maxDistance: 48, timeout: left() })
      return
    } catch (err) {
      if (signal?.aborted) throw err
      u.log(bot, `portal: water at ${JSON.stringify(u.plain(h))}: ${err.message}`)
    }
  }
  throw new Error(`no water bucket: ${first?.message}`)
}

/** the lava pools in the loaded chunks, ranked (best first) */
function loadedPools (bot, { need = 1, bad = new Set(), maxDistance = 128 } = {}) {
  const lava = u.findBlocks(bot, ['lava', 'flowing_lava'], { maxDistance, count: 12000 }).map((b) => b.position)
  return rankPools(lavaPools(worldOf(bot), lava), { from: bot.entity.position, need, bad })
}

/**
 * Natural obsidian (where water met lava: cave pools, ruined portals, …) mined with the diamond pickaxe: only blocks
 * with solid ground under them and no lava around (the drop must not fall or flow into lava), never obsidian the bot
 * placed or a portal it used. @returns {Promise<number>} obsidian mined
 */
async function mineWorldObsidian (bot, n, { signal, guard, deadline = Infinity, maxDistance = 64, bad = new Set(), keep = [] } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const portals = memory.memoryOf(bot).portals.filter((q) => q.dimension === bot.game.dimension).map((q) => u.vec(q.position))
  const kept = new Set(keep.map((q) => u.vec(q).floored().toString()))
  const ok = (b) => {
    const p = b.position
    if (bad.has(p.toString()) || kept.has(p.toString()) || memory.placedByBot(bot, p)) return false
    if (portals.some((q) => q.distanceTo(p) <= 6)) return false
    const below = bot.blockAt(p.offset(0, -1, 0))
    if (!u.isSolid(below) && below?.name !== 'obsidian') return false
    if (u.nearLava(bot, p, 1)) return false
    return [UP, ...DIRS].some((d) => u.isClear(bot.blockAt(p.plus(d))))
  }
  let mined = 0
  let fails = 0
  while (u.count(bot, 'obsidian') < n && fails < 4 && Date.now() < deadline) {
    u.throwIfAborted(signal)
    const [b] = u.findBlocks(bot, 'obsidian', { maxDistance, count: 256, filter: ok })
    if (!b) break
    const p = b.position
    const before = u.count(bot, 'obsidian')
    u.log(bot, `portal: natural obsidian at ${p}`)
    try {
      await u.fightGuarded(guard, () => u.goto(bot, new goals.GoalGetToBlock(p.x, p.y, p.z), { signal, timeout: 60000, retries: 1 }))
      await u.fightGuarded(guard, () => u.digBlock(bot, bot.blockAt(p), { signal, requireHarvest: true }))
      await u.waitForBlock(bot, p, (x) => x.name !== 'obsidian', { timeout: 3000, signal })
      await u.collectDrops(bot, p, { radius: 3, names: ['obsidian'], timeout: 10000, signal })
      if (u.count(bot, 'obsidian') > before) {
        mined++
        fails = 0
      } else {
        bad.add(p.toString())
        fails++
      }
    } catch (err) {
      if (signal?.aborted) throw err
      bad.add(p.toString())
      fails++
      u.log(bot, `portal: natural obsidian at ${p}: ${err.message}`)
    }
  }
  return mined
}

/**
 * Cast obsidian at one pool until `n` are carried. Returns (never loops forever) when the pool stops giving obsidian:
 * none for `stallMs`, the pool's reachable sources used up / out of reach, no mold site, 6 failed casts, or the
 * deadline. @returns {Promise<{ progress: number, reason: string|null }>}
 */
async function castAtPool (bot, pool, n, ctx) {
  const { signal, guard, stallMs, castMs, state, result, waterHints } = ctx
  const { goals } = u.ensurePathfinder(bot)
  const have = () => u.count(bot, 'obsidian')
  let progress = 0
  let lastProgress = Date.now()
  let failures = 0
  let interruptions = 0
  let lastLava = null
  let mold = null
  const done = (reason) => ({ progress, reason })
  // every walk at this pool keeps off its cells and its rim: a source taken with a bucket leaves a dry dip — walkable to
  // the pathfinder, with no lava next to it once its neighbours are taken too — until the pool's lava flows back in
  // (N1 seed 35 #1 / #2 and N1M5 #5: "tried to swim in lava" walking between two fills)
  const cells = poolCells(pool)
  const offPool = poolExclusion(bot, pool, cells)
  const stopLavaWatch = lavaWatch(bot, guard, cells)
  // BEDBOO_PORTAL_TRACE=1: where the bot stands every 500 ms while casting (debugging walks near the pool)
  const trace = process.env.BEDBOO_PORTAL_TRACE
    ? setInterval(() => { const f = bot.entity?.position?.floored(); if (f) u.log(bot, `trace ${bot.entity.position.x.toFixed(2)},${bot.entity.position.y.toFixed(2)},${bot.entity.position.z.toFixed(2)} feet ${bot.blockAt(f)?.name} below ${bot.blockAt(f.offset(0, -1, 0))?.name} goal ${bot.pathfinder?.goal ? 'set' : '-'}`) }, 500)
    : null
  try {
    return await castLoop()
  } finally {
    clearInterval(trace)
    stopLavaWatch()
    offPool.remove()
  }

  async function castLoop () {
  // far away (a scouted pool, the other side of a hill): there first
    const nearest = pool.reachable.slice().sort((a, b) => a.distanceTo(bot.entity.position) - b.distanceTo(bot.entity.position))[0]
    if (nearest && bot.entity.position.distanceTo(nearest) > 24) {
      u.log(bot, `portal: to the lava pool at ${nearest}`)
      try {
        await u.fightGuarded(guard, () => travelTo(bot, nearest, 6, { signal, timeout: Math.max(10000, Math.min(180000, ctx.deadline - Date.now())) }), { deadline: ctx.deadline })
      } catch (err) {
        if (signal?.aborted) throw err
        return done(`could not get to it: ${err.message}`)
      }
    }
    while (have() < n) {
      u.throwIfAborted(signal)
      if (Date.now() > ctx.deadline) return done('out of time')
      if (Date.now() - lastProgress > stallMs) return done(`no new obsidian for ${Math.round(stallMs / 1000)} s`)
      await feed(bot, { signal })
      if (guard) await guard.idle()
      const paused = await lowHealthPause(bot, { guard, signal, nightMs: ctx.nightWaitLeft() })
      if (paused.healed || paused.sheltered) lastProgress += paused.ms // healing / the night is not a stalled pool
      if (paused.sheltered) ctx.extend(paused.ms)
      // a trip: fill every empty bucket with lava (one bucket carries the water)
      if (u.count(bot, 'lava_bucket') === 0) {
        if (u.count(bot, 'bucket') === 0) {
        // a second water bucket (a refill while the first was out): empty it next to the bot
          if (u.count(bot, 'water_bucket') < 2 || !await pourOut(bot, { signal, guard })) {
            state.broken = 'no empty bucket left for lava (every bucket holds water)'
            return done(state.broken)
          }
        }
        const wanted = Math.max(1, Math.min(u.count(bot, 'bucket'), n - have()))
        for (let i = 0; i < wanted && u.count(bot, 'bucket') > 0; i++) {
          try {
            try {
              lastLava = await u.fightGuarded(guard, () => fillBucket(bot, 'lava', { signal, guard, sources: pool.sources, skip: state.skip, tries: 4, avoid: cells, timeout: Math.max(10000, Math.min(120000, ctx.deadline - Date.now())) }), { deadline: ctx.deadline })
            } finally {
              // standing down in the pool's footprint (a hole a taken source left): out of it before the pool's lava
              // flows back in — after a failed fill too
              await leavePoolLevel(bot, cells, { signal })
            }
          } catch (err) {
            if (signal?.aborted) throw err
            if (i === 0) return done(`lava: ${err.message}`)
            break
          }
        }
        result.trips++
      }
      if (!mold) {
        const lava = u.findBlocks(bot, ['lava', 'flowing_lava'], { maxDistance: 24, count: 1024, point: lastLava ?? bot.entity.position }).map((b) => b.position)
        mold = planMold(worldOf(bot), lava, { near: lastLava ?? bot.entity.position, exclude: state.badMolds })
        if (!mold) return done(`no flat ground for a mold near the lava at ${lastLava}`)
        result.mold = { mold: u.plain(mold.mold), water: u.plain(mold.water), stand: u.plain(mold.stand) }
        u.log(bot, `mold at ${mold.mold} (lava ${mold.lavaDistance.toFixed(1)} blocks away), water at ${mold.water}`)
      }
      while (u.count(bot, 'lava_bucket') > 0 && have() < n) {
        if (Date.now() - lastProgress > stallMs || Date.now() > ctx.deadline) break
        let fought = false
        const onBusy = () => { if (u.busyKind(guard) !== 'eat') fought = true }
        guard?.on('busy', onBusy)
        const cast = u.deadlineSignal(signal, castMs)
        try {
          if (guard) await guard.idle()
          await feed(bot, { signal })
          await castOne(bot, mold, { signal: cast.signal, goals, guard })
          result.cast++
          progress++
          lastProgress = Date.now()
          failures = 0
          u.log(bot, `obsidian ${have()}/${n}`)
        } catch (err) {
          if (signal?.aborted) throw err
          const msg = cast.timedOut ? `the cast took over ${Math.round(castMs / 1000)} s` : err.message
          if ((fought || u.busyKind(guard) === 'fight') && interruptions < 8) {
          // a fight interrupted the cast: not the mold's fault (bounded: a guard that is never idle is a failure)
            interruptions++
            u.log(bot, `cast interrupted by a fight (${interruptions}): ${msg}`)
            await guard.idle()
            const water = await refillWater(bot, { signal, guard, waterHints })
            if (water) return done(water)
            continue
          }
          failures++
          result.failures++
          u.log(bot, `cast failed (${failures} at ${mold.mold}): ${msg}`)
          if (result.failures >= 12) {
            state.broken = `bucket casting failed ${result.failures} times (last: ${msg})`
            return done(state.broken)
          }
          // the water may be gone (flowed into the hole, picked up elsewhere): refill before the next try
          const water = await refillWater(bot, { signal, guard, waterHints })
          if (water) return done(water)
          if (failures >= 2) {
          // another spot (a hole left with lava in it stays behind: it is in the ground, it cannot spread)
            state.badMolds.add(mold.mold.toString())
            mold = null
            break
          }
        } finally {
          cast.done()
          guard?.removeListener('busy', onBusy)
        }
      }
    }
    return done(null)
  }
}

/**
 * Out of lava when nothing else gets the bot out: the Agent's safety does it ('lava'); without an Agent (U18's harness,
 * combat.defend's guard) nobody did — N1 seed 35 stood 4 s in the lava retrying its fills. Every 100 ms: in lava →
 * stop, jump towards the nearest standable cell with no lava. @returns {() => void} stop
 */
function lavaWatch (bot, guard, cells = new Set()) {
  if (guard?.delegated) return () => {}
  let escaping = false
  let stopped = false
  const live = () => !stopped
  // U18's own guard (combat.defend) is marked busy while the bot escapes: every walk waits for it (u.goto) instead of
  // re-planning over the escape's controls
  const hold = (on) => { try { if (typeof guard?._setBusy === 'function') guard._setBusy(on) } catch {} }
  const timer = setInterval(async () => {
    if (stopped || escaping || !bot.entity || bot.health <= 0) return
    const feet = bot.blockAt(bot.entity.position.floored())
    if (!bot.entity.isInLava && !u.isLava(feet)) return
    escaping = true
    hold(true)
    try {
      u.log(bot, `portal: in lava at ${bot.entity.position.floored()}: getting out`)
      u.stopMoving(bot)
      const here = bot.entity.position.floored()
      let best = null
      for (let dx = -4; dx <= 4; dx++) {
        for (let dz = -4; dz <= 4; dz++) {
          for (let dy = -1; dy <= 2; dy++) {
            const p = here.offset(dx, dy, dz)
            if (!u.isClear(bot.blockAt(p)) || !u.isClear(bot.blockAt(p.offset(0, 1, 0))) || !u.isStandable(bot.blockAt(p.offset(0, -1, 0)))) continue
            // never into another hole of the pool / next to its lava (it flows back in)
            const d = Math.hypot(dx, dz) + Math.abs(dy) + (nearCells(cells, p) || lavaAround(bot, p) ? 20 : 0)
            if (!best || d < best.d) best = { p, d }
          }
        }
      }
      for (let i = 0; i < 60 && live() && bot.health > 0; i++) {
        const f = bot.blockAt(bot.entity.position.floored())
        if (!bot.entity.isInLava && !u.isLava(f)) break
        try { bot.pathfinder?.setGoal(null) } catch {}
        if (best) await bot.lookAt(best.p.offset(0.5, 1.6, 0.5), true)
        bot.setControlState('forward', !!best)
        bot.setControlState('jump', true)
        await u.tick(bot)
      }
    } catch {} finally {
      if (!stopped) { try { bot.clearControlStates() } catch {} }
      hold(false)
      escaping = false
    }
  }, 100)
  return () => {
    stopped = true
    clearInterval(timer)
  }
}

/** feet at / below the lava's level inside the pool's footprint (a taken source's hole): to a cell off the pool */
async function leavePoolLevel (bot, cells, { signal } = {}) {
  if (!bot.entity || bot.health <= 0) return
  const feet = bot.entity.position.floored()
  const inPool = [0, -1].some((dy) => cells.has(feet.offset(0, dy, 0).toString()))
  if (!inPool) return
  const { goals } = u.ensurePathfinder(bot)
  const goal = new goals.GoalNear(feet.x, feet.y + 1, feet.z, 5)
  goal.isEnd = (node) => {
    const n = new Vec3(node.x, node.y, node.z)
    return !nearCells(cells, n) && !lavaAround(bot, n) && !dropBeside(bot, n)
  }
  u.log(bot, `portal: standing in the pool's footprint at ${feet}: stepping out`)
  await u.goto(bot, goal, { signal, timeout: 15000, retries: 1 }).catch((err) => { if (signal?.aborted) throw err; u.log(bot, `portal: out of the pool: ${err.message}`) })
  await settle(bot, { signal })
}

/** the pool's footprint: its lava blocks when it was ranked (sources taken since included), as cell keys */
function poolCells (pool) {
  return new Set((pool.blocks ?? pool.sources ?? []).map((p) => u.vec(p).floored().toString()))
}

/**
 * A pathfinder step cost (1000) for the cells of `pool` (its lava when it was ranked, sources taken since included) and
 * the cells next to / above them, and for any cell with lava beside or under it. @returns {{ remove: () => void }}
 */
function poolExclusion (bot, pool, cells = poolCells(pool)) {
  const { movements } = u.ensurePathfinder(bot)
  // the footprint's box, 3 blocks around: everything outside costs nothing (the long walks to and from the pool)
  const pts = [...(pool.blocks ?? pool.sources ?? [])].map((p) => u.vec(p))
  const box = pts.length
    ? pts.reduce((b, p) => ({ x0: Math.min(b.x0, p.x - 3), x1: Math.max(b.x1, p.x + 3), y0: Math.min(b.y0, p.y - 3), y1: Math.max(b.y1, p.y + 3), z0: Math.min(b.z0, p.z - 3), z1: Math.max(b.z1, p.z + 3) }), { x0: Infinity, x1: -Infinity, y0: Infinity, y1: -Infinity, z0: Infinity, z1: -Infinity })
    : null
  const cost = (block) => {
    const p = block?.position
    if (!p || !box) return 0
    if (p.x < box.x0 || p.x > box.x1 || p.y < box.y0 || p.y > box.y1 || p.z < box.z0 || p.z > box.z1) return 0
    return nearCells(cells, p) || lavaAround(bot, p) ? 1000 : 0
  }
  if (movements?.exclusionAreasStep) movements.exclusionAreasStep.push(cost)
  return {
    remove () {
      const i = movements?.exclusionAreasStep?.indexOf(cost) ?? -1
      if (i >= 0) movements.exclusionAreasStep.splice(i, 1)
    }
  }
}

/**
 * Hurt badly (health ≤ `below`): no trip along the lava while mobs are around — eat, let the guard deal with what is
 * near, and wait (bounded by `maxMs`) for the health to come back. @returns {Promise<number>} ms waited
 */
async function lowHealthPause (bot, { guard, signal, below = 10, until = 14, maxMs = 30000, nightMs = 0 } = {}) {
  if (bot.health > below) return { ms: 0, healed: false, sheltered: false }
  const t = Date.now()
  const from = bot.health
  u.log(bot, `portal: health ${bot.health}, food ${bot.food}: pausing up to ${Math.round(maxMs / 1000)} s`)
  u.stopMoving(bot)
  // away from the lava first (a knockback or a misstep at the rim is the end at this health)
  if (u.nearLava(bot, bot.entity.position.floored(), 3)) {
    const { goals } = u.ensurePathfinder(bot)
    const lava = u.findBlocks(bot, ['lava', 'flowing_lava'], { maxDistance: 6, count: 64 }).map((b) => b.position)
    if (lava.length) {
      const c = lava.reduce((a, q) => a.plus(q), new Vec3(0, 0, 0)).scaled(1 / lava.length)
      const away = bot.entity.position.minus(c)
      const d = away.norm() > 0.1 ? away.normalize().scaled(8) : new Vec3(8, 0, 0)
      const to = bot.entity.position.plus(d)
      await u.goto(bot, new goals.GoalNearXZ(to.x, to.z, 2), { signal, timeout: 15000, retries: 0 }).catch((err) => { if (signal?.aborted) throw err })
    }
  }
  // hurt at night without armor: out of the mobs' reach until the morning (U17's shelter or a pocket / pit)
  if (nightMs > 0 && shelter.ticksToNight(bot) === 0 && shelter.armorWorn(bot) < 2) {
    return shelterPause()
  }
  // nothing to eat and too hungry to regenerate: waiting heals nothing (N1M3: 30 s before each of ten casts)
  const ae = bot.autoEat
  const edible = typeof ae?.findBestChoices === 'function' ? ae.findBestChoices(bot.inventory.items(), ae.opts?.priority ?? 'foodPoints').length > 0 : !!u.findItem(bot, u.FOODS)
  if (bot.food < 18 && !edible) {
    u.log(bot, `portal: health ${bot.health}, food ${bot.food}, nothing to eat: going on`)
    return { ms: Date.now() - t, healed: false, sheltered: false }
  }
  while (bot.health < until && Date.now() - t < maxMs) {
    // health only comes back with a (nearly) full food bar: eat up to 18
    await feed(bot, { signal, min: 18 })
    if (guard) await guard.idle()
    await u.sleep(1000, signal)
  }
  return { ms: Date.now() - t, healed: bot.health >= from + 2, sheltered: false }

  async function shelterPause () {
    await shelter.untilDay(bot, { signal, guard, maxMs: nightMs, why: `health ${bot.health} at night` })
      .catch((err) => { if (signal?.aborted) throw err; u.log(bot, `portal: shelter: ${err.message}`) })
    return { ms: Date.now() - t, healed: bot.health >= from + 2, sheltered: true }
  }
}

/** a water bucket again after a cast lost it; @returns {Promise<string|null>} why not (the pool loop gives up) */
async function refillWater (bot, { signal, guard, waterHints }) {
  if (u.count(bot, 'water_bucket') > 0) return null
  try {
    await ensureWaterBucket(bot, { signal, guard, hints: waterHints, timeout: 120000 })
    return null
  } catch (err) {
    if (signal?.aborted) throw err
    return `water: ${err.message}`
  }
}

/** pour a second water bucket out on the ground two blocks away (its bucket carries lava again); false: it did not */
async function pourOut (bot, { signal, guard } = {}) {
  const feet = bot.entity.position.floored()
  for (const d of DIRS) {
    const p = feet.plus(d).plus(d)
    if (!u.isSolid(bot.blockAt(p.offset(0, -1, 0))) || bot.blockAt(p)?.name !== 'air') continue
    const before = u.count(bot, 'bucket')
    await holdBucket(bot, 'water_bucket', { guard, signal })
    await bot.placeBlock(bot.blockAt(p.offset(0, -1, 0)), UP).catch((err) => u.log(bot, `pouring water out at ${p}: ${err.message}`))
    if (await u.waitFor(() => u.count(bot, 'bucket') > before, { timeout: 2000, interval: 50, signal }).then(() => true, () => false)) return true
  }
  return false
}

/**
 * Cast `n` obsidian (in total in the inventory) with buckets next to a lava pool and mine it with a diamond pickaxe.
 *
 * Bounded at every step (chain runs 2 and 4 hung here for 13 and 12 min): up to the surface first; the pools in the
 * loaded chunks are ranked (open sky, enough sources, near) and each one is left for the next after `stallMs` without
 * a new obsidian; then the scouted pools (`lava` hints), natural obsidian (mined), a spiral walk on the surface; the
 * whole search ends at `budgetMs` with what was tried.
 * @param {object} bot
 * @param {number} n
 * @param {{ signal?: AbortSignal, guard?: object, maxDistance?: number, lava?: Array<{x,y,z}>, water?: Array<{x,y,z}>,
 *   budgetMs?: number, stallMs?: number, castMs?: number, explore?: boolean }} [opts]
 * @returns {Promise<{ obsidian, cast, mined, mold, trips, pools: object[], failures }>}
 */
async function obtainObsidian (bot, n = 10, opts = {}) {
  const { signal, guard, maxDistance = 128, lava: lavaHints = [], water: waterHints = [], budgetMs = 10 * 60 * 1000, stallMs = 150000, castMs = 120000, explore = true } = opts
  // opts.keep: obsidian blocks never to mine (the frame being completed at `origin`)
  const have = () => u.count(bot, 'obsidian')
  const result = { obsidian: have(), cast: 0, mined: 0, mold: null, trips: 0, pools: [], failures: 0 }
  if (have() >= n) return result
  if (!hasObsidianPickaxe(bot)) throw new Error('obsidian needs a diamond (or netherite) pickaxe')
  const started = Date.now()
  const state = { skip: new Set(), badMolds: new Set(), badPools: new Set(), badObsidian: new Set(), hintsTried: 0, explored: false }
  const buckets = () => u.count(bot, 'bucket') + u.count(bot, 'lava_bucket') + u.count(bot, 'water_bucket')
  const tried = []
  // the night spent in a shelter does not count against the search (up to `nightWaitMs` in all)
  const nightWaitMs = opts.nightWaitMs ?? 12 * 60 * 1000
  let waitedNight = 0
  const ctx = {
    signal,
    guard,
    deadline: started + budgetMs,
    stallMs,
    castMs,
    state,
    result,
    waterHints,
    nightWaitLeft: () => Math.max(0, nightWaitMs - waitedNight),
    extend: (ms) => { waitedNight += ms; ctx.deadline += ms }
  }
  // the work outside (up, water, a pool, ten casts: 3–5 min measured) would run into the night: wait for the morning
  // first, out of the mobs' reach (an unarmored bot at a lava pool at night: N1M3 from the M3 snapshot)
  if (opts.night !== false && nightWaitMs > 0 && shelter.nightAhead(bot, 5 * 60 * 1000)) {
    const w = await shelter.untilDay(bot, { signal, guard, maxMs: nightWaitMs, needMs: 5 * 60 * 1000, why: `night in ${Math.round(shelter.ticksToNight(bot) / 20)} s, no armor` })
      .catch((err) => { if (signal?.aborted) throw err; u.log(bot, `portal: shelter: ${err.message}`); return { waited: 0 } })
    ctx.extend(w.waited)
    result.nightWaitMs = w.waited
  }
  await toSurface(bot, { signal })
  let casting = buckets() >= 2
  if (casting) {
    try {
      await u.fightGuarded(guard, () => ensureWaterBucket(bot, { signal, guard, hints: waterHints, timeout: Math.min(240000, budgetMs / 2) }), { deadline: ctx.deadline })
    } catch (err) {
      if (signal?.aborted) throw err
      casting = false
      tried.push(`water: ${err.message}`)
      u.log(bot, `portal: no water for bucket casting (${err.message}): natural obsidian only`)
    }
  } else {
    tried.push(`${buckets()} bucket(s): no bucket casting`)
    u.log(bot, `portal: ${buckets()} bucket(s): no bucket casting, natural obsidian only`)
  }
  while (have() < n) {
    u.throwIfAborted(signal)
    if (Date.now() > ctx.deadline) break
    if (casting && state.broken) {
      casting = false
      tried.push(state.broken)
    }
    if (casting && u.count(bot, 'water_bucket') === 0) {
      const why = await refillWater(bot, { signal, guard, waterHints })
      if (why) {
        casting = false
        tried.push(why)
      }
    }
    if (casting && buckets() >= 2) {
      const [pool] = loadedPools(bot, { need: n - have(), bad: state.badPools, maxDistance })
      if (pool) {
        u.log(bot, `portal: lava pool ${pool.key} (${pool.reachable.length} sources in reach, ${pool.sky} under the sky, centre ${pool.center})`)
        const before = have()
        const r = await castAtPool(bot, pool, n, ctx)
        result.pools.push({ key: pool.key, obsidian: have() - before, reason: r.reason })
        if (r.reason) {
          tried.push(`pool ${pool.key}: ${r.reason}`)
          u.log(bot, `portal: leaving the lava pool ${pool.key} (${have() - before} obsidian there): ${r.reason}`)
          state.badPools.add(pool.key)
        }
        continue
      }
      // nothing loaded: the scouted pools next
      if (state.hintsTried < lavaHints.length) {
        const h = lavaHints[state.hintsTried++]
        u.log(bot, `portal: no usable lava pool loaded; to the known pool at ${JSON.stringify(u.plain(h))}`)
        try {
          await u.fightGuarded(guard, () => travelTo(bot, h, 8, { signal, timeout: Math.max(10000, Math.min(240000, ctx.deadline - Date.now())) }), { deadline: ctx.deadline })
        } catch (err) {
          if (signal?.aborted) throw err
          tried.push(`known pool ${JSON.stringify(u.plain(h))}: ${err.message}`)
        }
        continue
      }
    }
    // natural obsidian (also what failed casts left in their molds)
    const mined = await mineWorldObsidian(bot, n, { signal, guard, deadline: ctx.deadline, bad: state.badObsidian, keep: opts.keep ?? [] })
    result.mined += mined
    if (mined) continue
    if (explore && !state.explored && casting) {
      state.explored = true
      const ex = optional('./explore')
      if (typeof ex?.explore === 'function') {
        u.log(bot, `portal: no lava pool in reach: exploring the surface for one (pools given up: ${[...state.badPools].join(' ') || 'none'})`)
        const r = await ex.explore(bot, {
          until: () => loadedPools(bot, { need: n - have(), bad: state.badPools, maxDistance: 96 })[0] ?? null,
          maxDistance: 256,
          timeout: Math.max(10000, Math.min(240000, ctx.deadline - Date.now())),
          signal
        }).catch((err) => { if (signal?.aborted) throw err; return { found: null, error: err.message } })
        u.ensurePathfinder(bot)
        tried.push(`explored ${r.waypoints ?? 0} waypoints: ${r.found ? 'found a pool' : 'no pool'}`)
        continue
      }
    }
    break
  }
  result.obsidian = have()
  if (have() < n) {
    const why = tried.length ? tried.join('; ') : `no lava pool with reachable sources within ${maxDistance} blocks of ${bot.entity.position.floored()} and no natural obsidian`
    throw new Error(`obsidian ${have()}/${n} after ${Math.round((Date.now() - started) / 1000)} s: ${why}`)
  }
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
async function castOne (bot, mold, { signal, goals, guard }) {
  const M = mold.mold
  const W = mold.water
  const ground = M.plus(mold.dir)
  await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 60000 })
  const before = u.count(bot, 'obsidian')
  let block = bot.blockAt(M)
  if (block.name === 'obsidian') return mineMold(bot, mold, before, { signal, goals })
  // a flooded mold (the last cast's water did not drain / was not taken back): let it drain, a source is taken back
  if (u.isWater(block) || u.isWater(bot.blockAt(M.offset(0, 1, 0)))) {
    for (const p of [M, M.offset(0, 1, 0), W]) {
      const b = bot.blockAt(p)
      if (u.isWaterSource(b) && u.count(bot, 'bucket') > 0) {
        await holdBucket(bot, 'bucket', { guard, signal })
        await bot.activateBlock(b)
        await u.sleep(300, signal)
      }
    }
    await u.waitFor(() => !u.isWater(bot.blockAt(M)) && !u.isWater(bot.blockAt(M.offset(0, 1, 0))), { timeout: 6000, interval: 100, signal })
      .catch(() => { throw new Error(`the mold at ${M} is flooded`) })
    block = bot.blockAt(M)
  }
  if (!u.isClear(block) && !u.isLava(block)) {
    await u.digBlock(bot, block, { signal })
    await u.waitForBlock(bot, M, (b) => b.boundingBox === 'empty', { timeout: 3000, signal })
  }
  block = bot.blockAt(M)
  if (!u.isLavaSource(block)) {
    const lavaBuckets = u.count(bot, 'lava_bucket')
    await holdBucket(bot, 'lava_bucket', { guard, signal })
    await bot.placeBlock(bot.blockAt(M.offset(0, -1, 0)), UP)
    await u.waitForBlock(bot, M, (b) => u.isLava(b), { timeout: 3000, signal })
    await u.waitFor(() => u.count(bot, 'lava_bucket') < lavaBuckets, { timeout: 2000, interval: 50, signal }).catch((err) => {
      if (signal?.aborted) throw err
      u.log(bot, `lava poured at ${M} but the inventory still shows ${u.count(bot, 'lava_bucket')} lava buckets`)
    })
  }
  if (u.count(bot, 'water_bucket') === 0) throw new Error('no water bucket')
  // plants (flowers, grass) where the water goes would hold it / be washed away unpredictably: break them first
  for (const p of [W, M.offset(0, 1, 0)]) await clearPlant(bot, p, { signal })
  await holdBucket(bot, 'water_bucket', { guard, signal })
  await bot.placeBlock(bot.blockAt(ground), UP)
  try {
    await u.waitForBlock(bot, M, (b) => b.name === 'obsidian', { timeout: 5000, signal })
  } finally {
    // take the water back (the source; flowing water drains by itself)
    const water = bot.blockAt(W)
    if (u.isWaterSource(water) && u.count(bot, 'bucket') > 0) {
      const buckets = u.count(bot, 'water_bucket')
      await holdBucket(bot, 'bucket', { guard })
      await bot.activateBlock(water)
      await waitCount(bot, 'water_bucket', buckets + 1, { timeout: 3000 }).catch(() => {})
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
  await u.waitFor(() => !wet(), { timeout: 8000, interval: 100, signal }).catch((err) => { if (signal?.aborted) throw err })
  for (let attempt = 0; ; attempt++) {
    try {
      // standing in water / off the ground digs 5× slower: back on the stand spot first
      if (attempt > 0) await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 20000 }).catch((err) => { if (signal?.aborted) throw err })
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
    await u.goto(bot, new goals.GoalBlock(M.x, M.y, M.z), { signal, timeout: 15000, retries: 1 }).catch((err) => { if (signal?.aborted) throw err })
    await u.sleep(250, signal)
  }
  if (u.count(bot, 'obsidian') <= before) throw new Error('the obsidian drop was not picked up')
  // back out of the hole
  await u.goto(bot, new goals.GoalBlock(mold.stand.x, mold.stand.y, mold.stand.z), { signal, timeout: 30000 }).catch((err) => { if (signal?.aborted) throw err })
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
async function obtainFlint (bot, { signal, maxTries = 60, timeout = 240000 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  const started = Date.now()
  let dug = 0
  const bad = new Set()
  while (u.count(bot, 'flint') === 0) {
    u.throwIfAborted(signal)
    if (dug >= maxTries) throw new Error(`no flint after ${dug} gravel blocks`)
    if (Date.now() - started > timeout) throw new Error(`no flint after ${Math.round(timeout / 1000)} s (${dug} gravel blocks dug)`)
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
      // near the bot's level first: gravel deep below is a pit to dig and to climb out of (N1 seed 35 #2: flint from
      // 15 blocks down, then the walk back up to the frame stalled)
      const y = bot.entity.position.y
      const cost = (b) => b.position.distanceTo(bot.entity.position) + 3 * Math.max(0, y - b.position.y - 3)
      target = found.slice().sort((a, b) => cost(a) - cost(b))[0]
      u.log(bot, `flint: gravel at ${target.position} (bot at ${bot.entity.position.floored()})`)
      try {
        await u.goto(bot, new goals.GoalGetToBlock(target.position.x, target.position.y, target.position.z), { signal, timeout: Math.max(5000, Math.min(90000, timeout - (Date.now() - started))) })
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
async function ensureFlintAndSteel (bot, { signal, timeout } = {}) {
  if (u.count(bot, 'flint_and_steel') > 0) return { crafted: false }
  if (u.count(bot, 'iron_ingot') === 0) throw new Error('a flint and steel needs an iron ingot')
  const flint = await obtainFlint(bot, { signal, timeout })
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
    if (step.block === 'obsidian') memory.rememberPlaced(bot, step.pos)
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
  // down in a gravel pit after the flint: up first (a straight walk out of a 1×1 shaft stalls)
  if (bot.entity.position.y < spot.y - 4) await toSurface(bot, { signal })
  const goSpot = () => u.goto(bot, new goals.GoalBlock(spot.x, spot.y, spot.z), { signal, timeout: 120000, stallMs: 20000 })
  try {
    await goSpot()
  } catch (err) {
    if (signal?.aborted || !/stalled/.test(err.message)) throw err
    // stood still in the flint's pit, 2–3 deep (a final chain run: 30 s at the bottom, then the whole N1M3 failed): the
    // pathfinder stopped for good (a failed placement leaves it hanging), the bot's own staircase steps out, again
    u.log(bot, `portal: to the frame: ${err.message}; climbing out first`)
    u.stopMoving(bot)
    const survive = optional('./survive')
    // the frame (and its inside) is never a step of that staircase: a protected zone of the Agent while it climbs
    const zones = optional('../skill')?.agentOf?.(bot)?.state?.protectedZones
    const cells = [...(frame.frame ?? []), ...(frame.interior ?? [])].map(u.vec)
    const zone = cells.length
      ? { name: 'nether portal frame', min: { x: Math.min(...cells.map((c) => c.x)), y: Math.min(...cells.map((c) => c.y)), z: Math.min(...cells.map((c) => c.z)) }, max: { x: Math.max(...cells.map((c) => c.x)), y: Math.max(...cells.map((c) => c.y)), z: Math.max(...cells.map((c) => c.z)) } }
      : null
    if (zones && zone) zones.push(zone)
    try {
      for (let i = 0; i < 6 && bot.entity.position.y < spot.y && typeof survive?.stairStepUp === 'function'; i++) {
        if (!await survive.stairStepUp(bot, signal).catch((e) => { if (signal?.aborted) throw e; return false })) break
      }
    } finally {
      if (zones && zone) zones.splice(zones.indexOf(zone), 1)
    }
    await goSpot()
  }
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

/** pathfinder into the portal block at `target` (a Movements copy that does not avoid portal blocks) */
async function intoPortal (bot, target, { signal } = {}) {
  const { goals, movements } = u.ensurePathfinder(bot)
  const pf = require('mineflayer-pathfinder')
  const m = new pf.Movements(bot)
  Object.assign(m, { canDig: false, allowParkour: false, maxDropDown: 3, scafoldingBlocks: movements.scafoldingBlocks, infiniteLiquidDropdownDistance: false })
  for (const id of movements.blocksToAvoid) m.blocksToAvoid.add(id)
  m.blocksToAvoid.delete(bot.registry.blocksByName.portal.id)
  try {
    await u.goto(bot, new goals.GoalBlock(target.x, target.y, target.z), { signal, timeout: 15000, retries: 0, movements: m })
  } finally {
    bot.pathfinder.setMovements(movements)
  }
}

/** the blocks around a portal block (diagnostics) */
function describeAround (bot, p) {
  const out = []
  for (let dy = -1; dy <= 2; dy++) {
    const row = []
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) row.push((bot.blockAt(p.offset(dx, dy, dz))?.name ?? '?').slice(0, 6))
    out.push(`y${p.y + dy}: ${row.join(' ')}`)
  }
  return out.join(' | ')
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
      await u.tick(bot)
    }
    bot.setControlState('jump', false)
    // stand still in the centre of the portal block (pushing forward could walk through it)
    for (let i = 0; i < 10 && bot.game.dimension === from; i++) {
      const c = target.offset(0.5, 0, 0.5)
      const d = c.minus(bot.entity.position)
      if (Math.hypot(d.x, d.z) < 0.25) break
      await bot.lookAt(c.offset(0, bot.entity.eyeHeight, 0), true)
      await u.tick(bot)
    }
    bot.setControlState('forward', false)
    if (!inside() && bot.game.dimension === from) {
      // walking straight in did not work (a step, a slab, a bump in the way): let the pathfinder take the bot into the
      // portal block itself (its movements avoid portals: a copy that does not)
      u.log(bot, `portal: could not walk into ${target} from ${bot.entity.position.floored()}, pathfinding in`)
      await intoPortal(bot, target, { signal }).catch((err) => u.log(bot, `portal: ${err.message}`))
      if (!inside() && bot.game.dimension === from) {
        u.log(bot, `portal: around ${target}: ${describeAround(bot, target)}`)
        continue
      }
    }
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
 *   enter?: boolean (true), guard?: boolean (true), lava?: [{x,y,z}] (known lava pools: scouted / remembered),
 *   water?: [{x,y,z}] (known lakes), obsidianMs?: number (10 min: the obsidian search's budget), stallMs?: number
 *   (150 s without a new obsidian: the next pool), flintMs?: number (4 min) }`
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
    let keep = []
    if (origin) {
      const plan = planPortalFrame(origin, axis ?? 'x', { obsidian: needed })
      needed = Math.min(needed, plan.frame.filter((p) => bot.blockAt(p)?.name !== 'obsidian').length)
      keep = plan.frame
    }
    let t = Date.now()
    // bounded by its own budget, fights handled inside (not started over after one)
    result.obsidian = await obtainObsidian(bot, needed, {
      signal,
      guard,
      lava: args.lava ?? [],
      water: args.water ?? [],
      budgetMs: args.obsidianMs ?? 10 * 60 * 1000,
      stallMs: args.stallMs ?? 150000,
      keep
    })
    timings.obsidianMs = Date.now() - t
    t = Date.now()
    // the site is chosen once: a retry after a fight goes on with the half-built frame
    const site = origin
      ? { base: u.vec(origin), axis: axis ?? 'x', side: args.side ?? 1 }
      : findPortalSite(worldOf(bot), bot.entity.position, { radius: 20 })
    if (!site) throw new Error(`no flat site for a portal around ${bot.entity.position.floored()}`)
    frame = await u.fightGuarded(guard, () => buildPortal(bot, { origin: site.base, axis: site.axis, side: site.side, signal }))
    timings.buildMs = Date.now() - t
    t = Date.now()
    const flint = { crafted: false, gravelDug: 0 }
    if (!frame.interior.every((p) => bot.blockAt(p)?.name === 'portal')) {
      const flintDeadline = Date.now() + (args.flintMs ?? 240000)
      await u.fightGuarded(guard, async () => {
        const r = await ensureFlintAndSteel(bot, { signal, timeout: Math.max(10000, flintDeadline - Date.now()) })
        if (r.crafted) Object.assign(flint, { crafted: true, gravelDug: r.gravelDug ?? 0 })
      }, { deadline: flintDeadline })
    }
    timings.flintMs = Date.now() - t
    t = Date.now()
    const lit = await u.fightGuarded(guard, () => lightPortal(bot, frame, { signal }))
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
  clusterPositions,
  lavaPools,
  rankPools,
  openSky,
  obtainObsidian,
  castAtPool,
  mineWorldObsidian,
  loadedPools,
  toSurface,
  feed,
  travelTo,
  holdBucket,
  lowHealthPause,
  lavaSafeGoal,
  dropBeside,
  reachGoal,
  poolExclusion,
  poolCells,
  nearCells,
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
