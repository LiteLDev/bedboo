// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// Real-client e2e (docs/bedd.md): walking with setControlState and a pathfinder goal, lookAt, setQuickBarSlot.
const assert = require('assert')
const { withTimeout } = require('mineflayer/lib/promise_utils')
const { gate, session, need, canRunCommands, run, target, until, sleep, nextServerbound, serverPosition, prepareArena, giveHotbar } = require('./common')

const horizontal = (a, b) => Math.hypot(a.x - b.x, a.z - b.z)
const wrapDeg = (d) => ((d % 360) + 540) % 360 - 180
const deg = (rad) => rad * 180 / Math.PI

describe('bedd: movement and looking (real client)', function () {
  let s
  before(async function () {
    gate(this)
    s = await session()
  })
  afterEach(function () {
    s?.bot.clearControlStates?.()
  })

  it('lookAt turns the client', async function () {
    need(this, s, 'lookAt', ['look'])
    const { bot } = s
    const eye = bot.entity.position.offset(0, 1.62, 0)
    for (const [dx, dy, dz] of [[4, 0, 3], [-3, -2, 1], [0, 2, -5]]) {
      const point = eye.offset(dx, dy, dz)
      await bot.lookAt(point, true)
      const yaw = Math.atan2(-dx, -dz)
      const pitch = Math.atan2(dy, Math.hypot(dx, dz))
      assert.ok(Math.abs(wrapDeg(deg(bot.entity.yaw - yaw))) < 2, `yaw ${deg(bot.entity.yaw)} vs ${deg(yaw)}`)
      assert.ok(Math.abs(deg(bot.entity.pitch - pitch)) < 2, `pitch ${deg(bot.entity.pitch)} vs ${deg(pitch)}`)
      const observed = bot.bedrock?.bedd?.observed
      if (observed?.yaw !== undefined) assert.ok(Number.isFinite(observed.yaw), 'bot.bedrock.bedd.observed.yaw')
    }
    const server = await serverPosition(s)
    if (server && Number.isFinite(server.yRot)) {
      // Bedrock yaw (degrees, 0 = +Z) is mineflayer's notchian yaw
      const notchian = require('mineflayer/lib/conversions').toNotchianYaw(bot.entity.yaw)
      assert.ok(Math.abs(wrapDeg(server.yRot - notchian)) < 5, `BDS yRot ${server.yRot} vs bot ${notchian}`)
    }
  })

  it('walks 5 blocks with setControlState', async function () {
    need(this, s, 'setControlState')
    const { bot } = s
    if (canRunCommands(s)) await prepareArena(s)
    const start = bot.entity.position.clone()
    const serverStart = await serverPosition(s)
    await bot.look(bot.entity.yaw, 0, true).catch(() => {})
    bot.setControlState('forward', true)
    try {
      await until(() => horizontal(bot.entity.position, start) >= 5, { what: 'the client to walk 5 blocks', timeout: 15000 })
    } finally {
      bot.setControlState('forward', false)
    }
    assert.strictEqual(bot.getControlState('forward'), false)
    await sleep(500)
    const serverEnd = await serverPosition(s)
    if (serverStart && serverEnd) {
      assert.ok(horizontal(serverEnd.pos, serverStart.pos) >= 4, `BDS moved ${horizontal(serverEnd.pos, serverStart.pos)}`)
      assert.ok(horizontal(serverEnd.pos, bot.entity.position) < 1.5, 'BDS and bot agree')
    }
  })

  it('reaches a pathfinder goal', async function () {
    need(this, s, 'setControlState')
    const { bot } = s
    const { pathfinder, Movements, goals } = require('mineflayer-pathfinder')
    if (!bot.pathfinder) bot.loadPlugin(pathfinder)
    const movements = new Movements(bot)
    movements.canDig = false
    movements.allow1by1towers = false
    movements.allowParkour = false
    bot.pathfinder.setMovements(movements)
    let goalPos
    if (canRunCommands(s)) {
      const arena = await prepareArena(s)
      // walk to the opposite corner side of the arena from where the walk test ended
      goalPos = arena.offset(bot.entity.position.x > arena.x ? -4 : 4, 0, bot.entity.position.z > arena.z ? -4 : 4)
    } else {
      goalPos = bot.entity.position.floored().offset(4, 0, 0)
    }
    try {
      await withTimeout(bot.pathfinder.goto(new goals.GoalNear(goalPos.x, goalPos.y, goalPos.z, 1)), 45000)
    } finally {
      bot.pathfinder.stop()
    }
    assert.ok(horizontal(bot.entity.position, goalPos.offset(0.5, 0, 0.5)) < 2, `at ${bot.entity.position}, goal ${goalPos}`)
    const server = await serverPosition(s)
    if (server) assert.ok(horizontal(server.pos, goalPos.offset(0.5, 0, 0.5)) < 2.5, `BDS at ${server.pos}`)
  })

  it('setQuickBarSlot selects the hotbar slot on the client', async function () {
    need(this, s, 'setQuickBarSlot', ['slot'])
    const { bot } = s
    const canSetup = canRunCommands(s)
    if (canSetup) await giveHotbar(s, 3, 'diamond', 1)
    if (bot.quickBarSlot === 3) { // make the selection observable
      bot.setQuickBarSlot(5)
      await until(() => bot.quickBarSlot === 5, { what: 'quickBarSlot 5' })
    }
    const echo = nextServerbound(s, 'mob_equipment', (p) => p.selected_slot === 3 || p.slot === 3, 5000)
    bot.setQuickBarSlot(3)
    await echo
    assert.strictEqual(bot.quickBarSlot, 3)
    if (canSetup) assert.strictEqual(bot.heldItem?.name, 'diamond')
    if (s.console) {
      const lines = await s.console.commandOutput(`testfor @a[name=${target(s.name)},hasitem={item=diamond,location=slot.weapon.mainhand}]`)
      assert.ok(lines.some((l) => /Found/.test(l)), `BDS mainhand: ${lines.join(' | ')}`)
      await run(s, 'clear @s diamond')
    }
  })
})
