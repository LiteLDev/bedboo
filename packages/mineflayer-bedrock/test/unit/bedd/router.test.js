// owner: BEDD-2 (authority table + core intent router)
'use strict'
// The bedd-mode router on the real createBot: a fake bedrock-protocol client whose queue/write go to
// client.bedd.route (what BB1's bedd client does), a hand-built client.bedd stub with a recording rpc and caps
// permutations, and the recorded BDS join (join_flat). Bot APIs are called for real and the recorded ops asserted.
const assert = require('assert')
const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
const fixtures = require('../../fixtures')
const mineflayerBedrock = require('../../..')
const { fakeClient, fakeClock, replayJoin } = require('../helpers/fake')
const { serveInventory, wireItem } = require('../helpers/inventory_server')
const { createInputQueue } = require('../../../lib/bedrock/input_queue')
const authority = require('../../../lib/bedd/authority')
const routerModule = require('../../../lib/bedd/router')

const ALL_OPS = ['world', 'look', 'input', 'slot', 'button', 'action', 'send', 'key', 'text', 'raw', 'mouse']

function capsWith (overrides = {}) {
  const caps = {}
  for (const op of ALL_OPS) caps[op] = 'present'
  return Object.assign(caps, overrides)
}

/** client.bedd as BB1 builds it (spec D), with an rpc that records every call */
function beddStub (caps, world) {
  const calls = []
  const rpc = {
    async call (op, args) {
      calls.push([op, args])
      if (op === 'world') return { ok: true, ...world.current }
      return { ok: true }
    },
    supports: (op) => caps[op] === 'present'
  }
  return {
    calls,
    rpc,
    caps,
    link: { state: 'up', type: 'remote' },
    capabilities: { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true }
  }
}

async function beddBot ({ caps = capsWith(), world = { inLevel: true, mouseGrabbed: true, showingMenu: false } } = {}) {
  const client = fakeClient()
  const worldRef = { current: world }
  client.bedd = beddStub(caps, worldRef)
  // timers: no real world poll interval (tests refresh explicitly), real timeouts (chat fallback delay)
  const timers = { setInterval: () => ({ unref () {} }), clearInterval () {}, setTimeout: (fn) => setImmediate(fn) }
  const clock = fakeClock()
  client.options.bedd = { router: { timers, now: () => clock.now } }
  client.bedd.attach = (bot) => routerModule.attach(bot, client)
  // BB1's bedd client: queue/write never reach a wire, they go to client.bedd.route
  const record = (kind) => (name, params) => {
    client.written.push([kind, name, params])
    return client.bedd.route?.(name, params)
  }
  client.queue = record('queue')
  client.write = record('write')
  const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true })
  bot._bedrock.input = createInputQueue(bot, { now: () => clock.now, timers: { setInterval: () => ({ unref () {} }), clearInterval () {} } })
  const errors = []
  bot.on('error', (err) => errors.push(err))
  const warnings = []
  client.on('warning', (err) => warnings.push(err))
  await new Promise((resolve) => bot.once('inject_allowed', () => setImmediate(resolve)))
  const router = routerModule.attach(bot, client)
  assert.strictEqual(routerModule.attach(bot, client), router, 'attach is idempotent')
  await replayJoin(bot, client)
  await router.refreshWorld()
  await router.idle()
  const created = {
    bot,
    client,
    router,
    worldRef,
    errors,
    warnings,
    calls: client.bedd.calls,
    ops: (filter) => client.bedd.calls.filter(([op]) => op !== 'world' && (!filter || op === filter)),
    clear: () => { client.bedd.calls.length = 0 },
    async tick (n = 1) {
      for (let i = 0; i < n; i++) {
        clock.advance(50)
        bot._bedrock.input.pump()
      }
      await router.idle()
    }
  }
  await created.tick(3) // settle; the first input is the look baseline
  created.clear()
  return created
}

function decode (buf) {
  const des = createDeserializer('1.26.51')
  return des.parsePacketBuffer(Buffer.from(buf, 'base64')).data
}

