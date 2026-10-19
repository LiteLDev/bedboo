// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * The live world model for the obtain planner (src/planner.js): recipes from `bot.recipesAll`, furnace recipes and
 * fuels from src/data, block sources from the registry's drops + harvest tools, costs from what `bot.findBlocks`
 * sees around the bot.
 */
const data = require('./data')
const world = require('./world')
const inventory = require('./inventory')
const { fromMineflayerRecipe } = require('./planner')

const dropIndex = new WeakMap()

/** registry block drops as names (drops are item ids, or `{ drop }` objects in some minecraft-data versions) */
function dropNames (registry, block) {
  return (block.drops ?? []).map((d) => {
    const id = typeof d === 'object' && d !== null ? (d.drop?.id ?? d.drop ?? d.id) : d
    return registry.items[id]?.name
  }).filter(Boolean)
}

/**
 * Blocks whose drops include `item`: [{ block, yield, tools, kind }] (`tools` null when the hand harvests it,
 * `kind` 'mine' for pickaxe blocks, else 'gather').
 */
function blocksDropping (registry, item) {
  let index = dropIndex.get(registry)
  if (!index) {
    index = new Map()
    for (const block of registry.blocksArray) {
      if (!block.diggable || block.hardness === null || block.hardness < 0) continue
      const drops = dropNames(registry, block)
      for (const name of new Set(drops)) {
        const y = data.dropYield(block.name, name, drops)
        if (!(y > 0)) continue
        if (!index.has(name)) index.set(name, [])
        index.get(name).push({
          block: block.name,
          yield: y,
          tools: inventory.harvestToolNames(registry, block),
          kind: (block.material ?? '').includes('mineable/pickaxe') ? 'mine' : 'gather',
          hardness: block.hardness
        })
      }
    }
    dropIndex.set(registry, index)
  }
  return index.get(item) ?? []
}

/** planner recipes for `item` (every crafting-grid recipe the server sent, tags expanded) */
function recipesFor (bot, item) {
  const it = bot.registry.itemsByName[item]
  if (!it || typeof bot.recipesAll !== 'function') return []
  const seen = new Set()
  const out = []
  for (const r of bot.recipesAll(it.id, null, true)) {
    const pr = fromMineflayerRecipe(bot.registry, r)
    if (!pr || pr.result.name !== item) continue
    const sig = `${pr.result.count}|${pr.requiresTable}|${Object.entries(pr.ingredients).sort().map(([k, v]) => `${k}${v}`).join(',')}`
    if (seen.has(sig)) continue
    seen.add(sig)
    out.push(pr)
  }
  return out
}

const searchCache = new WeakMap()
const CACHE_MS = 15000

/**
 * Up to 4 diggable positions of `blocks` within `radius`, nearest first — cached per bot for a few seconds while the
 * bot stays put (planning asks for the same blocks over and over).
 */
function nearestBlocks (bot, blocks, radius) {
  let cache = searchCache.get(bot)
  if (!cache) { cache = new Map(); searchCache.set(bot, cache) }
  const key = `${blocks.join(',')}@${radius}`
  const here = bot.entity.position
  const hit = cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS && hit.from.distanceTo(here) < 4) {
    // drop positions dug since
    return hit.found.filter((p) => blocks.includes(bot.blockAt(p)?.name))
  }
  const found = world.findBlocks(bot, blocks, { maxDistance: radius, count: 4, filter: (p) => world.safeToDig(bot, p) })
  cache.set(key, { at: Date.now(), from: here.clone(), found })
  return found
}

/** the seconds it takes to reach and dig one block at `pos` (rough) */
function blockCost (bot, pos, hardness) {
  const here = bot.entity.position
  const down = Math.max(0, here.y - pos.y)
  const up = Math.max(0, pos.y - here.y - 2)
  return 3 + world.distXZ(pos, here) / 4 + down * 1.1 + up * 1.5 + (hardness ?? 1.5) * 0.5
}

