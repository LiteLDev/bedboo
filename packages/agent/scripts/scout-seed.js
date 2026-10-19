#!/usr/bin/env node
// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Seed scouting for the overworld milestones (cheats allowed HERE ONLY: /locate, teleports, creative flight).
 *
 *   node packages/agent/scripts/scout-seed.js --seeds 2,7,42 [--out scout.json] [--write-seed <seed>]
 *
 * For every candidate seed it starts an isolated BDS (default generator, harness slot), joins a creative bot and
 * surveys the spawn area with the bot's own world view (`findBlocks` sees every loaded sub-chunk, -64..319):
 * trees, exposed stone, surface lava, gravel, water, and the nearest ore of each kind (with its depth). Then it
 * `/locate`s the mountain biomes where emerald ore generates, teleports there and looks for emerald ore.
 * Every seed gets a score; `--write-seed <seed>` writes that seed's survey to scenarios/overworld/seed.json.
 *
 * The milestones themselves never use any of this information: the agent finds everything with findBlocks /
 * exploration. seed.json only documents why the seed was chosen and where things are (for humans and for U18).
 */
const fs = require('fs')
const path = require('path')
const { Vec3 } = require('vec3')

const LOGS = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log', 'poplar_log']
const ORES = {
  coal: ['coal_ore', 'deepslate_coal_ore'],
  copper: ['copper_ore', 'deepslate_copper_ore'],
  iron: ['iron_ore', 'deepslate_iron_ore'],
  gold: ['gold_ore', 'deepslate_gold_ore'],
  redstone: ['redstone_ore', 'deepslate_redstone_ore', 'lit_redstone_ore', 'lit_deepslate_redstone_ore'],
  lapis: ['lapis_ore', 'deepslate_lapis_ore'],
  diamond: ['diamond_ore', 'deepslate_diamond_ore'],
  emerald: ['emerald_ore', 'deepslate_emerald_ore']
}
/** biomes where emerald ore generates (Bedrock names) */
const MOUNTAIN_BIOMES = ['stony_peaks', 'jagged_peaks', 'frozen_peaks', 'snowy_slopes', 'meadow', 'grove', 'extreme_hills', 'extreme_hills_mutated', 'extreme_hills_plus_trees', 'cherry_grove']

function parseArgs (argv) {
  const out = { seeds: [], out: null, writeSeed: null, radius: 64 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--seeds') out.seeds = argv[++i].split(',').map(s => s.trim()).filter(Boolean)
    else if (a === '--out') out.out = argv[++i]
    else if (a === '--write-seed') out.writeSeed = argv[++i]
    else if (a === '--radius') out.radius = Number(argv[++i])
    else throw new Error(`unknown argument ${a}`)
  }
  if (out.writeSeed && !out.seeds.includes(out.writeSeed)) out.seeds.push(out.writeSeed)
  if (!out.seeds.length) throw new Error('usage: scout-seed.js --seeds a,b,c [--out file] [--write-seed s]')
  return out
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const round = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) })

/** run a command as the bot and resolve with its output text */
async function botCommand (bot, cmd, timeout = 15000) {
  const res = await Promise.race([
    bot._bedrock.commands.request(cmd),
    sleep(timeout).then(() => { throw new Error(`${cmd}: no output`) })
  ])
  const lines = (res?.output ?? []).map(o => {
    const params = (o.parameters ?? []).map(String)
    let text = bot.registry.language?.[o.message_id] ?? o.message_id
    let i = 0
    text = text.replace(/%(\d+\$)?[sd]/g, (m, pos) => (pos ? params[parseInt(pos) - 1] : params[i++]) ?? m)
    return text
  })
  return { ok: !!res?.success_count, text: lines.join(' | '), raw: res }
}

function nearestOf (bot, names, origin, maxDistance) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(id => id !== undefined)
  if (!ids.length) return { count: 0, nearest: null }
  const found = bot.findBlocks({ matching: ids, maxDistance, count: 5000, point: origin })
  if (!found.length) return { count: 0, nearest: null }
  const p = found[0]
  return { count: found.length, nearest: { ...round(p), block: bot.blockAt(p)?.name, distance: +p.distanceTo(origin).toFixed(1) } }
}

