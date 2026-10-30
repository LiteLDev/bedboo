'use strict'
// owner: BEDD-3 (bedd action translation) — lib/bedd/router_actions.js and the bedd-mode gates of digging.js,
// placement.js and transactions.js, on the real createBot over a fake client that carries a hand-built client.bedd stub
// (a recording rpc) and replays the recorded BDS join (join_flat); the client's queue/write go through client.bedd.route
// like the bedd transport does.
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('../helpers/fake')
const { inventoryContent } = require('../helpers/inventory_server')
const routerActions = require('../../../lib/bedd/router_actions')
const { createRouteRegistry, markDispatch } = require('../../../lib/bedd/routes')
const { toBedrockYaw, toBedrockPitch } = require('../../../lib/bedrock/conversions')

const G = -60 // flat world ground (feet) level
const UP = new Vec3(0, 1, 0)
const settle = () => new Promise(resolve => setImmediate(resolve))
/** poll `fn` until it is truthy (real time: bedd-mode lookAt waits up to 1 s for an echo, lib/plugins/physics.js) */
async function waitFor (fn, ms = 3000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${fn}`)
    await new Promise(resolve => setTimeout(resolve, 10))
  }
}

/** a client.bedd stub: the rpc records every call and answers ok */
function beddStub (caps = { look: 'present', button: 'present' }) {
  const calls = []
  return {
    calls,
    rpc: {
      async call (op, args) {
        calls.push([op, args])
        return { ok: true }
      },
      supports: (op) => caps[op] === 'present'
    },
    caps,
    capabilities: { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true }
  }
}

async function beddBot ({ caps, mode = 'bedd' } = {}) {
  const created = await createFakeBot()
  const { bot, client, clock } = created
  const bedd = beddStub(caps)
  client.bedd = bedd
  const record = client.queue
  const routed = []
  // the bedd transport: whatever bedboo sends becomes a route call
  client.queue = client.write = (name, params) => {
    record(name, params)
    routed.push(name)
    client.bedd.route?.(name, params)
  }
  bot._bedrock.mode = mode
  created.actions = routerActions.attach(bot, client)
  await replayJoin(bot, client)
  created.tick = (n = 1) => {
    for (let i = 0; i < n; i++) {
      clock.advance(50)
      bot._bedrock.input.pump()
    }
  }
  created.tick(3) // settle on the grass
  created.bedd = bedd
  created.routed = routed
  created.idle = async () => { await settle(); await created.actions.idle(); await settle() }
  created.rid = (name) => bot.registry.runtimeIdByStateId[bot.registry.blocksByName[name].defaultState]
  created.setBlock = (pos, name) => client.receive('update_block', { position: { x: pos.x, y: pos.y, z: pos.z }, block_runtime_id: created.rid(name), flags: { _value: 3 }, layer: 0 })
  created.blockActions = () => client.sent('player_auth_input').flatMap((p) => (p.block_action ?? []).map((a) => a.action))
  bedd.calls.length = 0
  client.clearSent()
  routed.length = 0
  return created
}

function anglesTo (bot, target) {
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0)
  const d = target.minus(eye)
  return { yaw: toBedrockYaw(Math.atan2(-d.x, -d.z)), pitch: toBedrockPitch(Math.atan2(d.y, Math.hypot(d.x, d.z))) }
}

const near = (a, b, eps = 1e-6) => Math.abs((((a - b) % 360) + 540) % 360 - 180) < eps

describe('bedd action translation (BEDD-3): lib/bedd/router_actions.js', function () {
  this.timeout(30000)

  it('registry: registers block_action and inventory_transaction in the shared registry (lib/bedd/routes.js), once', async () => {
    const calls = []
    const client = { bedd: { rpc: { call: async (op, args) => { calls.push([op, args]); return { ok: true } } }, caps: { button: 'present' } } }
    const bot = { _bedrock: { mode: 'bedd' }, entities: {} }
    const routes = createRouteRegistry()
    const seen = []
    routes.register('player_auth_input', (params, ctx) => seen.push([ctx.name, params.tick]))
    client.bedd.routes = routes
    const actions = routerActions.attach(bot, client)
    assert.strictEqual(routerActions.attach(bot, client), actions, 'idempotent')
    await settle()
    assert.strictEqual(client.bedd.routes, routes, 'kept the existing registry')
    assert.strictEqual(routes.get('block_action').length, 1)
    assert.strictEqual(routes.get('inventory_transaction').length, 1)
    // without the router, ensureDispatch() installed a route that dispatches through the registry
    client.bedd.route('player_auth_input', { tick: 8n, block_action: [{ action: 'abort_break', position: { x: 0, y: 0, z: 0 }, face: 1 }] })
    await actions.idle()
    assert.deepStrictEqual(seen, [['player_auth_input', 8n]], 'the other player_auth_input handlers still get the packet')
    assert.deepStrictEqual(calls, [['button', { button: 'attack', action: 'up' }]])
    assert.doesNotThrow(() => client.bedd.route('no_such_packet', {}), 'unknown names are dropped')
    // a transaction type this module does not translate is declined (the router reports it unsupported)
    assert.strictEqual(routes.get('inventory_transaction')[0]({ transaction: { transaction_type: 'normal', transaction_data: {} } }, { name: 'inventory_transaction' }), false)

    // a route that dispatches already (the router's) is left alone
    const own = markDispatch(() => 'router')
    const other = { bedd: { rpc: { call: async () => ({}) }, caps: {}, route: own } }
    routerActions.attach(bot, other)
    assert.strictEqual(other.bedd.route, own)
    assert.ok(other.bedd.routes.has('inventory_transaction'))
    assert.strictEqual(routerActions.attach(bot, {}), null, 'no client.bedd: nothing to do')
  })

  it('dig: look at the face, attack down releaseOn:blockChange; no predict_break; update_block to air resolves and releases attack', async () => {
    const { bot, tick, idle, bedd, setBlock, blockActions } = await beddBot()
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, G, 0)
    setBlock(target, 'dirt')
    const block = bot.blockAt(target)
    const events = []
    bot.on('diggingCompleted', (b) => events.push(b.name))
    const done = bot.dig(block, true)
    await settle()
    assert.strictEqual(bot.targetDigFace, 4, 'the west face')
    tick(1)
    await idle()
    assert.deepStrictEqual(bedd.calls.map(([op]) => op), ['look', 'button'])
    const [, look] = bedd.calls[0]
    const want = anglesTo(bot, new Vec3(2.1, G + 0.5, 0.5)) // inside the block, near the west face
    assert.ok(near(look.yaw, want.yaw) && near(look.pitch, want.pitch, 1e-6), `looks at the west face: ${JSON.stringify(look)} vs ${JSON.stringify(want)}`)
    assert.deepStrictEqual(bedd.calls[1][1], { button: 'attack', action: 'down', releaseOn: 'blockChange' })
    // the client times the break: nothing else while held (15 ticks for dirt by hand, and more)
    tick(20)
    await idle()
    assert.strictEqual(bedd.calls.length, 2)
    assert.ok(!blockActions().includes('predict_break'), 'no predict_break')
    assert.ok(bot.targetDigBlock, 'waits for the server')
    setBlock(target, 'air')
    tick(1)
    await done
    await idle()
    assert.deepStrictEqual(events, ['air'])
    assert.deepStrictEqual(bedd.calls.slice(2), [['button', { button: 'attack', action: 'up' }]], 'attack released')
    assert.deepStrictEqual(blockActions(), ['start_break', 'abort_break'])
    assert.strictEqual(bot._bedrock.digging.last.outcome, 'completed')
  })

  it('dig: creative sends no predict_break; the dig gives up after digTime + 40 ticks without the server', async () => {
    const { bot, tick, idle, bedd, setBlock, blockActions } = await beddBot()
    bot.game.gameMode = 'creative'
    const target = new Vec3(2, G, 0)
    setBlock(target, 'dirt')
    const t0 = Date.now()
    const done = bot.dig(bot.blockAt(target), true)
    await settle()
    tick(1)
    await assert.rejects(done, /Digging aborted: the server did not break dirt/)
    assert.ok(Date.now() - t0 >= 1900, 'digTime 0 + 40 ticks')
    tick(1)
    await idle()
    assert.deepStrictEqual(blockActions(), ['start_break', 'abort_break'])
    assert.deepStrictEqual(bedd.calls.map(([op, a]) => `${op} ${a.button ?? ''} ${a.action ?? ''}`.trim()), ['look', 'button attack down', 'button attack up'])
  })

  it('placeBlock: look at the clicked point, then use click; no start/stop_item_use_on; resolves on update_block', async () => {
    const { bot, client, tick, idle, bedd, setBlock, routed } = await beddBot()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['dirt', 5] }, { firstStackId: 40 }))
    const ref = new Vec3(-1, G - 1, 0)
    let settled = false
    const placed = bot.placeBlock(bot.blockAt(ref), UP).then(() => { settled = true })
    await settle()
    tick(1)
    // no echo converges in this test (no follower): the look gives up after 1 s, then the click is sent
    await waitFor(() => routed.includes('inventory_transaction'))
    await idle()
    assert.deepStrictEqual(bedd.calls.map(([op]) => op), ['look', 'button'])
    const want = anglesTo(bot, new Vec3(-0.5, G - 0.02, 0.5)) // the clicked point, just inside the face
    assert.ok(near(bedd.calls[0][1].yaw, want.yaw) && near(bedd.calls[0][1].pitch, want.pitch), 'the top face centre')
    assert.deepStrictEqual(bedd.calls[1][1], { button: 'use', action: 'click' })
    assert.strictEqual(client.sent('player_action').length, 0, 'start/stop_item_use_on are client-owned')
    assert.ok(routed.includes('inventory_transaction'))
    assert.strictEqual(settled, false)
    // BDS's answer: the clicked block, then the destination
    setBlock(ref, 'grass_block')
    setBlock(ref.plus(UP), 'dirt')
    await placed
    assert.strictEqual(bot.blockAt(ref.plus(UP)).name, 'dirt')
  })

  it('attack(entity): look at the entity centre, then attack click; activateItem: use click, or use down / up for food', async () => {
    const { bot, client, idle, bedd } = await beddBot()
    client.receive('add_entity', {
      unique_id: -1050n,
      runtime_id: 1050n,
      entity_type: 'minecraft:zombie',
      position: { x: 2.5, y: G, z: 0.5 },
      velocity: { x: 0, y: 0, z: 0 },
      pitch: 0,
      yaw: 0,
      head_yaw: 0,
      body_yaw: 0,
      attributes: [],
      metadata: [],
      properties: { ints: [], floats: [] },
      links: []
    })
    const zombie = bot.entities[1050]
    assert.ok(zombie)
    bot.attack(zombie)
    await idle()
    assert.deepStrictEqual(bedd.calls.map(([op]) => op), ['look', 'button'])
    const want = anglesTo(bot, zombie.position.offset(0, zombie.height / 2, 0))
    assert.ok(near(bedd.calls[0][1].yaw, want.yaw) && near(bedd.calls[0][1].pitch, want.pitch))
    assert.deepStrictEqual(bedd.calls[1][1], { button: 'attack', action: 'click' })
    bedd.calls.length = 0
    // empty hand (a throwable, a rod, …): a click
    bot.activateItem()
    await idle()
    assert.deepStrictEqual(bedd.calls, [['button', { button: 'use', action: 'click' }]])
    // food: held until deactivateItem (item_release) …
    client.receive('inventory_content', inventoryContent(bot, { 0: ['bread', 5] }, { firstStackId: 40 }))
    await settle()
    bedd.calls.length = 0
    bot.activateItem()
    bot.activateItem()
    bot.deactivateItem()
    await idle()
    assert.deepStrictEqual(bedd.calls, [['button', { button: 'use', action: 'down' }], ['button', { button: 'use', action: 'up' }]])
    // … or until the server reports the use completed (consume)
    bedd.calls.length = 0
    bot.food = 10
    const eaten = bot.consume()
    await settle()
    client.receive('completed_using_item', { used_item_id: bot.registry.itemsByName.bread.id, use_method: 'eat' })
    await eaten
    await idle()
    assert.deepStrictEqual(bedd.calls, [['button', { button: 'use', action: 'down' }], ['button', { button: 'use', action: 'up' }]])
  })

  it('without the button op the mouse op presses the buttons; without look the click goes where the client looks', async () => {
    const { bot, tick, idle, bedd, setBlock } = await beddBot({ caps: { look: 'absent', button: 'absent' } })
    bot.game.gameMode = 'survival'
    const target = new Vec3(2, G, 0)
    setBlock(target, 'dirt')
    const done = bot.dig(bot.blockAt(target), true)
    await settle()
    tick(1)
    await idle()
    assert.deepStrictEqual(bedd.calls, [['mouse', { action: 'down', button: 'left' }]])
    setBlock(target, 'air')
    tick(1)
    await done
    await idle()
    assert.deepStrictEqual(bedd.calls.at(-1), ['mouse', { action: 'up', button: 'left' }])
    bot.activateItem()
    await idle()
    assert.deepStrictEqual(bedd.calls.at(-1), ['mouse', { action: 'click', button: 'right' }])
  })

  it('outside bedd mode the routed packets are left alone (raknet path: digging still predicts)', async () => {
    const { bot, tick, idle, bedd, setBlock, blockActions } = await beddBot({ mode: 'raknet' })
    bot.game.gameMode = 'creative'
    const target = new Vec3(2, G, 0)
    setBlock(target, 'dirt')
    const done = bot.dig(bot.blockAt(target), true)
    await settle()
    tick(1)
    assert.deepStrictEqual(blockActions(), ['start_break', 'predict_break'])
    setBlock(target, 'air')
    tick(1)
    await done
    await idle()
    assert.deepStrictEqual(bedd.calls, [])
  })

  it('faceAimPoint: inside the shape near the face (a bottom slab from the side, a full block from the top)', () => {
    const r = (p) => [p.x, p.y, p.z].map((v) => Math.round(v * 1e6) / 1e6)
    assert.deepStrictEqual(r(routerActions.faceAimPoint({ x: 0, y: 0, z: 0 }, 4, [[0, 0, 0, 1, 0.5, 1]])), [0.1, 0.25, 0.5])
    assert.deepStrictEqual(r(routerActions.faceAimPoint({ x: 1, y: 2, z: 3 }, 1, [])), [1.5, 2.9, 3.5])
  })

  it('lookAngles: Bedrock degrees (yaw 0 = +z, 90 = -x; pitch down positive)', () => {
    const o = { x: 0, y: 0, z: 0 }
    const r = (v) => Math.round(v * 1e6) / 1e6
    const a = (to) => { const { yaw, pitch } = routerActions.lookAngles(o, to); return [r(yaw), r(pitch)] }
    assert.deepStrictEqual(a({ x: 0, y: 0, z: 1 }), [0, 0])
    assert.deepStrictEqual(a({ x: -1, y: 0, z: 0 }), [90, 0])
    assert.deepStrictEqual(a({ x: 1, y: 0, z: 0 }), [-90, 0])
    assert.deepStrictEqual(a({ x: 0, y: -1, z: 1 }), [0, 45])
  })
})
