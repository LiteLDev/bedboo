// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Crafting with `bot.recipesFor` / `bot.craft`: the 2×2 grid when a recipe fits it, else a crafting table (one nearby,
 * or the carried one placed next to the bot and taken back afterwards).
 *
 * Skill `craft` — args: { item, count?: 1 }   (count = how many more `item`s to make)
 *                 result: { crafted: { [item]: n }, table: 'none'|'nearby'|'placed' }
 * Throws SkillError `NO_PLAN` (no recipe) / `MISSING` (ingredients or table missing) — use `obtain` to gather them.
 */
const { SkillError, checkAbort } = require('../errors')
const { defineSkill, log, progress } = require('../skill')
const inventory = require('../inventory')
const stations = require('../stations')

/** how many times `recipe` can be crafted from the inventory */
function maxTimes (bot, recipe) {
  let max = Infinity
  for (const d of recipe.delta) {
    if (d.count >= 0) continue
    const have = bot.inventory.items().filter((i) => i.type === d.id).reduce((n, i) => n + i.count, 0)
    max = Math.min(max, Math.floor(have / -d.count))
  }
  return max === Infinity ? 0 : max
}

/** the recipe that can be crafted the most times (ties: the first, i.e. the server's preferred one) */
function pickRecipe (bot, recipes) {
  let best = null
  let bestTimes = -1
  for (const r of recipes) {
    const t = maxTimes(bot, r)
    if (t > bestTimes) { best = r; bestTimes = t }
  }
  return best
}

/**
 * Craft until the bot has `count` more `item`s.
 * @param {object} bot
 * @param {string} item
 * @param {number} [count=1]
 * @param {{ signal?: AbortSignal, keepTable?: boolean }} [opts]
 */
async function craftItem (bot, item, count = 1, { signal, keepTable = false } = {}) {
  const it = bot.registry.itemsByName[item]
  if (!it) throw new SkillError(`unknown item ${item}`, { code: 'NO_PLAN' })
  const start = inventory.count(bot, item)
  const target = start + count
  let table = null
  let placed = null
  let how = 'none'
  try {
    for (let guard = 0; inventory.count(bot, item) < target; guard++) {
      checkAbort(signal)
      if (guard > 20) throw new SkillError(`crafting ${item}: no progress`, { code: 'FAILED' })
      const remaining = target - inventory.count(bot, item)
      let recipes = bot.recipesFor(it.id, null, 1, null)
      let useTable = false
      if (!recipes.length) {
        if (!bot.recipesAll(it.id, null, true).length) throw new SkillError(`no recipe for ${item}`, { code: 'NO_PLAN' })
        // fits only a crafting table, or the ingredients are missing: check with a table (any block works for the check)
        const tableRecipes = bot.recipesFor(it.id, null, 1, true)
        if (!tableRecipes.length) throw new SkillError(`missing ingredients for ${item}`, { code: 'MISSING' })
        if (!table) {
          const st = await stations.ensureStation(bot, 'crafting_table', { signal })
          table = st.block
          if (st.placed) placed = st.block
          how = st.placed ? 'placed' : 'nearby'
        }
        table = bot.blockAt(table.position)
        recipes = bot.recipesFor(it.id, null, 1, table)
        useTable = true
        if (!recipes.length) throw new SkillError(`missing ingredients for ${item}`, { code: 'MISSING' })
      }
      const recipe = pickRecipe(bot, recipes)
      const times = Math.max(1, Math.min(Math.ceil(remaining / recipe.result.count), maxTimes(bot, recipe)))
      log(bot, `craft ${times}× ${item} (${recipe.result.count} each)${useTable ? ' at a table' : ''}`)
      await bot.craft(recipe, times, useTable ? table : null)
    }
  } finally {
    if (placed && !keepTable && !signal?.aborted) await stations.pickUp(bot, placed, { signal })
  }
  const crafted = inventory.count(bot, item) - start
  progress(bot, 'craft', { item, count: crafted })
  return { crafted: { [item]: crafted }, table: how }
}

const craft = defineSkill('craft', async (bot, args) => {
  if (!args.item) throw new SkillError('craft needs args.item', { code: 'FAILED' })
  return craftItem(bot, args.item, args.count ?? 1, { signal: args.signal, keepTable: args.keepTable })
}, { description: 'craft an item (2×2 grid or a crafting table)' })

module.exports = Object.assign(craft, { craftItem, maxTimes, pickRecipe })
