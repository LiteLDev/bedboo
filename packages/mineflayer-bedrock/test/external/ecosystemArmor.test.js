// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * mineflayer-armor-manager 2.0.1 (unpatched) on BDS 1.26.51.1 (Bedrock extra, docs/ecosystem.md): armor and a shield
 * dropped on the ground are picked up (`playerCollect` with the collected item from `getDroppedItem()`) and
 * auto-equipped into the Java-layout armor slots 5–8 / the off-hand 45; a better piece replaces a worse one;
 * `bot.armorManager.equipAll()` equips what is in the inventory.
 */
const assert = require('assert')
const { useBot } = require('./common')

describe('ecosystemArmor', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })

  before(() => {
    ctx.bot.loadPlugin(require('mineflayer-armor-manager'))
    assert.ok(ctx.bot.armorManager)
  })
  beforeEach(async () => {
    await ctx.bot.test.resetState()
    ctx.bot.setQuickBarSlot(0)
  })
  afterEach(() => ctx.bot.test.becomeCreative())

  const slotName = (slot) => ctx.bot.inventory.slots[slot]?.name ?? null
  const equipped = () => [5, 6, 7, 8, 45].map(slotName)
  async function until (check, what, timeout = 15000) {
    const t0 = Date.now()
    while (!check()) {
      if (Date.now() - t0 > timeout) throw new Error(`${what}: ${JSON.stringify(equipped())}`)
      await ctx.bot.waitForTicks(2)
    }
  }

  /** toss every stack in the inventory a little ahead, then walk over the drops to pick them up again */
  async function dropAndCollect (names) {
    const { bot } = ctx
    const collected = []
    const onCollect = (collector, item) => { if (collector === bot.entity) collected.push(item.getDroppedItem?.()?.name) }
    bot.on('playerCollect', onCollect)
    try {
      await bot.look(0, -0.6, true) // north, a little down: the drops land ~1.5 blocks ahead
      for (const name of names) {
        const item = bot.inventory.items().find(i => i.name === name)
        await bot.tossStack(item)
      }
      // player-thrown items cannot be picked up for 2 s
      await bot.test.wait(2200)
      bot.setControlState('forward', true)
      await bot.waitForTicks(12)
      bot.setControlState('forward', false)
      await until(() => names.every(n => collected.includes(n)), `collected ${JSON.stringify(collected)}`)
    } finally {
      bot.removeListener('playerCollect', onCollect)
      bot.clearControlStates()
    }
    return collected
  }

  it('picked-up armor pieces and a shield are equipped (playerCollect → getDroppedItem → equip)', async () => {
    const { bot } = ctx
    await bot.test.becomeSurvival()
    for (const name of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield']) await bot.test.give(name, 1)
    await until(() => bot.inventory.items().length === 5, 'given')
    await dropAndCollect(['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'])
    await until(() => equipped().every(Boolean), 'all equipped')
    assert.deepStrictEqual(equipped(), ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield'])
    assert.deepStrictEqual(bot.entity.equipment.slice(2, 6).map(i => i?.name ?? null), ['iron_boots', 'iron_leggings', 'iron_chestplate', 'iron_helmet'])
    assert.strictEqual(bot.inventory.items().length, 0)
  })

  it('a better piece replaces a worse one; equipAll() equips the inventory', async () => {
    const { bot } = ctx
    await bot.test.becomeSurvival()
    await bot.test.give('leather_helmet', 1)
    await bot.test.give('golden_boots', 1)
    await until(() => bot.inventory.items().length === 2, 'given')
    await bot.armorManager.equipAll()
    await until(() => slotName(5) === 'leather_helmet' && slotName(8) === 'golden_boots', 'equipAll')
    await bot.test.give('diamond_helmet', 1)
    await until(() => bot.inventory.items().some(i => i.name === 'diamond_helmet'), 'given')
    await dropAndCollect(['diamond_helmet'])
    await until(() => slotName(5) === 'diamond_helmet', 'diamond helmet equipped')
    assert.ok(bot.inventory.items().some(i => i.name === 'leather_helmet'), 'the leather helmet went back to the inventory')
  })
})
