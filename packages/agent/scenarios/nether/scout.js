// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Seed scouting for U18's scenarios (cheats allowed here only: creative, /locate). For every seed: start a seeded BDS,
 * join with a creative bot at the world spawn, load the chunks around it and report
 * - surface lava sources (sky above them within a few blocks) and their distance from the spawn,
 * - water sources and gravel near the spawn,
 * - the nearest stronghold (`/locate structure stronghold`).
 *
 *   node packages/agent/scenarios/nether/scout.js 1 2 3 …      # seeds; JSON lines on stdout
 *
 * The chosen seeds are recorded in scenarios/{nether,end}/seed.json.
 */
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

async function main () {
  const seeds = process.argv.slice(2)
  for (const seed of seeds) {
    try {
      await scout(seed)
    } catch (err) {
      console.log(JSON.stringify({ seed, error: err.message }))
    }
  }
  process.exit(0)
}

if (require.main === module) main()

module.exports = { scout }
