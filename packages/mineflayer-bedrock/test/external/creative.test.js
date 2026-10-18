// owner: U8 (inventory, windows, creative & item use)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/creative.js. Item ids 1-4 are Bedrock ids too (stone, grass_block,
 * dirt, cobblestone — all in the creative inventory), so the body is verbatim except the concurrent second call:
 * upstream wraps the async call in try/catch, which never catches (its rejection is unhandled); here the
 * rejection is awaited and asserted. Bedrock extras: off-hand / armor slots, NBT variants from the creative
 * inventory, the error for items it does not have, and flight delegation (U5).
 */
const assert = require('assert')
const wait = require('util').promisify(setTimeout)
const { Vec3 } = require('vec3')
const { useBot, implemented } = require('./common')
const SLOT = 36

describe('creative', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('creative', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)

    const item1 = new Item(1, 1, 0)
    const item2 = new Item(2, 1, 0)

    const promise = bot.creative.setInventorySlot(SLOT, item2)

    await assert.rejects(bot.creative.setInventorySlot(SLOT, item1), (err) => {
      assert.ok(err instanceof Error, 'The error has not been passed')
      assert.match(err.message, /cancelled due to calling bot\.creative\.setInventorySlot\(36/)
      return true
    })

    // setting a slot once works
    await promise
    assert.ok(bot.inventory.slots[SLOT] != null)
    assert.ok(bot.inventory.slots[SLOT].type === item2.type)
    // set the same item in the same slot again to ensure we don't hang
    const returnValue = await Promise.race([
      bot.creative.setInventorySlot(SLOT, item2),
      (async () => {
        await wait(5000) // after 5 seconds just fail the test
        return 'Setting the same item in the same slot took too long'
      })()
    ])
    if (typeof returnValue === 'string') {
      throw new Error(returnValue)
    }
    // setting that same slot again works
    await bot.creative.setInventorySlot(SLOT, new Item(3, 1, 0))
    assert.strictEqual(bot.inventory.slots[SLOT].type, 3)
    // and again works
    await bot.creative.setInventorySlot(SLOT, new Item(4, 1, 0))
    assert.strictEqual(bot.inventory.slots[SLOT].type, 4)
    // setting a slot to null
    await bot.creative.setInventorySlot(SLOT, null)
    assert.strictEqual(bot.inventory.slots[SLOT], null)
    // clear slot
    await bot.creative.setInventorySlot(SLOT, new Item(4, 1, 0))
    assert.strictEqual(bot.inventory.slots[SLOT].type, 4)
    await bot.creative.clearSlot(SLOT)
    assert.strictEqual(bot.inventory.slots[SLOT], null)
    // clear inventory
    for (let i = 0; i < 9; i++) {
      await bot.creative.setInventorySlot(36 + i, new Item(1, 1, 0))
    }
    assert.strictEqual(bot.inventory.slots.filter(item => item).length, 9)
    await bot.creative.clearInventory()
    assert.strictEqual(bot.inventory.slots.filter(item => item).length, 0)
  })

  it('armor, off-hand, main inventory and full stacks match the server (Bedrock extra)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const byName = (name, count = 1) => new Item(bot.registry.itemsByName[name].id, count, 0)
    await bot.creative.setInventorySlot(5, byName('diamond_helmet'))
    await bot.creative.setInventorySlot(8, byName('iron_boots'))
    await bot.creative.setInventorySlot(45, byName('shield'))
    await bot.creative.setInventorySlot(20, byName('cobblestone', 64))
    await bot.creative.setInventorySlot(36, byName('diamond_sword'))
    assert.strictEqual(bot.inventory.slots[5].name, 'diamond_helmet')
    assert.strictEqual(bot.inventory.slots[45].name, 'shield')
    assert.strictEqual(bot.inventory.slots[20].count, 64)
    assert.deepStrictEqual(bot.entity.equipment.map(i => i?.name ?? null), ['diamond_sword', 'shield', 'iron_boots', null, null, 'diamond_helmet'])
    // the server's view (raw inventory packets after a console no-op) agrees with the model
    const raw = bot.test.ctx.packet('inventory_content', (p) => p.window_id === 'inventory', 10000)
    await bot.test.give('stick', 1)
    await raw.promise
    const inv = bot.test.rawInventory()
    assert.strictEqual(inv.armor[0]?.name, 'diamond_helmet')
    assert.strictEqual(inv.armor[3]?.name, 'iron_boots')
    assert.strictEqual(inv.offhand[0]?.name, 'shield')
    assert.strictEqual(inv.inventory[20]?.count, 64)
    assert.strictEqual(inv.inventory[0]?.name, 'diamond_sword')
    // every item carries its server stack id
    for (const slot of [5, 8, 20, 36, 45]) assert.ok(bot.inventory.slots[slot].stackId > 0, `slot ${slot} stack id`)
    await bot.creative.clearInventory()
    assert.strictEqual(bot.inventory.slots.filter(Boolean).length, 0)
  })

  it('creative inventory NBT variants; items it does not list are refused (Bedrock extra)', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const book = bot._bedrock.creativeItems.entries.find(e => e.item.name === 'enchanted_book' && e.item.nbt)
    assert.ok(book, 'the creative inventory lists enchanted books')
    const wanted = new Item(book.item.type, 1, book.item.metadata, JSON.parse(JSON.stringify(book.item.nbt)))
    await bot.test.setInventorySlot(37, wanted)
    assert.strictEqual(bot.inventory.slots[37].name, 'enchanted_book')
    assert.deepStrictEqual(bot.inventory.slots[37].nbt, book.item.nbt)
    const custom = new Item(bot.registry.itemsByName.diamond_sword.id, 1, 0)
    custom.nbt.value.display = { type: 'compound', value: { Name: { type: 'string', value: 'Excalibur' } } }
    await assert.rejects(bot.creative.setInventorySlot(38, custom), /not in the server's creative inventory/)
    assert.strictEqual(bot.inventory.slots[38], null)
  })

  it('startFlying / stopFlying / flyTo (flight: U5 physics hook)', async function () {
    const { bot } = ctx
    if (!implemented(bot._bedrock.physics.flyTo)) this.skip() // bot._bedrock.physics.flyTo lands with U5
    const gravity = bot.physics.gravity
    bot.creative.startFlying()
    // W3-FIX-A: the Bedrock engine flies by itself; upstream's gravity = 0 would outlive a flight ended by the server
    assert.strictEqual(bot.physics.gravity, gravity)
    const target = bot.entity.position.offset(0, 3, 0)
    await bot.creative.flyTo(target)
    assert.ok(bot.entity.position.distanceTo(target) < 0.5, `flew to ${bot.entity.position}`)
    bot.creative.stopFlying()
    await bot.test.teleport(new Vec3(0, bot.test.groundY, 0))
  })
})
