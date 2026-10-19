'use strict'
// owner: U17 — the obtain planner on a fake bot with the real 1.26.51 data: the registry, BDS's recorded
// crafting_data (mineflayer-bedrock's fixture, parsed by its recipes module) and a small fake world
const assert = require('assert')
const { Vec3 } = require('vec3')
const knowledge = require('../src/knowledge')
const planner = require('../src/planner')

const bedrockRoot = require('path').dirname(require.resolve('mineflayer-bedrock/package.json'))
/** a mineflayer-bedrock file (fixtures, recipes parser) or one of its dependencies */
function requireBedrock (request) {
  return require(request.startsWith('lib/') || request.startsWith('test/') ? require('path').join(bedrockRoot, request) : require.resolve(request, { paths: [bedrockRoot] }))
}

describe('obtain planner on a fake bot with real recipe data (U17)', function () {
  this.timeout(60000)
  let registry, recipes

  before(() => {
    const fixtures = requireBedrock('test/fixtures')
    const { createRegistry } = requireBedrock('lib/registry')
    const cap = fixtures.load('join_flat')
    registry = createRegistry()
    registry.handleStartGame(cap.first('start_game'))
    registry.handleItemRegistry(cap.first('item_registry'))
    recipes = requireBedrock('lib/bedrock/recipes').parseCraftingData(registry, cap.first('crafting_data'))
  })

  /**
   * A mineflayer-shaped bot standing at (0, 64, 0) on grass over stone, with `blocks` ({ "x,y,z": name }) placed
   * around and `items` ({ name: count }) carried.
   */
  function fakeBot ({ blocks = {}, items = {} } = {}) {
    const world = new Map(Object.entries(blocks))
    const nameAt = (p) => world.get(`${p.x},${p.y},${p.z}`) ?? (p.y < 63 ? 'stone' : p.y === 63 ? 'grass_block' : 'air')
    const Block = requireBedrock('prismarine-block')(registry)
    const blockAt = (p) => {
      const b = Block.fromStateId(registry.blocksByName[nameAt(p)].defaultState, 0)
      b.position = new Vec3(p.x, p.y, p.z)
      return b
    }
    const Item = requireBedrock('prismarine-item')(registry)
    const stacks = Object.entries(items).map(([name, count], i) => Object.assign(new Item(registry.itemsByName[name].id, count), { slot: 36 + i }))
    return {
      registry,
      entity: { position: new Vec3(0.5, 64, 0.5) },
      inventory: { items: () => stacks, slots: [] },
      blockAt,
      recipesAll: (id, meta, table) => recipes.filter((r) => r.result.id === id && (!r.requiresTable || table)),
      findBlocks: ({ matching, maxDistance = 64, count = 1, point }) => {
        const ids = new Set([].concat(matching))
        const from = point ?? new Vec3(0, 64, 0)
        const out = []
        for (const [k, name] of world) {
          const [x, y, z] = k.split(',').map(Number)
          const p = new Vec3(x, y, z)
          if (ids.has(registry.blocksByName[name].id) && p.distanceTo(from) <= maxDistance) out.push(p)
        }
        // the implicit stone layer: one block below the grass under the bot
        if (ids.has(registry.blocksByName.stone.id)) out.push(new Vec3(3, 62, 3))
        return out.sort((a, b) => a.distanceTo(from) - b.distanceTo(from)).slice(0, count)
      },
      nearestEntity: () => null
    }
  }

  it('blocksDropping: registry drops + harvest tools, deepslate variants, multi-drop yields', () => {
    const iron = knowledge.blocksDropping(registry, 'raw_iron')
    assert.deepStrictEqual(iron.map((s) => s.block).sort(), ['deepslate_iron_ore', 'iron_ore'])
    assert.ok(iron.every((s) => s.kind === 'mine' && s.tools.includes('stone_pickaxe') && !s.tools.includes('wooden_pickaxe')))
    const redstone = knowledge.blocksDropping(registry, 'redstone')
    assert.ok(redstone.some((s) => s.block === 'redstone_ore' && s.yield === 4.5))
    const cobble = knowledge.blocksDropping(registry, 'cobblestone')
    assert.ok(cobble.some((s) => s.block === 'stone' && s.tools.includes('wooden_pickaxe')))
    assert.ok(knowledge.blocksDropping(registry, 'oak_log').some((s) => s.block === 'oak_log' && s.tools === null && s.kind === 'gather'))
    assert.deepStrictEqual(knowledge.blocksDropping(registry, 'nether_star'), [])
  })

  it('recipesFor: the server recipes as planner recipes (tags expanded, duplicates merged)', () => {
    const bot = fakeBot()
    const table = knowledge.recipesFor(bot, 'crafting_table')
    assert.ok(table.some((r) => r.ingredients.oak_planks === 4 && r.result.count === 1 && !r.requiresTable))
    assert.ok(table.some((r) => r.ingredients.birch_planks === 4))
    const pick = knowledge.recipesFor(bot, 'stone_pickaxe')
    assert.ok(pick.some((r) => r.ingredients.cobblestone === 3 && r.ingredients.stick === 2 && r.requiresTable))
    assert.ok(pick.some((r) => r.ingredients.cobbled_deepslate === 3), 'stone tool materials tag')
  })

  it('stone pickaxe from nothing next to an oak tree: logs → planks → table → sticks → wooden pickaxe → stone', () => {
    const bot = fakeBot({ blocks: { '4,64,0': 'oak_log', '4,65,0': 'oak_log', '4,66,0': 'oak_log' } })
    const p = planner.plan({ item: 'stone_pickaxe', count: 1 }, knowledge.worldModel(bot))
    assert.ok(p.ok, p.reason)
    const order = p.steps.map((s) => `${s.action}:${s.item}`)
    assert.strictEqual(order[0], 'gather:oak_log')
    for (const s of ['craft:oak_planks', 'craft:crafting_table', 'craft:stick', 'craft:wooden_pickaxe', 'mine:cobblestone', 'craft:stone_pickaxe']) assert.ok(order.includes(s), `${s} in ${order}`)
    assert.ok(order.indexOf('craft:wooden_pickaxe') < order.indexOf('mine:cobblestone'))
    assert.ok(p.steps.find((s) => s.item === 'cobblestone').blocks.includes('stone'))
  })

  it('iron ingot with a stone pickaxe: iron ore in sight, a furnace from carried cobblestone, carried coal as fuel', () => {
    const bot = fakeBot({ blocks: { '6,60,2': 'iron_ore' }, items: { stone_pickaxe: 1, cobblestone: 8, coal: 1, crafting_table: 1 } })
    const p = planner.plan({ item: 'iron_ingot', count: 3 }, knowledge.worldModel(bot))
    assert.ok(p.ok, p.reason)
    assert.deepStrictEqual(p.steps.map((s) => `${s.action}:${s.item}`).sort(), ['craft:furnace', 'mine:raw_iron', 'smelt:iron_ingot'])
    const smelt = p.steps.find((s) => s.action === 'smelt')
    assert.deepStrictEqual([smelt.input, smelt.inputCount, smelt.fuel, smelt.fuelCount], ['raw_iron', 3, 'coal', 1])
  })

  it('diamonds need an iron pickaxe: no diamond ore in sight and no iron → explore estimates, still a plan', () => {
    const bot = fakeBot({ items: { stone_pickaxe: 1, crafting_table: 1, furnace: 1, coal: 4, stick: 4 } })
    const p = planner.plan({ item: 'diamond', count: 1 }, knowledge.worldModel(bot))
    assert.ok(p.ok, p.reason)
    const order = p.steps.map((s) => `${s.action}:${s.item}`)
    assert.ok(order.indexOf('craft:iron_pickaxe') >= 0 && order.indexOf('craft:iron_pickaxe') < order.indexOf('mine:diamond'), order.join(' '))
  })
})
