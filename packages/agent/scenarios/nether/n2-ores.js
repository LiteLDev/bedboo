// owner: U18 (agent combat & dimensions)
'use strict'
/**
 * N2 — nether ores: through a portal into the Nether, mine nether quartz ore, nether gold ore and ancient debris
 * (preferably in the y 8–22 band, branch-mining at y 15 when none is in reach) with a diamond pickaxe, survive the
 * Nether's mobs on difficulty normal (combat.defend: retaliation, hoglins / magma cubes, ghast fireballs), and come
 * back through the same portal.
 *
 * Cheat-assisted (documented in docs/differences/U18.md): the kit (diamond pickaxe and sword, diamond armor + a golden
 * helmet so piglins stay neutral — hoglin packs knock an iron-clad bot off ledges, food, 64 cobblestone to pillar / bridge with, a flint and steel) is given with /give, and the overworld portal FRAME is
 * placed with /setblock next to the spawn (N1 covers casting the obsidian and building a frame). The bot lights it,
 * walks in, mines and returns on its own. In the chained run (N1 → N2) the bot uses its own portal instead.
 */
const seed = require('./seed.json')

module.exports = {
  name: 'N2-nether-ores',
  description: 'quartz, nether gold and ancient debris in the nether, back through the portal',
  server: { world: 'default', seed: seed.seed, gamemode: 'survival', difficulty: 'normal', profile: 'none', gamerules: { dodaylightcycle: false, doweathercycle: false } },
  viewDistance: 8,
  setup: ['time set day', 'weather clear'],
  kit: [
    ['diamond_pickaxe', 1],
    ['diamond_sword', 1],
    ['diamond_chestplate', 1],
    ['diamond_leggings', 1],
    ['diamond_boots', 1],
    ['golden_helmet', 1],
    ['shield', 1],
    ['cooked_beef', 32],
    ['cobblestone', 64],
    ['flint_and_steel', 1]
  ],
  /** the frame next to the spawn: /setblock (cheat-assisted), corners cobblestone */
  async prepare ({ bot, cmd, data, log }) {
    const portal = require('../../src/skills/portal')
    const combat = require('../../src/skills/combat')
    await combat.equipForCombat(bot)
    const site = portal.findPortalSite((p) => bot.blockAt(p), bot.entity.position, { radius: 16 })
    if (!site) throw new Error('no portal site near the spawn')
    const plan = portal.planPortalFrame(site.base, site.axis)
    for (const step of plan.steps) {
      if (step.block === 'support' && bot.blockAt(step.pos)?.boundingBox === 'block') continue
      const block = step.block === 'clear' ? 'air' : step.block === 'obsidian' ? 'obsidian' : 'cobblestone'
      await cmd(`setblock ${step.pos.x} ${step.pos.y} ${step.pos.z} ${block}`)
    }
    data.origin = { x: plan.base.x, y: plan.base.y, z: plan.base.z }
    data.axis = plan.axis
    data.side = site.side
    log(`prepare: obsidian frame at ${plan.base} axis ${plan.axis} (setblock)`)
  },
  steps: (ctx) => [
    // the bot lights the prepared frame itself (no obsidian needed: the frame is complete)
    { skill: 'portal', name: 'light', args: { origin: ctx.data.origin, axis: ctx.data.axis, side: ctx.data.side, enter: false }, timeout: 3 * 60 * 1000 },
    { skill: 'nether', name: 'nether', args: { targets: { quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 } }, timeout: 14 * 60 * 1000 }
  ],
  timeout: 16 * 60 * 1000,
  check (report, { bot }) {
    const r = report.steps[1].result
    if (!r.returned || bot.game.dimension !== 'overworld') throw new Error(`not back in the overworld (${bot.game.dimension})`)
    for (const [block, n] of Object.entries({ quartz_ore: 3, nether_gold_ore: 3, ancient_debris: 1 })) {
      if ((r.mined[block] ?? 0) < n) throw new Error(`${block}: ${r.mined[block] ?? 0}/${n}`)
    }
    if (r.items.quartz < 3 || r.items.gold_nugget < 3 || r.items.ancient_debris < 1) throw new Error(`items ${JSON.stringify(r.items)}`)
  }
}
