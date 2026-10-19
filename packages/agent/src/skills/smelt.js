// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Smelting with `bot.openFurnace`: a furnace nearby, or the carried one placed next to the bot (taken back afterwards).
 * Furnace recipes and fuel values come from src/data (BDS sends no furnace recipes).
 *
 * Skill `smelt` — args: { item, count?: 1, input?, fuel? }   (`item` = the output, e.g. 'iron_ingot'; `count` more of it)
 *                 result: { smelted: { [item]: n }, input, fuel, furnace: 'nearby'|'placed' }
 */
const { SkillError, checkAbort } = require('../errors')
const { defineSkill, log, progress, sleep } = require('../skill')
const inventory = require('../inventory')
const data = require('../data')
const stations = require('../stations')

/** the fuel to burn: given, else the carried one that smelts the most (never the input itself when short) */
function chooseFuel (bot, { fuel, input, inputCount }) {
  if (fuel) return fuel
  let best = null
  let bestItems = 0
  for (const name of data.FUEL_CANDIDATES) {
    let have = inventory.count(bot, name)
    if (name === input) have -= inputCount
    const items = have * data.itemsPerFuel(name)
    if (have > 0 && items > bestItems) { best = name; bestItems = items }
  }
  return best
}

/**
 * Smelt until the bot has `count` more `item`s (or the input / fuel ran out).
 * @param {object} bot
 * @param {{ item: string, count?: number, input?: string, fuel?: string, signal?: AbortSignal, keepFurnace?: boolean }} opts
 */
async function smeltItem (bot, { item, count = 1, input, fuel, signal, keepFurnace = false }) {
  const sources = data.smeltingSources(item)
  if (!sources.length) throw new SkillError(`${item} is not a furnace product`, { code: 'NO_PLAN' })
  const source = input ? sources.find((s) => s.input === input) : sources.slice().sort((a, b) => inventory.count(bot, b.input) - inventory.count(bot, a.input))[0]
  if (!source || inventory.count(bot, source.input) === 0) throw new SkillError(`nothing to smelt into ${item} (needs ${sources.map((s) => s.input).join(' / ')})`, { code: 'MISSING' })
  const n = Math.min(Math.ceil(count / source.count), inventory.count(bot, source.input))
  const fuelName = chooseFuel(bot, { fuel, input: source.input, inputCount: n })
  if (!fuelName || inventory.count(bot, fuelName) === 0) throw new SkillError(`no fuel to smelt ${source.input}`, { code: 'MISSING' })
  const perFuel = data.itemsPerFuel(fuelName)
  const reg = bot.registry
  const start = inventory.count(bot, item)
  const st = await stations.ensureStation(bot, 'furnace', { signal })
  let furnace = null
  try {
    furnace = await bot.openFurnace(st.block)
    if (furnace.outputItem()) await furnace.takeOutput()
    if (furnace.inputItem() && furnace.inputItem().name !== source.input) await furnace.takeInput()
    if (furnace.fuelItem() && furnace.fuelItem().name !== fuelName) await furnace.takeFuel()
    const already = furnace.inputItem()?.count ?? 0
    const put = Math.max(0, n - already)
    if (put > 0) await furnace.putInput(reg.itemsByName[source.input].id, null, put)
    const fuelHave = furnace.fuelItem()?.count ?? 0
    const fuelNeed = Math.max(0, Math.ceil(n / perFuel) - fuelHave)
    const fuelPut = Math.min(fuelNeed, inventory.count(bot, fuelName) - (fuelName === source.input ? n : 0))
    if (fuelPut > 0) await furnace.putFuel(reg.itemsByName[fuelName].id, null, fuelPut)
    log(bot, `smelting ${n} ${source.input} → ${item} with ${fuelPut} ${fuelName} (${st.placed ? 'placed' : 'nearby'} furnace)`)
    const deadline = Date.now() + n * 10000 + 20000
    let taken = 0
    while (taken < n * source.count && Date.now() < deadline) {
      checkAbort(signal)
      await sleep(1000, signal)
      const out = furnace.outputItem()
      if (out && (out.count >= Math.min(8, n * source.count - taken) || !furnace.inputItem())) {
        await furnace.takeOutput()
        taken = inventory.count(bot, item) - start
      }
      if (!furnace.inputItem() && !furnace.outputItem()) break
      if (!furnace.fuelItem() && furnace.fuel === 0 && furnace.inputItem()) {
        // out of fuel with input left: add more of any fuel carried
        const more = chooseFuel(bot, { input: source.input, inputCount: furnace.inputItem().count })
        if (!more) break
        await furnace.putFuel(reg.itemsByName[more].id, null, Math.min(inventory.count(bot, more), Math.ceil(furnace.inputItem().count / data.itemsPerFuel(more))))
      }
    }
    if (furnace.outputItem()) await furnace.takeOutput()
    if (!keepFurnace || st.placed) {
      // leave nothing behind in a furnace we take with us
      if (furnace.inputItem()) await furnace.takeInput().catch(() => {})
      if (st.placed && furnace.fuelItem()) await furnace.takeFuel().catch(() => {})
    }
  } finally {
    try { furnace?.close() } catch {}
    if (st.placed && !keepFurnace) await stations.pickUp(bot, st.block)
  }
  const smelted = inventory.count(bot, item) - start
  progress(bot, 'smelt', { item, count: smelted, input: source.input, fuel: fuelName })
  if (smelted <= 0) throw new SkillError(`the furnace produced no ${item}`, { code: 'FAILED' })
  return { smelted: { [item]: smelted }, input: source.input, fuel: fuelName, furnace: st.placed ? 'placed' : 'nearby' }
}

const smelt = defineSkill('smelt', async (bot, args) => {
  if (!args.item) throw new SkillError('smelt needs args.item (the output)', { code: 'FAILED' })
  return smeltItem(bot, { ...args, count: args.count ?? 1 })
}, { description: 'smelt items in a furnace (placing the carried one if none is nearby)' })

module.exports = Object.assign(smelt, { smeltItem, chooseFuel })
