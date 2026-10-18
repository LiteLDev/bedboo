'use strict'
// owner: U5 (physics & movement) — the Bedrock engine (lib/physics) on offline worlds, with the values measured on
// BDS 1.26.51.1 (docs/differences/U5.md#engine), and the internalTest physics analogs.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { Physics, PlayerState, defaultPhysicsFields } = require('../../lib/physics')
const { moveVector, buildFlags } = require('../../lib/physics/input')
const { createWorld, playerState, YAW } = require('./helpers/physics_world')

const close = (a, b, eps = 1e-4, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg ?? ''} ${a} ≉ ${b}`)

function run (physics, world, state, ticks, each) {
  for (let i = 0; i < ticks; i++) {
    if (each) each(state, i)
    physics.simulatePlayer(state, world)
  }
  return state
}

describe('physics engine (U5): Bedrock movement', function () {
  this.timeout(20000)
  let world
  let physics
  beforeEach(() => {
    world = createWorld()
    physics = Physics(world.registry, world)
  })

  it('bot.physics shape: the 31 upstream field names with Bedrock values', () => {
    const fields = defaultPhysicsFields()
    assert.strictEqual(Object.keys(fields).length, 31)
    for (const [name, value] of Object.entries(fields)) assert.deepStrictEqual(physics[name], value, name)
    assert.strictEqual(physics.stepHeight, 0.5625)
    assert.strictEqual(physics.waterGravity, 0.005)
    assert.strictEqual(physics.sprintingUUID, 'd208fc00-42aa-4aad-9276-d5446530de43')
    assert.strictEqual(typeof physics.simulatePlayer, 'function')
    assert.strictEqual(typeof physics.adjustPositionHeight, 'function')
  })

  it('standing: velocity at the end of the tick is one gravity step; walking reaches 0.21586 blocks/tick (BDS)', () => {
    const st = playerState(new Vec3(0.5, -60, 0.5))
    run(physics, world, st, 3)
    assert.strictEqual(st.pos.y, -60)
    close(st.vel.y, -0.0784, 1e-7)
    assert.strictEqual(st.onGround, true)
    st.control.forward = true
    st.yaw = YAW.east
    let last = st.pos.x
    let step = 0
    run(physics, world, st, 40, () => { step = st.pos.x - last; last = st.pos.x })
    close(st.pos.x - last + step, 0.21586 + 0.21586, 2e-4, 'steady step')
    close(st.vel.x, 0.117858, 1e-5, 'delta = velocity after friction')
  })

  it('sprint ×1.3 (attribute modifier), sprint-jump +0.2 in the facing direction, jump 0.42 + boost, 10-tick delay', () => {
    const st = playerState(new Vec3(0.5, -60, 0.5), { forward: true, sprint: true })
    st.yaw = YAW.east
    run(physics, world, st, 60)
    close(st.vel.x, 0.117858 * 1.3, 1e-4, 'sprinting delta')
    // the server sends its sprint modifier: it is replaced by the client-side one, not stacked
    st.attributes = { 'minecraft:movement_speed': { value: 0.1, modifiers: [{ uuid: 'd208fc00-42aa-4aad-9276-d5446530de43', amount: 0.3, operation: 2, name: 'Sprinting speed boost' }] } }
    run(physics, world, st, 20)
    close(st.vel.x, 0.117858 * 1.3, 1e-4, 'no double sprint')

    const jumper = playerState(new Vec3(0.5, -60, 0.5), { jump: true })
    run(physics, world, jumper, 1)
    assert.strictEqual(jumper.jumped, true)
    close(jumper.pos.y, -60 + 0.42, 1e-5)
    close(jumper.vel.y, (0.42 - 0.08) * 0.98, 1e-6)
    const groundTicks = []
    run(physics, world, jumper, 60, (s, i) => { if (s.jumped) groundTicks.push(i) })
    assert.ok(groundTicks.length >= 4, 'keeps jumping while held')
    const boosted = playerState(new Vec3(0.5, -60, 0.5), { jump: true }, { jumpBoost: 2 })
    run(physics, world, boosted, 1)
    close(boosted.pos.y, -60 + 0.62, 1e-5)

    const sj = playerState(new Vec3(0.5, -60, 0.5), { forward: true, sprint: true, jump: true })
    sj.yaw = YAW.east
    run(physics, world, sj, 1)
    close(sj.vel.x, (0.2 + 0.13 * 0.98) * 0.91 * 0.6, 2e-3, 'sprint jump boost')
  })

  it('move vector: diagonals are normalized, sneaking scales by 0.3 (the processed vector BDS receives)', () => {
    assert.deepStrictEqual(moveVector({ forward: true }), { x: 0, z: 1 })
    const diag = moveVector({ forward: true, left: true })
    close(diag.x, Math.SQRT1_2, 1e-6)
    close(diag.z, Math.SQRT1_2, 1e-6)
    const sneak = moveVector({ forward: true, right: true, sneak: true })
    close(sneak.x, -0.3 * Math.SQRT1_2, 1e-6)
    close(sneak.z, 0.3 * Math.SQRT1_2, 1e-6)
    assert.deepStrictEqual(moveVector({ forward: true, sneak: true }, { flying: true }), { x: 0, z: 1 })
  })

  it('sneaking: edge avoidance (box shrunk by 0.025) stops before 0.275 past the edge with a zero velocity, the box is 1.49 high', () => {
    world.fill(3, -60, -2, 7, -58, 2, 'stone')
    const st = playerState(new Vec3(5.5, -57, 0.5), { forward: true, sneak: true })
    st.yaw = YAW.east
    run(physics, world, st, 120)
    assert.ok(st.pos.x > 8.2 && st.pos.x < 8.275, `stopped at the edge: ${st.pos.x}`)
    assert.strictEqual(st.vel.x, 0)
    assert.strictEqual(st.pos.y, -57)
    // 1.49 box: a sneak-jump under a 2-block ceiling rises to −59.49
    world.fill(0, -58, -1, 2, -58, 1, 'stone')
    const jumper = playerState(new Vec3(1.5, -60, 0.5), { sneak: true, jump: true })
    let top = -60
    run(physics, world, jumper, 12, (s) => { top = Math.max(top, s.pos.y) })
    close(Math.max(top, jumper.pos.y), -59.49, 1e-4)
  })

  it('auto-step 0.5625: slabs and stairs yes, a full block no; ground friction 0.6 on the walk-off tick', () => {
    world.fill(3, -60, -1, 3, -60, 1, 'smooth_stone_slab', { 'minecraft:vertical_half': 'bottom' })
    world.fill(5, -60, -1, 5, -59, 1, 'stone')
    const st = playerState(new Vec3(1.5, -60, 0.5), { forward: true })
    st.yaw = YAW.east
    const ys = []
    run(physics, world, st, 20, (s) => ys.push(s.pos.y))
    assert.ok(ys.includes(-59.5), 'stepped onto the slab')
    assert.ok(st.pos.x < 4.7 && st.isCollidedHorizontally, 'stopped by the 1.5 high wall')
    // measured: on the slab edge (centre over air) the player keeps ground speed: 2.7552 → 2.9693, delta 0.1169
    const edge = playerState(new Vec3(1.5, -60, 0.5), { forward: true })
    edge.yaw = YAW.east
    run(physics, world, edge, 8)
    close(edge.pos.x, 2.9693, 1e-3)
    close(edge.vel.x, 0.1169, 1e-3)

    const ledge = createWorld().fill(0, -60, -1, 4, -60, 1, 'stone')
    const lp = Physics(ledge.registry, ledge)
    const off = playerState(new Vec3(1.5, -59, 0.5), { forward: true })
    off.yaw = YAW.east
    let walkOff = null
    run(lp, ledge, off, 25, (s) => { if (walkOff === null && !s.onGround && s.pos.x > 5) walkOff = s.vel.x })
    close(walkOff ?? off.vel.x, 0.11786, 2e-3, 'walk-off tick keeps the ground update (BDS: 0.1178584)')
  })

  it('climbing: ladders collide with a 3/16 box, climb 0.2/tick with 0.2 kept as delta, fall at most 0.2, sneak holds', () => {
    world.fill(3, -60, -1, 3, -50, 1, 'stone')
    world.fill(2, -60, 0, 2, -51, 0, 'ladder', { facing_direction: 4 })
    const st = playerState(new Vec3(0.5, -60, 0.5), { forward: true })
    st.yaw = YAW.east
    run(physics, world, st, 30)
    close(st.pos.x, 2.5125, 1e-4, 'against the ladder box')
    assert.ok(st.pos.y > -57, `climbed: ${st.pos.y}`)
    close(st.vel.y, 0.2, 1e-6)
    const y = st.pos.y
    run(physics, world, st, 1)
    close(st.pos.y - y, 0.2, 1e-5)
    st.control = { ...st.control, forward: false, sneak: true }
    run(physics, world, st, 10)
    const held = st.pos.y
    run(physics, world, st, 10)
    close(st.pos.y, held, 1e-6, 'sneaking holds on')
  })

  it('cobweb ×0.25 / ×0.05 and velocity reset; water (gravity 0.005, terminal −0.025) and lava', () => {
    world.fill(3, -60, -1, 6, -59, 1, 'web')
    const st = playerState(new Vec3(4.5, -60, 0.5), { forward: true })
    st.yaw = YAW.east
    run(physics, world, st, 5)
    assert.strictEqual(st.isInWeb, true)
    assert.ok(st.vel.x === 0 && st.vel.z === 0, 'velocity reset in the web')
    const x = st.pos.x
    run(physics, world, st, 1)
    close(st.pos.x - x, 0.098 * 0.25, 1e-4)

    world.fill(10, -63, -3, 16, -50, 3, 'water')
    const swimmer = playerState(new Vec3(13.5, -55, 0.5))
    swimmer.onGround = false
    run(physics, world, swimmer, 60)
    assert.strictEqual(swimmer.isInWater, true)
    close(swimmer.vel.y, -0.025, 1e-3)

    world.fill(20, -63, -3, 26, -50, 3, 'lava')
    const lava = playerState(new Vec3(23.5, -55, 0.5))
    lava.onGround = false
    run(physics, world, lava, 40)
    assert.strictEqual(lava.isInLava, true)
    close(lava.vel.y, -0.04, 2e-3, 'lava terminal (0.5 drag, 0.02 gravity)')
  })

  it('soul sand ×0.544, honey and slime step-on (0.4 + |vy| × 0.2), honey jump × 0.6, slime bounce', () => {
    world.fill(-5, -61, -1, 40, -61, 1, 'soul_sand')
    const ss = playerState(new Vec3(0.5, -60.125, 0.5), { forward: true })
    ss.yaw = YAW.east
    run(physics, world, ss, 40)
    close(ss.vel.x, 0.0641143, 1e-5, 'BDS steady delta on soul sand')

    const honey = createWorld().fill(-5, -61, -1, 40, -61, 1, 'honey_block')
    const hp = Physics(honey.registry, honey)
    const hs = playerState(new Vec3(0.5, -60, 0.5), { forward: true })
    hs.yaw = YAW.east
    run(hp, honey, hs, 40)
    close(hs.vel.x, 0.0179402, 1e-5, 'BDS steady delta on honey')
    const hj = playerState(new Vec3(0.5, -60, 0.5), { jump: true })
    run(hp, honey, hj, 1)
    close(hj.pos.y + 60, 0.252, 1e-5, 'honey jump')

    const slime = createWorld().fill(-5, -61, -5, 5, -61, 5, 'slime')
    const sp = Physics(slime.registry, slime)
    const sl = playerState(new Vec3(0.5, -52, 0.5))
    sl.onGround = false
    let bounced = 0
    run(sp, slime, sl, 40, (s) => { if (s.vel.y > 0.3) bounced++ })
    assert.ok(bounced > 0, 'bounced off the slime')
    const sneaker = playerState(new Vec3(0.5, -52, 0.5), { sneak: true })
    sneaker.onGround = false
    run(sp, slime, sneaker, 40)
    assert.strictEqual(sneaker.pos.y, -60, 'sneaking does not bounce')
  })

  it('bubble columns push per block up to 0.7 (soul sand) and down to −0.3 (magma)', () => {
    world.fill(3, -63, -1, 5, -30, 1, 'glass')
    for (let y = -62; y <= -31; y++) world.set(4, y, 0, 'bubble_column', { drag_down: 0 })
    const up = playerState(new Vec3(4.5, -62, 0.5))
    run(physics, world, up, 40)
    close(up.vel.y, 0.7, 1e-6)
    for (let y = -62; y <= -31; y++) world.set(4, y, 0, 'bubble_column', { drag_down: 1 })
    run(physics, world, up, 40)
    close(up.vel.y, -0.3, 1e-6)
  })

  it('slow falling only while falling (vy < 0), levitation without drag', () => {
    const st = playerState(new Vec3(0.5, -40, 0.5), {}, { slowFalling: 1 })
    st.onGround = false
    run(physics, world, st, 1)
    close(st.vel.y, -0.0784, 1e-6, 'first tick from rest uses normal gravity (BDS)')
    run(physics, world, st, 1)
    close(st.vel.y, (-0.0784 - 0.01) * 0.98, 1e-6)
    const lev = playerState(new Vec3(0.5, -40, 0.5), {}, { levitation: 2 })
    lev.onGround = false
    run(physics, world, lev, 60)
    close(lev.vel.y, 0.1, 1e-3)
  })

  it('creative flight: +0.15 / −0.22 vertical, drag 0.6 / 0.91, idle damping 0.375 (BDS samples)', () => {
    const st = playerState(new Vec3(0.5, -40, 0.5), { sneak: true }, { flying: true, flySpeed: 0.05 })
    st.onGround = false
    run(physics, world, st, 1)
    close(st.pos.y, -40.22, 1e-5)
    close(st.vel.y, -0.132, 1e-6)
    run(physics, world, st, 6)
    close(st.vel.y, -0.320762, 1e-5)
    close(st.pos.y, -43.04809, 1e-4, 'BDS 7th tick')
    st.control = { ...st.control, sneak: false, jump: true }
    run(physics, world, st, 40)
    close(st.vel.y, 0.225, 1e-5)
    st.control = { ...st.control, jump: false }
    run(physics, world, st, 1)
    close(st.vel.y, 0.050625, 1e-6, 'idle damping')
    st.control = { ...st.control, forward: true }
    st.yaw = YAW.east
    run(physics, world, st, 150)
    close(st.vel.x, 0.049 * 0.91 / 0.09, 1e-3, 'horizontal flight terminal')
    st.control = { ...st.control, forward: false }
    const v = st.vel.x
    run(physics, world, st, 5)
    close(st.vel.x, v * Math.pow(0.91 * 0.375, 5), 1e-5)
  })

  it('elytra: glides (Java formula, matches BDS) and lands', () => {
    const st = playerState(new Vec3(0.5, -20, 0.5), {}, { elytraEquipped: true, elytraFlying: true })
    st.onGround = false
    st.yaw = YAW.east
    st.pitch = -0.2
    run(physics, world, st, 60)
    assert.strictEqual(st.elytraFlying, true)
    assert.ok(st.pos.x > 15, `glided ${st.pos.x}`)
    run(physics, world, st, 400)
    assert.strictEqual(st.elytraFlying, false, 'stops on the ground')
  })

  it('accepts upstream prismarine-physics PlayerState objects and minimal states', () => {
    const minimal = { pos: new Vec3(0, 0, 0) }
    assert.strictEqual(physics.simulatePlayer(minimal, world), minimal)
    assert.ok(minimal.vel instanceof Vec3)
    const bot = fakeBotForState()
    const UpstreamPlayerState = require('prismarine-physics').PlayerState
    const upstream = new UpstreamPlayerState(bot, { forward: true, back: false, left: false, right: false, jump: false, sprint: false, sneak: false })
    assert.strictEqual(upstream.jumpBoost, 2, 'JumpBoost read through minecraft-data(bot.version) (Bedrock effect ids)')
    physics.simulatePlayer(upstream, world)
    assert.ok(upstream.pos.x !== bot.entity.position.x || upstream.pos.z !== bot.entity.position.z, 'moved')
    const ours = new PlayerState(bot, { forward: true })
    assert.strictEqual(ours.jumpBoost, 2)
    assert.strictEqual(ours.elytraEquipped, false)
  })

  it('auth input flags: level flags while held, edges on change', () => {
    const idle = { control: {}, sprinting: false, sneaking: false }
    const walk = { control: { forward: true, sprint: true, jump: true }, sprinting: true, sneaking: false, jumped: true, onGround: true }
    const flags = buildFlags(idle, walk)
    for (const f of ['up', 'jump_down', 'jumping', 'want_up', 'jump_current_raw', 'jump_pressed_raw', 'start_jumping', 'sprint_down', 'sprinting', 'start_sprinting', 'vertical_collision']) assert.ok(flags.includes(f), f)
    const stop = buildFlags(walk, { control: { sneak: true }, sneaking: true, collidedHorizontally: true })
    for (const f of ['jump_released_raw', 'stop_sprinting', 'sneak_down', 'sneaking', 'start_sneaking', 'sneak_pressed_raw', 'horizontal_collision']) assert.ok(stop.includes(f), f)
    assert.ok(!stop.includes('up') && !stop.includes('vertical_collision'))
    const fly = buildFlags({ control: {} }, { control: { jump: true }, flying: true, gliding: true })
    for (const f of ['start_flying', 'ascend', 'start_gliding']) assert.ok(fly.includes(f), f)
    assert.ok(buildFlags({ control: {}, flying: true, gliding: true }, { control: {} }).includes('stop_flying'))
  })
})

/** just enough of a mineflayer-bedrock bot for (prismarine-physics) PlayerState */
function fakeBotForState () {
  const { createRegistry } = require('../../lib/registry')
  const registry = createRegistry()
  const windows = require('prismarine-windows')(registry)
  return {
    version: '1.26.51',
    registry,
    entity: {
      position: new Vec3(0.5, -60, 0.5),
      velocity: new Vec3(0, 0, 0),
      onGround: true,
      yaw: YAW.east,
      pitch: 0,
      attributes: {},
      effects: { 8: { id: 8, amplifier: 1, duration: 100 } }
    },
    jumpTicks: 0,
    jumpQueued: false,
    fireworkRocketDuration: 0,
    inventory: windows.createWindow(0, 'minecraft:inventory', 'Inventory')
  }
}
