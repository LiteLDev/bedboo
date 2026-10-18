// owner: U13 (stations)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/trade.js — ADAPTED fixture (docs/differences/U13.md#trade-fixture):
 * upstream summons a villager with NBT offers (`{NoAI:1, Offers:{Recipes:[…]}}`) from a command block; Bedrock's
 * /summon takes no NBT, so offers cannot be chosen. The port uses
 * - a `villager_v2` summoned with the spawn event `minecraft:become_librarian` (a novice librarian: its two unlocked
 *   trades are always "24 paper → 1 emerald" plus one of "9 emeralds → bookshelf" / "N emeralds + book → enchanted
 *   book"; librarians are summoned again until one offers the two-input trade), kept in reach with slowness;
 * - a `wandering_trader` (all its trades unlocked at once, small max uses) for emerald → item trades and the
 *   exhausted-trade rejection.
 * Like upstream, every trade is verified (fresh uses, the inputs/outputs shape) and run `trades` (2) times; the item
 * and emerald counts of bot.currentWindow are checked after each, and a blocked trade must reject. The trades are
 * random (which librarian book trade, which trader offers) — a random suite (gate ≥ 4/5).
 * Bedrock extra: the server's copy of the inventory (resend) equals the client's prediction of the trade outputs.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const trades = 2 // like upstream: each trade is run twice

describe('trade', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    if (ctx.bot.currentWindow) await ctx.bot.closeWindow(ctx.bot.currentWindow).catch(() => {})
    await ctx.bot.test.killAllEntities()
    await ctx.bot.test.becomeCreative()
  })

  function verifyTrade (bot, trade, minUses = trades) {
    assert.strictEqual(trade.nbTradeUses, 0, 'a fresh offer')
    assert.ok(trade.maximumNbTradeUses >= minUses, `max uses ${trade.maximumNbTradeUses}`)
    assert.strictEqual(trade.tradeDisabled, false)
    assert.strictEqual(trade.inputs.length, trade.hasItem2 ? 2 : 1)
    assert.strictEqual(trade.inputs[0], trade.inputItem1)
    assert.strictEqual(trade.outputs[0], trade.outputItem)
    assert.strictEqual(trade.realPrice, trade.inputItem1.count, 'no discount, no demand: the base price')

    const printCountInv = function (item) {
      return `${bot.currentWindow.count(bot.registry.itemsByName[item.name].id)}x ${item.displayName}`
    }
    const printCountTrade = function (item) {
      return `${item.count}x ${item.displayName}`
    }

    bot.test.sayEverywhere(`I have ${printCountInv(trade.inputItem1)} ${trade.hasItem2 ? 'and ' + printCountInv(trade.inputItem2) : ''}`)
    bot.test.sayEverywhere(`I can trade ${printCountTrade(trade.inputItem1)} ${trade.hasItem2 ? 'and ' + printCountTrade(trade.inputItem2) : ''} for ${printCountTrade(trade.outputItem)}`)
  }

  /** run trade `index` `trades` times and check the counts (inputs consumed, outputs received) */
  async function tradeAndCount (bot, villager, index) {
    const trade = villager.trades[index]
    verifyTrade(bot, trade)
    const count = (item) => bot.currentWindow.count(item.type)
    const before = new Map()
    for (const item of [trade.inputItem1, trade.inputItem2, trade.outputItem].filter(Boolean)) before.set(item.type, count(item))
    await bot.trade(villager, index, trades)
    const expected = new Map(before)
    expected.set(trade.inputItem1.type, expected.get(trade.inputItem1.type) - trade.realPrice * trades)
    if (trade.hasItem2) expected.set(trade.inputItem2.type, expected.get(trade.inputItem2.type) - trade.inputItem2.count * trades)
    expected.set(trade.outputItem.type, expected.get(trade.outputItem.type) + trade.outputItem.count * trades)
    for (const [type, n] of expected) assert.strictEqual(bot.currentWindow.count(type), n, `${bot.registry.items[type].name} after trade ${index}`)
    assert.strictEqual(trade.nbTradeUses, trades)
    assert.strictEqual(villager.slots[0], null, 'the trade slots are emptied like upstream')
    assert.strictEqual(villager.slots[1], null)
  }

  /** what the server holds equals the client's prediction (trade outputs are never sent back) */
  async function assertServerCopy (bot) {
    const describe = () => bot.inventory.items().map(i => `${i.slot}:${i.name}x${i.count}:${JSON.stringify(i.nbt)}`).sort()
    const predicted = describe()
    await bot.test.resyncInventory()
    assert.deepStrictEqual(describe(), predicted)
  }

  async function giveInputs (bot, trade) {
    await bot.test.give(trade.inputItem1.name, trade.realPrice * trades)
    if (trade.hasItem2) await bot.test.give(trade.inputItem2.name, trade.inputItem2.count * trades)
  }

  it('trade', async () => {
    const { bot } = ctx
    const pos = new Vec3(2, bot.test.groundY, 0)
    const emeraldId = bot.registry.itemsByName.emerald.id

    // a novice librarian offering the two-input trade (emeralds + book → enchanted book)
    let entity = null
    let offers = null
    for (let attempt = 0; attempt < 8 && !entity; attempt++) {
      const candidate = await bot.test.summon('villager_v2', pos, { spawnEvent: 'minecraft:become_librarian' })
      await bot.test.keepStill(candidate)
      const villager = await bot.openVillager(candidate)
      if (villager.trades.some(t => t.hasItem2)) {
        entity = candidate
        offers = villager.trades
      }
      await villager.close()
      if (!entity) await bot.test.killEntity(candidate)
    }
    assert.ok(entity, 'no librarian offered emeralds + book → enchanted book in 8 summons')
    assert(entity.name === 'villager_v2')
    assert.strictEqual(offers.length, 2, 'a novice: two unlocked trades')

    await bot.test.becomeSurvival()
    for (const trade of offers) await giveInputs(bot, trade)
    const villager = await bot.openVillager(entity)
    console.log('Opened villager')
    assert.strictEqual(villager.type, 'minecraft:merchant')

    // Handle trade #1 -- takes 24x paper and returns 1x emerald
    {
      const trade = villager.trades[0]
      assert.strictEqual(trade.inputs.length, 1, 'Expected single input from villager on first trade')
      const [input] = trade.inputs
      assert.strictEqual(input.name, 'paper')
      assert.strictEqual(input.count, 24)
      const [output] = trade.outputs
      assert.strictEqual(output.name, 'emerald')
      assert.strictEqual(output.count, 1)
      await tradeAndCount(bot, villager, 0)
    }

    // Handle trade #2 -- takes [Nx emerald, 1x book] and returns 1x enchanted book
    {
      const index = villager.trades.findIndex(t => t.hasItem2)
      const trade = villager.trades[index]
      assert.strictEqual(trade.inputs.length, 2, 'Expected two inputs from villager on second trade')
      const [input1, input2] = trade.inputs
      assert.strictEqual(input1.name, 'emerald')
      assert.ok(input1.count >= 5 && input1.count <= 64)
      assert.strictEqual(input2.name, 'book')
      assert.strictEqual(input2.count, 1)
      const [output] = trade.outputs
      assert.strictEqual(output.name, 'enchanted_book')
      assert.strictEqual(output.count, 1)
      assert.ok(output.enchants.length >= 1, 'the offer carries the book\'s enchantment')
      await tradeAndCount(bot, villager, index)
      assert.strictEqual(bot.currentWindow.count(bot.registry.itemsByName.book.id), 0)
      assert.strictEqual(bot.currentWindow.count(emeraldId), trades, 'the emeralds of trade #1 are left')
    }
    await villager.close()
    await assertServerCopy(bot)

    // the server counted the uses
    const again = await bot.openVillager(entity)
    assert.deepStrictEqual(again.trades.map(t => t.nbTradeUses), [trades, trades])
    await again.close()
    await bot.test.killEntity(entity)
  })

  it('trade: wandering trader, emerald trades, a used-up trade is blocked (Bedrock extra)', async () => {
    const { bot } = ctx
    const emeraldId = bot.registry.itemsByName.emerald.id
    const entity = await bot.test.summon('wandering_trader', new Vec3(2, bot.test.groundY, 0))
    await bot.test.keepStill(entity)
    await bot.test.becomeSurvival()
    let villager = await bot.openVillager(entity)
    const offers = villager.trades
    assert.ok(offers.length >= 6, `a wandering trader offers all its trades (${offers.length})`)
    for (const trade of offers) verifyTrade(bot, trade, 1)
    // two emerald → item trades, run twice each
    const buy = offers.map((t, i) => [t, i]).filter(([t]) => t.inputItem1.type === emeraldId && !t.hasItem2 && t.maximumNbTradeUses >= trades).slice(0, 2)
    assert.strictEqual(buy.length, 2, 'two emerald trades')
    await villager.close()
    for (const [trade] of buy) await giveInputs(bot, trade)
    // a trade with the fewest uses, to use it up
    const [limited, limitedIndex] = offers.map((t, i) => [t, i]).sort((a, b) => a[0].maximumNbTradeUses - b[0].maximumNbTradeUses)[0]
    await bot.test.give(limited.inputItem1.name, limited.realPrice * (limited.maximumNbTradeUses + 1))
    if (limited.hasItem2) await bot.test.give(limited.inputItem2.name, limited.inputItem2.count * (limited.maximumNbTradeUses + 1))

    villager = await bot.openVillager(entity)
    for (const [, index] of buy) {
      if (index === limitedIndex) continue
      await tradeAndCount(bot, villager, index)
    }
    // count defaults to every use left; then the trade is disabled and another trade is refused
    const trade = villager.trades[limitedIndex]
    await bot.trade(villager, limitedIndex)
    assert.strictEqual(trade.nbTradeUses, trade.maximumNbTradeUses)
    assert.strictEqual(trade.tradeDisabled, true)
    await assert.rejects(bot.trade(villager, limitedIndex, 1), /trade blocked/) // Shouldn't be able, the trade is blocked!
    await villager.close()
    await assertServerCopy(bot)

    const again = await bot.openVillager(entity)
    assert.strictEqual(again.trades[limitedIndex].nbTradeUses, again.trades[limitedIndex].maximumNbTradeUses)
    assert.strictEqual(again.trades[limitedIndex].tradeDisabled, true)
    await again.close()
    await bot.test.killEntity(entity)
  })
})
