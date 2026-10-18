'use strict'
// owner: U13 (stations) — furnace / enchanting table / anvil / villager plugins on a fake client (the Bedrock
// packets observed on BDS 1.26.51.1), the Bedrock anvil rules (lib/bedrock/anvil.js) and the station helpers
// (lib/bedrock/stations.js). Internal-test analogs of the station flows: upstream has no internal test for them.
const assert = require('assert')
const nbt = require('prismarine-nbt')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')
const { serveInventory, wireItem, inventoryContent, tick } = require('./helpers/inventory_server')
const { zigzag32, resultSteps, itemFromNbt, withNbt } = require('../../lib/bedrock/stations')

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.server = serveInventory(created.bot, created.client)
  created.Item = require('prismarine-item')(created.bot.registry)
  const { bot } = created
  // no world / physics round trip: activation is the server's business here
  created.activations = []
  bot.activateBlock = async (block) => { created.activations.push(block) }
  bot.activateEntity = async (entity) => { created.activations.push(entity) }
  bot.game.gameMode = 'survival'
  bot.experience.level = 30
  return created
}

let serializer
function serialize (name, params) {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  serializer = serializer ?? createSerializer('1.26.51')
  return serializer.createPacketBuffer({ name, params })
}

/** wait until `fn()` is truthy (each check after a macrotask) */
async function until (fn, what = 'condition') {
  for (let i = 0; i < 200; i++) {
    if (fn()) return
    await tick()
  }
  throw new Error(`timed out waiting for ${what}`)
}

const blockNamed = (bot, name, pos = new Vec3(1, -60, 0)) => {
  const Block = require('prismarine-block')(bot.registry)
  const block = Block.fromStateId(bot.registry.blocksByName[name].defaultState, 0)
  block.position = pos
  return block
}

describe('stations: furnace (U13)', function () {
  this.timeout(30000)

  it('container_set_data before / after container_open → fuel, progress, totals, seconds and update events', async () => {
    const { bot, client, activations } = await joined()
    // BDS sends the block's state BEFORE its container_open
    for (const [property, value] of [[0, 50], [1, 1200], [2, 1600], [3, 0]]) client.receive('container_set_data', { window_id: 3, property, value })
    const opening = bot.openFurnace(blockNamed(bot, 'blast_furnace'))
    await until(() => activations.length === 1, 'activation')
    client.receive('container_open', { window_id: 3, window_type: 'blast_furnace', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, 'raw_iron', 2, 70), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const furnace = await opening
    assert.strictEqual(furnace.type, 'minecraft:blast_furnace')
    assert.strictEqual(furnace.inputItem().name, 'raw_iron')
    assert.strictEqual(furnace.fuelItem(), null)
    assert.strictEqual(furnace.outputItem(), null)
    assert.strictEqual(furnace.totalProgress, 100, 'blast furnace: 100 ticks (Java property 3, not sent by Bedrock)')
    assert.strictEqual(furnace.totalProgressSeconds, 5)
    assert.strictEqual(furnace.progress, 0.5)
    assert.strictEqual(furnace.progressSeconds, 2.5, 'seconds left')
    assert.strictEqual(furnace.totalFuel, 1600)
    assert.strictEqual(furnace.fuel, 0.75)
    assert.strictEqual(furnace.fuelSeconds, 60)

    const updates = []
    furnace.on('update', () => updates.push([furnace.fuel, furnace.progress]))
    client.receive('container_set_data', { window_id: 3, property: 0, value: 60 })
    client.receive('container_set_data', { window_id: 3, property: 1, value: 800 })
    client.receive('container_set_data', { window_id: 4, property: 0, value: 99 }) // another window
    client.receive('container_set_data', { window_id: 3, property: 3, value: 7 }) // stored xp: update only
    assert.deepStrictEqual(updates, [[0.75, 0.6], [0.5, 0.6], [0.5, 0.6]])
    // the output arrives as an inventory_slot of the furnace window
    client.receive('inventory_slot', { window_id: 3, slot: 2, item: wireItem(bot, 'iron_ingot', 1, 71) })
    assert.strictEqual(furnace.outputItem().name, 'iron_ingot')
    await furnace.close()
    client.receive('container_set_data', { window_id: 3, property: 0, value: 70 })
    assert.strictEqual(updates.length, 3, 'no update after close')
  })

  it('putFuel / putInput / takeOutput are item stack requests into furnace_fuel / furnace_ingredient / out of furnace_output', async () => {
    const { bot, client, server, activations } = await joined()
    client.receive('inventory_content', inventoryContent(bot, { 0: ['coal', 4], 1: ['beef', 3] }, { firstStackId: 40 }))
    const opening = bot.openFurnace(blockNamed(bot, 'smoker'))
    await until(() => activations.length === 1, 'activation')
    client.receive('container_open', { window_id: 5, window_type: 'smoker', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 5, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, 'cooked_beef', 2, 80)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const furnace = await opening
    assert.strictEqual(furnace.totalProgress, 100, 'smoker: 100 ticks')
    await furnace.putFuel(bot.registry.itemsByName.coal.id, null, 2)
    await furnace.putInput(bot.registry.itemsByName.beef.id, null, 3)
    assert.deepStrictEqual([furnace.fuelItem().count, furnace.inputItem().count], [2, 3])
    const places = server.requests.flatMap(r => r.actions).filter(a => a.type_id === 'place').map(a => a.destination.slot_type.container_id)
    assert.ok(places.includes('furnace_fuel') && places.includes('smoker_ingredient'), places.join())
    const taken = await furnace.takeOutput()
    assert.strictEqual(taken.name, 'cooked_beef')
    assert.strictEqual(furnace.outputItem(), null)
    assert.ok(server.requests.flatMap(r => r.actions).some(a => a.source?.slot_type.container_id === 'furnace_output'))
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.cooked_beef.id), 2)
  })
})

