// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Static game knowledge the planner needs and BDS does not send:
 * - smelting: furnace recipes (vendored, see smelting.json / scripts/gen-smelting.js) and fuel burn times;
 * - drop yields: average items per mined block where it is not 1 (multi-drop ores, chance drops);
 * - mob drops: what killing a mob yields (Bedrock entity names);
 * - where blocks generate: natural blocks, and the biomes rare ones need (emerald → mountains).
 */
const smelting = require('./smelting.json')

const COOK_TICKS = smelting.cookTicks

/** output name → [{ input, output, count }] */
const byOutput = new Map()
/** input name → { input, output, count } */
const byInput = new Map()
for (const r of smelting.recipes) {
  if (!byOutput.has(r.output)) byOutput.set(r.output, [])
  byOutput.get(r.output).push(r)
  byInput.set(r.input, r)
}

/** furnace recipes producing `output` */
function smeltingSources (output) {
  return byOutput.get(output) ?? []
}

/** what smelting `input` gives, or null */
function smeltResult (input) {
  return byInput.get(input) ?? null
}

const WOOD = /^(stripped_)?(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar)_(log|wood)$/
const PLANKS = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar|bamboo)_planks$/
const WOODEN_SLAB = /^(oak|spruce|birch|jungle|acacia|dark_oak|mangrove|cherry|pale_oak|poplar|bamboo)_slab$/
const SAPLING = /^(oak|spruce|birch|jungle|acacia|dark_oak|cherry|pale_oak|poplar)_sapling$/

/** burn time (furnace ticks) of a fuel item, 0 when it is no fuel */
function fuelTicks (name) {
  const f = smelting.fuels
  if (Object.hasOwn(f, name)) return f[name]
  if (WOOD.test(name)) return f['tag:logs']
  if (PLANKS.test(name)) return f['tag:planks']
  if (WOODEN_SLAB.test(name)) return f['tag:wooden_slab']
  if (SAPLING.test(name)) return f['tag:sapling']
  return 0
}

/** items one fuel item smelts in a furnace */
function itemsPerFuel (name) {
  return fuelTicks(name) / COOK_TICKS
}

/** fuels the planner may choose (preferred first when costs tie) */
const FUEL_CANDIDATES = ['coal', 'charcoal', 'coal_block', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks', 'pale_oak_planks', 'poplar_planks', 'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'pale_oak_log', 'poplar_log', 'stick', 'lava_bucket', 'blaze_rod']

/**
 * Average number of `item`s one mined `block` yields, for drops other than "one of itself / its main drop"
 * (Bedrock loot tables; fortune ignored). Keys `block>item`; deepslate / lit variants share the base block's entry.
 */
const DROP_YIELDS = {
  'redstone_ore>redstone': 4.5,
  'lapis_ore>lapis_lazuli': 6.5,
  'copper_ore>raw_copper': 3.5,
  'nether_gold_ore>gold_nugget': 4,
  'gravel>flint': 0.1,
  'gravel>gravel': 0.9,
  'clay>clay_ball': 4,
  'glowstone>glowstone_dust': 3,
  'short_grass>wheat_seeds': 0.125,
  'tall_grass>wheat_seeds': 0.125,
  'fern>wheat_seeds': 0.125,
  'large_fern>wheat_seeds': 0.125,
  'melon_block>melon_slice': 5,
  'snow_layer>snowball': 1,
  'snow>snowball': 4,
  'dead_bush>stick': 1
}
/** chance drops of leaves (sapling / stick / apple) */
const LEAF_YIELDS = { sapling: 0.05, stick: 0.02, apple: 0.005 }

function baseBlockName (block) {
  return block.replace(/^lit_/, '').replace(/^deepslate_(?=.*_ore$)/, '')
}

/**
 * Expected drops of `item` per mined `block`.
 * @param {string} block block name
 * @param {string} item item name
 * @param {string[]} drops the block's registry drop names (first = main drop)
 */
function dropYield (block, item, drops) {
  const key = `${baseBlockName(block)}>${item}`
  if (Object.hasOwn(DROP_YIELDS, key)) return DROP_YIELDS[key]
  if (/leaves/.test(block)) {
    if (/_sapling$/.test(item)) return LEAF_YIELDS.sapling
    if (item === 'stick') return LEAF_YIELDS.stick
    if (item === 'apple') return LEAF_YIELDS.apple
    return 0
  }
  if (!drops?.length) return 0
  if (drops[0] === item) return 1
  return drops.includes(item) ? 0.05 : 0
}

