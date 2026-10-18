// owner: U11 (placing & placement-based parity)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/nether.js: a portal block at the bot's feet (`/setblock ~ ~ ~ portal`)
 * → 'spawn' in the nether, place a sign there with bot.placeBlock, signOpen, updateSign, the server's echo
 * (blockEntityData), activateBlock, and a portal back → 'spawn' in the overworld.
 * ADAPTED (docs/differences/U11.md#nether-test): upstream stands on the nether roof (`/tp 0 128 0`, the block below is
 * the bedrock at y 127) and places the sign at y 128. Bedrock's nether ends at y 127 (build limit 128, y 0..127), so a
 * block at y 128 is outside the world: the bot makes a sealed 1×2 pocket in netherrack at a random spot near the
 * arrival portal (`/fill`, its own commands) and teleports into it. The sign item search skips the sign BLOCKS the Bedrock item
 * registry lists (as in sign.test.js), and the portal back is set 4 s after the arrival at the earliest (a portal
 * block put around a player during its post-teleport cooldown never takes it on Bedrock). Everything else is verbatim.
 * The overworld spots start 16-128 blocks east of the origin instead of at it: the portals left behind (BDS links
 * the trip back to them; removing them makes the next trip from the same nether spot hang) stay out of the area
 * resetState uses.
 */
const assert = require('assert')
const Vec3 = require('vec3')
const { once, sleep, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  // Test spawn event on death
  const Item = require('prismarine-item')(bot.registry)
  const portalName = bot.registry.blocksByName.nether_portal ? 'nether_portal' : 'portal'

  let signItem = null
  for (const name in bot.registry.itemsByName) {
    if (/(wall|standing)_sign$/.test(name)) continue // Bedrock (adapted): sign blocks in the item registry
    if (name.includes('sign') && !name.includes('hanging')) signItem = bot.registry.itemsByName[name]
  }
  assert.notStrictEqual(signItem, null)

  // A portal's link goes inert after a failed attempt at the same spot, so
  // each retry must use a fresh location or it is guaranteed to time out.
  bot.test.netherAttempts ??= 0
  const attempt = ++bot.test.netherAttempts
  // Bedrock (adapted): the spots start 16-128 blocks east of the origin (random multiple of 16), so the portals the
  // test leaves behind (BDS takes the bot back to them) are outside the area every resetState teleports into and
  // restores; on a reused world a new run usually starts at a new spot
  bot.test.netherSpot ??= 16 * (1 + Math.floor(Math.random() * 8))
  await bot.test.teleport(new Vec3(bot.test.netherSpot + (attempt - 1) * 4, bot.test.groundY, 0))
  bot.chat(`/setblock ~ ~ ~ ${portalName}`)
  await onceWithCleanup(bot, 'spawn', { timeout: 30000 })
  const arrivedAt = Date.now()
  // Bedrock (adapted): the nether's top block is y 127 (no block at y 128 on the roof): a sealed 1×2 pocket in
  // netherrack near the arrival portal instead (BDS takes a portal block there back to the overworld; from an
  // arbitrary spot such as (0, 100, 0) it did not within 60 s, measured), at a random offset (a portal block at a
  // nether spot that already took a player back once never takes one again: a rerun on the same world needs a new spot)
  const out = bot.entity.position.floored().offset(3 + Math.floor(Math.random() * 6), 0, Math.floor(Math.random() * 7) - 3)
  await bot.test.sayEverywhere(`/fill ${out.x - 1} ${out.y - 1} ${out.z - 1} ${out.x + 1} ${out.y + 2} ${out.z + 1} netherrack`)
  await bot.test.sayEverywhere(`/fill ${out.x} ${out.y} ${out.z} ${out.x} ${out.y + 1} ${out.z} air`)
  const moved = once(bot, 'forcedMove')
  bot.test.sayEverywhere(`/tp ${out.x} ${out.y} ${out.z}`)

  await moved
  await bot.waitForChunksToLoad()

  // Poll until the block below is loaded and non-air before placing.
  // On slow CI, chunks may report as loaded before block data is ready.
  let lowerBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  while (!lowerBlock || lowerBlock.name === 'air') {
    await sleep(100)
    lowerBlock = bot.blockAt(bot.entity.position.offset(0, -1, 0))
  }

  await bot.lookAt(lowerBlock.position, true)
  await bot.test.setInventorySlot(36, new Item(signItem.id, 1, 0))
  const signOpen = onceWithCleanup(bot, 'signOpen', { timeout: 5000 })
  await bot.placeBlock(lowerBlock, new Vec3(0, 1, 0))

  // The server opens the sign editor once the sign is placed.
  const [sign] = await signOpen
  bot.updateSign(sign, '1\n2\n3\n')

  // Wait for the server to echo the new text back rather than polling: it
  // usually lands within a tick, but can take longer on slow CI.
  await onceWithCleanup(bot, 'blockEntityData', {
    timeout: 5000,
    checkCondition: (block) => block?.position?.equals(sign.position) && block.signText?.trimEnd() === '1\n2\n3'
  })
  const updated = bot.blockAt(sign.position)
  console.log('Updated sign', updated)

  assert.strictEqual(updated.signText.trimEnd(), '1\n2\n3')

  if (updated.blockEntity) {
    // Check block update
    bot.activateBlock(updated)
    assert.notStrictEqual(updated.blockEntity, undefined)
  }

  // Bedrock (adapted): a portal block put around the player during its post-teleport portal cooldown never takes it
  // (measured: placed 1.2 s after the arrival → nothing within 60 s; 2.7 s after → back in 1 s)
  await sleep(Math.max(0, PORTAL_COOLDOWN_MS - (Date.now() - arrivedAt)))
  bot.chat(`/setblock ~ ~ ~ ${portalName}`)
  await onceWithCleanup(bot, 'spawn', { timeout: 30000 })
}

/** time after a dimension change before a new portal block at the player's feet is taken (Bedrock, see above) */
const PORTAL_COOLDOWN_MS = 4000

describe('nether', function () {
  this.timeout(180000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('nether', async () => {
    const { bot } = ctx
    const dimensions = []
    const onSpawn = () => dimensions.push(bot.game.dimension)
    bot.on('spawn', onSpawn)
    try {
      await upstream()(bot)
    } finally {
      bot.removeListener('spawn', onSpawn)
    }
    assert.deepStrictEqual(dimensions, ['the_nether', 'overworld'])
  })
})
