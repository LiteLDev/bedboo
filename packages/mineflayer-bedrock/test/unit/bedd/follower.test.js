'use strict'
// owner: BEDD-4 (physics follower + external tick clock) — transport 'bedd': the input queue's external clock
// (setExternalClock / pumpTo), and bot.entity / physicsTick / look driven by the real client's echoed
// player_auth_input (lib/bedd/follower.js + the bedd branch of lib/plugins/physics.js). A real createBot on the fake
// client replays the recorded BDS join; the join's own outbound player_auth_input records play the client's echoes.
const assert = require('assert')
const { Vec3 } = require('vec3')
const fixtures = require('../../fixtures')
const mineflayerBedrock = require('../../..')
const { fakeClient, fakeClock, createFakeBot, replayJoin } = require('../helpers/fake')
const { createInputQueue } = require('../../../lib/bedrock/input_queue')
const follower = require('../../../lib/bedd/follower')

const EYE = 1.62
const close = (a, b, eps = 1e-6, msg = '') => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`)

/** timers that record setInterval calls and never fire */
function recordingTimers () {
  const timers = {
    intervals: 0,
    cleared: 0,
    setInterval: () => { timers.intervals++; return { unref () {} } },
    clearInterval: () => { timers.cleared++ }
  }
  return timers
}

/** the client's echoes: every outbound player_auth_input of join_flat (dir 'out') */
function echoRecords () {
  const cap = fixtures.load('join_flat')
  return cap.records.filter(r => r.dir === 'out' && r.name === 'player_auth_input').map(r => cap.parse(r))
}

/**
 * A bot on the fake client in mode 'bedd' (client.bedd stub), with a manual clock and recording timers, the follower
 * attached and the join replayed. bedd transport (BB1) sets bot._bedrock.mode itself; set here when absent.
 */
async function beddBot ({ mode = 'bedd' } = {}) {
  const client = fakeClient()
  client.bedd = {
    rpc: { call: async () => ({ ok: true }), supports: () => false },
    caps: {},
    link: { state: 'up', type: 'remote' },
    capabilities: { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true },
    attach () {}
  }
  const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true })
  if (mode) bot._bedrock.mode = bot._bedrock.mode ?? mode
  const clock = fakeClock()
  const timers = recordingTimers()
  bot._bedrock.input = createInputQueue(bot, { now: () => clock.now, timers })
  const errors = []
  bot.on('error', (err) => errors.push(err))
  await new Promise((resolve) => bot.once('inject_allowed', () => setImmediate(resolve)))
  const handle = follower.attach(bot, client)
  await replayJoin(bot, client)
  client.clearSent()
  const echo = (params) => client.emit('serverbound', { name: 'player_auth_input', params, reserialized: false })
  return { bot, client, clock, timers, errors, handle, echo, inputs: () => client.sent('player_auth_input') }
}

describe('bedd physics follower (BEDD-4)', function () {
  this.timeout(30000)

  describe('input queue external clock', () => {
    function queue () {
      const clock = { now: 10000 }
      const timers = recordingTimers()
      const client = fakeClient()
      const bot = { _client: client, emit () {} }
      const input = createInputQueue(bot, { now: () => clock.now, timers })
      input.anchor(100n)
      return { input, timers, client, clock }
    }

    it('setExternalClock(true) stops the timer; start() then starts none but the queue runs', () => {
      const { input, timers } = queue()
      input.start()
      assert.strictEqual(timers.intervals, 1)
      input.setExternalClock(true)
      assert.strictEqual(timers.cleared, 1)
      assert.ok(input.isExternalClock())
      assert.ok(input.isRunning())
      input.stop()
      input.start()
      assert.strictEqual(timers.intervals, 1)
      assert.ok(input.isRunning())
      input.setExternalClock(false) // back to the timer while running
      assert.strictEqual(timers.intervals, 2)
    })

    it('pumpTo(tick) sends exactly one packet for that tick and anchors on it', () => {
      const { input, client, clock } = queue()
      input.setExternalClock(true)
      assert.strictEqual(input.pumpTo(200n), 0, 'not started: nothing sent')
      input.start()
      assert.strictEqual(input.pumpTo(200n), 1)
      assert.strictEqual(input.pumpTo(205), 1) // no catch-up of 201..204
      assert.deepStrictEqual(client.sent('player_auth_input').map(p => p.tick), [200n, 205n])
      assert.strictEqual(input.currentTick(clock.now), 205n)
      assert.strictEqual(input.pumpTo(203n), 1, 'an older client tick still sends one packet')
      assert.strictEqual(input.lastTick, 206n, 'tick numbers only grow')
      input.suspend('loading')
      assert.strictEqual(input.pumpTo(300n), 0)
      input.resume('loading')
      assert.strictEqual(input.pumpTo(301n), 1)
      assert.deepStrictEqual(client.sent('player_auth_input').map(p => p.tick), [200n, 205n, 206n, 301n])
    })
  })

  describe('bedd mode', () => {
    it('bot.entity follows the echo (feet = eye − 1.62), one physicsTick per echo, no timer ticks', async () => {
      const { bot, timers, echo, inputs, errors } = await beddBot()
      assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
      assert.strictEqual(timers.intervals, 0, 'the 50 ms timer never starts in bedd mode')
      assert.ok(bot._bedrock.input.isExternalClock())
      let physicsTicks = 0
      let moves = 0
      bot.on('physicsTick', () => physicsTicks++)
      bot.on('move', () => moves++)
      const echoes = echoRecords()
      assert.ok(echoes.length >= 10)
      for (const [i, params] of echoes.entries()) {
        // move the echo a little each tick so every one is a distinct client state
        const moved = { ...params, position: { x: params.position.x + i * 0.1, y: params.position.y, z: params.position.z }, delta: { x: 0.1, y: 0, z: 0 } }
        echo(moved)
        close(bot.entity.position.x, moved.position.x)
        close(bot.entity.position.y, moved.position.y - EYE)
        close(bot.entity.position.z, moved.position.z)
        assert.ok(bot.entity.velocity.equals(new Vec3(0.1, 0, 0)))
        assert.strictEqual(physicsTicks, i + 1)
        assert.strictEqual(bot.bedrock.bedd.observed.tick, Number(params.tick))
      }
      assert.ok(moves >= echoes.length - 1)
      const sent = inputs()
      assert.strictEqual(sent.length, echoes.length, 'one input per echo (pumpTo)')
      assert.deepStrictEqual(sent.map(p => p.tick), echoes.map(p => BigInt(p.tick) + 1n))
      // without echoes the clock does not run by itself
      assert.strictEqual(bot._bedrock.input.pump(1e9), 0)
      assert.strictEqual(inputs().length, echoes.length)
      assert.strictEqual(timers.intervals, 0)
      assert.deepStrictEqual(errors, [])
    })

    it('onGround = vertical_collision && delta.y <= 0', async () => {
      const { bot, echo } = await beddBot()
      const [base] = echoRecords()
      echo({ ...base, input_data: ['vertical_collision'], delta: { x: 0, y: 0, z: 0 } })
      assert.strictEqual(bot.entity.onGround, true)
      echo({ ...base, tick: base.tick + 1n, input_data: ['vertical_collision'], delta: { x: 0, y: 0.42, z: 0 } })
      assert.strictEqual(bot.entity.onGround, false)
      echo({ ...base, tick: base.tick + 2n, input_data: [], delta: { x: 0, y: -0.08, z: 0 } })
      assert.strictEqual(bot.entity.onGround, false)
      echo({ ...base, tick: base.tick + 3n, input_data: ['vertical_collision'], delta: { x: 0, y: -0.0784, z: 0 } })
      assert.strictEqual(bot.entity.onGround, true, 'landed')
      echo({ ...base, tick: base.tick + 4n, input_data: [], delta: { x: 0, y: 0.42, z: 0 } }) // jump
      echo({ ...base, tick: base.tick + 5n, input_data: ['vertical_collision'], delta: { x: 0, y: -0.0784, z: 0 } })
      assert.strictEqual(bot.entity.onGround, false, 'a ceiling hit is not a landing')
    })

    it('lookAt resolves only after an echo with the matching rotation; the packets carry the desired one', async () => {
      const { bot, echo, inputs } = await beddBot()
      const [base] = echoRecords()
      echo(base)
      const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
      const target = eye.offset(-5, 0, 0) // yaw 90° (Bedrock), pitch 0
      let resolved = false
      const looking = bot.lookAt(target).then(() => { resolved = true })
      await new Promise(resolve => setImmediate(resolve))
      for (let i = 1; i <= 3; i++) {
        echo({ ...base, tick: base.tick + BigInt(i), yaw: 20 * i, pitch: 0 }) // the client is still turning
        await new Promise(resolve => setImmediate(resolve))
        assert.strictEqual(resolved, false, `echo ${i} must not resolve the look`)
        close(inputs().at(-1).yaw, 90, 1e-3, 'the input carries the desired yaw')
        close(bot.bedrock.bedd.observed.yaw, 20 * i)
      }
      echo({ ...base, tick: base.tick + 4n, yaw: 90.2, pitch: 0.1 })
      await looking
      assert.strictEqual(resolved, true)
      close(bot.bedrock.bedd.observed.yaw, 90.2)
      // converged: later inputs carry the echoed rotation again
      echo({ ...base, tick: base.tick + 5n, yaw: 91, pitch: 0 })
      close(inputs().at(-1).yaw, 91, 1e-3)
    })

    it('look(force) resolves at once and keeps the desired rotation until the echo converges', async () => {
      const { bot, echo, inputs } = await beddBot()
      const [base] = echoRecords()
      echo(base)
      await bot.look(0, 0, true) // mineflayer yaw 0 = Bedrock yaw 180
      echo({ ...base, tick: base.tick + 1n, yaw: 10, pitch: 0 })
      close(Math.abs(inputs().at(-1).yaw), 180, 1e-3)
      echo({ ...base, tick: base.tick + 2n, yaw: -179.8, pitch: 0 }) // within 0.5° across ±180
      echo({ ...base, tick: base.tick + 3n, yaw: -179.5, pitch: 0 })
      close(inputs().at(-1).yaw, -179.5, 1e-3)
    })

    it('set_entity_motion and corrections are not re-simulated (the next echo decides)', async () => {
      const { bot, client, echo } = await beddBot()
      const [base] = echoRecords()
      echo(base)
      const before = bot.entity.position.clone()
      // in raknet mode this rewinds and re-simulates the inputs after base.tick (moving the bot): not in bedd mode
      client.receive('set_entity_motion', { runtime_entity_id: bot._bedrock.ids.selfRuntimeId(), velocity: { x: 1, y: 1, z: 1 }, tick: base.tick })
      assert.ok(bot.entity.position.equals(before))
      client.receive('correct_player_move_prediction', { prediction_type: 'player', position: { x: 3.5, y: before.y + EYE, z: 3.5 }, delta: { x: 0, y: 0, z: 0 }, on_ground: true, tick: base.tick + 1n })
      close(bot.entity.position.x, 3.5, 1e-6, 'the correction is taken as is')
      echo({ ...base, tick: base.tick + 1n, delta: { x: 1, y: 1, z: 1 } })
      assert.ok(bot.entity.velocity.equals(new Vec3(1, 1, 1)))
    })

    it('attach is idempotent per bot and detaches on end', async () => {
      const { bot, client, handle } = await beddBot()
      assert.ok(handle)
      assert.strictEqual(follower.attach(bot, client), handle)
      const listeners = client.listenerCount('serverbound')
      handle.detach()
      assert.strictEqual(client.listenerCount('serverbound'), listeners - 1)
    })
  })

  describe('raknet mode (no-op)', () => {
    it('attach does nothing, echoes are ignored and the timer clock is unchanged', async () => {
      const { bot, client } = await createFakeBot()
      assert.strictEqual(bot._bedrock.mode, 'raknet') // lib/loader.js (BEDD-1): the transport name without client.bedd
      assert.strictEqual(follower.attach(bot, client), null)
      assert.strictEqual(bot.bedrock.bedd, undefined)
      await replayJoin(bot, client)
      assert.strictEqual(bot._bedrock.input.isExternalClock(), false)
      const pos = bot.entity.position.clone()
      let physicsTicks = 0
      bot.on('physicsTick', () => physicsTicks++)
      const [base] = echoRecords()
      client.emit('serverbound', { name: 'player_auth_input', params: { ...base, position: { x: 100, y: 100, z: 100 } }, reserialized: false })
      assert.strictEqual(bot._bedrock.physics.followEcho({ ...base, position: { x: 100, y: 100, z: 100 } }), false)
      assert.ok(bot.entity.position.equals(pos))
      assert.strictEqual(physicsTicks, 0)
    })

    it('start() still runs the 50 ms timer', async () => {
      const timers = recordingTimers()
      const client = fakeClient()
      const bot = { _client: client, emit () {} }
      const input = createInputQueue(bot, { now: () => 0, timers })
      input.start()
      input.start()
      assert.strictEqual(timers.intervals, 1)
      assert.ok(input.isRunning())
      input.stop()
      assert.ok(!input.isRunning())
    })
  })
})
