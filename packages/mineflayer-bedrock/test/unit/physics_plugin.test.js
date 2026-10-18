'use strict'
// owner: U5 (physics & movement) — the physics plugin on a fake client with the recorded BDS join (flat world):
// player_auth_input building, rewind + replay, teleports, knockback, flight, flyTo, elytra, vehicles, and the
// mineflayer internalTest physics analogs (docs/parity/U3-internal-tests.md).
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')

const EYE = 1.62
const close = (a, b, eps = 1e-4, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`)
/** a base ability layer the way BDS sends it (every flag allowed) */
const ALLOWED = { build: true, mine: true, invulnerable: true, flying: true, may_fly: true, instant_build: true, fly_speed: true, walk_speed: true }
function abilitiesPacket (bot, enabled) {
  return { entity_unique_id: bot._bedrock.ids.selfUniqueId(), permission_level: 'operator', command_permission: 'operator', abilities: [{ type: 'base', allowed: ALLOWED, enabled, fly_speed: 0.05, vertical_fly_speed: 1, walk_speed: 0.1 }] }
}

async function spawned (options) {
  const created = await createFakeBot(options)
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      created.clock.advance(50)
      created.bot._bedrock.input.pump()
    }
  }
  created.inputs = () => created.client.sent('player_auth_input')
  created.last = () => created.inputs().at(-1)
  created.tick(3) // settle on the grass
  return created
}

function selfRuntime (bot) { return bot._bedrock.ids.selfRuntimeId() }

describe('physics plugin (U5): Bedrock movement over player_auth_input', function () {
  this.timeout(30000)

  it('internalTest › physics › no physics if there is no chunk', async () => {
    // Bedrock always sends one player_auth_input per tick: the analog is that the bot does not simulate (nor move)
    // while its column is not loaded
    const { bot, tick, inputs, client } = await spawned()
    let physicsTicks = 0
    bot.on('physicsTick', () => physicsTicks++)
    bot._bedrock.physics.setPosition(new Vec3(5000.5, 100, 5000.5), { forced: true })
    client.clearSent()
    tick(20)
    assert.strictEqual(physicsTicks, 0)
    assert.strictEqual(inputs().length, 20)
    for (const p of inputs()) close(p.position.y, 100 + EYE, 1e-9)
  })

  it('internalTest › physics › absolute position & relative position (velocity)', async () => {
    const { bot, client, tick, last } = await spawned()
    const forced = []
    bot.on('forcedMove', () => forced.push(bot.entity.position.clone()))
    bot.entity.velocity.y = -1
    // absolute: move_player teleport (eye level) → feet position, velocity reset, forcedMove, handled_teleport
    client.receive('move_player', { runtime_id: selfRuntime(bot), position: { x: 1.5, y: -50 + EYE, z: 1.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: false, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 0 }, tick: bot._bedrock.input.lastTick })
    assert.strictEqual(forced.length, 1)
    assert.ok(bot.entity.position.distanceTo(new Vec3(1.5, -50, 1.5)) < 1e-6)
    assert.strictEqual(bot.entity.velocity.y, 0)
    tick()
    assert.ok(last().input_data.includes('handled_teleport'))
    close(last().position.y, -50 + EYE, 1e-5, 'the input after a teleport is not simulated (BDS)')
    // relative (velocity): set_entity_motion = the server-side velocity for the next tick
    client.receive('set_entity_motion', { runtime_entity_id: selfRuntime(bot), velocity: { x: 0.4, y: 0.4, z: 0 }, tick: 0n })
    tick()
    close(last().position.x, 1.9, 1e-5)
    close(last().position.y, -50 + 0.4 + EYE, 1e-5)
    close(last().delta.y, (0.4 - 0.08) * 0.98, 1e-6)
  })

  it('internalTest › physics › gravity + land on solid block + jump', async () => {
    const { bot, tick } = await spawned()
    bot._bedrock.physics.setPosition(new Vec3(1.5, -50, 1.5), { forced: true })
    let y = -50
    let landed = false
    bot.on('move', () => {
      if (landed) return
      assert.ok(bot.entity.position.y <= y + 1e-9)
      assert.ok(bot.entity.position.y >= -60)
      y = bot.entity.position.y
      if (bot.entity.position.y <= -60) {
        assert.strictEqual(bot.entity.position.y, -60)
        assert.strictEqual(bot.entity.onGround, true)
        landed = true
      } else {
        assert.strictEqual(bot.entity.onGround, false)
      }
    })
    tick(40)
    assert.ok(landed, 'landed')
    bot.setControlState('jump', true)
    tick(1)
    close(bot.entity.position.y, -60 + 0.42, 1e-5)
    bot.setControlState('jump', false)
    tick(20)
    assert.strictEqual(bot.entity.position.y, -60)
  })

  it('internalTest › physics › no movement packets while input is suspended', async () => {
    // Bedrock has no configuration phase: dimension changes / loading screens suspend the input queue
    const { bot, tick, inputs, client } = await spawned()
    bot._bedrock.input.suspend('test')
    client.clearSent()
    tick(20)
    assert.strictEqual(inputs().length, 0)
    bot._bedrock.input.resume('test')
    tick(2)
    assert.strictEqual(inputs().length, 2)
  })

  it('walking: move vector, edge + level flags, 0.21586 blocks per tick, delta = velocity', async () => {
    const { bot, tick, last, inputs } = await spawned()
    await bot.look(-Math.PI / 2, 0, true) // east
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    tick()
    const first = last()
    assert.deepStrictEqual(first.move_vector, { x: 0, z: 1 })
    assert.deepStrictEqual(first.raw_move_vector, { x: 0, z: 1 })
    for (const f of ['up', 'sprint_down', 'sprinting', 'start_sprinting', 'vertical_collision']) assert.ok(first.input_data.includes(f), f)
    tick()
    assert.ok(!last().input_data.includes('start_sprinting'), 'edge flag sent once')
    bot.setControlState('sprint', false)
    tick(40)
    const xs = inputs().slice(-3).map((p) => p.position.x)
    close(xs[2] - xs[1], 0.21586, 1e-4)
    close(last().delta.x, 0.117858, 1e-5)
    bot.setControlState('sneak', true)
    tick()
    for (const f of ['sneak_down', 'sneaking', 'start_sneaking', 'sneak_pressed_raw', 'stop_sprinting']) assert.ok(inputs().some((p) => p.input_data.includes(f)), f)
    close(last().move_vector.z, 0.3, 1e-6)
    bot.clearControlStates()
    tick()
    assert.ok(last().input_data.includes('stop_sneaking'))
  })

  it('using an item (bot.usingHeldItem): sprinting stops, the impulse is clamped to ±0.1225 (BDS trace useitem)', async () => {
    const { bot, tick, last, inputs } = await spawned()
    await bot.look(-Math.PI / 2, 0, true) // east
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    tick(30)
    assert.ok(last().input_data.includes('sprinting'))
    // activateItem: usingHeldItem + click_air (the server enters item use)
    bot.usingHeldItem = true
    require('../../lib/bedrock/transactions').useItem(bot)
    tick()
    assert.ok(last().input_data.includes('stop_sprinting'))
    assert.ok(!last().input_data.includes('sprinting'))
    tick(40)
    const xs = inputs().slice(-2).map((p) => p.position.x)
    close(xs[1] - xs[0], 0.0264, 1e-3, 'walking speed while using an item')
    bot.usingHeldItem = false
    tick()
    assert.ok(last().input_data.includes('start_sprinting'), 'the held sprint key sprints again')
    bot.clearControlStates()
  })

  it('rewind + replay: a correction rewinds to its tick and replays the recorded inputs', async () => {
    const { bot, client, tick } = await spawned()
    await bot.look(-Math.PI / 2, 0, true)
    bot.setControlState('forward', true)
    tick(30)
    const history = bot._bedrock.physics.history()
    const at = history.at(-6)
    const before = bot.entity.position.clone()
    const shifted = at.state.pos.offset(0, 0, 1) // server says: 1 block further south at that tick
    let correction = null
    bot._bedrock.physics.onCorrection((c) => { correction = c })
    client.receive('correct_player_move_prediction', { prediction_type: 'player', position: { x: shifted.x, y: shifted.y + EYE, z: shifted.z }, delta: { x: at.state.vel.x, y: at.state.vel.y, z: at.state.vel.z }, rotation: { x: 0, z: 0 }, on_ground: true, tick: at.tick })
    assert.strictEqual(correction.replayed, 5)
    close(bot.entity.position.z, before.z + 1, 1e-4, 'replayed from the corrected state')
    close(bot.entity.position.x, before.x, 1e-4)
  })

  it('teleport: the input after move_player is not simulated; inputs in flight are re-simulated from the target', async () => {
    const { bot, client, tick, inputs } = await spawned()
    bot._bedrock.physics.setPosition(new Vec3(0.5, -60, 0.5), { forced: false })
    // case B: the teleport covers every input sent → the next one is the unsimulated one
    client.receive('move_player', { runtime_id: selfRuntime(bot), position: { x: 0.5, y: -50 + EYE, z: 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 0 }, tick: bot._bedrock.input.lastTick })
    tick(2)
    const [skip, fall] = inputs().slice(-2)
    close(skip.position.y, -50 + EYE, 1e-6)
    assert.deepStrictEqual(skip.delta, { x: 0, y: 0, z: 0 })
    close(fall.position.y, -50 + EYE, 1e-6, 'first simulated tick: vy 0')
    close(fall.delta.y, -0.0784, 1e-6)
    // case A: two inputs were in flight → the first is the server's unsimulated one, the second falls from the target
    tick(3)
    const lastTick = bot._bedrock.input.lastTick
    client.receive('move_player', { runtime_id: selfRuntime(bot), position: { x: 0.5, y: -40 + EYE, z: 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: false, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 0 }, tick: lastTick - 2n })
    close(bot.entity.position.y, -40, 1e-6, 'one in-flight tick from rest: no movement yet')
    close(bot.entity.velocity.y, -0.0784, 1e-6)
  })

  it('knockback: set_entity_motion applies to the input after its tick, rewinding inputs already sent', async () => {
    const { bot, client, tick } = await spawned()
    tick(5)
    const lastTick = bot._bedrock.input.lastTick
    client.receive('set_entity_motion', { runtime_entity_id: selfRuntime(bot), velocity: { x: -0.4, y: 0.4, z: 0 }, tick: lastTick - 3n })
    // 3 inputs re-simulated with the motion applied at lastTick - 2: up 0.4, then 0.3136, then 0.228928
    close(bot.entity.position.y, -60 + 0.4 + 0.3136 + 0.228928, 1e-4)
    close(bot.entity.position.x, 0.5 - 0.4 - 0.4 * 0.546 - 0.4 * 0.546 * 0.91, 1e-4, 'ground friction on the knockback tick (BDS: delta -0.2184), then air')
  })

  it('effects: mob_effect (tick) re-simulates the inputs after it with the new levels', async () => {
    const { bot, client, tick } = await spawned()
    bot._bedrock.physics.setPosition(new Vec3(0.5, -40, 0.5), { forced: true })
    tick(4)
    const before = bot.entity.position.y
    // the server applied levitation II from the input after lastTick - 2
    bot.entity.effects = { 24: { id: 24, amplifier: 1, duration: 100 } }
    client.receive('mob_effect', { runtime_entity_id: selfRuntime(bot), event_id: 'add', effect_id: 24, amplifier: 1, particles: false, duration: 100, tick: bot._bedrock.input.lastTick - 2n, ambient: false })
    assert.ok(bot.entity.position.y > before, 'levitation applied retroactively to the last two inputs')
  })

  it('creative flight: request_ability with the next input, server sync through update_abilities', async () => {
    const { bot, client, tick, last } = await spawned()
    bot._bedrock.physics.setFlying(true)
    client.clearSent()
    tick()
    const names = client.written.map(([, name]) => name)
    assert.deepStrictEqual(names.slice(0, 2), ['request_ability', 'player_auth_input'])
    assert.deepStrictEqual(client.sent('request_ability')[0], { ability: 'flying', value_type: 'bool', bool_value: true, float_val: 0 })
    assert.ok(last().input_data.includes('start_flying'))
    bot.setControlState('jump', true)
    tick()
    assert.ok(last().input_data.includes('ascend'))
    close(last().delta.y, 0.15 * 0.6, 1e-6)
    bot.setControlState('jump', false)
    // the server ends the flight (gamemode change): no request is echoed back
    client.receive('update_abilities', abilitiesPacket(bot, { flying: false, may_fly: true }))
    assert.strictEqual(bot._bedrock.physics.isFlying(), false)
    client.clearSent()
    tick()
    assert.strictEqual(client.sent('request_ability').length, 0)
    assert.ok(last().input_data.includes('stop_flying'))
  })

  it('flyTo: flies there with flight inputs (no teleports) and resolves when stopped at the destination', async () => {
    const { bot, client, tick, inputs } = await spawned()
    const abilities = (flying) => client.receive('update_abilities', abilitiesPacket(bot, { flying, may_fly: true }))
    abilities(false) // creative: may fly
    const target = new Vec3(4.5, -55, 3.5)
    const state = { done: false }
    const p = bot._bedrock.physics.flyTo(target).then(() => { state.done = true })
    tick()
    abilities(true) // the server grants the request
    for (let i = 0; i < 200 && !state.done; i++) {
      tick()
      await Promise.resolve()
    }
    await p
    assert.ok(bot.entity.position.distanceTo(target) <= 0.15, `${bot.entity.position}`)
    assert.ok(inputs().some((x) => x.input_data.includes('start_flying')))
    assert.ok(inputs().some((x) => x.input_data.includes('up')))
    assert.ok(bot._bedrock.physics.isFlying(), 'stays flying (upstream semantics)')
    // every step is a physics step: no input moved more than the flight terminal speed
    const ys = inputs().map((x) => x.position)
    for (let i = 1; i < ys.length; i++) assert.ok(new Vec3(ys[i].x, ys[i].y, ys[i].z).distanceTo(new Vec3(ys[i - 1].x, ys[i - 1].y, ys[i - 1].z)) < 0.8)
  })

  it('elytraFly: upstream checks; start_gliding with a jump press; the server gliding flag ends it', async () => {
    const { bot, client, tick, last } = await spawned()
    await assert.rejects(bot.elytraFly(), /Unable to fly from ground/)
    bot._bedrock.physics.setPosition(new Vec3(0.5, -20, 0.5), { forced: true })
    tick(3)
    await assert.rejects(bot.elytraFly(), /Elytra must be equip to start flying/)
    const elytraId = bot._bedrock.ids.itemNetworkId('elytra')
    client.receive('inventory_content', { window_id: 'armor', input: [{ network_id: 0 }, { network_id: elytraId, count: 1, metadata: 0, has_stack_id: 1, stack_id: 5, block_runtime_id: 0, extra: {} }, { network_id: 0 }, { network_id: 0 }], container: { container_id: 'armor' }, storage_item: { network_id: 0 } })
    await bot.elytraFly()
    tick()
    for (const f of ['start_gliding', 'jump_pressed_raw', 'start_jumping', 'jumping']) assert.ok(last().input_data.includes(f), f)
    tick(10)
    assert.strictEqual(bot.entity.elytraFlying, true)
    await assert.rejects(bot.elytraFly(), /Already elytra flying/)
    // the server confirms, then ends the glide
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime(bot), metadata: [{ key: 'flags', type: 'long', value: { gliding: true } }], properties: { ints: [], floats: [] }, tick: bot._bedrock.input.lastTick })
    tick(2)
    client.receive('set_entity_data', { runtime_entity_id: selfRuntime(bot), metadata: [{ key: 'flags', type: 'long', value: { gliding: false } }], properties: { ints: [], floats: [] }, tick: bot._bedrock.input.lastTick })
    assert.strictEqual(bot.entity.elytraFlying, false)
    tick()
    assert.ok(last().input_data.includes('stop_gliding'))
  })

  it('moveVehicle: the move vector, boat paddles and client_predicted_vehicle with the vehicle id while riding', async () => {
    const { bot, tick, last } = await spawned()
    assert.ok(!bot.moveVehicle.notImplemented)
    bot.vehicle = { id: 77, runtimeId: 77n, uniqueId: -77n, name: 'boat', yaw: Math.PI, pitch: 0, position: bot.entity.position.clone() }
    bot.emit('mount')
    bot.moveVehicle(0, 1)
    tick()
    const p = last()
    assert.strictEqual(p.predicted_vehicle, -77n)
    assert.ok(p.input_data.includes('client_predicted_vehicle'))
    assert.deepStrictEqual(p.move_vector, { x: 0, z: 1 })
    for (const f of ['up', 'paddling_left', 'paddling_right']) assert.ok(p.input_data.includes(f), f)
    bot.moveVehicle(1, 0)
    tick()
    assert.ok(last().input_data.includes('paddling_right') && !last().input_data.includes('paddling_left'))
    const vehicle = bot.vehicle
    bot.vehicle = null
    bot.emit('dismount', vehicle)
    tick()
    assert.ok(!last().input_data.includes('client_predicted_vehicle'))
  })
})
