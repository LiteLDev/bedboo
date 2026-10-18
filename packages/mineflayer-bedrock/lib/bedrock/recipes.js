// owner: U12 (crafting)
'use strict'
const ITEM_TAGS = require('./item_tags')

/**
 * Bedrock crafting recipes (`crafting_data`) → prismarine-recipe `Recipe` objects, so `bot.recipesFor`,
 * `bot.recipesAll` and `bot.craft` keep mineflayer's semantics, plus the request planner of `bot.craft`.
 *
 * Recipe model (docs/differences/U12.md#recipes):
 * - Crafting recipes are the `shaped_recipes`, `shapeless_recipes` and `shulker_box_recipes` (dyeing that keeps the
 *   input's NBT) whose `block` is `crafting_table` (the tag of every recipe of the crafting grid, 2×2 included; whether
 *   a recipe needs the table is decided by its size, exactly like prismarine-recipe's `requiresTable`). `deprecated`
 *   recipes (legacy duplicates hidden from the recipe book), furnace / stonecutter / campfire / cartography / smithing
 *   recipes, potion recipes and the special `multi_recipes` (map cloning, fireworks, banner copies… no fixed inputs)
 *   are not crafting-grid recipes and are left out.
 * - Ingredient descriptors: `name` (item identifier, metadata 32767 = any → prismarine-recipe metadata `null`),
 *   `item_tag` (members from lib/bedrock/item_tags.js: BDS never sends them), legacy `int_id_meta` /
 *   `string_id_meta` / `complex_alias` by id or name; `molang` or unknown items/tags drop the recipe (none in BDS
 *   1.26.51.1).
 * - Multi-choice ingredients are expanded like minecraft-data's Java recipes: every cell of the same tag gets the same
 *   item (one recipe per member, e.g. 13 stick recipes, one per plank type); two different tags in one recipe give
 *   the cartesian product (planks × wooden slabs for the barrel), capped at MAX_VARIANTS combinations (then the
 *   members are paired by index). Expanded recipes keep the Bedrock `network_id` of their source recipe
 *   (`recipe.networkId`), which the `craft_recipe` request action names; structurally identical expansions (the
 *   generic `minecraft:stick` with crimson planks vs `stick_from_crimson_planks`) are kept once — BDS accepts either
 *   id for the same grid.
 * - Extra results (`output[1..]`: the 3 buckets of the cake, the glass bottles of honey recipes) go straight into the
 *   inventory on Bedrock; they are added to `recipe.delta` (positive) and are not an `outShape` (nothing stays in the
 *   grid).
 * - `bot.registry.recipes` is replaced (per bot) by the same recipes in minecraft-data's Java shape (`{ result,
 *   inShape | ingredients, networkId }` keyed by result item id), filled in place on every `crafting_data`, so
 *   `require('prismarine-recipe')(bot.registry).Recipe.find(id)` works as with Java data.
 *
 * Contract:
 * - `parseCraftingData(registry, packet, { tags? }) → Recipe[]` (expanded, deduplicated, each with `networkId`)
 * - `parseBedrockRecipes(registry, packet, { tags? }) → { bedrock: Map<networkId, BedrockRecipe>, entries, skipped }`
 * - `createRecipeBook(bot, { tags? }) → { load(packet), unlock(packet), find(itemType, metadata), all(),
 *   byNetworkId(id), match(recipe), resolve(recipe), bedrockFor(recipe), networkIds(recipe), limitedCrafting(),
 *   isUnlocked(recipe), table, skipped }` (`bot._bedrock.recipes`)
 * - `planCraft(opts) → { times, steps, overflow }` one `item_stack_request` (lib/bedrock/inventory_model.js steps) for
 *   up to `remaining` crafts; throws `missing ingredient` like upstream when not even one craft is possible.
 */

