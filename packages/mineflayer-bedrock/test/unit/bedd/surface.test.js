'use strict'
// owner: BEDD-5 (bedd lifecycle, capability surface and BeddUnsupportedError) — a real createBot on the fake client
// (test/unit/helpers/fake.js) carrying a `client.bedd` stub, with the join_flat replay: the real client owns the
// loading screen / respawn / dimension acks, the capability surface follows the caps, item stack requests need the
// `stack` op, and a bot without client.bedd is unchanged.
const assert = require('assert')
const mineflayerBedrock = require('../../..')
const { fakeClient, fakeClock, createFakeBot, replayJoin } = require('../helpers/fake')
const { serveInventory, inventoryContent } = require('../helpers/inventory_server')
const { createInputQueue } = require('../../../lib/bedrock/input_queue')
const surface = require('../../../lib/bedd/surface')
const { BeddUnsupportedError, isBeddUnsupported } = require('../../../lib/bedd/errors')

const ALL = ['tap', 'world', 'look', 'input', 'slot', 'button', 'action', 'send', 'key', 'text', 'mouse', 'raw']

function beddStub (client, caps) {
  return {
    caps,
    rpc: { call: async () => ({}), supports: (op) => caps[op] === 'present' },
    link: { type: 'remote' },
    capabilities: { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true },
    attach (bot) { return surface.attach(bot, client) }
  }
}

function present (...ops) {
  return Object.fromEntries(ops.map(op => [op, 'present']))
}

/**
 * createBot on a fake client with `client.bedd` (what lib/bedd/index.js builds), attached the way lib/loader.js does
 * (`bot._client.bedd?.attach(bot)` right after createBot, before the plugins inject).
 */
async function createBeddBot (caps = present(...ALL), { clientOptions = {} } = {}) {
  const client = fakeClient()
  Object.assign(client.options, clientOptions)
  client.bedd = beddStub(client, caps)
  const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true })
  bot._bedrock.mode = 'bedd'
  const warnings = []
  bot._warn = (...message) => warnings.push(message.join(' '))
  const clock = fakeClock()
  const timers = { setInterval: () => ({ unref () {} }), clearInterval () {} }
  bot._bedrock.input = createInputQueue(bot, { now: () => clock.now, timers })
  bot._client.bedd.attach(bot)
  const errors = []
  bot.on('error', (err) => errors.push(err))
  await new Promise((resolve) => bot.once('inject_allowed', () => setImmediate(resolve)))
  return { bot, client, clock, errors, warnings }
}

async function joinedBedd (caps, opts) {
  const created = await createBeddBot(caps, opts)
  await replayJoin(created.bot, created.client)
  return created
}

function assertUnsupported (err, feature, missing) {
  assert.ok(err instanceof BeddUnsupportedError, `BeddUnsupportedError, got ${err?.stack ?? err}`)
  assert.strictEqual(err.code, 'ERR_BEDD_UNSUPPORTED')
  assert.strictEqual(err.bedd, true)
  assert.strictEqual(err.feature, feature)
  if (missing) assert.deepStrictEqual(err.missing, missing)
  assert.ok(isBeddUnsupported(err))
}

