// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * End skill: fill the stronghold's end portal frames with eyes of ender, jump in, fight endermen in The End, leave
 * through the exit portal (credits acknowledged by mineflayer-bedrock) back to the overworld. The skill itself is
 * cheat-free; the cheat-assisted parts of the End milestone are scenario setup steps (documented in
 * docs/differences/U18.md): locating the stronghold (`/locate`) and teleporting the bot into its portal room, the
 * eyes of ender (`/give`), and killing the ender dragon (`/kill @e[type=ender_dragon]`) so the exit portal opens.
 *
 * Phases (`args.phase`, default all three in order):
 * - `activate`: every end_portal_frame within 24 blocks that has no eye gets one (`bot.activateBlock(frame)` with an
 *   ender eye in the hand — the bot's own action), the 3×3 end portal appears, the bot climbs onto the ring and steps
 *   in → The End;
 * - `fight`: hunt `args.endermen` (2) endermen (provoked by the first hit; they are never shot: arrows do not hurt
 *   them), defend.() retaliates against anything else;
 * - `exit`: walk to the exit portal (the bedrock fountain around (0, y, 0); it only opens after the dragon died) and
 *   step in → credits → overworld.
 *
 * args:   { phase?: 'activate'|'fight'|'exit', endermen?: number, exitTimeout?: number } (+ `signal`)
 * result: { entered: boolean, eyes: number, killed: { enderman: n }, exited: boolean, timings }
 */
const { Vec3 } = require('vec3')
const u = require('../dims/util')
const combat = require('./combat')

/** horizontal neighbours */
const SIDES = [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)]

function hasEye (block) {
  const p = block?.getProperties?.() ?? {}
  return p.end_portal_eye_bit === true || p.end_portal_eye_bit === 1 || p.eye === true || p.eye === 'true'
}

/** the 12 frames of the portal nearest to the bot (within `maxDistance`) and the ring's centre */
function portalRing (bot, { maxDistance = 24 } = {}) {
  const frames = u.findBlocks(bot, 'end_portal_frame', { maxDistance, count: 64 })
  if (frames.length < 12) return null
  // the ring of the nearest frame: frames on its y within 5 blocks of it (a stronghold has one portal room)
  const first = frames[0].position
  const ring = frames.filter((b) => b.position.y === first.y && b.position.distanceTo(first) <= 6)
  if (ring.length < 12) return null
  const center = ring.reduce((a, b) => a.plus(b.position), new Vec3(0, 0, 0)).scaled(1 / ring.length)
  return { frames: ring.slice(0, 12), center: new Vec3(Math.round(center.x * 2) / 2, first.y, Math.round(center.z * 2) / 2), y: first.y }
}

/**
 * The face of the block at `p` the bot looks at (top when its eyes are above the block's `height`, else the side
 * towards it) and the click point on it, for `activateBlock(block, face, cursor)`.
 */
function facingFace (bot, p, height = 1) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
  if (eye.y > p.y + height + 0.1) return { face: new Vec3(0, 1, 0), cursor: new Vec3(0.5, height, 0.5) }
  const dx = eye.x - (p.x + 0.5)
  const dz = eye.z - (p.z + 0.5)
  const y = Math.min(height, 1) / 2
  if (Math.abs(dx) >= Math.abs(dz)) return dx > 0 ? { face: new Vec3(1, 0, 0), cursor: new Vec3(1, y, 0.5) } : { face: new Vec3(-1, 0, 0), cursor: new Vec3(0, y, 0.5) }
  return dz > 0 ? { face: new Vec3(0, 0, 1), cursor: new Vec3(0.5, y, 1) } : { face: new Vec3(0, 0, -1), cursor: new Vec3(0.5, y, 0) }
}

/**
 * Put an eye of ender into every frame of the ring that lacks one. @returns {Promise<{ eyes: number, portal: number }>}
 */
async function activatePortal (bot, { signal, guard } = {}) {
  const { goals, movements } = u.ensurePathfinder(bot)
  const ring = portalRing(bot)
  if (!ring) throw new Error('no end portal frame ring within 24 blocks (the setup must bring the bot into the portal room)')
  // never walk on the ring: its corners are open and the inside is a drop into the lava pool under the portal
  const keepOff = (block) => {
    const p = block?.position
    if (!p) return 0
    return Math.abs(p.x + 0.5 - (ring.center.x + 0.5)) <= 2.6 && Math.abs(p.z + 0.5 - (ring.center.z + 0.5)) <= 2.6 && p.y >= ring.y - 2 && p.y <= ring.y + 3 ? 1000 : 0
  }
  movements.exclusionAreasStep.push(keepOff)
  try {
    return await fillFrames(bot, ring, { signal, guard, goals })
  } finally {
    movements.exclusionAreasStep.splice(movements.exclusionAreasStep.indexOf(keepOff), 1)
  }
}

