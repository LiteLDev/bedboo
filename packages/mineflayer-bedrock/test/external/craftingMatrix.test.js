// owner: U12 (crafting)
'use strict'
/**
 * Bedrock extra: the crafting matrix of U12 — bot.recipesFor / recipesAll / craft for the recipes a survival game (and
 * the scripted agent) needs, 2×2 and crafting table, bulk counts, failures, multi-result recipes, overflow — every
 * result checked against the server's own inventory (raw packets resent by a console no-op). Ingredients are given
 * with the console (`give`), the crafting table is set with `setblock` (bot.placeBlock is U11's).
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('craftingMatrix', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(async () => {
    await ctx.bot.test.resetState()
    await ctx.bot.test.becomeSurvival()
  })
  afterEach(() => ctx.bot.test.becomeCreative())

  const id = (bot, name) => {
    const item = bot.registry.itemsByName[name]
    assert.ok(item, `no item ${name}`)
    return item.id
  }

  /** the server's view of the inventory + ui windows (raw packets) after a console no-op that resends them */
  async function serverInventory (bot) {
    const ui = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'ui', 10000)
    const offhand = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'offhand', 10000)
    await bot.test.ctx.consoleOutput(`replaceitem entity ${bot.test.ctx.who()} slot.hotbar 8 keep air`)
    await Promise.all([ui.promise, offhand.promise])
    return bot.test.rawInventory()
  }

  /** sorted "name x count" of the player inventory (model) */
  const counts = (bot) => {
    const out = {}
    for (const it of bot.inventory.items()) out[it.name] = (out[it.name] ?? 0) + it.count
    return out
  }

  /** the model equals the server slot by slot; the crafting grids and the cursor are empty on the server */
  async function assertServerAgrees (bot) {
    const raw = await serverInventory(bot)
    for (let i = 0; i < 36; i++) {
      const model = bot.inventory.slots[i < 9 ? 36 + i : i]
      const server = raw.inventory[i]
      assert.strictEqual(model ? `${model.name}x${model.count}` : null, server ? `${server.name}x${server.count}` : null, `inventory slot ${i}`)
    }
    for (const s of [0, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40]) {
      assert.strictEqual(raw.ui[s] ?? null, null, `ui slot ${s} (cursor / crafting grid) is empty on the server`)
    }
    assert.strictEqual(bot.inventory.selectedItem, null, 'nothing carried')
  }

  async function give (bot, items) {
    for (const [name, count, metadata] of items) await bot.test.give(name, count, metadata ?? 0)
  }

  async function stageTable (bot) {
    await bot.test.setBlock({ x: 1, y: 0, z: 0, relative: true, blockName: 'crafting_table' })
    const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 })
    assert.ok(table, 'crafting table')
    return table
  }

  /**
   * give → recipesFor → craft → expected inventory, checked against the server.
   * @returns {object} the recipe used
   */
  async function craftCase (bot, { items, target, metadata = null, times = 1, table = null, expect }) {
    await bot.test.clearInventory()
    await give(bot, items)
    const recipes = bot.recipesFor(id(bot, target), metadata, 1, table)
    assert.ok(recipes.length > 0, `a recipe for ${target} from ${JSON.stringify(items)}`)
    const recipe = recipes[0]
    assert.strictEqual(typeof recipe.networkId, 'number', 'recipes carry the Bedrock network id')
    await bot.craft(recipe, times, table)
    assert.deepStrictEqual(counts(bot), expect ?? { [target]: recipe.result.count * times }, `crafting ${target}`)
    await assertServerAgrees(bot)
    assert.strictEqual(bot.currentWindow, null)
    return recipe
  }

  it('logs → planks for every wood type (2×2 grid)', async () => {
    const { bot } = ctx
    const woods = {
      oak_log: 'oak_planks',
      spruce_log: 'spruce_planks',
      birch_log: 'birch_planks',
      jungle_log: 'jungle_planks',
      acacia_log: 'acacia_planks',
      dark_oak_log: 'dark_oak_planks',
      mangrove_log: 'mangrove_planks',
      cherry_log: 'cherry_planks',
      pale_oak_log: 'pale_oak_planks',
      crimson_stem: 'crimson_planks',
      warped_stem: 'warped_planks',
      stripped_oak_log: 'oak_planks',
      bamboo_block: 'bamboo_planks'
    }
    for (const [log, planks] of Object.entries(woods)) {
      const recipe = await craftCase(bot, { items: [[log, 1]], target: planks })
      assert.strictEqual(recipe.requiresTable, false)
    }
  })

  it('sticks, crafting table, torches (coal and charcoal), chest, furnace, ladder', async () => {
    const { bot } = ctx
    await craftCase(bot, { items: [['oak_planks', 2]], target: 'stick' })
    await craftCase(bot, { items: [['spruce_planks', 4]], target: 'crafting_table' })
    await craftCase(bot, { items: [['coal', 1], ['stick', 1]], target: 'torch' })
    await craftCase(bot, { items: [['charcoal', 1], ['stick', 1]], target: 'torch' })
    const table = await stageTable(bot)
    await craftCase(bot, { items: [['birch_planks', 8]], target: 'chest', table })
    await craftCase(bot, { items: [['cobblestone', 8]], target: 'furnace', table })
    await craftCase(bot, { items: [['cobbled_deepslate', 8]], target: 'furnace', table })
    await craftCase(bot, { items: [['stick', 7]], target: 'ladder', table })
  })

  for (const [tier, material] of [['wooden', 'oak_planks'], ['stone', 'cobblestone'], ['iron', 'iron_ingot'], ['golden', 'gold_ingot'], ['diamond', 'diamond']]) {
    it(`${tier} tools: pickaxe, axe, shovel, hoe, sword`, async () => {
      const { bot } = ctx
      const table = await stageTable(bot)
      await bot.test.clearInventory()
      await give(bot, [[material, 11], ['stick', 9]])
      for (const tool of ['pickaxe', 'axe', 'shovel', 'hoe', 'sword']) {
        const [recipe] = bot.recipesFor(id(bot, `${tier}_${tool}`), null, 1, table)
        assert.ok(recipe, `${tier}_${tool} recipe`)
        await bot.craft(recipe, 1, table)
      }
      assert.deepStrictEqual(counts(bot), { [`${tier}_pickaxe`]: 1, [`${tier}_axe`]: 1, [`${tier}_shovel`]: 1, [`${tier}_hoe`]: 1, [`${tier}_sword`]: 1 })
      await assertServerAgrees(bot)
    })
  }

  for (const [tier, material] of [['iron', 'iron_ingot'], ['golden', 'gold_ingot'], ['diamond', 'diamond']]) {
    it(`${tier} armor: helmet, chestplate, leggings, boots`, async () => {
      const { bot } = ctx
      const table = await stageTable(bot)
      await bot.test.clearInventory()
      await give(bot, [[material, 24]])
      for (const piece of ['helmet', 'chestplate', 'leggings', 'boots']) {
        const [recipe] = bot.recipesFor(id(bot, `${tier}_${piece}`), null, 1, table)
        assert.ok(recipe, `${tier}_${piece} recipe`)
        await bot.craft(recipe, 1, table)
      }
      assert.deepStrictEqual(counts(bot), { [`${tier}_helmet`]: 1, [`${tier}_chestplate`]: 1, [`${tier}_leggings`]: 1, [`${tier}_boots`]: 1 })
      await assertServerAgrees(bot)
    })
  }

  it('bucket, flint and steel (2×2), shield, bow, arrows', async () => {
    const { bot } = ctx
    await craftCase(bot, { items: [['iron_ingot', 1], ['flint', 1]], target: 'flint_and_steel' })
    const table = await stageTable(bot)
    await craftCase(bot, { items: [['iron_ingot', 3]], target: 'bucket', table })
    await craftCase(bot, { items: [['oak_planks', 6], ['iron_ingot', 1]], target: 'shield', table })
    await craftCase(bot, { items: [['stick', 3], ['string', 3]], target: 'bow', table })
    await craftCase(bot, { items: [['flint', 1], ['stick', 1], ['feather', 1]], target: 'arrow', table })
  })

  it('stairs and slabs', async () => {
    const { bot } = ctx
    const table = await stageTable(bot)
    await craftCase(bot, { items: [['oak_planks', 6]], target: 'oak_stairs', table })
    // Bedrock names: cobblestone stairs = `stone_stairs`, stone stairs = `normal_stone_stairs`
    await craftCase(bot, { items: [['cobblestone', 6]], target: 'stone_stairs', table })
    await craftCase(bot, { items: [['stone', 6]], target: 'normal_stone_stairs', table })
    await craftCase(bot, { items: [['oak_planks', 3]], target: 'oak_slab', table })
    await craftCase(bot, { items: [['cobblestone', 3]], target: 'cobblestone_slab', table })
  })

  it('beds and boats', async () => {
    const { bot } = ctx
    const table = await stageTable(bot)
    // Bedrock has one `bed` item whose metadata is the colour (white 0, red 14)
    for (const [wool, color] of [['white_wool', 0], ['red_wool', 14]]) {
      await bot.test.clearInventory()
      await give(bot, [[wool, 3], ['oak_planks', 3]])
      const recipes = bot.recipesFor(id(bot, 'bed'), color, 1, table)
      assert.ok(recipes.length > 0, `a ${wool} bed recipe`)
      assert.ok(recipes.every(r => r.result.metadata === color), 'the metadata filter applies to the result')
      await bot.craft(recipes[0], 1, table)
      const bed = bot.inventory.items().find(it => it.name === 'bed')
      assert.strictEqual(bed?.metadata, color)
      assert.deepStrictEqual(counts(bot), { bed: 1 })
      await assertServerAgrees(bot)
    }
    await craftCase(bot, { items: [['oak_planks', 5]], target: 'oak_boat', table })
    await craftCase(bot, { items: [['spruce_planks', 5]], target: 'spruce_boat', table })
    await craftCase(bot, { items: [['bamboo_planks', 5]], target: 'bamboo_raft', table })
  })

  it('bulk: 64 planks in one call, 100 sticks across two stacks, in as few requests as possible', async () => {
    const { bot } = ctx
    const requests = []
    const unobserve = bot._bedrock.stackRequests.observe(({ request }) => {
      if (request.actions.some(a => a.type_id === 'craft_recipe')) requests.push(request.actions.find(a => a.type_id === 'craft_recipe').times_crafted)
    })
    try {
      await craftCase(bot, { items: [['oak_log', 16]], target: 'oak_planks', times: 16, expect: { oak_planks: 64 } })
      assert.deepStrictEqual(requests, [16], 'one request crafts a whole stack')
      requests.length = 0
      await bot.test.clearInventory()
      await give(bot, [['oak_planks', 64]])
      const [stick] = bot.recipesFor(id(bot, 'stick'), null, 100, null)
      assert.ok(stick)
      await bot.craft(stick, 25, null)
      assert.deepStrictEqual(counts(bot), { stick: 100, oak_planks: 14 })
      assert.deepStrictEqual(bot.inventory.items().filter(it => it.name === 'stick').map(it => it.count).sort((a, b) => b - a), [64, 36])
      assert.deepStrictEqual(requests, [16, 9], 'a request makes at most one stack')
      await assertServerAgrees(bot)
    } finally {
      unobserve()
    }
    // creative mode crafts the same way
    await bot.test.becomeCreative()
    await craftCase(bot, { items: [['oak_log', 2]], target: 'oak_planks', times: 2, expect: { oak_planks: 8 } })
  })

  it('2×2 grid vs crafting table: recipesFor / recipesAll filters, requiresTable error', async () => {
    const { bot } = ctx
    await bot.test.clearInventory()
    await give(bot, [['diamond', 3], ['stick', 2], ['oak_planks', 4]])
    const pickaxe = id(bot, 'diamond_pickaxe')
    assert.deepStrictEqual(bot.recipesFor(pickaxe, null, 1, null), [], 'a 3×3 recipe needs the table')
    assert.deepStrictEqual(bot.recipesAll(pickaxe, null, null), [])
    assert.strictEqual(bot.recipesAll(pickaxe, null, true).length, 1)
    const [recipe] = bot.recipesFor(pickaxe, null, 1, true)
    assert.ok(recipe.requiresTable)
    await assert.rejects(bot.craft(recipe, 1, null), /^Error: Recipe requires craftingTable, but one was not supplied: /)
    // a 2×2 recipe is crafted with the 3×3 grid when a table is given
    const table = await stageTable(bot)
    const [craftingTable] = bot.recipesFor(id(bot, 'crafting_table'), null, 1, null)
    assert.strictEqual(craftingTable.requiresTable, false)
    await bot.craft(craftingTable, 1, table)
    await bot.craft(recipe, 1, table)
    assert.deepStrictEqual(counts(bot), { crafting_table: 1, diamond_pickaxe: 1 })
    await assertServerAgrees(bot)
  })

  it('partial ingredients fail cleanly: crafts what it can, then "missing ingredient" like upstream', async () => {
    const { bot } = ctx
    await bot.test.clearInventory()
    await give(bot, [['oak_log', 3]])
    const [planks] = bot.recipesFor(id(bot, 'oak_planks'), null, 1, null)
    assert.strictEqual(bot.recipesFor(id(bot, 'oak_planks'), null, 16, null).length, 0, 'minResultCount 16 needs 4 logs')
    await assert.rejects(bot.craft(planks, 5, null), (err) => err.message === 'Error: missing ingredient')
    assert.deepStrictEqual(counts(bot), { oak_planks: 12 })
    await assertServerAgrees(bot)
    // nothing at all, at a table: the window is closed again
    const table = await stageTable(bot)
    await bot.test.clearInventory()
    const [sword] = bot.recipesAll(id(bot, 'iron_sword'), null, table)
    await assert.rejects(bot.craft(sword, 1, table), (err) => err.message === 'Error: missing ingredient')
    assert.strictEqual(bot.currentWindow, null)
    assert.deepStrictEqual(bot.recipesFor(id(bot, 'iron_sword'), null, 1, table), [])
    await assertServerAgrees(bot)
  })

  it('multi-result recipes: cake gives the buckets back, honey bottle → sugar + glass bottle (2×2)', async () => {
    const { bot } = ctx
    await craftCase(bot, { items: [['honey_bottle', 2]], target: 'sugar', times: 2, expect: { sugar: 6, glass_bottle: 2 } })
    const table = await stageTable(bot)
    const recipe = await craftCase(bot, {
      items: [['milk_bucket', 1], ['milk_bucket', 1], ['milk_bucket', 1], ['sugar', 2], ['egg', 1], ['wheat', 3]],
      target: 'cake',
      table,
      expect: { cake: 1, bucket: 3 }
    })
    assert.ok(recipe.delta.some(d => d.id === id(bot, 'bucket') && d.count === 3), 'the buckets are part of the delta')
  })

  it('a full inventory: the result goes where upstream puts it, what does not fit is tossed', async () => {
    const { bot } = ctx
    const table = await stageTable(bot)
    await bot.test.clearInventory()
    await give(bot, [['dirt', 35 * 64], ['honey_bottle', 4]])
    assert.strictEqual(bot.inventory.emptySlotCount(), 0)
    const dropped = once(bot, 'itemDrop', 10000)
    const [recipe] = bot.recipesFor(id(bot, 'honey_block'), null, 1, table)
    assert.ok(recipe)
    await bot.craft(recipe, 1, table)
    const [entity] = await dropped
    assert.strictEqual(entity.getDroppedItem()?.name, 'glass_bottle')
    assert.strictEqual(entity.getDroppedItem()?.count, 4)
    assert.deepStrictEqual(counts(bot), { dirt: 35 * 64, honey_block: 1 })
    // the server agrees (no free hotbar slot for the console no-op: removing a dirt stack resends the inventory)
    const resent = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'inventory', 10000)
    await bot.test.ctx.consoleOutput(`clear ${bot.test.ctx.who()} dirt 0 64`)
    await resent.promise
    const server = {}
    for (const it of bot.test.rawInventory().inventory) if (it) server[it.name] = (server[it.name] ?? 0) + it.count
    assert.deepStrictEqual(server, { dirt: 34 * 64, honey_block: 1 })
    // the bottles must not be picked up by the next test
    await bot.test.ctx.consoleOutput('kill @e[type=item]')
  })

  it('internalTest analogs: the table window is reused or another window is closed first; recipes from Recipe.find', async () => {
    const { bot } = ctx
    const table = await stageTable(bot)
    await bot.test.clearInventory()
    await give(bot, [['oak_planks', 9]])
    // a table window the user opened is reused, then closed like the one craft opens itself
    const window = await bot.openBlock(table)
    assert.strictEqual(window.type, 'minecraft:crafting')
    const [stick] = bot.recipesFor(id(bot, 'stick'), null, 1, table)
    await bot.craft(stick, 1, table)
    assert.strictEqual(bot.currentWindow, null)
    // another container open: closed before the table opens (BDS ignores the activation otherwise)
    await bot.test.setBlock({ x: -1, y: 0, z: 0, relative: true, blockName: 'chest' })
    const chest = await bot.openBlock(bot.findBlock({ matching: bot.registry.blocksByName.chest.id, maxDistance: 4 }))
    assert.strictEqual(bot.currentWindow, chest)
    await bot.craft(stick, 1, table)
    // a Recipe from prismarine-recipe over bot.registry.recipes (minecraft-data shape) crafts too
    const { Recipe } = require('prismarine-recipe')(bot.registry)
    const found = Recipe.find(id(bot, 'oak_slab')).find(r => r.inShape.flat().every(it => it.id === id(bot, 'oak_planks')))
    assert.ok(found, 'Recipe.find over bot.registry.recipes')
    await bot.craft(found, 1, table)
    const plain = new Recipe({ result: { id: id(bot, 'stick'), count: 4, metadata: 0 }, inShape: [[id(bot, 'oak_planks')], [id(bot, 'oak_planks')]] })
    assert.strictEqual(plain.networkId, undefined)
    await bot.craft(plain, 1, null)
    assert.deepStrictEqual(counts(bot), { stick: 12, oak_slab: 6 })
    await assertServerAgrees(bot)
  })
})
