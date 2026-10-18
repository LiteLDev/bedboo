// owner: U10 (digging)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/digWaterSpeed.js — verbatim body (Bedrock /fill syntax and block
 * names are the Java ones). Bedrock extra: the eye-level water really slows digging (digTime ×5) and BDS agrees
 * (the dig completes without the server restoring the block).
 */
const { Vec3 } = require('vec3')
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot } = require('./common')

describe('digWaterSpeed', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('digWaterSpeed', async () => {
    const { bot } = ctx
    const groundY = bot.test.groundY

    const testX = 10
    const testZ = 10
    const floorY = groundY

    // Command feedback is sent immediately while block changes flush at tick
    // end, so a chat echo does not prove the fill's updates arrived; the probe
    // block reaching its expected state does.
    const untilBlockIs = async (pos, names) => {
      const reached = () => names.includes(bot.blockAt(pos)?.name)
      if (reached()) return
      await onceWithCleanup(bot.world, 'blockUpdate', { timeout: 5000, checkCondition: reached })
    }

    // --- Setup: teleport and prepare the area ---
    await bot.test.becomeCreative()
    await bot.test.teleport(new Vec3(testX, floorY + 2, testZ))
    await bot.waitForChunksToLoad()

    // Clear the test area and place a solid floor
    bot.chat(`/fill ${testX - 2} ${floorY} ${testZ - 2} ${testX + 2} ${floorY + 5} ${testZ + 2} air`)
    bot.chat(`/fill ${testX - 2} ${floorY} ${testZ - 2} ${testX + 2} ${floorY} ${testZ + 2} stone`)
    await untilBlockIs(new Vec3(testX, floorY, testZ), ['stone'])

    // Place a dirt block for digTime testing
    const digBlockPos = new Vec3(testX + 1, floorY + 1, testZ)
    await bot.test.setBlock({ x: digBlockPos.x, y: digBlockPos.y, z: digBlockPos.z, blockName: 'dirt' })

    // Teleport bot to the test position
    await bot.test.teleport(new Vec3(testX, floorY + 1, testZ))

    // === Test 1: No water around bot - eye-level block should not be water ===
    const eyeBlock1 = bot._getBlockAtEyeLevel()
    bot.test.sayEverywhere(`Test 1 (dry): eye-level block = ${eyeBlock1?.name ?? 'null'}`)
    assert.notStrictEqual(eyeBlock1?.name, 'water',
      'Eye-level block should not be water when area is dry')

    // === Test 2: Fill water column around bot - eye-level block should be water ===
    const eyePos = new Vec3(testX, floorY + 2, testZ)
    bot.chat(`/fill ${testX} ${floorY + 1} ${testZ} ${testX} ${floorY + 4} ${testZ} water`)
    await untilBlockIs(eyePos, ['water', 'flowing_water'])

    const eyeBlock2 = bot._getBlockAtEyeLevel()
    bot.test.sayEverywhere(`Test 2 (submerged): eye-level block = ${eyeBlock2?.name ?? 'null'}`)
    assert(['water', 'flowing_water'].includes(eyeBlock2?.name),
      `Eye-level block should be water when submerged, got ${eyeBlock2?.name ?? 'null'}`)

    // === Test 3: Verify isInWater flag no longer affects digTime ===
    // This is the core behavior change of this PR: digTime should check the block
    // at eye level instead of using bot.entity.isInWater
    // Clear water and restore dirt
    bot.chat(`/fill ${testX - 1} ${floorY + 1} ${testZ - 1} ${testX + 1} ${floorY + 5} ${testZ + 1} air`)
    await untilBlockIs(digBlockPos, ['air'])
    await untilBlockIs(eyePos, ['air'])
    await bot.test.setBlock({ x: digBlockPos.x, y: digBlockPos.y, z: digBlockPos.z, blockName: 'dirt' })

    await bot.test.becomeSurvival()

    const block = bot.blockAt(digBlockPos)
    assert(block && block.name !== 'air', 'Expected a dirt block to measure digTime')

    // Measure baseline digTime
    const baselineDigTime = bot.digTime(block)

    // Set isInWater=true without actual water blocks - should NOT change digTime
    const origIsInWater = bot.entity.isInWater
    bot.entity.isInWater = true
    const digTimeWithFlag = bot.digTime(block)
    bot.entity.isInWater = origIsInWater

    bot.test.sayEverywhere(`Test 3: baseline=${baselineDigTime}ms, isInWater=true: ${digTimeWithFlag}ms`)
    assert.strictEqual(digTimeWithFlag, baselineDigTime,
      `isInWater flag should not affect digTime (got ${digTimeWithFlag}ms vs baseline ${baselineDigTime}ms). The PR changes digTime to check eye-level water instead.`)

    // Cleanup
    await bot.test.becomeCreative()
    bot.chat(`/fill ${testX - 2} ${floorY + 1} ${testZ - 2} ${testX + 2} ${floorY + 5} ${testZ + 2} air`)

    bot.test.sayEverywhere('digWaterSpeed: all tests passed')
  })

  it('digWaterSpeed (Bedrock extra): digging with the eyes under water takes 5× longer and BDS agrees', async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    // a 1×1 water shaft walled with glass (the water must not flow), the dirt outside it
    for (const [x1, z1, x2, z2] of [[-1, -1, -1, 1], [1, -1, 1, 1], [0, -1, 0, -1], [0, 1, 0, 1]]) {
      await server.commandOutput(`fill ${x1} ${g} ${z1} ${x2} ${g + 1} ${z2} glass`)
    }
    const target = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: target.x, y: target.y, z: target.z, blockName: 'dirt' })
    bot.creative.stopFlying() // resetState flies (gravity 0, like upstream's testCommon)
    await bot.test.becomeSurvival()
    await bot.test.teleport(new Vec3(0, g, 0))
    await bot.waitForTicks(2)
    const dry = bot.digTime(bot.blockAt(target))
    assert.strictEqual(dry, 750, 'dirt by hand')
    await server.commandOutput(`fill 0 ${g} 0 0 ${g + 1} 0 water`)
    const eye = new Vec3(0, g + 1, 0)
    const reached = () => bot.blockAt(eye)?.name === 'water'
    if (!reached()) await onceWithCleanup(bot.world, 'blockUpdate', { timeout: 5000, checkCondition: reached })
    // settle on the bottom (Bedrock players sink slowly in water)
    for (let i = 0; i < 40 && !bot.entity.onGround; i++) await bot.waitForTicks(1)
    assert.ok(bot.entity.onGround, 'standing on the bottom')
    const wet = bot.digTime(bot.blockAt(target))
    assert.strictEqual(wet, dry * 5)
    const start = performance.now()
    await bot.dig(bot.blockAt(target))
    const elapsed = performance.now() - start
    const last = bot._bedrock.digging.last
    assert.strictEqual(last.restores, 0)
    assert.strictEqual(last.serverSpeedData, last.speedData, 'BDS reports the same break speed')
    assert.ok(elapsed > dry * 4, `took ${elapsed} ms`)
    assert.strictEqual(bot.blockAt(target).name, 'air')
    await server.commandOutput(`fill -1 ${g} -1 1 ${g + 1} 1 air`)
  })
})
