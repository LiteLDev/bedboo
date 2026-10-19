'use strict'
// owner: U16b — regression: columns BDS sends for the granted chunk radius before its publisher updates catch up
// must not be unloaded (BDS never resends them; waitForChunksToLoad then times out — seen with runExample children)
const assert = require('assert')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin } = require('./helpers/fake')

describe('chunk radius vs publisher radius (U16b fix in blocks.js)', function () {
  // 'publisher radius + two chunks': with the join radius 64 BDS sends corner columns ~82 blocks away
  this.timeout(30000)

  async function joined () {
    const created = await createFakeBot()
    const loads = []
    created.bot.on('chunkColumnLoad', (p) => loads.push(p))
    await replayJoin(created.bot, created.client)
    return { ...created, loads }
  }

  it('a publisher update with a smaller radius than the granted chunk radius keeps the granted columns', async () => {
    // (BDS 1.26.51.1: chunk_radius_update can also come after the first far columns; the slack covers those)
    const { bot, client, loads } = await joined()
    assert.ok(loads.some((p) => Math.hypot(p.x + 8, p.z + 8) > 64), 'the capture has columns beyond 64 blocks')
    const unloaded = []
    bot.on('chunkColumnUnload', (p) => unloaded.push(p))
    client.receive('chunk_radius_update', { chunk_radius: 10 })
    // the join publisher radius lags behind: BDS already sent columns up to the granted 10 chunks
    client.receive('network_chunk_publisher_update', { coordinates: { x: 0, y: 32769, z: 0 }, radius: 32, saved_chunks: [] })
    assert.deepStrictEqual(unloaded, [])
    for (const p of loads) assert.ok(bot.world.getColumnAt(p), `column ${p} kept`)
  })

  it('columns beyond both radii are still unloaded', async () => {
    const { bot, client, loads } = await joined()
    const unloaded = []
    bot.on('chunkColumnUnload', (p) => unloaded.push(p))
    client.receive('chunk_radius_update', { chunk_radius: 2 })
    client.receive('network_chunk_publisher_update', { coordinates: { x: 0, y: -59, z: 0 }, radius: 32, saved_chunks: [] })
    const far = loads.filter((p) => Math.hypot(p.x + 8, p.z + 8) > 64) // radius 32 + two chunks of slack
    assert.ok(far.length > 0)
    assert.strictEqual(unloaded.length, far.length)
    for (const p of far) assert.ok(!bot.world.getColumnAt(p), `column ${p} unloaded`)
    assert.ok(bot.world.getColumnAt(new Vec3(0, 0, 0)), 'the own column stays')
  })
})
