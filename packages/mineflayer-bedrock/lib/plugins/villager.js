// owner: U13 (stations)
// Adapted from mineflayer 4.39.0 lib/plugins/villager.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): openVillager (window + 'ready' bookkeeping), trade (guards, error
// messages, use counting, putRequirements / deposit, putting the leftovers away) are kept; the trade list and the
// trade itself are Bedrock.
// Surface: bot.openVillager(villagerEntity) → Promise<Villager> (window + trades, selectedTrade, trade(index, count);
//   event 'ready'), bot.trade(villagerInstance, tradeIndex, times)
// Bedrock (BDS 1.26.51.1):
// - entities: `villager_v2` (the villager), `villager` (legacy) and `wandering_trader` (Java: a separate type whose
//   window is also minecraft:merchant) open a trade window.
// - interacting sends update_trade { window_id, window_type: 'trading', trade_tier, villager_unique_id, display_name,
//   offers: NBT { Recipes: [{ buyA, buyCountA, buyB?, buyCountB, sell, uses, maxUses, tier, traderExp, demand,
//   priceMultiplierA/B, netId, rewardExp }], TierExpRequirements } } and NO container_open: the trade screen is
//   opened by that packet (the inventory plugin opens it as the 'trading' container: ingredient 1 =
//   ui slot 4 `trade2_ingredient1`, ingredient 2 = ui slot 5 `trade2_ingredient2`, verified).
// - the offers list every tier; Java sends only the unlocked ones, so `trades` = the recipes with tier <= trade_tier.
// - prices: buyA.Count is the price the server charges (discounts such as Hero of the Village are folded in,
//   verified), buyCountA the base price: `inputItem1.count` = base (Java), `realPrice` = the server's price,
//   `specialPrice` = the difference minus Java's demand adjustment (so upstream's realPrice formula gives it back).
// - trading = one item stack request per use: craft_recipe { recipe_network_id: netId } + consume the inputs from
//   the ingredient slots + place the output from creative_output 50 into the inventory (= upstream's putAway(2)).
//   There is no select_trade; the server counts the use (`uses` in the next update_trade).
'use strict'
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { windowIdOf } = require('../bedrock/inventory_model')
const { resultSteps, runStation, closeCurrentWindow, onWindowGone, itemFromNbt, tagValue } = require('../bedrock/stations')

module.exports = inject

/** entities whose interaction opens a trade window (Bedrock names) */
const TRADER_NAMES = ['villager_v2', 'villager', 'wandering_trader']

