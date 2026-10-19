// owner: U17 (agent core & overworld milestones)
'use strict'
/**
 * Smelting with `bot.openFurnace`: a furnace nearby, or the carried one placed next to the bot (taken back afterwards).
 * Furnace recipes and fuel values come from src/data (BDS sends no furnace recipes).
 *
 * The furnace window is only open to load and to unload it: the furnace smelts on its own meanwhile (the bot waits
 * next to it), so a safety behaviour that closes the window (a fight, a meal) costs nothing — the furnace is opened
 * again afterwards. Big batches (≥ 12 items) are split over up to 3 furnaces (extra ones crafted from carried
 * cobblestone when there is enough): 25 raw iron take ~90 s instead of ~250 s.
 *
 * Skill `smelt` — args: { item, count?: 1, input?, fuel?, furnaces?: 3 }   (`item` = the output, e.g. 'iron_ingot';
 *                 `count` more of it)
 *                 result: { smelted: { [item]: n }, input, fuel, furnace: 'nearby'|'placed', furnaces }
 */
const { SkillError, checkAbort, isAbort } = require('../errors')
const { defineSkill, log, progress, sleep, heartbeat, agentOf } = require('../skill')
const inventory = require('../inventory')
const data = require('../data')
const stations = require('../stations')

/** cooking time of one item in a furnace (ms) */
const ITEM_MS = 10000

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
 * A furnace transfer, retried twice: now and then BDS rejects the stack request of a click into a furnace that was
 * placed a moment ago (it works a few ticks later). A retry recomputes what is still missing (the callback reads the
 * furnace again).
 */