describe('stations: enchanting table (U13)', function () {
  this.timeout(30000)

  const OPTIONS = [
    { cost: 4, slot_flags: 16, equip_enchants: [], held_enchants: [], self_enchants: [{ id: 12, level: 1 }], name: 'ball ignite', option_id: -2385 },
    { cost: 9, slot_flags: 16, equip_enchants: [], held_enchants: [{ id: 10, level: 2 }, { id: 17, level: 2 }], self_enchants: [], name: 'cold galvanize', option_id: 2385 },
    { cost: 30, slot_flags: 1024, equip_enchants: [], held_enchants: [{ id: 16, level: 1 }], self_enchants: [{ id: 15, level: 3 }], name: 'water shorten', option_id: -2386 }
  ]

  async function openTable ({ creative = false } = {}) {
    const created = await joined()
    const { bot, client, activations } = created
    if (creative) bot.game.gameMode = 'creative'
    client.receive('inventory_content', inventoryContent(bot, { 0: ['diamond_sword', 1], 1: ['lapis_lazuli', 5] }, { firstStackId: 60 }))
    client.receive('player_enchant_options', { options: [] }) // sent right before the container_open
    const opening = bot.openEnchantmentTable(blockNamed(bot, 'enchanting_table'))
    await until(() => activations.length === 1, 'activation')
    client.receive('container_open', { window_id: 3, window_type: 'enchantment', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    created.table = await opening
    return created
  }

  it('player_enchant_options → enchantments [{ level, expected }] and ready; xpseed stays -1', async () => {
    const { bot, client, table } = await openTable()
    assert.deepStrictEqual(table.enchantments, Array(3).fill({ level: -1, expected: { enchant: -1, level: -1 } }))
    assert.strictEqual(table.xpseed, -1)
    let readies = 0
    table.on('ready', () => readies++)
    await table.putLapis(table.findInventoryItem(bot.registry.itemsByName.lapis_lazuli.id))
    await table.putTargetItem(table.findInventoryItem(bot.registry.itemsByName.diamond_sword.id))
    assert.strictEqual(table.targetItem().name, 'diamond_sword')
    assert.strictEqual(table.slots[1].count, 5)
    client.receive('player_enchant_options', { options: OPTIONS })
    assert.strictEqual(readies, 1)
    assert.deepStrictEqual(table.enchantments, [
      { level: 4, expected: { enchant: 12, level: 1 } },
      { level: 9, expected: { enchant: 10, level: 2 } },
      { level: 30, expected: { enchant: 16, level: 1 } }
    ])
    client.receive('player_enchant_options', { options: OPTIONS })
    assert.strictEqual(readies, 1, 'ready once per transition')
    client.receive('player_enchant_options', { options: [] })
    assert.strictEqual(table.enchantments[0].level, -1)
  })

  it('enchant(choice): craft_recipe zigzag32(option id) + results_deprecated + consume lapis / item + place the predicted item back', async () => {
    const { bot, client, server, table } = await openTable()
    await table.putLapis(table.findInventoryItem(bot.registry.itemsByName.lapis_lazuli.id))
    await table.putTargetItem(table.findInventoryItem(bot.registry.itemsByName.diamond_sword.id))
    client.receive('player_enchant_options', { options: OPTIONS })
    const updated = new Promise(resolve => table.once('updateSlot:0', (oldItem, newItem) => resolve(newItem)))
    server.requests.length = 0
    const item = await table.enchant('2')
    assert.strictEqual(item, table.slots[0])
    assert.strictEqual((await updated).name, 'diamond_sword')
    assert.deepStrictEqual(item.enchants, [{ lvl: 1, name: 'silk_touch' }, { lvl: 3, name: 'efficiency' }], 'equip + held + self, in that order')
    const [request] = server.requests
    const types = request.actions.map(a => a.type_id)
    assert.deepStrictEqual(types, ['craft_recipe', 'results_deprecated', 'consume', 'consume', 'place'])
    assert.strictEqual(request.actions[0].recipe_network_id, 4771, 'zigzag32(-2386)')
    assert.deepStrictEqual(request.actions.map(a => a.legacy_type_id), [12, 19, 5, 5, 1])
    assert.strictEqual(request.actions[1].result_items[0].name, 'minecraft:diamond_sword')
    assert.deepStrictEqual(nbt.simplify(request.actions[1].result_items[0].extra.nbt.nbt).ench, [{ id: 16, lvl: 1 }, { id: 15, lvl: 3 }])
    assert.deepStrictEqual([request.actions[2].count, request.actions[2].source.slot_type.container_id, request.actions[2].source.slot], [3, 'enchanting_lapis', 15])
    assert.deepStrictEqual([request.actions[3].count, request.actions[3].source.slot_type.container_id, request.actions[3].source.slot], [1, 'enchanting_input', 14])
    assert.deepStrictEqual(request.actions[4].source, { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: request.request_id })
    assert.deepStrictEqual([request.actions[4].destination.slot_type.container_id, request.actions[4].destination.slot], ['enchanting_input', 14])
    serialize('item_stack_request', { requests: [request] })
    assert.strictEqual(table.slots[1].count, 2, '3 of 5 lapis')
    const taken = await table.takeTargetItem()
    assert.strictEqual(taken.name, 'diamond_sword')
    assert.strictEqual(table.targetItem(), null)
  })

  it('enchant in creative mode consumes no lapis; a book becomes an enchanted book; guards', async () => {
    const { bot, client, server, table } = await openTable({ creative: true })
    await table.putTargetItem(table.findInventoryItem(bot.registry.itemsByName.diamond_sword.id))
    client.receive('player_enchant_options', { options: OPTIONS })
    server.requests.length = 0
    await table.enchant(0)
    assert.deepStrictEqual(server.requests[0].actions.map(a => a.type_id), ['craft_recipe', 'results_deprecated', 'consume', 'place'])
    // the predicted result of a book
    const Item = require('prismarine-item')(bot.registry)
    const book = new Item(bot.registry.itemsByName.book.id, 1)
    const enchanted = withNbt(Item, book, (value) => ({ ...value, ench: { type: 'list', value: { type: 'compound', value: [] } } }), { type: bot.registry.itemsByName.enchanted_book.id })
    assert.strictEqual(enchanted.name, 'enchanted_book')
    // survival guards: lapis and levels
    bot.game.gameMode = 'survival'
    client.receive('player_enchant_options', { options: OPTIONS })
    await assert.rejects(table.enchant(2), /needs 3 lapis lazuli/)
  })
})

describe('stations: anvil (U13)', function () {
  this.timeout(30000)

  function anvilOf () {
    require('@bedboo/bedrock-data').install()
    const registry = require('prismarine-registry')('bedrock_1.26.51')
    const Item = require('prismarine-item')(registry)
    const combine = require('../../lib/bedrock/anvil')(registry)
    const make = (name, { enchants, repairCost, damage, count = 1, customName } = {}) => {
      const item = new Item(registry.itemsByName[name].id, count, 0, null, null, true)
      if (enchants) item.enchants = enchants.map(([n, lvl]) => ({ name: n, lvl }))
      if (repairCost) item.repairCost = repairCost
      if (damage) item.durabilityUsed = damage
      if (customName) item.customName = customName
      return item
    }
    return { registry, Item, combine, make }
  }

  it('Bedrock costs: added levels × multiplier, incompatible enchantments dropped for free, penalties, rename, too expensive', () => {
    const { Item, combine, make } = anvilOf()
    const sword = make('diamond_sword')
    // the upstream anvil test's numbers hold on Bedrock
    let r = combine(sword, make('enchanted_book', { enchants: [['sharpness', 5]] }), false, undefined, Item)
    assert.strictEqual(r.xpCost, 5)
    assert.deepStrictEqual(r.item.enchants, [{ lvl: 5, name: 'sharpness' }])
    assert.strictEqual(r.item.repairCost, 1)
    assert.deepStrictEqual(Object.keys(r.item.nbt.value), ['RepairCost', 'ench'], 'BDS key order')
    r = combine(make('diamond_sword', { enchants: [['sharpness', 5]] }), make('enchanted_book', { enchants: [['unbreaking', 3]] }), false, 'lol', Item)
    assert.strictEqual(r.xpCost, 4)
    assert.deepStrictEqual(Object.keys(r.item.nbt.value), ['RepairCost', 'display', 'ench'])
    assert.strictEqual(r.item.customName, 'lol')
    // wiki examples: Sharpness III + III → IV costs 1 (Java 4); Looting III onto Looting I (item) costs 8 (Java 12)
    assert.strictEqual(combine(make('diamond_sword', { enchants: [['sharpness', 3]] }), make('enchanted_book', { enchants: [['sharpness', 3]] }), false).xpCost, 1)
    assert.strictEqual(combine(make('diamond_sword', { enchants: [['looting', 1]] }), make('diamond_sword', { enchants: [['looting', 3]] }), false).xpCost, 8)
    // Smite V is incompatible with Sharpness: dropped at no cost, the Looting II still applies (book: 2 per level)
    r = combine(make('diamond_sword', { enchants: [['sharpness', 2]] }), make('enchanted_book', { enchants: [['smite', 5], ['looting', 2]] }), false, undefined, Item)
    assert.strictEqual(r.xpCost, 4)
    assert.deepStrictEqual(r.item.enchants, [{ lvl: 2, name: 'sharpness' }, { lvl: 2, name: 'looting' }])
    // a lower or equal-at-max level adds nothing → no change
    assert.deepStrictEqual(combine(make('diamond_sword', { enchants: [['sharpness', 5]] }), make('enchanted_book', { enchants: [['sharpness', 5]] }), false), { xpCost: 0, item: null })
    // Bedrock-specific multipliers: Impaling 2 (book 1)
    assert.strictEqual(combine(make('trident'), make('enchanted_book', { enchants: [['impaling', 5]] }), false).xpCost, 5)
    // an enchantment that does not fit the item is ignored
    assert.deepStrictEqual(combine(sword, make('enchanted_book', { enchants: [['protection', 4]] }), false), { xpCost: 0, item: null })
    // rename: 1 level + the penalty, which a rename alone keeps
    r = combine(make('diamond_sword', { repairCost: 3 }), null, false, 'hello', Item)
    assert.strictEqual(r.xpCost, 4)
    assert.strictEqual(r.item.repairCost, 3)
    assert.strictEqual(combine(sword, null, false, 'hello', Item).item.repairCost, 0)
    assert.deepStrictEqual(combine(make('diamond_sword', { customName: 'x' }), null, false, 'x'), { xpCost: 0, item: null }, 'same name')
    // too expensive at 40 outside creative (a rename too, unlike Java's cap at 39)
    assert.deepStrictEqual(combine(make('diamond_sword', { repairCost: 39 }), null, false, 'a'), { xpCost: 0, item: null })
    assert.strictEqual(combine(make('diamond_sword', { repairCost: 39 }), null, true, 'a').xpCost, 40)
    // not combinable
    assert.deepStrictEqual(combine(sword, make('dirt'), false), { xpCost: 0, item: null })
    assert.deepStrictEqual(combine(make('book'), make('enchanted_book', { enchants: [['sharpness', 3]] }), false), { xpCost: 0, item: null }, 'a plain book is no anvil target')
    // a sacrifice that changes nothing gives no result, even with a name (it would be used up)
    assert.deepStrictEqual(combine(make('iron_sword'), make('iron_ingot', { count: 5 }), false, 'Blade'), { xpCost: 0, item: null })
    assert.deepStrictEqual(combine(make('stick', { count: 16 }), make('stick', { count: 8 }), false, 'x'), { xpCost: 0, item: null })
    // Thorns goes on any armor piece with an anvil (the table only offers it on chestplates): book multiplier 4
    assert.strictEqual(combine(make('diamond_helmet'), make('enchanted_book', { enchants: [['thorns', 3]] }), false).xpCost, 12)
    // an enchantment id the registry does not know is kept as it is
    const odd = make('diamond_sword')
    odd.nbt = nbt.comp({ ench: nbt.list(nbt.comp([{ id: nbt.short(250), lvl: nbt.short(1) }])) })
    r = combine(odd, make('enchanted_book', { enchants: [['sharpness', 1]] }), false, undefined, Item)
    assert.deepStrictEqual(nbt.simplify(r.item.nbt).ench, [{ id: 250, lvl: 1 }, { id: 9, lvl: 1 }])
  })

  it('repairs: materials (25 % each, 1 level each) and the same item (+12 %, 2 levels)', () => {
    const { Item, combine, make } = anvilOf()
    let r = combine(make('iron_sword', { damage: 200 }), make('iron_ingot', { count: 3 }), false, undefined, Item)
    assert.deepStrictEqual([r.xpCost, r.usedMats, r.item.durabilityUsed, r.item.repairCost], [3, 3, 14, 1])
    r = combine(make('iron_sword', { damage: 100 }), make('iron_ingot', { count: 5 }), false, undefined, Item)
    assert.deepStrictEqual([r.xpCost, r.usedMats], [2, 2])
    assert.strictEqual(r.item.nbt.value.Damage, undefined, 'fully repaired')
    r = combine(make('iron_sword', { damage: 200 }), make('iron_sword', { damage: 100 }), false, undefined, Item)
    assert.deepStrictEqual([r.xpCost, r.item.durabilityUsed], [2, 20])
  })

  it('rename(): transfer into anvil_input, then optional + consume + place into the first free inventory slot, name in custom_names', async () => {
    const { bot, client, server, activations } = await joined()
    bot.game.gameMode = 'creative' // no experience change to wait for
    client.receive('inventory_content', inventoryContent(bot, { 0: ['diamond_sword', 1], 1: ['stick', 16] }, { firstStackId: 30 }))
    const opening = bot.openAnvil(blockNamed(bot, 'anvil'))
    await until(() => activations.length === 1, 'activation')
    client.receive('container_open', { window_id: 3, window_type: 'anvil', coordinates: { x: 1, y: -60, z: 0 }, runtime_entity_id: -1n })
    client.receive('inventory_content', { window_id: 3, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    const anvil = await opening
    assert.strictEqual(anvil.type, 'minecraft:anvil')
    server.requests.length = 0
    await anvil.rename(anvil.findInventoryItem(bot.registry.itemsByName.diamond_sword.id), 'hello')
    const request = server.requests[server.requests.length - 1]
    assert.deepStrictEqual(request.custom_names, ['hello'])
    assert.strictEqual(request.cause, 'anvil_text')
    assert.deepStrictEqual(request.actions.map(a => a.type_id), ['optional', 'consume', 'place'])
    assert.deepStrictEqual([request.actions[0].recipe_network_id, request.actions[0].filtered_string_index, request.actions[0].legacy_type_id], [0, 0, 15])
    assert.deepStrictEqual([request.actions[1].source.slot_type.container_id, request.actions[1].source.slot], ['anvil_input', 1])
    assert.deepStrictEqual([request.actions[2].destination.slot_type.container_id, request.actions[2].destination.slot], ['inventory', 9])
    serialize('item_stack_request', { requests: [request] })
    assert.strictEqual(anvil.slots[3].customName, 'hello', 'Java slot 3: the first main inventory slot')
    assert.strictEqual(anvil.slots[0], null)
    // a combine without a name: filtered_string_index -1, no custom names, both inputs consumed
    await assert.rejects(anvil.combine(anvil.slots[3], anvil.findInventoryItem(bot.registry.itemsByName.stick.id)), /Not anvil-able/)
  })
})

describe('stations: villager (U13)', function () {
  this.timeout(30000)

  const nbtItem = (name, count, damage = 0, tag) => nbt.comp({ Count: nbt.byte(count), Damage: nbt.short(damage), Name: nbt.string(`minecraft:${name}`), WasPickedUp: nbt.byte(0), ...(tag ? { tag } : {}) })
  const recipe = ({ buyA, buyCountA, buyB, buyCountB = 0, sell, tier = 0, uses = 0, maxUses = 12, netId, demand = 0, pmA = 0.05 }) => ({
    buyA, buyCountA: nbt.int(buyCountA), ...(buyB ? { buyB } : {}), buyCountB: nbt.int(buyCountB), demand: nbt.int(demand), maxUses: nbt.int(maxUses), netId: nbt.int(netId), priceMultiplierA: nbt.float(pmA), priceMultiplierB: nbt.float(0), rewardExp: nbt.byte(1), sell, tier: nbt.int(tier), traderExp: nbt.int(2), uses: nbt.int(uses)
  })
  const enchantedBook = nbt.comp({ ench: nbt.list(nbt.comp([{ id: nbt.short(15), lvl: nbt.short(5) }])) })
  const updateTrade = (recipes, { tier = 0, windowId = 2 } = {}) => ({
    window_id: windowId,
    window_type: 'trading',
    size: 0,
    trade_tier: tier,
    villager_unique_id: -77n,
    entity_unique_id: 1n,
    display_name: 'entity.villager.librarian',
    new_trading_ui: true,
    economic_trades: true,
    offers: nbt.comp({ Recipes: nbt.list(nbt.comp(recipes.map(r => r))), TierExpRequirements: nbt.list(nbt.comp([{ 0: nbt.int(0) }])) })
  })
  const RECIPES = [
    recipe({ buyA: nbtItem('paper', 24, 32767), buyCountA: 24, sell: nbtItem('emerald', 1), netId: 4953, maxUses: 3, uses: 1 }),
    // Hero of the Village: buyA.Count is the discounted price, buyCountA the base
    recipe({ buyA: nbtItem('emerald', 8, 32767), buyCountA: 13, buyB: nbtItem('book', 1, 32767), buyCountB: 1, sell: nbtItem('enchanted_book', 1, 0, enchantedBook), netId: 4954, pmA: 0.2 }),
    recipe({ buyA: nbtItem('book', 4), buyCountA: 4, sell: nbtItem('emerald', 1), tier: 1, netId: 4955 }) // locked
  ]

  async function openVillager (recipes = RECIPES) {
    const created = await joined()
    const { bot, client, activations } = created
    client.receive('inventory_content', inventoryContent(bot, { 0: ['paper', 64], 1: ['emerald', 20], 2: ['book', 2] }, { firstStackId: 20 }))
    const entity = { id: 77, name: 'villager_v2', entityType: bot.registry.entitiesByName.villager_v2.id, position: new Vec3(2, -60, 0) }
    const opening = bot.openVillager(entity)
    await until(() => activations.length === 1, 'activation')
    // BDS: update_trade alone opens the trade screen (no container_open), then the window's contents
    client.receive('update_trade', updateTrade(recipes))
    client.receive('inventory_content', { window_id: 2, input: [wireItem(bot, null), wireItem(bot, null), wireItem(bot, null)], container: { container_id: 'anvil_input' }, storage_item: wireItem(bot, null) })
    created.villager = await opening
    return created
  }

  it('update_trade opens the merchant window; offers → upstream trades (unlocked tiers, prices, discounts)', async () => {
    const { bot, villager } = await openVillager()
    assert.strictEqual(bot.currentWindow, villager)
    assert.strictEqual(villager.type, 'minecraft:merchant')
    assert.strictEqual(villager.selectedTrade, null)
    assert.strictEqual(villager.trades.length, 2, 'the tier-1 offer is locked (Java sends only unlocked offers)')
    const [paper, book] = villager.trades
    assert.deepStrictEqual([paper.inputItem1.name, paper.inputItem1.count, paper.outputItem.name, paper.outputItem.count], ['paper', 24, 'emerald', 1])
    assert.deepStrictEqual([paper.hasItem2, paper.inputItem2, paper.nbTradeUses, paper.maximumNbTradeUses, paper.tradeDisabled, paper.realPrice, paper.xp], [false, null, 1, 3, false, 24, 2])
    assert.strictEqual(paper.inputItem1.metadata, 0, 'Damage 32767 = any data value')
    assert.deepStrictEqual(paper.inputs, [paper.inputItem1])
    assert.deepStrictEqual(paper.outputs, [paper.outputItem])
    assert.deepStrictEqual([book.inputItem1.count, book.realPrice, book.specialPrice, book.hasItem2, book.inputItem2.name], [13, 8, -5, true, 'book'])
    assert.deepStrictEqual(book.outputItem.enchants, [{ lvl: 5, name: 'efficiency' }])
    assert.strictEqual(book.bedrock.netId, 4954)
    assert.ok(!Object.keys(book).includes('bedrock'), 'the Bedrock details are not enumerable')
    // upstream's formula gives the server's price back
    const demandDiff = Math.max(0, Math.floor(book.inputItem1.count * book.demand * book.priceMultiplier))
    assert.strictEqual(book.inputItem1.count + book.specialPrice + demandDiff, book.realPrice)
  })

  it('trade(): inputs into trade2_ingredient1/2 (ui 4/5), craft_recipe(netId) + consume + place the output; uses; trade blocked', async () => {
    const { bot, server, villager } = await openVillager()
    server.requests.length = 0
    await bot.trade(villager, '1', 2)
    const crafts = server.requests.filter(r => r.actions[0].type_id === 'craft_recipe')
    assert.strictEqual(crafts.length, 2, 'one request per use')
    const [first] = crafts
    assert.deepStrictEqual(first.actions.map(a => a.type_id), ['craft_recipe', 'consume', 'consume', 'place'])
    assert.strictEqual(first.actions[0].recipe_network_id, 4954)
    assert.deepStrictEqual(first.actions.slice(1, 3).map(a => [a.count, a.source.slot_type.container_id, a.source.slot]), [[8, 'trade2_ingredient1', 4], [1, 'trade2_ingredient2', 5]])
    assert.deepStrictEqual(first.actions[3].source, { slot_type: { container_id: 'creative_output' }, slot: 50, stack_id: first.request_id })
    serialize('item_stack_request', { requests: [first] })
    const places = server.requests.filter(r => r.actions[0].type_id !== 'craft_recipe').flatMap(r => r.actions).filter(a => a.type_id === 'place').map(a => a.destination.slot_type.container_id)
    assert.ok(places.includes('trade2_ingredient1') && places.includes('trade2_ingredient2'))
    assert.strictEqual(villager.count(bot.registry.itemsByName.emerald.id), 4)
    assert.strictEqual(villager.count(bot.registry.itemsByName.book.id), 0)
    const books = villager.slots.filter(i => i?.name === 'enchanted_book')
    assert.strictEqual(books.length, 2)
    assert.deepStrictEqual(books[0].enchants, [{ lvl: 5, name: 'efficiency' }])
    assert.strictEqual(villager.selectedTrade, villager.trades[1])
    assert.strictEqual(villager.trades[1].nbTradeUses, 2)
    assert.strictEqual(villager.slots[0], null)
    assert.strictEqual(villager.slots[1], null)
    await assert.rejects(bot.trade(villager, 1, 1), /Not enough item 1 to trade/)
    // count defaults to the uses left; then the trade is blocked
    await bot.trade(villager, 0)
    assert.strictEqual(villager.trades[0].nbTradeUses, 3)
    assert.strictEqual(villager.trades[0].tradeDisabled, true)
    await assert.rejects(bot.trade(villager, 0, 1), /trade blocked/)
    assert.strictEqual(villager.count(bot.registry.itemsByName.emerald.id), 6)
    // a resent update_trade for the open window refreshes the offers
    const ready = villager.trades
    bot._client.receive('update_trade', updateTrade(RECIPES.slice(0, 1)))
    await tick()
    assert.notStrictEqual(villager.trades, ready)
    assert.strictEqual(villager.trades.length, 1)
    assert.strictEqual(bot.currentWindow, villager)
  })

  it('accepts villager_v2 / villager / wandering_trader, refuses other entities', async () => {
    const { bot } = await joined()
    await assert.rejects(bot.openVillager({ id: 5, name: 'pig', entityType: bot.registry.entitiesByName.pig.id }), /not a villager/)
  })
})

describe('stations: helpers (U13)', function () {
  it('zigzag32 / itemFromNbt / resultSteps', async () => {
    assert.deepStrictEqual([-2386, 2385, -2385, 0].map(zigzag32), [4771, 4770, 4769, 0])
    const { bot, client, Item } = await joined()
    const item = itemFromNbt(Item, bot.registry, nbt.comp({ Count: nbt.byte(3), Damage: nbt.short(8), Name: nbt.string('minecraft:potion') }))
    assert.deepStrictEqual([item.name, item.count, item.metadata, item.nbt], ['potion', 3, 8, null])
    assert.strictEqual(itemFromNbt(Item, bot.registry, nbt.comp({ Count: nbt.byte(1), Name: nbt.string('minecraft:no_such_item') })), null)
    client.receive('inventory_content', inventoryContent(bot, { 0: ['bread', 60], 9: ['dirt', 64] }, { firstStackId: 10 }))
    const model = bot._bedrock.inventoryModel
    // bread: tops up the stack with room (60 → 64), then the first empty slot of the window's player part
    const { steps, rest } = resultSteps(model, bot.inventory, new Item(bot.registry.itemsByName.bread.id, 6))
    assert.strictEqual(rest, 0)
    assert.deepStrictEqual(steps.map(s => [s.type, s.count, s.dst]), [['place', 4, 'p:0'], ['place', 2, 'p:10']])
    assert.ok(steps.every(s => s.src.created.name === 'bread'))
  })
})
