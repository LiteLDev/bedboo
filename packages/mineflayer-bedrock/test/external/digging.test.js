// owner: U10 (digging)
'use strict'
/**
 * Bedrock extra: the digging API semantics against BDS 1.26.51.1 (mineflayer has no dedicated external test besides
 * digAndBuild (U11's file, verbatim) / digEverything / digWaterSpeed): events and properties, stopDigging, creative
 * instant breaking, back-to-back digs, the server break state being released, face selection, durability, death and
 * what other players see.
 */
const assert = require('assert')
const { Vec3 } = require('vec3')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createTestBot } = require('./common')

describe('digging', function () {
  this.timeout(120000)
  const ctx = useBot({ botOptions: { viewDistance: 'tiny' } })
  beforeEach(() => ctx.bot.test.resetState())

  async function until (predicate, ticks = 40, what = 'condition') {
    for (let i = 0; i < ticks; i++) {
      if (predicate()) return
      await ctx.bot.waitForTicks(1)
    }
    assert.ok(predicate(), `timed out waiting for ${what}`)
  }

  async function survivalOnGround () {
    const { bot } = ctx
    bot.creative.stopFlying() // resetState flies (gravity 0, like upstream's testCommon)
    await bot.test.becomeSurvival()
    await until(() => bot.entity.onGround, 60, 'on ground')
  }

  async function serverHas (pos, name) {
    const out = await ctx.server.commandOutput(`testforblock ${pos.x} ${pos.y} ${pos.z} ${name}`)
    return out.some((l) => /^Successfully found the block/.test(l))
  }

  it('dig: diggingCompleted (air block), targetDigBlock / targetDigFace while digging, lastDigTime', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'dirt' })
    await survivalOnGround()
    assert.strictEqual(bot.targetDigBlock, null)
    assert.strictEqual(bot.lastDigTime, null)
    const block = bot.blockAt(pos)
    const completed = onceWithCleanup(bot, 'diggingCompleted', { timeout: 5000 })
    const dig = bot.dig(block)
    await until(() => bot.targetDigBlock !== null, 20, 'targetDigBlock')
    assert.strictEqual(bot.targetDigBlock, block)
    assert.strictEqual(bot.targetDigFace, 4, 'the bot west of the block sees its west face')
    const before = performance.now()
    assert.strictEqual(await dig, undefined, 'dig resolves with nothing, like upstream')
    const [air] = await completed
    assert.strictEqual(air.name, 'air')
    assert.ok(air.position.equals(pos))
    assert.strictEqual(bot.targetDigBlock, null)
    assert.strictEqual(bot.targetDigFace, null)
    assert.ok(bot.lastDigTime >= before && bot.lastDigTime <= performance.now())
    assert.ok(await serverHas(pos, 'air'))
  })

  it('stopDigging: diggingAborted, "Digging aborted", the block stays; digging it again works', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'stone' })
    await survivalOnGround()
    const aborted = onceWithCleanup(bot, 'diggingAborted', { timeout: 5000 })
    const dig = bot.dig(bot.blockAt(pos))
    await bot.test.wait(1000)
    bot.stopDigging()
    await assert.rejects(dig, /Digging aborted/)
    const [block] = await aborted
    assert.strictEqual(block.name, 'stone')
    assert.strictEqual(bot.targetDigBlock, null)
    assert.ok(typeof bot.lastDigTime === 'number')
    // BDS dropped the break: the stone survives well past its 7.5 s
    await bot.test.wait(7000)
    assert.ok(await serverHas(pos, 'stone'))
    assert.strictEqual(bot.blockAt(pos).name, 'stone')
    // a fresh dig starts from zero and completes
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.stone_pickaxe.id, 1))
    await until(() => bot.heldItem?.name === 'stone_pickaxe', 40, 'pickaxe')
    await bot.dig(bot.blockAt(pos))
    assert.ok(await serverHas(pos, 'air'))
  })

  it('creative: digging is instant and drops nothing', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'obsidian' })
    assert.strictEqual(bot.game.gameMode, 'creative')
    const block = bot.blockAt(pos)
    assert.strictEqual(bot.digTime(block), 0)
    const drops = []
    const onDrop = (e) => drops.push(e)
    bot.on('itemDrop', onDrop)
    try {
      const start = performance.now()
      await bot.dig(block)
      assert.ok(performance.now() - start < 1000, 'instant')
      assert.ok(await serverHas(pos, 'air'))
      await bot.test.wait(500)
      assert.deepStrictEqual(drops, [])
    } finally {
      bot.removeListener('itemDrop', onDrop)
    }
  })

  it('a block placed where one was just dug stays (the server break state is released)', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'dirt' })
    await survivalOnGround()
    await bot.dig(bot.blockAt(pos))
    await bot.waitForTicks(2)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'dirt' })
    await bot.test.wait(2000)
    assert.ok(await serverHas(pos, 'dirt'), 'BDS would keep breaking it without abort_break')
  })

  it('back-to-back digs (a 3-block tunnel) take the sum of their dig times', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const Item = require('prismarine-item')(bot.registry)
    await bot.test.setInventorySlot(36, new Item(bot.registry.itemsByName.wooden_pickaxe.id, 1))
    await ctx.server.commandOutput(`fill 1 ${g} -1 3 ${g + 1} -1 stone`)
    await until(() => bot.blockAt(new Vec3(3, g + 1, -1))?.name === 'stone', 40, 'stone')
    await survivalOnGround()
    await until(() => bot.heldItem?.name === 'wooden_pickaxe', 40, 'pickaxe')
    const blocks = [new Vec3(1, g, -1), new Vec3(1, g + 1, -1), new Vec3(2, g, -1), new Vec3(2, g + 1, -1), new Vec3(3, g, -1)]
    let expected = 0
    const start = performance.now()
    for (const pos of blocks) {
      const block = bot.blockAt(pos)
      expected += bot.digTime(block)
      await bot.dig(block)
      const last = bot._bedrock.digging.last
      assert.strictEqual(last.restores, 0)
      assert.strictEqual(last.serverSpeedData, last.speedData)
    }
    const elapsed = performance.now() - start
    assert.ok(elapsed < expected + blocks.length * 250, `${Math.round(elapsed)} ms for ${expected} ms of digging`)
    for (const pos of blocks) assert.ok(await serverHas(pos, 'air'), `${pos}`)
    assert.ok(await serverHas(new Vec3(3, g + 1, -1), 'stone'))
  })

  it('canDigBlock: diggable and within reach', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'dirt' })
    await bot.test.setBlock({ x: 8, y: g, z: 0, blockName: 'dirt' })
    assert.ok(bot.canDigBlock(bot.blockAt(new Vec3(2, g, 0))))
    assert.ok(!bot.canDigBlock(bot.blockAt(new Vec3(8, g, 0))), 'too far')
    assert.ok(!bot.canDigBlock(bot.blockAt(new Vec3(0, g - 4, 0))), 'bedrock is not diggable')
    // creative digs everything instantly (digTime 0, like upstream); in survival bedrock never breaks
    await bot.test.becomeSurvival()
    await assert.rejects(bot.dig(bot.blockAt(new Vec3(0, g - 4, 0))), /dig time for bedrock is Infinity/)
    assert.strictEqual(bot.targetDigBlock, null)
  })

  it('digFace: a face vector, "raycast" (the visible face) and forceLook "ignore"', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    const faces = []
    for (const [forceLook, digFace] of [[true, new Vec3(0, 1, 0)], [true, 'raycast'], [true, new Vec3(-1, 0, 0)], ['ignore', undefined]]) {
      await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'dirt' })
      const dig = bot.dig(bot.blockAt(pos), forceLook, digFace)
      await until(() => bot.targetDigBlock !== null, 20, 'dig started')
      faces.push(bot.targetDigFace)
      await dig
      assert.ok(await serverHas(pos, 'air'))
    }
    assert.deepStrictEqual(faces, [1, 4, 4, 1], 'top for (0,1,0); raycast: the closest visible face (west); west; ignore → top')
  })

  it('durability: every block costs the tool 1 and a used-up tool breaks', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    const Item = require('prismarine-item')(bot.registry)
    const pickaxe = new Item(bot.registry.itemsByName.wooden_pickaxe.id, 1)
    const start = pickaxe.maxDurability - 3
    pickaxe.durabilityUsed = start
    await bot.test.setInventorySlot(36, pickaxe)
    await survivalOnGround()
    await until(() => bot.heldItem?.durabilityUsed === start, 40, 'damaged pickaxe')
    const changes = []
    const onChange = (item) => changes.push(item?.durabilityUsed ?? null)
    bot.on('heldItemChanged', onChange)
    try {
      let digs = 0
      while (bot.heldItem && digs < 5) {
        const used = bot.heldItem.durabilityUsed
        // BDS sends the destroyed block's update more than once (within a tick): let them pass before re-staging, or
        // the console helper takes a late one for the new block's update
        await bot.waitForTicks(2)
        await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'stone' })
        await bot.dig(bot.blockAt(new Vec3(2, g, 0)))
        digs++
        await until(() => !bot.heldItem || bot.heldItem.durabilityUsed === used + 1, 40, `damage ${used + 1}`)
      }
      assert.strictEqual(bot.heldItem, null, 'the pickaxe broke')
      assert.ok(digs >= 3 && digs <= 4, `${digs} digs from Damage ${start} of ${pickaxe.maxDurability}`)
      assert.strictEqual(changes.at(-1), null, 'heldItemChanged(null) when it broke')
    } finally {
      bot.removeListener('heldItemChanged', onChange)
    }
  })

  it('death while digging rejects the dig', async () => {
    const { bot } = ctx
    const g = bot.test.groundY
    await bot.test.setBlock({ x: 2, y: g, z: 0, blockName: 'obsidian' })
    await survivalOnGround()
    const dig = bot.dig(bot.blockAt(new Vec3(2, g, 0)))
    dig.catch(() => {}) // rejected during selfKill, asserted below
    await bot.test.wait(300)
    await bot.test.selfKill()
    await assert.rejects(dig, /Digging aborted/)
    assert.strictEqual(bot.targetDigBlock, null)
    await bot.test.awaitRespawn?.()
  })

  it('another player sees the break progress (blockBreakProgressObserved stages, then blockBreakProgressEnd)', async () => {
    const { bot, server } = ctx
    const g = bot.test.groundY
    const pos = new Vec3(2, g, 0)
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'stone' })
    const { bot: watcher } = await createTestBot({ server, username: `watch${process.pid % 1000}`, botOptions: { viewDistance: 'tiny' } })
    try {
      await watcher.test.teleport(new Vec3(0, g, 4))
      await survivalOnGround()
      const stages = []
      watcher.on('blockBreakProgressObserved', (block, stage) => { if (block?.position.equals(pos)) stages.push(stage) })
      const ended = onceWithCleanup(watcher, 'blockBreakProgressEnd', { timeout: 15000, checkCondition: (b) => b?.position.equals(pos) })
      await bot.dig(bot.blockAt(pos)) // stone by hand: 7.5 s
      await ended
      assert.ok(stages.length >= 8, `stages ${stages}`)
      assert.deepStrictEqual(stages, [...stages].sort((a, b) => a - b), 'stages only go up (no restart every tick)')
      assert.ok(stages.at(-1) >= 8, `last stage ${stages.at(-1)}`)
    } finally {
      watcher.end('test done')
    }
  })
})
