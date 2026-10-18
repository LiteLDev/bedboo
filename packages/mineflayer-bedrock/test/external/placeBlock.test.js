// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/placeBlock.js — the four upstream tests VERBATIM (blockPlaced, an
 * entity in the way, an item that is not a block, refusals in a row; bot.test.placeBlock is upstream's helper on the
 * real API, test/external/common/helpers/place.js). BDS answers every click with update_block for the reference block
 * then the destination, also when it refuses (docs/differences/U11.md#placement-protocol), so upstream's attribution
 * and error messages hold.
 * Bedrock extras: survival placement consumes the item, sneak-placing against interactive blocks (chest, crafting
 * table, furnace, door, sign) instead of using them, `half` (slabs) and `delta`, off-hand placement, creative flight,
 * buckets (water / lava out and back in), flint and steel (fire), bone meal.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('placeBlock', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    const { bot } = ctx
    for (const control of ['sneak', 'jump']) bot.setControlState(control, false)
    await bot.test.becomeCreative()
  })

  // ---------------------------------------------------------------- upstream (verbatim)
  const upstream = (() => {
    const tests = []

    function addTest (name, f) {
      tests[name] = f
    }

    // the block the tests place, one block east of the bot's spawn point
    const target = bot => new Vec3(1, bot.test.groundY, 0)

    async function holdDirt (bot) {
      const Item = require('prismarine-item')(bot.registry)
      await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 1, 0))
    }

    async function expectRefusal (bot, placement, item) {
      const start = Date.now()
      await assert.rejects(placement, new RegExp(`^Error: Server refused to place ${item} at \\(\\d+, -?\\d+, \\d+\\): the block is still air$`))
      assert(Date.now() - start < 2000, `refused placement took ${Date.now() - start}ms to surface`)
    }

    addTest('emits blockPlaced with the old and new block', async (bot) => {
      await holdDirt(bot)
      const placed = once(bot, 'blockPlaced')
      await bot.test.placeBlock(36, target(bot))
      const [oldBlock, newBlock] = await placed
      assert.strictEqual(oldBlock.name, 'air')
      assert.strictEqual(newBlock.name, 'dirt')
      assert(newBlock.position.equals(target(bot)))
      await bot.test.setBlock({ ...target(bot), blockName: 'air' })
    })

    addTest('rejects when an entity is in the way, then works once it is gone', async (bot) => {
      await holdDirt(bot)
      const name = bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'ArmorStand' : 'armor_stand'
      const { x, y, z } = target(bot)
      const spawned = once(bot, 'entitySpawn')
      bot.chat(`/summon ${name} ${x + 0.5} ${y} ${z + 0.5}`)
      await spawned

      // only the server knows the block is occupied, so the client sends the
      // placement and the refusal has to come from the server's reply
      await expectRefusal(bot, bot.test.placeBlock(36, target(bot)), 'dirt')
      assert.strictEqual(bot.blockAt(target(bot)).name, 'air')

      const gone = once(bot, 'entityGone')
      bot.chat(`/kill @e[type=${name}]`)
      await gone
      await bot.test.placeBlock(36, target(bot))
      assert.strictEqual(bot.blockAt(target(bot)).name, 'dirt')
      await bot.test.setBlock({ ...target(bot), blockName: 'air' })
    })

    addTest('rejects when the held item cannot be placed', async (bot) => {
      const Item = require('prismarine-item')(bot.registry)
      await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.stick.id, 1, 0))
      await expectRefusal(bot, bot.test.placeBlock(36, target(bot)), 'stick')
      assert.strictEqual(bot.blockAt(target(bot)).name, 'air')
    })

    addTest('rejects each refused placement in a row', async (bot) => {
      await holdDirt(bot)
      // the bot cannot place into its own hitbox; a refusal must leave nothing
      // behind that would mis-attribute the next reply
      for (let i = 0; i < 3; i++) {
        await expectRefusal(bot, bot.test.placeBlock(36, bot.entity.position.floored()), 'dirt')
      }
      await bot.test.placeBlock(36, target(bot))
      assert.strictEqual(bot.blockAt(target(bot)).name, 'dirt')
      await bot.test.setBlock({ ...target(bot), blockName: 'air' })
    })

    return tests
  })()

  for (const name of Object.keys(upstream)) {
    it(name, () => upstream[name](ctx.bot))
  }

  // ---------------------------------------------------------------- Bedrock extras
  const Item = () => require('prismarine-item')(ctx.bot.registry)
  const give = (slot, name, count = 1) => ctx.bot.test.setInventorySlot(slot, new (Item())(ctx.bot.registry.itemsByName[name].id, count, 0))
  async function survival () {
    await ctx.bot.test.becomeSurvival()
    ctx.bot.creative.stopFlying()
  }
  const at = (x, y, z) => ctx.bot.blockAt(new Vec3(x, y, z))

  it('survival: the placed block is taken from the stack (inventory_content), placements in a row', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await give(36, 'cobblestone', 5)
    await survival()
    bot.setQuickBarSlot(0)
    const events = []
    bot.on('blockPlaced', function onPlaced (oldBlock, newBlock) { events.push(`${oldBlock.name}>${newBlock.name}@${newBlock.position}`) })
    for (const x of [1, 2, -1]) await bot.placeBlock(at(x, g - 1, 0), new Vec3(0, 1, 0))
    // on top of a placed block and against the side of one
    await bot.placeBlock(at(1, g, 0), new Vec3(0, 1, 0))
    await bot.placeBlock(at(2, g, 0), new Vec3(0, 0, 1))
    assert.deepStrictEqual(events, ['air>cobblestone@(1, -60, 0)', 'air>cobblestone@(2, -60, 0)', 'air>cobblestone@(-1, -60, 0)',
      'air>cobblestone@(1, -59, 0)', 'air>cobblestone@(2, -60, 1)'])
    assert.strictEqual(bot.heldItem, null, 'the 5 cobblestones were used')
    await assert.rejects(bot.placeBlock(at(3, g - 1, 0), new Vec3(0, 1, 0)), /^Error: must be holding an item to place$/)
  })

  for (const blockName of ['chest', 'crafting_table', 'furnace', 'wooden_door', 'standing_sign', 'barrel']) {
    it(`survival: sneak-places on top of a ${blockName} instead of using it`, async () => {
      const { bot } = ctx
      const g = bot.test.groundY
      await bot.test.setBlock({ x: 2, y: g, z: 0, blockName })
      await give(36, 'dirt', 2)
      await survival()
      bot.setQuickBarSlot(0)
      let opened = null
      const onOpen = (window) => { opened = window }
      bot.on('windowOpen', onOpen)
      const signOpened = []
      const onSign = (block) => signOpened.push(block)
      bot.on('signOpen', onSign)
      const crouched = onceWithCleanup(bot, 'entityCrouch', { timeout: 5000, checkCondition: (e) => e === bot.entity })
      try {
        const top = blockName === 'wooden_door' ? g + 1 : g // a door is two blocks high
        await bot.placeBlock(at(2, top, 0), new Vec3(0, 1, 0))
        await crouched
        assert.strictEqual(at(2, top + 1, 0).name, 'dirt')
        assert.strictEqual(bot.getControlState('sneak'), false, 'the sneak the placement pressed is released')
        await bot.test.wait(300)
        assert.strictEqual(opened, null, `the ${blockName} was not used`)
        assert.deepStrictEqual(signOpened, [])
        if (blockName === 'wooden_door') assert.ok(!at(2, g, 0).getProperties().open_bit, 'the door stays closed')
      } finally {
        bot.removeListener('windowOpen', onOpen)
        bot.removeListener('signOpen', onSign)
        if (bot.currentWindow) await bot.closeWindow(bot.currentWindow)
      }
    })
  }

  it('survival: a sneak held by the caller (pathfinder) is kept; no sneak is pressed against plain blocks', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'chest' })
    await give(36, 'dirt', 2)
    await survival()
    bot.setQuickBarSlot(0)
    bot.setControlState('sneak', true)
    await bot.placeBlock(at(2, g, 0), new Vec3(0, 1, 0))
    assert.strictEqual(bot.getControlState('sneak'), true)
    assert.strictEqual(at(2, g + 1, 0).name, 'dirt')
    bot.setControlState('sneak', false)
    await bot.test.wait(300)
    let pressed = false
    const watch = () => { if (bot.getControlState('sneak')) pressed = true }
    bot.on('physicsTick', watch)
    await bot.placeBlock(at(1, g - 1, 0), new Vec3(0, 1, 0))
    bot.removeListener('physicsTick', watch)
    assert.strictEqual(pressed, false)
  })

  it('creative flight: places against a chest (the raw sneak keys count while flying)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'chest' })
    await give(36, 'dirt', 1)
    assert.ok(bot._bedrock.physics.isFlying(), 'resetState started flying')
    await bot.placeBlock(at(2, g, 0), new Vec3(0, 1, 0))
    assert.strictEqual(at(2, g + 1, 0).name, 'dirt')
    assert.strictEqual(bot.currentWindow, null)
    assert.strictEqual(bot.heldItem?.count, 1, 'creative placement does not use the item')
  })

  it('_placeBlockWithOptions: half (slabs, stairs) and delta select the clicked point', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'stone' })
    await bot.test.setBlock({ x: -2, y: g, z: 0, blockName: 'stone' })
    await give(36, 'oak_slab', 4)
    bot.setQuickBarSlot(0)
    // against the side of a block: the upper or lower half of the face
    await bot._placeBlockWithOptions(at(2, g, 0), new Vec3(-1, 0, 0), { half: 'top' })
    assert.strictEqual(at(1, g, 0).getProperties()['minecraft:vertical_half'], 'top')
    await bot._placeBlockWithOptions(at(-2, g, 0), new Vec3(1, 0, 0), { half: 'bottom' })
    assert.strictEqual(at(-1, g, 0).getProperties()['minecraft:vertical_half'], 'bottom')
    // delta: an explicit click point (upper part of the north face of the stone at 2)
    await bot.test.setBlock({ x: 1, y: g, z: 0, blockName: 'air' })
    await bot._placeBlockWithOptions(at(2, g, 0), new Vec3(0, 0, -1), { delta: new Vec3(0.5, 0.9, 0) })
    assert.strictEqual(at(2, g, -1).getProperties()['minecraft:vertical_half'], 'top')
    // forceLook 'ignore' keeps the current rotation
    const yaw = bot.entity.yaw
    await bot._placeBlockWithOptions(at(-2, g, 0), new Vec3(0, 1, 0), { forceLook: 'ignore' })
    assert.strictEqual(bot.entity.yaw, yaw)
    assert.strictEqual(at(-2, g + 1, 0).name, 'oak_slab')
  })

  it('_placeBlockWithOptions offhand: Bedrock places nothing from the off-hand, the server refuses (inherent difference)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    // /replaceitem can force a block into the off-hand slot; the vanilla client never uses it to place
    await bot.test.setInventorySlot(45, new (Item())(bot.registry.itemsByName.cobblestone.id, 2, 0))
    await give(36, 'dirt', 2)
    bot.setQuickBarSlot(0)
    await assert.rejects(bot._placeBlockWithOptions(at(1, g - 1, 0), new Vec3(0, 1, 0), { offhand: true, swingArm: 'left' }),
      /^Error: Server refused to place dirt at \(1, -60, 0\): the block is still air$/)
    assert.strictEqual(at(1, g, 0).name, 'air')
    assert.strictEqual(bot.inventory.slots[45]?.count, 2)
    // upstream's check before anything is sent
    await bot.test.setInventorySlot(45, null)
    await assert.rejects(bot._placeBlockWithOptions(at(2, g - 1, 0), new Vec3(0, 1, 0), { offhand: true }), /^Error: must be holding an item in the off-hand to place$/)
  })

  it('buckets: water and lava out with placeBlock (blockPlaced), back in with activateBlock on the source', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await give(36, 'water_bucket')
    await give(37, 'lava_bucket')
    await give(38, 'bucket')
    await survival()
    for (const [slot, liquid, x] of [[0, 'water', 2], [1, 'lava', -2]]) {
      bot.setQuickBarSlot(slot)
      const placed = once(bot, 'blockPlaced')
      await bot.placeBlock(at(x, g - 1, 2), new Vec3(0, 1, 0))
      const [oldBlock, newBlock] = await placed
      assert.strictEqual(oldBlock.name, 'air')
      assert.strictEqual(newBlock.name, liquid)
      assert.strictEqual(bot.inventory.slots[36 + slot]?.name, 'bucket', `the ${liquid} bucket is empty`)
    }
    // fill the empty bucket from the water source: click the liquid block (what the vanilla client targets)
    bot.setQuickBarSlot(2)
    const emptied = onceWithCleanup(bot, `blockUpdate:${new Vec3(2, g, 2)}`, { timeout: 5000, checkCondition: (o, n) => n?.name === 'air' })
    await bot.activateBlock(at(2, g, 2))
    await emptied
    if (bot.heldItem?.name !== 'water_bucket') await onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.name === 'water_bucket' })
    assert.strictEqual(bot.heldItem?.name, 'water_bucket')
    // Bedrock extra: activateItem's form of a bucket (BDS ignores click_air): the block along the look
    bot.setQuickBarSlot(1)
    const lavaGone = onceWithCleanup(bot, `blockUpdate:${new Vec3(-2, g, 2)}`, { timeout: 5000, checkCondition: (o, n) => n?.name === 'air' })
    await bot.lookAt(new Vec3(-1.5, g + 0.5, 2.5), true)
    await bot.waitForTicks(1)
    assert.ok(bot._bedrock.placement.useOnLookedAtBlock(bot.heldItem), 'the lava source is in reach')
    await lavaGone
  })

  it('flint and steel: placeBlock lights a fire (blockPlaced) and wears the tool', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await give(36, 'flint_and_steel')
    await survival()
    bot.setQuickBarSlot(0)
    const placed = once(bot, 'blockPlaced')
    await bot.placeBlock(at(1, g - 1, -1), new Vec3(0, 1, 0))
    const [, fire] = await placed
    assert.strictEqual(fire.name, 'fire')
    if (bot.heldItem?.durabilityUsed !== 1) await onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.durabilityUsed === 1 })
    assert.strictEqual(bot.heldItem.durabilityUsed, 1)
    await bot.test.setBlock({ x: 1, y: g, z: -1, blockName: 'air' })
  })

  it('bone meal: activateBlock on a sapling uses one bone meal', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 2, blockName: 'oak_sapling' })
    await give(36, 'bone_meal', 3)
    await survival()
    bot.setQuickBarSlot(0)
    const used = onceWithCleanup(bot, 'heldItemChanged', { timeout: 5000, checkCondition: (item) => item?.count === 2 })
    await bot.activateBlock(at(2, g, 2))
    await used
    assert.strictEqual(bot.heldItem.count, 2)
  })
})
