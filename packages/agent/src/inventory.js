// owner: U17 (agent core & overworld milestones)
'use strict'
/** Inventory helpers over the public mineflayer API (`bot.inventory`, `bot.heldItem`, `bot.equip`). */

/** items the bot carries: main inventory + hotbar, the off-hand and the armor slots too */
function allItems (bot) {
  const items = bot.inventory.items()
  const extra = [bot.inventory.slots[45], ...[5, 6, 7, 8].map((s) => bot.inventory.slots[s])].filter(Boolean)
  return items.concat(extra)
}

/** how many `name` the bot carries (main inventory + hotbar + off-hand + armor) */
function count (bot, name) {
  let n = 0
  for (const item of allItems(bot)) if (item.name === name) n += item.count
  return n
}

/** name → count of everything the bot carries */
function counts (bot) {
  const out = {}
  for (const item of allItems(bot)) out[item.name] = (out[item.name] ?? 0) + item.count
  return out
}

/** first stack of `name` in the main inventory / hotbar (what bot.equip / toss take) */
function find (bot, name) {
  return bot.inventory.items().find((i) => i.name === name) ?? null
}

/** first stack of any of `names`, in the order given */
function findAny (bot, names) {
  const items = bot.inventory.items()
  for (const name of names) {
    const item = items.find((i) => i.name === name)
    if (item) return item
  }
  return null
}

const TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite']
/** tool material rank by mining speed / harvest level (golden mines fast but only wood-tier blocks) */
function toolTier (name) {
  const m = /^(wooden|golden|stone|copper|iron|diamond|netherite)_/.exec(name ?? '')
  return m ? TIERS.indexOf(m[1]) : -1
}

/** `pickaxe`, `axe`, `shovel`, `hoe`, `sword` or null */
function toolKind (name) {
  const m = /_(pickaxe|axe|shovel|hoe|sword)$/.exec(name ?? '')
  return m ? m[1] : null
}

/** tool kinds by block material (Bedrock material strings: 'mineable/pickaxe', 'leaves;mineable/hoe', …) */
function toolKindsFor (block) {
  const material = block?.material ?? ''
  const kinds = []
  for (const kind of ['pickaxe', 'axe', 'shovel', 'hoe']) if (material.includes(`mineable/${kind}`)) kinds.push(kind)
  return kinds
}

/** registry names of the tools that can harvest `block` (null: anything can, the hand included) */
function harvestToolNames (registry, block) {
  if (!block?.harvestTools) return null
  return Object.keys(block.harvestTools).map((id) => registry.items[id]?.name).filter(Boolean)
}

/** whether the bot carries something that harvests `block` (or nothing is needed) */
function canHarvest (bot, block) {
  const tools = harvestToolNames(bot.registry, block)
  if (!tools) return true
  return tools.some((t) => count(bot, t) > 0)
}

/**
 * Best item in the inventory to dig `block` with: the fastest tool of the block's kind that can harvest it, else
 * the hand (null). Uses the bot's dig-time estimate when available.
 */
function bestToolFor (bot, block) {
  const harvest = harvestToolNames(bot.registry, block)
  const kinds = toolKindsFor(block)
  let best = null
  let bestTime = Infinity
  const candidates = bot.inventory.items().filter((i) => {
    const kind = toolKind(i.name)
    if (!kind || kind === 'sword' || kind === 'hoe') return harvest ? harvest.includes(i.name) : false
    return kinds.includes(kind) || harvest?.includes(i.name)
  })
  for (const item of candidates) {
    if (harvest && !harvest.includes(item.name)) continue
    const time = digTimeWith(bot, block, item)
    if (time < bestTime) { best = item; bestTime = time }
  }
  return best
}

/** prismarine-block's dig time estimate (public API; only used to rank tools) */
function digTimeWith (bot, block, item) {
  try {
    return block.digTime(item?.type ?? null, false, false, false, item?.enchants ?? [], bot.entity?.effects ?? {})
  } catch {
    return 1000 - toolTier(item?.name) * 100
  }
}

/** equip `item` (or the first stack named so) in the hand unless it is already held */
async function equip (bot, item, dest = 'hand') {
  if (typeof item === 'string') item = find(bot, item)
  if (!item) return null
  if (dest === 'hand' && bot.heldItem?.name === item.name && bot.heldItem?.type === item.type) return bot.heldItem
  await bot.equip(item, dest)
  return item
}

/** first free hotbar / inventory slot count */
function freeSlots (bot) {
  return typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 36 - bot.inventory.items().length
}

/** blocks the agent may use as scaffolding / filler, least useful first (cobblestone is a crafting / building material) */
const FILLER = ['dirt', 'andesite', 'diorite', 'granite', 'tuff', 'netherrack', 'cobbled_deepslate', 'cobblestone', 'stone', 'deepslate']

