// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * N1 — nether entry: obtain obsidian legitimately (bucket casting next to the surface lava pool of seed 35, mined with
 * a diamond pickaxe), build a 4×5 frame (10 obsidian + scaffolding corners), craft a flint and steel (flint from
 * gravel dug by the bot, an iron ingot), light it and walk in → the Nether.
 *
 * Cheat-assisted (documented in docs/differences/U18.md): the starting kit is given with /give — the end state of the
 * overworld milestones (U17's M3 "diamond" milestone: a diamond pickaxe, iron, buckets, food, iron gear) until U17's
 * M3 snapshot exists; switch `server.snapshot` to it then. Everything after the kit is the bot's own work.
 */
const seed = require('./seed.json')

module.exports = {
  name: 'N1-nether-entry',
  description: 'bucket-cast 10 obsidian, build + light a portal, enter the nether',
  server: { world: 'default', seed: seed.seed, gamemode: 'survival', difficulty: 'easy', profile: 'none', gamerules: { dodaylightcycle: false, doweathercycle: false } },
  viewDistance: 8,
  setup: ['time set day', 'weather clear'],
  kit: [
    ['diamond_pickaxe', 1],
    ['bucket', 3],
    ['iron_ingot', 3],
    ['bread', 16],
    ['iron_sword', 1],
    ['iron_helmet', 1],
    ['iron_chestplate', 1],
    ['iron_leggings', 1],
    ['iron_boots', 1]
  ],
  async prepare ({ bot }) {
    const combat = require('../../src/skills/combat')
    await combat.equipForCombat(bot)
  },
  steps: [
    { skill: 'portal', name: 'portal', args: { obsidian: 10, enter: true }, timeout: 14 * 60 * 1000 }
  ],
  timeout: 15 * 60 * 1000,
  check (report, { bot }) {
    const r = report.steps[0].result
    if (bot.game.dimension !== 'the_nether') throw new Error(`not in the nether: ${bot.game.dimension}`)
    if (!r.lit) throw new Error('portal not lit')
    if (r.obsidian.cast < 10) throw new Error(`only ${r.obsidian.cast} obsidian cast`)
    if (!r.flint.crafted) throw new Error('the flint and steel was not crafted by the bot')
  }
}
