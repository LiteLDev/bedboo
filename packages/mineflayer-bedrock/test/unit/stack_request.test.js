'use strict'
// owner: U8 (inventory, windows, creative & item use) — lib/bedrock/stack_request.js: ids, legacy action ids,
// validation, response matching / errors / timeouts, observers; every action serialized with bedrock-protocol 1.26.51
const assert = require('assert')
const { createFakeBot } = require('./helpers/fake')
const { createStackRequestManager, normalizeAction, StackRequestError, LEGACY_ACTION_IDS } = require('../../lib/bedrock/stack_request')
const slots = require('../../lib/bedrock/slots')

let serializer
function roundTrip (name, params) {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  if (!serializer) {
    serializer = createSerializer('1.26.51')
    serializer.deserializer = createDeserializer('1.26.51')
  }
  const buf = serializer.createPacketBuffer({ name, params })
  return serializer.deserializer.parsePacketBuffer(buf).data.params
}

const info = (container, slot, stackId = 0) => ({ slot_type: { container_id: container }, slot, stack_id: stackId })

/** one action of every type, as the inventory model / station units build them */
const EVERY_ACTION = [
  { type_id: 'take', count: 4, source: info('hotbar', 0, 7), destination: info('cursor', 0) },
  { type_id: 'place', count: 2, source: info('cursor', 0, -3), destination: info('inventory', 9) },
  { type_id: 'swap', source: info('cursor', 0, 9), destination: info('container', 3, 12) },
  { type_id: 'drop', count: 1, source: info('hotbar', 1, 5) },
  { type_id: 'destroy', count: 64, source: info('hotbar_and_inventory', 20, 33) },
  { type_id: 'consume', count: 1, source: info('crafting_input', 28, 40) },
  { type_id: 'create', result_slot_id: 0 },
  { type_id: 'lab_table_combine' },
  { type_id: 'beacon_payment', primary_effect: 1, secondary_effect: 10 },
  { type_id: 'mine_block', hotbar_slot: 0, predicted_durability: 1560, network_id: 15 },
  { type_id: 'craft_recipe', recipe_network_id: 123, times_crafted: 2 },
  { type_id: 'craft_recipe_auto', recipe_network_id: 124, times_crafted: 1, ingredients: [] },
  { type_id: 'craft_creative', item_id: 604, times_crafted: 1 },
  { type_id: 'optional', recipe_network_id: 5, filtered_string_index: 0 },
  { type_id: 'craft_grindstone_request', recipe_network_id: 6, times_crafted: 1, cost: 3 },
  { type_id: 'craft_loom_request', pattern: 'bo', times_crafted: 1 },
  { type_id: 'non_implemented' },
  { type_id: 'results_deprecated', result_items: [], times_crafted: 1 }
]

