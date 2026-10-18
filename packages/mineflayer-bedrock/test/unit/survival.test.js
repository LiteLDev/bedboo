// owner: U14 (survival interactions)
'use strict'
/**
 * fishing.js and book.js on a fake client fed with the packets BDS 1.26.51.1 sends (shapes recorded live, see
 * docs/differences/U14.md): the bobber (add_entity fishing_hook with owner_eid), the bite (entity_event fish_hook_hook),
 * the book opened by a use, edited with book_edit and sent back on the release.
 */
const assert = require('assert')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick } = require('./helpers/inventory_server')
const { pagesOf, pageEdits } = require('../../lib/plugins/book')

const SELF_RUNTIME = 91n // the recorded join's local player

let serializer
function serialize (name, params) {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = serializer ?? createSerializer('1.26.51')
  return serializer.createPacketBuffer({ name, params })
}

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.server = serveInventory(created.bot, created.client)
  return created
}

function addHook (bot, client, runtimeId, owner = BigInt(bot._bedrock.ids.selfUniqueId())) {
  client.receive('add_entity', {
    unique_id: -runtimeId,
    runtime_id: runtimeId,
    entity_type: 'minecraft:fishing_hook',
    position: { x: 0.65, y: -58.76, z: 0.5 },
    velocity: { x: 1.2, y: -0.49, z: 0 },
    pitch: -21,
    yaw: 90,
    head_yaw: 0,
    body_yaw: 0,
    attributes: [],
    metadata: [{ key: 'owner_eid', type: 'long', value: owner }, { key: 'target_eid', type: 'long', value: 0n }],
    properties: { ints: [], floats: [] },
    links: []
  })
}

const entityEvent = (client, runtimeId, eventId) => client.receive('entity_event', { runtime_entity_id: runtimeId, event_id: eventId, data: 0 })
const uses = (client) => client.sent('inventory_transaction').filter((p) => p.transaction.transaction_data?.action_type === 'click_air')

describe('fishing (U14)', function () {
  this.timeout(30000)

  it('fish(): cast, ignore teasing / other bobbers, reel in on fish_hook_hook and resolve', async () => {
    const { bot, client } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['fishing_rod', 1] }))
    let resolved = false
    const fishing = bot.fish().then(() => { resolved = true })
    assert.strictEqual(uses(client).length, 1, 'cast = one click_air')
    addHook(bot, client, 500n, 12345n) // someone else's bobber
    addHook(bot, client, 501n) // ours
    entityEvent(client, 501n, 'fish_hook_tease')
    entityEvent(client, 501n, 'fish_hook_position')
    entityEvent(client, 500n, 'fish_hook_hook') // not ours
    await tick()
    assert.strictEqual(resolved, false)
    assert.strictEqual(uses(client).length, 1)
    entityEvent(client, 501n, 'fish_hook_hook')
    await fishing
    assert.strictEqual(uses(client).length, 2, 'reeled in = a second click_air')
    // the hook going away afterwards does not matter
    client.receive('remove_entity', { entity_id_self: -501n })
    for (const p of uses(client)) serialize('inventory_transaction', p)
  })

  it("the bobber disappears → 'Fishing cancelled'; a second fish() cancels the first", async () => {
    const { bot, client } = await joined()
    const first = bot.fish()
    addHook(bot, client, 600n)
    client.receive('remove_entity', { entity_id_self: -600n })
    await assert.rejects(first, (err) => err.message === 'Fishing cancelled')

    const second = bot.fish()
    const third = bot.fish()
    await assert.rejects(second, /Fishing cancelled due to calling bot\.fish\(\) again/)
    addHook(bot, client, 601n)
    entityEvent(client, 601n, 'fish_hook_hook')
    await third
  })
})