const WILDCARD_METADATA = 32767
/** recipe `block` tags crafted in the player's 2×2 grid / the crafting table */
const CRAFTING_BLOCKS = new Set(['crafting_table'])
const MAX_VARIANTS = 256
/** Java slot search order of upstream's findInventoryItem / putSelectedItemRange (main inventory, then hotbar) */
const PLAYER_ORDER = Object.freeze([...Array.from({ length: 27 }, (_, i) => `p:${i + 9}`), ...Array.from({ length: 9 }, (_, i) => `p:${i}`)])

const stripNamespace = (name) => String(name).replace(/^minecraft:/, '')
const metadataOf = (m) => (m === undefined || m === null || m < 0 || m >= WILDCARD_METADATA) ? null : m

/** crafting_data packet → [{ type, recipe }] (1.26.40+ typed arrays, or the older `recipes: [{ type, recipe }]`) */
function rawRecipesOf (packet) {
  const out = []
  const add = (type, list) => { for (const recipe of list ?? []) out.push({ type, recipe }) }
  add('shaped', packet?.shaped_recipes)
  add('shaped_chemistry', packet?.shaped_chemistry_recipes)
  add('shapeless', packet?.shapeless_recipes)
  add('shapeless_chemistry', packet?.shapeless_chemistry_recipes)
  add('shulker_box', packet?.shulker_box_recipes)
  for (const entry of packet?.recipes ?? []) if (entry?.recipe) out.push({ type: entry.type, recipe: entry.recipe })
  return out
}

/**
 * @typedef {object} BedrockRecipe
 * @property {number} networkId  `network_id` (what `craft_recipe` names)
 * @property {string} recipeId   `recipe_id` (what unlocked_recipes names)
 * @property {'shaped'|'shapeless'|'shulker_box'|'shaped_chemistry'|'shapeless_chemistry'} type
 * @property {boolean} shaped
 * @property {string} block
 * @property {number} priority
 * @property {number|null} width
 * @property {number|null} height
 * @property {object[]} input  RecipeIngredient descriptors (row-major for shaped recipes)
 * @property {object[]} output wire items (ItemLegacy: network_id, count, metadata, block_runtime_id, extra)
 */

/** @returns {BedrockRecipe|null} */
function normalizeRecipe ({ type, recipe }) {
  const shaped = type === 'shaped' || type === 'shaped_chemistry'
  if (!shaped && type !== 'shapeless' && type !== 'shapeless_chemistry' && type !== 'shulker_box') return null
  if (!recipe || !Array.isArray(recipe.input) || !Array.isArray(recipe.output) || recipe.output.length === 0) return null
  return {
    networkId: recipe.network_id,
    recipeId: recipe.recipe_id,
    type,
    shaped,
    block: recipe.block,
    priority: recipe.priority ?? 0,
    width: shaped ? recipe.width : null,
    height: shaped ? recipe.height : null,
    input: recipe.input,
    output: recipe.output
  }
}

/**
 * One ingredient descriptor → `null` (empty cell), `{ key, options: [{ id, metadata }] }`, or `undefined` (cannot be
 * resolved: the recipe is skipped).
 */
function resolveIngredient (registry, desc, tags) {
  if (!desc || desc.type === 'invalid') return null
  const kind = desc.type === 'valid' ? desc.descriptor_type : desc.type
  if (kind === 'empty' || kind === 'invalid') return null
  if ((desc.count ?? 1) !== 1) return undefined // BDS sends 1; a grid cell holds one item per craft
  const metadata = metadataOf(desc.metadata)
  let item
  switch (kind) {
    case 'name':
    case 'string_id_meta':
    case 'complex_alias':
      item = registry.itemsByName[stripNamespace(desc.name)]
      break
    case 'int_id_meta':
      item = registry.items[desc.network_id]
      break
    case 'item_tag': {
      const members = tags[desc.tag]
      if (!members) return undefined
      const options = []
      for (const name of members) {
        const member = registry.itemsByName[stripNamespace(name)]
        if (member) options.push({ id: member.id, metadata: null })
      }
      return options.length ? { key: `t:${desc.tag}`, options } : undefined
    }
    default:
      return undefined
  }
  if (!item) return undefined
  return { key: `i:${item.id}:${metadata}`, options: [{ id: item.id, metadata }] }
}

