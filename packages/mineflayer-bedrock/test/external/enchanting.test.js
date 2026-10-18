// owner: U13 (stations)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/enchanting.js. Adaptation (docs/differences/U13.md#ported-tests):
 * `/xp set <bot> 999 levels` does not exist on Bedrock: `/xp 999L <bot>`; the table and the bookshelves are placed
 * with the setblock-based bot.test.placeBlock (U11 upgrades it to bot.placeBlock). Everything else is verbatim.
 * Bedrock extras: each of the three options on several items (the server's enchanted item — read back with an
 * inventory resend — equals the client's prediction, choice + 1 levels and lapis are charged), a book becomes an
 * enchanted book, creative mode charges neither.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

async function until (condition, timeout) {
  for (const end = Date.now() + timeout; !condition() && Date.now() < end;) await new Promise(resolve => setTimeout(resolve, 50))
}

const BOOKSHELVES = [[3, 2], [3, 1], [3, 0], [3, -1], [3, -2], [2, -2], [1, -2], [0, -2], [-1, -2], [-1, -1], [-1, 1], [-1, 2], [0, 2], [1, 2], [2, 2]]

describe('enchanting', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    if (ctx.bot.currentWindow) await ctx.bot.closeWindow(ctx.bot.currentWindow).catch(() => {})
    await ctx.bot.test.becomeCreative()
  })

  it('enchanting', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    const lapisId = bot.registry.itemsByName.lapis_lazuli ? bot.registry.itemsByName.lapis_lazuli.id : bot.registry.itemsByName.dye.id
    const lapisData = bot.registry.itemsByName.lapis_lazuli ? 0 : 4

    const enchantSlot = 2

    // Bedrock: no `/xp set … levels` (adapted)
    const leveled = once(bot, 'experience')
    bot.chat(`/xp 999L ${bot.username}`)
    await leveled
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.bookshelf.id, 15))
    await bot.test.setInventorySlot(37, new Item(bot.registry.itemsByName.enchanting_table.id, 1))
    await bot.test.setInventorySlot(38, new Item(bot.registry.itemsByName.diamond_sword.id, 1))
    await bot.test.setInventorySlot(39, new Item(lapisId, enchantSlot + 1, lapisData))

    await bot.test.becomeSurvival()

    // Place enchanting table
    await bot.test.placeBlock(37, bot.entity.position.offset(1, 0, 0))

    // Place bookshelfs
    for (const [x, z] of BOOKSHELVES) await bot.test.placeBlock(36, bot.entity.position.offset(x, 0, z))

    const b = bot.findBlock({ matching: bot.registry.blocksByName.enchanting_table.id })
    const enchantingTable = await bot.openEnchantmentTable(b)

    console.log('Opened enchanting table')

    const lapis = enchantingTable.findInventoryItem(lapisId)
    await enchantingTable.putLapis(lapis)

    const sword = enchantingTable.findInventoryItem(bot.registry.itemsByName.diamond_sword.id)

    await enchantingTable.putTargetItem(sword)

    console.log('Table ready')
    await enchantingTable.enchant(enchantSlot)
    await bot.test.wait(500)
    const result = await enchantingTable.takeTargetItem()

    assert.notStrictEqual(result.nbt, undefined)

    await enchantingTable.close()
  })

  /** table + 15 bookshelves around the bot (as in the upstream test) */
  async function stageTable (bot) {
    const pos = bot.entity.position.offset(1, 0, 0).floored()
    await bot.test.setBlock({ ...pos, blockName: 'enchanting_table' })
    for (const [x, z] of BOOKSHELVES) {
      const p = bot.entity.position.offset(x, 0, z).floored()
      await bot.test.setBlock({ ...p, blockName: 'bookshelf' })
    }
    return bot.blockAt(pos)
  }

  const CASES = [
    ['diamond_sword', 0], ['diamond_sword', 1], ['diamond_sword', 2],
    ['diamond_pickaxe', 2], ['diamond_chestplate', 1], ['book', 2]
  ]
  for (const [target, choice] of CASES) {
    it(`${target}, option ${choice}: the server's item = the prediction, ${choice + 1} levels and lapis charged (Bedrock extra)`, async () => {
      const { bot } = ctx
      const Item = require('prismarine-item')(bot.registry)
      const id = (name) => bot.registry.itemsByName[name].id
      await bot.test.setInventorySlot(36, new Item(id(target), 1))
      await bot.test.setInventorySlot(37, new Item(id('lapis_lazuli'), 5))
      await bot.test.becomeSurvival()
      await bot.test.setExperienceLevel(40)
      const table = await bot.openEnchantmentTable(await stageTable(bot))
      assert.strictEqual(table.type, 'minecraft:enchantment')
      assert.deepStrictEqual(table.enchantments.map(e => e.level), [-1, -1, -1], 'nothing in the table yet')
      await table.putLapis(table.findInventoryItem(id('lapis_lazuli')))
      const ready = once(table, 'ready')
      await table.putTargetItem(table.findInventoryItem(id(target)))
      await ready
      const option = JSON.parse(JSON.stringify(table.enchantments[choice])) // the slots are reset after enchanting
      assert.ok(option.level >= 1 && option.level <= 30, `level requirement ${option.level}`)
      assert.ok(bot.registry.enchantments[option.expected.enchant], `expected enchant ${option.expected.enchant}`)
      assert.ok(option.expected.level >= 1)
      assert.strictEqual(table.xpseed, -1, 'Bedrock never sends the seed')

      const levels = bot.experience.level
      const item = await table.enchant(choice)
      const resultName = target === 'book' ? 'enchanted_book' : target
      assert.strictEqual(item, table.slots[0])
      assert.strictEqual(item.name, resultName)
      assert.ok(item.enchants.length >= 1)
      assert.ok(item.enchants.some(e => bot.registry.enchantmentsByName[e.name].id === option.expected.enchant && e.lvl === option.expected.level),
        'the hinted enchantment is applied')
      assert.strictEqual(table.slots[1]?.count ?? 0, 5 - (choice + 1), 'lapis charged')
      const taken = await table.takeTargetItem()
      assert.strictEqual(taken.name, resultName)
      await table.close()
      await until(() => bot.experience.level === levels - (choice + 1), 3000)
      assert.strictEqual(bot.experience.level, levels - (choice + 1), 'levels charged')

      const predicted = bot.inventory.items().find(i => i.name === resultName)
      await bot.test.resyncInventory()
      const server = bot.inventory.items().find(i => i.name === resultName)
      assert.deepStrictEqual(server.nbt, predicted.nbt, 'the server enchanted it as predicted')
      assert.strictEqual(bot.inventory.count(id('lapis_lazuli')), 5 - (choice + 1))
    })
  }

  it('creative mode: neither lapis nor levels are charged (Bedrock extra)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const id = (name) => bot.registry.itemsByName[name].id
    await bot.test.setInventorySlot(36, new Item(id('iron_sword'), 1))
    await bot.test.setInventorySlot(37, new Item(id('lapis_lazuli'), 3))
    const table = await bot.openEnchantmentTable(await stageTable(bot))
    await table.putLapis(table.findInventoryItem(id('lapis_lazuli')))
    await table.putTargetItem(table.findInventoryItem(id('iron_sword')))
    const item = await table.enchant(2)
    assert.ok(item.enchants.length >= 1)
    assert.strictEqual(table.slots[1].count, 3)
    await table.close()
    const predicted = bot.inventory.items().find(i => i.name === 'iron_sword')
    await bot.test.resyncInventory()
    assert.deepStrictEqual(bot.inventory.items().find(i => i.name === 'iron_sword').nbt, predicted.nbt)
    assert.strictEqual(bot.inventory.count(id('lapis_lazuli')), 3)
  })
})
