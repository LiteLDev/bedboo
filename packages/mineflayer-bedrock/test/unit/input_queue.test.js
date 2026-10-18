'use strict'
// owner: U4 (core runtime) — tick clock + player_auth_input queue (lib/bedrock/input_queue.js)
const assert = require('assert')
const { EventEmitter } = require('events')
const { createInputQueue } = require('../../lib/bedrock/input_queue')
require('../../lib/registry').installDataOverlay()

function setup ({ maxCatchupTicks, start = 10000 } = {}) {
  const clock = { now: start }
  const sent = []
  const bot = new EventEmitter()
  bot._client = { queue: (name, params) => sent.push([name, params]) }
  const input = createInputQueue(bot, { now: () => clock.now, timers: { setInterval: () => ({}), clearInterval () {} }, maxCatchupTicks })
  return { bot, input, clock, sent, packets: () => sent.filter(([n]) => n === 'player_auth_input').map(([, p]) => p) }
}

/** deterministic pseudo-random jitter */
function rng (seed) {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return x / 2147483648
  }
}

describe('input queue (tick clock + player_auth_input)', () => {
  it('tick = anchorTick + round((now - anchorTime) / 50)', () => {
    const { input, clock } = setup()
    input.anchor(57846n)
    assert.strictEqual(input.currentTick(), 57846n)
    clock.now += 24
    assert.strictEqual(input.currentTick(), 57846n)
    clock.now += 2 // 26 ms → rounds to 1
    assert.strictEqual(input.currentTick(), 57847n)
    assert.strictEqual(input.currentTick(clock.now + 1000), 57867n)
    input.anchor(100, clock.now)
    assert.strictEqual(input.currentTick(), 100n)
  })

  it('sends exactly one packet per elapsed server tick under a 16 Hz jittery timer (never twice the same tick)', () => {
    const { input, clock, packets } = setup()
    input.anchor(5000n)
    const random = rng(42)
    const start = clock.now
    let pumps = 0
    while (clock.now - start < 60000) { // one minute
      clock.now += 62.5 + (random() - 0.5) * 30 // 16 Hz ± 15 ms
      input.pump()
      pumps++
    }
    const ticks = packets().map(p => p.tick)
    assert.ok(pumps < 1000, `the timer fired ${pumps} times (16 Hz)`)
    assert.strictEqual(ticks[0], 5001n, 'the first pump (62 ms after the anchor) sends the current tick')
    assert.strictEqual(BigInt(ticks.length), input.currentTick() - ticks[0] + 1n, 'one packet per tick')
    assert.ok(ticks.length > 1150 && ticks.length < 1250, `${ticks.length} packets in a minute`)
    for (let i = 1; i < ticks.length; i++) assert.strictEqual(ticks[i], ticks[i - 1] + 1n, `tick ${i} follows ${i - 1}`)
    assert.strictEqual(ticks[ticks.length - 1], input.currentTick())
    assert.strictEqual(input.lastTick, input.currentTick())
  })

  it('sends nothing when no tick elapsed and caps the catch-up (default 4, oldest skipped)', () => {
    const { input, clock, packets } = setup()
    input.anchor(0n)
    assert.strictEqual(input.pump(), 1) // first pump sends the current tick
    assert.strictEqual(input.pump(), 0)
    clock.now += 20
    assert.strictEqual(input.pump(), 0, 'no tick elapsed')
    clock.now += 30
    assert.strictEqual(input.pump(), 1)
    clock.now += 50 * 10 // event loop stalled for 10 ticks
    assert.strictEqual(input.pump(), 4)
    const ticks = packets().map(p => Number(p.tick))
    assert.deepStrictEqual(ticks, [0, 1, 8, 9, 10, 11])
    const capped = setup({ maxCatchupTicks: 2 })
    capped.input.anchor(0n)
    capped.input.pump()
    capped.clock.now += 500
    assert.strictEqual(capped.input.pump(), 2)
  })

  it('suspend/resume: nothing is sent while any reason holds, no burst on resume', () => {
    const { input, clock, packets } = setup()
    input.anchor(0n)
    input.pump()
    input.suspend('death')
    input.suspend('lifecycle')
    clock.now += 500
    assert.strictEqual(input.pump(), 0)
    input.resume('death')
    assert.ok(input.isSuspended())
    clock.now += 500
    assert.strictEqual(input.pump(), 0)
    input.resume('lifecycle')
    assert.ok(!input.isSuspended())
    clock.now += 50
    assert.strictEqual(input.pump(), 1)
    assert.deepStrictEqual(packets().map(p => Number(p.tick)), [0, 21])
  })

  it('drains one-shot flags, keeps held flags, block actions, ≤1 item stack request per tick, vehicle, handled_teleport', () => {
    const { input, clock, packets } = setup()
    input.anchor(0n)
    input.addFlags(['start_sprinting'])
    input.hold('sneaking', true)
    input.markTeleportHandled()
    input.queueBlockAction({ action: 'start_break', position: { x: 1, y: -61, z: 2 }, face: 1 })
    input.queueBlockAction({ action: 'continue_break', position: { x: 1, y: -61, z: 2 }, face: 1 })
    input.queueItemStackRequest({ request_id: -1, actions: [], custom_names: [], cause: -1 })
    input.queueItemStackRequest({ request_id: -3, actions: [], custom_names: [], cause: -1 })
    input.setVehicle(-12884901851n, { x: 1, z: 2 })
    input.pump()
    clock.now += 50
    input.hold('sneaking', false)
    input.setVehicle(null)
    input.pump()
    const [a, b] = packets()
    assert.deepStrictEqual(new Set(a.input_data), new Set(['block_breaking_delay_enabled', 'sneaking', 'start_sprinting', 'handled_teleport', 'block_action', 'item_stack_request', 'client_predicted_vehicle']))
    assert.strictEqual(a.block_action.length, 2)
    assert.deepStrictEqual(a.block_action[0], { action: 'start_break', position: { x: 1, y: -61, z: 2 }, face: 1 })
    assert.strictEqual(a.item_stack_request.request_id, -1)
    assert.strictEqual(a.predicted_vehicle, -12884901851n)
    assert.deepStrictEqual(a.vehicle_rotation, { x: 1, z: 2 })
    assert.deepStrictEqual(b.input_data.sort(), ['block_breaking_delay_enabled', 'item_stack_request'])
    assert.strictEqual(b.item_stack_request.request_id, -3)
    assert.strictEqual(b.block_action, undefined)
    assert.strictEqual(b.predicted_vehicle, undefined)
  })

  it('merges the provider movement fields and serializes with bedrock-protocol 1.26.51', () => {
    const { input, packets } = setup()
    input.anchor(57846n)
    let calls = 0
    input.setProvider((tick) => {
      calls++
      assert.strictEqual(tick, 57846n)
      return { position: { x: 0.5, y: -58.38, z: 0.5 }, yaw: 90, pitch: -10, head_yaw: 90, delta: { x: 0, y: -0.0784, z: 0 }, input_data: ['vertical_collision'] }
    })
    const seen = []
    input.onSent((packet, tick) => seen.push(tick))
    input.pump()
    assert.strictEqual(calls, 1)
    assert.deepStrictEqual(seen, [57846n])
    const [p] = packets()
    assert.strictEqual(p.yaw, 90)
    assert.ok(p.input_data.includes('vertical_collision') && p.input_data.includes('block_breaking_delay_enabled'))
    const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
    const buf = createSerializer('1.26.51').createPacketBuffer({ name: 'player_auth_input', params: p })
    const back = createDeserializer('1.26.51').parsePacketBuffer(buf).data.params
    assert.strictEqual(back.tick, 57846n)
    assert.strictEqual(Math.fround(back.position.y), Math.fround(-58.38))
    assert.deepStrictEqual(new Set(back.input_data), new Set(p.input_data))
    assert.strictEqual(back.play_mode, 'normal')
  })

  it('start()/stop() drive pump() from a 50 ms interval', () => {
    const intervals = []
    const bot = new EventEmitter()
    const sent = []
    bot._client = { queue: (name) => sent.push(name) }
    let now = 0
    const input = createInputQueue(bot, {
      now: () => now,
      timers: { setInterval: (fn, ms) => { intervals.push({ fn, ms }); return { id: 1 } }, clearInterval: () => intervals.pop() }
    })
    input.start()
    input.start()
    assert.strictEqual(intervals.length, 1)
    assert.strictEqual(intervals[0].ms, 50)
    assert.ok(input.isRunning())
    intervals[0].fn()
    now += 50
    intervals[0].fn()
    assert.strictEqual(sent.length, 2)
    input.stop()
    assert.ok(!input.isRunning())
  })
})
