// owner: U12 (crafting)
'use strict'
/**
 * Bedrock extra: the item tag table of lib/bedrock/item_tags.js against the live server. BDS never sends tag members,
 * so every member of every tag that a crafting recipe uses is crafted once through bot.recipesFor + bot.craft (the
 * recipe expanded for that member) and the server must accept it. Also: every recipe of the server's crafting_data
 * resolves (no recipe skipped for an unknown tag or item).
 */
const assert = require('assert')
const { useBot } = require('./common')
const ITEM_TAGS = require('../../lib/bedrock/item_tags')

/** per tag: a recipe that uses it, the other ingredients, how many members it takes */
const CASES = [
  { tag: 'minecraft:planks', target: 'stick', uses: 2 },
  { tag: 'minecraft:logs', target: 'campfire', uses: 3, others: [['stick', 3], ['coal', 1]], table: true },
  { tag: 'minecraft:wooden_slabs', target: 'composter', uses: 7, table: true },
  { tag: 'minecraft:stone_crafting_materials', target: 'brewing_stand', uses: 3, others: [['blaze_rod', 1]], table: true },
  { tag: 'minecraft:stone_tool_materials', target: 'stone_axe', uses: 3, others: [['stick', 2]], table: true },
  { tag: 'minecraft:egg', target: 'pumpkin_pie', uses: 1, others: [['pumpkin', 1], ['sugar', 1]] },
  { tag: 'minecraft:coals', target: 'torch', uses: 1, others: [['stick', 1]] },
  { tag: 'minecraft:metal_nuggets', target: 'name_tag', uses: 1, others: [['paper', 1]] },
  { tag: 'minecraft:wool', target: 'painting', uses: 1, others: [['stick', 8]], table: true },
  { tag: 'minecraft:soul_fire_base_blocks', target: 'soul_torch', uses: 1, others: [['coal', 1], ['stick', 1]], table: true },
  { tag: 'minecraft:mushrooms_for_stew', target: 'mushroom_stew', uses: 2, others: [['bowl', 1]] }
]

describe('craftingTags', function () {
  this.timeout(300000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  before(async () => {
    await ctx.bot.test.resetState()
    await ctx.bot.test.becomeSurvival()
  })

  it('every crafting recipe of the server resolves (tags, items)', () => {
    const { bot } = ctx
    const book = bot._bedrock.recipes
    assert.deepStrictEqual(book.skipped, [])
    assert.ok(book.all().length > 4000, `expanded crafting recipes: ${book.all().length}`)
    const used = new Set()
    for (const recipe of book.all()) {
      for (const desc of book.byNetworkId(recipe.networkId).input) if (desc.descriptor_type === 'item_tag') used.add(desc.tag)
    }
    for (const tag of used) assert.ok(ITEM_TAGS[tag], `tag ${tag} is in the table`)
    for (const { tag } of CASES) assert.ok(used.has(tag), `${tag} is used by a crafting recipe`)
  })

  for (const { tag, target, uses, others = [], table: needsTable } of CASES) {
    it(`${tag}: every member crafts ${target}`, async () => {
      const { bot } = ctx
      let table = null
      if (needsTable) {
        await bot.test.setBlock({ x: 1, y: 0, z: 0, relative: true, blockName: 'crafting_table' })
        table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 4 })
      }
      const targetId = bot.registry.itemsByName[target].id
      const rejected = []
      for (const member of ITEM_TAGS[tag]) {
        await bot.test.clearInventory()
        await bot.test.give(member, uses)
        for (const [name, count] of others) await bot.test.give(name, count)
        const recipes = bot.recipesFor(targetId, null, 1, table)
        const memberId = bot.registry.itemsByName[member].id
        const recipe = recipes.find(r => r.delta.some(d => d.id === memberId && d.count === -uses))
        assert.ok(recipe, `${target} recipe with ${member}`)
        try {
          await bot.craft(recipe, 1, table)
        } catch (err) {
          rejected.push(`${member}: ${err.message}`)
          continue
        }
        assert.strictEqual(bot.inventory.count(targetId), recipe.result.count, `${target} from ${member}`)
        assert.strictEqual(bot.inventory.count(memberId), 0, `${member} consumed`)
      }
      assert.deepStrictEqual(rejected, [], `the server accepts every member of ${tag}`)
    })
  }
})
