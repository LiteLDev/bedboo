// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * N1 without any cheat: from U17's M3 end-state snapshot (`u17-s<seed>-m3`, seed 1234: the agent's own diamond
 * pickaxe, iron gear and bucket), run by U17's Agent (its safety behaviours guard the portal skill through
 * combat.guardFor). The agent obtains a second bucket and an iron ingot itself (U17's obtain planner), walks back to the
 * world spawn (surface lava 57 blocks away on seed 1234) and runs the portal skill: bucket-cast obsidian, frame,
 * flint and steel, light, enter → the Nether.
 *
 * A milestone in U17's format (`{ id, name, steps, verify }`), run with scenarios/overworld/harness.js `runMilestone`
 * from the M3 snapshot (built on demand by running M1–M3 when missing).
 */
const N1M3 = {
  id: 'N1M3',
  name: 'N1 nether entry from M3',
  steps: [
    { skill: 'obtain', name: 'second bucket', args: { item: 'bucket', count: 2 }, timeout: 8 * 60 * 1000 },
    { skill: 'obtain', name: 'iron ingot for the flint and steel', args: { item: 'iron_ingot', count: 1 }, timeout: 6 * 60 * 1000 },
    { skill: 'navigate', name: 'back to the spawn', args: { spawn: true }, timeout: 4 * 60 * 1000 },
    { skill: 'portal', name: 'portal', args: { obsidian: 10, enter: true }, timeout: 14 * 60 * 1000 }
  ],
  timeout: 30 * 60 * 1000,
  verify (agent) {
    const bot = agent.bot
    if (bot.game.dimension !== 'the_nether') throw new Error(`not in the nether: ${bot.game.dimension}`)
    return { dimension: bot.game.dimension }
  }
}

module.exports = { N1M3 }
