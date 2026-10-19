// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * The obtain planner: how to get `count` × `item` from what the bot has and sees.
 *
 * Pure (no bot): it works on a world model, so unit tests drive it with fakes and src/skills/obtain.js with the live
 * bot (`worldModel(bot)`). The obtain skill re-plans after every executed step (the world changes: drops vary, a tree
 * is farther than it looked, a tool breaks), so a plan only has to be good, not exact.
 *
 * World model:
 *   inventory               { [item]: count }
 *   recipes(item)           [{ result: { name, count }, ingredients: { [name]: count }, requiresTable, id? }]
 *   smelting(item)          [{ input, count }]          furnace recipes producing `item` (`count` per input)
 *   fuels                   [{ name, perItem }]         fuel items and how many items one smelts
 *   sources(item)           [{ kind: 'mine'|'gather', blocks: [name], tools: [name]|null, yield, cost }]
 *                           blocks dropping `item`: `tools` harvest them (null: the hand does), `yield` items per
 *                           block, `cost` seconds to reach and dig one (Infinity: unavailable)
 *   mobs(item)              [{ mob, yield, cost }]      (optional) mobs dropping it
 *   stations                { crafting_table: bool, furnace: bool }  one is placed near the bot
 *
 * Result: `{ ok: true, steps, cost }` with `steps` in execution order (dependencies first) — each step is one of
 *   { action: 'craft', item, count, times, ingredients: { [name]: n }, table: bool }
 *   { action: 'smelt', item, count, input, inputCount, fuel, fuelCount }
 *   { action: 'mine' | 'gather', item, count, blocks: [name], tools: [name]|null }
 *   { action: 'kill', item, count, mobs: [name] }
 * — or `{ ok: false, reason }`. `steps[0]` can always be executed with the current inventory.
 */

/** cost of `deficit` more units at `each` seconds (no deficit costs nothing, even when the item is unobtainable) */
const more = (deficit, each) => deficit > 0 ? deficit * each : 0

/** seconds: one craft request (plus walking to / placing a table) */
const CRAFT_COST = 2
const PLACE_COST = 4
/** seconds per smelted item (200 furnace ticks) + taking it out */
const SMELT_COST = 10.5

class PlanError extends Error {}

/**
 * @param {{ item: string, count?: number }} goal
 * @param {object} world see above
 * @param {{ maxDepth?: number }} [opts]
 */
function plan (goal, world, opts = {}) {
  const planner = new Planner(world, opts)
  try {
    return planner.run(goal.item, goal.count ?? 1)
  } catch (err) {
    if (err instanceof PlanError) return { ok: false, reason: err.message, steps: [] }
    throw err
  }
}

class Planner {
  constructor (world, { maxDepth = 12 } = {}) {
    this.world = world
    this.maxDepth = maxDepth
    this.memo = new Map()
    this.cache = { recipes: new Map(), smelting: new Map(), sources: new Map(), mobs: new Map() }
    this.fuels = (world.fuels ?? []).filter((f) => f.perItem > 0)
  }

  // ---- cached world queries ----------------------------------------------------------------------------------------
  recipes (item) { return this.cached('recipes', item, () => this.world.recipes?.(item) ?? []) }
  smelting (item) { return this.cached('smelting', item, () => this.world.smelting?.(item) ?? []) }
  sources (item) { return this.cached('sources', item, () => this.world.sources?.(item) ?? []) }
  mobs (item) { return this.cached('mobs', item, () => this.world.mobs?.(item) ?? []) }
  cached (kind, item, fn) {
    const map = this.cache[kind]
    if (!map.has(item)) map.set(item, fn())
    return map.get(item)
  }

  hasStation (name, inv) {
    return !!this.world.stations?.[name] || (inv[name] ?? 0) > 0
  }

