// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/bossBar.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 *
 * Adapted (docs/differences/U6.md#boss-bars): Bedrock has no /bossbar command — boss bars belong to boss entities.
 *   create: `/summon wither "Test Boss Bar"` 20 blocks away → bossBarCreated with that title;
 *   update: the bar fills while the wither spawns (BDS re-sends show_bar every second) → bossBarUpdated with a higher
 *           health; colour/style cannot be set by command: the wither's bar is rebecca_purple without notches;
 *   delete: `/kill @e[type=wither]` → after the death animation the entity is removed → bossBarDeleted.
 * The server runs on `easy` (a wither despawns on peaceful); the bot stays in creative, so the wither ignores it.
 */
const assert = require('assert')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('bossBar', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative', difficulty: 'easy' } })
  beforeEach(() => env.bot.test.resetState())

  it('bossBar', async () => {
    const { bot } = env
    bot.test.sayEverywhere('### Starting bossBar')
    console.log('[bossBar test] Starting boss bar tests')
    const pos = bot.entity.position.floored()

    // Test boss bar creation
    const createBossBar = async () => {
      const title = 'Test Boss Bar'
      const created = once(bot, 'bossBarCreated', 20000)
      bot.test.sayEverywhere(`/summon wither "${title}" ${pos.x} ${pos.y} ${pos.z + 20}`)
      // Wait for the boss bar to be created
      const [bossBar] = await created
      assert.strictEqual(bossBar.title.toString(), title)
      assert.strictEqual(bot.bossBars.length, 1)
      return bossBar
    }

    // Test boss bar update
    const updateBossBar = async (created) => {
      const start = created.health
      // Wait for the boss bar to have the expected state
      const [bossBar] = await onceWithCleanup(bot, 'bossBarUpdated', {
        timeout: 10000,
        checkCondition: (bossBar) => bossBar.health > start
      })
      assert.strictEqual(bossBar, created)
      assert.ok(bossBar.health > start && bossBar.health <= 1, `health ${bossBar.health}`)
      assert.strictEqual(bossBar.color, 'rebecca_purple')
      assert.strictEqual(bossBar.dividers, 0)
      assert.match(bossBar.entityUUID, /^-?\d+$/)
    }

    // Test boss bar deletion
    const deleteBossBar = async () => {
      const deleted = once(bot, 'bossBarDeleted', 30000)
      bot.test.sayEverywhere('/kill @e[type=wither]')
      await deleted
      assert.strictEqual(bot.bossBars.length, 0)
    }

    try {
      const bossBar = await createBossBar()
      await updateBossBar(bossBar)
      await deleteBossBar()
      console.log('[bossBar test] All tests passed!')
    } catch (err) {
      console.error('[bossBar test] Test failed:', err)
      throw err
    }
  })

  it('an unnamed boss shows its translated name; the bar goes when the boss leaves the view (Bedrock extra)', async () => {
    const { bot } = env
    const pos = bot.entity.position.floored()
    const created = once(bot, 'bossBarCreated', 20000)
    bot.test.sayEverywhere(`/summon wither ${pos.x} ${pos.y} ${pos.z - 20}`)
    const [bossBar] = await created
    assert.strictEqual(bossBar.title.toString(), 'Wither')
    assert.strictEqual(bossBar.title.translate, 'entity.wither.name')
    const deleted = once(bot, 'bossBarDeleted', 20000)
    bot.test.sayEverywhere(`/tp @e[type=wither] ${pos.x} ${pos.y} ${pos.z + 600}`)
    assert.strictEqual((await deleted)[0], bossBar)
    assert.strictEqual(bot.bossBars.length, 0)
  })
})