function inject (bot) {
  const { entitiesByName } = bot.registry
  const Item = require('prismarine-item')(bot.registry)

  // BDS opens the trading screen with update_trade alone (no container_open): the inventory plugin opens the merchant
  // window from it (window type 'trading' → minecraft:merchant, W3-FIX-B); a resend for the open window only
  // refreshes the offers (gotTrades below).

  async function openVillager (villagerEntity) {
    const traderTypes = TRADER_NAMES.map(name => entitiesByName[name]?.id).filter(id => id !== undefined)
    assert.ok(traderTypes.includes(villagerEntity.entityType), `entity ${villagerEntity.name} is not a villager`)
    let ready = false

    await closeCurrentWindow(bot)
    const villagerPromise = bot.openEntity(villagerEntity)
    bot._client.on('update_trade', gotTrades)
    let villager
    try {
      villager = await villagerPromise
    } catch (err) {
      bot._client.removeListener('update_trade', gotTrades)
      throw err
    }
    if (villager.type !== 'minecraft:villager' && villager.type !== 'minecraft:merchant') {
      throw new Error('Expected minecraft:villager or minecraft:mechant type, but got ' + villager.type)
    }

    villager.trades = null
    villager.selectedTrade = null

    onWindowGone(bot, villager, () => {
      bot._client.removeListener('update_trade', gotTrades)
    })

    villager.trade = async (index, count) => {
      await bot.trade(villager, index, count)
    }

    if (!ready) await once(villager, 'ready')
    // a trade window opens with empty input slots on Java (the server returned them when the last one closed). On
    // Bedrock they are the player's ui slots: items a dead trader's window left there (BDS refuses to return them from
    // that screen, docs/differences/U16a.md#container-gone) show up here — put them back into the inventory (U16a)
    const model = bot._bedrock.inventoryModel
    const stuck = [0, 1].filter((slot) => villager.slots[slot]).map((slot) => model.keyOf(villager, slot)).filter(Boolean)
    if (stuck.length > 0 && bot.currentWindow === villager) {
      await model.returnItems(villager, stuck).catch((err) => bot._warn(`returning the items left in the trade slots: ${err.message}`))
    }
    return villager

    async function gotTrades (packet) {
      let villager
      try {
        villager = await villagerPromise
      } catch {
        return
      }
      if (windowIdOf(packet.window_id) !== villager.id) return
      villager.trades = parseTrades(packet)
      if (!ready) {
        ready = true
        villager.emit('ready')
      }
    }
  }

  const anyData = (compound) => Number(tagValue(tagValue(compound)?.Damage)) === 32767

  /** metadata to match an input with (null = any: the offer's Damage 32767) */
  const inputMetadata = (Trade, n) => Trade.bedrock?.[`anyData${n}`] ? null : Trade[`inputItem${n}`].metadata

  /** update_trade offers → upstream trade objects (unlocked tiers only) */
  function parseTrades (packet) {
    const tier = Number(packet.trade_tier ?? 0)
    const recipes = tagValue(tagValue(packet.offers)?.Recipes)?.value ?? []
    const trades = []
    for (const recipe of recipes) {
      const r = (key) => tagValue(recipe[key])
      if (Number(r('tier') ?? 0) > tier) continue
      const price = Number(tagValue(tagValue(recipe.buyA)?.Count) ?? 0)
      const baseCount = Number(r('buyCountA') ?? 0) || price
      const inputItem1 = itemFromNbt(Item, bot.registry, recipe.buyA, baseCount)
      const outputItem = itemFromNbt(Item, bot.registry, recipe.sell)
      if (!inputItem1 || !outputItem) continue // an item this registry does not know
      const hasB = !!recipe.buyB && Number(r('buyCountB') ?? 0) > 0
      const inputItem2 = hasB ? itemFromNbt(Item, bot.registry, recipe.buyB) : null
      if (hasB && !inputItem2) continue
      const demand = Number(r('demand') ?? 0)
      const priceMultiplier = Number(r('priceMultiplierA') ?? 0)
      const demandDiff = Math.max(0, Math.floor(baseCount * demand * priceMultiplier))
      const uses = Number(r('uses') ?? 0)
      const maxUses = Number(r('maxUses') ?? 0)
      const trade = {
        inputItem1,
        outputItem,
        hasItem2: !!inputItem2,
        inputItem2,
        tradeDisabled: uses >= maxUses,
        nbTradeUses: uses,
        maximumNbTradeUses: maxUses,
        xp: Number(r('traderExp') ?? 0),
        specialPrice: price - baseCount - demandDiff,
        priceMultiplier,
        demand
      }
      trade.inputs = inputItem2 ? [inputItem1, inputItem2] : [inputItem1]
      trade.outputs = [outputItem]
      trade.realPrice = Math.min(Math.max(price, 1), inputItem1.stackSize)
      Object.defineProperty(trade, 'bedrock', {
        enumerable: false,
        value: {
          netId: Number(r('netId')),
          tier: Number(r('tier') ?? 0),
          rewardExp: !!r('rewardExp'),
          // Damage 32767: any data value of the input is accepted
          anyData1: anyData(recipe.buyA),
          anyData2: hasB && anyData(recipe.buyB)
        }
      })
      trades.push(trade)
    }
    return trades
  }

  async function trade (villager, index, count) {
    const choice = parseInt(index, 10) // allow string argument
    assert.notStrictEqual(villager.trades, null)
    assert.notStrictEqual(villager.trades[choice], null)
    const Trade = villager.trades[choice]
    villager.selectedTrade = Trade
    count = count || Trade.maximumNbTradeUses - Trade.nbTradeUses
    assert.ok(Trade.maximumNbTradeUses - Trade.nbTradeUses > 0, 'trade blocked')
    assert.ok(Trade.maximumNbTradeUses - Trade.nbTradeUses >= count)

    const itemCount1 = villager.count(Trade.inputItem1.type, inputMetadata(Trade, 1))
    const hasEnoughItem1 = itemCount1 >= Trade.realPrice * count
    let hasEnoughItem2 = true
    let itemCount2 = 0
    if (Trade.hasItem2) {
      itemCount2 = villager.count(Trade.inputItem2.type, inputMetadata(Trade, 2))
      hasEnoughItem2 = itemCount2 >= Trade.inputItem2.count * count
    }
    if (!hasEnoughItem1) {
      throw new Error('Not enough item 1 to trade')
    }
    if (!hasEnoughItem2) {
      throw new Error('Not enough item 2 to trade')
    }

    // Bedrock has no select_trade (Java's server then moves the inputs itself): clear ingredient slots holding
    // something else, the trade is picked by its recipe network id in the request
    for (const [i, wanted] of [[0, Trade.inputItem1], [1, Trade.inputItem2]]) {
      const there = villager.slots[i]
      if (there && (!wanted || there.type !== wanted.type)) await bot.putAway(i)
    }

    for (let i = 0; i < count; i++) {
      await putRequirements(villager, Trade)
      await takeOutput(villager, Trade)
      // ToDo: See if this does anything kappa
      Trade.nbTradeUses++
      if (Trade.maximumNbTradeUses - Trade.nbTradeUses === 0) {
        Trade.tradeDisabled = true
      }
    }

    for (const i of [0, 1]) {
      if (villager.slots[i]) {
        await bot.putAway(i) // 1.14+ whole stacks of items will automatically be placed , so there might be some left over
      }
    }
  }

  /** Bedrock: the trade request (upstream: putAway(2) of the server's result slot) */
  async function takeOutput (window, Trade) {
    const model = bot._bedrock.inventoryModel
    const output = model.cloneItem(Trade.outputItem, Trade.outputItem.count, null)
    const steps = [
      { type: 'raw', action: { type_id: 'craft_recipe', recipe_network_id: Trade.bedrock.netId, times_crafted: 1 } },
      { type: 'consume', count: Trade.realPrice, src: model.keyOf(window, 0) }
    ]
    if (Trade.hasItem2) steps.push({ type: 'consume', count: Trade.inputItem2.count, src: model.keyOf(window, 1) })
    const placed = resultSteps(model, window, output)
    steps.push(...placed.steps)
    await runStation(bot, window, steps, { what: 'trade' })
    if (placed.rest > 0) await bot.putSelectedItemRange(window.inventoryStart, window.inventoryEnd, window, null)
  }

  async function putRequirements (window, Trade) {
    const [slot1, slot2] = window.slots
    const { type: type1 } = Trade.inputItem1
    const metadata1 = inputMetadata(Trade, 1)

    const input1 = slot1
      ? Math.max(0, Trade.realPrice - slot1.count)
      : Trade.realPrice
    if (input1) {
      await deposit(window, type1, metadata1, input1, 0)
    }
    if (Trade.hasItem2) {
      const { count: tradeCount2, type: type2 } = Trade.inputItem2
      const metadata2 = inputMetadata(Trade, 2)

      const input2 = slot2
        ? Math.max(0, tradeCount2 - slot2.count)
        : tradeCount2
      if (input2) {
        await deposit(window, type2, metadata2, input2, 1)
      }
    }
  }

  async function deposit (window, itemType, metadata, count, slot) {
    const options = {
      window,
      itemType,
      metadata,
      count,
      sourceStart: window.inventoryStart,
      sourceEnd: window.inventoryEnd,
      destStart: slot,
      destEnd: slot + 1
    }
    await bot.transfer(options)
  }

  bot.openVillager = openVillager
  bot.trade = trade
}

module.exports.TRADER_NAMES = TRADER_NAMES
