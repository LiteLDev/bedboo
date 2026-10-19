// owner: U11 (placing; the dig half is U10's bot.dig) → U16
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/digAndBuild.js, VERBATIM: fly up 2 (console tp), place a dirt block
 * 2 below with bot.test.placeBlock (the real bot.placeBlock), stop flying, fall onto it, then dig it bare-handed in
 * survival and collect the drop.
 * The place half (everything up to and including the fall onto the placed block) also runs as its own test, with
 * stricter checks (U11); the verbatim test runs since U10's bot.dig landed (U16a).
 */
const { Vec3 } = require('vec3')
const assert = require('assert')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  const Item = require('prismarine-item')(bot.registry)

  await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 1, 0))
  await bot.test.fly(new Vec3(0, 2, 0))
  await bot.test.placeBlock(36, bot.entity.position.plus(new Vec3(0, -2, 0)))
  await bot.test.clearInventory()
  await bot.creative.stopFlying()
  await waitForFall()
  await bot.test.becomeSurvival()
  // we are bare handed
  await bot.dig(bot.blockAt(bot.entity.position.plus(new Vec3(0, -1, 0))))
  // make sure we collected das dirt
  await bot.test.wait(1000)
  assert(Item.equal(bot.inventory.slots[36], new Item(bot.registry.itemsByName.dirt.id, 1, 0)))
  bot.test.sayEverywhere('dirt collect test: pass')

  async function waitForFall () {
    return new Promise((resolve, reject) => {
      assert(!bot.entity.onGround, 'waitForFall called when we were already on the ground')
      const startingPosition = bot.entity.position.clone()
      bot.on('move', function onMove () {
        if (bot.entity.onGround) {
          const distance = startingPosition.distanceTo(bot.entity.position)
          assert(distance > 0.2, `waitForFall didn't fall very far: ${distance}`)
          bot.removeListener('move', onMove)
          resolve()
        }
      })
    })
  }
}

describe('digAndBuild', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(() => ctx.bot.test.becomeCreative())

  it('digAndBuild', async function () {
    await upstream()(ctx.bot)
  })

  it('digAndBuild: the place half — place below while flying, stop flying, land on the placed block', async () => {
    const { bot } = ctx
    const Item = require('prismarine-item')(bot.registry)
    const g = bot.test.groundY

    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.dirt.id, 1, 0))
    await bot.test.fly(new Vec3(0, 2, 0))
    const placed = new Promise((resolve) => bot.once('blockPlaced', (oldBlock, newBlock) => resolve(newBlock)))
    await bot.test.placeBlock(36, bot.entity.position.plus(new Vec3(0, -2, 0)))
    assert.strictEqual((await placed).name, 'dirt')
    assert.strictEqual(bot.blockAt(new Vec3(0, g, 0)).name, 'dirt')
    await bot.test.clearInventory()
    await bot.creative.stopFlying()
    // upstream's waitForFall
    await new Promise((resolve, reject) => {
      assert(!bot.entity.onGround, 'waitForFall called when we were already on the ground')
      const startingPosition = bot.entity.position.clone()
      bot.on('move', function onMove () {
        if (bot.entity.onGround) {
          const distance = startingPosition.distanceTo(bot.entity.position)
          assert(distance > 0.2, `waitForFall didn't fall very far: ${distance}`)
          bot.removeListener('move', onMove)
          resolve()
        }
      })
    })
    assert.ok(Math.abs(bot.entity.position.y - (g + 1)) < 0.01, `standing on the placed dirt: ${bot.entity.position}`)
    assert.strictEqual(bot.blockAt(bot.entity.position.plus(new Vec3(0, -1, 0))).name, 'dirt')
  })
})
