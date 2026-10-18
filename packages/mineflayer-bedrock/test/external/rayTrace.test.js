// owner: U9 (player state, world extras & dimensions)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/rayTrace.js — VERBATIM test body (ray_trace.js is vendored
 * unchanged; lookAt is the physics plugin's). Extra Bedrock checks: blockAtCursor on a placed block with a matcher,
 * and getExplosionDamages (vendored explosion.js) against the bot.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { BlockFace } = require('prismarine-world').iterators
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  const { position } = bot.entity
  await bot.lookAt(position.offset(0, 3, 0), true)

  let block = bot.blockAtCursor()
  assert.strictEqual(block, null)

  block = bot.blockInSight()
  assert.strictEqual(block, undefined)

  await bot.lookAt(position.offset(0, -3, 0), true)

  block = bot.blockAtCursor()
  const relBlock = bot.blockAt(position.offset(0, -1, 0))
  relBlock.face = BlockFace.TOP

  assert.deepStrictEqual(block.position, relBlock.position)
  assert.deepStrictEqual(block.face, relBlock.face)

  block = bot.blockInSight()
  assert.deepStrictEqual(block.position, relBlock.position)
  assert.deepStrictEqual(block.face, relBlock.face)
}

describe('rayTrace', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('rayTrace', async () => {
    await ctx.bot.waitForChunksToLoad()
    await upstream()(ctx.bot)
  })

  it('rayTrace: a placed block in front, matcher, explosion damages (Bedrock extra)', async () => {
    const { bot } = ctx
    await bot.waitForChunksToLoad()
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 3, y: g + 1, z: 0, blockName: 'stone' })
    await bot.lookAt(new Vec3(3, g + 1.5, 0.5), true)
    const block = bot.blockAtCursor(5)
    assert.ok(block, 'stone in sight')
    assert.strictEqual(block.name, 'stone')
    assert.ok(block.position.equals(new Vec3(3, g + 1, 0)))
    assert.strictEqual(block.face, BlockFace.WEST)
    assert.strictEqual(bot.blockAtCursor(5, (b) => b.name === 'dirt'), null, 'matcher rejects the stone')
    assert.strictEqual(bot.blockAtCursor(2), null, 'out of range')
    assert.strictEqual(bot.entityAtCursor(), null)

    // explosion: raw damages from 1 block away with power 4 (TNT); the stone between shields part of the bot
    const raw = bot.getExplosionDamages(bot.entity, bot.entity.position.offset(0, 0, -1), 4, true)
    assert.ok(raw > 20, `raw ${raw}`)
    assert.strictEqual(bot.getExplosionDamages(bot.entity, bot.entity.position.offset(0, 0, -20), 4, true), 0, 'out of range')
    // peaceful: players take no explosion damage (difficulty factor 0), armor or not
    assert.strictEqual(bot.getExplosionDamages(bot.entity, bot.entity.position.offset(0, 0, -1), 4), 0)
  })
})
