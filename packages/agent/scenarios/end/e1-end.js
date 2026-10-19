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

/**
 * Cheat-assisted: locate the stronghold, teleport the bot (creative) above it, find the portal room's frame ring in the
 * chunks the server sent, teleport the bot onto the room's stairs next to the ring, give the kit, survival.
 * @param {object} ctx harness context
 * @param {{ kit?: Array<[string, number]> }} [opts]
 */
async function toPortalRoom ({ bot, cmd, log, data }, { kit = KIT } = {}) {
  const u = require('../../src/dims/util')
  const end = require('../../src/skills/end')
  const combat = require('../../src/skills/combat')
  if (bot.game.dimension !== 'overworld') throw new Error(`the stronghold is in the overworld (bot in ${bot.game.dimension})`)
  await cmd('gamemode creative {bot}')
  const out = await cmd('locate structure stronghold')
  const m = /at block (-?\d+), \(y\?\), (-?\d+)/.exec(out.join(' '))
  if (!m) throw new Error(`locate: ${out.join(' | ')}`)
  const x = Number(m[1])
  const z = Number(m[2])
  log(`stronghold: ${out.join(' ')}`)
  await cmd(`tp {bot} ${x} 200 ${z}`)
  await u.waitFor(() => Math.abs(bot.entity.position.x - (x + 0.5)) < 2 && Math.abs(bot.entity.position.z - (z + 0.5)) < 2, { timeout: 20000, message: 'the teleport' })
  await bot.waitForChunksToLoad()
  const ring = await u.waitFor(() => end.portalRing(bot, { maxDistance: 160 }), { timeout: 60000, interval: 1000, message: 'the portal room in the loaded chunks' })
  const spot = end.walkInSpot(bot, ring)
  if (!spot) throw new Error(`no spot next to the portal ring at ${ring.center}`)
  await cmd(`tp {bot} ${spot.o.x} ${spot.o.y} ${spot.o.z}`)
  await u.waitFor(() => bot.entity.position.distanceTo(spot.o.offset(0.5, 0, 0.5)) < 1.5, { timeout: 20000, message: 'the teleport into the portal room' })
  await bot.waitForChunksToLoad()
  log(`stronghold: portal ring ${ring.center} (${ring.frames.filter((f) => end.hasEye(bot.blockAt(f.position))).length} eyes in), bot on ${spot.o}`)
  for (const [item, n] of kit) await cmd(`give {bot} ${item} ${n}`)
  await cmd('gamemode survival {bot}')
  await bot.waitForTicks(20)
  await combat.equipForCombat(bot)
  data.ring = ring.center
}

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
module.exports.KIT = KIT
