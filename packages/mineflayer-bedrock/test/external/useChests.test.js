// owner: U8 → U11 (inventory, windows, creative & item use; U11 re-runs the verbatim placeBlock version)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/useChests.js, staged with /setblock instead of bot.placeBlock (U11
 * runs the verbatim placement version in wave 4). Adaptations (docs/differences/U8.md#use-chests):
 * - chests are set with the console: Bedrock pairs two adjacent chests that face the same way along the axis
 *   perpendicular to their facing, so the large trapped chest (along z) is set facing east;
 * - the chestLidMove assertions run when the event fires (U9's block_actions; not emitted before it lands);
 * - fillChest uses Bedrock's `/replaceitem block … slot.container <n> <item> <count>` (feature
 *   replaceItemSlotIsPrefixed) sent by the bot (bot.chat).
 * Bedrock extras: barrel, shulker box, dispenser, dropper and hopper windows (deposit / withdraw / click).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('useChests', function () {
  this.timeout(180000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('useChests', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    // openContainer and placeBlock turn to face the block before acting.
    bot.physics.yawSpeed = bot.physics.pitchSpeed = 1e3

    bot.test.groundY = bot.supportFeature('tallWorld') ? -60 : 4

    const smallChestLocation = new Vec3(0, bot.test.groundY, -1)
    const largeChestLocations = [new Vec3(0, bot.test.groundY, 1), new Vec3(1, bot.test.groundY, 1)]
    const smallTrappedChestLocation = new Vec3(1, bot.test.groundY, 0)
    const largeTrappedChestLocations = [
      new Vec3(-1, bot.test.groundY, 1),
      new Vec3(-1, bot.test.groundY, 0)
    ]
    const chestSlot = 36
    const trappedChestSlot = 37
    const boneSlot = 38

    let blockItemsByName
    if (bot.supportFeature('itemsAreNotBlocks')) {
      blockItemsByName = 'itemsByName'
    } else if (bot.supportFeature('itemsAreAlsoBlocks')) {
      blockItemsByName = 'blocksByName'
    }

    const chestBlockId = bot.registry.blocksByName.chest.id
    const trappedChestBlockId = bot.registry.blocksByName.trapped_chest.id

    function itemByName (items, name) {
      for (let i = 0; i < items.length; ++i) {
        const item = items[i]
        if (item && item.name === name) return item
      }
      return null
    }

    async function depositBones (chestLocation, count) {
      const chest = await bot.openContainer(bot.blockAt(chestLocation))
      assert(chest.containerItems().length === 0)
      assert(chest.items().length > 0)
      const name = 'bone'
      const item = itemByName(chest.items(), name)
      if (!item) {
        bot.test.sayEverywhere(`unknown item ${name}`)
        throw new Error(`unknown item ${name}`)
      }
      await chest.deposit(item.type, null, count)
      await chest.close()
    }

    async function withdrawBones (chestLocation, count) {
      const chest = await bot.openContainer(bot.blockAt(chestLocation))
      const name = 'bone'
      const item = itemByName(chest.containerItems(), name)
      if (!item) {
        bot.test.sayEverywhere(`unknown item ${name}`)
        throw new Error(`unknown item ${name}`)
      }
      await chest.withdraw(item.type, null, count)
      assert(chest.containerItems().length === 0)
      assert(chest.items().length > 0)
      await chest.close()
    }

    await bot.test.setInventorySlot(chestSlot, new Item(bot.registry[blockItemsByName].chest.id, 3, 0))
    await bot.test.setInventorySlot(trappedChestSlot, new Item(bot.registry[blockItemsByName].trapped_chest.id, 3, 0))
    await bot.test.setInventorySlot(boneSlot, new Item(bot.registry.itemsByName.bone.id, 3, 0))

    await bot.test.becomeSurvival()

    // place the chests around us (Bedrock: console /setblock, see the module comment)
    const place = (pos, blockName) => bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName })
    await place(largeChestLocations[0], 'chest')
    await place(largeChestLocations[1], 'chest')
    await place(smallChestLocation, 'chest')
    await place(largeTrappedChestLocations[0], 'trapped_chest ["minecraft:cardinal_direction"="east"]')
    await place(largeTrappedChestLocations[1], 'trapped_chest ["minecraft:cardinal_direction"="east"]')
    await place(smallTrappedChestLocation, 'trapped_chest')
    // the chests were set by the console, not taken from the inventory
    await bot.test.setInventorySlot(chestSlot, null)
    await bot.test.setInventorySlot(trappedChestSlot, null)

    assert.strictEqual(bot.blockAt(largeChestLocations[0]).type, chestBlockId)
    assert.strictEqual(bot.blockAt(largeChestLocations[1]).type, chestBlockId)
    assert.strictEqual(bot.blockAt(smallChestLocation).type, chestBlockId)
    assert.strictEqual(bot.blockAt(largeTrappedChestLocations[0]).type, trappedChestBlockId)
    assert.strictEqual(bot.blockAt(largeTrappedChestLocations[1]).type, trappedChestBlockId)
    assert.strictEqual(bot.blockAt(smallTrappedChestLocation).type, trappedChestBlockId)

    // Test that "chestLidMove" is emitted only once when opening a double chest
    let emitted = false
    bot.on('chestLidMove', handler)
    async function handler (block, isOpen, block2) {
      if (emitted) {
        assert.fail(new Error('chestLidMove emitted twice'))
      } else {
        emitted = true

        let blockAssert = false; let block2Assert = false
        for (const location of largeChestLocations) {
          if (location.equals(block.position)) blockAssert = true
          if (location.equals(block2.position)) block2Assert = true
        }
        assert(blockAssert && block2Assert, new Error('The block instance emitted by chestLidMove is not part of the chest oppened'))
        assert.strictEqual(isOpen, 1, new Error('isOpen should be 1 when opened by one only player'))
      }
    }
    const chest = await bot.openContainer(bot.blockAt(largeChestLocations[0]))
    assert.strictEqual(chest.inventoryStart, 54, 'a double chest')
    assert.strictEqual(chest.type, 'minecraft:generic_9x6')
    await bot.test.wait(500)
    bot.removeListener('chestLidMove', handler)
    const closed = once(chest, 'close')
    chest.close()
    await closed

    await depositBones(smallChestLocation, 1)
    await depositBones(largeChestLocations[0], 2)

    assert(bot.inventory.items().length === 0)

    await withdrawBones(smallChestLocation, 1)
    await withdrawBones(largeChestLocations[0], 2)

    await depositBones(smallTrappedChestLocation, 1)
    await depositBones(largeTrappedChestLocations[0], 2)

    assert(bot.inventory.items().length === 0)

    await withdrawBones(smallTrappedChestLocation, 1)
    await withdrawBones(largeTrappedChestLocations[0], 2)

    // Deposit part of a stack: the halving path must leave the same counts as one-by-one
    const boneCount = (items) => items.filter(item => item.name === 'bone').reduce((sum, item) => sum + item.count, 0)
    await bot.test.becomeCreative()
    await bot.test.setInventorySlot(itemByName(bot.inventory.slots, 'bone').slot, new Item(bot.registry.itemsByName.bone.id, 64, 0))
    await bot.test.becomeSurvival()
    assert.strictEqual(boneCount(bot.inventory.items()), 64)
    const partialChest = await bot.openContainer(bot.blockAt(smallChestLocation))
    await partialChest.deposit(bot.registry.itemsByName.bone.id, null, 36)
    assert.strictEqual(itemByName(partialChest.containerItems(), 'bone').count, 36)
    assert.strictEqual(boneCount(partialChest.items()), 28)
    await partialChest.withdraw(bot.registry.itemsByName.bone.id, null, 36)
    assert.strictEqual(partialChest.containerItems().length, 0)
    assert.strictEqual(boneCount(partialChest.items()), 64)
    partialChest.close()

    const itemsWithStackSize = {
      64: ['stone', 'mycelium'],
      16: ['ender_pearl', 'egg'],
      1: ['fishing_rod', 'bow']
    }

    // The transition cases need one stack of more than 2, a second stack of a
    // different type, and a free slot. Nothing asserts on a fuller chest.
    const layout = [
      { slot: 0, name: itemsWithStackSize[64][0], count: 8 },
      { slot: 1, name: itemsWithStackSize[64][1], count: 8 },
      { slot: 2, name: itemsWithStackSize[16][0], count: 4 }
    ]

    // Write the slots server side. Filling them by clicking leaves the result at
    // the mercy of the client's predicted state, which from 1.17 is not confirmed
    // per click, and a lost move is invisible until an assertion reads the slot.
    function fillChest (pos) {
      const at = `${pos.x} ${pos.y} ${pos.z}`
      for (const { slot, name, count } of layout) {
        const item = bot.registry.itemsByName[name]
        assert.ok(item, `${name} should exist on this version`)
        if (bot.supportFeature('hasItemCommand')) {
          bot.chat(`/item replace block ${at} container.${slot} with ${name} ${count}`)
        } else if (bot.supportFeature('replaceItemSlotIsPrefixed')) {
          bot.chat(`/replaceitem block ${at} slot.container ${slot} ${name} ${count}`)
        } else {
          bot.chat(`/replaceitem block ${at} container.${slot} ${name} ${count}`)
        }
      }
    }

    // Each left/right click resolves differently depending on whether the cursor
    // is holding something and what is in the target slot, so every case needs
    // its own precondition rather than another random click.
    async function testClickTransitions (window) {
      const held = () => window.selectedItem
      const find = (pred) => {
        for (let i = 0; i < window.inventoryStart; i++) {
          if (pred(window.slots[i], i)) return i
        }
        return -1
      }

      assert.ok(!held(), 'cursor must start empty')

      // Needs more than 2 so there is still something on the cursor after placing
      // one, and something left to merge back.
      const a = find(s => s !== null && s.count > 2)
      assert.notStrictEqual(a, -1, 'expected an occupied slot holding more than 2')
      const taken = { type: window.slots[a].type, count: window.slots[a].count }
      await bot.clickWindow(a, 0, 0)
      assert.ok(held(), 'left click on an occupied slot should take it')
      assert.strictEqual(held().type, taken.type)
      assert.strictEqual(held().count, taken.count)
      assert.strictEqual(window.slots[a], null)

      // holding + empty slot, right click -> place exactly one
      await bot.clickWindow(a, 1, 0)
      assert.ok(window.slots[a], 'right click on an empty slot should place one')
      assert.strictEqual(window.slots[a].count, 1)
      assert.strictEqual(held().count, taken.count - 1)

      // holding + occupied slot of the same type -> merge into it. The slot holds
      // 1 and the cursor the rest of the same stack, so all of it fits and the
      // cursor is left empty.
      await bot.clickWindow(a, 0, 0)
      assert.strictEqual(window.slots[a].type, taken.type)
      assert.strictEqual(window.slots[a].count, taken.count, 'the whole stack should merge back')
      assert.ok(!held(), 'a merge that fits should empty the cursor')

      // holding + occupied slot of a different type -> swap
      await bot.clickWindow(a, 0, 0)
      assert.ok(held(), 'expected to be holding the merged stack')
      const other = find((s, i) => s !== null && i !== a && s.type !== held().type)
      assert.notStrictEqual(other, -1, 'expected a slot holding a different item type')
      const there = { type: window.slots[other].type, count: window.slots[other].count }
      const cursor = { type: held().type, count: held().count }
      await bot.clickWindow(other, 0, 0)
      assert.strictEqual(window.slots[other].type, cursor.type, 'swap should leave the cursor item in the slot')
      assert.strictEqual(window.slots[other].count, cursor.count)
      assert.strictEqual(held().type, there.type, 'swap should leave the slot item on the cursor')
      assert.strictEqual(held().count, there.count)

      // holding + empty slot -> drop the whole stack
      await bot.clickWindow(a, 0, 0)
      assert.ok(!held(), 'left click on an empty slot should drop the whole stack')
      assert.strictEqual(window.slots[a].type, there.type)

      // empty cursor + occupied slot, right click -> take half
      const big = find(s => s !== null && s.count > 1)
      assert.notStrictEqual(big, -1, 'expected a slot holding more than 1')
      const whole = window.slots[big].count
      await bot.clickWindow(big, 1, 0)
      assert.ok(held(), 'right click on an occupied slot should take half')
      assert.strictEqual(held().count + (window.slots[big]?.count ?? 0), whole, 'the halves should account for the whole stack')
      await bot.clickWindow(big, 0, 0)
      assert.ok(!held(), 'putting the half back should empty the cursor')

      // shift click moves the stack out of the chest entirely
      const move = find(s => s !== null)
      assert.notStrictEqual(move, -1, 'expected an occupied slot to shift click')
      await bot.clickWindow(move, 0, 1)
      assert.strictEqual(window.slots[move], null, 'shift click should empty the chest slot')
    }

    function clearLargeChest () {
      bot.chat(`/setblock ${largeChestLocations[0].x} ${largeChestLocations[0].y} ${largeChestLocations[0].z} chest`)
      bot.chat(`/setblock ${largeChestLocations[1].x} ${largeChestLocations[1].y} ${largeChestLocations[1].z} chest`)
    }

    fillChest(largeChestLocations[0])
    const window = await bot.openContainer(bot.blockAt(largeChestLocations[0]))
    // Which half of a double chest the window lists first depends on the version.
    for (const { name, count } of layout) {
      const slot = window.slots.findIndex((s, i) => i < window.inventoryStart && s?.name === name)
      assert.notStrictEqual(slot, -1, `expected ${name} in the chest`)
      assert.strictEqual(window.slots[slot].count, count)
    }
    await testClickTransitions(window)

    await window.close()
    clearLargeChest()
  })

  for (const [blockName, javaType, size] of [
    ['barrel', 'minecraft:generic_9x3', 27],
    ['white_shulker_box', 'minecraft:shulker_box', 27],
    ['undyed_shulker_box', 'minecraft:shulker_box', 27],
    ['dispenser', 'minecraft:generic_3x3', 9],
    ['dropper', 'minecraft:generic_3x3', 9],
    ['hopper', 'minecraft:hopper', 5],
    ['ender_chest', 'minecraft:generic_9x3', 27]
  ]) {
    it(`${blockName}: openContainer, deposit, click, withdraw, close (Bedrock extra)`, async () => {
      const { bot } = ctx
      const Item = require('prismarine-item')(bot.registry)
      const boneId = bot.registry.itemsByName.bone.id
      await bot.test.setInventorySlot(36, new Item(boneId, 5, 0))
      await bot.test.becomeSurvival()
      const pos = new Vec3(2, bot.test.groundY, 0)
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName })
      const opened = once(bot, 'windowOpen')
      const container = await bot.openContainer(bot.blockAt(pos))
      const [announced] = await opened
      assert.strictEqual(announced, container)
      assert.strictEqual(bot.currentWindow, container)
      assert.strictEqual(container.type, javaType)
      assert.strictEqual(container.inventoryStart, size)
      assert.strictEqual(container.slots.length, size + 36)
      assert.strictEqual(container.slots[container.hotbarStart]?.name, 'bone', 'the player part mirrors bot.inventory')
      await container.deposit(boneId, null, 3)
      assert.strictEqual(container.containerCount(boneId), 3)
      assert.strictEqual(bot.inventory.count(boneId), 2)
      // move one bone inside the container with the cursor
      const at = container.containerItems()[0].slot
      const target = container.firstEmptyContainerSlot()
      await bot.clickWindow(at, 1, 0) // take half (2)
      await bot.clickWindow(target, 0, 0)
      assert.strictEqual(container.slots[target].count, 2)
      await container.withdraw(boneId, null, 2)
      assert.strictEqual(container.containerCount(boneId), 1)
      assert.strictEqual(bot.inventory.count(boneId), 4)
      const closed = once(bot, 'windowClose')
      await container.close()
      await closed
      assert.strictEqual(bot.currentWindow, null)
      // the server agrees (the container is a block entity: reopen it)
      const again = await bot.openContainer(bot.blockAt(pos))
      assert.strictEqual(again.containerCount(boneId), 1)
      await again.close()
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
    })
  }
})
