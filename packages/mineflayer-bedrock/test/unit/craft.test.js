'use strict'
// owner: U12 (crafting) — the craft plugin on a fake client (recorded join + the U8 inventory responder): recipes from
// the join's crafting_data, recipesFor / recipesAll, bot.craft's item stack requests (2×2 with the inventory screen,
// crafting table window, batches, several results) serialized by bedrock-protocol, upstream errors
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, inventoryContent } = require('./helpers/inventory_server')

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.server = serveInventory(created.bot, created.client)
  return created
}

let serializer, deserializer
/** serialize + parse an item_stack_request like bedrock-protocol does on the wire (a bad action disconnects on BDS) */
function roundTrip (request) {
  const { createSerializer, createDeserializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = serializer ?? createSerializer('1.26.51')
  deserializer = deserializer ?? createDeserializer('1.26.51')
  const buffer = serializer.createPacketBuffer({ name: 'item_stack_request', params: { requests: [request] } })
  return deserializer.parsePacketBuffer(buffer).data.params.requests[0]
}

const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => typeof v === 'bigint' ? Number(v) : v))
const summary = (request) => request.actions.map(a => [a.type_id, a.legacy_type_id, a.count ?? a.times_crafted ?? a.result_slot_id, a.source && `${a.source.slot_type.container_id}:${a.source.slot}`, a.destination && `${a.destination.slot_type.container_id}:${a.destination.slot}`].filter(x => x !== undefined))
const names = (window) => window.slots.map((it, i) => it ? `${i}:${it.name}x${it.count}` : null).filter(Boolean).join(' ')

