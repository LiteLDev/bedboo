'use strict'
// owner: U17 — the obtain planner on a fake world model (no server)
const assert = require('assert')
const { plan, fromMineflayerRecipe } = require('../src/planner')

const PICK = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']
const STONE_PICK = PICK.slice(1)
const IRON_PICK = PICK.slice(2)

/** a small Bedrock-like tech tree: logs → planks → sticks / table → tools; stone, iron, diamond */
function fakeWorld ({ inventory = {}, visible = {}, stations = {}, extra = {} } = {}) {
  const recipes = {
    oak_planks: [{ result: { name: 'oak_planks', count: 4 }, ingredients: { oak_log: 1 } }],
    birch_planks: [{ result: { name: 'birch_planks', count: 4 }, ingredients: { birch_log: 1 } }],
    stick: [
      { result: { name: 'stick', count: 4 }, ingredients: { oak_planks: 2 } },
      { result: { name: 'stick', count: 4 }, ingredients: { birch_planks: 2 } }
    ],
    crafting_table: [
      { result: { name: 'crafting_table', count: 1 }, ingredients: { oak_planks: 4 } },
      { result: { name: 'crafting_table', count: 1 }, ingredients: { birch_planks: 4 } }
    ],
    wooden_pickaxe: [
      { result: { name: 'wooden_pickaxe', count: 1 }, ingredients: { oak_planks: 3, stick: 2 }, requiresTable: true },
      { result: { name: 'wooden_pickaxe', count: 1 }, ingredients: { birch_planks: 3, stick: 2 }, requiresTable: true }
    ],
    stone_pickaxe: [
      { result: { name: 'stone_pickaxe', count: 1 }, ingredients: { cobblestone: 3, stick: 2 }, requiresTable: true },
      { result: { name: 'stone_pickaxe', count: 1 }, ingredients: { cobbled_deepslate: 3, stick: 2 }, requiresTable: true }
    ],
    iron_pickaxe: [{ result: { name: 'iron_pickaxe', count: 1 }, ingredients: { iron_ingot: 3, stick: 2 }, requiresTable: true }],
    diamond_pickaxe: [{ result: { name: 'diamond_pickaxe', count: 1 }, ingredients: { diamond: 3, stick: 2 }, requiresTable: true }],
    furnace: [{ result: { name: 'furnace', count: 1 }, ingredients: { cobblestone: 8 }, requiresTable: true }],
    iron_ingot: [{ result: { name: 'iron_ingot', count: 9 }, ingredients: { iron_block: 1 }, requiresTable: true }],
    iron_block: [{ result: { name: 'iron_block', count: 1 }, ingredients: { iron_ingot: 9 }, requiresTable: true }],
    bucket: [{ result: { name: 'bucket', count: 1 }, ingredients: { iron_ingot: 3 }, requiresTable: true }],
    ...extra.recipes
  }
  const smelting = {
    iron_ingot: [{ input: 'raw_iron', count: 1 }, { input: 'iron_ore', count: 1 }],
    charcoal: [{ input: 'oak_log', count: 1 }, { input: 'birch_log', count: 1 }],
    stone: [{ input: 'cobblestone', count: 1 }]
  }
  const blocks = {
    oak_log: [{ kind: 'gather', blocks: ['oak_log'], tools: null, yield: 1 }],
    birch_log: [{ kind: 'gather', blocks: ['birch_log'], tools: null, yield: 1 }],
    cobblestone: [{ kind: 'mine', blocks: ['stone'], tools: PICK, yield: 1 }],
    cobbled_deepslate: [{ kind: 'mine', blocks: ['deepslate'], tools: PICK, yield: 1 }],
    raw_iron: [{ kind: 'mine', blocks: ['iron_ore', 'deepslate_iron_ore'], tools: STONE_PICK, yield: 1 }],
    coal: [{ kind: 'mine', blocks: ['coal_ore', 'deepslate_coal_ore'], tools: PICK, yield: 1 }],
    diamond: [{ kind: 'mine', blocks: ['diamond_ore', 'deepslate_diamond_ore'], tools: IRON_PICK, yield: 1 }],
    redstone: [{ kind: 'mine', blocks: ['redstone_ore', 'deepslate_redstone_ore'], tools: IRON_PICK, yield: 4.5 }]
  }
  return {
    inventory,
    recipes: (item) => recipes[item] ?? [],
    smelting: (item) => smelting[item] ?? [],
    fuels: [{ name: 'coal', perItem: 8 }, { name: 'charcoal', perItem: 8 }, { name: 'oak_planks', perItem: 1.5 }, { name: 'birch_planks', perItem: 1.5 }, { name: 'oak_log', perItem: 1.5 }],
    sources: (item) => (blocks[item] ?? []).map((s) => ({ ...s, cost: visible[item] ?? (item === 'diamond' ? 300 : 150) })),
    stations
  }
}