/** cells (resolved ingredients) → list of concrete cell assignments ({ id, metadata } | null per cell) */
function expandCells (cells) {
  const keys = []
  const lists = []
  for (const cell of cells) {
    if (cell && cell.options.length > 1 && !keys.includes(cell.key)) {
      keys.push(cell.key)
      lists.push(cell.options)
    }
  }
  let combos = [[]]
  const product = lists.reduce((n, list) => n * list.length, 1)
  if (product <= MAX_VARIANTS) {
    for (const list of lists) combos = combos.flatMap(combo => list.map(option => [...combo, option]))
  } else {
    const n = Math.max(...lists.map(list => list.length))
    combos = Array.from({ length: n }, (_, i) => lists.map(list => list[i % list.length]))
  }
  return combos.map(combo => cells.map(cell => {
    if (!cell) return null
    const k = keys.indexOf(cell.key)
    return k === -1 ? cell.options[0] : combo[k]
  }))
}

const enumItem = (option) => option.metadata === null ? option.id : { id: option.id, metadata: option.metadata }

/** stable structural key of an enum entry (dedupe of identical expansions) */
function entryKey (entry) {
  const item = (it) => it === null ? '-' : typeof it === 'number' ? `${it}` : `${it.id}:${it.metadata}`
  const body = entry.inShape
    ? 's' + entry.inShape.map(row => row.map(item).join(',')).join('/')
    : 'l' + entry.ingredients.map(item).sort().join(',')
  const extra = (entry.extraResults ?? []).map(e => `+${e.id}:${e.metadata}x${e.count}`).join('')
  return `${entry.result.id}:${entry.result.metadata}x${entry.result.count}${extra}|${body}`
}

/**
 * @param {object} registry the bot's registry (after item_registry: items keyed by network id)
 * @param {object} packet crafting_data
 * @param {{ tags?: object }} [opts]
 * @returns {{ bedrock: Map<number, BedrockRecipe>, entries: object[], skipped: object[] }} `entries` are
 *   minecraft-data (Java) recipe entries `{ result: { id, count, metadata }, inShape | ingredients, networkId,
 *   alternateNetworkIds?, extraResults? }`, sorted by Bedrock priority then network id and deduplicated (the ids of
 *   the Bedrock recipes that expand to the same grid are kept in `alternateNetworkIds`)
 */
function parseBedrockRecipes (registry, packet, { tags = ITEM_TAGS } = {}) {
  const bedrock = new Map()
  const skipped = []
  const recipes = []
  for (const raw of rawRecipesOf(packet)) {
    const r = normalizeRecipe(raw)
    if (!r || !CRAFTING_BLOCKS.has(r.block)) continue
    bedrock.set(r.networkId, r)
    recipes.push(r)
  }
  recipes.sort((a, b) => (a.priority - b.priority) || (a.networkId - b.networkId))

  const entries = []
  const seen = new Map() // entry key → entry
  for (const r of recipes) {
    const results = r.output.map(o => ({ item: registry.items[o.network_id], o }))
    if (results.some(({ item }) => !item)) { skipped.push({ recipeId: r.recipeId, reason: 'unknown result item' }); continue }
    const cells = r.input.map(desc => resolveIngredient(registry, desc, tags))
    if (cells.some(c => c === undefined)) { skipped.push({ recipeId: r.recipeId, reason: 'unresolved ingredient' }); continue }
    if (cells.every(c => c === null)) { skipped.push({ recipeId: r.recipeId, reason: 'no ingredients' }); continue }
    if (r.shaped && (r.width * r.height !== cells.length || r.width > 3 || r.height > 3)) { skipped.push({ recipeId: r.recipeId, reason: 'bad shape' }); continue }
    if (!r.shaped && cells.filter(Boolean).length > 9) { skipped.push({ recipeId: r.recipeId, reason: 'too many ingredients' }); continue }
    const [main, ...extra] = results
    const result = { id: main.item.id, count: main.o.count, metadata: main.o.metadata ?? 0 }
    const extraResults = extra.map(({ item, o }) => ({ id: item.id, count: o.count, metadata: o.metadata ?? 0 }))
    for (const assignment of expandCells(cells)) {
      const entry = { result: { ...result }, networkId: r.networkId }
      if (r.shaped) {
        entry.inShape = Array.from({ length: r.height }, (_, y) => Array.from({ length: r.width }, (_, x) => {
          const option = assignment[x + r.width * y]
          return option ? enumItem(option) : null
        }))
      } else {
        entry.ingredients = assignment.filter(Boolean).map(enumItem)
      }
      if (extraResults.length) entry.extraResults = extraResults.map(e => ({ ...e }))
      const key = entryKey(entry)
      const kept = seen.get(key)
      if (kept) {
        // the same grid for another Bedrock recipe (e.g. stick_from_crimson_planks): BDS accepts either id
        if (kept.networkId !== r.networkId && !kept.alternateNetworkIds?.includes(r.networkId)) (kept.alternateNetworkIds ??= []).push(r.networkId)
        continue
      }
      seen.set(key, entry)
      entries.push(entry)
    }
  }
  return { bedrock, entries, skipped }
}