  /**
   * Estimated seconds to obtain ONE more `item` from scratch (inventory ignored, except tools and stations already
   * owned). All estimates are computed together as a fixpoint over the items reachable from `item` (recipes,
   * furnace inputs, fuels, harvest tools, stations): every cost starts at what can be dug / hunted, then recipes and
   * furnace recipes lower it until nothing changes — cycles (planks ↔ logs ↔ wood, ingot ↔ block) can never lower a
   * cost, so they need no special casing.
   */
  estimate (item) {
    if (!this.memo.has(item)) this.computeEstimates(item)
    return this.memo.get(item)
  }

  /** the items whose cost `item`'s cost depends on (transitively), `item` included */
  reachable (item) {
    const seen = new Set()
    const queue = [item, 'crafting_table', 'furnace', ...this.fuels.map((f) => f.name)]
    while (queue.length) {
      const it = queue.pop()
      if (seen.has(it) || this.memo.has(it)) continue
      seen.add(it)
      for (const r of this.recipes(it)) for (const ing of Object.keys(r.ingredients)) queue.push(ing)
      for (const sm of this.smelting(it)) queue.push(sm.input)
      for (const src of this.sources(it)) for (const t of src.tools ?? []) queue.push(t)
    }
    return seen
  }

  computeEstimates (root) {
    const items = [...this.reachable(root)]
    const inv = this.world.inventory ?? {}
    const est = new Map(items.map((it) => [it, Infinity]))
    const get = (it) => this.memo.has(it) ? this.memo.get(it) : (est.get(it) ?? Infinity)
    const relax = (item) => {
      let best = Infinity
      for (const r of this.recipes(item)) {
        let c = CRAFT_COST
        for (const [ing, n] of Object.entries(r.ingredients)) {
          c += get(ing) * n
          if (!Number.isFinite(c)) break
        }
        if (r.requiresTable && !this.hasStation('crafting_table', inv)) c += get('crafting_table') + PLACE_COST
        best = Math.min(best, c / r.result.count)
      }
      if (this.smelting(item).length) {
        let fuel = Infinity
        for (const f of this.fuels) fuel = Math.min(fuel, get(f.name) / f.perItem)
        for (const sm of this.smelting(item)) {
          let c = SMELT_COST + get(sm.input) + fuel
          if (!this.hasStation('furnace', inv)) c += get('furnace') + PLACE_COST
          best = Math.min(best, c / sm.count)
        }
      }
      for (const src of this.sources(item)) {
        if (!(src.yield > 0) || !Number.isFinite(src.cost)) continue
        let c = src.cost / src.yield
        if (src.tools && !src.tools.some((t) => (inv[t] ?? 0) > 0)) c += Math.min(...src.tools.map(get))
        best = Math.min(best, c)
      }
      for (const m of this.mobs(item)) {
        if (!(m.yield > 0) || !Number.isFinite(m.cost)) continue
        best = Math.min(best, m.cost / m.yield)
      }
      return best
    }
    // Bellman-Ford style: at most |items| rounds, usually a handful
    for (let round = 0; round <= items.length; round++) {
      let changed = false
      for (const it of items) {
        const c = relax(it)
        if (c < est.get(it) - 1e-9) {
          est.set(it, c)
          changed = true
        }
      }
      if (!changed) break
    }
    for (const [it, c] of est) this.memo.set(it, c)
  }

  run (item, count) {
    const inv = { ...(this.world.inventory ?? {}) }
    const steps = []
    const cost = this.acquire(item, count, inv, [], steps)
    return { ok: true, steps, cost }
  }