describe('bedd: lifecycle, capability surface and BeddUnsupportedError (BEDD-5)', function () {
  this.timeout(30000)

  describe('BeddUnsupportedError', () => {
    it('carries code, bedd, feature and missing; names the missing op or v2', () => {
      const err = new BeddUnsupportedError('bot.craft', { missing: ['stack'] })
      assertUnsupported(err, 'bot.craft', ['stack'])
      assert.strictEqual(err.name, 'BeddUnsupportedError')
      assert.match(err.message, /bot\.craft .*'bedd'.*'stack'/)
      assert.match(new BeddUnsupportedError('bot.writeBook', { missing: ['v2'] }).message, /v2/)
      assert.deepStrictEqual(new BeddUnsupportedError('book_edit').missing, [])
      assert.ok(!isBeddUnsupported(new Error('x')))
    })
  })

  describe('lifecycle: the real client owns the loading screen, respawn and dimension acks', () => {
    it('join_flat: spawn without serverbound_loading_screen or a respawn reply', async () => {
      const { bot, client } = await createBeddBot()
      let spawned = 0
      bot.on('spawn', () => spawned++)
      await replayJoin(bot, client)
      assert.strictEqual(spawned, 1)
      assert.strictEqual(bot._bedrock.lifecycle.state, 'spawned')
      assert.deepStrictEqual(client.sent('serverbound_loading_screen'), [])
      assert.deepStrictEqual(client.sent('respawn'), [])
      assert.ok(bot.entity.position.y < 32766, 'the respawn state 1 position still applies')
    })

    it('dimension change: no dimension_change_ack and no loading screen acks; spawn follows the server ack', async () => {
      const { bot, client } = await joinedBedd()
      client.clearSent()
      let spawned = 0
      bot.on('spawn', () => spawned++)
      client.receive('change_dimension', { dimension: 1, position: { x: 0, y: 70, z: 0 }, respawn: false, loading_screen_id: 3 })
      assert.strictEqual(bot._bedrock.lifecycle.state, 'changing_dimension')
      client.receive('player_action', { runtime_entity_id: bot._bedrock.ids.selfRuntimeId(), action: 'dimension_change_ack', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
      assert.strictEqual(spawned, 1)
      assert.deepStrictEqual(client.sent('player_action'), [])
      assert.deepStrictEqual(client.sent('serverbound_loading_screen'), [])
    })

    it('without client.bedd the join still sends the acks (unchanged)', async () => {
      const { bot, client } = await createFakeBot()
      await replayJoin(bot, client)
      assert.deepStrictEqual(client.sent('serverbound_loading_screen').map(p => p.type), [1, 2])
      assert.strictEqual(client.sent('respawn').length, 1)
      assert.strictEqual(bot.bedrock.bedd, undefined)
      assert.strictEqual(surface.attach(bot), null, 'attach is a no-op without client.bedd')
      assert.strictEqual(bot.craft.beddSurface, undefined)
    })
  })

  describe('capability surface', () => {
    it('supports() follows the caps permutations (dig: a look and a click)', async () => {
      const { bot, client } = await createBeddBot({})
      const { supports } = bot.bedrock.bedd
      const permutations = [
        [{}, false],
        [present('button'), false],
        [present('look'), false],
        [present('look', 'button'), true],
        [present('raw', 'mouse'), true],
        [{ look: 'present', button: 'disabled' }, false],
        [{ look: 'absent', raw: 'present', button: 'absent', mouse: 'present' }, true]
      ]
      for (const [caps, expected] of permutations) {
        client.bedd.caps = caps
        assert.strictEqual(supports('dig'), expected, `dig with ${JSON.stringify(caps)}`)
        assert.strictEqual(bot.bedrock.bedd.caps, caps, 'caps is the live client.bedd.caps')
      }
      client.bedd.caps = present(...ALL)
      assert.strictEqual(supports('craft'), false, 'craft needs stack')
      assert.strictEqual(supports('creative.setInventorySlot'), false)
      client.bedd.caps.stack = 'present'
      assert.strictEqual(supports('craft'), true)
      assert.strictEqual(supports('clickWindow'), true)
      for (const v2 of ['writeBook', 'updateSign', 'respawn']) assert.strictEqual(supports(v2), false, v2)
      assert.strictEqual(supports('blockAt'), true, 'state reads always work')
      assert.strictEqual(supports('look'), true)
      client.bedd.caps.send = 'disabled'
      assert.strictEqual(supports('send'), false, 'a BeDD op by name')
      assert.strictEqual(supports('chat'), true, 'chat falls back to the text op')
    })

    it('bot.craft rejects ERR_BEDD_UNSUPPORTED without the stack op; stubs keep upstream arity and sync/async', async () => {
      const { bot } = await joinedBedd()
      const err = await bot.craft({ result: { id: 1, count: 1 } }, 1, null).then(() => null, e => e)
      assertUnsupported(err, 'bot.craft', ['stack'])
      assert.strictEqual(bot.craft.length, 3)
      assert.strictEqual(bot.craft.name, 'craft')
      assertUnsupported(await bot.clickWindow(36, 0, 0).then(() => null, e => e), 'bot.clickWindow', ['stack'])
      assert.strictEqual(bot.clickWindow.length, 3)
      assertUnsupported(await bot.transfer({}).then(() => null, e => e), 'bot.transfer', ['stack'])
      assertUnsupported(await bot.creative.setInventorySlot(36, null).then(() => null, e => e), 'bot.creative.setInventorySlot', ['stack'])
      assert.strictEqual(bot.creative.setInventorySlot.length, 2)
      // v2: async writeBook rejects, sync updateSign throws
      const book = bot.writeBook(36, ['a'])
      assert.ok(book instanceof Promise)
      assertUnsupported(await book.then(() => null, e => e), 'bot.writeBook', ['v2'])
      assert.throws(() => bot.updateSign(null, 'x'), (e) => { assertUnsupported(e, 'bot.updateSign', ['v2']); return true })
      assert.strictEqual(bot.updateSign.length, 2)
      // nothing reached the client: no screen opened, no request sent
      assert.deepStrictEqual(bot._client.sent('interact'), [])
      assert.deepStrictEqual(bot._client.sent('item_stack_request'), [])
    })

    it('with the stack op the item stack APIs run: the request flows to _client.queue', async () => {
      const caps = present(...ALL, 'stack')
      const { bot, client } = await joinedBedd(caps)
      const server = serveInventory(bot, client)
      client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 5] }, { firstStackId: 20 }))
      await bot.moveSlotItem(36, 37)
      assert.ok(server.requests.length >= 1)
      assert.strictEqual(client.sent('item_stack_request').length, server.requests.length)
      assert.strictEqual(bot.inventory.slots[37]?.name, 'stone')
      // craft gets past the surface: whatever it fails with, it is not ERR_BEDD_UNSUPPORTED
      const err = await bot.craft(null, 1, null).then(() => null, e => e)
      assert.ok(!isBeddUnsupported(err), `craft is not refused by the surface: ${err?.message}`)
      // caps are read per call: the op going away refuses again
      caps.stack = 'disabled'
      assertUnsupported(await bot.moveSlotItem(37, 36).then(() => null, e => e), 'bot.moveSlotItem', ['stack'])
    })

    it('equip: an item already in the hotbar to the hand needs no stack op, anything else does', async () => {
      const { bot, client } = await joinedBedd()
      client.receive('inventory_content', inventoryContent(bot, { 3: ['stone', 5], 12: ['dirt', 1] }, { firstStackId: 20 }))
      client.clearSent()
      await bot.equip(bot.inventory.slots[39], 'hand')
      assert.strictEqual(bot.quickBarSlot, 3)
      assert.strictEqual(client.sent('mob_equipment').length, 1)
      // that still needs a hotbar op
      const caps = bot._client.bedd.caps
      caps.slot = 'absent'
      caps.key = 'disabled'
      assertUnsupported(await bot.equip(bot.inventory.slots[39], 'hand').then(() => null, e => e), 'bot.equip', ['slot', 'key'])
      caps.slot = 'present'
      assertUnsupported(await bot.equip(bot.inventory.slots[12], 'hand').then(() => null, e => e), 'bot.equip', ['stack'])
      assertUnsupported(await bot.equip(bot.inventory.slots[39], 'head').then(() => null, e => e), 'bot.equip', ['stack'])
      assert.strictEqual(bot.equip.length, 2)
    })

    it('stack_request.create refuses item_stack_request only without the stack op', async () => {
      const caps = present(...ALL)
      const { bot, client } = await joinedBedd(caps)
      const mgr = bot._bedrock.stackRequests
      const action = { type_id: 'drop', count: 1, source: { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: 1 }, randomly: false }
      assert.throws(() => mgr.create([action]), (e) => { assertUnsupported(e, 'item_stack_request', ['stack']); return true })
      assertUnsupported(await mgr.send([action]).then(() => null, e => e), 'item_stack_request', ['stack'])
      assert.strictEqual(mgr.pending.size, 0)
      assert.deepStrictEqual(client.sent('item_stack_request'), [])
      caps.stack = 'present'
      mgr.send([action], { timeout: 50 }).catch(() => {})
      assert.strictEqual(client.sent('item_stack_request').length, 1)
    })

    it('respawn: never throws (health.js calls it from packet listeners); warns once while dead', async () => {
      const { bot, client, warnings } = await joinedBedd()
      assert.strictEqual(bot.respawn(), undefined)
      assert.strictEqual(bot.respawn.length, 0)
      assert.strictEqual(warnings.filter(w => /respawn/.test(w)).length, 0, 'alive: upstream no-op, no warning')
      client.clearSent()
      // death (the respawn option is on by default: health.js calls bot.respawn() on every health-0 update)
      client.receive('respawn', { position: { x: 0, y: 32767, z: 0 }, state: 0, runtime_entity_id: bot._bedrock.ids.selfRuntimeId() })
      client.receive('set_health', { health: 0 })
      assert.strictEqual(bot.isAlive, false)
      await new Promise(resolve => setImmediate(resolve))
      client.receive('set_health', { health: 0 })
      assert.strictEqual(bot.respawn(), undefined)
      assert.deepStrictEqual(client.sent('respawn'), [])
      assert.deepStrictEqual(client.sent('player_action'), [])
      assert.strictEqual(warnings.filter(w => /respawn/.test(w)).length, 1, warnings.join('\n'))
      assert.strictEqual(bot.bedrock.bedd.supports('respawn'), false)
    })

    it('bot.quit only detaches: no disconnect packet, end with the reason', async () => {
      const { bot, client } = await joinedBedd()
      const ended = new Promise(resolve => bot.once('end', resolve))
      bot.quit()
      assert.strictEqual(await ended, 'disconnect.quitting')
      assert.deepStrictEqual(client.sent('disconnect'), [])
      assert.strictEqual(client.closed, true)
      assert.strictEqual(bot._bedrock.lifecycle.state, 'ended')
    })

    it('resource packs: nothing held, accept/deny do nothing (one warning)', async () => {
      const { bot, client, warnings } = await createBeddBot()
      assert.strictEqual(client.holdResourcePacks, undefined)
      bot.acceptResourcePack()
      bot.denyResourcePack()
      assert.deepStrictEqual(client.sent('resource_pack_client_response'), [])
      assert.strictEqual(warnings.filter(w => /ResourcePack/.test(w)).length, 1)
    })

    it('ignored options warn once each; attach is idempotent; bot.bedrock.bedd keeps members other units added', async () => {
      const client = fakeClient()
      Object.assign(client.options, { host: '1.2.3.4', port: 19133, viewDistance: 'far', auth: 'microsoft' })
      client.bedd = beddStub(client, present(...ALL))
      const bot = mineflayerBedrock.createBot({ client, username: client.username, logErrors: false, hideErrors: true })
      const warnings = []
      bot._warn = (...m) => warnings.push(m.join(' '))
      bot.bedrock.bedd = { observed: { yaw: 0, pitch: 0, tick: 0 } }
      surface.attach(bot, client)
      surface.attach(bot, client)
      await new Promise((resolve) => bot.once('inject_allowed', () => setImmediate(resolve)))
      surface.attach(bot, client)
      for (const key of surface.IGNORED_OPTIONS) assert.strictEqual(warnings.filter(w => w.includes(`'${key}'`)).length, 1, key)
      assert.deepStrictEqual(bot.bedrock.bedd.observed, { yaw: 0, pitch: 0, tick: 0 })
      assert.strictEqual(typeof bot.bedrock.bedd.supports, 'function')
      assert.strictEqual(bot.craft.original.beddSurface, undefined, 'wrapped once')
      bot.end()
    })
  })
})