/** a block with nothing solid above it up to the top of the loaded column */
function skyExposed (bot, p) {
  for (let y = p.y + 1; y < Math.min(p.y + 80, 320); y++) {
    const b = bot.blockAt(new Vec3(p.x, y, p.z))
    if (!b) return true
    if (b.boundingBox === 'block' && !/leaves/.test(b.name)) return false
  }
  return true
}

function surfaceSurvey (bot, origin, radius) {
  const reg = bot.registry
  const ids = (names) => names.map(n => reg.blocksByName[n]?.id).filter(id => id !== undefined)
  const logs = bot.findBlocks({ matching: ids(LOGS), maxDistance: radius, count: 5000, point: origin })
  const logKinds = {}
  for (const p of logs) { const n = bot.blockAt(p)?.name; logKinds[n] = (logKinds[n] ?? 0) + 1 }
  const exposed = (names, minY = -64, maxDistance = radius) => bot.findBlocks({ matching: ids(names), maxDistance, count: 20000, point: origin })
    .filter(p => p.y >= minY && skyExposed(bot, p))
  const stone = exposed(['stone', 'andesite', 'diorite', 'granite', 'deepslate', 'tuff'], 40)
  const lava = exposed(['lava', 'flowing_lava'], 0, radius * 2)
  const gravel = exposed(['gravel'], 40)
  const water = exposed(['water', 'flowing_water'], 40)
  const near = (list) => list.length ? { ...round(list[0]), distance: +list[0].distanceTo(origin).toFixed(1) } : null
  const ores = {}
  // ores: 3-D distance (diamonds are ~120 blocks below a y 64 spawn)
  for (const [kind, names] of Object.entries(ORES)) ores[kind] = nearestOf(bot, names, origin, radius * 2.5)
  const columns = Object.keys(bot.world.async?.columns ?? bot.world.columns ?? {}).length
  return {
    loadedColumns: columns,
    logs: { count: logs.length, kinds: logKinds, nearest: near(logs) },
    exposedStone: { count: stone.length, nearest: near(stone) },
    surfaceLava: { count: lava.length, nearest: near(lava) },
    gravel: { count: gravel.length, nearest: near(gravel) },
    water: { count: water.length, nearest: near(water) },
    ores
  }
}

async function waitChunks (bot, ms = 20000) {
  await Promise.race([bot.waitForChunksToLoad(), sleep(ms)]).catch(() => {})
  await sleep(1500)
}

async function scoutSeed (seed, { radius }) {
  const bds = require('@bedboo/bds')
  const mineflayer = require('mineflayer-bedrock')
  const server = await bds.startServer({ world: 'default', seed, gamemode: 'creative', difficulty: 'peaceful', log: () => {} })
  let bot
  const t0 = Date.now()
  try {
    bot = mineflayer.createBot({ host: server.host, port: server.port, username: 'Scout' })
    await new Promise((resolve, reject) => {
      bot.once('spawn', resolve)
      bot.once('end', (r) => reject(new Error(`ended: ${r}`)))
      setTimeout(() => reject(new Error('no spawn')), 90000)
    })
    await waitChunks(bot, 30000)
    const spawn = bot.entity.position.clone()
    const survey = surfaceSurvey(bot, spawn, radius)
    // emerald: /locate the mountain biomes, fly to the nearest, look for emerald ore there
    const mountains = []
    for (const biome of MOUNTAIN_BIOMES) {
      // Bedrock wants the namespaced id; output parameters: [name, x, y, z, distance] (structures: [name, x, z, distance])
      const r = await botCommand(bot, `/locate biome minecraft:${biome}`).catch((err) => ({ ok: false, text: err.message }))
      const params = (r.raw?.output?.[0]?.parameters ?? []).map(Number)
      if (r.ok && params.length >= 4) {
        const pos = params.length >= 5 ? { x: params[1], y: params[2], z: params[3] } : { x: params[1], y: null, z: params[2] }
        mountains.push({ biome, ...pos, distance: Math.round(Math.hypot(pos.x - spawn.x, pos.z - spawn.z)) })
      }
    }
    mountains.sort((a, b) => a.distance - b.distance)
    const emerald = []
    for (const m of mountains.slice(0, 3)) {
      await botCommand(bot, `/tp @s ${m.x} 200 ${m.z}`)
      await sleep(1000)
      await waitChunks(bot, 30000)
      const here = bot.entity.position.clone()
      const found = nearestOf(bot, ORES.emerald, here, 80)
      const ground = (() => {
        for (let y = 250; y > -60; y--) { const b = bot.blockAt(new Vec3(m.x, y, m.z)); if (b && b.boundingBox === 'block') return y + 1 }
        return null
      })()
      emerald.push({ biome: m.biome, at: { x: m.x, y: ground, z: m.z }, distance: m.distance, ...found })
      if (found.count) break
    }
    const result = { seed, spawn: round(spawn), ms: Date.now() - t0, survey, mountains, emerald }
    result.score = score(result)
    return result
  } finally {
    try { bot?.end('scouting done') } catch {}
    await server.stop().catch(() => {})
  }
}

