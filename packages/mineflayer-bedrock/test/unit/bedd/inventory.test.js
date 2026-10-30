'use strict'
// owner: BEDD-7 (inventory routing through BeDD's `stack` op) — lib/bedd/inventory.js on a real createBot over the
// fake client (recorded join) in bedd mode: clickWindow / craft / equip go out as `stack` rpc calls, the fake BeDD
// remaps the request ids like the real client's ItemStackNetManager and answers with the client's ids; the bot's
// pending requests resolve, the inventory updates, unknown / colliding responses are ignored, a missing cap rejects
// with ERR_BEDD_UNSUPPORTED
const assert = require('assert')
const { createFakeBot, replayJoin } = require('../helpers/fake')
const { serveInventory, inventoryContent, tick } = require('../helpers/inventory_server')
const inventory = require('../../../lib/bedd/inventory')
const { createRouteRegistry, ensureDispatch, markDispatch } = require('../../../lib/bedd/routes')

let deserializer
function decode (buf) {
  const { createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  deserializer = deserializer ?? createDeserializer('1.26.51')
  const { name, params } = deserializer.parsePacketBuffer(Buffer.from(buf, 'base64')).data
  assert.strictEqual(name, 'item_stack_request')
  assert.strictEqual(params.requests.length, 1)
  return params.requests[0]
}

/** what BDS answers to `request` (computed from the bot's prediction, like test/unit/helpers/inventory_server.js) */
function answer (bot, request, nextStackId) {
  const model = bot._bedrock.inventoryModel
  const containers = new Map()
  for (const action of request.actions) {
    for (const info of [action.source, action.destination]) {
      if (!info || info.slot_type.container_id === 'creative_output') continue
      const id = info.slot_type.container_id
      if (!containers.has(id)) containers.set(id, new Map())
      const key = model.keyOfResponse(id, info.slot)
      const item = key ? model.read(key) : null
      const slot = { slot: info.slot, hotbar_slot: info.slot, count: item ? item.count : 0, custom_name: '', filtered_custom_name: '', durability_correction: 0 }
      if (item) slot.item_stack_id = item.stackId > 0 ? item.stackId : nextStackId()
      containers.get(id).set(info.slot, slot)
    }
  }
  return { status: 'ok', request_id: request.request_id, containers: [...containers].map(([id, slots]) => ({ slot_type: { container_id: id }, slots: [...slots.values()] })) }
}

/**
 * A bot on the fake client in bedd mode. The fake BeDD:
 * - `client.queue` goes through `client.bedd.route` (the bedd transport's contract); the inventory screen
 *   open / close is answered by the U8 responder (standing in for the router + the real client's screen);
 * - `stack` decodes the buffer, gives the request the client's next id (-1001, -1003, …), and the "server" answers
 *   with that id — after the reply (default), or before it (`fake.responseFirst`), or never (`fake.hold`).
 */
async function beddBot ({ stack = 'present', route } = {}) {
  const created = await createFakeBot()
  const { bot, client } = created
  await replayJoin(bot, client)
  bot._bedrock.mode = 'bedd'
  const server = serveInventory(bot, client)
  server.ignoreRequests = true // the server never sees bedboo's own request: the client sends it
  let stackId = 5000
  let clientId = -999
  const fake = {
    calls: [],
    submitted: [], // [bedbooRequest, clientRequest]
    held: [],
    responseFirst: false,
    hold: false,
    reply: null, // (args) => reply override
    flush () { for (const fn of fake.held.splice(0)) fn() }
  }
  client.bedd = {
    caps: { stack },
    capabilities: { ownsLogin: true, ownsLoadingScreen: true, ownsChunkRequests: true, ownsMovement: true },
    rpc: {
      supports: (op) => client.bedd.caps[op] === 'present',
      async call (op, args) {
        fake.calls.push([op, args])
        if (op !== 'stack') return { ok: true }
        if (fake.reply) return fake.reply(args)
        const request = decode(args.buf)
        const bedbooId = request.request_id
        clientId -= 2
        const id = clientId
        // the ItemStackNetManager assigns its own id; slots changed earlier in the request follow it
        const own = (info) => info && info.stack_id === bedbooId ? { ...info, stack_id: id } : info
        const clientRequest = { ...request, request_id: id, actions: request.actions.map(a => ({ ...a, source: own(a.source), destination: own(a.destination) })) }
        fake.submitted.push([request, clientRequest])
        const respond = () => client.receive('item_stack_response', { responses: [answer(bot, clientRequest, () => stackId++)] })
        if (fake.hold) fake.held.push(respond)
        else if (fake.responseFirst) respond()
        else setImmediate(respond)
        await tick()
        return { ok: true, via: 'manager', requestIds: [id], map: { [String(bedbooId)]: id } }
      }
    }
  }
  if (route) client.bedd.route = route
  const queue = client.queue
  client.queue = (name, params) => {
    queue(name, params)
    if (name === 'item_stack_request') client.bedd.route?.(name, params)
  }
  const state = inventory.attach(bot, client)
  return { ...created, server, fake, state }
}

const names = (window) => window.slots.map((it, i) => it ? `${i}:${it.name}x${it.count}` : null).filter(Boolean).join(' ')
const stackCalls = (fake) => fake.calls.filter(([op]) => op === 'stack')

describe('bedd inventory: item_stack_request through BeDD\'s stack op (BEDD-7)', function () {
  this.timeout(30000)

  it('clickWindow: one stack call per click, the client-id response resolves it and updates bot.inventory', async () => {
    const { bot, client, fake, state } = await beddBot()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10], 9: ['dirt', 4] }, { firstStackId: 100 }))
    await bot.clickWindow(36, 0, 0)
    await bot.clickWindow(20, 1, 0)
    await bot.clickWindow(9, 0, 0)
    assert.strictEqual(names(bot.inventory), '9:stonex9 20:stonex1')
    assert.strictEqual(bot.inventory.selectedItem.name, 'dirt')
    assert.ok(bot.inventory.slots[9].stackId >= 5000, 'the response (client id) applied the server stack ids')
    assert.strictEqual(stackCalls(fake).length, 3)
    const [[request]] = fake.submitted
    assert.deepStrictEqual(request.actions.map(a => [a.type_id, a.count, a.source.slot_type.container_id, a.source.stack_id]), [['take', 10, 'hotbar', 100]])
    assert.ok(fake.submitted.every(([b, c]) => b.request_id !== c.request_id), 'the client used its own ids')
    assert.strictEqual(state.map.size, 0, 'entries cleared on response')
    assert.strictEqual(bot._bedrock.stackRequests.pending.size, 0)
    await bot.clickWindow(36, 0, 0)
  })

  it('craft planks from a log (2×2): self references keep bedboo\'s id (the map key BeDD substitutes)', async () => {
    const { bot, client, fake } = await beddBot()
    const id = (name) => bot.registry.itemsByName[name].id
    client.receive('inventory_content', inventoryContent(bot, { 0: ['oak_log', 2] }, { firstStackId: 20 }))
    const [planks] = bot.recipesFor(id('oak_planks'), null, 1, null)
    await bot.craft(planks, 2, null)
    assert.strictEqual(names(bot.inventory), '9:oak_planksx8')
    assert.ok(bot.inventory.slots[9].stackId > 0)
    const [[request, clientRequest]] = fake.submitted
    assert.strictEqual(request.actions[3].source.stack_id, request.request_id)
    assert.strictEqual(clientRequest.actions[3].source.stack_id, clientRequest.request_id)
    assert.deepStrictEqual(request.actions.map(a => a.type_id), ['place', 'craft_recipe', 'results_deprecated', 'consume', 'place'])
  })

  it('equip from the main inventory (armor and hand), then unequip', async () => {
    const { bot, client, fake } = await beddBot()
    client.receive('inventory_content', inventoryContent(bot, { 9: ['iron_boots', 1], 10: ['stone', 3] }, { firstStackId: 200 }))
    await bot.equip(bot.inventory.slots[9], 'feet')
    assert.strictEqual(bot.inventory.slots[8]?.name, 'iron_boots')
    await bot.equip(bot.inventory.slots[10], 'hand')
    assert.strictEqual(bot.heldItem?.name, 'stone')
    await bot.unequip('feet')
    assert.strictEqual(bot.inventory.slots[8], null)
    assert.ok(stackCalls(fake).length >= 3)
  })

  it('a response that reaches the tap before the stack reply is held, then resolves the request', async () => {
    const { bot, client, fake, state } = await beddBot()
    fake.responseFirst = true
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10] }, { firstStackId: 100 }))
    await bot.clickWindow(36, 0, 0)
    assert.strictEqual(bot.inventory.selectedItem?.count, 10)
    assert.ok(state.stats.held >= 1)
    await bot.clickWindow(36, 0, 0)
    assert.strictEqual(bot.inventory.slots[36]?.count, 10)
  })

  it('a response with a colliding id that is not ours (the user clicking in the real client) never settles a bot request', async () => {
    const { bot, client, fake } = await beddBot()
    fake.hold = true
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10] }, { firstStackId: 100 }))
    const click = bot.clickWindow(36, 0, 0)
    while (fake.held.length === 0) await tick()
    await bot._bedrock.beddInventory.idle()
    const [[request]] = fake.submitted
    assert.ok(bot._bedrock.stackRequests.pending.has(request.request_id))
    client.receive('item_stack_response', { responses: [{ status: 7, request_id: request.request_id }] })
    await tick()
    assert.ok(bot._bedrock.stackRequests.pending.has(request.request_id), 'the foreign response was ignored')
    fake.flush()
    await click
    assert.strictEqual(bot.inventory.selectedItem?.count, 10)
  })

  it('a later request naming an earlier pending request\'s id gets that request\'s client id', async () => {
    const { bot, client, fake } = await beddBot()
    fake.hold = true
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10] }, { firstStackId: 100 }))
    const a = bot.clickWindow(36, 0, 0)
    while (fake.submitted.length < 1) await tick()
    const b = bot.clickWindow(20, 0, 0)
    while (fake.submitted.length < 2) await tick()
    const [[first, firstClient], [second, secondClient]] = fake.submitted
    assert.strictEqual(second.actions[0].source.stack_id, firstClient.request_id, 'what BeDD received names the client id')
    assert.notStrictEqual(first.request_id, firstClient.request_id)
    assert.strictEqual(secondClient.actions[0].source.slot_type.container_id, 'cursor')
    fake.flush()
    await tick()
    fake.flush()
    await Promise.all([a, b])
    assert.strictEqual(names(bot.inventory), '20:stonex10')
  })

  it('caps.stack absent or disabled → ERR_BEDD_UNSUPPORTED, rolled back, nothing reaches BeDD', async () => {
    for (const stack of ['absent', 'disabled']) {
      const { bot, client, fake } = await beddBot({ stack })
      client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10], 9: ['oak_log', 1] }, { firstStackId: 100 }))
      await assert.rejects(bot.clickWindow(36, 0, 0), (err) => err.code === 'ERR_BEDD_UNSUPPORTED' && err.bedd === true && err.feature === 'item_stack_request' && err.missing.includes('stack'))
      assert.strictEqual(bot.inventory.slots[36]?.count, 10, 'rolled back')
      assert.strictEqual(bot.inventory.selectedItem, null)
      const [planks] = bot.recipesFor(bot.registry.itemsByName.oak_planks.id, null, 1, null)
      // bot.craft wraps every failure in `new Error(err)` (upstream); BEDD-5's surface stubs it with the code itself
      await assert.rejects(bot.craft(planks, 1, null), /BeddUnsupportedError/)
      await assert.rejects(bot.equip(bot.inventory.slots[9], 'hand'), { code: 'ERR_BEDD_UNSUPPORTED' })
      assert.strictEqual(stackCalls(fake).length, 0)
    }
  })

  it('a disabled / unknown-op reply rejects with ERR_BEDD_UNSUPPORTED; another failure with "Server rejected"', async () => {
    const { bot, client, fake } = await beddBot()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10] }, { firstStackId: 100 }))
    fake.reply = () => ({ ok: false, error: 'stack is disabled (allowStack)', code: 'disabled' })
    await assert.rejects(bot.clickWindow(36, 0, 0), { code: 'ERR_BEDD_UNSUPPORTED' })
    fake.reply = () => { throw Object.assign(new Error("unknown op 'stack'"), { code: 'unknown' }) }
    await assert.rejects(bot.clickWindow(36, 0, 0), { code: 'ERR_BEDD_UNSUPPORTED' })
    fake.reply = () => ({ ok: false, error: 'not in a level', code: 'not_in_level' })
    await assert.rejects(bot.clickWindow(36, 0, 0), /^Error: Server rejected transaction for clicking on slot 36/)
    assert.strictEqual(bot.inventory.slots[36]?.count, 10)
    fake.reply = null
    await bot.clickWindow(36, 0, 0)
    assert.strictEqual(bot.inventory.selectedItem?.count, 10)
  })

  it('timeout clears the entry; a late answer is still reported as late-ok', async () => {
    const { bot, client, fake, state } = await beddBot()
    fake.hold = true
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 10] }, { firstStackId: 100 }))
    const mgr = bot._bedrock.stackRequests
    const outcomes = []
    mgr.observe(({ outcome }) => outcomes.push(outcome))
    const create = mgr.create
    mgr.create = (actions, opts) => create(actions, { ...opts, timeout: 50 })
    await assert.rejects(bot.clickWindow(36, 0, 0), /Server didn't respond/)
    assert.strictEqual(state.map.size, 0)
    fake.flush()
    await tick()
    assert.deepStrictEqual(outcomes, ['timeout', 'late-ok'])
  })

  it('route registry: the shared registry (lib/bedd/routes.js); an existing route is wrapped, a dispatching one kept', async () => {
    const seen = []
    const { client, fake } = await beddBot({ route: (name, params) => seen.push(name) })
    assert.ok(client.bedd.routes.has('item_stack_request'))
    assert.strictEqual(inventory.handlersFor(client.bedd.routes, 'item_stack_request').length, 1)
    client.bedd.route('mob_equipment', {})
    assert.deepStrictEqual(seen, ['mob_equipment'], 'other names still reach the previous route')
    const route = client.bedd.route
    ensureDispatch(client.bedd)
    assert.strictEqual(client.bedd.route, route)
    // a router (BEDD-2) owning the registry and its route: only registers
    const routes = createRouteRegistry()
    const own = markDispatch(() => {})
    const bedd = { routes, route: own }
    assert.strictEqual(ensureDispatch(bedd), routes)
    assert.strictEqual(bedd.route, own)
    assert.throws(() => ensureDispatch({ routes: { map: new Map() } }), TypeError, 'a foreign registry shape is refused')
    assert.strictEqual(stackCalls(fake).length, 0)
  })

  it('without client.bedd nothing attaches and the manager keeps its raknet behaviour', async () => {
    const { bot, client } = await createFakeBot()
    assert.strictEqual(inventory.attach(bot, client), null)
    assert.strictEqual(bot._bedrock.stackRequests.bedd, null)
  })
})