/** apply a plan to an inventory the way the executor would (exact yields) and check every step was possible */
function simulate (steps, inventory) {
  const inv = { ...inventory }
  for (const s of steps) {
    if (s.action === 'craft') {
      if (s.table) assert.ok(inv.crafting_table > 0, `craft ${s.item}: a crafting table is carried`)
      for (const [name, n] of Object.entries(s.ingredients)) {
        assert.ok((inv[name] ?? 0) >= n, `craft ${s.item}: ${n} ${name} (have ${inv[name] ?? 0})`)
        inv[name] -= n
      }
    } else if (s.action === 'smelt') {
      assert.ok(inv.furnace > 0, `smelt ${s.item}: a furnace is carried`)
      assert.ok((inv[s.input] ?? 0) >= s.inputCount, `smelt ${s.item}: ${s.inputCount} ${s.input}`)
      assert.ok((inv[s.fuel] ?? 0) >= s.fuelCount, `smelt ${s.item}: ${s.fuelCount} ${s.fuel}`)
      inv[s.input] -= s.inputCount
      inv[s.fuel] -= s.fuelCount
    } else if (s.action === 'mine' || s.action === 'gather') {
      if (s.tools) assert.ok(s.tools.some((t) => inv[t] > 0), `${s.action} ${s.item}: one of ${s.tools} is carried`)
    }
    inv[s.item] = (inv[s.item] ?? 0) + s.count
  }
  return inv
}

