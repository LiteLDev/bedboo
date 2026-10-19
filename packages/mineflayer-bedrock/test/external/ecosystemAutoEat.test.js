// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-auto-eat 5.0.3 (ESM, loaded with `await import()`; + patches/mineflayer-auto-eat@5.0.3.patch) on BDS
 * 1.26.51.1 (Bedrock extra, docs/ecosystem.md). Bedrock has no entity_status: the patched plugin completes a meal on
 * BDS' completed_using_item. Difficulty easy (on peaceful the food level never drops, docs/differences/U8.md).
 * - eat(): equips the best food (registry foods), eats it, returns to the previous item; the food level rises.
 * - enableAuto(): hungry (/effect hunger) → eats by itself until the food level is back above minHunger.
 * Its dependency @nxg-org/mineflayer-util-plugin (GPL-3.0, unmodified) needs Java version comparisons on the registry
 * (bedrock-data relaxes them, docs/differences/U15.md#version-comparisons).
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('ecosystemAutoEat', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  const events = []

  before(async () => {
    const { bot } = ctx
    const { loader } = await import('mineflayer-auto-eat')
    bot.loadPlugin(loader)
    assert.ok(bot.autoEat && bot.util, 'auto-eat + util plugin loaded')
    for (const name of ['eatStart', 'eatFinish', 'eatFail']) bot.autoEat.on(name, (arg) => events.push([name, arg?.food?.name ?? arg?.message]))
  })
  beforeEach(async () => {
    await ctx.bot.test.resetState()
    ctx.bot.setQuickBarSlot(0)
    events.length = 0
  })
  afterEach(async () => {
    ctx.bot.autoEat.disableAuto()
    await ctx.bot.test.ctx.consoleOutput(`effect ${ctx.bot.username} clear`)
    await ctx.bot.test.becomeCreative()
  })

  async function hungry (below) {
    const { bot } = ctx
    await bot.test.ctx.consoleExpect(`effect ${bot.username} hunger 60 255`, /effect|gave|applied/i)
    const t0 = Date.now()
    while (!(bot.food < below)) {
      assert.ok(Date.now() - t0 < 30000, `food ${bot.food}`)
      await bot.waitForTicks(5)
    }
    await bot.test.ctx.consoleOutput(`effect ${bot.username} clear`)
  }

  it('eat(): picks bread, eats it (completed_using_item), food rises, the sword comes back', async () => {
    const { bot } = ctx
    await bot.test.becomeSurvival()
    await bot.test.give('diamond_sword', 1)
    await bot.test.give('bread', 8)
    await bot.test.give('rotten_flesh', 8) // banned by default
    await hungry(16)
    const before = bot.food
    const t0 = Date.now()
    await bot.autoEat.eat()
    const ms = Date.now() - t0
    console.log(`      eat(): ${ms} ms, food ${before} → ${bot.food}`)
    assert.ok(ms < 3000, 'completed before the 3 s eatingTimeout')
    await bot.waitForTicks(10)
    assert.ok(bot.food > before, `food ${before} → ${bot.food}`)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.bread.id), 7)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.rotten_flesh.id), 8)
    assert.strictEqual(bot.heldItem?.name, 'diamond_sword', 'returnToLastItem')
    assert.deepStrictEqual(events.map(e => e[0]), ['eatStart', 'eatFinish'])
  })

  it('enableAuto(): eats by itself when hungry until the food level is back above minHunger', async () => {
    const { bot } = ctx
    await bot.test.becomeSurvival()
    await bot.test.give('cooked_beef', 16)
    bot.autoEat.setOpts({ minHunger: 15 })
    await hungry(10)
    bot.autoEat.enableAuto()
    const t0 = Date.now()
    while (bot.food < 15 || bot.autoEat.isEating) {
      assert.ok(Date.now() - t0 < 30000, `food ${bot.food}, events ${JSON.stringify(events)}`)
      await bot.waitForTicks(5)
    }
    console.log(`      auto: food ≥ 15 after ${Date.now() - t0} ms, ${events.filter(e => e[0] === 'eatFinish').length} meal(s)`)
    assert.ok(events.some(e => e[0] === 'eatFinish' && e[1] === 'cooked_beef'), JSON.stringify(events))
    assert.ok(!events.some(e => e[0] === 'eatFail'), JSON.stringify(events))
    assert.ok(bot.inventory.count(bot.registry.itemsByName.cooked_beef.id) < 16)
  })
})