async function fillFrames (bot, ring, { signal, guard, goals }) {
  const missing = ring.frames.filter((f) => !hasEye(bot.blockAt(f.position)))
  if (u.count(bot, 'ender_eye') < missing.length) throw new Error(`${missing.length} frames need eyes, the bot has ${u.count(bot, 'ender_eye')}`)
  u.log(bot, `end: ${missing.length} of 12 frames need an eye (ring centre ${ring.center})`)
  let eyes = 0
  // nearest first, re-sorted after every eye (the bot moves around the ring)
  const todo = new Set(missing.map((f) => f.position.toString()))
  while (todo.size) {
    u.throwIfAborted(signal)
    const next = ring.frames.filter((f) => todo.has(f.position.toString()))
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0]
    const p = next.position
    await combat.guarded(guard, async () => {
      for (let attempt = 0; ; attempt++) {
        const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
        // from the stairs the frame's top is in view, from the room's floor its side (facingFace)
        if (attempt > 0 || eye.distanceTo(p.offset(0.5, 0.5, 0.5)) > 4) {
          await u.goto(bot, new goals.GoalNear(p.x, p.y, p.z, attempt > 0 ? 2 : 3), { signal, timeout: 60000 })
        }
        await u.equipItem(bot, 'ender_eye')
        const { face, cursor } = facingFace(bot, p, 0.8125)
        await bot.activateBlock(bot.blockAt(p), face, cursor)
        try {
          await u.waitForBlock(bot, p, hasEye, { timeout: 2500, signal })
          return
        } catch (err) {
          if (attempt >= 2 || signal?.aborted) throw err
          u.log(bot, `end: no eye in ${p} yet (bot at ${bot.entity.position.floored()}), clicking again`)
        }
      }
    })
    todo.delete(p.toString())
    eyes++
  }
  // the portal opens in the 3×3 inside the ring
  const portal = await u.waitFor(() => {
    const n = u.findBlocks(bot, 'end_portal', { maxDistance: 8, count: 16, point: ring.center }).length
    return n >= 9 ? n : 0
  }, { timeout: 5000, signal, message: 'the end portal to open' })
  u.log(bot, `end: portal open (${portal} blocks) after ${eyes} eyes`)
  return { eyes, portal, ring }
}

/** a standable feet position outside `ring`, level with the frames, next to a middle frame (a walk-in spot) */
function walkInSpot (bot, ring) {
  const spots = []
  for (const f of ring.frames) {
    const p = f.position
    for (const d of SIDES) {
      // outside the ring: farther from the centre than the frame
      if (p.plus(d).offset(0.5, 0, 0.5).xzDistanceTo(ring.center.offset(0.5, 0, 0.5)) <= p.offset(0.5, 0, 0.5).xzDistanceTo(ring.center.offset(0.5, 0, 0.5))) continue
      // level with the frames, or one up (on the stairs of a stronghold's portal room)
      for (const dy of [0, 1]) {
        const o = p.plus(d).offset(0, dy, 0)
        if (u.isClear(bot.blockAt(o)) && u.isClear(bot.blockAt(o.offset(0, 1, 0))) && u.isStandable(bot.blockAt(o.offset(0, -1, 0)))) {
          spots.push({ o, d, f: p, dy })
          break
        }
      }
    }
  }
  spots.sort((a, b) => a.dy - b.dy || a.o.distanceTo(bot.entity.position) - b.o.distanceTo(bot.entity.position))
  return spots[0] ?? null
}

