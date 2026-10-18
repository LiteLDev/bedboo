'use strict'
// owner: W3-FIX-A (wave-3 gate fix-ups: movement, flight, lifecycle, abilities) — regressions of the wave-3 review on
// the fake client with the recorded BDS join: abilities as the single flight source, firework boosts across rewinds,
// the raised shield, the End exit spawn, sneak / sprint before clicks, look() from tick listeners, queued jumps across
// replays, creative gravity, throwing physicsTick listeners, plain creative fireworks / banners, entityElytraFlew.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const transactions = require('../../lib/bedrock/transactions')
const { SPAWN_POSITION_TIMEOUT_MS } = require('../../lib/bedrock/lifecycle')

const EYE = 1.62
const ZERO = { x: 0, y: 0, z: 0 }
const close = (a, b, eps = 1e-4, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`)
const ALLOWED = { build: true, mine: true, invulnerable: true, flying: true, may_fly: true, instant_build: true, fly_speed: true, walk_speed: true }

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
  created.names = () => created.client.written.map(([, name]) => name)
  created.self = () => created.bot._bedrock.ids.selfRuntimeId()
  created.tick(3) // settle on the grass
  return created
}

function abilitiesPacket (bot, enabled, flySpeed = 0.05) {
  return { entity_unique_id: bot._bedrock.ids.selfUniqueId(), permission_level: 'operator', command_permission: 'operator', abilities: [{ type: 'base', allowed: ALLOWED, enabled, fly_speed: flySpeed, vertical_fly_speed: 1, walk_speed: 0.1 }] }
}

function equipElytra (bot, client) {
  const elytraId = bot._bedrock.ids.itemNetworkId('elytra')
  client.receive('inventory_content', { window_id: 'armor', input: [{ network_id: 0 }, { network_id: elytraId, count: 1, metadata: 0, has_stack_id: 1, stack_id: 5, block_runtime_id: 0, extra: {} }, { network_id: 0 }, { network_id: 0 }], container: { container_id: 'armor' }, storage_item: { network_id: 0 } })
}

const glidingData = (bot, on) => ({ runtime_entity_id: bot._bedrock.ids.selfRuntimeId(), metadata: [{ key: 'flags', type: 'long', value: { gliding: on } }], properties: { ints: [], floats: [] }, tick: bot._bedrock.input.lastTick })

/** gliding east from y -20 with an elytra, confirmed by the server */
async function gliding () {
  const created = await spawned()
  const { bot, client, tick } = created
  await bot.look(-Math.PI / 2, 0, true)
  bot._bedrock.physics.setPosition(new Vec3(0.5, -20, 0.5), { forced: true })
  tick(3)
  equipElytra(bot, client)
  await bot.elytraFly()
  tick()
  client.receive('set_entity_data', glidingData(bot, true))
  tick(2)
  assert.strictEqual(bot.entity.elytraFlying, true)
  return created
}

function correctTo (client, entry) {
  const { pos, vel, onGround } = entry.state
  client.receive('correct_player_move_prediction', { prediction_type: 'player', position: { x: pos.x, y: pos.y + EYE, z: pos.z }, delta: { x: vel.x, y: vel.y, z: vel.z }, rotation: { x: 0, z: 0 }, on_ground: onGround, tick: entry.tick })
}

describe('wave-3 fix-ups (W3-FIX-A): physics, flight, lifecycle, abilities', function () {
  this.timeout(30000)

  it('abilities.js is the single flight source: game mode changes and repeated update_abilities give one abilities event, no request_ability', async () => {
    const { bot, client, tick } = await spawned()
    const self = bot._bedrock.ids.selfUniqueId()
    const mode = (gamemode) => client.receive('update_player_game_type', { gamemode, player_unique_id: self, tick: 0n })
    // the layers BDS sends (measured): creative flying, survival (nothing), spectator (its own layer: may_fly cleared)
    const creativeFlying = abilitiesPacket(bot, { flying: true, may_fly: true, instant_build: true, invulnerable: true }, 0.1)
    const survival = abilitiesPacket(bot, {}, 0.1)
    const spectator = abilitiesPacket(bot, {}, 0.1)
    spectator.abilities.unshift({ type: 'spectator', allowed: ALLOWED, enabled: { invulnerable: true, flying: true, no_clip: true }, fly_speed: 0, vertical_fly_speed: 0, walk_speed: 0 })
    // creative + flying (resetState: startFlying → request → BDS grants it, twice)
    mode('creative')
    bot.creative.startFlying()
    tick()
    assert.strictEqual(client.sent('request_ability').length, 1)
    const seen = []
    bot.on('abilities', (a) => seen.push(a))
    client.receive('update_abilities', creativeFlying)
    client.receive('update_abilities', creativeFlying)
    assert.strictEqual(seen.length, 1, 'the repeated update_abilities changes nothing')
    assert.strictEqual(bot.abilities.flying, true)
    assert.strictEqual(bot._bedrock.physics.isFlying(), true)
    tick()
    close(bot._bedrock.physics.history().at(-1).input.flySpeed, 0.1, 1e-6, 'physics reads bot.abilities.flyingSpeed')
    // survival: derived at once, then BDS's own update_abilities with the same values
    client.clearSent()
    seen.length = 0
    mode('survival')
    const derived = bot.abilities
    assert.strictEqual(bot._bedrock.physics.isFlying(), false)
    client.receive('update_abilities', survival)
    await Promise.resolve()
    assert.deepStrictEqual(seen, [derived], 'one abilities event per game mode change')
    assert.strictEqual(bot.abilities, derived, 'the object stays')
    assert.deepStrictEqual([derived.mayFly, derived.instantBuild, derived.invulnerable, derived.flying], [false, false, false, false])
    tick(30)
    assert.strictEqual(client.sent('request_ability').length, 0, 'no request_ability for a server-side change')
    assert.ok(client.sent('player_auth_input').some((p) => p.input_data.includes('stop_flying')))
    await assert.rejects(bot._bedrock.physics.flyTo(bot.entity.position.offset(0, 2, 0)), /not allowed/)
    // a refused request: BDS answers with the unchanged abilities (no event): the flight stops at once
    bot.creative.startFlying()
    tick()
    assert.strictEqual(bot._bedrock.physics.isFlying(), true, 'predicted')
    client.receive('update_abilities', survival)
    await Promise.resolve()
    assert.strictEqual(bot._bedrock.physics.isFlying(), false, 'refused')
    // spectator: Java-like derived abilities, then BDS's layers (may_fly cleared, flying): the bot keeps flying
    client.clearSent()
    seen.length = 0
    mode('spectator')
    assert.deepStrictEqual([seen[0].mayFly, seen[0].flying, seen[0].invulnerable, seen[0].instantBuild], [true, true, true, false])
    client.receive('update_abilities', spectator)
    client.receive('update_abilities', spectator)
    await Promise.resolve()
    assert.strictEqual(seen.length, 2)
    assert.deepStrictEqual([bot.abilities.mayFly, bot.abilities.flying], [false, true])
    assert.strictEqual(bot._bedrock.physics.isFlying(), true)
    assert.strictEqual(bot.entity.flying, true)
    tick(30)
    assert.strictEqual(client.sent('request_ability').length, 0)
    // a flight the client asks for still sends request_ability
    mode('creative')
    bot.creative.stopFlying()
    tick()
    assert.deepStrictEqual(client.sent('request_ability').map((p) => p.bool_value), [false])
  })

  it('a firework boost survives a correction that rewinds to before it started (and a pending rocket survives replays)', async () => {
    const { bot, client, tick } = await gliding()
    const before = bot._bedrock.physics.history().at(-1)
    bot.fireworkRocketDuration = 20 // entities.js: the bot's rocket spawned between two ticks
    tick(4)
    assert.strictEqual(bot.fireworkRocketDuration, 16)
    const boosted = bot.entity.velocity.norm()
    assert.ok(boosted > 1, `boosted ${boosted}`)
    assert.strictEqual(bot._bedrock.physics.history().at(-4).input.fireworkStart, 20, 'the start is recorded in the input')
    // the server corrects the last tick before the boost (its state equals our prediction)
    correctTo(client, before)
    assert.strictEqual(bot.fireworkRocketDuration, 16, 'replayed with the boost')
    close(bot.entity.velocity.norm(), boosted, 1e-6)
    tick(3)
    assert.strictEqual(bot.fireworkRocketDuration, 13)
    // a rocket started after the last input: a correction before the next tick keeps it for that tick
    const last = bot._bedrock.physics.history().at(-1)
    bot.fireworkRocketDuration = 30
    correctTo(client, bot._bedrock.physics.history().at(-3))
    assert.strictEqual(bot.fireworkRocketDuration, 30, 'not lowered by the replay')
    tick()
    assert.strictEqual(bot._bedrock.physics.history().at(-1).input.fireworkStart, 30)
    assert.strictEqual(bot.fireworkRocketDuration, 29)
    assert.ok(bot._bedrock.physics.history().at(-1).tick > last.tick)
    // a new rocket that sets the very value the countdown has (usedFirework) is a start too
    bot.fireworkRocketDuration = 29
    bot.emit('usedFirework', 99)
    tick()
    assert.strictEqual(bot._bedrock.physics.history().at(-1).input.fireworkStart, 29)
    assert.strictEqual(bot.fireworkRocketDuration, 28)
    // teleport with inputs in flight: replayed from the duration at the server's tick, not lowered twice
    const lastTick = bot._bedrock.input.lastTick
    tick(2)
    client.receive('move_player', { runtime_id: bot._bedrock.ids.selfRuntimeId(), position: { x: 0.5, y: -10 + EYE, z: 0.5 }, pitch: 0, yaw: 270, head_yaw: 270, mode: 'teleport', on_ground: false, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 0 }, tick: lastTick })
    assert.strictEqual(bot.fireworkRocketDuration, 27, 'the in-flight tick after the unsimulated one boosted once')
  })

  it('a raised shield (usingHeldItem without click_air: plain sneak on Bedrock) gets no item-use clamp; a click_air use does', async () => {
    const run = async (setup) => {
      const { bot, tick, inputs } = await spawned()
      await bot.look(-Math.PI / 2, 0, true) // east
      setup(bot)
      bot.setControlState('forward', true)
      tick(30)
      const xs = inputs().slice(-2).map((p) => p.position.x)
      return xs[1] - xs[0]
    }
    const sneak = await run((bot) => bot.setControlState('sneak', true))
    // inventory.js activateItem(true) with an off-hand shield: usingHeldItem + raiseShield (sneak), no click_air
    const shield = await run((bot) => { bot.usingHeldItem = true; bot.setControlState('sneak', true) })
    const eating = await run((bot) => { bot.usingHeldItem = true; transactions.useItem(bot) })
    close(shield, sneak, 1e-9, 'shield = plain sneak')
    close(sneak, 0.0648, 1e-3)
    close(eating, 0.0264, 1e-3, 'item use clamp')
    // the server's use ends with completed_using_item (inventory.js clears usingHeldItem): a shield raised before the
    // next tick is not an item use
    const { bot, client, tick, inputs } = await spawned()
    await bot.look(-Math.PI / 2, 0, true)
    bot.usingHeldItem = true
    transactions.useItem(bot)
    client.receive('completed_using_item', { used_item_id: 0, use_method: 'eat' })
    assert.strictEqual(bot.usingHeldItem, false)
    bot.usingHeldItem = true
    bot.setControlState('sneak', true)
    bot.setControlState('forward', true)
    tick(30)
    const xs = inputs().slice(-2).map((p) => p.position.x)
    close(xs[1] - xs[0], sneak, 1e-9)
  })

  it('End exit: change_dimension at the spawn search height spawns only once respawn state 1 placed the bot', async () => {
    const { bot, client } = await spawned()
    const SELF = bot._bedrock.ids.selfRuntimeId()
    const events = []
    for (const e of ['spawn', 'forcedMove']) bot.on(e, () => events.push([e, bot.entity.position.y]))
    client.receive('show_credits', { runtime_entity_id: SELF, status: 0 })
    client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: 0n })
    client.receive('change_dimension', { dimension: 0, position: { x: 0, y: 32767, z: 0 }, respawn: true, loading_screen_id: 12 })
    assert.notStrictEqual(bot.entity.position.y, 32767, 'the search height is no position')
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.deepStrictEqual(client.sent('serverbound_loading_screen').map((p) => p.type), [1, 2], 'acks at once')
    assert.deepStrictEqual(events, [], 'no spawn before the position')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'changing_dimension')
    client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 0.5, y: -60 + EYE, z: 0.5 }, state: 1, runtime_entity_id: 0n })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'spawn'])
    close(events[1][1], -60, 1e-6, "'spawn' at the real position")
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
    // the state 1 may also come before the server's ack: spawn at the ack
    events.length = 0
    client.receive('change_dimension', { dimension: 0, position: { x: 0, y: 32767, z: 0 }, respawn: true, loading_screen_id: 13 })
    client.receive('respawn', { position: { x: 2.5, y: -60 + EYE, z: 2.5 }, state: 1, runtime_entity_id: 0n })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove'])
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'spawn'])
    // a real feet position (portals, /tp) spawns at the ack as before
    events.length = 0
    client.receive('change_dimension', { dimension: 1, position: { x: 0.5, y: 70, z: 0.5 }, respawn: false, loading_screen_id: 14 })
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'spawn'])
  })

  it('End exit without the respawn state 1: spawns after the fallback timeout', async function () {
    this.timeout(SPAWN_POSITION_TIMEOUT_MS + 5000)
    const { bot, client } = await spawned()
    const SELF = bot._bedrock.ids.selfRuntimeId()
    let spawns = 0
    bot.on('spawn', () => spawns++)
    client.receive('change_dimension', { dimension: 0, position: { x: 0, y: 32767, z: 0 }, respawn: true, loading_screen_id: 3 })
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    assert.strictEqual(spawns, 0)
    await new Promise((resolve) => setTimeout(resolve, SPAWN_POSITION_TIMEOUT_MS + 100))
    assert.strictEqual(spawns, 1)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
  })

  it('a respawn into another dimension whose respawn state 1 is still at the search height spawns at the next real position', async () => {
    const { bot, client } = await spawned()
    const SELF = bot._bedrock.ids.selfRuntimeId()
    client.receive('change_dimension', { dimension: 1, position: { x: 8.5, y: 70, z: 8.5 }, respawn: false, loading_screen_id: 3 })
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    const events = []
    for (const e of ['spawn', 'forcedMove']) bot.on(e, () => events.push([e, bot.entity.position.y]))
    // death in the nether (observed: change_dimension at the search height without loading screen id)
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
    client.receive('respawn', { position: { x: 8.5, y: 71.62, z: 8.5 }, state: 0, runtime_entity_id: 0n })
    client.receive('change_dimension', { dimension: 0, position: { x: 0, y: 32767, z: 0 }, respawn: false })
    client.receive('player_action', { runtime_entity_id: SELF, action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 0, y: 32768.62, z: 0 }, state: 1, runtime_entity_id: 0n })
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'respawn', data: 0 })
    client.receive('set_health', { health: 20 })
    assert.strictEqual(bot.isAlive, true)
    assert.deepStrictEqual(events, [], 'no spawn (nor a move) at the search height')
    assert.strictEqual(bot._bedrock.lifecycle.state, 'respawning')
    client.receive('move_player', { runtime_id: SELF, position: { x: 0.5, y: -60 + EYE, z: 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'reset', on_ground: true, ridden_runtime_id: 0, tick: bot._bedrock.input.lastTick })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'spawn'])
    close(events[1][1], -60, 1e-6)
    assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
    // the search height may also come as a move_player after a real respawn state 1
    events.length = 0
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'death_animation', data: 0 })
    client.receive('respawn', { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: 0n })
    client.receive('respawn', { position: { x: 0.5, y: -58.38, z: 0.5 }, state: 1, runtime_entity_id: 0n })
    client.receive('move_player', { runtime_id: SELF, position: { x: 0, y: 32768.62, z: 0 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'reset', on_ground: false, ridden_runtime_id: 0, tick: bot._bedrock.input.lastTick })
    client.receive('entity_event', { runtime_entity_id: SELF, event_id: 'respawn', data: 0 })
    client.receive('set_health', { health: 20 })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'forcedMove'], 'no spawn at the search height')
    client.receive('move_player', { runtime_id: SELF, position: { x: 0.5, y: -60 + EYE, z: 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'reset', on_ground: true, ridden_runtime_id: 0, tick: bot._bedrock.input.lastTick })
    assert.deepStrictEqual(events.map(([e]) => e), ['forcedMove', 'forcedMove', 'forcedMove', 'spawn'])
    close(events[3][1], -60, 1e-6)
  })

  it('sneak / sprint before a click: useItemOn / useOnEntity / afterControlsSent wait for the player_auth_input that carries them', async () => {
    const { bot, client, tick, names } = await spawned()
    const physics = bot._bedrock.physics
    const block = { position: new Vec3(3, -61, 0), face: 1, stopDelay: 0 }
    // nothing pending: queued synchronously, as before
    assert.strictEqual(physics.controlsPending(), false)
    client.clearSent()
    const now = transactions.useItemOn(bot, block)
    assert.deepStrictEqual(names(), ['player_action', 'inventory_transaction', 'player_action'])
    await now
    // sneak, then click at once: the click follows the input with start_sneaking
    client.clearSent()
    bot.setControlState('sneak', true)
    assert.strictEqual(physics.controlsPending(), true)
    const placed = transactions.useItemOn(bot, block)
    await Promise.resolve()
    assert.deepStrictEqual(names(), [])
    tick()
    await placed
    assert.deepStrictEqual(names().slice(0, 3), ['player_auth_input', 'player_action', 'inventory_transaction'])
    assert.ok(client.sent('player_auth_input')[0].input_data.includes('start_sneaking'))
    assert.strictEqual(physics.controlsPending(), false)
    // sprint before an attack (entities.js: afterControlsSent)
    client.clearSent()
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    const target = { id: 77, runtimeId: 77n }
    const attacked = transactions.useOnEntity(bot, target, { action: 'attack' })
    let ran = false
    physics.afterControlsSent(() => { ran = true })
    assert.strictEqual(ran, false)
    tick()
    await attacked
    assert.strictEqual(ran, true)
    assert.deepStrictEqual(names().slice(0, 2), ['player_auth_input', 'inventory_transaction'])
    assert.ok(client.sent('player_auth_input')[0].input_data.includes('sprint_down'), 'the sprint key (no sprinting while sneaking)')
    // a change from a physicsTick listener (after this tick's input was built) waits for the next input
    client.clearSent()
    let clicked = null
    bot.once('physicsTick', () => {
      bot.setControlState('sneak', false)
      clicked = transactions.useItemOn(bot, block)
    })
    tick()
    await Promise.resolve()
    assert.deepStrictEqual(names(), ['player_auth_input'])
    tick()
    await clicked
    assert.deepStrictEqual(names().slice(0, 4), ['player_auth_input', 'player_auth_input', 'player_action', 'inventory_transaction'])
    assert.ok(client.sent('player_auth_input')[1].input_data.includes('stop_sneaking'))
    // toggled back before the next input: nothing to wait for
    bot.setControlState('sneak', true)
    bot.setControlState('sneak', false)
    assert.strictEqual(physics.controlsPending(), false)
    bot.clearControlStates()
  })

  it('pending clicks: sent at once when the input gets suspended, dropped (controlsSent rejects) when the bot ends', async () => {
    const { bot, client, names } = await spawned()
    const physics = bot._bedrock.physics
    bot.setControlState('sneak', true)
    let ran = false
    physics.afterControlsSent(() => { ran = true })
    client.clearSent()
    const clicked = transactions.useItemOn(bot, { position: new Vec3(3, -61, 0), face: 1, stopDelay: 0 })
    // a dimension change suspends the input before the sneak went out
    client.receive('change_dimension', { dimension: 1, position: { x: 0.5, y: 70, z: 0.5 }, respawn: false, loading_screen_id: 9 })
    await clicked
    assert.strictEqual(ran, true)
    assert.ok(names().includes('inventory_transaction'))
    assert.strictEqual(physics.controlsPending(), false, 'nothing can be sent while suspended')
    client.receive('player_action', { runtime_entity_id: bot._bedrock.ids.selfRuntimeId(), action: 'dimension_change_ack', position: ZERO, result_position: ZERO, face: 0 })
    // the bot ends with a click waiting (the sneak never went out: sprint is the pending change now)
    bot.setControlState('sprint', true)
    assert.strictEqual(physics.controlsPending(), true)
    let late = false
    physics.afterControlsSent(() => { late = true })
    const waiting = physics.controlsSent()
    bot.end('test')
    await assert.rejects(waiting, /bot ended/)
    assert.strictEqual(late, false)
  })

  it('riding: every input reports the vehicle seat (vehicle wire position + rider_seat_position), vehicle corrections included', async () => {
    const { bot, client, tick, last } = await spawned()
    const SELF = bot._bedrock.ids.selfRuntimeId()
    const seat = (x, y, z) => client.receive('set_entity_data', { runtime_entity_id: SELF, metadata: [{ key: 'rider_seat_position', type: 'vec3f', value: { x, y, z } }], properties: { ints: [], floats: [] }, tick: 0n })
    // a boat (wire y = feet + 0.375) with BDS's boat seat (measured: rider feet 0.225 below the boat's feet)
    seat(0, 1.02, 0)
    const boat = { id: 77, runtimeId: 77n, uniqueId: -77n, name: 'boat', yaw: Math.PI, pitch: 0, position: new Vec3(2.7, -61, 0.7) }
    bot.vehicle = boat
    bot.emit('mount')
    tick()
    close(last().position.y, -61 + 0.375 + 1.02, 1e-6, 'eye level')
    close(last().position.x, 2.7, 1e-9)
    close(bot.entity.position.y, -61 - 0.225, 1e-6, 'bot.entity.position follows')
    boat.position = new Vec3(5, -60.5, 0.7) // move_entity
    tick()
    close(last().position.x, 5, 1e-9)
    // BDS's vehicle correction is newer than the last move_entity
    client.receive('correct_player_move_prediction', { prediction_type: 'vehicle', position: { x: 6, y: -60.1, z: 0.7 }, delta: { x: 0.3, y: 0, z: 0 }, rotation: { x: 0, z: 0 }, on_ground: false, tick: bot._bedrock.input.lastTick })
    tick()
    close(last().position.x, 6, 1e-6)
    close(last().position.y, -60.1 + 1.02, 1e-5)
    boat.position = new Vec3(6.3, -60.475, 0.7)
    tick()
    close(last().position.x, 6.3, 1e-9)
    bot.vehicle = null
    bot.emit('dismount', boat)
    tick()
    close(last().position.x, 6.3, 1e-5, 'the rider gets off at the seat, not where it mounted')
    // a horse: seat (0, 2.32, -0.2) in its frame, facing south (yaw π) → 0.2 to the north
    seat(0, 2.32, -0.2)
    const horse = { id: 78, runtimeId: 78n, uniqueId: -78n, name: 'horse', yaw: Math.PI, pitch: 0, position: new Vec3(0.5, -60, 4.5) }
    bot.vehicle = horse
    bot.emit('mount')
    tick()
    close(bot.entity.position.y, -60 + 0.7, 1e-6)
    close(bot.entity.position.z, 4.3, 1e-6)
    close(bot.entity.position.x, 0.5, 1e-9)
  })

  it('look / lookAt from a physicsTick or move listener resolve once the new rotation was sent', async () => {
    const { bot, tick, last } = await spawned()
    let resolved = null
    bot.once('physicsTick', () => { bot.look(Math.PI / 2, 0).then(() => { resolved = last().yaw }) })
    tick()
    await Promise.resolve()
    assert.strictEqual(resolved, null, 'the input of this tick was built before the listener turned the bot')
    tick()
    await new Promise(setImmediate)
    close(resolved, 90, 1e-3, 'resolved after the input with the new yaw')
    // from a 'move' listener (onSent emits move before the look task check)
    resolved = null
    let started = false
    bot.on('move', function onMove () {
      if (started) return
      started = true
      bot.removeListener('move', onMove)
      bot.look(-Math.PI / 2, 0).then(() => { resolved = last().yaw })
    })
    bot.setControlState('forward', true)
    tick()
    await new Promise(setImmediate)
    assert.strictEqual(resolved, null)
    tick()
    await new Promise(setImmediate)
    close(resolved, 270, 1e-3)
    bot.clearControlStates()
  })

  it('a jump queued between ticks survives corrections, knockback and teleport replays', async () => {
    const { bot, client, tick, last } = await spawned()
    tick(3)
    const entry = bot._bedrock.physics.history().at(-3)
    // tap jump between two ticks (pathfinder toggles per tick)
    bot.setControlState('jump', true)
    bot.setControlState('jump', false)
    assert.strictEqual(bot.jumpQueued, true)
    correctTo(client, entry)
    assert.strictEqual(bot.jumpQueued, true, 'kept by the correction replay')
    client.receive('set_entity_motion', { runtime_entity_id: bot._bedrock.ids.selfRuntimeId(), velocity: { x: 0, y: 0, z: 0 }, tick: bot._bedrock.input.lastTick - 2n })
    assert.strictEqual(bot.jumpQueued, true, 'kept by the knockback replay')
    tick()
    assert.ok(last().input_data.includes('start_jumping'), 'and jumped')
    close(bot.entity.position.y, -60 + 0.42, 1e-5)
    tick(20)
    bot.setControlState('jump', true)
    bot.setControlState('jump', false)
    client.receive('move_player', { runtime_id: bot._bedrock.ids.selfRuntimeId(), position: { x: 0.5, y: -60 + EYE, z: 0.5 }, pitch: 0, yaw: 0, head_yaw: 0, mode: 'teleport', on_ground: true, ridden_runtime_id: 0, teleport: { cause: 'command', source_entity_type: 0 }, tick: bot._bedrock.input.lastTick - 2n })
    assert.strictEqual(bot.jumpQueued, true, 'kept by the teleport replay')
  })

  it('creative.startFlying leaves bot.physics.gravity alone (flight refused → the bot still falls)', async () => {
    const { bot, tick } = await spawned()
    const gravity = bot.physics.gravity
    bot._bedrock.physics.setPosition(new Vec3(0.5, -50, 0.5), { forced: true })
    bot.creative.startFlying() // survival: the server never grants it
    assert.strictEqual(bot.physics.gravity, gravity)
    tick(25)
    assert.strictEqual(bot._bedrock.physics.isFlying(), false, 'request dropped')
    const y = bot.entity.position.y
    tick(10)
    assert.ok(bot.entity.position.y < y - 1, `falls: ${y} → ${bot.entity.position.y}`)
    assert.strictEqual(bot.physics.gravity, gravity)
  })

  it('a throwing physicsTick listener: the input is still sent, no duplicate history tick, the error is emitted', async () => {
    const { bot, tick, inputs, errors } = await spawned()
    const boom = new Error('listener bug')
    const throwing = () => { throw boom }
    bot.on('physicsTick', throwing)
    const before = inputs().length
    tick(5)
    bot.removeListener('physicsTick', throwing)
    assert.strictEqual(inputs().length, before + 5)
    assert.strictEqual(errors.filter((e) => e === boom).length, 5)
    const ticks = bot._bedrock.physics.history().map((h) => h.tick)
    assert.strictEqual(new Set(ticks).size, ticks.length)
    const sent = inputs().slice(-5).map((p) => p.tick)
    for (let i = 1; i < sent.length; i++) assert.strictEqual(sent[i], sent[i - 1] + 1n)
  })

  it('creative.setInventorySlot entry: plain firework rockets / banners / firework stars get the default variant; enchanted books stay exact', async () => {
    const { bot } = await spawned()
    const Item = require('prismarine-item')(bot.registry)
    const index = bot._bedrock.creativeItems
    const rocket = index.entryFor(new Item(bot.registry.itemsByName.firework_rocket.id, 64))
    assert.ok(rocket, 'a plain rocket')
    assert.strictEqual(rocket.item.nbt.value.Fireworks.value.Flight.value, 1)
    assert.deepStrictEqual(rocket.item.nbt.value.Fireworks.value.Explosions.value.value, [])
    const banner = index.entryFor(new Item(bot.registry.itemsByName.banner.id, 1, 0))
    assert.strictEqual(banner?.item.nbt.value.Type.value, 0)
    assert.ok(index.entryFor(new Item(bot.registry.itemsByName.firework_star.id, 1, 0)))
    assert.strictEqual(index.entryFor(new Item(bot.registry.itemsByName.enchanted_book.id, 1)), null, 'no single default enchanted book')
    // the default is the structurally smallest NBT, not the shortest text: ties are refused
    const { nbtSize } = require('../../lib/plugins/creative')
    const tag = (value) => ({ type: 'compound', name: '', value })
    assert.strictEqual(nbtSize(tag({ Fireworks: tag({ Explosions: { type: 'list', value: { type: 'end', value: [] } }, Flight: { type: 'byte', value: 1 } }) })), 4)
    assert.strictEqual(nbtSize(tag({ Fireworks: tag({ Explosions: { type: 'list', value: { type: 'compound', value: [{ FireworkType: { type: 'byte', value: 0 } }] } }, Flight: { type: 'byte', value: 1 } }) })), 6)
    // exact matches first, as before
    const red = index.entries.find((e) => e.item.name === 'firework_rocket' && e.item.nbt.value.Fireworks.value.Explosions.value.value.length > 0)
    assert.strictEqual(index.entryFor(new Item(red.item.type, 1, 0, JSON.parse(JSON.stringify(red.item.nbt)))), red)
  })

  it('entityElytraFlew(bot.entity) fires when the server confirms a bot.elytraFly() glide (once)', async () => {
    const { bot, client, tick } = await spawned()
    const flew = []
    bot.on('entityElytraFlew', (e) => flew.push(e))
    bot._bedrock.physics.setPosition(new Vec3(0.5, -20, 0.5), { forced: true })
    tick(3)
    equipElytra(bot, client)
    await bot.elytraFly()
    assert.strictEqual(bot.entity.elytraFlying, true, 'predicted at once')
    assert.deepStrictEqual(flew, [])
    tick()
    client.receive('set_entity_data', glidingData(bot, true))
    assert.deepStrictEqual(flew, [bot.entity])
    tick()
    client.receive('set_entity_data', glidingData(bot, true))
    assert.strictEqual(flew.length, 1)
    client.receive('set_entity_data', glidingData(bot, false))
    client.receive('set_entity_data', glidingData(bot, true))
    assert.strictEqual(flew.length, 2, 'a new glide')
    // a death ends the glide even without a gliding = false
    bot.emit('death')
    client.receive('set_entity_data', glidingData(bot, true))
    assert.strictEqual(flew.length, 3)
  })
})
