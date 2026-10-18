// owner: U7 (entities & players)
'use strict'
/**
 * Vehicles against a real BDS 1.26.51.1 (Bedrock extra, U7): bot.mount / bot.dismount on a summoned boat and horse
 * (interact → set_entity_link), bot.vehicle, mount / dismount / entityAttach / entityDetach, the vehicle killed under
 * the bot, dismount() while not mounted. moveVehicle is the physics plugin's (U5) and is tested there.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

const GROUND = -60

describe('vehicles (U7): mount / dismount', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  beforeEach(async () => {
    if (env.bot.vehicle) {
      const off = env.bot.test.botEvent('dismount')
      env.bot.dismount()
      await off.promise
    }
    await env.bot.test.resetState()
  })

  const ev = (event, predicate, timeout) => env.bot.test.botEvent(event, predicate, timeout)

  async function ride (vehicle) {
    const { bot } = env
    const mounted = ev('mount')
    const attached = ev('entityAttach', (e, v) => e === bot.entity && v === vehicle)
    bot.mount(vehicle)
    await mounted.promise
    await attached.promise
    assert.strictEqual(bot.vehicle, vehicle)
    assert.strictEqual(bot.entity.vehicle, vehicle)
    assert.ok(vehicle.passengers.includes(bot.entity))
  }

  async function getOff (vehicle) {
    const { bot } = env
    const dismounted = ev('dismount')
    const detached = ev('entityDetach', (e) => e === bot.entity)
    bot.dismount()
    const [from] = await dismounted.promise
    const [, detachedFrom] = await detached.promise
    assert.strictEqual(from, vehicle)
    assert.strictEqual(detachedFrom, vehicle)
    assert.strictEqual(bot.vehicle, null)
    assert.strictEqual(bot.entity.vehicle, null)
    assert.ok(!vehicle.passengers.includes(bot.entity))
  }

  it('boat: mount → bot.vehicle, dismount → null', async () => {
    const { bot } = env
    const boat = await bot.test.summon('boat', new Vec3(2, GROUND, 0))
    await ride(boat)
    await getOff(boat)
    await bot.test.killEntity(boat)
  })

  it('horse (adult, summoned): mount and dismount', async () => {
    const { bot } = env
    const horse = await bot.test.summon('horse', new Vec3(2, GROUND, 2), { spawnEvent: 'minecraft:ageable_grow_up' })
    await ride(horse)
    // a wild horse may throw the rider (tame_fail) before we get off: both end in a dismount
    if (bot.vehicle) await getOff(horse)
    await bot.test.killEntity(horse)
  })

  it('the vehicle is killed under the bot → dismount(vehicle)', async () => {
    const { bot } = env
    const boat = await bot.test.summon('boat', new Vec3(-2, GROUND, 0))
    await ride(boat)
    const dismounted = ev('dismount')
    await bot.test.killEntity(boat)
    const [from] = await dismounted.promise
    assert.strictEqual(from, boat)
    assert.strictEqual(bot.vehicle, null)
  })

  it("dismount() while not mounted emits 'error' like upstream", async () => {
    const { bot } = env
    const error = ev('error', (err) => /not mounted/.test(err.message))
    bot.dismount()
    await error.promise
  })

  it('moveVehicle steers the boat (physics plugin, U5)', async () => {
    const { bot } = env
    const boat = await bot.test.summon('boat', new Vec3(2, GROUND, -2))
    await ride(boat)
    const start = boat.position.clone()
    const moved = ev('entityMoved', (e) => e === boat && e.position.distanceTo(start) > 0.5, 10000)
    const timer = setInterval(() => bot.moveVehicle(0, 1), 50)
    try { await moved.promise } finally { clearInterval(timer) }
    await getOff(boat)
    await bot.test.killEntity(boat)
  })
})
