// owner: U13 (stations)
// Adapted from mineflayer 4.39.0 lib/plugins/furnace.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): openFurnace, the window members and the fuel / progress
// normalisation are kept verbatim; the window properties come from Bedrock's container_set_data.
// Surface: bot.openFurnace(furnaceBlock) → Promise<Furnace> (window + fuel, progress, totalFuel, fuelSeconds,
//   totalFuelSeconds, totalProgress, progressSeconds, totalProgressSeconds, takeInput, takeFuel, takeOutput, putInput,
//   putFuel, inputItem, fuelItem, outputItem; event 'update')
// Bedrock (BDS 1.26.51.1): furnace / blast_furnace / smoker windows (lib/bedrock/windows.js: ingredient 0, fuel 1,
//   output 2, item stack requests through bot.transfer / bot.putAway). The block's state arrives as
//   container_set_data { window_id, property, value } — BEFORE its container_open, then every tick while it burns:
//     0 tick count (cook progress, counts up)  → Java property 2 (current progress)
//     1 lit time (fuel left, counts down)      → Java property 0 (current fuel)
//     2 lit duration (burn time of the fuel)   → Java property 1 (total fuel)
//     3 stored xp, 4 fuel aux                  → no Java counterpart ('update' only)
//   There is no "total cook time" property: it is the block's constant (furnace 200 ticks, blast furnace and
//   smoker 100), set at open like Java's property 3. Smelting is server side; the output arrives as inventory_slot.
'use strict'
const assert = require('assert')
const { windowIdOf } = require('../bedrock/inventory_model')
const { closeCurrentWindow, onWindowGone } = require('../bedrock/stations')

module.exports = inject

/** Bedrock container_set_data property → Java furnace window property */
const BEDROCK_TO_JAVA = { 0: 2, 1: 0, 2: 1 }
/** cook time (ticks) of each furnace-like block: Java's property 3, not sent by Bedrock */
const TOTAL_COOK_TICKS = {
  'minecraft:furnace': 200,
  'minecraft:blast_furnace': 100,
  'minecraft:smoker': 100
}

function inject (bot) {
  const allowedWindowTypes = ['minecraft:furnace', 'minecraft:blast_furnace', 'minecraft:smoker']

  // container_set_data arrives before the container_open of the window it belongs to: keep the latest values
  // per window id until that window closes
  const windowData = new Map()
  bot._client.on('container_set_data', (packet) => {
    const id = windowIdOf(packet.window_id)
    if (id === null) return
    let data = windowData.get(id)
    if (!data) windowData.set(id, data = new Map())
    data.set(packet.property, packet.value)
  })
  bot._client.on('container_close', (packet) => windowData.delete(windowIdOf(packet.window_id)))

  function matchWindowType (window) {
    for (const type of allowedWindowTypes) {
      if (window.type.startsWith(type)) return true
    }
    return false
  }

  async function openFurnace (furnaceBlock) {
    await closeCurrentWindow(bot)
    const furnace = await bot.openBlock(furnaceBlock)
    if (!matchWindowType(furnace)) {
      throw new Error('This is not a furnace-like window')
    }

    furnace.totalFuel = null
    furnace.fuel = null
    furnace.fuelSeconds = null
    furnace.totalProgress = null
    furnace.progress = null
    furnace.progressSeconds = null
    furnace.takeInput = takeInput
    furnace.takeFuel = takeFuel
    furnace.takeOutput = takeOutput
    furnace.putInput = putInput
    furnace.putFuel = putFuel
    furnace.inputItem = function () { return this.slots[0] }
    furnace.fuelItem = function () { return this.slots[1] }
    furnace.outputItem = function () { return this.slots[2] }

    // raw current fuel / progress: BDS sends a new fuel's lit time before its lit duration in the same tick, so
    // both are normalised again when their total changes
    let rawFuel = null
    let rawProgress = null

    // Java's property 3 (total progress) is the block's constant on Bedrock; the values received before the
    // window opened are applied in Java's property order (totals first)
    const totalCook = TOTAL_COOK_TICKS[allowedWindowTypes.find(t => furnace.type.startsWith(t))]
    applyProperty(3, totalCook)
    const early = windowData.get(furnace.id)
    if (early) {
      for (const javaProperty of [1, 0, 2]) {
        const bedrockProperty = Number(Object.keys(BEDROCK_TO_JAVA).find(k => BEDROCK_TO_JAVA[k] === javaProperty))
        if (early.has(bedrockProperty)) applyProperty(javaProperty, early.get(bedrockProperty))
      }
    }

    bot._client.on('container_set_data', onUpdateWindowProperty)
    onWindowGone(bot, furnace, () => {
      bot._client.removeListener('container_set_data', onUpdateWindowProperty)
    })

    return furnace

    function onUpdateWindowProperty (packet) {
      if (windowIdOf(packet.window_id) !== furnace.id) return
      const javaProperty = BEDROCK_TO_JAVA[packet.property]
      if (javaProperty !== undefined) applyProperty(javaProperty, packet.value)
      furnace.emit('update')
    }

    function applyProperty (property, value) {
      switch (property) {
        case 0: // Current fuel
          rawFuel = value
          furnace.fuel = 0
          furnace.fuelSeconds = 0
          if (furnace.totalFuel) {
            furnace.fuel = value / furnace.totalFuel
            furnace.fuelSeconds = furnace.fuel * furnace.totalFuelSeconds
          }
          break
        case 1: // Total fuel
          furnace.totalFuel = value
          furnace.totalFuelSeconds = ticksToSeconds(furnace.totalFuel)
          if (rawFuel !== null) applyProperty(0, rawFuel)
          break
        case 2: // Current progress
          rawProgress = value
          furnace.progress = 0
          furnace.progressSeconds = 0
          if (furnace.totalProgress) {
            furnace.progress = value / furnace.totalProgress
            furnace.progressSeconds = furnace.totalProgressSeconds - (furnace.progress * furnace.totalProgressSeconds)
          }
          break
        case 3: // Total progress
          furnace.totalProgress = value
          furnace.totalProgressSeconds = ticksToSeconds(furnace.totalProgress)
          if (rawProgress !== null) applyProperty(2, rawProgress)
      }
    }

    async function takeSomething (item) {
      assert.ok(item)
      await bot.putAway(item.slot)
      return item
    }

    async function takeInput () {
      return takeSomething(furnace.inputItem())
    }

    async function takeFuel () {
      return takeSomething(furnace.fuelItem())
    }

    async function takeOutput () {
      return takeSomething(furnace.outputItem())
    }

    async function putSomething (destSlot, itemType, metadata, count) {
      const options = {
        window: furnace,
        itemType,
        metadata,
        count,
        sourceStart: furnace.inventoryStart,
        sourceEnd: furnace.inventoryEnd,
        destStart: destSlot,
        destEnd: destSlot + 1
      }
      await bot.transfer(options)
    }

    async function putInput (itemType, metadata, count) {
      await putSomething(0, itemType, metadata, count)
    }

    async function putFuel (itemType, metadata, count) {
      await putSomething(1, itemType, metadata, count)
    }
  }

  function ticksToSeconds (ticks) {
    return ticks * 0.05
  }

  bot.openFurnace = openFurnace
}

module.exports.BEDROCK_TO_JAVA = BEDROCK_TO_JAVA
module.exports.TOTAL_COOK_TICKS = TOTAL_COOK_TICKS
