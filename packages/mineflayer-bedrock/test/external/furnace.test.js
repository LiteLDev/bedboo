// owner: U13 (stations)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/furnace.js. Adaptation (docs/differences/U13.md#ported-tests):
 * upstream shortens the cook with `/data merge block … {CookTime:195s}`; Bedrock has no /data (nor /blockdata), so
 * the port waits for the furnace's own 10 s (200 ticks) — everything else, including the fuel / progress window
 * properties and the take/put calls, is verbatim. The furnace is placed with the setblock-based bot.test.placeBlock
 * (U11 upgrades it to bot.placeBlock).
 * Bedrock extras: raw iron in a furnace and a blast furnace, beef in a smoker (progress normalised by the block's
 * own cook time, fuel by the fuel's burn time), and a furnace opened while it already burns (container_set_data
 * arrives before container_open).
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('furnace', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    if (ctx.bot.currentWindow) await ctx.bot.closeWindow(ctx.bot.currentWindow).catch(() => {})
    await ctx.bot.test.becomeCreative()
  })

  it('furnace', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    const furnacePos = bot.entity.position.offset(2, 0, 0).floored()
    const coalId = bot.registry.itemsByName.coal.id
    const porkchopId = bot.registry.itemsByName.porkchop.id
    const cookedPorkchopId = bot.registry.itemsByName.cooked_porkchop.id
    const coalInputCount = 2
    const porkchopInputCount = 2

    // Test setup
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.furnace.id, 1))
    await bot.test.placeBlock(36, furnacePos)
    await bot.test.setInventorySlot(37, new Item(porkchopId, porkchopInputCount))
    await bot.test.setInventorySlot(38, new Item(coalId, coalInputCount)) // Get coal
    if (bot.supportFeature('itemsAreAlsoBlocks')) {
      assert.strictEqual(bot.blockAt(furnacePos).type, bot.registry.itemsByName.furnace.id)
    } else {
      assert.strictEqual(bot.blockAt(furnacePos).type, bot.registry.blocksByName.furnace.id)
    }

    // Put inputs
    const furnace = await bot.openFurnace(bot.blockAt(furnacePos))
    assert.strictEqual(furnace.inputItem(), furnace.slots[0])
    assert.strictEqual(furnace.fuelItem(), furnace.slots[1])
    assert.strictEqual(furnace.outputItem(), furnace.slots[2])
    assert.strictEqual(furnace.inputItem(), null)
    assert.strictEqual(furnace.fuelItem(), null)
    assert.strictEqual(furnace.outputItem(), null)

    await furnace.putFuel(coalId, null, coalInputCount)

    assert.strictEqual(furnace.fuelItem(), furnace.slots[1])
    assert.strictEqual(furnace.fuelItem().type, coalId)
    assert.strictEqual(furnace.fuelItem().count, coalInputCount)

    await furnace.putInput(porkchopId, null, porkchopInputCount)

    assert.strictEqual(furnace.inputItem(), furnace.slots[0])
    assert.strictEqual(furnace.inputItem().type, porkchopId)
    assert.strictEqual(furnace.inputItem().count, porkchopInputCount)

    // Burning starts on the next server tick; the window properties carrying
    // fuel and progress arrive as furnace updates, not with the item packets.
    await onceWithCleanup(furnace, 'update', {
      timeout: 5000,
      checkCondition: () => furnace.fuel > 0 && furnace.fuel < 1 && furnace.progress > 0 && furnace.progress < 1
    })
    assert(furnace.fuel > 0 && furnace.fuel < 1)
    assert(furnace.progress > 0 && furnace.progress < 1)

    // Bedrock: no /data merge to shorten the cook — the furnace finishes the item after its 200 ticks (10 s)
    await onceWithCleanup(furnace, 'update', { timeout: 15000, checkCondition: () => furnace.outputItem() !== null })
    assert.strictEqual(furnace.outputItem(), furnace.slots[2])
    assert.strictEqual(furnace.outputItem().type, cookedPorkchopId)
    assert.strictEqual(furnace.outputItem().count, 1)

    assert.strictEqual(furnace.inputItem().type, porkchopId)
    assert.strictEqual(furnace.inputItem().count, porkchopInputCount - 1)

    assert.strictEqual(furnace.fuelItem().type, coalId)
    assert.strictEqual(furnace.fuelItem().count, coalInputCount - 1)

    await furnace.takeOutput()
    await furnace.takeInput()
    await furnace.takeFuel()
    await furnace.close()

    // Check inventory
    const cookedPorkchopCount = bot.inventory.count(cookedPorkchopId)
    const porkchopCount = bot.inventory.count(porkchopId)
    const coalCount = bot.inventory.count(coalId)

    assert.strictEqual(cookedPorkchopCount, 1)
    assert.strictEqual(porkchopCount, porkchopInputCount - 1)
    assert.strictEqual(coalCount, coalInputCount - 1)
  })

  // block, input, output, cook ticks, coal burn ticks
  const SMELTERS = [
    ['furnace', 'raw_iron', 'iron_ingot', 200, 1600],
    ['blast_furnace', 'raw_iron', 'iron_ingot', 100, 800],
    ['smoker', 'beef', 'cooked_beef', 100, 800]
  ]
  for (const [block, input, output, cookTicks, burnTicks] of SMELTERS) {
    it(`${block}: ${input} → ${output}, fuel / progress / seconds from container_set_data (Bedrock extra)`, async () => {
      const { bot } = ctx
      const Item = require('prismarine-item')(bot.registry)
      const id = (name) => bot.registry.itemsByName[name].id
      await bot.test.setInventorySlot(36, new Item(id(input), 2))
      await bot.test.setInventorySlot(37, new Item(id('coal'), 1))
      await bot.test.becomeSurvival()
      const pos = bot.entity.position.offset(2, 0, 0).floored()
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: block })

      const furnace = await bot.openFurnace(bot.blockAt(pos))
      assert.strictEqual(furnace.type, `minecraft:${block}`)
      assert.strictEqual(furnace.totalProgress, cookTicks, 'the block\'s cook time (Java property 3)')
      assert.strictEqual(furnace.totalProgressSeconds, cookTicks / 20)
      await furnace.putFuel(id('coal'), null, 1)
      await furnace.putInput(id(input), null, 2)
      assert.strictEqual(bot.inventory.count(id(input)), 0)

      const started = Date.now()
      await onceWithCleanup(furnace, 'update', { timeout: 5000, checkCondition: () => furnace.progress > 0.2 })
      assert.strictEqual(furnace.totalFuel, burnTicks, 'burn time of one coal in this block')
      assert.ok(furnace.fuel > 0.5 && furnace.fuel < 1, `fuel ${furnace.fuel}`)
      assert.ok(Math.abs(furnace.fuelSeconds - furnace.fuel * burnTicks / 20) < 1e-9)
      assert.ok(Math.abs(furnace.progressSeconds - (1 - furnace.progress) * cookTicks / 20) < 1e-9, 'seconds left')

      await onceWithCleanup(furnace, 'update', { timeout: cookTicks * 50 + 5000, checkCondition: () => furnace.outputItem() !== null })
      const elapsed = Date.now() - started
      assert.ok(elapsed < cookTicks * 50 + 2000, `cooked in ${elapsed} ms`)
      assert.strictEqual(furnace.outputItem().name, output)
      assert.strictEqual(furnace.inputItem().count, 1)
      assert.strictEqual(furnace.fuelItem(), null, 'the coal burns')

      const taken = await furnace.takeOutput()
      assert.strictEqual(taken.name, output)
      assert.strictEqual(furnace.outputItem(), null)
      await furnace.close()
      assert.strictEqual(bot.inventory.count(id(output)), 1)

      // reopened while it burns: the values sent before container_open are applied at once
      const again = await bot.openFurnace(bot.blockAt(pos))
      assert.strictEqual(again.totalFuel, burnTicks)
      assert.ok(again.fuel > 0 && again.fuel < 1, `fuel ${again.fuel}`)
      assert.ok(again.progress > 0 && again.progress < 1, `progress ${again.progress}`)
      assert.strictEqual(again.inputItem().name, input)
      await again.takeInput()
      await again.close()
      assert.strictEqual(bot.inventory.count(id(input)), 1)
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
    })
  }
})
