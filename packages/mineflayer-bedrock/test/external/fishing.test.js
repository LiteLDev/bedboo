// owner: U14 (survival interactions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/fishing.js against BDS 1.26.51.1 (random: the gate is ≥ 4/5 runs).
 *
 * Verbatim flow: water under the bot (`/fill ~-10 ~-1 ~-10 ~10 ~-1 ~10 water`), rain, a Lure rod, lookAt(own
 * position), bot.fish(), wait for the catch's playerCollect, clear weather. Adapted (docs/differences/U14.md#fishing):
 * - the rod: Bedrock `/give` cannot carry enchantments and `/enchant` caps Lure at III, so the rod comes from
 *   `/give @s fishing_rod` + `/enchant @s lure 3` (upstream computes Lure V from the 600-tick bite window, measured
 *   identical on BDS). Measured bite waits on BDS (cast → fish_hook_hook): Lure 0 clear 6.3–32.3 s (mean 20.7, n=10),
 *   Lure 0 rain 6.0–20.9 s (12.1, n=8), Lure III clear 2.5–12.7 s (5.9, n=8), Lure III rain 1.9–12.2 s (5.7, n=10).
 * - the fish promise is awaited too (upstream lets it float).
 * Bedrock extras: the rejections ('Fishing cancelled' when the bobber disappears, a second fish() call) and the
 * bobber's owner.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('fishing', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    const { bot } = ctx
    // reel a bobber still out in
    if (Object.values(bot.entities).some((e) => e.name === 'fishing_hook')) bot.activateItem()
    await bot.test.botCommand('/weather clear')
  })

  /**
   * A fishing rod with the given Lure. BDS reports an /enchant to the client (an inventory_transaction) only in
   * survival, so the bot enchants in survival and goes back to creative.
   */
  async function lureRod (bot, lure) {
    await bot.test.clearInventory()
    await bot.test.awaitItemReceived('/give @s fishing_rod 1')
    await bot.test.becomeSurvival()
    const enchanted = onceWithCleanup(bot.inventory, 'updateSlot:36', { timeout: 10000, checkCondition: (oldItem, newItem) => newItem?.enchants?.length > 0 })
    enchanted.catch(() => {})
    const out = await bot.test.botCommand(`/enchant @s lure ${lure}`)
    if (!out.success_count) throw new Error(`enchant: ${JSON.stringify(out.output)}`)
    await enchanted
    await bot.test.becomeCreative()
    const rod = bot.inventory.slots[36]
    assert.strictEqual(rod?.name, 'fishing_rod')
    assert.deepStrictEqual(rod.enchants, [{ name: 'lure', lvl: lure }])
  }

  it('fishing', async () => {
    const { bot } = ctx

    await bot.test.sayEverywhere('/fill ~-10 ~-1 ~-10 ~10 ~-1 ~10 water')
    await bot.test.sayEverywhere('/weather rain') // rain shortens the vanilla bite wait
    // Upstream: Lure (fishingBiteDelayMaxTicks - 100) / 100 = V from the 100..600 tick wait. Bedrock's /enchant
    // refuses levels above the maximum (Lure III) and /give cannot carry enchantments, so III it is.
    const lure = Math.min((bot.supportFeature('fishingBiteDelayMaxTicks') - 100) / 100, 3)
    await lureRod(bot, lure)
    await bot.lookAt(bot.entity.position) // dont force the position
    const fishing = bot.fish()
    fishing.catch(() => {})

    const started = Date.now()
    await new Promise((resolve) => {
      function onPlayerCollect (collector, collected) {
        if (collected.name.toLowerCase() === 'item' || collected.type === 'object') {
          bot.test.sayEverywhere('I caught: ' + collected.displayName)
          bot.removeListener('playerCollect', onPlayerCollect)
          resolve()
        }
      }
      bot.on('playerCollect', onPlayerCollect)
    })
    await fishing // resolved on the bite (the bot reeled in)
    console.log(`      caught after ${((Date.now() - started) / 1000).toFixed(1)} s`)

    bot.test.sayEverywhere('/weather clear')
  })

  it("the bobber disappears → 'Fishing cancelled'; fish() again → the first call rejects (Bedrock extra)", async () => {
    const { bot } = ctx
    await bot.test.sayEverywhere('/fill ~-10 ~-1 ~-10 ~10 ~-1 ~10 water')
    await bot.test.give('fishing_rod', 1) // no Lure, clear weather: no bite within the first 5 s
    await bot.lookAt(bot.entity.position)

    // the bobber: add_entity fishing_hook owned by the bot
    let spawned = bot.test.botEvent('entitySpawn', (e) => e.name === 'fishing_hook')
    const first = bot.fish()
    first.catch(() => {})
    const [hook] = await spawned.promise
    assert.strictEqual(BigInt(hook.metadata.owner_eid), BigInt(bot._bedrock.ids.selfUniqueId()))
    await bot.test.killEntity(hook)
    await assert.rejects(first, /^Error: Fishing cancelled$/)

    // a second call while fishing: the first rejects; reeling the first bobber in cancels the second (upstream)
    spawned = bot.test.botEvent('entitySpawn', (e) => e.name === 'fishing_hook')
    const second = bot.fish()
    second.catch(() => {})
    await spawned.promise
    await bot.test.wait(500)
    const third = bot.fish()
    third.catch(() => {})
    await assert.rejects(second, /Fishing cancelled due to calling bot\.fish\(\) again/)
    await assert.rejects(third, /^Error: Fishing cancelled$/)
  })
})
