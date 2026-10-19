// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * Combat — survive the night: on difficulty normal, at midnight, with natural mob spawning, the bot stands guard at
 * its post for `DURATION` and kills the hostiles that come at it (zombies, skeletons, spiders, creepers, …) with the
 * combat skill's `survive` mode (combat.defend: melee with the best weapon, the bow against far / flying mobs, shield
 * = sneak when cornered, hit-and-run against creepers, retreat + eat when low, back to the post after each fight).
 *
 * Cheat-assisted (documented): the kit (iron sword, shield, iron armor, bow + arrows, food) is given with /give and
 * the time is set to midnight with the day cycle off. Nothing is summoned: every mob spawns naturally.
 */
const seed = require('./seed.json')

const DURATION = Number(process.env.BEDBOO_U18_NIGHT_MS) || 5 * 60 * 1000

module.exports = {
  name: 'C1-survive-the-night',
  description: `stand guard ${DURATION / 60000} min at night, normal difficulty, natural spawns`,
  server: { gamemode: 'survival', difficulty: 'normal', profile: 'none', gamerules: seed.gamerules },
  viewDistance: 6,
  setup: ['time set midnight', 'weather clear'],
  kit: [
    ['iron_sword', 1],
    ['shield', 1],
    ['iron_helmet', 1],
    ['iron_chestplate', 1],
    ['iron_leggings', 1],
    ['iron_boots', 1],
    ['bow', 1],
    ['arrow', 64],
    ['cooked_beef', 16]
  ],
  steps: [
    { skill: 'combat', name: 'survive', args: { mode: 'survive', durationMs: DURATION, radius: 16 }, timeout: DURATION + 2 * 60 * 1000 }
  ],
  timeout: DURATION + 4 * 60 * 1000,
  check (report) {
    const r = report.steps[0].result
    if (!r.survived) throw new Error('the bot died')
    const kills = Object.values(r.killed).reduce((a, b) => a + b, 0)
    if (kills < 3) throw new Error(`only ${kills} hostiles killed in ${DURATION / 1000} s: ${JSON.stringify(r.killed)}`)
  }
}
