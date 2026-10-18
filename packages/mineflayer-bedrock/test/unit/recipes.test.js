'use strict'
// owner: U12 (crafting) — lib/bedrock/recipes.js on the recorded crafting_data of BDS 1.26.51.1: recipe model, tag
// expansion, the Java-shaped registry.recipes, limited crafting, and the craft request planner
const assert = require('assert')
const fixtures = require('../fixtures')
const { createRegistry } = require('../../lib/registry')
const recipes = require('../../lib/bedrock/recipes')
const ITEM_TAGS = require('../../lib/bedrock/item_tags')

function setup () {
  const cap = fixtures.load('join_flat')
  const registry = createRegistry()
  registry.handleStartGame(cap.first('start_game'))
  registry.handleItemRegistry(cap.first('item_registry'))
  return { registry, packet: cap.first('crafting_data'), Item: require('prismarine-item')(registry) }
}

const nameOf = (registry, it) => it.id === -1 ? '-' : registry.items[it.id].name
const shape = (registry, recipe) => recipe.inShape.map(row => row.map(it => nameOf(registry, it)).join(',')).join(' / ')

describe('recipes: crafting_data → prismarine-recipe Recipes (U12)', function () {
  this.timeout(30000)
  let registry, packet, all

  before(() => {
    ({ registry, packet } = setup())
    all = recipes.parseCraftingData(registry, packet)
  })
  const id = (name) => registry.itemsByName[name].id
  const of = (name) => all.filter(r => r.result.id === id(name))

  it('every crafting-grid recipe resolves; each Recipe is a prismarine-recipe Recipe with the Bedrock network id', () => {
    const parsed = recipes.parseBedrockRecipes(registry, packet)
    assert.deepStrictEqual(parsed.skipped, [], 'no unknown tag or item')
    assert.ok(all.length > 4000, `${all.length} expanded recipes`)
    const { Recipe } = require('prismarine-recipe')(registry)
    for (const r of all) {
      assert.ok(r instanceof Recipe)
      assert.ok(parsed.bedrock.get(r.networkId), 'network id of a crafting recipe')
      assert.strictEqual(parsed.bedrock.get(r.networkId).block, 'crafting_table')
      assert.ok(Array.isArray(r.delta) && typeof r.requiresTable === 'boolean')
    }
    // furnace / stonecutter / campfire … recipes and the hidden `deprecated` duplicates are not crafting recipes
    assert.ok(![...parsed.bedrock.values()].some(r => r.block !== 'crafting_table'))
    assert.strictEqual(of('stripped_mangrove_wood').length, 1, 'the deprecated 2×2 duplicate is left out')
    assert.strictEqual(of('stripped_mangrove_wood')[0].requiresTable, false)
  })

  it('tags expand like minecraft-data: one recipe per member, the same member in every cell of the tag', () => {
    const sticks = of('stick')
    const fromPlanks = sticks.filter(r => r.networkId === 1581)
    assert.deepStrictEqual(fromPlanks.map(r => shape(registry, r)), ITEM_TAGS['minecraft:planks'].map(p => `${p} / ${p}`))
    assert.ok(fromPlanks.every(r => !r.requiresTable && r.result.count === 4 && r.result.metadata === 0))
    // structurally identical recipes are kept once (generic minecraft:stick wins over stick_from_crimson_planks)
    assert.strictEqual(sticks.filter(r => shape(registry, r) === 'crimson_planks / crimson_planks').length, 1)
    assert.deepStrictEqual(sticks.filter(r => r.networkId !== 1581).map(r => shape(registry, r)), ['bamboo / bamboo'])
    // two tags in one recipe: the cartesian product (planks × wooden slabs)
    assert.strictEqual(of('barrel').length, ITEM_TAGS['minecraft:planks'].length * ITEM_TAGS['minecraft:wooden_slabs'].length)
    // coals: torches from coal and charcoal
    assert.deepStrictEqual(of('torch').map(r => shape(registry, r)).sort(), ['charcoal / stick', 'coal / stick'])
  })

  it('shapes are row-major top to bottom; shapeless recipes list ingredients; requiresTable by size', () => {
    const [pickaxe] = of('diamond_pickaxe')
    assert.strictEqual(shape(registry, pickaxe), 'diamond,diamond,diamond / -,stick,- / -,stick,-')
    assert.strictEqual(pickaxe.requiresTable, true)
    assert.deepStrictEqual(pickaxe.delta.map(d => [nameOf(registry, d), d.count]), [['diamond', -3], ['stick', -2], ['diamond_pickaxe', 1]])
    const [flint] = of('flint_and_steel')
    assert.strictEqual(flint.inShape, null)
    assert.deepStrictEqual(flint.ingredients.map(it => nameOf(registry, it)).sort(), ['flint', 'iron_ingot'])
    assert.strictEqual(flint.requiresTable, false)
    const [table] = of('crafting_table')
    assert.strictEqual(table.requiresTable, false)
    assert.strictEqual(of('ladder')[0].result.count, 3)
  })

  it('extra results (cake buckets, honey bottles) are part of delta, never an outShape', () => {
    const [cake] = of('cake').filter(r => r.inShape.flat().some(it => it.id === id('egg')))
    assert.strictEqual(cake.outShape, null)
    assert.deepStrictEqual(cake.delta.filter(d => d.count > 0).map(d => [nameOf(registry, d), d.count]), [['cake', 1], ['bucket', 3]])
    const [sugar] = of('sugar').filter(r => r.inShape?.flat().some(it => it.id === id('honey_bottle')))
    assert.deepStrictEqual(sugar.delta.map(d => [nameOf(registry, d), d.count]), [['honey_bottle', -1], ['sugar', 3], ['glass_bottle', 1]])
  })

  it('metadata: wildcard ingredients have metadata null, the bed colour is the result metadata', () => {
    const [stick] = of('stick')
    assert.ok(stick.inShape.flat().every(it => it.metadata === null))
    const beds = of('bed')
    const red = beds.filter(r => r.inShape?.flat().some(it => it.id === id('red_wool')))
    assert.ok(red.length > 0 && red.every(r => r.result.metadata === 14))
  })

  it('the Java-shaped bot.registry.recipes works with prismarine-recipe; find/match/limited crafting', () => {
    const { registry, packet } = setup()
    const bot = { registry, bedrock: { gameRules: { doLimitedCrafting: false } } }
    const book = recipes.createRecipeBook(bot)
    assert.strictEqual(registry.recipes, book.table)
    book.load(packet)
    const stickId = registry.itemsByName.stick.id
    const entry = registry.recipes[stickId][0]
    assert.deepStrictEqual(Object.keys(entry).sort(), ['inShape', 'networkId', 'result'])
    const { Recipe } = require('prismarine-recipe')(registry)
    const found = Recipe.find(stickId)
    assert.strictEqual(found.length, book.find(stickId).length)
    assert.strictEqual(found[0].networkId, undefined, 'prismarine-recipe drops unknown fields')
    assert.strictEqual(book.match(found[0]), book.find(stickId)[0], 'match() finds the Bedrock recipe again')
    assert.strictEqual(book.match(new Recipe({ result: { id: stickId, count: 4 }, inShape: [[registry.itemsByName.oak_planks.id], [registry.itemsByName.oak_planks.id]] })).networkId, 1581)
    assert.strictEqual(book.match(new Recipe({ result: { id: stickId, count: 4 }, inShape: [[1], [1]] })), null)
    // the bed metadata filter (upstream Recipe.find never filters: it checks a `meta` key)
    const bedId = registry.itemsByName.bed.id
    assert.ok(book.find(bedId, 14).length > 0 && book.find(bedId, 14).length < book.find(bedId).length)
    // limited crafting: only unlocked recipe ids
    bot.bedrock.gameRules.doLimitedCrafting = true
    assert.strictEqual(book.find(stickId).length, 0)
    book.unlock({ unlock_type: 'initially_unlocked', recipes: ['minecraft:stick'] })
    assert.strictEqual(book.find(stickId).length, 13)
    book.unlock({ unlock_type: 'remove_all_unlocked', recipes: [] })
    assert.strictEqual(book.find(stickId).length, 0)
    // a grid shared by two Bedrock recipes is available when either is unlocked, and crafted with that one
    const crimson = book.find(stickId).find(r => r.inShape[0][0].id === registry.itemsByName.crimson_planks.id) ?? null
    bot.bedrock.gameRules.doLimitedCrafting = false
    const crimsonStick = book.find(stickId).find(r => r.inShape[0][0].id === registry.itemsByName.crimson_planks.id)
    assert.strictEqual(crimson, null)
    assert.deepStrictEqual(book.networkIds(crimsonStick), [1581, 1866])
    assert.strictEqual(book.bedrockFor(crimsonStick).networkId, 1581)
    bot.bedrock.gameRules.doLimitedCrafting = true
    book.unlock({ unlock_type: 'newly_unlocked', recipes: ['minecraft:stick_from_crimson_planks'] })
    assert.deepStrictEqual(book.find(stickId), [crimsonStick])
    assert.strictEqual(book.bedrockFor(crimsonStick).networkId, 1866)
    bot.bedrock.gameRules.doLimitedCrafting = false
    // a Recipe of an older crafting_data resolves to the current one with the same grid
    const before = book.find(stickId)[0]
    book.load(packet)
    assert.notStrictEqual(book.find(stickId)[0], before)
    assert.strictEqual(book.resolve(before), book.find(stickId)[0])
    assert.strictEqual(book.resolve(book.find(stickId)[0]), book.find(stickId)[0])
    // a crafting_data that clears the recipes replaces them in place (prismarine-recipe keeps the object)
    book.load({ ...packet, shaped_recipes: packet.shaped_recipes.filter(r => r.recipe_id === 'minecraft:stick'), shapeless_recipes: [], shulker_box_recipes: [] })
    assert.strictEqual(registry.recipes, book.table)
    assert.deepStrictEqual(Object.keys(book.table), [String(stickId)])
    assert.strictEqual(book.byNetworkId(1336), null)
  })
})

