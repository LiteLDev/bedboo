// owner: U4 (core runtime)
'use strict'
/**
 * World core against a real BDS 1.26.51.1 (Bedrock extra, U4): chunks in sub-chunk request mode across the flat
 * world, blockAt, setblock (update_block) and fill (update_subchunk_blocks) → blockUpdate events, findBlocks
 * correctness + speed (the exampleBlockFinder budget), canSeeBlock, publisher-radius unloading.
 */
const assert = require('assert')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const { useBot } = require('./common')

function waitFor (emitter, event, predicate = () => true, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, fn); reject(new Error(`timed out waiting for ${event}`)) }, timeout)
    function fn (...args) {
      if (!predicate(...args)) return
      clearTimeout(timer)
      emitter.removeListener(event, fn)
      resolve(args)
    }
    emitter.on(event, fn)
  })
}

describe('core: world, chunks and block updates (U4)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('every loaded column of the flat world: bedrock -64, dirt -63/-62, grass -61, air above', async () => {
    const { bot } = env
    await bot.waitForChunksToLoad()
    const columns = Object.keys(bot.world.async.columns).map(k => k.split(',').map(Number))
    assert.ok(columns.length >= 100, `${columns.length} columns (view distance 'far')`)
    const expected = { '-64': 'bedrock', '-63': 'dirt', '-62': 'dirt', '-61': 'grass_block', '-55': 'air', 0: 'air', 200: 'air', 319: 'air' }
    for (const [cx, cz] of columns) {
      if (Math.abs(cx) <= 1 && Math.abs(cz) <= 1) continue // the tests' building area
      for (const [y, name] of Object.entries(expected)) {
        const pos = new Vec3(cx * 16 + 3, Number(y), cz * 16 + 11)
        assert.strictEqual(bot.blockAt(pos)?.name, name, `${pos}`)
      }
    }
    assert.strictEqual(bot.blockAt(new Vec3(0, -100, 0)).name, 'air', 'below the world')
    assert.strictEqual(bot.blockAt(new Vec3(1e6, -61, 1e6)), null, 'not loaded')
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    assert.strictEqual(below.name, 'grass_block')
    assert.strictEqual(bot.canSeeBlock(below), true)
    assert.strictEqual(bot.canSeeBlock(bot.blockAt(bot.entity.position.offset(0, -3, 0))), false)
  })

  it('setblock → blockUpdate and blockUpdate:(x, y, z) with the old and new block', async () => {
    const { bot } = env
    const pos = new Vec3(3, bot.test.groundY, 1)
    const updated = waitFor(bot, 'blockUpdate:(3, -60, 1)')
    const any = waitFor(bot, 'blockUpdate', (oldBlock, newBlock) => newBlock.position.equals(pos))
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'stone' })
    const [oldBlock, newBlock] = await updated
    await any
    assert.strictEqual(oldBlock.name, 'air')
    assert.strictEqual(newBlock.name, 'stone')
    assert.ok(newBlock.position.equals(pos))
    assert.strictEqual(bot.blockAt(pos).name, 'stone')
    const back = waitFor(bot, 'blockUpdate:(3, -60, 1)')
    await bot.test.setBlock({ x: pos.x, y: pos.y, z: pos.z, blockName: 'air' })
    assert.strictEqual((await back)[1].name, 'air')
  })

  it('fill (update_subchunk_blocks) updates every block; findBlocks finds them, nearest first', async () => {
    const { bot, server } = env
    const positions = []
    for (let x = 2; x <= 4; x++) for (let z = 2; z <= 4; z++) positions.push(new Vec3(x, bot.test.groundY, z))
    const remaining = new Set(positions.map(String))
    const all = new Promise((resolve) => {
      const onUpdate = (oldBlock, newBlock) => {
        remaining.delete(newBlock.position.toString())
        if (remaining.size === 0) { bot.removeListener('blockUpdate', onUpdate); resolve() }
      }
      bot.on('blockUpdate', onUpdate)
    })
    const lines = await server.commandOutput(`fill 2 ${bot.test.groundY} 2 4 ${bot.test.groundY} 4 gold_block`)
    assert.ok(lines.some(l => /9 blocks filled/.test(l)), lines.join(' | '))
    await Promise.race([all, new Promise((resolve, reject) => setTimeout(() => reject(new Error(`no update for ${[...remaining]}`)), 10000))])
    for (const p of positions) assert.strictEqual(bot.blockAt(p).name, 'gold_block')
    const gold = bot.registry.blocksByName.gold_block.id
    const found = bot.findBlocks({ matching: gold, maxDistance: 32, count: 20 })
    assert.deepStrictEqual(found.map(String).sort(), positions.map(String).sort())
    const nearest = bot.findBlock({ matching: gold })
    assert.ok(nearest.position.equals(new Vec3(2, bot.test.groundY, 2)), `${nearest.position}`)
  })

  it('findBlocks: find dirt within 128 blocks in < 500 ms (exampleBlockFinder budget)', async () => {
    const { bot } = env
    const dirt = bot.registry.blocksByName.dirt.id
    const t0 = performance.now()
    const blocks = bot.findBlocks({ matching: [dirt], maxDistance: 128, count: 10 })
    const ms = performance.now() - t0
    assert.strictEqual(blocks.length, 10)
    assert.ok(ms < 500, `${ms.toFixed(1)} ms`)
    for (const p of blocks) assert.strictEqual(bot.blockAt(p).name, 'dirt')
    assert.strictEqual(bot.findBlocks({ matching: bot.registry.blocksByName.diamond_ore.id, maxDistance: 64 }).length, 0)
  })

  it('chunks out of the publisher radius are unloaded (chunkColumnUnload) after a long /tp, then come back', async () => {
    const { bot } = env
    const unloaded = []
    const onUnload = (p) => unloaded.push(p)
    bot.on('chunkColumnUnload', onUnload)
    try {
      await bot.test.teleport(new Vec3(2000, bot.test.groundY, 2000))
      await bot.waitForChunksToLoad()
      assert.ok(unloaded.some(p => p.x === 0 && p.z === 0), 'the origin column was unloaded')
      assert.strictEqual(bot.world.getColumnAt(new Vec3(0, 0, 0)), undefined)
      assert.strictEqual(bot.blockAt(new Vec3(2000, bot.test.groundY - 1, 2000)).name, 'grass_block')
    } finally {
      bot.removeListener('chunkColumnUnload', onUnload)
    }
    await bot.test.teleport(new Vec3(0, bot.test.groundY, 0))
    await bot.waitForChunksToLoad()
    assert.strictEqual(bot.blockAt(new Vec3(0, bot.test.groundY - 1, 0)).name, 'grass_block')
  })
})