/** prismarine-recipe Recipe from an enum entry, with the Bedrock network id and the extra results in `delta` */
function toRecipe ({ Recipe, RecipeItem }, entry) {
  const recipe = new Recipe(entry)
  recipe.networkId = entry.networkId
  for (const extra of entry.extraResults ?? []) {
    const d = recipe.delta.find(it => it.id === extra.id && it.metadata === extra.metadata)
    if (d) d.count += extra.count
    else recipe.delta.push(new RecipeItem(extra.id, extra.metadata, extra.count))
  }
  return recipe
}

/**
 * @param {object} registry
 * @param {object} packet crafting_data
 * @param {{ tags?: object }} [opts]
 * @returns {object[]} prismarine-recipe `Recipe`s, each with `networkId`
 */
function parseCraftingData (registry, packet, opts = {}) {
  const classes = require('prismarine-recipe')(registry)
  return parseBedrockRecipes(registry, packet, opts).entries.map(entry => toRecipe(classes, entry))
}

/** structural signature of a prismarine-recipe Recipe's ingredients (shape or ingredient list) */
function ingredientSignature (recipe) {
  const item = (it) => (!it || it.id === -1 || it.id === null || it.id === undefined) ? '-' : `${it.id}:${it.metadata ?? null}`
  return recipe.inShape
    ? 's' + recipe.inShape.map(row => row.map(item).join(',')).join('/')
    : 'l' + (recipe.ingredients ?? []).map(item).sort().join(',')
}

/**
 * The bot's recipe book (`bot._bedrock.recipes`). Also sets `bot.registry.recipes` to its Java-shaped table.
 * @param {object} bot
 * @param {{ tags?: object }} [opts]
 */
