// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/time.js — VERBATIM test body (only the promise_utils require path
 * changes). Bedrock: world time from sync_world_clocks, doDaylightCycle from the doDayLightCycle game rule
 * (`/gamerule doDaylightCycle …` is case-insensitive on BDS; gameRuleUsesResourceLocation is false).
 * Extra Bedrock checks: the world clock registry (bot.time.clocks) and the local clock run.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  // Test time properties and ranges
  const timeProps = {
    doDaylightCycle: 'boolean',
    bigTime: 'bigint',
    time: 'number',
    timeOfDay: 'number',
    day: 'number',
    isDay: 'boolean',
    moonPhase: 'number',
    bigAge: 'bigint',
    age: 'number'
  }

  // Verify all properties exist and have correct types
  Object.entries(timeProps).forEach(([prop, type]) => {
    assert.strictEqual(typeof bot.time[prop], type, `Property ${prop} should be of type ${type}`)
  })

  // Verify ranges
  assert(bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 24000, 'timeOfDay should be between 0 and 24000')
  assert(bot.time.moonPhase >= 0 && bot.time.moonPhase < 8, 'moonPhase should be between 0 and 7')
  assert(bot.time.day >= 0, 'day should be non-negative')
  assert(bot.time.age >= 0, 'age should be non-negative')
  assert(bot.time.bigAge >= 0n, 'bigAge should be non-negative')

  // Helper functions
  const isTimeClose = (current, target) => Math.abs(current - target) < 510
  // update_time is the only carrier of world time and doDaylightCycle, and
  // vanilla broadcasts it once every 20 ticks, so each wait costs a full tick
  // interval on servers that do not echo commands.
  const waitForTimeState = async (matches) =>
    onceWithCleanup(bot, 'time', { timeout: 5000, checkCondition: matches })

  // The gamerule is renamed on versions with gameRuleUsesResourceLocation.
  const sendSetDaylightCycleCommand = (value) => {
    if (bot.supportFeature('gameRuleUsesResourceLocation')) {
      bot.test.sayEverywhere(`/gamerule minecraft:advance_time ${value}`)
    } else {
      bot.test.sayEverywhere(`/gamerule doDaylightCycle ${value}`)
    }
  }

  // Disable daylight cycle before time transition tests to prevent
  // time from drifting between /time set and the assertion
  const originalDaylightCycle = bot.time.doDaylightCycle

  // Night with the cycle off: covers isDay false and doDaylightCycle false.
  sendSetDaylightCycleCommand(false)
  bot.test.sayEverywhere('/time set 18000')
  await waitForTimeState(() => isTimeClose(bot.time.timeOfDay, 18000))
  assert(isTimeClose(bot.time.timeOfDay, 18000), `Expected time to be close to 18000, got ${bot.time.timeOfDay}`)
  assert.strictEqual(bot.time.isDay, false, 'midnight should be night')
  assert.strictEqual(bot.time.doDaylightCycle, false)

  // 12000 is the last tick that still counts as day.
  bot.test.sayEverywhere('/time set 12000')
  await waitForTimeState(() => isTimeClose(bot.time.timeOfDay, 12000))
  assert(isTimeClose(bot.time.timeOfDay, 12000), `Expected time to be close to 12000, got ${bot.time.timeOfDay}`)
  assert.strictEqual(bot.time.isDay, true, 'sunset should be day')

  // Day and moon phase progression, and doDaylightCycle true.
  // Must be read before the commands below mutate them.
  const currentDay = bot.time.day
  const currentPhase = bot.time.moonPhase
  sendSetDaylightCycleCommand(true)
  bot.test.sayEverywhere('/time add 24000')
  await waitForTimeState(() => bot.time.day >= currentDay + 1)
  assert(bot.time.day >= currentDay + 1, `Expected day to be at least ${currentDay + 1}, got ${bot.time.day}`)
  assert.notStrictEqual(bot.time.moonPhase, currentPhase, 'Moon phase should change after a full day')
  assert.strictEqual(bot.time.doDaylightCycle, true)

  // Restore for later tests; the server applies it without the client waiting.
  sendSetDaylightCycleCommand(originalDaylightCycle)
}

describe('time', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('time', async () => {
    await upstream()(ctx.bot)
  })

  it('time: Bedrock world clock registry, local clock run, age from the server tick (Bedrock extra)', async () => {
    const { bot } = ctx
    const overworld = bot.time.clocks.overworld
    assert.ok(overworld, `clocks: ${Object.keys(bot.time.clocks)}`)
    assert.strictEqual(overworld.name, 'minecraft:overworld')
    assert.strictEqual(typeof overworld.id, 'bigint')
    assert.ok(overworld.timeMarkers.some(m => m.name === 'minecraft:midnight' && m.time === 18000), 'time markers')

    // the harness profile turns the daylight cycle off: the time stands still, 'time' still comes every 20 ticks
    await bot.test.botCommand('/gamerule doDaylightCycle false')
    await bot.test.botCommand('/time set 1000')
    await onceWithCleanup(bot, 'time', { timeout: 5000, checkCondition: () => bot.time.time === 1000 && bot.time.doDaylightCycle === false })
    const ageBefore = bot.time.age
    await onceWithCleanup(bot, 'time', { timeout: 5000 }) // a periodic one
    await onceWithCleanup(bot, 'time', { timeout: 5000 })
    assert.strictEqual(bot.time.time, 1000, 'frozen clock')
    assert.ok(bot.time.age >= ageBefore + 20, `age runs with the server tick: ${ageBefore} → ${bot.time.age}`)
    assert.strictEqual(bot.time.bigAge, BigInt(bot.time.age))

    // with the cycle on, the clock runs locally between the server's syncs (20 ticks per second)
    await bot.test.botCommand('/gamerule doDaylightCycle true')
    await onceWithCleanup(bot, 'time', { timeout: 5000, checkCondition: () => bot.time.doDaylightCycle === true })
    const t0 = bot.time.time
    const started = Date.now()
    await new Promise(resolve => setTimeout(resolve, 2000))
    await onceWithCleanup(bot, 'time', { timeout: 5000 })
    const elapsedTicks = (Date.now() - started) / 50
    assert.ok(bot.time.time - t0 >= elapsedTicks * 0.7 && bot.time.time - t0 <= elapsedTicks * 1.3 + 25,
      `ran ${bot.time.time - t0} ticks in ~${elapsedTicks.toFixed(0)}`)
    await bot.test.botCommand('/gamerule doDaylightCycle false')
  })
})
