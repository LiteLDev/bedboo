// owner: U16 (wave 5, U16a parity hardening)
'use strict'
/**
 * Live regression tests for the wave-4 review findings (BDS 1.26.51.1, Bedrock extras with no upstream counterpart;
 * the unit-level ones are in test/unit/hardening.test.js, docs/differences/U16a.md):
 * - #1 getting off a minecart on rails / a boat on land leaves the rider on the block, not inside it (BDS agrees);
 * - #2 the rider's seat is kept across rides (BDS sends rider_seat_position only when it changes);
 * - #3 bot.dig(air) resolves like upstream;
 * - #4 concurrent placements both place (the second click carries the server's new held-item stack id);
 * - #5 a placement against a block the server just changed (farmland → dirt) is retried with the fresh state;
 * - #7 mushroom stew from a brown and a red mushroom;
 * - #8 an enchanting option without enchantments leaves the item as the server has it;
 * - #9 a trader killed while its window is open: windowClose, and the items left in the trade slots come back;
 * - #10 a burning furnace (lit_furnace) opens with openFurnace and is found with bot.bedrock.blockVariants;
 * - #12 a book with more than 50 pages is refused at once.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')
const { queryTargetPosition } = require('./common/helpers/base')

const GROUND = -60
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

describe('hardening (U16a): wave-4 review fixes on BDS', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(async () => {
    const { bot } = env
    if (bot.vehicle) {
      const off = bot.test.botEvent('dismount')
      bot.dismount()
      await off.promise
    }
    if (bot.currentWindow) await bot.closeWindow(bot.currentWindow).catch(() => {})
    await bot.test.becomeCreative()
    await bot.test.resetState()
  })
  after(async () => {
    if (env.bot) await env.bot.test.killAllEntities().catch(() => {})
  })

  async function mount (bot, vehicle) {
    const mounted = bot.test.botEvent('mount')
    bot.mount(vehicle)
    await mounted.promise
    assert.strictEqual(bot.vehicle, vehicle)
  }

  async function dismount (bot, vehicle) {
    const off = bot.test.botEvent('dismount')
    bot.dismount()
    const [from] = await off.promise
    assert.strictEqual(from, vehicle)
  }

  /** the bot can walk away (not stuck in a block): forward for 1 s */
  async function walks (bot) {
    const start = bot.entity.position.clone()
    bot.setControlState('forward', true)
    await sleep(1000)
    bot.setControlState('forward', false)
    return bot.entity.position.distanceTo(start)
  }

  async function assertOnTheGround (bot, server, what) {
    const feet = bot.entity.position
    assert.ok(Math.abs(feet.y - GROUND) < 0.01, `${what}: feet at ${feet} (ground ${GROUND})`)
    const inside = bot.blockAt(feet.floored())
    assert.ok(inside && inside.boundingBox !== 'block', `${what}: inside ${inside?.name}`)
    const serverFeet = await queryTargetPosition(server, bot.username)
    assert.ok(serverFeet && serverFeet.distanceTo(feet) < 0.3, `${what}: the server has the rider at ${serverFeet}, the bot ${feet}`)
  }

  describe('#1 / #2 riding', () => {
    it('getting off a minecart on rails: on top of the rail block (BDS agrees), and it can walk', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      await bot.test.setBlock({ x: 2, y: GROUND, z: 0, blockName: 'rail' })
      const cart = await bot.test.summon('minecart', new Vec3(2, GROUND, 0))
      try {
        await mount(bot, cart)
        await sleep(500)
        assert.ok(bot.entity.position.y < GROUND, `the seat is inside the rail block: ${bot.entity.position}`)
        await dismount(bot, cart)
        await sleep(1000)
        await assertOnTheGround(bot, server, 'minecart')
        const walked = await walks(bot)
        assert.ok(walked > 2, `walked ${walked.toFixed(2)} blocks in 1 s`)
      } finally {
        await bot.test.killEntity(cart).catch(() => {})
      }
    })

    it('getting off a boat on land: on the grass, not in it', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      const boat = await bot.test.summon('boat', new Vec3(2, GROUND, 0))
      try {
        await mount(bot, boat)
        await sleep(500)
        assert.ok(bot.entity.position.distanceTo(boat.position) < 1, `rider ${bot.entity.position}, boat ${boat.position}`)
        await dismount(bot, boat)
        await sleep(1000)
        await assertOnTheGround(bot, server, 'boat')
        const walked = await walks(bot)
        assert.ok(walked > 2, `walked ${walked.toFixed(2)} blocks in 1 s`)
      } finally {
        await bot.test.killEntity(boat).catch(() => {})
      }
    })

    it('two rides in a row (boat → minecart → boat): the rider follows its vehicle every time', async () => {
      const { bot, server } = env
      const fill = async (block) => {
        const out = await server.commandOutput(`fill -3 ${GROUND - 1} -4 30 ${GROUND - 1} 4 ${block}`)
        assert.ok(out.some((l) => /blocks filled/.test(l)), out.join(' | '))
      }
      await server.commandOutput(`fill -3 ${GROUND} -4 30 ${GROUND + 3} 4 air`)
      await fill('water')
      try {
        for (const [round, type] of [[1, 'boat'], [2, 'minecart'], [3, 'boat']]) {
          if (type === 'minecart') {
            // a minecart on a rail beside the pool: mount and get off (the same seat as a boat: BDS sends nothing new)
            await bot.test.teleport(new Vec3(-5, GROUND, 0))
            await bot.test.setBlock({ x: -6, y: GROUND, z: 0, blockName: 'rail' })
            const cart = await bot.test.summon('minecart', new Vec3(-6, GROUND, 0))
            await mount(bot, cart)
            await sleep(500)
            assert.ok(bot.entity.position.distanceTo(cart.position) < 1, `round ${round}: rider ${bot.entity.position}, cart ${cart.position}`)
            await dismount(bot, cart)
            await bot.test.killEntity(cart)
            continue
          }
          await bot.test.teleport(new Vec3(0, GROUND, 0))
          const boat = await bot.test.summon('boat', new Vec3(2, GROUND - 1, 0))
          await mount(bot, boat)
          await sleep(500)
          const mountedAt = bot.entity.position.clone()
          bot.moveVehicle(0, 1)
          await sleep(2500)
          bot.moveVehicle(0, 0)
          await sleep(500)
          const travelled = boat.position.distanceTo(new Vec3(2.5, GROUND - 1, 0.5))
          assert.ok(travelled > 3, `round ${round}: the boat travelled ${travelled.toFixed(2)} blocks`)
          assert.ok(bot.entity.position.distanceTo(boat.position) < 1, `round ${round}: rider ${bot.entity.position}, boat ${boat.position}`)
          assert.ok(bot.entity.position.distanceTo(mountedAt) > 2, `round ${round}: the rider stayed where it mounted (${bot.entity.position})`)
          await dismount(bot, boat)
          await bot.test.killEntity(boat)
        }
      } finally {
        await fill('grass_block')
        await bot.test.setBlock({ x: -6, y: GROUND, z: 0, blockName: 'air' })
      }
    })
  })

  describe('#3 / #4 / #5 digging and placing', () => {
    it('bot.dig(air) resolves (upstream: digTime 0, diggingCompleted)', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      const air = bot.blockAt(bot.entity.position.offset(2, 0, 0).floored())
      assert.strictEqual(air.name, 'air')
      assert.strictEqual(bot.digTime(air), 0)
      const completed = once(bot, 'diggingCompleted')
      await bot.dig(air)
      const [block] = await completed
      assert.strictEqual(block.name, 'air')
    })

    it('two placements at once (Promise.all): both place in survival', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 20)
      const refs = [new Vec3(2, GROUND - 1, 0), new Vec3(-2, GROUND - 1, 0), new Vec3(0, GROUND - 1, 2)]
      await Promise.all(refs.slice(0, 2).map((p) => bot.placeBlock(bot.blockAt(p), new Vec3(0, 1, 0))))
      // fire-and-forget clicks without a look, like the review's repro
      await Promise.all([
        bot._placeBlockWithOptions(bot.blockAt(refs[2]), new Vec3(0, 1, 0), { forceLook: 'ignore' }),
        bot._placeBlockWithOptions(bot.blockAt(new Vec3(0, GROUND - 1, -2)), new Vec3(0, 1, 0), { forceLook: 'ignore' })
      ])
      for (const p of [...refs, new Vec3(0, GROUND - 1, -2)]) assert.strictEqual(bot.blockAt(p.offset(0, 1, 0)).name, 'dirt', `at ${p.offset(0, 1, 0)}`)
      assert.strictEqual(bot.inventory.count(bot.registry.itemsByName.dirt.id), 16)
    })

    it('placing against farmland right after it turned into dirt server side (stale block state) still places', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('dirt', 10)
      const ref = new Vec3(2, GROUND, 0)
      await bot.test.setBlock({ ...ref, blockName: 'farmland' })
      const farmland = bot.blockAt(ref)
      assert.strictEqual(farmland.name, 'farmland')
      await bot.placeBlock(farmland, new Vec3(0, 1, 0)) // BDS turns the farmland into dirt a tick later
      await bot.placeBlock(farmland, new Vec3(1, 0, 0)) // the click still describes farmland
      assert.strictEqual(bot.blockAt(ref.offset(1, 0, 0)).name, 'dirt')
      assert.strictEqual(bot.blockAt(ref.offset(0, 1, 0)).name, 'dirt')
    })
  })

  describe('#7 / #8 / #10 / #12 crafting, stations, books', () => {
    it('mushroom stew from one brown and one red mushroom', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('brown_mushroom', 1)
      await bot.test.give('red_mushroom', 1)
      await bot.test.give('bowl', 1)
      const stew = bot.registry.itemsByName.mushroom_stew.id
      const [recipe] = bot.recipesFor(stew, null, 1, null)
      assert.ok(recipe, 'a recipe with the inventory\'s mushrooms')
      await bot.craft(recipe, 1, null)
      assert.strictEqual(bot.inventory.count(stew), 1)
      await bot.test.resyncInventory()
      assert.strictEqual(bot.inventory.count(stew), 1, 'the server\'s copy')
    })

    it('an enchanting option without enchantments (carrot on a stick, no bookshelves) leaves the item as the server has it', async function () {
      const { bot } = env
      const leveled = once(bot, 'experience')
      bot.chat(`/xp 30L ${bot.username}`)
      await leveled
      await bot.test.becomeSurvival()
      await bot.test.give('lapis_lazuli', 3)
      await bot.test.give('carrot_on_a_stick', 1)
      const pos = bot.entity.position.offset(2, 0, 0).floored()
      await bot.test.setBlock({ ...pos, blockName: 'enchanting_table' })
      const table = await bot.openEnchantmentTable(bot.blockAt(pos))
      try {
        await table.putLapis(table.findInventoryItem(bot.registry.itemsByName.lapis_lazuli.id))
        const ready = once(table, 'ready')
        await table.putTargetItem(table.findInventoryItem(bot.registry.itemsByName.carrot_on_a_stick.id))
        await Promise.race([ready, sleep(5000)])
        const choice = table.enchantments.findIndex((e) => e.level > 0 && e.expected.enchant === -1)
        if (choice < 0) {
          console.log(`      no option without enchantments offered: ${JSON.stringify(table.enchantments)}`)
          this.skip() // the offers are the server's (seeded); docs/differences/U16a.md#enchanting-empty-options
        }
        const item = await table.enchant(choice)
        assert.strictEqual(item.name, 'carrot_on_a_stick')
        assert.deepStrictEqual(item.enchants, [])
        await table.takeTargetItem()
      } finally {
        await table.close().catch(() => {})
      }
      const describe = () => bot.inventory.items().filter((i) => i.name === 'carrot_on_a_stick').map((i) => JSON.stringify(i.nbt))
      const predicted = describe()
      await bot.test.resyncInventory()
      assert.deepStrictEqual(describe(), predicted, 'the server\'s copy equals the prediction')
    })

    it('a burning furnace (lit_furnace) opens with openFurnace and is found with bot.bedrock.blockVariants', async () => {
      const { bot } = env
      const pos = bot.entity.position.offset(2, 0, 0).floored()
      await bot.test.setBlock({ ...pos, blockName: 'lit_furnace' })
      assert.strictEqual(bot.blockAt(pos).name, 'lit_furnace')
      assert.strictEqual(bot.findBlock({ matching: bot.registry.blocksByName.furnace.id, maxDistance: 8 }), null, 'Java-style: missed (documented)')
      const found = bot.findBlock({ matching: bot.bedrock.blockVariants('furnace'), maxDistance: 8 })
      assert.ok(found && found.position.equals(pos))
      const furnace = await bot.openFurnace(found)
      assert.strictEqual(furnace.type, 'minecraft:furnace')
      assert.strictEqual(furnace.totalProgress, 200)
      await furnace.close()
    })

    it('a book with more than 50 pages is refused at once; the book stays where it was', async () => {
      const { bot } = env
      await bot.test.becomeSurvival()
      await bot.test.give('writable_book', 1)
      const slot = bot.inventory.findInventoryItem(bot.registry.itemsByName.writable_book.id).slot
      const pages = Array.from({ length: 51 }, (_, i) => `page ${i}`)
      const started = Date.now()
      await assert.rejects(bot.writeBook(slot, pages), /at most 50 pages/)
      assert.ok(Date.now() - started < 1000)
      assert.strictEqual(bot.inventory.slots[slot]?.name, 'writable_book')
      // 50 pages are fine
      await bot.writeBook(slot, pages.slice(0, 50))
    })
  })

  describe('a double-tapped forward while walking (U15 open item)', () => {
    it('BDS sprints after forward is pressed again within 6 ticks; the bot predicts it: no corrections, same position', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      await bot.look(Math.PI, 0, true)
      let corrections = 0
      const onCorrection = (p) => { if (p.prediction_type !== 'vehicle') corrections++ }
      bot._client.on('correct_player_move_prediction', onCorrection)
      let serverSprint = false
      const onUpdate = (e) => { if (e === bot.entity && e.metadata?.flags?.sprinting) serverSprint = true }
      bot.on('entityUpdate', onUpdate)
      try {
        const start = bot.entity.position.clone()
        // a short step, then forward again (mineflayer-pathfinder's short moves): the server sprints until release
        bot.setControlState('forward', true)
        await bot.waitForTicks(3)
        bot.setControlState('forward', false)
        await bot.waitForTicks(1)
        bot.setControlState('forward', true)
        await bot.waitForTicks(30)
        bot.setControlState('forward', false)
        await sleep(800)
        const travelled = bot.entity.position.distanceTo(start)
        assert.ok(serverSprint, 'the server reported the player sprinting')
        assert.ok(travelled > 30 * 0.2158 * 1.2, `travelled ${travelled.toFixed(2)} blocks: sprint speed`)
        assert.strictEqual(corrections, 0, 'no corrections')
        const serverFeet = await queryTargetPosition(server, bot.username)
        assert.ok(serverFeet.distanceTo(bot.entity.position) < 0.1, `server ${serverFeet}, bot ${bot.entity.position}`)
      } finally {
        bot.clearControlStates()
        bot._client.removeListener('correct_player_move_prediction', onCorrection)
        bot.removeListener('entityUpdate', onUpdate)
      }
    })
  })

  describe('#9 a trader that dies while trading', () => {
    it('windowClose; the emeralds left in the trade slot come back with the next trade window', async () => {
      const { bot, server } = env
      await bot.test.becomeSurvival()
      await bot.test.give('emerald', 10)
      const emerald = bot.registry.itemsByName.emerald.id
      const first = await bot.test.summon('wandering_trader', new Vec3(2, GROUND, 0))
      await bot.test.keepStill(first)
      const villager = await bot.openVillager(first)
      await bot.moveSlotItem(villager.findInventoryItem(emerald).slot, 0)
      assert.strictEqual(villager.slots[0]?.count, 10)
      const closed = onceWithCleanup(bot, 'windowClose', { timeout: 5000 })
      await server.commandOutput('kill @e[type=wandering_trader]')
      const [window] = await closed
      assert.strictEqual(window, villager)
      assert.strictEqual(bot.currentWindow, null)
      assert.strictEqual(bot.inventory.count(emerald), 0, 'still in the server\'s trade slot')

      const second = await bot.test.summon('wandering_trader', new Vec3(-2, GROUND, 0))
      await bot.test.keepStill(second)
      const next = await bot.openVillager(second)
      assert.strictEqual(next.slots[0], null, 'returned when the next trade window opened')
      assert.strictEqual(bot.inventory.count(emerald), 10)
      await next.close()
      await bot.test.resyncInventory()
      assert.strictEqual(bot.inventory.count(emerald), 10, 'the server\'s copy')
    })
  })
})
