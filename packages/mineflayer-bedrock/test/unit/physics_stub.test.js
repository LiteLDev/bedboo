'use strict'
// owner: U4 (core runtime) — the physics SURFACE (U4 stationary stub, U5 replaces the engine): these tests guard
// the contract U5 must keep (docs/CONTRIBUTING.md "Physics surface").
const assert = require('assert')
const { Vec3 } = require('vec3')
const conv = require('mineflayer/lib/conversions')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { defaultPhysicsFields } = require('../../lib/physics')
const { isStub } = require('../../lib/bedrock/errors')

const EYE = 1.62

/** deterministic jitter around a 16 Hz timer */
function jitter (seed = 7) {
  let x = seed
  return () => {
    x = (x * 1103515245 + 12345) % 2147483648
    return 62.5 + (x / 2147483648 - 0.5) * 30
  }
}

async function spawnedBot (options) {
  const created = await createFakeBot(options)
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  const next = jitter()
  /** advance the fake clock like a 16 Hz timer for `ms`, pumping the input queue at each fire */
  created.run = (ms) => {
    const end = created.clock.now + ms
    while (created.clock.now < end) {
      created.clock.advance(next())
      created.bot._bedrock.input.pump()
    }
  }
  created.tick = () => {
    created.clock.advance(50)
    return created.bot._bedrock.input.pump()
  }
  return created
}