describe('obtain planner (U17)', () => {
  it('already carried: no steps', () => {
    const r = plan({ item: 'stone_pickaxe', count: 1 }, fakeWorld({ inventory: { stone_pickaxe: 1 } }))
    assert.deepStrictEqual(r, { ok: true, steps: [], cost: 0 })
  })

  it('M1 tech tree from nothing: logs → planks → table → sticks → wooden pickaxe → cobblestone → stone pickaxe', () => {
    const world = fakeWorld({ visible: { oak_log: 8, cobblestone: 6 } })
    const r = plan({ item: 'stone_pickaxe', count: 1 }, world)
    assert.ok(r.ok, r.reason)
    const order = r.steps.map((s) => `${s.action}:${s.item}`)
    assert.strictEqual(order[0], 'gather:oak_log', 'the first step needs nothing')
    for (const needed of ['craft:oak_planks', 'craft:crafting_table', 'craft:stick', 'craft:wooden_pickaxe', 'mine:cobblestone', 'craft:stone_pickaxe']) {
      assert.ok(order.includes(needed), `${needed} in ${order}`)
    }
    assert.ok(order.indexOf('craft:wooden_pickaxe') < order.indexOf('mine:cobblestone'), 'the pickaxe before the stone')
    assert.ok(order.indexOf('craft:crafting_table') < order.indexOf('craft:wooden_pickaxe'), 'the table before the table recipe')
    const inv = simulate(r.steps, {})
    assert.ok(inv.stone_pickaxe >= 1)
    // not wasteful: one table, at most two log gathers' worth of logs
    assert.strictEqual(r.steps.filter((s) => s.item === 'crafting_table').length, 1)
    const logs = r.steps.filter((s) => s.item === 'oak_log').reduce((n, s) => n + s.count, 0)
    assert.ok(logs <= 5, `${logs} logs`)
  })

  it('chooses among a recipe\'s ingredient alternatives by what is visible / carried', () => {
    const birch = plan({ item: 'crafting_table', count: 1 }, fakeWorld({ visible: { oak_log: 120, birch_log: 6 } }))
    assert.ok(birch.ok)
    assert.deepStrictEqual(birch.steps.map((s) => s.item), ['birch_log', 'birch_planks', 'crafting_table'])
    // 2 oak planks carried: only the 2 missing ones are costed, so oak wins although birch trees are a bit closer
    const carried = plan({ item: 'crafting_table', count: 1 }, fakeWorld({ inventory: { oak_planks: 2 }, visible: { oak_log: 20, birch_log: 14 } }))
    assert.ok(carried.ok)
    assert.strictEqual(carried.steps.find((s) => s.action === 'craft' && s.item === 'crafting_table').ingredients.oak_planks, 4)
  })

  it('iron: mines raw iron with a stone pickaxe, places a furnace, smelts with the cheapest fuel', () => {
    const world = fakeWorld({ inventory: { stone_pickaxe: 1, crafting_table: 1, stick: 4, cobblestone: 8, coal: 2 }, visible: { raw_iron: 20, oak_log: 10 } })
    const r = plan({ item: 'iron_pickaxe', count: 1 }, world)
    assert.ok(r.ok, r.reason)
    const order = r.steps.map((s) => `${s.action}:${s.item}`)
    assert.deepStrictEqual(order.slice().sort(), ['craft:furnace', 'craft:iron_pickaxe', 'mine:raw_iron', 'smelt:iron_ingot'])
    assert.strictEqual(order[3], 'craft:iron_pickaxe')
    assert.strictEqual(order[2], 'smelt:iron_ingot')
    const smelt = r.steps[2]
    assert.strictEqual(smelt.input, 'raw_iron')
    assert.strictEqual(smelt.fuel, 'coal', 'the carried coal')
    assert.strictEqual(smelt.fuelCount, 1)
    assert.strictEqual(r.steps.find((s) => s.item === 'raw_iron').count, 3)
    simulate(r.steps, world.inventory)
  })

  it('never plans through a cycle (iron block ↔ ingot) and never mines without the harvest tool', () => {
    const r = plan({ item: 'iron_ingot', count: 2 }, fakeWorld({ inventory: { wooden_pickaxe: 1, crafting_table: 1 }, visible: { raw_iron: 5, cobblestone: 5, oak_log: 5 } }))
    assert.ok(r.ok, r.reason)
    const order = r.steps.map((s) => `${s.action}:${s.item}`)
    assert.ok(!order.includes('craft:iron_block'))
    assert.ok(order.indexOf('craft:stone_pickaxe') >= 0 && order.indexOf('craft:stone_pickaxe') < order.indexOf('mine:raw_iron'), `stone pickaxe first: ${order}`)
    simulate(r.steps, { wooden_pickaxe: 1, crafting_table: 1 })
  })

  it('diamond pickaxe: iron pickaxe first (diamond needs iron), then 3 diamonds', () => {
    const world = fakeWorld({ inventory: { stone_pickaxe: 1, crafting_table: 1, furnace: 1, coal: 4, stick: 8 }, visible: { raw_iron: 30, diamond: 90 } })
    const r = plan({ item: 'diamond_pickaxe', count: 1 }, world)
    assert.ok(r.ok, r.reason)
    const order = r.steps.map((s) => `${s.action}:${s.item}`)
    assert.deepStrictEqual(order, ['mine:raw_iron', 'smelt:iron_ingot', 'craft:iron_pickaxe', 'mine:diamond', 'craft:diamond_pickaxe'])
    assert.strictEqual(r.steps[3].count, 3)
  })

  it('multi-drop blocks: one redstone ore covers several redstone', () => {
    const r = plan({ item: 'redstone', count: 4 }, fakeWorld({ inventory: { iron_pickaxe: 1 }, visible: { redstone: 50 } }))
    assert.ok(r.ok)
    assert.strictEqual(r.steps.length, 1)
    assert.ok(Math.abs(r.cost - 50) < 1e-9, `one block: ${r.cost}`)
  })

  it('charcoal fuel when there is no coal: logs are smelted and burnt', () => {
    const r = plan({ item: 'iron_ingot', count: 3 }, fakeWorld({ inventory: { raw_iron: 3, furnace: 1 }, visible: { oak_log: 5 } }))
    assert.ok(r.ok, r.reason)
    const smelt = r.steps.find((s) => s.action === 'smelt' && s.item === 'iron_ingot')
    assert.ok(['oak_planks', 'oak_log', 'charcoal'].includes(smelt.fuel), smelt.fuel)
    simulate(r.steps, { raw_iron: 3, furnace: 1 })
  })

  it('reserves ingredients: a sibling cannot use up what the parent already gathered', () => {
    // stone pickaxe from 3 planks-worth carried: the sticks must not eat the planks reserved for the table
    const world = fakeWorld({ inventory: { oak_planks: 4, cobblestone: 3 }, visible: { oak_log: 10 } })
    const r = plan({ item: 'stone_pickaxe', count: 1 }, world)
    assert.ok(r.ok, r.reason)
    simulate(r.steps, world.inventory)
  })

  it('impossible items say why', () => {
    const r = plan({ item: 'nether_star', count: 1 }, fakeWorld())
    assert.strictEqual(r.ok, false)
    assert.match(r.reason, /no way to obtain 1 nether_star/)
    const noTool = plan({ item: 'diamond', count: 1 }, fakeWorld({ visible: { diamond: 10, raw_iron: Infinity, oak_log: Infinity, birch_log: Infinity } }))
    assert.strictEqual(noTool.ok, false)
    assert.match(noTool.reason, /diamond/)
  })

  it('stations nearby are used instead of crafting new ones', () => {
    const r = plan({ item: 'stone_pickaxe', count: 1 }, fakeWorld({ inventory: { cobblestone: 3, stick: 2 }, stations: { crafting_table: true } }))
    assert.deepStrictEqual(r.steps.map((s) => s.item), ['stone_pickaxe'])
  })

  it('fromMineflayerRecipe: delta → ingredients (results and remainders skipped)', () => {
    const registry = { items: { 1: { name: 'oak_planks' }, 2: { name: 'stick' }, 3: { name: 'cake' }, 4: { name: 'milk_bucket' }, 5: { name: 'bucket' } } }
    assert.deepStrictEqual(fromMineflayerRecipe(registry, { result: { id: 2, count: 4 }, delta: [{ id: 1, count: -2 }, { id: 2, count: 4 }], requiresTable: false, networkId: 7 }),
      { result: { name: 'stick', count: 4 }, ingredients: { oak_planks: 2 }, requiresTable: false, id: 7 })
    const cake = fromMineflayerRecipe(registry, { result: { id: 3, count: 1 }, delta: [{ id: 4, count: -3 }, { id: 3, count: 1 }, { id: 5, count: 3 }], requiresTable: true })
    assert.deepStrictEqual(cake.ingredients, { milk_bucket: 3 })
  })
})