describe('book (U14)', function () {
  this.timeout(30000)

  /** the book NBT BDS sends: writable_book pages [{ photoname, text }] */
  function bookNbt (pages, extra = {}) {
    return {
      version: 1,
      nbt: {
        type: 'compound',
        name: '',
        value: {
          pages: { type: 'list', value: pages.length ? { type: 'compound', value: pages.map((text) => ({ photoname: { type: 'string', value: '' }, text: { type: 'string', value: text } })) } : { type: 'end', value: [] } },
          ...extra
        }
      }
    }
  }

  function sendBook (bot, client, slot, name, pages, stackId, extra) {
    const item = wireItem(bot, name, 1, stackId, pages ? { has_nbt: true, nbt: bookNbt(pages, extra) } : {})
    const content = inventoryContent(bot, {})
    content.input[slot] = item
    client.receive('inventory_content', content)
  }

  it('pageEdits: replace changed pages, add new ones, delete extra ones from the end', () => {
    assert.deepStrictEqual(pageEdits(0, [], ['a', 'b']).map((e) => [e.type, e.page_number, e.text]), [['add_page', 0, 'a'], ['add_page', 1, 'b']])
    assert.deepStrictEqual(pageEdits(2, ['a', 'x', 'c', 'd'], ['a', 'b']).map((e) => [e.inventory_slot, e.type, e.page_number, e.text]),
      [[2, 'replace_page', 1, 'b'], [2, 'delete_page', 3, undefined], [2, 'delete_page', 2, undefined]])
    assert.deepStrictEqual(pageEdits(0, ['a'], ['a']), [])
    for (const edit of pageEdits(3, ['a', 'x', 'c'], ['§1b', 'y'])) serialize('book_edit', edit)
  })

  it('writeBook on a held book: use (BDS adds a page list) → book_edit per page → release → acknowledged by the resent book', async () => {
    const { bot, client } = await joined()
    sendBook(bot, client, 0, 'writable_book', null, 7)
    assert.strictEqual(bot.heldItem.name, 'writable_book')
    const written = bot.writeBook(36, ['one', 'two'])
    await tick()
    assert.strictEqual(uses(client).length, 1, 'opened with a use')
    assert.deepStrictEqual(client.sent('book_edit'), [], 'no edit before the book is open')
    sendBook(bot, client, 0, 'writable_book', [], 8) // BDS: the opened book gets an empty page list
    await new Promise((resolve) => setTimeout(resolve, 200))
    const edits = client.sent('book_edit')
    assert.deepStrictEqual(edits.map((e) => [e.inventory_slot, e.type, e.page_number, e.text]), [[0, 'add_page', 0, 'one'], [0, 'add_page', 1, 'two']])
    const releases = client.sent('inventory_transaction').filter((p) => p.transaction.transaction_type === 'item_release')
    assert.strictEqual(releases.length, 1, 'closed with a release')
    sendBook(bot, client, 0, 'writable_book', ['one', 'two'], 9) // BDS resends the edited book
    await written
    assert.deepStrictEqual(pagesOf(bot.inventory.slots[36]), ['one', 'two'])
    assert.strictEqual(bot.inventory.slots[36].stackId, 9)
  })

  it('signBook: the sign edit carries title / author / xuid; resolves on the written_book', async () => {
    const { bot, client } = await joined()
    sendBook(bot, client, 2, 'writable_book', ['one'], 7)
    bot.setQuickBarSlot(5)
    const signed = bot.signBook(38, ['one'], 'Author', 'Title')
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.strictEqual(bot.quickBarSlot, 2, 'the book is held while it is edited')
    const edits = client.sent('book_edit')
    assert.deepStrictEqual(edits, [{ inventory_slot: 2, type: 'sign', title: 'Title', author: 'Author', xuid: '' }])
    serialize('book_edit', edits[0])
    sendBook(bot, client, 2, 'written_book', ['one'], 9, { author: { type: 'string', value: 'Author' }, title: { type: 'string', value: 'Title' } })
    await signed
    assert.strictEqual(bot.inventory.slots[38].name, 'written_book')
    assert.strictEqual(bot.quickBarSlot, 5, 'the held slot is restored')
  })

  it('an edit BDS dropped (no matching resend) is sent again in a second session', async () => {
    const { bot, client } = await joined()
    sendBook(bot, client, 0, 'writable_book', ['old'], 7)
    const written = bot.writeBook(36, ['new'])
    written.catch(() => {})
    await new Promise((resolve) => setTimeout(resolve, 250))
    assert.strictEqual(client.sent('book_edit').length, 1)
    // the release resend still has the old page: the session times out (5 s) and a second one resends the edit
    sendBook(bot, client, 0, 'writable_book', ['old'], 8)
    await new Promise((resolve) => setTimeout(resolve, 5800))
    assert.strictEqual(uses(client).length, 2, 'opened again')
    assert.strictEqual(client.sent('book_edit').length, 2)
    sendBook(bot, client, 0, 'writable_book', ['new'], 9)
    await written
  })

  it('argument checks like upstream', async () => {
    const { bot, client } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['stone', 1] }))
    await assert.rejects(bot.writeBook(-1, []), /slot out of inventory range/)
    await assert.rejects(bot.signBook(36, [], 'a', 'b'), /no book found in slot 36/)
  })
})

describe('bed sleep / wake packets (U14)', function () {
  it('wake(): player_action stop_sleeping while sleeping, "already awake" otherwise', async () => {
    const { bot, client } = await joined()
    await assert.rejects(bot.wake(), /already awake/)
    client.receive('set_entity_data', { runtime_entity_id: SELF_RUNTIME, metadata: [{ key: 'player_flags', type: 'byte', value: 2 }], properties: { ints: [], floats: [] }, tick: 0n })
    assert.strictEqual(bot.isSleeping, true)
    await bot.wake()
    const [action] = client.sent('player_action')
    assert.deepStrictEqual({ ...action, runtime_entity_id: String(action.runtime_entity_id) }, { runtime_entity_id: String(SELF_RUNTIME), action: 'stop_sleeping', position: { x: 0, y: 0, z: 0 }, result_position: { x: 0, y: 0, z: 0 }, face: 0 })
    serialize('player_action', action)
    // BDS: animate wake_up (+ player_flags 0) → 'wake'
    const woke = new Promise((resolve) => bot.once('wake', resolve))
    client.receive('animate', { action_id: 'wake_up', runtime_entity_id: SELF_RUNTIME, data: 0, has_swing_source: false })
    await woke
    assert.strictEqual(bot.isSleeping, false)
  })
})