async function retry (bot, fn, signal) {
  for (let i = 0; ; i++) {
    try {
      return await fn()
    } catch (err) {
      if (i >= 2 || !/rejected|didn't respond/i.test(err.message)) throw err
      log(bot, `furnace: ${err.message}; retrying`)
      await sleep(600, signal)
    }
  }
}

/**
 * Open the furnace `f.block`, run `fn(furnace)`, close it. The bot walks back within reach first; a safety
 * behaviour that took the controls (and closed the window) in the middle → wait for it, then once more (3 tries).
 */
async function withFurnace (bot, f, fn, signal) {
  const navigate = require('./navigate')
  const { goals } = require('mineflayer-pathfinder')
  const safety = agentOf(bot)?.safety
  let lastErr = null
  for (let attempt = 0; attempt < 3; attempt++) {
    checkAbort(signal)
    await safety?.idle(signal)
    const block = bot.blockAt(f.block.position)
    if (!block || !stations.STATION_BLOCKS.furnace.includes(block.name)) throw new SkillError(`the furnace at ${navigate.fmt(f.block.position)} is gone`, { code: 'FAILED' })
    if (bot.entity.position.offset(0, bot.entity.eyeHeight ?? 1.62, 0).distanceTo(block.position.offset(0.5, 0.5, 0.5)) > 4.2) {
      await navigate.goto(bot, new goals.GoalLookAtBlock(block.position, bot.world, { reach: 4 }), { signal, timeout: 30000, attempts: 2 })
    }
    let furnace = null
    try {
      furnace = await bot.openFurnace(block)
      const r = await fn(furnace)
      return r
    } catch (err) {
      if (isAbort(err)) throw err
      lastErr = err
      const interrupted = safety?.busy || safety?.recentlyBusy?.(2000) || (furnace && bot.currentWindow !== furnace)
      if (!interrupted && !/rejected|didn't respond|closed|window/i.test(err.message)) throw err
      log(bot, `furnace: ${err.message}${interrupted ? ' (interrupted)' : ''}; opening it again`)
    } finally {
      try { if (furnace && bot.currentWindow === furnace) furnace.close() } catch {}
    }
  }
  throw lastErr
}

/** split `n` items over `k` furnaces as evenly as possible */
function split (n, k) {
  const out = []
  for (let i = 0; i < k; i++) out.push(Math.floor(n / k) + (i < n % k ? 1 : 0))
  return out.filter((x) => x > 0)
}

/** fuel items for `parts` (one entry per furnace) */
function fuelFor (parts, perFuel) {
  return parts.reduce((s, x) => s + Math.ceil(x / perFuel), 0)
}

/**
 * Up to `want` furnaces next to the bot: the first one nearby or placed (stations.ensureStation), more ones placed
 * from the inventory (crafted from cobblestone / cobbled deepslate when 8 spare are carried). @returns {Promise<object[]>}
 */
async function furnacesFor (bot, want, { signal, input, inputCount = 0 }) {
  const first = await stations.ensureStation(bot, 'furnace', { signal })
  const out = [first]
  for (let k = 1; k < want; k++) {
    try {
      if (!inventory.count(bot, 'furnace')) {
        // never from the stone being smelted; keep a few for pillars and the house
        const stone = ['cobblestone', 'cobbled_deepslate'].map((n) => inventory.count(bot, n) - (n === input ? inputCount : 0))
        if (Math.max(...stone) < 16) break
        await require('./craft').craftItem(bot, 'furnace', 1, { signal })
      }
      const taken = out.map((f) => f.block.position)
      const block = await stations.placeNear(bot, 'furnace', { signal, avoid: (p) => taken.some((q) => q.equals(p)) })
      out.push({ block, placed: true })
    } catch (err) {
      if (isAbort(err)) throw err
      log(bot, `smelt: no extra furnace (${err.message})`)
      break
    }
  }
  return out
}

/**
 * Smelt until the bot has `count` more `item`s (or the input / fuel ran out).
 * @param {object} bot
 * @param {{ item: string, count?: number, input?: string, fuel?: string, signal?: AbortSignal, keepFurnace?: boolean,
 *   furnaces?: number }} opts
 */
async function smeltItem (bot, { item, count = 1, input, fuel, signal, keepFurnace = false, furnaces: maxFurnaces = 3 }) {
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
  const fuelCarried = inventory.count(bot, fuelName) - (fuelName === source.input ? n : 0)
  // how many furnaces: ~8 items each, and the fuel must cover every furnace's share
  let want = n >= 12 ? Math.min(maxFurnaces, Math.ceil(n / 8)) : 1
  while (want > 1 && fuelFor(split(n, want), perFuel) > fuelCarried) want--
  const list = await furnacesFor(bot, want, { signal, input: source.input, inputCount: n })
  const parts = split(n, list.length)
  const placed = list.filter((f) => f.placed)
  let fuelPut = 0
  try {
    // load every furnace (and empty what another job left in it)
    for (let i = 0; i < list.length; i++) {
      const share = parts[i] ?? 0
      list[i].share = share
      await withFurnace(bot, list[i], async (furnace) => {
        if (furnace.outputItem()) await retry(bot, () => furnace.outputItem() ? furnace.takeOutput() : null, signal)
        if (furnace.inputItem() && furnace.inputItem().name !== source.input) await retry(bot, () => furnace.inputItem() ? furnace.takeInput() : null, signal)
        if (furnace.fuelItem() && furnace.fuelItem().name !== fuelName) await retry(bot, () => furnace.fuelItem() ? furnace.takeFuel() : null, signal)
        const want = () => Math.min(Math.max(0, share - (furnace.inputItem()?.count ?? 0)), inventory.count(bot, source.input))
        if (want() > 0) await retry(bot, () => want() > 0 ? furnace.putInput(reg.itemsByName[source.input].id, null, want()) : null, signal)
        const inside = furnace.inputItem()?.count ?? 0
        const fuelNeed = () => Math.max(0, Math.ceil(inside / perFuel) - (furnace.fuelItem()?.count ?? 0))
        // the inputs are in the furnace already: what is left of the fuel item is all fuel (also when fuel = input)
        const put = () => Math.min(fuelNeed(), inventory.count(bot, fuelName))
        if (put() > 0) {
          const k = put()
          await retry(bot, () => put() > 0 ? furnace.putFuel(reg.itemsByName[fuelName].id, null, put()) : null, signal)
          fuelPut += k
        }
      }, signal)
    }
    log(bot, `smelting ${n} ${source.input} → ${item} with ${fuelPut} ${fuelName} in ${list.length} furnace(s) (${placed.length} placed)`)
    // wait next to the furnaces, unload them when they should be done; again while input is left
    const deadline = Date.now() + Math.max(...parts) * ITEM_MS + 40000
    let doneAt = Date.now() + Math.max(...parts) * ITEM_MS + 1000
    for (;;) {
      checkAbort(signal)
      if (Date.now() < doneAt && Date.now() < deadline) {
        heartbeat(bot)
        await sleep(1000, signal)
        continue
      }
      // the longest queue still burning; furnaces out of fuel with input left get any fuel carried
      let left = 0
      for (const f of list) {
        await withFurnace(bot, f, async (furnace) => {
          if (furnace.outputItem()) await retry(bot, () => furnace.outputItem() ? furnace.takeOutput() : null, signal)
          const inside = furnace.inputItem()?.count ?? 0
          if (inside && !furnace.fuelItem() && !furnace.fuel) {
            const more = chooseFuel(bot, { input: source.input, inputCount: 0 })
            if (!more) return // stalled: nothing left to burn
            await retry(bot, () => furnace.putFuel(reg.itemsByName[more].id, null, Math.min(inventory.count(bot, more), Math.ceil(inside / data.itemsPerFuel(more)))), signal)
          }
          left = Math.max(left, inside)
        }, signal).catch((err) => {
          if (isAbort(err)) throw err
          log(bot, `smelt: ${err.message}`)
        })
      }
      if (!left || Date.now() >= deadline) break
      doneAt = Date.now() + left * ITEM_MS + 1000
    }
    // leave nothing behind in a furnace we take with us
    for (const f of list) {
      if (keepFurnace && !f.placed) continue
      await withFurnace(bot, f, async (furnace) => {
        if (furnace.outputItem()) await furnace.takeOutput().catch(() => {})
        if (furnace.inputItem()) await furnace.takeInput().catch(() => {})
        if (f.placed && furnace.fuelItem()) await furnace.takeFuel().catch(() => {})
      }, signal).catch((err) => { if (isAbort(err)) throw err })
    }
  } finally {
    try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow) } catch {}
    // an aborted / timed-out smelt leaves the furnaces: the next task must not fight over the controls
    if (!keepFurnace && !signal?.aborted) {
      for (const f of placed) await stations.pickUp(bot, f.block, { signal }).catch(() => {})
    }
  }
  const smelted = inventory.count(bot, item) - start
  if (smelted <= 0) throw new SkillError(`the furnace produced no ${item}`, { code: 'FAILED' })
  progress(bot, 'smelt', { item, count: smelted, input: source.input, fuel: fuelName, furnaces: list.length })
  return { smelted: { [item]: smelted }, input: source.input, fuel: fuelName, furnace: list[0].placed ? 'placed' : 'nearby', furnaces: list.length }
}

const smelt = defineSkill('smelt', async (bot, args) => {
  if (!args.item) throw new SkillError('smelt needs args.item (the output)', { code: 'FAILED' })
  return smeltItem(bot, { ...args, count: args.count ?? 1 })
}, { description: 'smelt items in a furnace (placing the carried one if none is nearby)' })

module.exports = Object.assign(smelt, { smeltItem, chooseFuel, split, fuelFor })
