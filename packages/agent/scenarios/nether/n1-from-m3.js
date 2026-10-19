// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * N1 without any cheat, from U17's end-state snapshots of seed 1234 under U17's Agent (its safety behaviours guard the
 * portal skill through combat.guardFor):
 *
 * - **N1M3** from `u17-s1234-m3` (M3's end: the agent's own diamond pickaxe, iron gear and a bucket, deep under the
 *   spawn at the diamonds);
 * - **N1M5** from `u17-s1234-m5` (M5's end: every overworld ore mined, the bot ≈ 135 blocks west of the spawn at
 *   y 1–7 under the meadow — where the final chain's nether part starts).
 *
 * The agent obtains a second bucket and an iron ingot itself (U17's obtain planner), then runs the portal skill: (the
 * night ahead and no armor: a sealed pocket until the morning — M3's snapshot is ≈ 200 s before nightfall), up to
 * the surface, a water bucket, bucket-cast obsidian at a lava pool (the pools it sees, ranked; the scouted surface pool
 * east of the spawn as a hint — a player who remembers where the lava was), frame, flint and steel, light, enter → the
 * Nether. The hints come from scenarios/nether/seed-1234.json (scouted with scout.js --pools).
 *
 * Milestones in U17's format (`{ id, name, steps, verify }`), run with scenarios/overworld/harness.js `runMilestone`
 * from the snapshot (built on demand by running the earlier milestones when missing).
 */
const SEED = require('./seed-1234.json')

/** the portal step of the chain: seed 1234's scouted lava pool and lake as hints */
const PORTAL_STEP = {
  skill: 'portal',
  name: 'portal',
  args: { obsidian: 10, enter: true, lava: SEED.lava.hints, water: SEED.water.hints },
  // up to 12 min of it waiting out a night in a shelter (an unarmored bot does not cast next to lava at night)
  timeout: 30 * 60 * 1000
}

function n1From (id, name) {
  return {
    id,
    name,
    steps: [
      { skill: 'obtain', name: 'second bucket', args: { item: 'bucket', count: 2 }, timeout: 8 * 60 * 1000 },
      { skill: 'obtain', name: 'iron ingot for the flint and steel', args: { item: 'iron_ingot', count: 1 }, timeout: 6 * 60 * 1000 },
      PORTAL_STEP
    ],
    timeout: 45 * 60 * 1000,
    verify (agent) {
      const bot = agent.bot
      if (bot.game.dimension !== 'the_nether') throw new Error(`not in the nether: ${bot.game.dimension}`)
      return { dimension: bot.game.dimension }
    }
  }
}

const N1M3 = n1From('N1M3', 'N1 nether entry from M3')
const N1M5 = n1From('N1M5', 'N1 nether entry from M5')

/**
 * N1M5H: N1M5, then the chain's "back home" phase — the nether skill under the Agent (`targets`: the chain's
 * `--nether-ores` set with BEDBOO_U18_NETHER_ORES=1, else nothing to mine), back through the bot's own portal.
 */
function n1HomeFrom (id, name, targets = {}) {
  const base = n1From(id, name)
  return {
    ...base,
    steps: [...base.steps, { skill: 'nether', name: 'back home', args: { targets, returnHome: true }, timeout: 14 * 60 * 1000, retries: 1 }],
    timeout: 60 * 60 * 1000,
    verify (agent) {
      const bot = agent.bot
      if (bot.game.dimension !== 'overworld') throw new Error(`not back in the overworld: ${bot.game.dimension}`)
      return { dimension: bot.game.dimension }
    }
  }
}
const N1M5H = n1HomeFrom('N1M5H', 'N1 from M5 and back home', process.env.BEDBOO_U18_NETHER_ORES === '1' ? { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 } : {})

module.exports = { N1M3, N1M5, N1M5H, PORTAL_STEP, n1From, n1HomeFrom }
