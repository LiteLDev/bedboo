// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-tool 1.2.0 (+ patches/mineflayer-tool@1.2.0.patch) on BDS 1.26.51.1 (Bedrock extra, docs/ecosystem.md):
 * `bot.tool.equipForBlock` picks the fastest pickaxe / axe / shovel, honours Bedrock enchantments (`ench` NBT, read
 * through `item.enchants`), keeps the hand when no tool beats it, and rejects with NoItem when `requireHarvest` finds no
 * harvesting tool. Its dig-time estimate equals mineflayer-bedrock's `bot.digTime` (Bedrock effect factors), and the
 * chosen tool really digs at that speed on BDS.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

describe('ecosystemTool', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })

  before(async () => {
    const { bot } = ctx
    bot.loadPlugin(require('mineflayer-tool').plugin)
    await bot.waitForTicks(2) // mineflayer-tool loads mineflayer-pathfinder on the next tick
    assert.ok(bot.tool && bot.pathfinder)
  })
  beforeEach(async () => {
    await ctx.bot.test.resetState()
    ctx.bot.setQuickBarSlot(0)
  })
  afterEach(() => ctx.bot.test.becomeCreative())

  const g = () => ctx.bot.test.groundY
  async function blockAt (x, z, name) {
    await ctx.bot.test.setBlock({ x, y: g(), z, blockName: name })
    return ctx.bot.blockAt(new Vec3(x, g(), z))
  }
  async function hotbar (names) {
    const Item = require('prismarine-item')(ctx.bot.registry)
    for (let i = 0; i < names.length; i++) {
      await ctx.bot.test.setInventorySlot(36 + i, new Item(ctx.bot.registry.itemsByName[names[i]].id, 1, 0))
    }
  }

  it('equipForBlock: iron pickaxe for stone and iron ore, axe for logs, shovel for dirt; digs at the estimated speed', async () => {
    const { bot } = ctx
    await hotbar(['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'stone_axe', 'iron_shovel'])
    const stone = await blockAt(1, 1, 'stone')
    const log = await blockAt(1, -1, 'oak_log')
    const dirt = await blockAt(-1, 1, 'dirt')
    const ore = await blockAt(-1, -1, 'iron_ore')
    await bot.test.becomeSurvival()
    for (const [block, tool] of [[stone, 'iron_pickaxe'], [log, 'stone_axe'], [dirt, 'iron_shovel'], [ore, 'iron_pickaxe']]) {
      await bot.tool.equipForBlock(block, { requireHarvest: true })
      assert.strictEqual(bot.heldItem?.name, tool, `${block.name}`)
      // mineflayer-tool's estimate (patched: Bedrock dig speed) = bot.digTime with that tool in hand
      assert.strictEqual(bot.tool.getDigTime(block, bot.heldItem), bot.digTime(block), block.name)
    }
    // the chosen tool digs at the estimated speed on BDS
    await bot.tool.equipForBlock(stone)
    const expected = bot.digTime(stone)
    const t0 = performance.now()
    await bot.dig(stone)
    const took = performance.now() - t0
    console.log(`      stone with ${bot.heldItem.name}: ${took.toFixed(0)} ms (estimate ${expected} ms)`)
    assert.ok(took > expected - 150 && took < expected + 600, `${took} vs ${expected}`)
    assert.strictEqual(bot.blockAt(stone.position).name, 'air')
  })

  it('honours enchantments (Bedrock ench NBT): Efficiency V beats a plain pickaxe of the same tier', async () => {
    const { bot } = ctx
    await hotbar(['iron_pickaxe', 'iron_pickaxe'])
    bot.setQuickBarSlot(1)
    await bot.waitForTicks(4)
    await bot.test.ctx.consoleExpect(`enchant ${bot.username} efficiency 5`, /enchant/i)
    for (let i = 0; i < 40 && !bot.inventory.slots[37]?.enchants?.length; i++) await bot.waitForTicks(1)
    const enchanted = bot.inventory.slots[37]
    assert.deepStrictEqual(enchanted.enchants, [{ name: 'efficiency', lvl: 5 }], 'item.enchants reads the ench NBT')
    bot.setQuickBarSlot(0)
    await bot.waitForTicks(2)
    const stone = await blockAt(1, 1, 'stone')
    assert.ok(bot.tool.getDigTime(stone, enchanted) < bot.tool.getDigTime(stone, bot.inventory.slots[36]), 'Efficiency counts')
    await bot.test.becomeSurvival()
    await bot.tool.equipForBlock(stone)
    assert.strictEqual(bot.heldItem.slot, 37, 'the enchanted pickaxe')
    assert.deepStrictEqual(bot.heldItem.enchants, [{ name: 'efficiency', lvl: 5 }])
    // mineflayer-pathfinder's own pick agrees (patched: item.enchants)
    assert.strictEqual(bot.pathfinder.bestHarvestTool(stone).slot, 37)
  })

  it('hand fallback: keeps the held item when no tool beats the hand, NoItem when requireHarvest finds none', async () => {
    const { bot } = ctx
    const dirt = await blockAt(1, 1, 'dirt')
    const stone = await blockAt(1, -1, 'stone')
    const obsidian = await blockAt(-1, 1, 'obsidian')
    await bot.test.becomeSurvival()
    // nothing at all: the hand it is
    await bot.tool.equipForBlock(stone)
    assert.strictEqual(bot.heldItem, null)
    // only an axe: no better tool for dirt (the axe is as slow as the hand) → no needless equip, the axe stays
    await hotbar(['stone_axe'])
    let equips = 0
    const equip = bot.equip
    bot.equip = (...args) => { equips++; return equip.apply(bot, args) }
    try {
      await bot.tool.equipForBlock(dirt)
      assert.strictEqual(equips, 0)
      assert.strictEqual(bot.heldItem?.name, 'stone_axe')
      // stone can only be harvested with a pickaxe
      await assert.rejects(bot.tool.equipForBlock(stone, { requireHarvest: true }), { name: 'NoItem' })
      // obsidian needs a diamond pickaxe
      await hotbar(['stone_axe', 'iron_pickaxe'])
      await assert.rejects(bot.tool.equipForBlock(obsidian, { requireHarvest: true }), { name: 'NoItem' })
    } finally {
      bot.equip = equip
    }
    // the hand digs dirt
    bot.setQuickBarSlot(5)
    await bot.waitForTicks(2)
    await bot.tool.equipForBlock(dirt)
    await bot.dig(dirt)
    assert.strictEqual(bot.blockAt(dirt.position).name, 'air')
  })
})
