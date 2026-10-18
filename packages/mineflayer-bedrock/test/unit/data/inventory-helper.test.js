'use strict'
// owner: W1-FIX (wave-1 fix-up) — bot.test.setInventorySlot (test/external/common/helpers/inventory.js) on
// prismarine-items carrying Bedrock NBT: what /replaceitem can express and what it must refuse
const assert = require('assert')
const { createRegistry } = require('../../../lib/registry')
const install = require('../../external/common/helpers/inventory')
const { unsupportedItemData, replaceItemSpec } = install

const registry = createRegistry()
const Item = require('prismarine-item')(registry)
const item = (name, count = 1) => new Item(registry.itemsByName[name].id, count)
const nbtOf = (value) => ({ type: 'compound', name: '', value })

/** a bot.test with the inventory helpers over a console that records the commands */
function helpers () {
  const commands = []
  const bot = { test: {}, registry }
  const ctx = {
    state: {},
    who: () => 'bot',
    packet: () => ({ promise: new Promise(() => {}), cancel () {} }),
    consoleExpect: async (cmd) => { commands.push(cmd) }
  }
  install(bot, ctx)
  return { t: bot.test, commands }
}

describe('bot.test.setInventorySlot item check (replaceitem)', () => {
  it('plain items and empty slots are placed as <name> <count> <data>', () => {
    assert.strictEqual(unsupportedItemData(item('stone', 5)), null)
    assert.strictEqual(replaceItemSpec(item('stone', 5)), 'stone 5 0')
    assert.strictEqual(replaceItemSpec({ name: 'diamond_sword', count: 1 }), 'diamond_sword 1 0')
    assert.strictEqual(replaceItemSpec(null), 'air')
  })

  it('a tool\'s Damage goes through the data value (BDS stores it as Damage); new tools carry Damage 0', () => {
    const sword = item('diamond_sword')
    assert.deepStrictEqual(Object.keys(sword.nbt.value), ['Damage'], 'prismarine-item gives new tools Damage 0')
    assert.strictEqual(unsupportedItemData(sword), null)
    assert.strictEqual(replaceItemSpec(sword), 'diamond_sword 1 0')
    sword.durabilityUsed = 10
    assert.strictEqual(replaceItemSpec(sword, registry), 'diamond_sword 1 10')
    // plain objects (raw-client tests) use the static data for the durability
    assert.strictEqual(replaceItemSpec({ name: 'iron_pickaxe', count: 1, nbt: nbtOf({ Damage: { type: 'int', value: 5 } }) }), 'iron_pickaxe 1 5')
  })

  it('Damage on an item that cannot be damaged is refused (the data value would pick a variant)', () => {
    const stone = { name: 'stone', count: 1, nbt: nbtOf({ Damage: { type: 'int', value: 3 } }) }
    assert.deepStrictEqual(unsupportedItemData(stone, registry), { nbt: ['Damage'], lists: [] })
    assert.strictEqual(unsupportedItemData({ name: 'diamond_sword', count: 1, metadata: 2, nbt: nbtOf({ Damage: { type: 'int', value: 3 } }) }, registry).nbt[0], 'Damage')
  })

  it('enchantments, custom names, book contents and can_destroy lists are refused', () => {
    const sword = item('diamond_sword')
    sword.enchants = [{ name: 'sharpness', lvl: 2 }]
    sword.durabilityUsed = 3
    assert.deepStrictEqual(unsupportedItemData(sword), { nbt: ['ench'], lists: [] })
    const named = item('stone')
    named.customName = 'Named'
    assert.deepStrictEqual(unsupportedItemData(named), { nbt: ['display'], lists: [] })
    const book = item('writable_book')
    book.nbt = nbtOf({ pages: { type: 'list', value: { type: 'compound', value: [{ text: { type: 'string', value: 'hi' } }] } } })
    assert.deepStrictEqual(unsupportedItemData(book), { nbt: ['pages'], lists: [] })
    const pick = item('diamond_pickaxe')
    pick.blocksCanDestroy = ['stone']
    assert.deepStrictEqual(unsupportedItemData(pick), { nbt: [], lists: ['can_destroy'] })
  })

  it('setInventorySlot throws a clear error before sending any command', async () => {
    const { t, commands } = helpers()
    const sword = item('diamond_sword')
    sword.enchants = [{ name: 'sharpness', lvl: 1 }]
    await assert.rejects(t.setInventorySlot(36, sword),
      /^Error: setInventorySlot: NBT cannot be set with replaceitem; use bot\.creative\.setInventorySlot \(U8\) — diamond_sword carries NBT ench$/)
    const pick = item('diamond_pickaxe')
    pick.blocksCanDestroy = ['stone']
    await assert.rejects(t.setInventorySlot(36, pick), /^Error: setInventorySlot: can_destroy cannot be set with replaceitem; .* carries can_destroy$/)
    assert.deepStrictEqual(commands, [])
  })

  it('setInventorySlot sends a damaged tool with its Damage as the data value', async () => {
    const { t, commands } = helpers()
    const sword = item('diamond_sword')
    sword.durabilityUsed = 7
    t.setInventorySlot(36, sword)
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepStrictEqual(commands, ['replaceitem entity bot slot.hotbar 0 diamond_sword 1 7'])
  })
})
