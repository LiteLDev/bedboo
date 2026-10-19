// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * E1 — The End (cheat-assisted): the bot fills the stronghold's end portal frames with eyes of ender, jumps in, kills
 * two endermen (provoked by its first hit) on the main island, and leaves through the exit portal (credits → the
 * overworld).
 *
 * Cheat-assisted steps (documented in docs/differences/U18.md):
 * - `locate structure stronghold` (console) and teleports: the bot is teleported (creative) above the located point,
 *   the portal room's frame ring is found in the chunks the server sent, and the bot is teleported onto the room's
 *   stairs next to the ring, then switched to survival;
 * - the kit (12 eyes of ender, diamond gear, bow and arrows, food) with /give;
 * - the ender dragon is killed with `/kill @e[type=ender_dragon]` right after the bot arrived, so the exit portal
 *   opens (the dragon fight is out of scope).
 * Filling the frames, entering the portal, fighting and leaving are the bot's own actions.
 */
const seed = require('./seed.json')

/** `locate structure stronghold` output (Bedrock: "… at block 1666, (y?), -830 (1861 blocks away)") → `{ x, z }` | null */
function parseLocate (lines) {
  const text = [].concat(lines).join(' ')
  const m = /at block (-?\d+), *\(?(?:y\?|~|-?\d+)\)?, *(-?\d+)/.exec(text) ?? /(-?\d+), *\(y\?\), *(-?\d+)/.exec(text)
  return m ? { x: Number(m[1]), z: Number(m[2]) } : null
}

/** where to look for the portal room around a locate point: the point itself, then rings of teleports 64 / 128 out */
function searchPoints (loc) {
  const pts = [[0, 0]]
  for (const r of [64, 128]) for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]]) pts.push([dx * r, dz * r])
  return pts.map(([dx, dz]) => ({ x: loc.x + dx, z: loc.z + dz }))
}

/**
 * Cheat-assisted: teleport the (creative) bot above the located stronghold — and around it, 64 / 128 blocks out, when
 * the portal room is not in the chunks loaded there — until the 12-frame ring shows up. @returns {Promise<object|null>}
 * the ring (end.portalRing) or null
 */
async function findPortalRing ({ bot, cmd, log }, loc, { waitMs = 20000 } = {}) {
  const u = require('../../src/dims/util')
  const end = require('../../src/skills/end')
  for (const p of searchPoints(loc)) {
    await cmd(`tp {bot} ${p.x} 200 ${p.z}`)
    await u.waitFor(() => Math.abs(bot.entity.position.x - (p.x + 0.5)) < 2 && Math.abs(bot.entity.position.z - (p.z + 0.5)) < 2, { timeout: 20000, message: 'the teleport' })
    await Promise.resolve(bot.waitForChunksToLoad?.()).catch(() => {})
    const ring = await u.waitFor(() => end.portalRing(bot, { maxDistance: 160 }), { timeout: waitMs, interval: 1000, message: 'the portal room' }).catch(() => null)
    if (ring) return ring
    log(`stronghold: no portal ring in the chunks around ${p.x}, ${p.z}`)
  }
  return null
}

/**
 * Cheat-assisted: locate the stronghold, teleport the bot (creative) above it, find the portal room's frame ring in the
 * chunks the server sent (teleporting around the locate point when needed), teleport the bot onto the room's stairs
 * next to the ring, give the kit, survival.
 * @param {object} ctx harness context
 * @param {{ kit?: Array<[string, number]> }} [opts]
 */
