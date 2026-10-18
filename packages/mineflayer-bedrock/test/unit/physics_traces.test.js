'use strict'
// owner: U5 (physics & movement) — offline regression on movement traces recorded against BDS 1.26.51.1
// (test/fixtures/physics/*.json.gz): every sent position was offset by +5 so that the server never adopted it and each
// correct_player_move_prediction carries the server's own simulation state (about every 6 ticks). Between two such
// states (or a teleport and a state) the engine, fed the recorded inputs, must land on the server's state.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')
const { Vec3 } = require('vec3')
const { Physics } = require('../../lib/physics')
const { createWorld } = require('./helpers/physics_world')

const DIR = path.join(__dirname, '../fixtures/physics')
const CONTROLS = ['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak']

/**
 * Per-trace limits: `pos` = largest position error over the verified intervals (blocks), `share` = share of intervals
 * that must match within 1e-3. Exact scenarios match to float precision; the others carry the residuals listed in
 * docs/differences/U5.md#residuals.
 */
const LIMITS = {
  default: { pos: 2e-3, share: 1 },
  // the column surface (launch out of the water) and the switch to magma are not reproduced offline
  bubble2: { pos: 3, share: 0.6 },
  // the server ends the glide when the elytra is taken off at the end of the recording
  elyprobe: { pos: 0.7, share: 0.95 },
  // landing on honey while jumping (first tick of the step-on slowdown)
  honey: { pos: 0.8, share: 0.8 },
  // the recording ends by filling the lava pool with dirt around the player (BDS pushes it out)
  lava: { pos: 0.25, share: 0.97 },
  // sinking into powder snow: < 2 mm per 6 ticks
  powdersnow: { pos: 2e-3, share: 0.85 },
  // slime bounce heights are fitted within 1 cm
  slime: { pos: 0.012, share: 0.9 }
}

function load (file) {
  return JSON.parse(zlib.gunzipSync(fs.readFileSync(path.join(DIR, file))).toString('utf8'))
}

function replay (trace, limits) {
  const ticks = new Map(trace.ticks.map((t) => [BigInt(t[0]), t]))
  const motions = new Map()
  for (const [tick, lastSent, x, y, z] of trace.motions) {
    const at = BigInt(tick) > 0n ? BigInt(tick) + 1n : BigInt(lastSent) + 1n
    motions.set(at, new Vec3(x, y, z))
  }
  const effectEvents = trace.effects.map(([tick, lastSent, id, amplifier, event]) => ({ from: (BigInt(tick) > 0n ? BigInt(tick) : BigInt(lastSent)) + 1n, id, amplifier, event }))
  const anchors = []
  for (const c of trace.corrections) anchors.push({ kind: 'correction', at: BigInt(c[0]), pos: c.slice(1, 4), vel: c.slice(4, 7), onGround: !!c[7] })
  for (const t of trace.teleports) {
    const tick = BigInt(t[0])
    const lastSent = BigInt(t[1])
    anchors.push({ kind: 'teleport', at: tick === lastSent ? lastSent + 1n : lastSent, pos: t.slice(2, 5), vel: [0, 0, 0], onGround: !!t[5] })
  }
  anchors.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.kind === 'teleport' ? -1 : 1))

  const results = []
  for (let i = 1; i < anchors.length; i++) {
    const from = anchors[i - 1]
    const to = anchors[i]
    if (to.kind !== 'correction' || to.at <= from.at) continue
    const world = createWorld()
    for (const [tick, cmd] of trace.cmds) if (tick === null || BigInt(tick) <= from.at) world.command(cmd)
    const physics = Physics(world.registry, world)
    const rec0 = ticks.get(from.at)
    const state = {
      pos: new Vec3(...from.pos),
      vel: new Vec3(...from.vel),
      onGround: from.onGround,
      jumpTicks: rec0 ? rec0[12] : 0,
      control: {},
      yaw: 0,
      pitch: 0,
      attributes: {}
    }
    let complete = true
    for (let t = from.at + 1n; t <= to.at; t++) {
      const rec = ticks.get(t)
      if (!rec) { complete = false; break }
      const [, bits, yaw, pitch, mvx, mvz, flying, gliding, skip, simulated, effects, speed] = rec
      if (skip || !simulated) continue
      state.control = Object.fromEntries(CONTROLS.map((c, k) => [c, !!(bits & (1 << k))]))
      state.yaw = yaw
      state.pitch = pitch
      state.moveVector = { x: mvx, z: mvz }
      state.flying = !!flying
      state.flySpeed = 0.05
      state.elytraFlying = !!gliding
      state.elytraEquipped = true
      const levels = effectLevels(effects, effectEvents, t)
      state.jumpBoost = levels[8] ?? 0
      state.slowFalling = levels[27] ?? 0
      state.levitation = levels[24] ?? 0
      state.attributes = speed ? { 'minecraft:movement_speed': { value: speed[0], modifiers: speed[1].map(([uuid, amount, operation, name]) => ({ uuid, amount, operation, name })) } } : {}
      if (motions.has(t)) state.vel = motions.get(t).clone()
      physics.simulatePlayer(state, world)
    }
    if (!complete) continue
    const error = state.pos.distanceTo(new Vec3(...to.pos))
    results.push({ from: from.at, to: to.at, error })
  }
  return results
}

/** effect levels (amplifier + 1) for tick t: from the mob_effect events (applied from the input after their tick) */
function effectLevels (logged, events, t) {
  if (!events.length) return Object.fromEntries(Object.entries(logged).map(([id, amp]) => [id, amp + 1]))
  const levels = {}
  for (const e of events) {
    if (e.from > t) continue
    if (e.event === 'remove') delete levels[e.id]
    else levels[e.id] = e.amplifier + 1
  }
  return levels
}

describe('physics traces (U5): the engine reproduces BDS 1.26.51.1 states offline', function () {
  this.timeout(120000)
  const files = fs.existsSync(DIR) ? fs.readdirSync(DIR).filter((f) => f.endsWith('.json.gz')).sort() : []

  it('has recorded traces', () => {
    assert.ok(files.length >= 10, `${files.length} traces`)
  })

  for (const file of files) {
    const name = file.replace(/\.json\.gz$/, '')
    it(`${name}`, () => {
      const trace = load(file)
      const limits = LIMITS[name] ?? LIMITS.default
      const results = replay(trace, limits)
      assert.ok(results.length >= 3, `${results.length} verified intervals`)
      const worst = results.reduce((a, b) => (b.error > a.error ? b : a))
      const exact = results.filter((r) => r.error <= 1e-3).length / results.length
      if (process.env.U5_TRACE_STATS) console.log(name, results.length, 'intervals, exact', exact.toFixed(3), 'worst', worst.error.toFixed(5), 'sorted', results.map((r) => r.error).sort((a, b) => b - a).slice(0, 5).map((e) => e.toFixed(4)).join(' '))
      assert.ok(worst.error <= limits.pos, `worst interval ${worst.from}→${worst.to}: ${worst.error.toFixed(5)} (limit ${limits.pos})`)
      assert.ok(exact >= limits.share, `${(exact * 100).toFixed(1)}% of ${results.length} intervals within 1e-3 (limit ${limits.share * 100}%)`)
    })
  }
})
