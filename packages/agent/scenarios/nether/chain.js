// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * U18's part of the final chained run, in one world (seed 35): N1 (bucket-cast obsidian, build + light the portal,
 * enter the Nether) → N2 with the bot's OWN portal (quartz, nether gold, ancient debris, back home) → E1 (cheat-
 * assisted stronghold teleport + eyes, the End, endermen, exit portal → overworld). The coordinator prepends U17's
 * overworld milestones (their end state replaces the N1 kit). Difficulty easy, vanilla mob spawning; no gold armor:
 * piglins are fought when they attack.
 */
const n1 = require('./n1-portal')
const e1 = require('../end/e1-end')

const TARGETS = { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 }

module.exports = {
  name: 'CHAIN-N1-N2-E1',
  description: 'portal → nether ores → home → (cheat) stronghold → the End → exit',
  server: { ...n1.server, difficulty: 'easy' },
  viewDistance: 8,
  setup: n1.setup,
  kit: n1.kit,
  prepare: n1.prepare,
  steps: [
    { skill: 'portal', name: 'N1 portal', args: { obsidian: 10, enter: true }, timeout: 14 * 60 * 1000 },
    { skill: 'nether', name: 'N2 nether', args: { targets: TARGETS }, timeout: 14 * 60 * 1000 },
    { run: (ctx) => e1.toPortalRoom(ctx, { kit: [['ender_eye', 12], ['cooked_beef', 16]] }), name: 'E1 stronghold (cheat)' },
    ...e1.steps
  ],
  timeout: 45 * 60 * 1000,
  check (report, { bot }) {
    const byName = Object.fromEntries(report.steps.map((s) => [s.name, s]))
    if (!byName['N1 portal'].result.entered) throw new Error('N1: not entered')
    const nether = byName['N2 nether'].result
    if (!nether.returned) throw new Error('N2: not returned')
    for (const [block, n] of Object.entries(TARGETS)) if ((nether.mined[block] ?? 0) < n) throw new Error(`N2 ${block}: ${nether.mined[block]}/${n}`)
    if ((byName.endermen.result.killed.enderman ?? 0) < 2) throw new Error('E1: endermen')
    if (!byName.exit.result.exited || bot.game.dimension !== 'overworld') throw new Error('E1: not back in the overworld')
  }
}