/** walk towards `center` (jumping onto the frame) until the dimension changes */
async function stepInto (bot, center, from, { signal, timeout = 15000 } = {}) {
  const until = Date.now() + timeout
  try {
    while (bot.game.dimension === from && Date.now() < until) {
      u.throwIfAborted(signal)
      await bot.lookAt(center.offset(0, bot.entity.eyeHeight, 0), true)
      bot.setControlState('forward', true)
      bot.setControlState('jump', bot.entity.onGround && (bot.entity.isCollidedHorizontally || center.y > bot.entity.position.y - 0.2))
      await bot.waitForTicks(1)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
}

/** climb onto the frame ring and drop into the end portal → The End */
async function enterEndPortal (bot, ring, { signal } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  ring = ring ?? portalRing(bot)
  if (!ring) throw new Error('no end portal ring nearby')
  const spot = walkInSpot(bot, ring)
  if (!spot) throw new Error('no spot outside the ring level with the frames to walk in from')
  await u.goto(bot, new goals.GoalBlock(spot.o.x, spot.o.y, spot.o.z), { signal, timeout: 60000 })
  const arrived = u.waitForDimension(bot, 'the_end', { timeout: 30000, signal })
  arrived.catch(() => {})
  const center = ring.center.offset(0.5, 0, 0.5)
  await stepInto(bot, center, bot.game.dimension, { signal })
  await arrived
  await u.sleep(1000, signal)
  u.log(bot, `end: arrived in The End at ${bot.entity.position.floored()}`)
  return { arrival: u.plain(bot.entity.position.floored()) }
}

/** the exit portal's blocks (they appear once the dragon died) near (0, y, 0) */
function exitPortalBlocks (bot) {
  return u.findBlocks(bot, 'end_portal', { maxDistance: 32, count: 64, point: new Vec3(0, Math.floor(bot.entity.position.y), 0) })
    .filter((b) => Math.abs(b.position.x) <= 4 && Math.abs(b.position.z) <= 4)
}

/**
 * Walk to the exit portal and step in → credits (acked by mineflayer-bedrock) → overworld.
 * Waits up to `exitTimeout` for the portal to open (the dragon's death).
 */
async function exitEnd (bot, { signal, exitTimeout = 120000, guard } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  let portal = exitPortalBlocks(bot)
  if (!portal.length) {
    // get close to the fountain first (its chunks must be loaded), then wait for the portal to open
    u.log(bot, 'end: walking to the exit fountain at (0, 0)')
    await u.goto(bot, new goals.GoalNearXZ(0, 0, 6), { signal, timeout: 180000, retries: 3 }).catch((err) => u.log(bot, `end: fountain: ${err.message}`))
    portal = await u.waitFor(() => { const p = exitPortalBlocks(bot); return p.length ? p : null }, { timeout: exitTimeout, interval: 500, signal, message: 'the exit portal to open (the dragon must be dead)' })
  }
  // a rim position (standable, outside the portal) next to a portal block
  const rims = []
  for (const b of portal) {
    for (const d of SIDES) {
      for (const dy of [0, 1]) {
        const o = b.position.plus(d).offset(0, dy, 0)
        if (bot.blockAt(o)?.name === 'end_portal') continue
        if (u.isClear(bot.blockAt(o)) && u.isClear(bot.blockAt(o.offset(0, 1, 0))) && u.isStandable(bot.blockAt(o.offset(0, -1, 0)))) rims.push({ o, b: b.position })
      }
    }
  }
  if (!rims.length) throw new Error('no standable rim around the exit portal')
  rims.sort((a, b) => a.o.distanceTo(bot.entity.position) - b.o.distanceTo(bot.entity.position))
  let lastErr
  for (const rim of rims.slice(0, 4)) {
    try {
      await u.goto(bot, new goals.GoalBlock(rim.o.x, rim.o.y, rim.o.z), { signal, timeout: 120000, retries: 2 })
      // nothing may pull the bot out of its walk into the portal
      if (guard) { await guard.idle(); guard.pause() }
      const arrived = u.waitForDimension(bot, 'overworld', { timeout: 60000, signal })
      arrived.catch(() => {})
      await stepInto(bot, rim.b.offset(0.5, 0, 0.5), 'the_end', { signal, timeout: 10000 })
      await arrived
      await u.sleep(1000, signal)
      u.log(bot, `end: back in the overworld at ${bot.entity.position.floored()}`)
      return { exited: true, arrival: u.plain(bot.entity.position.floored()) }
    } catch (err) {
      if (signal?.aborted) throw err
      if (guard?.busy) throw err // a fight: guarded() runs the exit again afterwards
      lastErr = err
      u.log(bot, `end: exit via ${rim.o}: ${err.message}`)
    } finally {
      guard?.resume()
    }
  }
  throw new Error(`could not enter the exit portal: ${lastErr?.message}`)
}

/**
 * An enderman worth hunting: on the island's top (solid ground within 6 below, open sky for 8 above — not in a pocket
 * under the island) and not far above / below the bot.
 */
function onIsland (bot, e) {
  const p = e.position.floored()
  if (Math.abs(p.y - bot.entity.position.y) > 10) return false
  let ground = false
  for (let d = 1; d <= 6 && !ground; d++) {
    const b = bot.blockAt(p.offset(0, -d, 0))
    if (b && b.boundingBox === 'block') ground = true
  }
  if (!ground) return false
  for (let d = 2; d <= 9; d++) {
    const b = bot.blockAt(p.offset(0, d, 0))
    if (b && b.boundingBox === 'block' && !/obsidian|bedrock/.test(b.name)) return false
  }
  return true
}

/**
 * From the arrival platform (≈100, 49, 0: carved into the island's edge, under its surface) onto the island's top
 * near the exit fountain (0, y, 0), where the endermen roam: hops of ≤ 30 blocks (quick searches; the pathfinder
 * digs up through end stone and pillars with it).
 */
async function toIslandTop (bot, { signal, guard } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  // open sky: nothing solid over the bot (under the island's overhang the endermen up top are out of reach)
  const openSky = () => {
    const f = bot.entity.position.floored()
    for (let y = f.y + 2; y < f.y + 24; y++) if (bot.blockAt(new Vec3(f.x, y, f.z))?.boundingBox === 'block') return false
    return true
  }
  for (let hop = 0; hop < 10; hop++) {
    const p = bot.entity.position
    const d = Math.hypot(p.x, p.z)
    if (d <= 30 && openSky()) return true
    let goal
    if (d > 30) {
      const step = Math.min(30, d - 20)
      goal = new goals.GoalNearXZ(p.x - (p.x / d) * step, p.z - (p.z / d) * step, 4)
    } else {
      // up through the rock to the surface above
      const f = p.floored()
      let top = f.y
      for (let y = f.y + 24; y > f.y; y--) {
        if (bot.blockAt(new Vec3(f.x, y, f.z))?.boundingBox === 'block') { top = y; break }
      }
      goal = new goals.GoalNear(f.x, top + 1, f.z, 2)
    }
    await combat.guarded(guard, () => u.goto(bot, goal, { signal, timeout: 60000, retries: 1 }))
      .catch((err) => { if (signal?.aborted) throw err; u.log(bot, `end: towards the island top: ${err.message}`) })
  }
  return Math.hypot(bot.entity.position.x, bot.entity.position.z) <= 40 && openSky()
}

async function endSkill (bot, args) {
  args = args ?? {}
  const { signal, endermen = 2 } = args
  const phases = args.phase ? [args.phase] : ['activate', 'fight', 'exit']
  const result = { entered: bot.game.dimension === 'the_end', eyes: 0, killed: {}, exited: false, timings: {} }
  for (const phase of phases) {
    const t = Date.now()
    if (phase === 'activate') {
      if (bot.game.dimension !== 'the_end') {
        u.ensurePathfinder(bot, { fresh: true })
        // silverfish (the portal room's spawner), cave mobs: fought while the eyes go in
        const guard = combat.guardFor(bot, { radius: 6, retaliate: true, signal })
        let a
        try {
          a = await activatePortal(bot, { signal, guard })
          await guard.idle()
        } finally {
          result.guard = await guard.stop()
        }
        result.eyes = a.eyes
        const e = await enterEndPortal(bot, a.ring, { signal })
        result.entered = true
        result.arrival = e.arrival
      }
    } else if (phase === 'fight') {
      if (bot.game.dimension !== 'the_end') throw new Error('not in The End')
      // no parkour over the void
      u.ensurePathfinder(bot, { fresh: true, allowParkour: false, maxDropDown: 3 })
      const guard = combat.guardFor(bot, { radius: 8, retaliate: true, includeNeutral: false, signal })
      try {
        const t0 = Date.now()
        result.onTop = await toIslandTop(bot, { signal, guard })
        result.timings.toIslandMs = Date.now() - t0
        u.log(bot, `end: on the island at ${bot.entity.position.floored()} (${((Date.now() - t0) / 1000).toFixed(0)} s)`)
        // endermen roam the whole main island: look around waypoints near its centre (the fountain at 0, 0)
        const exploreTo = (b, hop) => {
          const a = Math.random() * Math.PI * 2
          const r = 15 + Math.random() * 35 // never into the fountain (its portal opens with the dragon's death)
          return new Vec3(Math.cos(a) * r, b.entity.position.y, Math.sin(a) * r)
        }
        const r = await combat.huntFor(bot, 'enderman', endermen, { radius: 96, signal, guard, exploreTo, filter: (e) => onIsland(bot, e), timeout: args.fightTimeout ?? 600000 })
        result.killed.enderman = r.killed
        result.fights = r.fights
      } finally {
        result.guard = await guard.stop()
      }
    } else if (phase === 'exit') {
      if (bot.game.dimension !== 'the_end') throw new Error('not in The End')
      // provoked endermen may follow the bot to the fountain
      const guard = combat.guardFor(bot, { radius: 6, retaliate: true, includeNeutral: false, signal })
      let r
      try {
        r = await combat.guarded(guard, () => exitEnd(bot, { signal, exitTimeout: args.exitTimeout, guard }), { retries: 5 })
      } finally {
        result.exitGuard = await guard.stop()
      }
      result.exited = r.exited
      result.exitArrival = r.arrival
    } else {
      throw new Error(`unknown end phase ${phase}`)
    }
    result.timings[`${phase}Ms`] = Date.now() - t
  }
  return result
}

module.exports = Object.assign(endSkill, {
  portalRing,
  facingFace,
  activatePortal,
  walkInSpot,
  enterEndPortal,
  exitPortalBlocks,
  exitEnd,
  hasEye,
  onIsland,
  toIslandTop
})
