// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Seed scouting for U18's scenarios (cheats allowed here only: creative, /tp, /locate). For every seed: start a seeded
 * BDS, join with a creative bot at the world spawn, load the chunks around it and report
 * - surface lava sources (sky above them within a few blocks) and their distance from the spawn,
 * - water sources and gravel near the spawn,
 * - the nearest stronghold (`/locate structure stronghold`).
 *
 *   node packages/agent/scenarios/nether/scout.js 1 2 3 …      # seeds; JSON lines on stdout
 *
 * `--pools <seed> [x,z …] [--out file]`: the detailed survey of one seed that the portal skill's hints come from —
 * the lava pools (connected lava blocks, their sources, the ones a bucket reaches, how many under the open sky) and
 * natural obsidian around the spawn and the given points, the nearest surface water, and the stronghold's portal room
 * (located, then found in the loaded chunks around the locate point: its frame ring and a walk-in spot).
 *
 *   node packages/agent/scenarios/nether/scout.js --pools 1234 -630,100 --out scenarios/nether/seed-1234.json
 *
 * The chosen seeds are recorded in scenarios/{nether,end}/seed.json (and seed-<seed>.json).
 */
const fs = require('fs')
const { Vec3 } = require('vec3')
const { createTestBot } = require('../../../mineflayer-bedrock/test/external/common')
const bds = require('@bedboo/bds')

async function scout (seed, { radius = 160 } = {}) {
  const server = await bds.startServer({ world: 'default', seed: String(seed), gamemode: 'creative' })
  let bot
  try {
    ;({ bot } = await createTestBot({ server, botOptions: { viewDistance: 10 } }))
    await bot.waitForChunksToLoad()
    await bot.waitForTicks(40)
    const spawn = bot.entity.position.floored()
    const columns = Object.keys(bot.world.async.columns).length
    const reg = bot.registry
    const find = (names, count = 2000) => bot.findBlocks({ matching: names.map((n) => reg.blocksByName[n].id), maxDistance: radius, count })
    const isSource = (p) => bot.blockAt(p)?.getProperties?.().liquid_depth === 0
    const skyAbove = (p) => {
      for (let y = p.y + 1; y < p.y + 6; y++) if (bot.blockAt(new Vec3(p.x, y, p.z))?.name !== 'air') return false
      return true
    }
    const lava = find(['lava', 'flowing_lava']).filter(isSource)
    const surfaceLava = lava.filter(skyAbove).filter((p) => p.y > 50)
    // lava sources in reach of a cave / the surface: air right above (a pool the bot can see and fill a bucket from)
    const exposedLava = lava.filter((p) => bot.blockAt(p.offset(0, 1, 0))?.name === 'air' && p.y > 40)
    const pool = exposedLava.length ? lava.filter((p) => p.distanceTo(exposedLava[0]) <= 6).length : 0
    const water = find(['water', 'flowing_water']).filter(isSource).filter(skyAbove)
    const gravel = find(['gravel'])
    const dist = (p) => Math.round(p.distanceTo(spawn))
    const near = (list) => list.length ? { n: list.length, nearest: list[0].toString(), d: dist(list[0]) } : null
    const locate = await server.commandOutput('locate structure stronghold')
    console.log(JSON.stringify({
      seed: String(seed),
      spawn: spawn.toString(),
      columns,
      surfaceLava: near(surfaceLava),
      exposedLava: near(exposedLava),
      pool,
      lavaAny: near(lava),
      water: near(water),
      gravel: near(gravel),
      stronghold: locate.join(' | ')
    }))
  } finally {
    try { bot?.end('scout done') } catch {}
    await server.stop()
  }
}

const plainOf = (p) => ({ x: p.x, y: p.y, z: p.z })

/** creative teleport to (x, y, z) and wait for the chunks around */
async function teleport (bot, server, x, y, z) {
  const u = require('../../src/dims/util')
  await server.commandOutput(`tp ${JSON.stringify(bot.username)} ${x} ${y} ${z}`)
  await u.waitFor(() => Math.abs(bot.entity.position.x - (x + 0.5)) < 2 && Math.abs(bot.entity.position.z - (z + 0.5)) < 2, { timeout: 20000, message: 'the teleport' })
  await bot.waitForChunksToLoad()
  await bot.waitForTicks(60)
}