describe('item stack requests (U8)', function () {
  this.timeout(30000)

  it('legacy_type_id: the pre-1.26.40 action numbering (craft_creative 14, results_deprecated 19)', () => {
    assert.deepStrictEqual(
      ['take', 'place', 'swap', 'drop', 'destroy', 'consume', 'create'].map(t => LEGACY_ACTION_IDS[t]), [0, 1, 2, 3, 4, 5, 6])
    assert.strictEqual(LEGACY_ACTION_IDS.beacon_payment, 10)
    assert.strictEqual(LEGACY_ACTION_IDS.craft_recipe, 12)
    assert.strictEqual(LEGACY_ACTION_IDS.craft_creative, 14)
    assert.strictEqual(LEGACY_ACTION_IDS.results_deprecated, 19)
    for (const action of EVERY_ACTION) {
      assert.strictEqual(normalizeAction(action).legacy_type_id, LEGACY_ACTION_IDS[action.type_id], action.type_id)
    }
    assert.strictEqual(normalizeAction({ ...EVERY_ACTION[0], legacy_type_id: 0 }).legacy_type_id, 0, 'an explicit value is kept')
  })

  it('validation: what BDS would answer with a disconnect throws before sending', () => {
    assert.throws(() => normalizeAction({ type_id: 'destroy', count: 0, source: info('hotbar', 0, 1) }), /count must be 1\.\.255/)
    assert.throws(() => normalizeAction({ type_id: 'take', count: 300, source: info('hotbar', 0), destination: info('cursor', 0) }), /count/)
    assert.throws(() => normalizeAction({ type_id: 'place', count: 1, source: info('hotbar', 0) }), /missing place destination/)
    assert.throws(() => normalizeAction({ type_id: 'hug' }), /unknown action type hug/)
    assert.throws(() => normalizeAction({ type_id: 'take', count: 1, source: { slot_type: {}, slot: 0 }, destination: info('cursor', 0) }), /container_id/)
    assert.throws(() => normalizeAction({ type_id: 'take', count: 1, source: info('hotbar', 256), destination: info('cursor', 0) }), /invalid take source slot/)
    // slots.resolve() shape is accepted and normalized
    const a = normalizeAction({ type_id: 'drop', count: 2, source: { container_id: 'hotbar', slot: 3, stack_network_id: 17 } })
    assert.deepStrictEqual(a, { type_id: 'drop', count: 2, legacy_type_id: 3, randomly: false, source: { slot_type: { container_id: 'hotbar' }, slot: 3, stack_id: 17 } })
  })

  it('every action type serializes and parses back with bedrock-protocol 1.26.51 (legacy byte included)', () => {
    for (const action of EVERY_ACTION) {
      const request = { request_id: -1, actions: [normalizeAction(action)], custom_names: [], cause: -1 }
      const back = roundTrip('item_stack_request', { requests: [request] })
      const parsed = back.requests[0].actions[0]
      assert.strictEqual(parsed.type_id, action.type_id)
      assert.strictEqual(parsed.legacy_type_id, LEGACY_ACTION_IDS[action.type_id], action.type_id)
      if (action.source) assert.deepStrictEqual(parsed.source.slot_type.container_id, action.source.slot_type.container_id)
    }
    // the auth-input variant (≤ 1 per tick) carries the same structure
    const r = { request_id: -5, actions: [normalizeAction(EVERY_ACTION[0])], custom_names: [], cause: -1 }
    assert.strictEqual(roundTrip('item_stack_request', { requests: [r] }).requests[0].request_id, -5)
  })

  it('create / send: odd negative ids, the packet, response matching (ok → resolves, error → StackRequestError)', async () => {
    const { bot, client } = await createFakeBot()
    const mgr = bot._bedrock.stackRequests
    const seen = []
    mgr.observe((e) => seen.push([e.request.request_id, e.outcome]))
    const { request, response } = mgr.create((id) => [
      { type_id: 'craft_creative', item_id: 604 },
      { type_id: 'place', count: 3, source: info('creative_output', 50, id), destination: info('hotbar', 0) }
    ])
    assert.strictEqual(request.request_id, -1)
    assert.strictEqual(request.actions[1].source.stack_id, -1, 'creative_output carries the request id')
    assert.deepStrictEqual([request.custom_names, request.cause], [[], -1])
    mgr.write(request)
    assert.deepStrictEqual(client.sent('item_stack_request'), [{ requests: [request] }])
    const second = mgr.send([{ type_id: 'drop', count: 1, source: info('hotbar', 2, 4) }])
    assert.strictEqual(client.sent('item_stack_request')[1].requests[0].request_id, -3)
    client.receive('item_stack_response', {
      responses: [
        { status: 'ok', request_id: -1, containers: [{ slot_type: { container_id: 'hotbar' }, slots: [{ slot: 0, hotbar_slot: 0, count: 3, item_stack_id: 77, custom_name: '', filtered_custom_name: '', durability_correction: 0 }] }] },
        { status: 50, request_id: -3 },
        { status: 'ok', request_id: -99 } // unknown ids are ignored
      ]
    })
    const res = await response
    assert.strictEqual(res.containers[0].slots[0].item_stack_id, 77)
    await assert.rejects(second, (err) => err instanceof StackRequestError && err.status === 50 && err.outcome === 'error' && err.requestId === -3)
    assert.deepStrictEqual(seen, [[-1, 'ok'], [-3, 'error']])
    assert.strictEqual(mgr.pending.size, 0)
    // the response packet itself round-trips
    roundTrip('item_stack_response', { responses: [{ status: 'ok', request_id: -1, containers: res.containers }] })
  })

  it('timeout and disconnect reject; unawaited responses never raise unhandled rejections', async () => {
    const { bot, client } = await createFakeBot()
    const mgr = createStackRequestManager(bot, { timeout: 20 })
    const late = mgr.send([{ type_id: 'drop', count: 1, source: info('hotbar', 0, 1) }])
    await assert.rejects(late, (err) => err.outcome === 'timeout' && /no item_stack_response/.test(err.message))
    mgr.send([{ type_id: 'drop', count: 1, source: info('hotbar', 0, 1) }], { timeout: 60000 }) // never awaited
    const closed = mgr.send([{ type_id: 'drop', count: 1, source: info('hotbar', 0, 1) }], { timeout: 60000 })
    client.close()
    await assert.rejects(closed, (err) => err.outcome === 'closed')
    assert.strictEqual(mgr.pending.size, 0)
    assert.throws(() => mgr.create([]), /at least one action/)
    // viaInput: the request rides in the next player_auth_input
    const queued = []
    bot._bedrock.input.queueItemStackRequest = (r) => queued.push(r)
    mgr.write({ request_id: -9, actions: [], custom_names: [], cause: -1 }, { viaInput: true })
    assert.strictEqual(queued[0].request_id, -9)
  })

  it('slots.resolve → action slot info (stack ids: server id, pending request id, 0 when empty)', async () => {
    const { bot } = await createFakeBot()
    const Item = require('prismarine-item')(bot.registry)
    const stone = new Item(bot.registry.itemsByName.stone.id, 5, 0, null, 41, true)
    bot.inventory.updateSlot(36, stone)
    assert.deepStrictEqual(slots.resolve(bot.inventory, 36), { container_id: 'hotbar', slot: 0, stack_network_id: 41 })
    stone.stackId = -7 // changed by pending request -7
    assert.strictEqual(slots.resolve(bot.inventory, 36).stack_network_id, -7)
    assert.deepStrictEqual(slots.resolve(bot.inventory, 37), { container_id: 'hotbar', slot: 1, stack_network_id: 0 })
    const action = normalizeAction({ type_id: 'drop', count: 1, source: slots.resolve(bot.inventory, 36) })
    assert.deepStrictEqual(action.source, { slot_type: { container_id: 'hotbar' }, slot: 0, stack_id: -7 })
  })
})