function createRecipeBook (bot, { tags = ITEM_TAGS } = {}) {
  const registry = bot.registry
  const table = {}
  if (registry) registry.recipes = table
  const byResult = new Map()
  const bedrock = new Map()
  const byKey = new Map() // entry key → { entry, recipe }
  let networkIds = new WeakMap() // book Recipe → [network id, …alternates]
  const unlocked = new Set()
  const skipped = []
  let all = []

  function clear () {
    for (const key of Object.keys(table)) delete table[key]
    byResult.clear()
    bedrock.clear()
    byKey.clear()
    networkIds = new WeakMap()
    skipped.length = 0
    all = []
  }

  function load (packet) {
    if (packet?.clear_recipes !== false) clear()
    const parsed = parseBedrockRecipes(registry, packet, { tags })
    for (const [id, r] of parsed.bedrock) bedrock.set(id, r)
    skipped.push(...parsed.skipped)
    const classes = require('prismarine-recipe')(registry)
    for (const entry of parsed.entries) {
      const ids = [entry.networkId, ...(entry.alternateNetworkIds ?? [])]
      const key = entryKey(entry)
      const kept = byKey.get(key)
      if (kept) {
        // a later crafting_data (clear_recipes false) with the same grid
        const keptIds = networkIds.get(kept.recipe)
        for (const id of ids) if (!keptIds.includes(id)) keptIds.push(id)
        kept.entry.alternateNetworkIds = keptIds.slice(1)
        continue
      }
      const recipe = toRecipe(classes, entry)
      byKey.set(key, { entry, recipe })
      networkIds.set(recipe, ids)
      ;(table[entry.result.id] ??= []).push(entry)
      if (!byResult.has(entry.result.id)) byResult.set(entry.result.id, [])
      byResult.get(entry.result.id).push(recipe)
      all.push(recipe)
    }
  }

  /** unlocked_recipes: what limited crafting (gamerule doLimitedCrafting) allows */
  function unlock (packet) {
    switch (packet?.unlock_type) {
      case 'initially_unlocked':
      case 'newly_unlocked':
        for (const id of packet.recipes ?? []) unlocked.add(id)
        return
      case 'remove_unlocked':
        for (const id of packet.recipes ?? []) unlocked.delete(id)
        return
      case 'remove_all_unlocked':
        unlocked.clear()
    }
  }

  function limitedCrafting () {
    const rules = bot.bedrock?.gameRules ?? {}
    for (const [name, value] of Object.entries(rules)) if (name.toLowerCase() === 'dolimitedcrafting') return !!value
    return false
  }

  /** the network ids a book Recipe may be crafted with: under limited crafting only the unlocked ones */
  function usableNetworkIds (recipe, limited = limitedCrafting()) {
    const ids = networkIds.get(recipe) ?? []
    return limited ? ids.filter(id => unlocked.has(bedrock.get(id)?.recipeId)) : ids
  }

  function isUnlocked (recipe) {
    return usableNetworkIds(recipe).length > 0
  }

  /** upstream `Recipe.find(itemType, metadata)` over this bot's recipes (metadata filter applied to the result) */
  function find (itemType, metadata) {
    const limited = limitedCrafting()
    return (byResult.get(itemType) ?? []).filter(recipe => (metadata === null || metadata === undefined || recipe.result.metadata === metadata) &&
      (!limited || usableNetworkIds(recipe, true).length > 0))
  }

  /**
   * The book's Recipe with the same result and ingredients as `recipe` (a Recipe without a known `networkId`, e.g. from
   * prismarine-recipe's Recipe.find or built by user code; a result without metadata matches any metadata).
   */
  function match (recipe) {
    const result = recipe?.result
    if (!result) return null
    const body = ingredientSignature(recipe)
    return (byResult.get(result.id) ?? []).find(r => r.result.count === result.count &&
      (result.metadata === null || result.metadata === undefined || r.result.metadata === result.metadata) &&
      ingredientSignature(r) === body) ?? null
  }

  /** the current book Recipe for `recipe`: itself, or (a stale or foreign Recipe) the one with the same grid */
  function resolve (recipe) {
    return networkIds.has(recipe) ? recipe : match(recipe)
  }

  /** the Bedrock recipe a book Recipe is crafted with (the first unlocked one under limited crafting) */
  function bedrockFor (recipe) {
    const [id] = usableNetworkIds(recipe)
    return id === undefined ? null : bedrock.get(id) ?? null
  }

  return {
    table,
    skipped,
    load,
    unlock,
    find,
    match,
    resolve,
    bedrockFor,
    networkIds: (recipe) => [...(networkIds.get(recipe) ?? [])],
    limitedCrafting,
    isUnlocked,
    all: () => all,
    unlockedRecipes: () => new Set(unlocked),
    byNetworkId: (id) => bedrock.get(id) ?? null
  }
}

/** item stack request ItemStackRequestInstanceDescriptor of a recipe output (results_deprecated) */
function resultDescriptor (registry, wire) {
  const name = registry.items[wire.network_id]?.name ?? ''
  return {
    type: 'name',
    legacy_type: 1,
    name: name.includes(':') ? name : `minecraft:${name}`,
    metadata: wire.metadata ?? 0,
    count: wire.count,
    block_runtime_id: wire.block_runtime_id ?? 0,
    extra: wire.extra ?? { has_nbt: 0, can_place_on: [], can_destroy: [] }
  }
}

