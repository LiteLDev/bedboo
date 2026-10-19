// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Mine ores and stone: the nearest loaded block (bot.findBlocks sees every loaded sub-chunk, -64..319), reached by a
 * safe vertical shaft when it is deep below and by mineflayer-pathfinder otherwise; dug with the best tool that can
 * harvest it (a missing tool is a `MISSING` error: `obtain` gets the tool first). Exploration (towards the biomes
 * the ore needs, e.g. mountains for emerald) when none is loaded.
 *
 * Skill `mine` — args: { item?, block?, blocks?, count?: 1, maxDistance?: 128 } | { all: [{ item, count? }] }
 *   `item` = what to gain ('diamond', 'raw_iron', …: every block dropping it counts, deepslate variants included),
 *   or `block`/`blocks` = what to dig (count = blocks).
 * result: { mined: { [block]: n }, collected: { [item]: n }, ms }
 *
 * Also exported: `mineAll(bot, { targets: [{ item, count }] })` — one target after the other, nearest first.
 */
const { defineSkill, log } = require('../skill')
const { checkAbort } = require('../errors')
const gather = require('./gather')
const inventory = require('../inventory')
const knowledge = require('../knowledge')
const world = require('../world')

const mine = defineSkill('mine', (bot, args) => {
  if (args.all) return mineAll(bot, { ...args, targets: args.all })
  return gather.run(bot, { ...args, blocks: args.blocks ?? (args.block ? [args.block] : undefined) }, 'mine')
}, { description: 'mine ores / stone (shaft down to deep ores, explore when none is loaded)' })

/**
 * Several items, nearest source first. @returns {Promise<{ results: Record<string, object> }>}
 */
async function mineAll (bot, { targets, signal, all, ...rest }) {
  const left = targets.map((t) => ({ ...t, count: t.count ?? 1, start: inventory.count(bot, t.item) }))
  const results = {}
  while (left.length) {
    checkAbort(signal)
    // nearest loaded source of any remaining target
    let best = null
    for (const t of left) {
      const blocks = gather.blocksFor(bot, t.item, null)
      const p = world.findBlocks(bot, blocks, { maxDistance: 128, count: 1 })[0]
      const cost = p ? knowledge.blockCost(bot, p) : Infinity
      if (!best || cost < best.cost) best = { t, cost }
    }
    const t = best.t
    log(bot, `mineAll: next ${t.item} (${Number.isFinite(best.cost) ? `~${Math.round(best.cost)} s` : 'explore'})`)
    results[t.item] = await gather.run(bot, { ...rest, item: t.item, count: t.count, signal }, 'mine')
    left.splice(left.indexOf(t), 1)
  }
  return { results }
}

module.exports = Object.assign(mine, { mineAll })
