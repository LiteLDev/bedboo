// owner: U13 (stations)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/anvil.js (its four tests, same names and assertions). Adaptations
 * (docs/differences/U13.md#ported-tests):
 * - `/xp set <bot> 999 levels` does not exist on Bedrock: bot.test.setExperienceLevel(999) (`/xp -100000L` +
 *   `/xp 999L`);
 * - the enchanted sword (`makeItem({ enchants })`) cannot be created on Bedrock (creative only creates catalogue
 *   items; replaceitem has no NBT): it is a plain sword enchanted with `/enchant` (bot.test.enchantInventorySlot);
 *   the enchanted books are the creative catalogue's (makeBook, verbatim);
 * - a Bedrock custom name is the plain string (Java 1.13.2+: a JSON text component): renameName(name) = name;
 * - renameCost() is 0 without the Java version comparison (the Bedrock registry cannot compare with '1.8.9');
 * - the anvil is placed with the setblock-based bot.test.placeBlock (U11 upgrades it to bot.placeBlock).
 * Bedrock extras: the server's copy of every result (inventory resend) equals the client's prediction, a repair
 * with materials, a renamed stack, and the "Not anvil-able" guard.
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('anvil', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    if (ctx.bot.currentWindow) await ctx.bot.closeWindow(ctx.bot.currentWindow).catch(() => {})
    await ctx.bot.test.becomeCreative()
  })

  async function runTest (bot, testFunction) {
    const Item = require('prismarine-item')(bot.registry)
    const renameCost = () => 0 // weird quirk of anvils (Bedrock: a rename keeps the penalty; registry has no '1.8.9' — adapted)
    const renameName = (name) => name // Bedrock: the plain name (adapted; Java 1.13.2+: JSON.stringify({ text: name }))
    await bot.test.becomeCreative()
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.anvil.id, 1))
    await bot.test.becomeSurvival()
    await bot.test.placeBlock(36, bot.entity.position.offset(1, 0, 0))

    await bot.test.setExperienceLevel(999) // Bedrock has no `/xp set … levels` (adapted)

    const b = bot.findBlock({ matching: bot.registry.blocksByName.anvil.id }) // find anvil before tests so all tests can use it

    function makeBook (enchants) {
      return makeItem({ type: bot.registry.itemsByName.enchanted_book.id, count: 1, enchants })
    }

    function makeItem (opts) {
      const { type, count = 1, enchants, repairCost } = opts
      const item = new Item(type, count)
      if (enchants) item.enchants = enchants
      if (repairCost) item.repairCost = repairCost
      return item
    }

    /** Bedrock: an enchanted item comes from /enchant on a plain one (adapted makeItem({ enchants })) */
    async function setEnchantedItem (slot, opts) {
      const { type, count = 1, enchants } = opts
      await bot.test.enchantInventorySlot(slot, new Item(type, count), enchants)
    }
    await testFunction(b, renameCost, renameName, Item, bot, makeBook, makeItem, setEnchantedItem)
  }

  /** the anvil result as the server has it equals the client's prediction */
  async function assertServerCopy (bot, slot) {
    const predicted = bot.inventory.slots[slot]
    await bot.test.resyncInventory()
    const server = bot.inventory.slots[slot]
    assert.ok(server, `slot ${slot} holds the result`)
    assert.strictEqual(server.name, predicted.name)
    assert.strictEqual(server.count, predicted.count)
    assert.deepStrictEqual(server.nbt, predicted.nbt)
  }

  it('anvil combine two items', () => runTest(ctx.bot, async (b, renameCost, renameName, Item, bot, makeBook, makeItem) => { // combine two items
    await bot.test.becomeCreative()
    // get items
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.diamond_sword.id, 1))
    await bot.test.setInventorySlot(37, makeBook([{ name: 'sharpness', lvl: 5 }]))
    await bot.test.becomeSurvival()

    const anvil = await bot.openAnvil(b)

    const sword = anvil.findInventoryItem(bot.registry.itemsByName.diamond_sword.id)
    const book = anvil.findInventoryItem(bot.registry.itemsByName.enchanted_book.id)

    await anvil.combine(sword, book)
    // test result
    assert.strictEqual(bot.experience.level, 994)
    assert.strictEqual(anvil.slots[3].repairCost, 1)
    assert.deepStrictEqual(anvil.slots[3].enchants, [{ name: 'sharpness', lvl: 5 }])
    await anvil.close()
    await bot.test.wait(1000)
    await assertServerCopy(bot, 9) // Bedrock extra
  }))

  it('anvil combine with nbt selection two items', () => runTest(ctx.bot, async (b, renameCost, renameName, Item, bot, makeBook, makeItem, setEnchantedItem) => { // combining two items in inventory, but there are three items, so this is more a test of using nbt when picking the item in inventory
    bot.chat(`/clear ${bot.username}`)
    await bot.test.becomeCreative()

    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.diamond_sword.id, 1))
    await setEnchantedItem(37, { type: bot.registry.itemsByName.diamond_sword.id, enchants: [{ name: 'sharpness', lvl: 5 }] }) // adapted
    await bot.test.setInventorySlot(38, makeBook([{ name: 'unbreaking', lvl: 3 }]))

    await bot.test.becomeSurvival()

    const anvil = await bot.openAnvil(b)

    const sword = bot.inventory.slots[37]
    const book = anvil.findInventoryItem(bot.registry.itemsByName.enchanted_book.id)

    await anvil.combine(sword, book)
    // test result
    assert.strictEqual(bot.experience.level, 996)
    assert.strictEqual(anvil.slots[3].repairCost, 1)
    assert.deepStrictEqual(anvil.slots[3].enchants, [{ name: 'sharpness', lvl: 5 }, { name: 'unbreaking', lvl: 3 }])
    await anvil.close()
    await bot.test.wait(1000)
    await assertServerCopy(bot, 9) // Bedrock extra
  }))

  it('anvil using anvil.rename', () => runTest(ctx.bot, async (b, renameCost, renameName, Item, bot, makeBook, makeItem) => { // using anvil.rename
    bot.chat(`/clear ${bot.username}`)
    await bot.test.becomeCreative()

    await bot.test.setInventorySlot(36, makeItem({ type: bot.registry.itemsByName.diamond_sword.id }))

    await bot.test.becomeSurvival()

    const anvil = await bot.openAnvil(b)

    const sword = anvil.findInventoryItem(bot.registry.itemsByName.diamond_sword.id)
    await anvil.rename(sword, 'hello')
    // test result
    assert.strictEqual(bot.experience.level, 998)
    assert.strictEqual(anvil.slots[3].repairCost, renameCost())
    assert.deepStrictEqual(anvil.slots[3].customName, renameName('hello'))
    await anvil.close()
    await bot.test.wait(1000)
    await assertServerCopy(bot, 9) // Bedrock extra
  }))

  it('anvil two item + rename', () => runTest(ctx.bot, async (b, renameCost, renameName, Item, bot, makeBook, makeItem, setEnchantedItem) => { // test 2 + a rename
    bot.chat(`/clear ${bot.username}`)
    await bot.test.becomeCreative()

    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.diamond_sword.id, 1))
    await setEnchantedItem(37, { type: bot.registry.itemsByName.diamond_sword.id, enchants: [{ name: 'sharpness', lvl: 5 }] }) // adapted
    await bot.test.setInventorySlot(38, makeBook([{ name: 'unbreaking', lvl: 3 }]))

    await bot.test.becomeSurvival()

    const anvil = await bot.openAnvil(b)

    const sword = bot.inventory.slots[37]
    const book = anvil.findInventoryItem(bot.registry.itemsByName.enchanted_book.id)

    await anvil.combine(sword, book, 'lol')
    // test result
    assert.strictEqual(bot.experience.level, 995)
    assert.strictEqual(anvil.slots[3].repairCost, 1)
    assert.deepStrictEqual(anvil.slots[3].enchants, [{ name: 'sharpness', lvl: 5 }, { name: 'unbreaking', lvl: 3 }])
    assert.strictEqual(anvil.slots[3].customName, renameName('lol'))
    await anvil.close()
    await bot.test.wait(1000)
    await assertServerCopy(bot, 9) // Bedrock extra
  }))

  it('anvil: repair with materials, a renamed stack, upgrading an enchantment (Bedrock extra)', () => runTest(ctx.bot, async (b, renameCost, renameName, Item, bot, makeBook, makeItem, setEnchantedItem) => {
    const id = (name) => bot.registry.itemsByName[name].id
    await bot.test.becomeCreative()
    // a damaged iron sword (replaceitem sets a tool's Damage through its data value) + 3 iron ingots
    const damaged = new Item(id('iron_sword'), 1)
    damaged.durabilityUsed = 200
    await bot.test.setInventorySlot(36, damaged)
    await bot.test.setInventorySlot(37, new Item(id('iron_ingot'), 3))
    await bot.test.setInventorySlot(38, new Item(id('stick'), 16))
    await bot.test.becomeSurvival()

    let anvil = await bot.openAnvil(b)
    // Bedrock: 1 level per ingot (each restores 25 % = 62 of 250), the prior work penalty becomes 1
    await anvil.combine(anvil.findInventoryItem(id('iron_sword')), anvil.findInventoryItem(id('iron_ingot')))
    assert.strictEqual(bot.experience.level, 996)
    const repaired = anvil.slots[3]
    assert.strictEqual(repaired.name, 'iron_sword')
    assert.strictEqual(repaired.durabilityUsed, 200 - 3 * 62)
    assert.strictEqual(repaired.repairCost, 1)
    assert.strictEqual(anvil.count(id('iron_ingot')), 0)
    // a stack is renamed as a whole for one level (+ no prior work penalty on sticks)
    await anvil.rename(anvil.findInventoryItem(id('stick')), 'wands')
    assert.strictEqual(bot.experience.level, 995)
    assert.strictEqual(anvil.slots[4].count, 16)
    assert.strictEqual(anvil.slots[4].customName, 'wands')
    // "Not anvil-able": nothing changes in either direction (the window is closed, like upstream)
    await assert.rejects(anvil.combine(anvil.slots[3], anvil.slots[4]), /Not anvil-able/)
    await bot.test.wait(500)
    await assertServerCopy(bot, 9)
    await assertServerCopy(bot, 10)

    // Bedrock prices an upgrade by the levels it adds: Sharpness IV + IV → V costs 1 (Java: 5) + the penalties
    await bot.test.becomeCreative()
    await bot.test.clearInventory()
    await setEnchantedItem(36, { type: id('diamond_sword'), enchants: [{ name: 'sharpness', lvl: 4 }] })
    await bot.test.setInventorySlot(37, makeBook([{ name: 'sharpness', lvl: 4 }]))
    await bot.test.becomeSurvival()
    await bot.test.setExperienceLevel(30)
    anvil = await bot.openAnvil(b)
    await anvil.combine(bot.inventory.slots[36], anvil.findInventoryItem(id('enchanted_book')))
    assert.strictEqual(bot.experience.level, 29)
    assert.deepStrictEqual(anvil.slots[3].enchants, [{ name: 'sharpness', lvl: 5 }])
    await anvil.close()
    await bot.test.wait(500)
    await assertServerCopy(bot, 9)
  }))
})