/**
 * Plan one crafting item stack request, verified on BDS 1.26.51.1 (docs/differences/U12.md#craft-request):
 *   place × n (inventory → grid cell)  then  craft_recipe { recipe_network_id, times_crafted }
 *   + results_deprecated { result_items, times_crafted } + consume × cells (from the grid)
 *   + per result k: [create { result_slot_id: k } when several results] + place × m (created output 50 → inventory)
 * BDS only crafts from the grid (consuming inventory slots directly is refused), the created output holds at most one
 * stack per request (status 14 beyond), and every result must be taken (status 17 otherwise).
 * @param {object} p
 * @param {object} p.registry
 * @param {Function} p.Item prismarine-item class (Item.equal)
 * @param {object} p.recipe prismarine-recipe Recipe (inShape / ingredients)
 * @param {BedrockRecipe} p.bedrock the Bedrock recipe (network id, output wire items)
 * @param {(key: string) => object|null} p.read inventory model read (keys 'p:0-35', 'c', grid 'u:<n>')
 * @param {string[]} p.grid model keys of the grid cells, row-major
 * @param {number} p.width grid width (2 or 3)
 * @param {number} p.remaining crafts still wanted (≥ 1)
 * @param {(wire: object) => object} p.created recipe output wire item → predicted Item
 * @returns {{ times: number, steps: object[], overflow: boolean }}
 */