describe('recipes: planCraft — the item stack request of one craft batch (U12)', function () {
  let registry, Item, book
  before(() => {
    const s = setup()
    registry = s.registry
    Item = s.Item
    book = recipes.createRecipeBook({ registry })
    book.load(s.packet)
  })
  const id = (name) => registry.itemsByName[name].id
  const stack = (name, count, stackId) => {
    const item = new Item(id(name), count, 0)
    item.stackId = stackId
    return item
  }
  /** a reader over a player inventory given as { 'p:<i>': Item } */
  const reader = (slots) => (key) => slots[key] ?? null
  const plan = (name, slots, { remaining = 1, table = false, pick = (rs) => rs[0] } = {}) => {
    const recipe = pick(book.find(id(name)))
    return recipes.planCraft({
      registry,
      Item,
      recipe,
      bedrock: book.byNetworkId(recipe.networkId),
      read: reader(slots),
      grid: table ? [32, 33, 34, 35, 36, 37, 38, 39, 40].map(n => `u:${n}`) : [28, 29, 30, 31].map(n => `u:${n}`),
      width: table ? 3 : 2,
      remaining,
      created: (wire) => require('../../lib/bedrock/item').fromNetwork(registry, { ...wire, has_stack_id: false })
    })
  }
  const describeSteps = (steps) => steps.map(s => s.type === 'raw'
    ? [s.action.type_id, s.action.times_crafted ?? s.action.result_slot_id]
    : [s.type, s.count, typeof s.src === 'object' ? `created:${s.src.created.name}` : s.src, s.dst].filter(x => x !== undefined))

  it('2×2 sticks: place into the grid, craft_recipe + results_deprecated, consume, place the result (upstream order)', () => {
    const p = plan('stick', { 'p:0': stack('oak_planks', 5, 7) }, { pick: (rs) => rs.find(r => r.inShape[0][0].id === id('oak_planks')) })
    assert.strictEqual(p.times, 1)
    assert.deepStrictEqual(describeSteps(p.steps), [
      ['place', 1, 'p:0', 'u:28'], ['place', 1, 'p:0', 'u:30'],
      ['craft_recipe', 1], ['results_deprecated', 1],
      ['consume', 1, 'u:28'], ['consume', 1, 'u:30'],
      ['place', 4, 'created:stick', 'p:9']
    ])
    const craft = p.steps.find(s => s.action?.type_id === 'craft_recipe').action
    assert.deepStrictEqual(craft, { type_id: 'craft_recipe', recipe_network_id: 1581, times_crafted: 1 })
    const results = p.steps.find(s => s.action?.type_id === 'results_deprecated').action
    assert.deepStrictEqual(JSON.parse(JSON.stringify(results.result_items)), [{ type: 'name', legacy_type: 1, name: 'minecraft:stick', metadata: 0, count: 4, block_runtime_id: 0, extra: { has_nbt: 0, can_place_on: [], can_destroy: [] } }])
    assert.strictEqual(p.overflow, false)
  })

  it('3×3 shapes map to ui 32-40 row-major; sources in upstream order (main inventory, then hotbar); results join stacks', () => {
    const p = plan('wooden_pickaxe', { 'p:2': stack('oak_planks', 2, 1), 'p:12': stack('oak_planks', 1, 2), 'p:3': stack('stick', 2, 3) }, { table: true, pick: (rs) => rs.find(r => r.inShape[0][0].id === id('oak_planks')) })
    assert.deepStrictEqual(describeSteps(p.steps).slice(0, 5), [
      ['place', 1, 'p:12', 'u:32'], ['place', 1, 'p:2', 'u:33'], ['place', 1, 'p:2', 'u:34'],
      ['place', 1, 'p:3', 'u:36'], ['place', 1, 'p:3', 'u:39']
    ])
    assert.deepStrictEqual(describeSteps(p.steps).at(-1), ['place', 1, 'created:wooden_pickaxe', 'p:9'], 'the first empty slot in upstream order')
    const torch = plan('torch', { 'p:0': stack('coal', 3, 1), 'p:1': stack('stick', 3, 2), 'p:20': stack('torch', 60, 3) }, { remaining: 3, pick: (rs) => rs.find(r => r.inShape[0][0].id === id('coal')) })
    assert.deepStrictEqual(describeSteps(torch.steps).slice(-2), [['place', 4, 'created:torch', 'p:20'], ['place', 8, 'created:torch', 'p:9']])
  })

  it('bulk: one request crafts up to a stack of results and a stack per grid cell; missing ingredient', () => {
    assert.strictEqual(plan('oak_planks', { 'p:0': stack('oak_log', 64, 1) }, { remaining: 64, pick: (rs) => rs.find(r => r.ingredients?.[0].id === id('oak_log') || r.inShape?.[0][0].id === id('oak_log')) }).times, 16)
    assert.strictEqual(plan('oak_planks', { 'p:0': stack('oak_log', 3, 1) }, { remaining: 64, pick: (rs) => rs.find(r => (r.ingredients ?? r.inShape.flat())[0].id === id('oak_log')) }).times, 3)
    const sword = book.find(id('iron_sword'))[0]
    assert.throws(() => recipes.planCraft({ registry, Item, recipe: sword, bedrock: book.byNetworkId(sword.networkId), read: reader({ 'p:0': stack('iron_ingot', 1, 1) }), grid: [32, 33, 34, 35, 36, 37, 38, 39, 40].map(n => `u:${n}`), width: 3, remaining: 1, created: () => null }), /^Error: missing ingredient$/)
    // a 3×3 shape does not fit the 2×2 grid
    assert.throws(() => plan('iron_sword', { 'p:0': stack('iron_ingot', 2, 1), 'p:1': stack('stick', 1, 2) }), /does not fit/)
  })

  it('several results: create { result_slot_id } before taking each; what does not fit is carried (overflow)', () => {
    const cake = plan('cake', {
      'p:0': stack('milk_bucket', 1, 1), 'p:1': stack('milk_bucket', 1, 2), 'p:2': stack('milk_bucket', 1, 3), 'p:3': stack('sugar', 2, 4), 'p:4': stack('egg', 1, 5), 'p:5': stack('wheat', 3, 6)
    }, { table: true, pick: (rs) => rs.find(r => r.inShape.flat().some(it => it.id === id('egg'))) })
    assert.deepStrictEqual(describeSteps(cake.steps).slice(9), [
      ['craft_recipe', 1], ['results_deprecated', 1],
      ...[32, 33, 34, 35, 36, 37, 38, 39, 40].map(n => ['consume', 1, `u:${n}`]),
      ['create', 0], ['place', 1, 'created:cake', 'p:9'],
      ['create', 1], ['place', 3, 'created:bucket', 'p:10']
    ])
    // a full inventory: the honey block takes the freed slot, the bottles go to the cursor
    const full = {}
    for (let i = 0; i < 35; i++) full[`p:${i}`] = stack('dirt', 64, 100 + i)
    full['p:35'] = stack('honey_bottle', 4, 200)
    const honey = plan('honey_block', full)
    assert.deepStrictEqual(describeSteps(honey.steps).slice(-4), [['create', 0], ['place', 1, 'created:honey_block', 'p:35'], ['create', 1], ['take', 4, 'created:glass_bottle', 'c']])
    assert.strictEqual(honey.overflow, true)
    // 8 of 9 bottles used: no slot frees, the block and the bottles would both need the cursor (2 crafts, then 1:
    // still two stacks) → destination full
    full['p:35'] = stack('honey_bottle', 9, 200)
    assert.throws(() => plan('honey_block', full, { remaining: 2 }), /^Error: destination full$/)
    // nothing fits and the cursor holds something else
    full['p:35'] = stack('honey_bottle', 4, 200)
    full.c = stack('stone', 1, 300)
    assert.throws(() => plan('honey_block', full), /^Error: destination full$/)
    // a carried stack of the result takes the overflow
    full.c = stack('glass_bottle', 12, 300)
    assert.deepStrictEqual(describeSteps(plan('honey_block', full).steps).at(-1), ['take', 4, 'created:glass_bottle', 'c'])
  })

  it('ingredients of different NBT never share a grid cell', () => {
    const named = stack('oak_planks', 1, 2)
    named.nbt = { type: 'compound', name: '', value: { display: { type: 'compound', value: { Name: { type: 'string', value: 'x' } } } } }
    const p = plan('stick', { 'p:9': stack('oak_planks', 1, 1), 'p:10': named, 'p:11': stack('oak_planks', 1, 3) }, { pick: (rs) => rs.find(r => r.inShape[0][0].id === id('oak_planks')) })
    assert.deepStrictEqual(describeSteps(p.steps).slice(0, 2), [['place', 1, 'p:9', 'u:28'], ['place', 1, 'p:10', 'u:30']], 'one stack per cell, cells may differ')
    const two = plan('stick', { 'p:9': stack('oak_planks', 1, 1), 'p:10': named, 'p:11': stack('oak_planks', 3, 3) }, { remaining: 2, pick: (rs) => rs.find(r => r.inShape[0][0].id === id('oak_planks')) })
    assert.strictEqual(two.times, 2)
    assert.deepStrictEqual(describeSteps(two.steps).slice(0, 3), [['place', 1, 'p:9', 'u:28'], ['place', 1, 'p:11', 'u:28'], ['place', 2, 'p:11', 'u:30']])
  })
})
