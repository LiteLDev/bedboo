// owner: BEDD-6 (real-client e2e + docs)
'use strict'
// Real-client e2e (docs/bedd.md): inventory through BeDD's `stack` op (item_stack_request submitted by the client's own
// ItemStackNetManager): craft planks in the 2×2 grid, deposit them into a chest.
const assert = require('assert')
const {
  gate, session, need, needCommands, run, until, serverItemCount, botItemCount, prepareArena, giveHotbar
} = require('./common')

describe('bedd: inventory via the stack op (real client)', function () {
  let s
  before(async function () {
    gate(this)
    s = await session()
  })

  it('crafts planks from a log', async function () {
    need(this, s, 'craft', ['stack'])
    needCommands(this, s)
    const { bot } = s
    await prepareArena(s)
    await run(s, 'clear @s oak_planks').catch(() => {})
    await giveHotbar(s, 2, 'oak_log', 1)
    const planks = bot.registry.itemsByName.oak_planks
    assert.ok(planks, 'oak_planks in the registry')
    const [recipe] = bot.recipesFor(planks.id, null, 1, null)
    assert.ok(recipe, 'a 2×2 planks recipe')
    await bot.craft(recipe, 1, null)
    await until(() => botItemCount(bot, 'oak_planks') === 4, { what: '4 oak planks (tapped inventory)', timeout: 10000 })
    assert.strictEqual(botItemCount(bot, 'oak_log'), 0)
    if (s.console) assert.strictEqual(await serverItemCount(s, 'oak_planks'), 4, 'BDS: 4 planks')
  })

  it('deposits the planks into a chest', async function () {
    need(this, s, 'deposit', ['stack', 'look', 'button'])
    needCommands(this, s)
    const { bot } = s
    const arena = await prepareArena(s)
    if (botItemCount(bot, 'oak_planks') < 4) {
      await run(s, 'clear @s oak_planks').catch(() => {})
      await giveHotbar(s, 2, 'oak_planks', 4)
    }
    const pos = arena.offset(2, 0, 2)
    await run(s, `setblock ${pos.x} ${pos.y} ${pos.z} air`)
    await run(s, `setblock ${pos.x} ${pos.y} ${pos.z} chest`)
    await until(() => bot.blockAt(pos)?.name === 'chest', { what: 'the chest on the tap' })
    const chest = await bot.openContainer(bot.blockAt(pos))
    try {
      await chest.deposit(bot.registry.itemsByName.oak_planks.id, null, 4)
      const inChest = chest.containerItems().filter((i) => i.name === 'oak_planks').reduce((n, i) => n + i.count, 0)
      assert.strictEqual(inChest, 4, 'the chest window holds 4 planks')
    } finally {
      chest.close()
    }
    await until(() => !bot.currentWindow, { what: 'the chest closed' })
    await until(() => botItemCount(bot, 'oak_planks') === 0, { what: 'no planks left in the inventory', timeout: 5000 })
    if (s.console) assert.strictEqual(await serverItemCount(s, 'oak_planks'), 0, 'BDS: the planks left the player')
  })
})