function planCraft ({ registry, Item, recipe, bedrock, read, grid, width, remaining, created }) {
  const height = Math.ceil(grid.length / width)
  const cells = []
  if (recipe.inShape) {
    for (let y = 0; y < recipe.inShape.length; y++) {
      const row = recipe.inShape[y]
      for (let x = 0; x < row.length; x++) {
        const it = row[x]
        if (!it || it.id === -1 || it.id === null || it.id === undefined) continue
        if (x >= width || y >= height) throw new Error('crafting: the recipe does not fit the crafting grid')
        cells.push({ key: grid[x + width * y], id: it.id, metadata: it.metadata ?? null })
      }
    }
  } else {
    const ingredients = recipe.ingredients ?? []
    if (ingredients.length > grid.length) throw new Error('crafting: the recipe does not fit the crafting grid')
    ingredients.forEach((it, i) => cells.push({ key: grid[i], id: it.id, metadata: it.metadata ?? null }))
  }
  if (cells.length === 0) throw new Error('crafting: the recipe has no ingredients')
  const matches = (item, cell) => !!item && item.type === cell.id && (cell.metadata === null || item.metadata === cell.metadata)
  const stackSizeOf = (id) => registry.items[id]?.stackSize ?? 64

  // how many crafts this request can do: ingredients available (upstream counts the inventory range only),
  // one grid slot holds a stack, the created output holds one stack of each result
  let times = remaining
  const groups = new Map()
  for (const cell of cells) {
    const key = `${cell.id}:${cell.metadata}`
    if (!groups.has(key)) groups.set(key, { cell, need: 0 })
    groups.get(key).need++
  }
  for (const { cell, need } of groups.values()) {
    let available = 0
    for (const k of PLAYER_ORDER) {
      const item = read(k)
      if (matches(item, cell)) available += item.count
    }
    times = Math.min(times, Math.floor(available / need))
  }
  if (!(times >= 1)) throw new Error('missing ingredient')
  for (const cell of cells) times = Math.min(times, stackSizeOf(cell.id))
  for (const o of bedrock.output) times = Math.min(times, Math.max(1, Math.floor(stackSizeOf(o.network_id) / o.count)))

  for (;;) {
    const plan = tryPlan(times)
    if (plan.times === times) return plan
    if (!(plan.times >= 1)) throw new Error('missing ingredient')
    times = plan.times
  }

  function tryPlan (times) {
    // predicted contents of the player slots while the request is built: key → { item, count }
    const virtual = new Map()
    const slotOf = (k) => {
      if (virtual.has(k)) return virtual.get(k)
      const item = read(k)
      return { item, count: item ? item.count : 0 }
    }
    const vset = (k, item, count) => virtual.set(k, count > 0 ? { item, count } : { item: null, count: 0 })
    const countOf = (k) => slotOf(k).count
    const itemOf = (k) => slotOf(k).item
    const steps = []
    const sources = new Map() // cell key → first source item (shulker NBT)

    // 1. ingredients into the grid (sources in upstream's search order). A cell holds one kind of stack (same
    //    item and NBT): the first kind, in that order, with enough items for every craft of the batch.
    for (const cell of cells) {
      const kinds = []
      for (const k of PLAYER_ORDER) {
        const item = itemOf(k)
        if (!matches(item, cell) || countOf(k) === 0) continue
        let kind = kinds.find(group => Item.equal(group.item, item, false, true))
        if (!kind) kinds.push(kind = { item, keys: [], total: 0 })
        kind.keys.push(k)
        kind.total += countOf(k)
      }
      const kind = kinds.find(group => group.total >= times)
      if (!kind) return { times: Math.max(0, ...kinds.map(group => group.total)) }
      let need = times
      for (const k of kind.keys) {
        if (need === 0) break
        const n = Math.min(need, countOf(k))
        steps.push({ type: 'place', count: n, src: k, dst: cell.key })
        vset(k, kind.item, countOf(k) - n)
        need -= n
      }
      sources.set(cell.key, kind.item)
    }

    // 2. the craft itself
    steps.push({ type: 'raw', action: { type_id: 'craft_recipe', recipe_network_id: bedrock.networkId, times_crafted: times } })
    steps.push({ type: 'raw', action: { type_id: 'results_deprecated', result_items: bedrock.output.map(o => resultDescriptor(registry, o)), times_crafted: times } })
    for (const cell of cells) steps.push({ type: 'consume', count: times, src: cell.key })

    // 3. take every result out of the created output (upstream putSelectedItemRange: stacks with room first, then
    //    the first empty slot; what does not fit goes to the cursor and is tossed by the caller)
    let overflow = false
    let cursorUsed = false
    for (let k = 0; k < bedrock.output.length; k++) {
      const o = bedrock.output[k]
      const item = created(o)
      if (bedrock.type === 'shulker_box') {
        const source = [...sources.values()].find(it => /shulker_box$|bundle$/.test(it?.name ?? ''))
        if (source?.nbt) item.nbt = JSON.parse(JSON.stringify(source.nbt))
      }
      const stackSize = item.stackSize ?? stackSizeOf(o.network_id)
      if (bedrock.output.length > 1) steps.push({ type: 'raw', action: { type_id: 'create', result_slot_id: k } })
      let total = o.count * times
      while (total > 0) {
        let dst = PLAYER_ORDER.find(key => { const it = itemOf(key); return it && countOf(key) < stackSize && Item.equal(it, item, false, true) })
        if (!dst) dst = PLAYER_ORDER.find(key => countOf(key) === 0)
        if (!dst) break
        const n = Math.min(total, stackSize - countOf(dst))
        steps.push({ type: 'place', count: n, src: { created: item }, dst })
        vset(dst, itemOf(dst) ?? item, countOf(dst) + n)
        total -= n
      }
      if (total > 0) {
        const cursor = read('c')
        if (cursorUsed || (cursor && !(Item.equal(cursor, item, false, true) && cursor.count + total <= stackSize))) {
          // only one stack can be carried: craft less in this request (the next batch starts from a tossed cursor)
          if (times > 1) return { times: times - 1 }
          throw new Error('destination full')
        }
        steps.push({ type: 'take', count: total, src: { created: item }, dst: 'c' })
        cursorUsed = true
        overflow = true
      }
    }
    return { times, steps, overflow }
  }
}

module.exports = {
  ITEM_TAGS,
  CRAFTING_BLOCKS,
  PLAYER_ORDER,
  parseCraftingData,
  parseBedrockRecipes,
  createRecipeBook,
  planCraft,
  resultDescriptor
}
