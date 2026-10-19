// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Gather surface resources (logs, sand, gravel, dirt, leaves, …): find the nearest loaded block (exploring when none
 * is), walk there, dig it with the best tool, pick up the drops.
 *
 * Skill `gather` — args: { item?, count?: 1, blocks?: string[], maxDistance?: 64 }
 *   `item` = what to gain (its source blocks come from the registry's drops), or `blocks` = what to dig (count =
 *   blocks); 'log' / 'planks'-style shortcuts: `item: 'log'` accepts any overworld log.
 * result: { mined: { [block]: n }, collected: { [item]: n }, ms }
 */
const { SkillError } = require('../errors')
const { defineSkill, log } = require('../skill')
const knowledge = require('../knowledge')
const planner = require('../planner')
const inventory = require('../inventory')
const dig = require('../dig')

const ANY_LOG = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'cherry_log', 'mangrove_log', 'pale_oak_log', 'poplar_log']

/** block names to dig for `item` (registry drops; `kind` filters 'mine' / 'gather') */
function blocksFor (bot, item, kind) {
  if (item === 'log') return ANY_LOG
  const sources = knowledge.blocksDropping(bot.registry, item).filter((s) => !kind || s.kind === kind)
  // main drops first (a stone for cobblestone, not a cobblestone wall)
  sources.sort((a, b) => b.yield - a.yield)
  return sources.map((s) => s.block)
}

async function run (bot, args, kind) {
  let blocks = args.blocks ? [].concat(args.blocks) : null
  let item = args.item ?? null
  if (!blocks) {
    if (!item) throw new SkillError(`${kind} needs args.item or args.blocks`, { code: 'FAILED' })
    blocks = blocksFor(bot, item, null)
    if (item === 'log') item = null // any log: count blocks
    if (!blocks.length) throw new SkillError(`no block drops ${item}`, { code: 'NO_PLAN' })
  }
  const collect = () => dig.collectBlocks(bot, {
    item,
    count: args.count ?? 1,
    blocks,
    maxDistance: args.maxDistance ?? (kind === 'mine' ? 128 : 64),
    exploreDistance: args.exploreDistance ?? 320,
    biomes: args.biomes,
    timeout: args.timeout,
    signal: args.signal
  })
  // no tool that harvests the block (lost in a death, broken): get the cheapest one and carry on
  if (args.obtainTool !== false) await ensureTool(bot, blocks, args.signal)
  return collect()
}

/** carry a tool that harvests the first of `blocks` (obtain the cheapest when none is carried) */
async function ensureTool (bot, blocks, signal) {
  const block = bot.registry.blocksByName[blocks[0]]
  const tools = inventory.harvestToolNames(bot.registry, block)
  if (!tools || tools.some((t) => inventory.count(bot, t) > 0)) return null
  const estimates = new planner.Planner(knowledge.worldModel(bot))
  let best = null
  for (const t of tools) {
    const cost = estimates.estimate(t)
    if (Number.isFinite(cost) && (!best || cost < best.cost)) best = { tool: t, cost }
  }
  if (!best) return null
  log(bot, `${blocks[0]} needs one of ${tools.join(', ')}: obtaining ${best.tool}`)
  await require('./obtain').obtain(bot, { item: best.tool, count: 1, signal })
  return best.tool
}

const gather = defineSkill('gather', (bot, args) => run(bot, args, 'gather'), { description: 'collect surface blocks (logs, sand, gravel, …)' })

module.exports = Object.assign(gather, { run, blocksFor, ensureTool, ANY_LOG })
