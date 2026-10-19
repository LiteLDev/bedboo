// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Exploration: walk a square spiral around the start until something shows up in the loaded world.
 *
 * Skill `explore` — args: { blocks?: string[], biomes?: string[], maxDistance?: 320, leg?: 48, timeout?: ms }
 *                   result: { found: 'block'|'biome'|null, position, distance, waypoints }
 * Stops as soon as one of `blocks` is loaded (bot.findBlocks sees every loaded sub-chunk) or, with `biomes`, once the
 * bot stands in one of them (it heads straight for such a biome as soon as one is loaded).
 *
 * Helper: `explore.explore(bot, { until, biomes, … })` with a predicate.
 */
const { Vec3 } = require('vec3')
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress } = require('../skill')
const world = require('../world')
const navigate = require('./navigate')

/** square spiral waypoints (relative), legs growing by `leg` every two turns */
function * spiral (leg) {
  const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]]
  let x = 0
  let z = 0
  for (let i = 0; ; i++) {
    const [dx, dz] = dirs[i % 4]
    const len = leg * (Math.floor(i / 2) + 1)
    x += dx * len
    z += dz * len
    yield { x, z }
  }
}

/**
 * @param {object} bot
 * @param {object} opts
 * @param {() => any} [opts.until] stop when it returns something truthy (returned as `found`)
 * @param {string[]} [opts.biomes] head for / stop in these biomes
 * @param {number} [opts.maxDistance=320] farthest waypoint from the start (horizontal)
 * @param {number} [opts.leg=48]
 * @param {number} [opts.timeout=240000]
 * @param {AbortSignal} [opts.signal]
 */
async function explore (bot, { until = () => null, biomes, maxDistance = 320, leg = 48, timeout = 240000, signal } = {}) {
  const started = Date.now()
  const origin = bot.entity.position.clone()
  const want = biomes?.length ? new Set(biomes) : null
  const check = () => {
    const hit = until()
    if (hit) return { found: 'block', hit }
    if (want) {
      const here = world.biomeAt(bot, bot.entity.position.floored())
      if (here && want.has(here)) return { found: 'biome', hit: here }
    }
    return null
  }
  let waypoints = 0
  const result = (r) => ({ ...r, position: pos(bot), distance: Math.round(world.distXZ(origin, bot.entity.position)), waypoints, ms: Date.now() - started })
  let r = check()
  if (r) return result(r)
  // exploring is a surface walk: climb out of a mine first (tunnelling towards waypoints would take forever)
  const survive = require('./survive')
  if (!survive.underOpenSky(bot)) {
    await survive.surface(bot, { signal }).catch((err) => { if (isAbort(err)) throw err; log(bot, `explore: ${err.message}`) })
    r = check()
    if (r) return result(r)
  }
  for (const rel of spiral(leg)) {
    checkAbort(signal)
    if (Date.now() - started > timeout) break
    if (Math.max(Math.abs(rel.x), Math.abs(rel.z)) > maxDistance) break
    let target = new Vec3(origin.x + rel.x, origin.y, origin.z + rel.z)
    if (want) {
      const spots = world.findBiome(bot, [...want], { radius: 144 })
      if (spots.length) {
        target = spots[0]
        log(bot, `explore: ${world.biomeAt(bot, target)} biome seen at ${navigate.fmt(target)}`)
      }
    }
    waypoints++
    progress(bot, 'explore', { to: { x: Math.round(target.x), z: Math.round(target.z) } })
    const { goals } = require('mineflayer-pathfinder')
    try {
      await navigate.goto(bot, new goals.GoalNearXZ(target.x, target.z, 4), {
        signal,
        timeout: Math.min(90000, timeout - (Date.now() - started)),
        attempts: 2
      })
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `explore: waypoint ${navigate.fmt(target)} not reached: ${err.message}`)
    }
    r = check()
    if (r) return result(r)
  }
  return result({ found: null })
}

function pos (bot) {
  const p = bot.entity.position
  return { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }
}

const skill = defineSkill('explore', async (bot, args) => {
  const blocks = args.blocks ? [].concat(args.blocks) : null
  const until = blocks ? () => world.findBlocks(bot, blocks, { maxDistance: args.searchRadius ?? 96, count: 1 })[0] : undefined
  const r = await explore(bot, { ...args, until })
  if (!r.found && (blocks || args.biomes)) throw new SkillError(`explored ${r.waypoints} waypoints, found none of ${[...(blocks ?? []), ...(args.biomes ?? [])].join(', ')}`, { code: 'NOT_FOUND', details: r })
  return { ...r, hit: r.hit && r.hit.x !== undefined ? { x: r.hit.x, y: r.hit.y, z: r.hit.z } : r.hit }
}, { description: 'walk a spiral until a block / biome is loaded' })

module.exports = Object.assign(skill, { explore, spiral })
