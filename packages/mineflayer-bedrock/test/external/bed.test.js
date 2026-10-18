// owner: U14 (survival interactions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/bed.js against BDS 1.26.51.1, plus Bedrock extras.
 *
 * Adapted (docs/differences/U14.md#beds):
 * - the bed: Bedrock `/setblock` of a bed always places the whole bed, the given position becoming the head and the
 *   foot going behind it (its `head_piece_bit` state is ignored), so the port places ONE bed with its head at
 *   bedPos2 facing south (`["direction"=0]`): foot at bedPos1, head at bedPos2 = bedPos1 + z, upstream's layout.
 *   Upstream's two setblocks (foot then head) would leave a head at bedPos1 and nothing at bedPos2.
 * - the bed block is `bed` (upstream takes the first item whose name ends in "bed"; on Bedrock that is the
 *   `item.straw_bed` item, not a block).
 * Everything else is verbatim: waitForChunksToLoad, `/time set 18000` + the `time` event, the block checks, sleep(foot)
 * → isSleeping, wake() → 'wake' → !isSleeping.
 */
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('bed', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  afterEach(async () => {
    const { bot } = ctx
    if (bot.isSleeping) {
      const woke = once(bot, 'wake')
      await bot.wake()
      await woke
    }
    await bot.test.becomeCreative()
  })

  /** upstream's bed: foot at bedPos1, head at bedPos2 = bedPos1 + (0, 0, 1), facing south */
  async function placeBed (bot, bedPos1) {
    const bedPos2 = bedPos1.offset(0, 0, 1)
    bot.chat(`/setblock ${bedPos2.toArray().join(' ')} bed ["direction"=0]`)
    return bedPos2
  }

  it('bed', async () => {
    const { bot } = ctx
    // The bed is placed relative to the bot; blockAt cannot see it until the
    // surrounding chunks are loaded.
    await bot.waitForChunksToLoad()
    const midnight = 18000
    const bedItem = bot.registry.itemsByName.bed // Bedrock: the `bed` item / block (see the header)
    const bedPos1 = bot.entity.position.offset(2, 0, 0).floored()
    const bedPos2 = bedPos1.offset(0, 0, 1)

    assert(bedItem)

    // Put the bed (Bedrock: one setblock places both halves, see the header)
    assert.ok(!bot.supportFeature('setBlockUsesMetadataNumber', bot.version))
    await placeBed(bot, bedPos1)
    bot.chat(`/time set ${midnight}`)
    await once(bot, 'time')
    await bot.test.wait(1000)

    console.log(bot.time.timeOfDay, bot.blockAt(bedPos1).name, bot.blockAt(bedPos2).name)
    const blockAtBed1 = bot.blockAt(bedPos1)
    const blockAtBed2 = bot.blockAt(bedPos2)
    assert(bot.time.timeOfDay >= midnight)
    assert(blockAtBed1?.name?.endsWith('bed'), `Expected ${bedPos1} to be bed, got ${JSON.stringify(blockAtBed1)}`)
    assert(blockAtBed2?.name?.endsWith('bed'), `Expected ${bedPos2} to be bed, got ${JSON.stringify(blockAtBed2)}`)

    // Sleep
    assert(!bot.isSleeping)
    const wakePromise = once(bot, 'wake')
    await bot.sleep(bot.blockAt(bedPos1))

    // Wake
    assert(bot.isSleeping)
    await bot.wake()
    await wakePromise
    assert(!bot.isSleeping)
  })

  it('survival: the server keeps the player in the bed, marks it occupied, wakes it after 100 ticks (Bedrock extra)', async () => {
    const { bot } = ctx
    await bot.waitForChunksToLoad()
    await bot.test.becomeSurvival()
    const bedPos1 = bot.entity.position.offset(-2, 0, 0).floored()
    const head = await placeBed(bot, bedPos1)
    bot.chat('/time set 13000')
    await once(bot, 'time')
    await bot.test.wait(500)
    assert.ok(bot.isABed(bot.blockAt(head)))

    const slept = bot.test.botEvent('sleep')
    const occupied = bot.test.botEvent('blockUpdate', (oldBlock, newBlock) => bot.isABed(newBlock) && bot.parseBedMetadata(newBlock).occupied)
    await bot.sleep(bot.blockAt(bedPos1))
    await slept.promise
    await occupied.promise
    assert.strictEqual(bot.isSleeping, true)
    assert.strictEqual(bot.entity.sleeping, true)
    // BDS: player_flags bit 1 + the bed position (the head) in the metadata; the player lies in the bed
    assert.strictEqual(Number(bot.entity.metadata.player_flags) & 2, 2)
    assert.deepStrictEqual(bot.entity.metadata.player_bed_position, { x: head.x, y: head.y, z: head.z })
    const pos = bot.entity.position
    assert.ok(Math.hypot(pos.x - head.x - 0.5, pos.z - head.z - 0.5) < 0.01, `in the bed: ${pos}`)
    await assert.rejects(bot.sleep(bot.blockAt(bedPos1)), /already sleeping/)

    // nobody wakes the bot: the server ends the sleep after 100 ticks (doDaylightCycle is off, so the time stays)
    await bot.test.botEvent('wake', () => true, 10000).promise
    assert.strictEqual(bot.isSleeping, false)
    await assert.rejects(bot.wake(), /already awake/)
  })

  it('sleep() rejections like upstream: by day, not a bed, too far (Bedrock extra)', async () => {
    const { bot } = ctx
    await bot.waitForChunksToLoad()
    const bedPos1 = bot.entity.position.offset(2, 0, -3).floored()
    await placeBed(bot, bedPos1)
    bot.chat('/time set 1000')
    await once(bot, 'time')
    await bot.test.wait(500)
    await assert.rejects(bot.sleep(bot.blockAt(bedPos1)), /it's not night and it's not a thunderstorm/)

    bot.chat('/time set 18000')
    await once(bot, 'time')
    await bot.test.wait(500)
    await assert.rejects(bot.sleep(bot.blockAt(bot.entity.position.offset(0, -1, 0))), /wrong block : not a bed block/)

    // (half a bed cannot be staged on BDS: removing one half breaks the other; unit-tested in test/unit/bed.test.js)

    // too far: a bed 10 blocks away
    const far = bot.entity.position.offset(10, 0, 0).floored()
    await placeBed(bot, far)
    await bot.test.wait(500)
    await assert.rejects(bot.sleep(bot.blockAt(far)), /the bed is too far|cant click the bed/)
  })
})