  /**
   * Make `inv[item] >= need`, appending the steps; returns the estimated cost. Items acquired for a parent are
   * reserved (taken out of `inv`) by the parent right after, so a later sibling cannot use them up.
   */
  acquire (item, need, inv, stack, steps) {
    const have = inv[item] ?? 0
    if (have >= need) return 0
    if (stack.length > this.maxDepth) throw new PlanError(`too deep: ${stack.join(' → ')} → ${item}`)
    const missing = need - have
    const options = []
    const why = []

    for (const r of this.recipes(item)) {
      const times = Math.ceil(missing / r.result.count)
      let c = CRAFT_COST
      for (const [ing, n] of Object.entries(r.ingredients)) {
        if (ing === item || stack.includes(ing)) { c = Infinity; break }
        c += more(n * times - (inv[ing] ?? 0), this.estimate(ing))
        if (!Number.isFinite(c)) break
      }
      if (r.requiresTable && !this.hasStation('crafting_table', inv)) c += this.estimate('crafting_table') + PLACE_COST
      if (Number.isFinite(c)) options.push({ cost: c, kind: 'craft', recipe: r, times })
    }
    if (this.recipes(item).length && !options.some((o) => o.kind === 'craft')) why.push('no craftable recipe')

    for (const s of this.smelting(item)) {
      if (s.input === item || stack.includes(s.input)) continue
      const k = Math.ceil(missing / s.count)
      let c = SMELT_COST * k + more(k - (inv[s.input] ?? 0), this.estimate(s.input))
      const fuel = this.chooseFuel(k, inv, stack, s.input)
      if (!fuel) continue
      c += fuel.cost
      if (!this.hasStation('furnace', inv)) c += this.estimate('furnace') + PLACE_COST
      if (Number.isFinite(c)) options.push({ cost: c, kind: 'smelt', smelt: s, k, fuel })
    }

    for (const src of this.sources(item)) {
      if (!(src.yield > 0) || !Number.isFinite(src.cost)) continue
      const blocks = Math.ceil(missing / src.yield)
      let c = blocks * src.cost
      let tool = null
      if (src.tools && !src.tools.some((t) => (inv[t] ?? 0) > 0)) {
        let best = Infinity
        for (const t of src.tools) {
          if (stack.includes(t)) continue
          const e = this.estimate(t)
          if (e < best) { best = e; tool = t }
        }
        if (!tool) { why.push(`no tool for ${src.blocks.join('/')}`); continue }
        c += best
      }
      if (Number.isFinite(c)) options.push({ cost: c, kind: 'source', src, tool })
    }

    for (const m of this.mobs(item)) {
      if (!(m.yield > 0) || !Number.isFinite(m.cost)) continue
      options.push({ cost: Math.ceil(missing / m.yield) * m.cost, kind: 'mob', mob: m })
    }

    if (!options.length) {
      const path = stack.length ? ` (for ${stack.join(' → ')})` : ''
      throw new PlanError(`no way to obtain ${missing} ${item}${path}${why.length ? `: ${why.join(', ')}` : ''}`)
    }
    options.sort((a, b) => a.cost - b.cost)
    // the estimates ignore the acquisition stack: the cheapest option may lead back through `item` itself (ingot ←
    // nuggets ← ingot) and fail deeper down — then undo it and try the next one
    let lastError = null
    for (const choice of options) {
      const invBefore = { ...inv }
      const stepsBefore = steps.length
      stack.push(item)
      try {
        switch (choice.kind) {
          case 'craft': return this.applyCraft(item, choice, inv, stack, steps)
          case 'smelt': return this.applySmelt(item, choice, inv, stack, steps)
          case 'source': return this.applySource(item, missing, choice, inv, stack, steps)
          case 'mob': return this.applyMob(item, missing, choice, inv, steps)
        }
      } catch (err) {
        if (!(err instanceof PlanError)) throw err
        lastError = err
        for (const k of Object.keys(inv)) delete inv[k]
        Object.assign(inv, invBefore)
        steps.length = stepsBefore
      } finally {
        stack.pop()
      }
    }
    throw lastError
  }

  /** acquire `n` × `name` and take them out of `inv` (reserved for the caller); returns [cost, release] */
  reserve (name, n, inv, stack, steps, reserved) {
    const c = this.acquire(name, n, inv, stack, steps)
    inv[name] -= n
    reserved[name] = (reserved[name] ?? 0) + n
    return c
  }