/** a filler block stack, or null */
function filler (bot, { keep = {} } = {}) {
  for (const name of FILLER) {
    const item = find(bot, name)
    if (item && count(bot, name) > (keep[name] ?? 0)) return item
  }
  return null
}

/** never worth a slot to the agent (mineshaft loot, leaves' drops, flowers, …) */
const JUNK = /^(leaf_litter|.*_sapling|wheat_seeds|beetroot_seeds|pumpkin_seeds|melon_seeds|torchflower_seeds|rail|.*_fence|.*_carpet|poisonous_potato|spider_eye|gunpowder|bone|feather|dandelion|poppy|.*_tulip|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|allium|blue_orchid|short_grass|tall_grass|fern|dead_bush|vine|glow_lichen|moss_carpet|pointed_dripstone|calcite|smooth_basalt|amethyst_shard|clay_ball|seagrass|egg|ink_sac|leather|rabbit_hide|name_tag|lead|saddle|book|paper)$/
/** blocks kept up to a number (the rest is tossed when the inventory is full): pillars, the house, scaffolding */
const KEEP = { cobblestone: 128, cobbled_deepslate: 64, dirt: 32, stone: 32, deepslate: 16, andesite: 16, diorite: 16, granite: 16, tuff: 16, gravel: 8, sand: 8, rotten_flesh: 8, stick: 16, arrow: 64 }
/**
 * `late` (the overworld's work is done, the Nether / the End ahead): building stone for pillars and bridges only, the
 * ores the milestones wanted are no longer needed
 */
const KEEP_LATE = { ...KEEP, cobblestone: 64, cobbled_deepslate: 32, dirt: 0, andesite: 0, diorite: 0, granite: 0, tuff: 0, deepslate: 0, stone: 0, rotten_flesh: 0, raw_copper: 0, raw_iron: 8, raw_gold: 0, redstone: 0, lapis_lazuli: 0, emerald: 0, coal: 8 }

/**
 * What can go when the inventory is full: junk, blocks above their KEEP amount, tools a better one of the same kind
 * replaces (a wooden / stone pickaxe next to an iron one), arrows without a bow. @returns {Array<{ name, count }>}
 */
function junk (bot, { late = false } = {}) {
  const have = counts(bot)
  const keep = late ? KEEP_LATE : KEEP
  const out = []
  for (const [name, n] of Object.entries(have)) {
    if (JUNK.test(name)) { out.push({ name, count: n }); continue }
    if (name === 'arrow' && !have.bow) { out.push({ name, count: n }); continue }
    if (Object.hasOwn(keep, name) && n > keep[name]) { out.push({ name, count: n - keep[name] }); continue }
    const kind = toolKind(name)
    if (kind && kind !== 'hoe') {
      // a better tool of this kind is carried: this one is dead weight (golden ones are only kept for the Nether's
      // piglins as armor, never as tools)
      const tier = toolTier(name)
      const better = Object.keys(have).some((o) => o !== name && toolKind(o) === kind && toolTier(o) > tier && !o.startsWith('golden_'))
      if (better && !(name.startsWith('iron_') && kind === 'pickaxe')) out.push({ name, count: n })
    }
  }
  return out
}

/** whether picking up a drop of `name` would only add junk / surplus (see `junk`) */
function unwanted (bot, name) {
  if (!name) return false
  if (JUNK.test(name)) return true
  if (name === 'arrow' && !count(bot, 'bow')) return true
  return Object.hasOwn(KEEP, name) && count(bot, name) >= KEEP[name]
}

/**
 * Free inventory slots: toss junk / surplus (see `junk`) until `minFree` slots are free. Tossed items fly a few blocks
 * ahead; the bot does not pick them up again (it is busy elsewhere, and drops are only collected around a dug block).
 * @returns {Promise<Record<string, number>>} what was tossed
 */
async function declutter (bot, { minFree = 4, keep = null, late = false } = {}) {
  const tossed = {}
  if (freeSlots(bot) >= minFree || typeof bot.toss !== 'function') return tossed
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
  // whole stacks first (junk), then the surplus of the blocks
  const list = junk(bot, { late }).filter((j) => j.name !== keep).sort((a, b) => (JUNK.test(b.name) ? 1 : 0) - (JUNK.test(a.name) ? 1 : 0))
  for (const { name, count: n } of list) {
    if (freeSlots(bot) >= minFree) break
    const def = bot.registry.itemsByName[name]
    if (!def) continue
    try {
      await bot.toss(def.id, null, n)
      tossed[name] = n
    } catch {}
  }
  return tossed
}

module.exports = { allItems, count, counts, find, findAny, toolTier, toolKind, toolKindsFor, harvestToolNames, canHarvest, bestToolFor, equip, freeSlots, FILLER, filler, TIERS, junk, unwanted, declutter, JUNK, KEEP, KEEP_LATE }