/** lava pools, natural obsidian and surface water within `radius` of the bot */
function survey (bot, { radius = 128 } = {}) {
  const u = require('../../src/dims/util')
  const portal = require('../../src/skills/portal')
  const here = bot.entity.position.floored()
  const blockAt = (p) => bot.blockAt(p)
  const lava = u.findBlocks(bot, ['lava', 'flowing_lava'], { maxDistance: radius, count: 30000 }).map((b) => b.position)
  const pools = portal.lavaPools(blockAt, lava)
    .filter((p) => p.reachable.length >= 2)
    .map((p) => {
      const nearest = p.reachable.slice().sort((a, b) => a.distanceTo(here) - b.distanceTo(here))[0]
      return { key: p.key, center: plainOf(p.center), sources: p.sources.length, reachable: p.reachable.length, sky: p.sky, nearest: plainOf(nearest), distance: Math.round(nearest.distanceTo(here)) }
    })
    .sort((a, b) => a.distance - b.distance)
  const obsidian = u.findBlocks(bot, 'obsidian', { maxDistance: radius, count: 400 }).map((b) => {
    const p = b.position
    return { at: plainOf(p), below: bot.blockAt(p.offset(0, -1, 0))?.name, lavaNext: u.nearLava(bot, p, 1), distance: Math.round(p.distanceTo(here)) }
  })
  const water = u.findBlocks(bot, ['water'], { maxDistance: radius, count: 30000, filter: (b) => u.isWaterSource(b) && u.isClear(bot.blockAt(b.position.offset(0, 1, 0))) })
  const waterNear = water.slice(0, 1).map((b) => ({ at: plainOf(b.position), distance: Math.round(b.position.distanceTo(here)) }))
  return { at: plainOf(here), pools: pools.slice(0, 12), obsidian: obsidian.slice(0, 20), obsidianCount: obsidian.length, water: waterNear }
}

/** `/locate` the stronghold and find its portal room's frame ring (teleporting around the locate point) */
async function strongholdRoom (bot, server) {
  const end = require('../../src/skills/end')
  const e1 = require('../end/e1-end')
  const out = await server.commandOutput('locate structure stronghold')
  const loc = e1.parseLocate(out)
  if (!loc) return { locate: out.join(' | ') }
  const ring = await e1.findPortalRing({ bot, cmd: (c) => server.commandOutput(c.replaceAll('{bot}', JSON.stringify(bot.username))), log: () => {} }, loc)
  if (!ring) return { locate: loc, ring: null }
  const spot = end.walkInSpot(bot, ring)
  const eyes = ring.frames.filter((f) => end.hasEye(bot.blockAt(f.position))).length
  return {
    locate: loc,
    portalRing: plainOf(ring.center),
    fromLocate: Math.round(Math.hypot(ring.center.x - loc.x, ring.center.z - loc.z)),
    eyesPresent: eyes,
    walkIn: spot ? plainOf(spot.o) : null
  }
}

async function scoutPools (seed, points = [], { out } = {}) {
  const server = await bds.startServer({ world: 'default', seed: String(seed), gamemode: 'creative', log: () => {} })
  let bot
  try {
    ;({ bot } = await createTestBot({ server, botOptions: { viewDistance: 10 } }))
    await bot.waitForChunksToLoad()
    await bot.waitForTicks(60)
    const spawn = bot.entity.position.floored()
    const result = { seed: String(seed), bds: '1.26.51.1', scoutedAt: new Date().toISOString().slice(0, 10), spawn: plainOf(spawn), areas: [] }
    result.areas.push({ name: 'spawn', ...survey(bot) })
    for (const [x, z] of points) {
      await teleport(bot, server, x, 200, z)
      result.areas.push({ name: `${x},${z}`, ...survey(bot) })
    }
    result.stronghold = await strongholdRoom(bot, server)
    const json = JSON.stringify(result, null, 2)
    if (out) fs.writeFileSync(out, json + '\n')
    console.log(json)
  } finally {
    try { bot?.end('scout done') } catch {}
    await server.stop()
  }
}

async function main () {
  const args = process.argv.slice(2)
  const pi = args.indexOf('--pools')
  if (pi >= 0) {
    const oi = args.indexOf('--out')
    const out = oi >= 0 ? args[oi + 1] : undefined
    const rest = args.filter((a, i) => i > pi + 1 && a !== '--out' && a !== out)
    await scoutPools(args[pi + 1], rest.map((s) => s.split(',').map(Number)), { out })
    process.exit(0)
  }
  for (const seed of args) {
    try {
      await scout(seed)
    } catch (err) {
      console.log(JSON.stringify({ seed, error: err.message }))
    }
  }
  process.exit(0)
}

if (require.main === module) main().catch((err) => { console.error(err); process.exit(1) })

module.exports = { scout, scoutPools, survey, strongholdRoom }