/**
 * Planner sources of `item`, grouped by kind + tools (deepslate variants together), with a cost from the nearest
 * loaded block (or an exploration estimate for natural blocks, Infinity otherwise).
 * @param {object} bot
 * @param {string} item
 * @param {{ failures?: Map<string, number>, maxDistance?: number, exclude?: (pos) => boolean }} [opts]
 */
function sourcesFor (bot, item, { failures, maxDistance = 128 } = {}) {
  const groups = new Map()
  for (const s of blocksDropping(bot.registry, item)) {
    const k = `${s.kind}|${s.tools ? s.tools.slice().sort().join(',') : '-'}|${s.yield}`
    if (!groups.has(k)) groups.set(k, { kind: s.kind, blocks: [], tools: s.tools, yield: s.yield, hardness: s.hardness })
    groups.get(k).blocks.push(s.block)
  }
  const out = []
  for (const g of groups.values()) {
    const natural = g.blocks.map((b) => data.NATURAL[b]).filter(Boolean)
    // a block that does not generate (stripped logs, walls, …) only counts when it is right here: searching the whole
    // loaded world for something that is not there is what makes findBlocks slow
    const radius = !natural.length ? 16 : g.kind === 'mine' ? maxDistance : Math.min(maxDistance, 96)
    const found = nearestBlocks(bot, g.blocks, radius)
    let cost
    if (found.length) cost = Math.min(...found.map((p) => blockCost(bot, p, g.hardness)))
    else if (!natural.length) cost = Infinity
    // out of sight: rare ones (diamonds) and those of particular biomes (acacia in savannas) are far to look for
    else cost = (natural.every((n) => n.rare) ? 300 : 150) + (natural.every((n) => n.biomes) ? 450 : 0)
    const n = failures?.get(`${g.kind}:${item}`) ?? 0
    if (n >= 3) cost = Infinity
    else cost *= 1 + 2 * n
    out.push({ kind: g.kind, blocks: g.blocks, tools: g.tools, yield: g.yield, cost })
  }
  return out
}

/** visible mobs dropping `item` (passive ones) */
function mobsFor (bot, item, { failures } = {}) {
  const out = []
  for (const s of data.mobSources(item)) {
    const e = bot.nearestEntity((x) => x.name === s.mob && x.position.distanceTo(bot.entity.position) < 48)
    if (!e) continue
    const n = failures?.get(`kill:${item}`) ?? 0
    if (n >= 3) continue
    out.push({ mob: s.mob, yield: s.yield, cost: (12 + e.position.distanceTo(bot.entity.position) / 4) * (1 + 2 * n) })
  }
  return out
}

/** a usable station block nearby (crafting_table / furnace), see stations.stationNear */
function stationNear (bot, name, radius) {
  return require('./stations').stationNear(bot, name, radius)
}

/**
 * The planner's world model for a live bot.
 * @param {object} bot
 * @param {{ failures?: Map<string, number> }} [opts]
 */
function worldModel (bot, { failures } = {}) {
  const fuels = data.FUEL_CANDIDATES.filter((n) => bot.registry.itemsByName[n]).map((name) => ({ name, perItem: data.itemsPerFuel(name) }))
  const failed = (key) => (failures?.get(key) ?? 0) >= 3
  return {
    inventory: inventory.counts(bot),
    recipes: (item) => failed(`craft:${item}`) ? [] : recipesFor(bot, item),
    smelting: (item) => failed(`smelt:${item}`) ? [] : data.smeltingSources(item).filter((r) => bot.registry.itemsByName[r.input]).map((r) => ({ input: r.input, count: r.count })),
    fuels,
    sources: (item) => sourcesFor(bot, item, { failures }),
    mobs: (item) => mobsFor(bot, item, { failures }),
    stations: {
      crafting_table: !!stationNear(bot, 'crafting_table'),
      furnace: !!stationNear(bot, 'furnace')
    }
  }
}

module.exports = { blocksDropping, dropNames, recipesFor, sourcesFor, mobsFor, stationNear, worldModel, blockCost }
