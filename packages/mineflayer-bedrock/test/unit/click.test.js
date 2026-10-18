'use strict'
// owner: U8 (inventory, windows, creative & item use) — lib/bedrock/click.js: Java click semantics → Bedrock steps
const assert = require('assert')
const { createFakeBot } = require('./helpers/fake')
const { planClick, placeBackPlan, armorSlotFor } = require('../../lib/bedrock/click')

describe('clickWindow planner (U8)', function () {
  this.timeout(30000)
  let bot, Item, Window

  before(async () => {
    ({ bot } = await createFakeBot())
    Item = require('prismarine-item')(bot.registry)
    Window = require('prismarine-windows')(bot.registry).Window
  })

  const item = (name, count = 1) => new Item(bot.registry.itemsByName[name].id, count, 0, null, 1, true)
  function inventory (contents = {}, cursor = null) {
    const w = new Window(0, 'minecraft:inventory', 'Inventory', 46, { start: 9, end: 44 }, 0, true)
    for (const [slot, it] of Object.entries(contents)) w.updateSlot(Number(slot), it)
    w.selectedItem = cursor
    return w
  }
  function chest (contents = {}, cursor = null) {
    const w = new Window(3, 'minecraft:generic_9x3', 'Chest', 63, { start: 27, end: 62 }, -1, true)
    for (const [slot, it] of Object.entries(contents)) w.updateSlot(Number(slot), it)
    w.selectedItem = cursor
    return w
  }
  const inv = (w, slot, button, mode, extra = {}) => planClick(w, slot, button, mode, { Item, kind: 'inventory', isCreatedOutput: (s) => s === 0, mayPlace: (s, it) => !(s >= 5 && s <= 8) || armorSlotFor(it) === s, ...extra })
  const box = (w, slot, button, mode) => planClick(w, slot, button, mode, { Item, kind: 'chest' })

  it('mode 0 left: take / place / merge / swap / no-op', () => {
    assert.deepStrictEqual(inv(inventory({ 36: item('stone', 10) }), 36, 0, 0), [{ type: 'take', count: 10, src: 36, dst: 'cursor' }])
    assert.deepStrictEqual(inv(inventory({}, item('stone', 10)), 20, 0, 0), [{ type: 'place', count: 10, src: 'cursor', dst: 20 }])
    assert.deepStrictEqual(inv(inventory({ 20: item('stone', 60) }, item('stone', 10)), 20, 0, 0), [{ type: 'place', count: 4, src: 'cursor', dst: 20 }])
    assert.deepStrictEqual(inv(inventory({ 20: item('stone', 64) }, item('stone', 10)), 20, 0, 0), [])
    assert.deepStrictEqual(inv(inventory({ 20: item('dirt', 2) }, item('stone', 10)), 20, 0, 0), [{ type: 'swap', src: 'cursor', dst: 20 }])
    assert.deepStrictEqual(inv(inventory(), 20, 0, 0), [])
  })

  it('mode 0 right: half / one / one more / swap', () => {
    assert.deepStrictEqual(inv(inventory({ 36: item('stone', 9) }), 36, 1, 0), [{ type: 'take', count: 5, src: 36, dst: 'cursor' }], 'the larger half')
    assert.deepStrictEqual(inv(inventory({}, item('stone', 9)), 12, 1, 0), [{ type: 'place', count: 1, src: 'cursor', dst: 12 }])
    assert.deepStrictEqual(inv(inventory({ 12: item('stone', 3) }, item('stone', 9)), 12, 1, 0), [{ type: 'place', count: 1, src: 'cursor', dst: 12 }])
    assert.deepStrictEqual(inv(inventory({ 12: item('dirt', 3) }, item('stone', 9)), 12, 1, 0), [{ type: 'swap', src: 'cursor', dst: 12 }])
  })

  it('outside the window (-999): drop the cursor stack (left) or one item (right)', () => {
    assert.deepStrictEqual(inv(inventory({}, item('stone', 9)), -999, 0, 0), [{ type: 'drop', count: 9, src: 'cursor' }])
    assert.deepStrictEqual(inv(inventory({}, item('stone', 9)), -999, 1, 0), [{ type: 'drop', count: 1, src: 'cursor' }])
    assert.deepStrictEqual(inv(inventory(), -999, 0, 0), [])
  })

  it('armor slots only take their armor (Java Slot.mayPlace); the crafting result needs bot.craft', () => {
    assert.deepStrictEqual(inv(inventory({}, item('dirt')), 5, 0, 0), [])
    assert.deepStrictEqual(inv(inventory({}, item('iron_helmet')), 5, 0, 0), [{ type: 'place', count: 1, src: 'cursor', dst: 5 }])
    assert.throws(() => inv(inventory({ 0: item('oak_planks', 4) }), 0, 0, 0), /crafting result/)
    assert.deepStrictEqual(inv(inventory(), 0, 0, 0), [])
  })

  it('mode 1 shift, player inventory: main → hotbar, hotbar → main, armor → its slot, merges first', () => {
    assert.deepStrictEqual(inv(inventory({ 12: item('stone', 10) }), 12, 0, 1), [{ type: 'place', count: 10, src: 12, dst: 36 }])
    assert.deepStrictEqual(inv(inventory({ 40: item('stone', 10) }), 40, 0, 1), [{ type: 'place', count: 10, src: 40, dst: 9 }])
    assert.deepStrictEqual(inv(inventory({ 12: item('stone', 10), 38: item('stone', 60), 40: item('stone', 62) }), 12, 0, 1),
      [{ type: 'place', count: 4, src: 12, dst: 38 }, { type: 'place', count: 2, src: 12, dst: 40 }, { type: 'place', count: 4, src: 12, dst: 36 }])
    assert.deepStrictEqual(inv(inventory({ 30: item('iron_boots') }), 30, 0, 1), [{ type: 'place', count: 1, src: 30, dst: 8 }])
    assert.deepStrictEqual(inv(inventory({ 30: item('iron_boots'), 8: item('diamond_boots') }), 30, 0, 1), [{ type: 'place', count: 1, src: 30, dst: 36 }])
    assert.deepStrictEqual(inv(inventory({ 6: item('iron_chestplate') }), 6, 0, 1), [{ type: 'place', count: 1, src: 6, dst: 9 }])
    assert.deepStrictEqual(inv(inventory({ 20: item('shield') }), 20, 0, 1), [{ type: 'place', count: 1, src: 20, dst: 45 }])
    const full = {}
    for (let s = 36; s < 45; s++) full[s] = item('dirt', 64)
    assert.deepStrictEqual(inv(inventory({ ...full, 12: item('stone', 1) }), 12, 0, 1), [], 'no room: nothing moves')
  })

  it('mode 1 shift, chest: container → player part from the end (hotbar first), player → container from the start', () => {
    assert.deepStrictEqual(box(chest({ 3: item('bone', 5) }), 3, 0, 1), [{ type: 'place', count: 5, src: 3, dst: 62 }])
    assert.deepStrictEqual(box(chest({ 3: item('bone', 5), 30: item('bone', 63) }), 3, 0, 1),
      [{ type: 'place', count: 1, src: 3, dst: 30 }, { type: 'place', count: 4, src: 3, dst: 62 }])
    assert.deepStrictEqual(box(chest({ 1: item('bone', 1), 54: item('bone', 5) }), 54, 0, 1), [{ type: 'place', count: 5, src: 54, dst: 1 }])
    assert.deepStrictEqual(box(chest({ 54: item('stone', 5) }), 54, 0, 1), [{ type: 'place', count: 5, src: 54, dst: 0 }])
  })

  it('mode 1 shift into station windows follows the spec rules (furnace fuel/ingredient, brewing, enchanting one item)', () => {
    const { CONTAINER_SPECS } = require('../../lib/bedrock/windows')
    const station = (key, size, contents = {}) => {
      const w = new Window(5, 'x', 'x', size + 36, { start: size, end: size + 35 }, CONTAINER_SPECS[key].craftingResultSlot, true)
      for (const [slot, it] of Object.entries(contents)) w.updateSlot(Number(slot), it)
      return w
    }
    const plan = (key, w, slot) => planClick(w, slot, 0, 1, { Item, kind: 'station', quickMoveTargets: CONTAINER_SPECS[key].quickMoveTargets, slotLimit: (s) => CONTAINER_SPECS[key].slotLimits?.[s] })
    assert.deepStrictEqual(plan('furnace', station('furnace', 3, { 30: item('coal', 8) }), 30), [{ type: 'place', count: 8, src: 30, dst: 1 }])
    assert.deepStrictEqual(plan('furnace', station('furnace', 3, { 30: item('oak_log', 2) }), 30), [{ type: 'place', count: 2, src: 30, dst: 0 }])
    assert.deepStrictEqual(plan('furnace', station('furnace', 3, { 0: item('beef', 64), 3: item('beef', 5) }), 3), [{ type: 'place', count: 5, src: 3, dst: 30 }], 'ingredient full: main → hotbar')
    assert.deepStrictEqual(plan('brewing_stand', station('brewing_stand', 5, { 9: item('glass_bottle', 3) }), 9), [{ type: 'place', count: 1, src: 9, dst: 0 }], 'one bottle per slot')
    assert.deepStrictEqual(plan('brewing_stand', station('brewing_stand', 5, { 9: item('nether_wart', 3) }), 9), [{ type: 'place', count: 3, src: 9, dst: 3 }])
    assert.deepStrictEqual(plan('enchantment', station('enchantment', 2, { 9: item('lapis_lazuli', 10) }), 9), [{ type: 'place', count: 10, src: 9, dst: 1 }])
    assert.deepStrictEqual(plan('furnace', station('furnace', 3, { 2: item('iron_ingot', 3) }), 2), [{ type: 'place', count: 3, src: 2, dst: 38 }], 'result → player part from the end')
  })

  it('mode 2 number keys (and 40 = off-hand), mode 4 drop key, mode 3 creative clone, modes 5/6', () => {
    assert.deepStrictEqual(inv(inventory({ 15: item('gold_ingot', 6) }), 15, 3, 2), [{ type: 'place', count: 6, src: 15, dst: 39 }])
    assert.deepStrictEqual(inv(inventory({ 15: item('gold_ingot', 6), 39: item('stone', 1) }), 15, 3, 2), [{ type: 'swap', src: 15, dst: 39 }])
    assert.deepStrictEqual(inv(inventory({ 39: item('stone', 2) }), 15, 3, 2), [{ type: 'place', count: 2, src: 39, dst: 15 }])
    assert.deepStrictEqual(inv(inventory({ 15: item('arrow', 6) }), 15, 40, 2), [{ type: 'place', count: 6, src: 15, dst: 45 }])
    assert.deepStrictEqual(inv(inventory({ 15: item('stone', 6) }, item('dirt')), 15, 3, 2), [], 'not while carrying')
    assert.deepStrictEqual(inv(inventory({ 15: item('stone', 6) }), 15, 0, 4), [{ type: 'drop', count: 1, src: 15 }])
    assert.deepStrictEqual(inv(inventory({ 15: item('stone', 6) }), 15, 1, 4), [{ type: 'drop', count: 6, src: 15 }])
    assert.deepStrictEqual(inv(inventory({ 15: item('stone', 6) }), 15, 2, 3, { gameMode: 'creative' }), [{ type: 'creative', item: inventory({ 15: item('stone', 6) }).slots[15], count: 64, dst: 'cursor' }])
    assert.deepStrictEqual(inv(inventory({ 15: item('stone', 6) }), 15, 2, 3, { gameMode: 'survival' }), [])
    assert.throws(() => inv(inventory(), 15, 1, 5), /not implemented/)
    assert.throws(() => inv(inventory(), 15, 0, 6), /not implemented/)
    assert.throws(() => inv(inventory(), 15, 9, 2), /invalid operation/)
    assert.throws(() => inv(inventory(), 99, 0, 0), /not part of window/)
  })

  it('placeBackPlan: Java placeItemBackInInventory order (selected, off-hand, stacks with room, first empty, drop)', () => {
    const slots = { 0: item('stone', 60), 4: item('stone', 63), 2: item('dirt', 1) }
    const at = (i) => i === 'offhand' ? item('stone', 62) : (slots[i] ?? null)
    assert.deepStrictEqual(placeBackPlan(Item, at, item('stone', 10), 4), { moves: [{ index: 4, count: 1 }, { index: 'offhand', count: 2 }, { index: 0, count: 4 }, { index: 1, count: 3 }], rest: 0 })
    const full = (i) => i === 'offhand' ? null : item('dirt', 64)
    assert.deepStrictEqual(placeBackPlan(Item, full, item('stone', 10), 0), { moves: [], rest: 10 })
  })
})