  applyCraft (item, { recipe, times }, inv, stack, steps) {
    let cost = CRAFT_COST
    if (recipe.requiresTable && !this.hasStation('crafting_table', inv)) cost += this.acquire('crafting_table', 1, inv, stack, steps) + PLACE_COST
    const reserved = {}
    const ingredients = {}
    for (const [ing, n] of Object.entries(recipe.ingredients)) {
      cost += this.reserve(ing, n * times, inv, stack, steps, reserved)
      ingredients[ing] = n * times
    }
    const made = times * recipe.result.count
    inv[item] = (inv[item] ?? 0) + made
    steps.push({ action: 'craft', item, count: made, times, ingredients, table: !!recipe.requiresTable, ...(recipe.id !== undefined ? { recipe: recipe.id } : {}) })
    return cost
  }

  /** cheapest fuel for `k` items (fuel already carried first), excluding the smelted input itself when short */
  chooseFuel (k, inv, stack, input) {
    let best = null
    for (const f of this.fuels) {
      if (stack.includes(f.name)) continue
      const units = Math.ceil(k / f.perItem)
      const spare = Math.max(0, (inv[f.name] ?? 0) - (f.name === input ? k : 0))
      const c = more(units - spare, this.estimate(f.name))
      if (!Number.isFinite(c)) continue
      if (!best || c < best.cost || (c === best.cost && units < best.units)) best = { name: f.name, units, cost: c }
    }
    return best
  }

  applySmelt (item, { smelt, k }, inv, stack, steps) {
    let cost = SMELT_COST * k
    if (!this.hasStation('furnace', inv)) cost += this.acquire('furnace', 1, inv, stack, steps) + PLACE_COST
    const reserved = {}
    cost += this.reserve(smelt.input, k, inv, stack, steps, reserved)
    // choose the fuel again now that the input is reserved (the inventory changed)
    const fuel = this.chooseFuel(k, inv, stack, null)
    if (!fuel) throw new PlanError(`no fuel to smelt ${k} ${smelt.input}`)
    cost += this.reserve(fuel.name, fuel.units, inv, stack, steps, reserved)
    const made = k * smelt.count
    inv[item] = (inv[item] ?? 0) + made
    steps.push({ action: 'smelt', item, count: made, input: smelt.input, inputCount: k, fuel: fuel.name, fuelCount: fuel.units })
    return cost
  }

  applySource (item, missing, { src, tool }, inv, stack, steps) {
    let cost = 0
    if (tool) cost += this.acquire(tool, 1, inv, stack, steps)
    cost += Math.ceil(missing / src.yield) * src.cost
    inv[item] = (inv[item] ?? 0) + missing
    steps.push({ action: src.kind ?? 'mine', item, count: missing, blocks: src.blocks.slice(), tools: src.tools ? src.tools.slice() : null })
    return cost
  }

  applyMob (item, missing, { mob }, inv, steps) {
    inv[item] = (inv[item] ?? 0) + missing
    steps.push({ action: 'kill', item, count: missing, mobs: [mob.mob] })
    return Math.ceil(missing / mob.yield) * mob.cost
  }
}

/**
 * Convert a prismarine-recipe Recipe (mineflayer `bot.recipesAll`) to the planner's recipe shape.
 * @param {object} registry bot.registry
 * @param {object} recipe prismarine Recipe ({ result, delta, requiresTable })
 */
function fromMineflayerRecipe (registry, recipe) {
  const ingredients = {}
  for (const d of recipe.delta ?? []) {
    if (d.count >= 0) continue
    const name = registry.items[d.id]?.name
    if (!name) return null
    ingredients[name] = (ingredients[name] ?? 0) - d.count
  }
  const resultName = registry.items[recipe.result.id]?.name
  if (!resultName || !Object.keys(ingredients).length) return null
  return { result: { name: resultName, count: recipe.result.count }, ingredients, requiresTable: !!recipe.requiresTable, id: recipe.networkId }
}

module.exports = { plan, Planner, PlanError, fromMineflayerRecipe, CRAFT_COST, SMELT_COST, PLACE_COST }
