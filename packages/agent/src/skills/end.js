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
 * - `fight`: from the arrival platform up onto the island's top (toIslandTop: bounded, another way after a stall),
 *   then hunt `args.endermen` (2) endermen (provoked by the first hit; they are never shot: arrows do not hurt them),
 *   defend.() retaliates against anything else;
 * - `exit`: walk to the exit portal (the bedrock fountain around (0, y, 0); it only opens after the dragon died) and
 *   step in → credits → overworld; endermen that follow are fought while the bot has over 10 hp, then left behind
 *   through the portal.
 *
 * args:   { phase?: 'activate'|'fight'|'exit', endermen?: number, exitTimeout?: number, fightTimeout?: number,
 *           walkMs?: number (150 s), walkStallMs?: number (15 s), walkWays?: string[] (WALK_WAYS) } (+ `signal`)
 * result: { entered: boolean, eyes: number, killed: { enderman: n }, exited: boolean, timings, walk?: { onTop, ms, hops,
 *           stalls: [{ hop, way, at, ms, error }], ways } }
 */
const { Vec3 } = require('vec3')
const u = require('../dims/util')
const combat = require('./combat')
const portal = require('./portal')
const { retaliate } = require('../dims/retaliate')

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
    await u.fightGuarded(guard, async () => {
      const reach = () => bot.entity.position.offset(0, bot.entity.eyeHeight, 0).distanceTo(p.offset(0.5, 0.5, 0.5))
      for (let attempt = 0; ; attempt++) {
        // from the stairs the frame's top is in view, from the room's floor its side (facingFace)
        if (attempt > 0 || reach() > 4) {
          try {
            await u.goto(bot, new goals.GoalNear(p.x, p.y, p.z, attempt > 0 ? 2 : 3), { signal, timeout: 60000, stallMs: 15000 })
          } catch (err) {
            // a walk that stood still (seen once: the bot on a frame after a fight with a silverfish): clicked from
            // where it is when the frame is within reach, else walked to again (another range)
            if (signal?.aborted || u.busyKind(guard) === 'fight' || attempt >= 3) throw err
            u.log(bot, `end: to the frame ${p}: ${err.message}`)
            if (reach() > 4.5) continue
          }
        }
        await u.equipItem(bot, 'ender_eye')
        const { face, cursor } = facingFace(bot, p, 0.8125)
        await bot.activateBlock(bot.blockAt(p), face, cursor)
        try {
          await u.waitForBlock(bot, p, hasEye, { timeout: 2500, signal })
          return
        } catch (err) {
          if (attempt >= 3 || signal?.aborted) throw err
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

/**
 * Walk towards `center` (jumping onto the frame) until the dimension change starts: the lifecycle's 'game' event
 * (bot.game.dimension switched) / 'spawn' end the walk — the ticks between pause while the bot changes dimension
 * (u.tick, not a bare waitForTicks, which would reject across the change). The caller awaits the arrival's spawn.
 */
async function stepInto (bot, center, from, { signal, timeout = 15000 } = {}) {
  let until = Date.now() + timeout
  try {
    while (bot.game.dimension === from && Date.now() < until) {
      u.throwIfAborted(signal)
      // a fight has the controls (the portal room's silverfish): the walk waits for it, and the time does not count
      const busy = fighting(bot)
      if (busy) {
        const t = Date.now()
        bot.setControlState('forward', false)
        bot.setControlState('jump', false)
        await busy.idle()
        until += Date.now() - t
        continue
      }
      await bot.lookAt(center.offset(0, bot.entity.eyeHeight, 0), true)
      if (bot.game.dimension !== from) break
      bot.setControlState('forward', true)
      bot.setControlState('jump', bot.entity.onGround && (bot.entity.isCollidedHorizontally || center.y > bot.entity.position.y - 0.2))
      // wakes up on the lifecycle's 'game' (the dimension switched) / 'spawn' as well as on the next tick
      await u.tick(bot)
    }
  } finally {
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
  }
}

/** the Agent's safety or a combat guard while it fights (not while it only eats), or null */
function fighting (bot) {
  const guard = u.guardOf(bot)
  if (u.busyKind(guard) === 'fight') return guard
  const safety = require('../skill').agentOf(bot)?.safety
  return safety?.busy && safety.busy.type !== 'eat' ? safety : null
}

/** climb onto the frame ring and drop into the end portal → The End */
async function enterEndPortal (bot, ring, { signal, timeout = 120000 } = {}) {
  const { goals } = u.ensurePathfinder(bot)
  ring = ring ?? portalRing(bot)
  if (!ring) throw new Error('no end portal ring nearby')
  const spot = walkInSpot(bot, ring)
  if (!spot) throw new Error('no spot outside the ring level with the frames to walk in from')
  const center = ring.center.offset(0.5, 0, 0.5)
  const from = bot.game.dimension
  const deadline = Date.now() + timeout
  // walks in until the bot is through (≤ `timeout`): a fight takes the controls on the way — the portal room's
  // silverfish spawner (FINAL-ROUND E1A run 1: two silverfish held the bot mid-walk, its one walk-in ran out, and the
  // arrival wait timed out 30 s later). The walk waits for the fight (stepInto), and a walk that did not get the bot
  // through goes again
  for (let walk = 1; ; walk++) {
    await u.goto(bot, new goals.GoalBlock(spot.o.x, spot.o.y, spot.o.z), { signal, timeout: Math.max(5000, Math.min(60000, deadline - Date.now())) })
    const arrived = u.waitForDimension(bot, 'the_end', { timeout: 30000, signal })
    arrived.catch(() => {})
    await stepInto(bot, center, from, { signal })
    try {
      await arrived
      break
    } catch (err) {
      if (signal?.aborted) throw err
      // through, its spawn late: wait for it a while longer
      if (bot.game.dimension === 'the_end') {
        await u.onceEvent(bot, 'spawn', { timeout: 30000, signal })
        break
      }
      if (Date.now() + 45000 > deadline) throw err
      u.log(bot, `end: not through the portal after walk ${walk} (${err.message}); again`)
    }
  }
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
 * Waits up to `exitTimeout` for the portal to open (the dragon's death). The bot can get there before its own step
 * in — knocked into the portal by an enderman it fights at the fountain: the walk then ends in the overworld (it went
 * on towards (0, 0) there for minutes before), which is the exit too.
 */
async function exitEnd (bot, { signal, exitTimeout = 120000, guard } = {}) {
  const left = new AbortController()
  const state = { steppingIn: false, died: false }
  const onSpawn = () => { if (bot.game.dimension !== 'the_end' && !state.steppingIn && !state.died) left.abort(new u.AbortedError(`left The End (${bot.game.dimension})`)) }
  // a death (an enderman, the void) respawns the bot in the overworld too: that is no exit
  const onDeath = () => {
    state.died = true
    left.abort(new u.AbortedError(`the bot died in The End (at ${bot.entity?.position?.floored()})`))
  }
  bot.on('spawn', onSpawn)
  bot.on('death', onDeath)
  try {
    return await exitWalk(bot, { signal: signal ? AbortSignal.any([signal, left.signal]) : left.signal, exitTimeout, guard, state })
  } catch (err) {
    if (state.died) throw new Error(`the bot died in The End during the exit (${err.message})`)
    if (signal?.aborted || bot.game.dimension !== 'overworld') throw err
    await u.sleep(1000, signal)
    u.log(bot, `end: back in the overworld at ${bot.entity.position.floored()} (through the exit portal during the walk to it: ${err.message})`)
    return { exited: true, arrival: u.plain(bot.entity.position.floored()) }
  } finally {
    bot.removeListener('spawn', onSpawn)
    bot.removeListener('death', onDeath)
  }
}

async function exitWalk (bot, { signal, exitTimeout, guard, state }) {
  const { goals } = u.ensurePathfinder(bot)
  let portal = exitPortalBlocks(bot)
  if (!portal.length) {
    // get close to the fountain first (its chunks must be loaded), then wait for the portal to open
    u.log(bot, 'end: walking to the exit fountain at (0, 0)')
    await u.goto(bot, new goals.GoalNearXZ(0, 0, 6), { signal, timeout: 180000, retries: 3, stallMs: 20000 }).catch((err) => { if (signal?.aborted) throw err; u.log(bot, `end: fountain: ${err.message}`) })
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
      await u.goto(bot, new goals.GoalBlock(rim.o.x, rim.o.y, rim.o.z), { signal, timeout: 120000, retries: 2, stallMs: 20000 })
      // nothing may pull the bot out of its walk into the portal
      if (guard) { await guard.idle(); guard.pause() }
      state.steppingIn = true
      const arrived = u.waitForDimension(bot, 'overworld', { timeout: 60000, signal })
      arrived.catch(() => {})
      await stepInto(bot, rim.b.offset(0.5, 0, 0.5), 'the_end', { signal, timeout: 10000 })
      await arrived
      await u.sleep(1000, signal)
      u.log(bot, `end: back in the overworld at ${bot.entity.position.floored()}`)
      return { exited: true, arrival: u.plain(bot.entity.position.floored()) }
    } catch (err) {
      if (signal?.aborted) throw err
      if (u.busyKind(guard) === 'fight') throw err // a fight: fightGuarded() runs the exit again afterwards
      lastErr = err
      u.log(bot, `end: exit via ${rim.o}: ${err.message}`)
    } finally {
      state.steppingIn = false
      guard?.resume()
    }
  }
  throw new Error(`could not enter the exit portal: ${lastErr?.message}`)
}

/**
 * Eat to a full bar and wait (bounded) for the health to come back to `min` before the next fight: health regenerates
 * quickly with a full food bar and saturation (cooked beef). Angry endermen that come meanwhile are the guard's.
 */
async function healUp (bot, { guard, signal, min = 16, maxMs = 45000 } = {}) {
  const t = Date.now()
  if (bot.health >= min && bot.food >= 18) return 0
  u.log(bot, `end: health ${bot.health}, food ${bot.food}: healing up before the next fight`)
  while (Date.now() - t < maxMs && (bot.health < min || bot.food < 18)) {
    u.throwIfAborted(signal)
    if (guard) await guard.idle()
    if (bot.food < 20) await portal.feed(bot, { signal, min: 20 })
    await u.sleep(1000, signal)
  }
  return Date.now() - t
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

/** the walk up's ways, in preference order (see toIslandTop) */
const WALK_WAYS = ['path', 'no placement', 'manual']

/** open sky over the bot: nothing solid in the 24 blocks above its head (not under the island's overhang) */
function openSky (bot) {
  const f = bot.entity.position.floored()
  for (let y = f.y + 2; y < f.y + 24; y++) if (bot.blockAt(new Vec3(f.x, y, f.z))?.boundingBox === 'block') return false
  return true
}

/**
 * The fight phase's movements: no parkour over the void, drops of ≤ 3, scaffolding (bridges, towers). `noPlace`: ones
 * that never place a block and drop ≤ 6 — off the arrival platform onto the island's slope under it (a fall of ≤ 3
 * damage) and up through its end stone by digging, when a placement fails.
 */
function walkMovements (bot, { noPlace = false } = {}) {
  return u.ensurePathfinder(bot, noPlace ? { fresh: true, allowParkour: false, maxDropDown: 6, scaffold: [] } : { fresh: true, allowParkour: false, maxDropDown: 3 })
}

/** horizontal directions, the ones towards `target` (from `from`) first */
function directionsTowards (from, target) {
  const t = new Vec3(target.x - from.x, 0, target.z - from.z)
  return SIDES.map((d) => ({ d, dot: d.x * t.x + d.z * t.z })).sort((a, b) => b.dot - a.dot).map((x) => x.d)
}

/** the first solid block in the `depth` cells under `p` (feet), or null (the void, a deep drop) */
function groundBelow (bot, p, depth) {
  for (let dy = 1; dy <= depth; dy++) {
    const b = bot.blockAt(p.offset(0, -dy, 0))
    if (!b) return null
    if (u.isLava(b) || u.isWater(b)) return null
    if (u.isStandable(b)) return b
  }
  return null
}

/** dig `p` unless it is clear already (never a block next to a liquid, never bedrock / obsidian / a portal) */
async function digClear (bot, p, signal) {
  const b = bot.blockAt(p)
  if (!b || u.isClear(b)) return true
  if (u.isLava(b) || u.isWater(b) || /bedrock|obsidian|portal|end_gateway/.test(b.name) || u.nearLava(bot, p, 1)) return false
  await u.digBlock(bot, b, { signal })
  return u.isClear(bot.blockAt(p))
}

/** walk onto the cell `p` (feet) with plain controls (a step up jumps, a drop falls); ≤ `ticks` ticks */
function stepOnto (bot, p, signal, { ticks = 30 } = {}) {
  return require('./navigate').stepTo(bot, p, signal, { ticks })
}

/** a filler block (U17's filler stacks) in the hand, or null */
async function holdFiller (bot) {
  const inventory = require('../inventory')
  const item = inventory.filler(bot)
  if (!item) return null
  try {
    await inventory.equip(bot, item)
    return bot.heldItem?.name === item.name ? bot.heldItem : null
  } catch (err) {
    u.log(bot, `end: equipping ${item.name}: ${err.message}`)
    return null
  }
}

/**
 * One block across a gap towards `d` (the bot's own placement, the pathfinder's way: sneaking back to the edge, the
 * new block against the side of the one under the feet), then onto it.
 */
async function bridgeStep (bot, d, signal) {
  const feet = bot.entity.position.floored()
  const under = bot.blockAt(feet.offset(0, -1, 0))
  const next = feet.plus(d)
  if (!u.isSolid(under) || !u.isClear(bot.blockAt(next.offset(0, -1, 0)))) return false
  if (!await holdFiller(bot)) return false
  const edge = feet.offset(0.5 + d.x * 0.5, 0, 0.5 + d.z * 0.5)
  try {
    bot.setControlState('sneak', true)
    for (let i = 0; i < 40 && Math.hypot(bot.entity.position.x - edge.x, bot.entity.position.z - edge.z) > 0.35; i++) {
      // look back over the edge, steeply down at the face; walk backwards
      await bot.look(Math.atan2(d.x, d.z), -1.42, true)
      bot.setControlState('back', true)
      await u.tick(bot)
    }
    bot.setControlState('back', false)
    await bot.placeBlock(under, d)
  } catch (err) {
    u.log(bot, `end: bridge block at ${next.offset(0, -1, 0)}: ${err.message}`)
  } finally {
    bot.setControlState('back', false)
    bot.setControlState('sneak', false)
  }
  if (!u.isStandable(bot.blockAt(next.offset(0, -1, 0)))) return false
  await stepOnto(bot, next, signal)
  return !bot.entity.position.floored().equals(feet)
}

/**
 * One step towards `target` without the pathfinder (its own moves failed there): a staircase into the rock ahead, a
 * step / drop (≤ 6) onto the ground ahead, a bridge block across a gap, or — none of those — a pillar step where the
 * 3×3 columns over the bot are clear (BDS refuses a tower block under any ceiling there, see util.bedrockTowers).
 * @returns {Promise<string|null>} what it did
 */
async function manualStep (bot, target, { signal, trail = [] } = {}) {
  const feet = bot.entity.position.floored()
  // straight up (under the island's rock): a staircase in any direction
  const up = target.y > feet.y + 2 && Math.hypot(target.x - feet.x, target.z - feet.z) < 3
  // (not back onto the cells it just came from: around an obsidian pillar it went back and forth)
  const been = (c) => trail.some((t) => t.x === c.x && t.z === c.z)
  for (const d of directionsTowards(feet, target).filter((d) => !been(feet.plus(d))).slice(0, up ? 4 : 3)) {
    const next = feet.plus(d)
    const ahead = bot.blockAt(next)
    if (!ahead) continue
    if (u.isStandable(ahead)) {
      // rock ahead: a staircase step up onto it (the cell over the head, the two over the step dug)
      const dest = next.offset(0, 1, 0)
      if (!await digClear(bot, feet.offset(0, 2, 0), signal) || !await digClear(bot, dest, signal) || !await digClear(bot, dest.offset(0, 1, 0), signal)) continue
      await stepOnto(bot, dest, signal)
      if (bot.entity.position.floored().y > feet.y) return 'staircase'
      continue
    }
    if (up) continue
    // the way ahead (a plant, a low ceiling) dug open
    if (!await digClear(bot, next, signal) || !await digClear(bot, next.offset(0, 1, 0), signal)) continue
    // open ahead: walk on / drop onto the ground below it (never into the void; a fall of over 3 only when healthy)
    const ground = groundBelow(bot, next, 6)
    if (ground) {
      const landing = ground.position.offset(0, 1, 0)
      if (feet.y - landing.y > 3 && bot.health < 10) continue
      await stepOnto(bot, landing, signal, { ticks: 40 })
      if (process.env.BEDBOO_AGENT_DEBUG) u.log(bot, `end: step from ${feet} towards ${d} onto ${landing}: now at ${bot.entity.position.floored()}`)
      if (!bot.entity.position.floored().equals(feet)) return landing.y < feet.y ? 'drop' : 'step'
      continue
    }
    if (await bridgeStep(bot, d, signal)) return 'bridge'
  }
  // a pillar step where nothing is over the 3×3 columns (the island's top above, open air around)
  if (target.y <= feet.y) return null
  for (let dx = -1; dx <= 1; dx++) {
    for (let dz = -1; dz <= 1; dz++) {
      for (const dy of [2, 3]) if (!u.isClear(bot.blockAt(feet.offset(dx, dy, dz)))) return null
    }
  }
  try {
    await require('./survive').pillarStep(bot, signal)
    return bot.entity.position.floored().y > feet.y ? 'pillar' : null
  } catch (err) {
    if (signal?.aborted) throw err
    u.log(bot, `end: pillar step: ${err.message}`)
    return null
  }
}

/**
 * From the arrival platform (≈100, 49, 0: an obsidian platform at the island's edge, its top over the island's slope)
 * onto the island's top near the exit fountain (0, y, 0), where the endermen roam: hops of ≤ 30 blocks (quick
 * searches; the pathfinder bridges from the platform, digs up through end stone and pillars).
 *
 * A hop that does not move the bot 2 blocks in `stallMs` (15 s), or that ends with the pathfinder giving up on failed
 * placements, is a stall. The walk once stood still on its half-built bridge for 10 × 30 s (4 chained runs): unpatched,
 * mineflayer-pathfinder never got past a scaffolding block whose equip or placement failed. The patched pathfinder
 * (patches/mineflayer-pathfinder@2.4.5.patch, docs/differences/U15.md#pathfinder) releases its equip lock, retries a
 * refused cell once and then plans around it or rejects with NoPath ("… placements failed in a row"), and its stop()
 * settles at once; the ways below stay as a bounded defence in depth. The next hop after a stall takes another way:
 * the pathfinder without placements (dropping ≤ 6 off the platform onto the island's slope, digging up through the end
 * stone), then the bot's own steps (staircase, drop, bridge, pillar: `manualStep`); each way that stalled counts
 * against it. Bounded by `maxMs`.
 * @returns {Promise<{ onTop: boolean, ms: number, hops: number, stalls: Array<{ hop, way, at, ms, error }>, ways: object,
 *   maxStillMs: number }>} `maxStillMs`: the longest the bot stayed within 1 block of a spot (not fighting)
 */
async function toIslandTop (bot, { signal, guard, maxMs = 150000, stallMs = 15000, ways = WALK_WAYS } = {}) {
  const { goals } = walkMovements(bot)
  const t0 = Date.now()
  const out = { onTop: false, ms: 0, hops: 0, stalls: [], ways: {}, maxStillMs: 0 }
  // a meal now, standing still: one that auto-eat starts mid-bridge swaps the block in the hand for food
  if (bot.food < 18) await portal.feed(bot, { signal, min: 20 }).catch((err) => { if (signal?.aborted) throw err })
  // the longest time the bot did not get 1 block away from where it stood (fights excepted): the walk's worst stall
  let anchor = bot.entity.position.clone()
  let stillSince = Date.now()
  const still = setInterval(() => {
    if (!bot.entity) return
    if (u.busyKind(guard) === 'fight' || bot.entity.position.distanceTo(anchor) >= 1) {
      anchor = bot.entity.position.clone()
      stillSince = Date.now()
    }
    out.maxStillMs = Math.max(out.maxStillMs, Date.now() - stillSince)
  }, 500)
  // (in preference order: the first of the ways that stalled least)
  const fails = Object.fromEntries(ways.map((w) => [w, 0]))
  const way = () => Object.keys(fails).reduce((a, b) => (fails[b] < fails[a] ? b : a))
  const onTop = () => Math.hypot(bot.entity.position.x, bot.entity.position.z) <= 30 && openSky(bot)
  // what is left of `maxMs` (a hop never runs past it)
  const left = () => Math.max(5000, maxMs - (Date.now() - t0))
  const withoutMeals = require('../skill').withoutMeals
  // the cells the bot's own steps went through lately
  const trail = []
  try {
    for (let hop = 0; hop < 20 && Date.now() - t0 < maxMs; hop++) {
      u.throwIfAborted(signal)
      if (onTop()) break
      const p = bot.entity.position
      const d = Math.hypot(p.x, p.z)
      let target
      if (d > 30) {
        const step = Math.min(30, d - 20)
        target = new Vec3(p.x - (p.x / d) * step, p.y, p.z - (p.z / d) * step)
      } else {
        // up through the rock to the surface above
        const f = p.floored()
        let top = f.y
        for (let y = f.y + 24; y > f.y; y--) {
          if (bot.blockAt(new Vec3(f.x, y, f.z))?.boundingBox === 'block') { top = y; break }
        }
        target = new Vec3(f.x, top + 1, f.z)
      }
      const how = way()
      const start = bot.entity.position.clone()
      const t = Date.now()
      out.hops++
      let error = null
      try {
        if (how === 'manual') {
          // a few of the bot's own steps, then the pathfinder again (stopped first: no goal of its own drives the
          // controls during the steps)
          u.stopMoving(bot)
          walkMovements(bot)
          const steps = []
          const until = t + Math.min(45000, left())
          for (let i = 0; i < 6 && Date.now() < until; i++) {
            const from = bot.entity.position.floored()
            const s = await u.fightGuarded(guard, () => withoutMeals(bot, () => manualStep(bot, target, { signal, trail })))
            if (!s) break
            trail.push(from)
            if (trail.length > 8) trail.shift()
            steps.push(s)
            if (onTop()) break
          }
          if (!steps.length) error = 'no step possible'
          else u.log(bot, `end: own steps towards the island top: ${steps.join(', ')} (at ${bot.entity.position.floored()})`)
        } else {
          walkMovements(bot, { noPlace: how === 'no placement' })
          const goal = d > 30 ? new goals.GoalNearXZ(target.x, target.z, 4) : new goals.GoalNear(target.x, target.y, target.z, 2)
          await u.fightGuarded(guard, () => withoutMeals(bot, () => u.goto(bot, goal, { signal, timeout: Math.min(60000, left()), retries: 1, stallMs })), { deadline: t0 + maxMs })
        }
      } catch (err) {
        if (signal?.aborted) throw err
        error = err.message
        u.log(bot, `end: towards the island top (${how}): ${err.message}`)
      }
      out.ways[how] = (out.ways[how] ?? 0) + 1
      // no 2 blocks gained, a walk that stood still for stallMs at its end (after a few blocks of a bridge), or a
      // pathfinder that gave up on its placements
      if (!onTop() && (bot.entity.position.distanceTo(start) < 2 || /stalled|placements failed/.test(error ?? ''))) {
        // stalled: another way next
        fails[how]++
        const stall = { hop, way: how, at: u.plain(bot.entity.position.floored()), ms: Date.now() - t, error }
        out.stalls.push(stall)
        u.log(bot, `end: the walk up stalled at ${bot.entity.position.floored()} (${how}, ${Math.round(stall.ms / 1000)} s): next ${way()}`)
      }
    }
  } finally {
    clearInterval(still)
    // the fight's own movements again (the hunt walks with them)
    walkMovements(bot)
    out.ms = Date.now() - t0
    out.onTop = onTop()
  }
  if (!out.onTop) out.onTop = Math.hypot(bot.entity.position.x, bot.entity.position.z) <= 40 && openSky(bot)
  return out
}

/**
 * An AbortSignal for a phase in The End: aborts with `signal`, on the bot's death, or when it spawns in another
 * dimension; `reason` says which. @returns {{ signal: AbortSignal, reason: string|null, done: () => void }}
 */
function endWatch (bot, signal) {
  const controller = new AbortController()
  const state = { reason: null }
  const abort = (why) => {
    if (state.reason) return
    state.reason = why
    controller.abort(new u.AbortedError(why))
  }
  const onParent = () => controller.abort(signal.reason)
  const onDeath = () => abort(`the bot died in The End (at ${bot.entity?.position?.floored()})`)
  const onSpawn = () => { if (bot.game.dimension !== 'the_end') abort(`the bot is no longer in The End (${bot.game.dimension})`) }
  if (signal?.aborted) controller.abort(signal.reason)
  else signal?.addEventListener('abort', onParent, { once: true })
  bot.on('death', onDeath)
  bot.on('spawn', onSpawn)
  return {
    signal: controller.signal,
    get reason () { return state.reason },
    done () {
      signal?.removeEventListener('abort', onParent)
      bot.removeListener('death', onDeath)
      bot.removeListener('spawn', onSpawn)
    }
  }
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
        const stopRetaliating = retaliate(bot, guard)
        let a
        try {
          a = await activatePortal(bot, { signal, guard })
          await guard.idle()
        } finally {
          stopRetaliating()
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
      // a death (a fall into the void) respawns the bot in the overworld: the phase ends there, with that reason —
      // not minutes of hunting endermen in the overworld (E1 #2 without an Agent)
      const watch = endWatch(bot, signal)
      const guard = combat.guardFor(bot, { radius: 8, retaliate: true, includeNeutral: false, signal: watch.signal })
      // under the Agent: endermen that attack (looked at, or a hunt's target that comes back) are fought too
      const stopRetaliating = retaliate(bot, guard)
      try {
        const signal = watch.signal
        const t0 = Date.now()
        const walk = await toIslandTop(bot, { signal, guard, maxMs: args.walkMs, stallMs: args.walkStallMs, ways: args.walkWays })
        result.onTop = walk.onTop
        result.walk = walk
        result.timings.toIslandMs = Date.now() - t0
        u.log(bot, `end: ${walk.onTop ? 'on the island' : 'walk up ended'} at ${bot.entity.position.floored()} (${((Date.now() - t0) / 1000).toFixed(0)} s, ${walk.hops} hops, longest stand-still ${Math.round(walk.maxStillMs / 1000)} s, ${walk.stalls.length} stalls${walk.stalls.length ? `: ${walk.stalls.map((s) => `${s.way} ${Math.round(s.ms / 1000)} s`).join(', ')}` : ''})`)
        // endermen roam the whole main island: look around waypoints near its centre (the fountain at 0, 0)
        const exploreTo = (b, hop) => {
          const a = Math.random() * Math.PI * 2
          const r = 15 + Math.random() * 35 // never into the fountain (its portal opens with the dragon's death)
          return new Vec3(Math.cos(a) * r, b.entity.position.y, Math.sin(a) * r)
        }
        // one enderman at a time, healed up in between: a hunt that provokes the next one at half health while the
        // last one (teleported away, still angry) comes back is how the bot died (E1A in seed 1234, runs 1 and 4)
        const until = Date.now() + (args.fightTimeout ?? 600000)
        result.killed.enderman = 0
        result.fights = []
        while (result.killed.enderman < endermen) {
          if (Date.now() > until) throw new Error(`endermen: ${result.killed.enderman}/${endermen} killed in ${Math.round((args.fightTimeout ?? 600000) / 1000)} s`)
          await healUp(bot, { guard, signal })
          const r = await combat.huntFor(bot, 'enderman', 1, { radius: 96, signal, guard, exploreTo, filter: (e) => onIsland(bot, e), timeout: Math.max(30000, until - Date.now()) })
          result.killed.enderman += r.killed
          result.fights.push(...r.fights)
        }
      } catch (err) {
        if (watch.reason) throw new Error(watch.reason)
        throw err
      } finally {
        watch.done()
        stopRetaliating()
        result.guard = await guard.stop()
      }
    } else if (phase === 'exit') {
      if (bot.game.dimension !== 'the_end') throw new Error('not in The End')
      // provoked endermen may follow the bot to the fountain: fought while the bot is healthy; at 10 hp or less the
      // way out is the portal itself — no more fights, the walk goes on into it (a default chain run was slain at
      // the fountain by five endermen in a row, 17 → 0 hp in 12 s, three of them killed)
      const spent = (e) => e.name === 'enderman' && bot.health <= 10
      const guard = combat.guardFor(bot, { radius: 6, retaliate: true, includeNeutral: false, ignore: spent, signal })
      const stopRetaliating = retaliate(bot, guard, { exclude: spent })
      let r
      try {
        r = await u.fightGuarded(guard, () => exitEnd(bot, { signal, exitTimeout: args.exitTimeout, guard }), { retries: 5 })
      } finally {
        stopRetaliating()
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
  healUp,
  endWatch,
  toIslandTop,
  manualStep,
  groundBelow,
  directionsTowards,
  WALK_WAYS
})