describe('bedd authority table (BEDD-2)', () => {
  it('classifies the spec table (item_stack_request translated per the override)', () => {
    const c = authority.classify
    for (const name of ['login', 'request_chunk_radius', 'subchunk_request', 'serverbound_loading_screen', 'set_local_player_as_initialized', 'tick_sync', 'respawn', 'animate', 'network_stack_latency']) {
      assert.strictEqual(c(name, {}), 'clientOwned', name)
    }
    assert.strictEqual(c('player_action', { action: 'dimension_change_ack' }), 'clientOwned')
    assert.strictEqual(c('player_action', { action: 'start_item_use_on' }), 'clientOwned')
    assert.strictEqual(c('player_action', { action: 'respawn' }), 'clientOwned')
    assert.strictEqual(c('player_action', { action: 'stop_sleeping' }), 'unsupported')
    assert.strictEqual(c('interact', { action_id: 'mouse_over_entity' }), 'clientOwned')
    assert.strictEqual(c('interact', { action_id: 'open_inventory' }), 'translated')
    assert.strictEqual(c('interact', { action_id: 'leave_vehicle' }), 'unsupported')
    for (const name of ['player_auth_input', 'mob_equipment', 'container_close', 'item_stack_request']) assert.strictEqual(c(name, {}), 'translated', name)
    const tx = (type, action) => ({ transaction: { transaction_type: type, transaction_data: { action_type: action } } })
    assert.strictEqual(c('inventory_transaction', tx('item_use', 'click_block')), 'translated')
    assert.strictEqual(c('inventory_transaction', tx('item_use', 'click_air')), 'translated')
    assert.strictEqual(c('inventory_transaction', tx('item_use', 'break_block')), 'unsupported')
    assert.strictEqual(c('inventory_transaction', tx('item_release', 'release')), 'translated')
    assert.strictEqual(c('inventory_transaction', tx('item_use_on_entity', 'attack')), 'translated')
    assert.strictEqual(c('inventory_transaction', tx('normal')), 'unsupported')
    assert.strictEqual(c('text', {}), 'shared')
    assert.strictEqual(c('command_request', {}), 'shared')
    for (const name of ['book_edit', 'block_pick_request', 'crafting_event', 'set_default_game_type', 'some_future_packet']) assert.strictEqual(c(name, {}), 'unsupported', name)
  })

  it('the sets are frozen', () => {
    assert.throws(() => authority.clientOwned.add('text'), TypeError)
    assert.throws(() => authority.translated.delete('mob_equipment'), TypeError)
    assert.ok(Object.isFrozen(authority.shared))
  })
})