async function toPortalRoom ({ bot, cmd, log, data }, { kit = KIT, gear = END_GEAR } = {}) {
  const u = require('../../src/dims/util')
  const end = require('../../src/skills/end')
  const combat = require('../../src/skills/combat')
  if (bot.game.dimension !== 'overworld') throw new Error(`the stronghold is in the overworld (bot in ${bot.game.dimension})`)
  await cmd('gamemode creative {bot}')
  const out = await cmd('locate structure stronghold')
  const loc = parseLocate(out)
  if (!loc) throw new Error(`locate: ${out.join(' | ')}`)
  log(`stronghold: ${out.join(' ')}`)
  const ring = await findPortalRing({ bot, cmd, log }, loc)
  if (!ring) throw new Error(`no end portal room within 128 blocks of the located stronghold at ${loc.x}, ${loc.z}`)
  const spot = end.walkInSpot(bot, ring)
  if (!spot) throw new Error(`no spot next to the portal ring at ${ring.center}`)
  await cmd(`tp {bot} ${spot.o.x} ${spot.o.y} ${spot.o.z}`)
  await u.waitFor(() => bot.entity.position.distanceTo(spot.o.offset(0.5, 0, 0.5)) < 1.5, { timeout: 20000, message: 'the teleport into the portal room' })
  await Promise.resolve(bot.waitForChunksToLoad?.()).catch(() => {})
  log(`stronghold: portal ring ${ring.center} (${ring.frames.filter((f) => end.hasEye(bot.blockAt(f.position))).length} eyes in), bot on ${spot.o}`)
  // the End's fight gear when the bot has none as good (worn or carried): the chain's bot comes with iron tools only
  const has = (name) => u.count(bot, name) > 0 || [5, 6, 7, 8].some((slot) => bot.inventory.slots[slot]?.name === name)
  const missing = gear.filter(([item]) => !has(item) && !has(item.replace(/^diamond_/, 'netherite_')))
  for (const [item, n] of [...kit, ...missing]) {
    const given = await cmd(`give {bot} ${item} ${n}`)
    if (!given.some((l) => /^Gave/.test(l))) throw new Error(`kit: give ${item} ${n}: ${given.join(' | ')}`)
  }
  if (missing.length) log(`stronghold: End fight gear given (cheat-assisted): ${missing.map(([i]) => i).join(', ')}`)
  await cmd('gamemode survival {bot}')
  await bot.waitForTicks(20)
  await u.waitFor(() => u.count(bot, kit[0][0]) >= kit[0][1], { timeout: 10000, message: `${kit[0][1]} ${kit[0][0]} in the inventory` }).catch(() => {})
  await combat.equipForCombat(bot)
  data.ring = ring.center
}

/** The final chain's kit at the stronghold (what scenarios/overworld/final-chain.js passes to toPortalRoom). */
const CHAIN_KIT = [['ender_eye', 12], ['cooked_beef', 16]]

/**
 * The End's fight gear, given by toPortalRoom (cheat-assisted, like E1's kit) for every piece the bot lacks (none as
 * good worn or carried): the chain's bot comes with an iron sword and no armor — unarmored it died to one provoked
 * enderman in 4 hits, with iron armor and the iron sword to the second and third angry enderman (E1A, seed 1234).
 */
const END_GEAR = [['diamond_sword', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1], ['diamond_leggings', 1], ['diamond_boots', 1]]

const KIT = [['ender_eye', 12], ['diamond_sword', 1], ['diamond_pickaxe', 1], ['diamond_helmet', 1], ['diamond_chestplate', 1],
  ['diamond_leggings', 1], ['diamond_boots', 1], ['bow', 1], ['arrow', 64], ['cooked_beef', 32], ['cobblestone', 64]]

module.exports = {
  name: 'E1-the-end',
  description: 'eyes into the stronghold portal, enter the End, kill 2 endermen, exit portal → overworld',
  server: { world: 'default', seed: seed.seed, gamemode: 'creative', difficulty: 'normal', profile: 'none', gamerules: { dodaylightcycle: false, doweathercycle: false } },
  viewDistance: 10,
  setup: ['time set day', 'weather clear'],
  prepare: (ctx) => toPortalRoom(ctx),
  steps: [
    { skill: 'end', name: 'activate', args: { phase: 'activate' }, timeout: 4 * 60 * 1000 },
    { console: 'execute in the_end run kill @e[type=ender_dragon]', name: 'kill dragon (cheat)', delayMs: 2000 },
    { skill: 'end', name: 'endermen', args: { phase: 'fight', endermen: 2 }, timeout: 8 * 60 * 1000 },
    { skill: 'end', name: 'exit', args: { phase: 'exit' }, timeout: 4 * 60 * 1000 }
  ],
  timeout: 15 * 60 * 1000,
  check (report, { bot }) {
    const [activate, kill, fight, exit] = report.steps
    if (!activate.result.entered) throw new Error('did not enter the End')
    if (!kill.result.some((l) => /Killed/.test(l))) throw new Error(`dragon kill: ${kill.result.join(' | ')}`)
    if ((fight.result.killed.enderman ?? 0) < 2) throw new Error(`endermen killed: ${fight.result.killed.enderman}`)
    if (!exit.result.exited || bot.game.dimension !== 'overworld') throw new Error(`not back in the overworld: ${bot.game.dimension}`)
  }
}

module.exports.toPortalRoom = toPortalRoom
module.exports.findPortalRing = findPortalRing
module.exports.parseLocate = parseLocate
module.exports.searchPoints = searchPoints
module.exports.KIT = KIT
module.exports.CHAIN_KIT = CHAIN_KIT
module.exports.END_GEAR = END_GEAR
