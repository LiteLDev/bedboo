// owner: U9 (player state, world extras & dimensions)
// Adapted from mineflayer 4.39.0 lib/plugins/time.js (MIT, Copyright (c) 2013 Andrew Kelley): same bot.time fields
//   and derivations (timeOfDay, day, isDay, moonPhase), 'time' event.
// Surface: bot.time { doDaylightCycle, bigTime, time, timeOfDay, day, isDay, moonPhase, bigAge, age, clocks }
//   (null until the first update)
// Events: 'time'
// Bedrock (docs/differences/U9.md#world-time):
// - BDS 1.26.51 sends NO set_time packet: world time is the `minecraft:overworld` world clock of
//   `sync_world_clocks` (initialize_registry: clocks with id, name, time, paused, time markers; sync_state: id →
//   time, paused — sent before start_game, on /time set|add and now and then). bot.time.time is the clock's time
//   (absolute day time like Java's), in every dimension (Bedrock has one world time).
// - doDaylightCycle is the `doDayLightCycle` game rule (start_game.gamerules, game_rules_changed); a change emits
//   'time' (the Java server re-sends update_time on that change too).
// - bigAge/age: the server tick (start_game.current_tick + elapsed ticks of lib/bedrock/input_queue.js).
// - Between syncs the clock runs locally (one tick per server tick while doDaylightCycle is on and the clock is not
//   paused); like Java's once-per-second update_time, 'time' is emitted every 20 physics ticks.
// - bot.time.clocks: one entry per Bedrock world clock keyed by its name without `minecraft:` (upstream 26.1 shape
//   { id, totalTicks, partialTick, rate } plus the Bedrock `name`, `paused`, `timeMarkers`).
'use strict'

module.exports = inject

const TICKS_PER_DAY = 24000
const EMIT_EVERY_TICKS = 20

function inject (bot) {
  bot.time = {
    doDaylightCycle: null,
    bigTime: null,
    time: null,
    timeOfDay: null,
    day: null,
    isDay: null,
    moonPhase: null,
    bigAge: null,
    age: null,
    clocks: {}
  }

  /** clock id (string) → clock: { id, name, totalTicks, partialTick, rate, paused, timeMarkers, syncTime, syncTick } */
  const clocksById = new Map()
  let daylightRule = null // doDayLightCycle game rule (null until known)
  let synced = false // a world clock time was received
  let ticks = 0

  const serverTick = () => {
    const input = bot._bedrock?.input
    if (!input || !bot._bedrock?.startGame) return null
    try { return input.currentTick() } catch { return null }
  }

  const keyOf = (name) => String(name).replace(/^minecraft:/, '')

  function clockFor (id) {
    const key = String(id)
    let clock = clocksById.get(key)
    if (!clock) {
      clock = { id: BigInt(id), name: undefined, totalTicks: 0, partialTick: 0, rate: 1, paused: false, timeMarkers: [], syncTime: 0, syncTick: null }
      clocksById.set(key, clock)
    }
    return clock
  }

  function running (clock) {
    return !clock.paused && daylightRule !== false
  }

  function setClockTime (clock, time, paused) {
    clock.syncTime = Number(time)
    clock.syncTick = serverTick()
    clock.totalTicks = clock.syncTime
    clock.partialTick = 0
    if (paused !== undefined) clock.paused = !!paused
    clock.rate = running(clock) ? 1 : 0
    synced = true
  }

  /** advance every clock to the current server tick (clock time = synced time + elapsed ticks × rate) */
  function advanceClocks () {
    const now = serverTick()
    for (const clock of clocksById.values()) {
      clock.rate = running(clock) ? 1 : 0
      if (now === null) continue
      if (clock.syncTick === null) {
        clock.syncTick = now
        continue
      }
      if (clock.rate > 0) {
        const elapsed = Number(now - clock.syncTick)
        if (elapsed > 0) clock.totalTicks = clock.syncTime + elapsed
      } else {
        // frozen: keep the current time as the new base
        clock.syncTime = clock.totalTicks
        clock.syncTick = now
      }
    }
  }

  /** the clock driving bot.time: the current dimension's, else the overworld's, else any */
  function mainClock () {
    const byName = (name) => [...clocksById.values()].find(c => c.name && keyOf(c.name) === name)
    return byName(bot.game?.dimension) ?? byName('overworld') ?? clocksById.values().next().value ?? null
  }

  function update () {
    advanceClocks()
    const clock = mainClock()
    if (!clock || !synced) return false
    const time = Math.max(0, Math.floor(clock.totalTicks))
    bot.time.doDaylightCycle = daylightRule ?? true
    bot.time.bigTime = BigInt(time)
    bot.time.time = time
    bot.time.timeOfDay = time % TICKS_PER_DAY
    bot.time.day = Math.floor(time / TICKS_PER_DAY)
    bot.time.isDay = bot.time.timeOfDay >= 0 && bot.time.timeOfDay < 13000
    bot.time.moonPhase = bot.time.day % 8
    const age = serverTick() ?? 0n
    bot.time.bigAge = age < 0n ? 0n : age
    bot.time.age = Number(bot.time.bigAge)
    return true
  }

  function emitTime () {
    // the clocks arrive before start_game (before 'login'): emitted from start_game on
    if (update() && bot._bedrock?.startGame) bot.emit('time')
  }

  bot._client.on('sync_world_clocks', (packet) => {
    switch (packet.payload_type) {
      case 'initialize_registry':
        for (const data of packet.clocks ?? []) {
          const clock = clockFor(data.id)
          clock.name = data.name
          clock.timeMarkers = (data.time_markers ?? []).map(m => ({ id: BigInt(m.id), name: m.name, time: m.time, period: m.period }))
          setClockTime(clock, data.time, data.paused)
          bot.time.clocks[keyOf(data.name)] = clock
        }
        break
      case 'sync_state':
        for (const state of packet.sync_states ?? []) {
          setClockTime(clockFor(state.clock_id), state.time, state.paused)
        }
        break
      case 'add_time_marker': {
        const clock = clockFor(packet.add_clock_id)
        for (const m of packet.add_time_markers ?? []) clock.timeMarkers.push({ id: BigInt(m.id), name: m.name, time: m.time, period: m.period })
        break
      }
      case 'remove_time_marker': {
        const clock = clockFor(packet.remove_clock_id)
        const removed = new Set((packet.remove_time_marker_ids ?? []).map(id => String(id)))
        clock.timeMarkers = clock.timeMarkers.filter(m => !removed.has(String(m.id)))
        break
      }
      default:
        return
    }
    emitTime()
  })

  function daylightFrom (rules) {
    const rule = (rules ?? []).find(r => String(r?.name).toLowerCase() === 'dodaylightcycle')
    return rule === undefined ? undefined : !!rule.value
  }

  bot._client.on('start_game', (packet) => {
    const value = daylightFrom(packet.gamerules)
    if (value !== undefined) daylightRule = value
    // the clocks were synced before start_game (no tick clock yet): restart their local run from now
    for (const clock of clocksById.values()) clock.syncTick = null
    emitTime()
  })

  bot._client.on('game_rules_changed', (packet) => {
    const value = daylightFrom(packet.rules)
    if (value === undefined || value === daylightRule) return
    advanceClocks() // settle the running time with the old rule first
    daylightRule = value
    emitTime()
  })

  // Java servers send update_time once per second: the same cadence locally
  bot.on('physicsTick', () => {
    if (++ticks % EMIT_EVERY_TICKS === 0) emitTime()
  })
}