/** higher is better: every milestone resource close to the spawn */
function score (r) {
  const s = r.survey
  let score = 0
  const near = (n, good, ok) => !n ? -30 : n.distance <= good ? 10 : n.distance <= ok ? 5 : 0
  score += near(s.logs.nearest, 12, 30) * 2
  score += near(s.exposedStone.nearest, 20, 48)
  score += near(s.surfaceLava.nearest, 40, 64)
  score += near(s.gravel.nearest, 32, 64)
  for (const kind of ['coal', 'iron', 'copper', 'gold', 'redstone', 'lapis', 'diamond']) score += near(s.ores[kind].nearest, 32, 64)
  const em = r.emerald.find(e => e.count)
  score += !em ? -40 : em.distance <= 200 ? 20 : em.distance <= 400 ? 10 : 0
  return score
}

async function main () {
  const args = parseArgs(process.argv.slice(2))
  process.env.BEDBOO_MAX_SERVERS ??= '10'
  const results = []
  for (const seed of args.seeds) {
    process.stderr.write(`scouting seed ${seed}…\n`)
    try {
      const r = await scoutSeed(seed, args)
      results.push(r)
      const s = r.survey
      const d = (n) => n ? `${n.distance}` : '-'
      process.stderr.write(`  seed ${seed}: score ${r.score}, spawn ${JSON.stringify(r.spawn)}, logs ${d(s.logs.nearest)}, stone ${d(s.exposedStone.nearest)}, lava ${d(s.surfaceLava.nearest)}, gravel ${d(s.gravel.nearest)}, ores ${Object.entries(s.ores).map(([k, v]) => `${k}:${d(v.nearest)}`).join(' ')}, emerald ${JSON.stringify(r.emerald.find(e => e.count)?.nearest ?? null)} (${r.mountains[0]?.biome} ${r.mountains[0]?.distance})\n`)
    } catch (err) {
      process.stderr.write(`  seed ${seed}: failed: ${err.stack}\n`)
      results.push({ seed, error: err.message })
    }
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify(results, null, 2))
  if (args.writeSeed) {
    const r = results.find(x => x.seed === args.writeSeed && !x.error)
    if (!r) throw new Error(`seed ${args.writeSeed} was not scouted successfully`)
    const file = path.join(__dirname, '..', 'scenarios', 'overworld', 'seed.json')
    const doc = {
      seed: r.seed,
      generator: 'default',
      bds: '1.26.51.1',
      scoutedAt: new Date().toISOString().slice(0, 10),
      note: 'Written by packages/agent/scripts/scout-seed.js (cheats used for scouting only). The milestones never read these coordinates: the agent finds everything itself.',
      spawn: r.spawn,
      surface: {
        logs: r.survey.logs,
        exposedStone: r.survey.exposedStone,
        surfaceLava: r.survey.surfaceLava,
        gravel: r.survey.gravel,
        water: r.survey.water
      },
      ores: r.survey.ores,
      mountains: r.mountains,
      emerald: r.emerald,
      score: r.score
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n')
    process.stderr.write(`wrote ${file}\n`)
  }
  results.sort((a, b) => (b.score ?? -1e9) - (a.score ?? -1e9))
  console.log(results.map(r => `${r.seed}\t${r.score ?? r.error}`).join('\n'))
}

if (require.main === module) {
  main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1) })
}

module.exports = { scoutSeed, score, MOUNTAIN_BIOMES, ORES }
