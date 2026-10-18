// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * A self-built nether portal against BDS 1.26.51.1 (Bedrock extra; the user requirement "a self-built Nether portal"):
 * in survival the bot places a 4×5 obsidian frame with bot.placeBlock (14 blocks from its inventory: the bottom row on
 * the grass, the sides stacked, the top corners on the sides, the top middle against the side of the corner), lights
 * it with flint and steel through bot.placeBlock (blockPlaced: air → portal), sees the 2×3 portal blocks, walks in
 * (forward + jump) and arrives in the nether ('spawn', bot.game.dimension).
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('portalIgnition', function () {
  this.timeout(180000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    const { bot } = ctx
    for (const control of ['forward', 'jump']) bot.setControlState(control, false)
    await bot.test.becomeCreative()
  })

  it('build an obsidian frame with placeBlock, light it with flint and steel, walk in → the nether', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const g = bot.test.groundY
    const Z = 3
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.obsidian.id, 14, 0))
    await bot.test.setInventorySlot(37, new Item(bot.registry.itemsByName.flint_and_steel.id, 1, 0))
    await bot.test.becomeSurvival()
    bot.creative.stopFlying()
    bot.setQuickBarSlot(0)

    const at = (x, y) => bot.blockAt(new Vec3(x, y, Z))
    const up = new Vec3(0, 1, 0)
    const east = new Vec3(1, 0, 0)
    // bottom row (on the grass)
    for (const x of [-1, 0, 1, 2]) await bot.placeBlock(bot.blockAt(new Vec3(x, g - 1, Z)), up)
    // the sides and the top corners, stacked
    for (const x of [-1, 2]) {
      for (let y = g + 1; y <= g + 4; y++) await bot.placeBlock(at(x, y - 1), up)
    }
    // the top middle, against the side of the corner
    await bot.placeBlock(at(-1, g + 4), east)
    await bot.placeBlock(at(0, g + 4), east)
    const frame = []
    for (let x = -1; x <= 2; x++) for (let y = g; y <= g + 4; y++) if (x === -1 || x === 2 || y === g || y === g + 4) frame.push(at(x, y).name)
    assert.deepStrictEqual([...new Set(frame)], ['obsidian'])
    assert.strictEqual(frame.length, 14)
    assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.obsidian.id), 0, 'all 14 obsidian used')

    // light it: flint and steel on the top of a bottom block
    bot.setQuickBarSlot(1)
    const placed = onceWithCleanup(bot, 'blockPlaced', { timeout: 5000 })
    await bot.placeBlock(at(0, g), up)
    const [oldBlock, newBlock] = await placed
    assert.strictEqual(oldBlock.name, 'air')
    assert.strictEqual(newBlock.name, 'portal')
    for (let x = 0; x <= 1; x++) {
      for (let y = g + 1; y <= g + 3; y++) {
        if (at(x, y).name !== 'portal') await onceWithCleanup(bot, `blockUpdate:${new Vec3(x, y, Z)}`, { timeout: 5000, checkCondition: (o, n) => n?.name === 'portal' })
        assert.strictEqual(at(x, y).name, 'portal', `portal block at ${x} ${y}`)
      }
    }

    // walk in
    const spawned = onceWithCleanup(bot, 'spawn', { timeout: 60000, checkCondition: () => bot.game.dimension === 'the_nether' })
    await bot.lookAt(new Vec3(0.5, g + 1.6, Z + 0.5), true)
    bot.setControlState('forward', true)
    bot.setControlState('jump', true)
    const inside = () => bot.entity.position.z > Z + 0.1 && bot.entity.position.y >= g + 1
    for (let i = 0; i < 60 && !inside(); i++) await bot.waitForTicks(1)
    bot.setControlState('forward', false)
    bot.setControlState('jump', false)
    assert.ok(inside(), `walked into the portal: ${bot.entity.position}`)
    await spawned
    assert.strictEqual(bot.game.dimension, 'the_nether')
  })
})