describe('bedd router on createBot + join_flat (BEDD-2)', function () {
  this.timeout(30000)

  it('the recorded join_flat player_auth_input records (idle) and the clientOwned join packets never reach the rpc', async () => {
    const { client, router, ops, calls } = await beddBot()
    // the join (replayed in beddBot) wrote set_local_player_as_initialized, subchunk_request, …: all dropped
    assert.ok(router.counters.dropped.set_local_player_as_initialized >= 1)
    const cap = fixtures.load('join_flat')
    for (const record of cap.records.filter(r => r.dir === 'out')) {
      const params = cap.parse(record)
      if (authority.classify(record.name, params) === 'clientOwned') client.bedd.route(record.name, params)
      if (record.name === 'player_auth_input') client.bedd.route(record.name, params)
    }
    await router.idle()
    assert.deepStrictEqual(ops(), [])
    assert.ok(calls.every(([op]) => op === 'world'))
    assert.ok(router.counters.dropped.subchunk_request >= 40)
  })

  it('setControlState forward + sprint → one input call with the right flags, resent every 100 ms, cleared on stop', async () => {
    const { bot, ops, clear, tick } = await beddBot()
    bot.setControlState('forward', true)
    bot.setControlState('sprint', true)
    await tick()
    assert.deepStrictEqual(ops(), [['input', { move: { x: 0, z: 1 }, jump: false, sneak: false, sprint: true, ttlMs: 300 }]])
    clear()
    await tick() // 50 ms later, unchanged: nothing
    assert.deepStrictEqual(ops(), [])
    await tick() // 100 ms after the last call: keep-alive
    assert.strictEqual(ops('input').length, 1)
    clear()
    bot.setControlState('left', true)
    bot.setControlState('jump', true)
    await tick()
    assert.deepStrictEqual(ops('input').map(([, a]) => a), [{ move: { x: 1, z: 1 }, jump: true, sneak: false, sprint: true, ttlMs: 300 }])
    clear()
    bot.clearControlStates()
    await tick(3)
    assert.deepStrictEqual(ops('input').map(([, a]) => a), [{ move: { x: 0, z: 0 }, jump: false, sneak: false, sprint: false, ttlMs: 0 }])
  })

  it('input absent → W/A/S/D/SPACE/LSHIFT/LCTRL key fallback', async () => {
    const { bot, ops, clear, tick } = await beddBot({ caps: capsWith({ input: 'absent' }) })
    bot.setControlState('forward', true)
    bot.setControlState('sneak', true)
    await tick(2)
    assert.deepStrictEqual(ops(), [['key', { key: 'W', action: 'down' }], ['key', { key: 'LSHIFT', action: 'down' }]])
    clear()
    bot.setControlState('forward', false)
    bot.setControlState('back', true)
    await tick()
    assert.deepStrictEqual(ops(), [['key', { key: 'W', action: 'up' }], ['key', { key: 'S', action: 'down' }]])
    clear()
    bot.clearControlStates()
    await tick()
    assert.deepStrictEqual(ops().map(([, a]) => a.action), ['up', 'up'])
  })

  it('bot.end releases the fallback keys it holds', async () => {
    const { bot, router, ops, clear, tick } = await beddBot({ caps: capsWith({ input: 'absent' }) })
    bot.setControlState('forward', true)
    await tick()
    clear()
    bot.end()
    await router.idle()
    assert.deepStrictEqual(ops(), [['key', { key: 'W', action: 'up' }]])
  })

  it('bot.end clears an active input override', async () => {
    const { bot, router, ops, clear, tick } = await beddBot()
    bot.setControlState('forward', true)
    await tick()
    clear()
    bot.end()
    await router.idle()
    assert.deepStrictEqual(ops(), [['input', { move: { x: 0, z: 0 }, jump: false, sneak: false, sprint: false, ttlMs: 0 }]])
  })

  it('input disabled also falls back to keys', async () => {
    const { bot, ops, tick } = await beddBot({ caps: capsWith({ input: 'disabled' }) })
    bot.setControlState('right', true)
    await tick()
    assert.deepStrictEqual(ops(), [['key', { key: 'D', action: 'down' }]])
  })

  it('showingMenu true suppresses input, look and slot; they resume when the screen closes', async () => {
    const { bot, router, worldRef, ops, clear, tick } = await beddBot()
    worldRef.current = { inLevel: true, mouseGrabbed: false, showingMenu: true }
    await router.refreshWorld()
    assert.strictEqual(router.inputAllowed(), false)
    bot.setControlState('forward', true)
    await bot.look(1, 0.2, true)
    bot.setQuickBarSlot(4)
    await tick(3)
    assert.deepStrictEqual(ops(), [])
    worldRef.current = { inLevel: true, mouseGrabbed: true, showingMenu: false }
    await router.refreshWorld()
    await tick()
    assert.deepStrictEqual(ops().map(([op]) => op).sort(), ['input', 'look', 'slot'])
    clear()
  })

  it('bot.look → look op in Bedrock degrees (the player_auth_input convention); no look without a change', async () => {
    const { bot, client, ops, clear, tick } = await beddBot()
    await tick(2)
    assert.deepStrictEqual(ops('look'), [], 'attaching never turns the real client')
    client.written.length = 0
    await bot.look(Math.PI / 2, -0.5, true)
    await tick()
    const sent = client.sent('player_auth_input').at(-1)
    const looks = ops('look')
    assert.strictEqual(looks.length, 1)
    assert.deepStrictEqual(looks[0][1], { yaw: sent.yaw, pitch: sent.pitch, timeoutMs: 250 })
    assert.ok(Math.abs(sent.yaw) > 1, 'a real turn')
    clear()
    await tick(3)
    assert.deepStrictEqual(ops('look'), [])
  })

  it('look absent → proportional raw mouse loop against bot.bedrock.bedd.observed', async () => {
    const { bot, client, ops, clear, tick } = await beddBot({ caps: capsWith({ look: 'absent' }) })
    bot.bedrock.bedd = { observed: { yaw: 0, pitch: 0, tick: 1 } }
    client.written.length = 0
    await bot.look(Math.PI / 2, 0, true)
    await tick()
    const target = client.sent('player_auth_input').at(-1).yaw
    const raws = ops('raw')
    assert.strictEqual(raws.length, 1)
    assert.strictEqual(Math.sign(raws[0][1].dx), Math.sign(target), 'turns toward the target')
    clear()
    await tick() // no new echo: no second step (closed loop)
    assert.deepStrictEqual(ops('raw'), [])
    bot.bedrock.bedd.observed = { yaw: target, pitch: 0, tick: 2 }
    await tick()
    assert.deepStrictEqual(ops('raw'), [], 'inside the deadband')
  })

  it('setQuickBarSlot → slot op; slot absent → number key', async () => {
    let created = await beddBot()
    created.bot.setQuickBarSlot(3)
    await created.router.idle()
    assert.deepStrictEqual(created.ops(), [['slot', { slot: 3 }]])
    created = await beddBot({ caps: capsWith({ slot: 'absent' }) })
    created.bot.setQuickBarSlot(6)
    await created.router.idle()
    assert.deepStrictEqual(created.ops(), [['key', { key: '7', action: 'press' }]])
  })

  it('chat and /command → send with bedrock-protocol bytes that decode back (command uuid preserved)', async () => {
    const { bot, client, router, ops } = await beddBot()
    bot.chat('hello there')
    bot.chat('/say hi')
    await router.idle()
    const sends = ops('send')
    assert.strictEqual(sends.length, 2)
    const text = decode(sends[0][1].buf)
    assert.strictEqual(text.name, 'text')
    assert.strictEqual(text.params.message, 'hello there')
    const command = decode(sends[1][1].buf)
    assert.strictEqual(command.name, 'command_request')
    assert.strictEqual(command.params.command, '/say hi')
    assert.strictEqual(command.params.origin.uuid, client.sent('command_request')[0].origin.uuid)
  })

  it('send absent → T / SLASH, text, ENTER (and a warning that the uuid is lost)', async () => {
    const { bot, router, ops, warnings } = await beddBot({ caps: capsWith({ send: 'absent' }) })
    bot.chat('hey')
    bot.chat('/time set 1000')
    await router.idle()
    assert.deepStrictEqual(ops(), [
      ['key', { key: 'T', action: 'press' }], ['text', { text: 'hey' }], ['key', { key: 'ENTER', action: 'press' }],
      ['key', { key: 'SLASH', action: 'press' }], ['text', { text: 'time set 1000' }], ['key', { key: 'ENTER', action: 'press' }]
    ])
    assert.ok(warnings.some(w => /uuid/.test(w.message)))
  })

  it('closeWindow → ESC (only while a screen shows); open_inventory → action inventory', async () => {
    const { bot, client, router, worldRef, ops, clear } = await beddBot()
    serveInventory(bot, client)
    const opened = new Promise(resolve => bot.once('windowOpen', resolve))
    client.receive('container_open', { window_id: 9, window_type: 'dispenser', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 9, input: Array(9).fill(wireItem(bot, null)), container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const window = await opened
    worldRef.current = { inLevel: true, mouseGrabbed: false, showingMenu: true }
    await bot.closeWindow(window)
    await router.idle()
    assert.deepStrictEqual(ops(), [['key', { key: 'ESC', action: 'press' }]])
    clear()
    worldRef.current = { inLevel: true, mouseGrabbed: true, showingMenu: false }
    client.bedd.route('container_close', { window_id: 9, window_type: 'none', server: false })
    await router.idle()
    assert.deepStrictEqual(ops(), [], 'no ESC (it would open the pause menu)')
    await router.refreshWorld()
    client.bedd.route('interact', { action_id: 'open_inventory', target_entity_id: 1n, has_position: false })
    await router.idle()
    assert.deepStrictEqual(ops(), [['action', { name: 'inventory' }]])
  })

  it('unsupported packets throw ERR_BEDD_UNSUPPORTED and emit bedd_unsupported_packet once per name', async () => {
    const { bot, client, ops } = await beddBot()
    const events = []
    bot.on('bedd_unsupported_packet', (info) => events.push(info))
    for (let i = 0; i < 2; i++) {
      assert.throws(() => client.bedd.route('book_edit', { type: 'replace_page' }), (err) => err.code === 'ERR_BEDD_UNSUPPORTED' && err.bedd === true)
    }
    // translated names nobody registered take the unsupported path too
    assert.throws(() => client.bedd.route('item_stack_request', { requests: [] }), { code: 'ERR_BEDD_UNSUPPORTED' })
    const tx = { transaction: { transaction_type: 'item_use', transaction_data: { action_type: 'click_air' } } }
    assert.throws(() => client.bedd.route('inventory_transaction', tx), { code: 'ERR_BEDD_UNSUPPORTED' })
    assert.deepStrictEqual(events.map(e => e.name), ['book_edit', 'item_stack_request', 'inventory_transaction'])
    assert.deepStrictEqual(ops(), [])
  })

  it('other modules plug in through client.bedd.routes.register (created by whoever attaches first)', async () => {
    // a module that attaches before the router creates the registry
    const bedd = {}
    routerModule.ensureRoutes(bedd)
    const early = bedd.routes
    routerModule.ensureRoutes(bedd)
    assert.strictEqual(bedd.routes, early, 'idempotent')

    const { client, router, ops } = await beddBot()
    const seen = []
    const handler = (params, ctx) => {
      seen.push([ctx.name, params])
      return ctx.call('button', { button: 'use', action: 'click' })
    }
    const off = client.bedd.routes.register('inventory_transaction', handler)
    client.bedd.routes.register('inventory_transaction', handler) // same function twice: registered once
    client.bedd.routes.register('block_action', (actions, ctx) => seen.push([ctx.name, actions]))
    const tx = { transaction: { transaction_type: 'item_use', transaction_data: { action_type: 'click_air' } } }
    client.bedd.route('inventory_transaction', tx)
    client.bedd.route('player_auth_input', { yaw: 0, pitch: 0, input_data: ['block_action'], block_action: [{ action: 'start_break' }] })
    await router.idle()
    assert.deepStrictEqual(seen.map(([n]) => n), ['inventory_transaction', 'block_action'])
    assert.deepStrictEqual(ops(), [['button', { button: 'use', action: 'click' }]])
    off()
    assert.throws(() => client.bedd.route('inventory_transaction', tx), { code: 'ERR_BEDD_UNSUPPORTED' })
    // a throwing handler inside the tick only warns
    client.bedd.routes.register('player_auth_input', () => { throw new Error('boom') })
    client.bedd.route('player_auth_input', { yaw: 0, pitch: 0, input_data: [] })
  })

  it('a registry another module created first is reused by attach', async () => {
    const client = fakeClient()
    const calls = []
    client.bedd = { rpc: { call: async (op, args) => { calls.push([op, args]); return { ok: true } } }, caps: capsWith({ world: 'absent' }) }
    client.options.bedd = { router: { timers: { setInterval: () => null, clearInterval () {}, setTimeout } } }
    const registry = routerModule.ensureRoutes(client.bedd)
    const got = []
    registry.register('item_stack_request', (params) => got.push(params))
    const router = routerModule.attach(null, client)
    assert.strictEqual(client.bedd.routes, registry)
    client.bedd.route('item_stack_request', { requests: [{ request_id: 1 }] })
    assert.deepStrictEqual(got, [{ requests: [{ request_id: 1 }] }])
    router.stop()
    assert.strictEqual(client.bedd.route('book_edit', {}), undefined, 'a stopped router ignores packets')
  })
})
