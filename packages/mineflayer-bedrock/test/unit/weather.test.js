'use strict'
// owner: U9 (player state, world extras & dimensions) — rain.js and time.js on the recorded BDS join (start_game
// rain level, the `/weather rain|clear` level_events, sync_world_clocks of `/time set`) + synthesized packets
const assert = require('assert')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')

describe('weather and time (U9)', function () {
  this.timeout(30000)

  it('internalTest › rain › flips isRaining on rain level zero-crossings without start_raining', async () => {
    const { bot, client } = await createFakeBot()
    const rain = []
    const updates = []
    bot.on('rain', () => rain.push(bot.isRaining))
    bot.on('weatherUpdate', () => updates.push([bot.rainState, bot.thunderState]))
    await replayJoin(bot, client)
    // the fixture world was raining at join: start_game.rain_level 1, like Java's join packets → rain + levels
    assert.strictEqual(bot.isRaining, true)
    assert.strictEqual(bot.rainState, 1)
    assert.deepStrictEqual(rain, [true])
    rain.length = 0
    updates.length = 0

    // the capture's /weather rain + /weather clear
    for (const { name, params } of afterSpawnRecords()) {
      if (name === 'level_event' && /rain|thunder/.test(params.event)) client.receive(name, params)
    }
    assert.deepStrictEqual(rain, [false], 'start_rain while raining: no second rain event; stop_rain: one')
    assert.strictEqual(bot.isRaining, false)
    assert.strictEqual(bot.rainState, 0)

    // thunder levels (data = level × 65535) without a rain change
    updates.length = 0
    client.receive('level_event', { event: 'start_thunder', position: { x: 0, y: 0, z: 0 }, data: 32767 })
    assert.ok(Math.abs(bot.thunderState - 0.5) < 1e-4)
    assert.strictEqual(bot.isRaining, false)
    client.receive('level_event', { event: 'start_rain', position: { x: 0, y: 0, z: 0 }, data: 65535 })
    client.receive('level_event', { event: 'stop_thunder', position: { x: 0, y: 0, z: 0 }, data: 0 })
    client.receive('level_event', { event: 'stop_rain', position: { x: 0, y: 0, z: 0 }, data: 0 })
    assert.deepStrictEqual(rain, [false, true, false])
    assert.deepStrictEqual(updates.map(([r, t]) => [r, Math.round(t * 100) / 100]), [[0, 0.5], [1, 0.5], [1, 0], [0, 0]])
  })

  it('start_game without rain: no rain event, levels 0', async () => {
    const { bot, client } = await createFakeBot()
    let rains = 0
    bot.on('rain', () => rains++)
    await replayJoin(bot, client, { until: (name) => name === 'start_game' })
    client.receive('start_game', { ...require('../fixtures').load('join_flat').first('start_game'), rain_level: 0, lightning_level: 0 })
    assert.deepStrictEqual([bot.isRaining, bot.rainState, bot.thunderState, rains], [false, 0, 0, 0])
  })

  it('time: world clock of sync_world_clocks, doDaylightCycle game rule, derived fields, time event', async () => {
    const { bot, client, clock } = await createFakeBot()
    const times = []
    bot.on('time', () => times.push(bot.time.time))
    await replayJoin(bot, client)
    // join: sync_state 32063 (before the registry and start_game), registry 32063
    assert.strictEqual(bot.time.time, 32063)
    assert.strictEqual(bot.time.bigTime, 32063n)
    assert.strictEqual(bot.time.timeOfDay, 32063 % 24000)
    assert.strictEqual(bot.time.day, 1)
    assert.strictEqual(bot.time.isDay, true)
    assert.strictEqual(bot.time.moonPhase, 1)
    assert.strictEqual(bot.time.doDaylightCycle, true)
    assert.strictEqual(typeof bot.time.bigAge, 'bigint')
    assert.ok(bot.time.bigAge >= 57846n, 'the server tick (start_game.current_tick)')
    assert.strictEqual(bot.time.age, Number(bot.time.bigAge))
    assert.ok(times.length >= 1, "'time' once start_game is known")
    const overworld = bot.time.clocks.overworld
    assert.strictEqual(overworld.name, 'minecraft:overworld')
    assert.strictEqual(overworld.id, 7194480507151251734n)
    assert.deepStrictEqual(overworld.timeMarkers.map(m => m.name).sort(), ['minecraft:day', 'minecraft:midnight', 'minecraft:night', 'minecraft:noon', 'minecraft:sunrise', 'minecraft:sunset'])

    // the capture's /time set 1000 (client command) and /time set 6000
    times.length = 0
    for (const { name, params } of afterSpawnRecords()) {
      if (name === 'sync_world_clocks') client.receive(name, params)
    }
    assert.deepStrictEqual(times, [1001, 6001, 6024])
    assert.strictEqual(bot.time.day, 0)

    // the clock runs with the server tick while doDaylightCycle is on
    clock.advance(1000)
    bot.emit('physicsTick') // refreshed every 20 physics ticks; force a refresh through the game rule path instead
    client.receive('game_rules_changed', { rules: [{ name: 'doDayLightCycle', editable: true, type: 'bool', value: false }] })
    assert.strictEqual(bot.time.doDaylightCycle, false)
    assert.strictEqual(bot.time.time, 6024 + 20, '20 ticks elapsed before the cycle stopped')
    const frozen = bot.time.time
    clock.advance(5000)
    client.receive('sync_world_clocks', { payload_type: 'sync_state', sync_states: [{ clock_id: 7194480507151251734n, time: 18000, paused: false }] })
    assert.strictEqual(bot.time.time, 18000)
    assert.strictEqual(bot.time.isDay, false)
    clock.advance(5000)
    for (let i = 0; i < 20; i++) bot.emit('physicsTick')
    assert.strictEqual(bot.time.time, 18000, `frozen (was ${frozen})`)
    assert.strictEqual(times[times.length - 1], 18000, 'periodic time event every 20 physics ticks')
  })
})