/** Bedrock entity name → drops (average per kill, looting ignored). Hostile mobs are only fought, never hunted. */
const MOB_DROPS = {
  cow: { beef: 2, leather: 1 },
  mooshroom: { beef: 2, leather: 1 },
  pig: { porkchop: 2 },
  sheep: { mutton: 1.5, white_wool: 1 },
  chicken: { chicken: 1, feather: 1 },
  rabbit: { rabbit: 0.5, rabbit_hide: 0.5 },
  spider: { string: 1 },
  cave_spider: { string: 1 },
  zombie: { rotten_flesh: 1 },
  skeleton: { bone: 1, arrow: 1 },
  creeper: { gunpowder: 1 }
}
const PASSIVE_MOBS = new Set(['cow', 'mooshroom', 'pig', 'sheep', 'chicken', 'rabbit'])

/** item → [{ mob, yield }] */
function mobSources (item, { hostile = false } = {}) {
  const out = []
  for (const [mob, drops] of Object.entries(MOB_DROPS)) {
    if (!hostile && !PASSIVE_MOBS.has(mob)) continue
    if (Object.hasOwn(drops, item)) out.push({ mob, yield: drops[item] })
  }
  return out
}

/** foods the agent eats, best first (cooked meat, bread, apples, raw meat last) */
const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_chicken', 'cooked_salmon', 'cooked_cod', 'baked_potato', 'bread', 'cooked_rabbit', 'apple', 'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'potato', 'dried_kelp']

/**
 * Blocks that generate in the overworld and can be looked for (explored) when none is loaded, with the biomes they
 * need. Anything else is only mined when the bot already sees one (it could be a player's build).
 */
const NATURAL = {
  stone: {},
  deepslate: {},
  andesite: {},
  diorite: {},
  granite: {},
  tuff: {},
  dirt: {},
  grass_block: {},
  sand: {},
  red_sand: {},
  gravel: {},
  clay: {},
  coal_ore: {},
  deepslate_coal_ore: {},
  iron_ore: {},
  deepslate_iron_ore: {},
  copper_ore: {},
  deepslate_copper_ore: {},
  gold_ore: {},
  deepslate_gold_ore: {},
  redstone_ore: {},
  deepslate_redstone_ore: {},
  lapis_ore: {},
  deepslate_lapis_ore: {},
  diamond_ore: { rare: true },
  deepslate_diamond_ore: { rare: true },
  emerald_ore: { rare: true, biomes: ['stony_peaks', 'jagged_peaks', 'frozen_peaks', 'snowy_slopes', 'meadow', 'grove', 'extreme_hills', 'extreme_hills_mutated', 'extreme_hills_plus_trees', 'extreme_hills_plus_trees_mutated', 'extreme_hills_edge', 'cherry_grove'] },
  deepslate_emerald_ore: { rare: true, biomes: ['stony_peaks', 'jagged_peaks', 'frozen_peaks', 'snowy_slopes', 'meadow', 'grove', 'extreme_hills', 'extreme_hills_mutated', 'extreme_hills_plus_trees', 'extreme_hills_plus_trees_mutated', 'extreme_hills_edge', 'cherry_grove'] },
  oak_log: {},
  birch_log: {},
  spruce_log: {},
  jungle_log: { biomes: ['jungle', 'jungle_hills', 'jungle_edge', 'bamboo_jungle', 'jungle_mutated'] },
  acacia_log: { biomes: ['savanna', 'savanna_plateau', 'savanna_mutated'] },
  dark_oak_log: { biomes: ['roofed_forest', 'roofed_forest_mutated'] },
  cherry_log: { biomes: ['cherry_grove'] },
  mangrove_log: { biomes: ['mangrove_swamp'] },
  pale_oak_log: { biomes: ['pale_garden'] },
  oak_leaves: {},
  birch_leaves: {},
  spruce_leaves: {},
  short_grass: {},
  tall_grass: {}
}

module.exports = {
  COOK_TICKS,
  smeltingRecipes: smelting.recipes,
  smeltingSources,
  smeltResult,
  fuelTicks,
  itemsPerFuel,
  FUEL_CANDIDATES,
  dropYield,
  baseBlockName,
  mobSources,
  MOB_DROPS,
  PASSIVE_MOBS,
  FOODS,
  NATURAL
}