describe('physics stub surface (U4 → U5)', function () {
  this.timeout(30000)

  it('bot.physics: every mineflayer default field + a working simulatePlayer / adjustPositionHeight', async () => {
    const { bot } = await spawnedBot()
    const fields = defaultPhysicsFields()
    assert.strictEqual(Object.keys(fields).length, 31)
    for (const [name, value] of Object.entries(fields)) {
      assert.deepStrictEqual(bot.physics[name], value, `bot.physics.${name}`)
    }
    assert.ok(!isStub(bot.physics.simulatePlayer))
    const state = { pos: new Vec3(0, 0, 0) }
    assert.strictEqual(bot.physics.simulatePlayer(state, bot.world), state)
    // upstream prismarine-physics semantics (U5 engine): lowers onto the ground at most 1 block below
    const pos = new Vec3(0.5, -59.5, 0.5)
    bot.physics.adjustPositionHeight(pos)
    assert.strictEqual(pos.y, -60, 'lowered onto the grass of the flat world')
    assert.strictEqual(bot.physicsEnabled, true)
    assert.strictEqual(bot.jumpQueued, false)
    assert.strictEqual(bot.jumpTicks, 0)
  })

  it('control states: set/get/clear, controlState accessors, validation, jumpQueued', async () => {
    const { bot } = await spawnedBot()
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) assert.strictEqual(bot.getControlState(c), false)
    bot.setControlState('forward', true)
    assert.strictEqual(bot.controlState.forward, true)
    bot.controlState.sneak = true
    assert.strictEqual(bot.getControlState('sneak'), true)
    bot.setControlState('jump', true)
    assert.strictEqual(bot.jumpQueued, true)
    assert.throws(() => bot.setControlState('fly', true), /invalid control: fly/)
    assert.throws(() => bot.setControlState('forward', 1), /invalid state: 1/)
    assert.throws(() => bot.getControlState('fly'), /invalid control/)
    bot.clearControlStates()
    for (const c of ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']) assert.strictEqual(bot.controlState[c], false)
  })

  it('one player_auth_input + one physicsTick/physicTick per server tick (16 Hz jitter), eye-level, stationary', async () => {
    const { bot, client, run } = await spawnedBot()
    let physicsTicks = 0
    let physicTicks = 0
    let moves = 0
    bot.on('physicsTick', () => physicsTicks++)
    bot.on('physicTick', () => physicTicks++)
    bot.on('move', () => moves++)
    run(10000)
    const packets = client.sent('player_auth_input')
    const ticks = packets.map(p => p.tick)
    for (let i = 1; i < ticks.length; i++) assert.strictEqual(ticks[i], ticks[i - 1] + 1n)
    assert.ok(packets.length >= 199 && packets.length <= 202, `${packets.length} ticks in 10 s`)
    assert.strictEqual(physicsTicks, packets.length)
    assert.strictEqual(physicTicks, packets.length)
    // U5 engine: the spawn position is 1e-5 above the grass (BDS); the first tick after the forced spawn position is not
    // simulated (like BDS after a teleport), the second settles onto the grass. Bedrock's delta is
    // the velocity at the end of the tick: standing still that is the gravity step (0, -0.0784, 0)
    for (const p of packets.slice(2)) {
      assert.ok(Math.abs(p.position.y - (bot.entity.position.y + EYE)) < 1e-9)
      assert.deepStrictEqual({ x: p.delta.x, z: p.delta.z }, { x: 0, z: 0 })
      assert.ok(Math.abs(p.delta.y - -0.0784) < 1e-6, `resting delta ${p.delta.y}`)
      assert.ok(p.input_data.includes('vertical_collision'))
    }
    assert.ok(moves <= 2, 'standing still emits no move events (U5: besides the first packet and the 1e-5 settle)')
    assert.strictEqual(bot.entity.onGround, true)
  })

  it('look / lookAt: effective in the next player_auth_input; force resolves at once', async () => {
    const { bot, client, tick } = await spawnedBot()
    tick()
    let resolved = false
    const looking = bot.look(Math.PI / 2, 0.5).then(() => { resolved = true })
    await Promise.resolve()
    assert.strictEqual(resolved, false, 'waits for the packet')
    tick()
    await looking
    const last = client.sent('player_auth_input').pop()
    assert.ok(Math.abs(last.yaw - Math.fround(conv.toNotchianYaw(bot.entity.yaw))) < 1e-6)
    assert.ok(Math.abs(last.pitch - Math.fround(conv.toNotchianPitch(bot.entity.pitch))) < 1e-6)
    assert.strictEqual(last.head_yaw, last.yaw)
    assert.deepStrictEqual(last.interact_rotation, { x: last.pitch, z: last.yaw })
    assert.ok(Math.abs(bot.entity.yaw - Math.PI / 2) < 0.01)
    // camera_orientation is the view direction
    const dir = last.camera_orientation
    assert.ok(Math.abs(Math.hypot(dir.x, dir.y, dir.z) - 1) < 1e-9)
    assert.ok(Math.abs(dir.y - Math.sin(bot.entity.pitch)) < 1e-9)

    await bot.look(0, 0, true) // force: no packet needed
    await bot.lookAt(bot.entity.position.offset(0, EYE, -5), true)
    assert.ok(Math.abs(bot.entity.yaw) < 0.01 && Math.abs(bot.entity.pitch) < 0.01, 'looking north (-z)')
    const lookAt = bot.lookAt(bot.entity.position.offset(5, EYE, 0))
    tick()
    await lookAt
    assert.ok(Math.abs(bot.entity.yaw - -Math.PI / 2) < 0.01, `east: ${bot.entity.yaw}`)
  })

  it('waitForTicks resolves after n physics ticks', async () => {
    const { bot, tick } = await spawnedBot()
    let done = false
    const p = bot.waitForTicks(3).then(() => { done = true })
    tick()
    tick()
    await Promise.resolve()
    assert.strictEqual(done, false)
    tick()
    await p
    assert.strictEqual(done, true)
    await bot.waitForTicks(0)
  })

  it('forcedMove on a move_player teleport: eye → feet, velocity reset, handled_teleport in the next input', async () => {
    const { bot, client, tick } = await spawnedBot()
    const events = []
    bot.on('move', () => events.push('move'))
    bot.on('forcedMove', () => events.push('forcedMove'))
    client.receive('move_player', { runtime_id: 91, position: { x: 10.5, y: -60 + EYE, z: 10.5 }, pitch: 10, yaw: 90, head_yaw: 90, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 1 }, tick: 1n })
    assert.deepStrictEqual(events, ['move', 'forcedMove'])
    assert.ok(bot.entity.position.distanceTo(new Vec3(10.5, -60, 10.5)) < 1e-6)
    assert.ok(Math.abs(bot.entity.yaw - conv.fromNotchianYaw(90)) < 1e-9)
    tick()
    const [p] = client.sent('player_auth_input').slice(-1)
    assert.ok(p.input_data.includes('handled_teleport'))
    assert.ok(Math.abs(p.position.y - (-60 + EYE)) < 1e-6)
    tick()
    assert.ok(!client.sent('player_auth_input').pop().input_data.includes('handled_teleport'), 'one-shot')
    // another entity's move_player is not ours
    client.receive('move_player', { runtime_id: 5, position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'normal', on_ground: true, ridden_runtime_id: 0, tick: 2n })
    assert.ok(bot.entity.position.distanceTo(new Vec3(10.5, -60, 10.5)) < 1e-6)
    // mode rotation: head only
    client.receive('move_player', { runtime_id: 91, position: { x: 0, y: 0, z: 0 }, pitch: 0, yaw: 180, head_yaw: 180, mode: 'rotation', on_ground: true, ridden_runtime_id: 0, tick: 3n })
    assert.ok(bot.entity.position.distanceTo(new Vec3(10.5, -60, 10.5)) < 1e-6)
    assert.ok(Math.abs(bot.entity.yaw - conv.fromNotchianYaw(180)) < 1e-9)
  })

  it('correct_player_move_prediction snaps position, velocity and onGround (forcedMove)', async () => {
    const { bot, client } = await spawnedBot()
    let forced = 0
    bot.on('forcedMove', () => forced++)
    client.receive('correct_player_move_prediction', { prediction_type: 'player', position: { x: 0.5, y: -52.5, z: 0.5 }, delta: { x: 0, y: -0.44, z: 0 }, rotation: { x: 0, z: 0 }, on_ground: false, tick: 10n })
    assert.strictEqual(forced, 1)
    assert.ok(Math.abs(bot.entity.position.y - (-52.5 - EYE)) < 1e-9)
    assert.strictEqual(bot.entity.velocity.y, -0.44)
    assert.strictEqual(bot.entity.onGround, false)
    client.receive('correct_player_move_prediction', { prediction_type: 'vehicle', position: { x: 9, y: 9, z: 9 }, delta: { x: 0, y: 0, z: 0 }, rotation: { x: 0, z: 0 }, on_ground: false, tick: 11n })
    assert.strictEqual(forced, 1, 'vehicle corrections are not the player')
  })

  it('simple gravity: falls after a teleport into the air and lands on the ground; physicsEnabled=false freezes', async () => {
    const { bot, client, tick } = await spawnedBot()
    bot._bedrock.physics.setPosition(new Vec3(0.5, -55, 0.5), { forced: true })
    let ticks = 0
    while (!bot.entity.onGround && ticks < 100) { tick(); ticks++ }
    assert.ok(ticks > 5 && ticks < 30, `landed after ${ticks} ticks`)
    assert.strictEqual(bot.entity.position.y, -60)
    assert.ok(Math.abs(bot.entity.velocity.y - -0.0784) < 1e-6, 'U5 engine: resting velocity = one gravity step')
    const falling = client.sent('player_auth_input').filter(p => p.delta.y < 0)
    assert.ok(falling.length > 3, 'delta carries the velocity while falling')

    bot.physicsEnabled = false
    let physicsTicks = 0
    bot.on('physicsTick', () => physicsTicks++)
    bot._bedrock.physics.setPosition(new Vec3(0.5, -55, 0.5), { forced: true })
    const before = client.sent('player_auth_input').length
    for (let i = 0; i < 10; i++) tick()
    assert.strictEqual(bot.entity.position.y, -55, 'no simulation')
    assert.strictEqual(physicsTicks, 0)
    assert.strictEqual(client.sent('player_auth_input').length - before, 10, 'inputs are still sent every tick')
    bot.physicsEnabled = true

    bot._bedrock.physics.setFlying(true)
    for (let i = 0; i < 10; i++) tick()
    assert.strictEqual(bot.entity.position.y, -55, 'flying: no gravity')
    bot._bedrock.physics.setFlying(false)
  })

  it('setPosition: forced → velocity 0 + forcedMove + handled_teleport (unless handledTeleport: false)', async () => {
    const { bot, client, tick } = await spawnedBot()
    let forced = 0
    bot.on('forcedMove', () => forced++)
    bot.entity.velocity.set(1, 1, 1)
    bot._bedrock.physics.setPosition(new Vec3(1.5, -60, 1.5), { forced: true, handledTeleport: false })
    assert.strictEqual(forced, 1)
    assert.deepStrictEqual(bot.entity.velocity, new Vec3(0, 0, 0))
    tick()
    assert.ok(!client.sent('player_auth_input').pop().input_data.includes('handled_teleport'))
    bot._bedrock.physics.setPosition(new Vec3(2.5, -60, 2.5), { forced: true })
    tick()
    assert.ok(client.sent('player_auth_input').pop().input_data.includes('handled_teleport'))
    bot._bedrock.physics.setPosition(new Vec3(3.5, -60, 3.5))
    assert.strictEqual(forced, 2, 'unforced moves are not forcedMove')
  })

  it('no physicsTick while the bot\'s column is not loaded, inputs still sent (Bedrock analog of "no physics if there is no chunk")', async () => {
    const { bot, client, tick } = await spawnedBot()
    let physicsTicks = 0
    bot.on('physicsTick', () => physicsTicks++)
    bot._bedrock.physics.setPosition(new Vec3(5000.5, 100, 5000.5), { forced: true })
    for (let i = 0; i < 5; i++) tick()
    assert.strictEqual(physicsTicks, 0)
    assert.strictEqual(bot.entity.position.y, 100, 'no fall without a chunk')
    assert.strictEqual(client.sent('player_auth_input').length, 5)
  })
})