describe('craft: recipes, recipesFor / recipesAll, bot.craft requests (U12)', function () {
  this.timeout(30000)

  it('recipes come from the join\'s crafting_data; recipesFor checks the inventory, recipesAll the table', async () => {
    const { bot, client } = await joined()
    const book = bot._bedrock.recipes
    assert.ok(book.all().length > 4000)
    assert.strictEqual(bot.registry.recipes, book.table)
    const id = (name) => bot.registry.itemsByName[name].id
    assert.deepStrictEqual(bot.recipesFor(id('stick'), null, 1, null), [], 'no planks')
    client.receive('inventory_content', inventoryContent(bot, { 0: ['oak_planks', 3], 9: ['diamond', 3], 10: ['stick', 2] }))
    const sticks = bot.recipesFor(id('stick'), null, 1, null)
    assert.strictEqual(sticks.length, 1)
    assert.strictEqual(sticks[0].inShape[0][0].id, id('oak_planks'))
    assert.deepStrictEqual(bot.recipesFor(id('stick'), null, 8, null), [], 'minResultCount 8 needs 4 planks')
    assert.deepStrictEqual(bot.recipesFor(id('diamond_pickaxe'), null, 1, null), [], 'a 3×3 recipe needs a table')
    assert.strictEqual(bot.recipesFor(id('diamond_pickaxe'), null, 1, true).length, 1)
    assert.strictEqual(bot.recipesAll(id('diamond_pickaxe'), null, null).length, 0)
    assert.strictEqual(bot.recipesAll(id('stick'), null, null).length, 14, '13 plank types + bamboo')
    // unlocked_recipes + doLimitedCrafting
    client.receive('game_rules_changed', { rules: [{ name: 'doLimitedCrafting', editable: true, type: 'bool', value: true }] })
    assert.deepStrictEqual(bot.recipesFor(id('stick'), null, 1, null), [])
    client.receive('unlocked_recipes', { unlock_type: 'newly_unlocked', recipes: ['minecraft:stick'] })
    assert.strictEqual(bot.recipesFor(id('stick'), null, 1, null).length, 1)
  })

  it('2×2: one request in the inventory screen — place into crafting_input, craft_recipe, results_deprecated, consume, place', async () => {
    const { bot, client, server } = await joined()
    const id = (name) => bot.registry.itemsByName[name].id
    client.receive('inventory_content', inventoryContent(bot, { 0: ['oak_log', 2] }, { firstStackId: 20 }))
    const [planks] = bot.recipesFor(id('oak_planks'), null, 1, null)
    client.clearSent()
    await bot.craft(planks, 2, null)
    assert.deepStrictEqual(client.sent('interact').map(p => p.action_id), ['open_inventory'], 'the 2×2 grid needs the inventory screen')
    assert.strictEqual(server.requests.length, 1, 'both crafts in one request')
    const [request] = server.requests
    assert.deepStrictEqual(summary(request), [
      ['place', 1, 2, 'hotbar:0', 'crafting_input:28'],
      ['craft_recipe', 12, 2],
      ['results_deprecated', 19, 2],
      ['consume', 5, 2, 'crafting_input:28'],
      ['place', 1, 8, 'creative_output:50', 'inventory:9']
    ])
    assert.strictEqual(request.actions[0].source.stack_id, 20)
    assert.strictEqual(request.actions[3].source.stack_id, request.request_id, 'a slot changed earlier in the request carries the request id')
    assert.strictEqual(request.actions[4].source.stack_id, request.request_id, 'the created output carries the request id')
    assert.deepStrictEqual(strip(roundTrip(request)), strip(request), 'bedrock-protocol serializes it unchanged')
    assert.strictEqual(names(bot.inventory), '9:oak_planksx8')
    assert.ok(bot.inventory.slots[9].stackId > 0, 'the response stack id')
    assert.strictEqual(bot.inventory.slots[9].blockRuntimeId, bot._bedrock.recipes.byNetworkId(planks.networkId).output[0].block_runtime_id, 'the server copy of the result (block runtime id)')
  })

  it('crafting table: the window opens, several results take a create each, the window closes; upstream errors', async () => {
    const { bot, client, server } = await joined()
    const id = (name) => bot.registry.itemsByName[name].id
    const tablePos = new Vec3(1, -60, 0)
    let opens = 0
    bot.openBlock = async (block) => {
      opens++
      const opened = new Promise(resolve => bot.once('windowOpen', resolve))
      client.receive('container_open', { window_id: 9, window_type: 'workbench', coordinates: { x: block.position.x, y: block.position.y, z: block.position.z }, runtime_entity_id: -1n })
      return opened
    }
    const table = { position: tablePos, name: 'crafting_table' }
    client.receive('inventory_content', inventoryContent(bot, { 0: ['milk_bucket', 1], 1: ['milk_bucket', 1], 2: ['milk_bucket', 1], 3: ['sugar', 2], 4: ['egg', 1], 5: ['wheat', 3] }, { firstStackId: 40 }))
    const [cake] = bot.recipesFor(id('cake'), null, 1, table)
    assert.ok(cake)
    await assert.rejects(bot.craft(cake, 1, null), (err) => err.message.startsWith('Recipe requires craftingTable, but one was not supplied: {"result":'))
    client.clearSent()
    await bot.craft(cake, 1, table)
    assert.strictEqual(opens, 1)
    assert.strictEqual(server.requests.length, 1)
    const request = server.requests[0]
    assert.deepStrictEqual(summary(request).slice(9).map(a => a.slice(0, 3)), [
      ['craft_recipe', 12, 1], ['results_deprecated', 19, 1],
      ...Array(9).fill(['consume', 5, 1]),
      ['create', 6, 0], ['place', 1, 1], ['create', 6, 1], ['place', 1, 3]
    ])
    assert.deepStrictEqual(request.actions.find(a => a.type_id === 'results_deprecated').result_items.map(r => [r.name, r.count]), [['minecraft:cake', 1], ['minecraft:bucket', 3]])
    assert.deepStrictEqual(strip(roundTrip(request)), strip(request))
    assert.strictEqual(names(bot.inventory), '9:cakex1 10:bucketx3')
    assert.strictEqual(bot.currentWindow, null, 'closed after crafting')
    assert.strictEqual(client.sent('container_close').length, 1)
    // nothing left: upstream's wrapped "missing ingredient", the window is closed again
    await assert.rejects(bot.craft(cake, 1, table), (err) => err.message === 'Error: missing ingredient')
    assert.strictEqual(bot.currentWindow, null)
    // a rejected request: the prediction is rolled back, the error is wrapped like upstream
    client.receive('inventory_content', inventoryContent(bot, { 0: ['iron_ingot', 3] }, { firstStackId: 60 }))
    server.reject(35)
    const [bucket] = bot.recipesFor(id('bucket'), null, 1, table)
    await assert.rejects(bot.craft(bucket, 1, table), (err) => /^StackRequestError: .*status 35/.test(err.message))
    assert.strictEqual(names(bot.inventory), '36:iron_ingotx3')
  })

  it('items left in the grid go back first; a Recipe without networkId is matched to the server recipe', async () => {
    const { bot, client, server } = await joined()
    const id = (name) => bot.registry.itemsByName[name].id
    client.receive('inventory_content', inventoryContent(bot, { 0: ['oak_planks', 2] }, { firstStackId: 70 }))
    client.receive('inventory_content', inventoryContent(bot, { 29: ['dirt', 1] }, { window: 'ui', size: 54, firstStackId: 80 }))
    assert.strictEqual(names(bot.inventory), '2:dirtx1 36:oak_planksx2')
    const { Recipe } = require('prismarine-recipe')(bot.registry)
    const plain = new Recipe({ result: { id: id('stick'), count: 4 }, inShape: [[id('oak_planks')], [id('oak_planks')]] })
    await bot.craft(plain, 1, null)
    assert.deepStrictEqual(server.requests.map(r => r.actions[0].type_id + ':' + r.actions[0].source.slot_type.container_id), ['place:crafting_input', 'place:hotbar'])
    assert.strictEqual(server.requests[1].actions.find(a => a.type_id === 'craft_recipe').recipe_network_id, 1581)
    assert.strictEqual(names(bot.inventory), '9:stickx4 37:dirtx1', 'the grid item went back like Java\'s placeItemBackInInventory')
    const bogus = new Recipe({ result: { id: id('stick'), count: 4 }, inShape: [[id('dirt')]] })
    await assert.rejects(bot.craft(bogus, 1, null), (err) => err.message.startsWith('Error: crafting: no recipe of the server matches {'))
  })
})
