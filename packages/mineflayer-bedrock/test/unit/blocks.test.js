'use strict'
// owner: U4 (core runtime) — world core (lib/plugins/blocks.js) on the recorded BDS join + the prismarine-chunk
// patch (dimension bounds, layer-1 superimposition)
const assert = require('assert')
const { performance } = require('perf_hooks')
const { Vec3 } = require('vec3')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')
const { createRegistry } = require('../../lib/registry')
const fixtures = require('../fixtures')

async function joined () {
  const created = await createFakeBot()
  const loads = []
  created.bot.on('chunkColumnLoad', (p) => loads.push(p))
  await replayJoin(created.bot, created.client)
  created.loads = loads
  return created
}

describe('world core (blocks.js) on the BDS 1.26.51.1 join capture', function () {
  this.timeout(30000)

  it('internalTest › blockAt', async () => {
    const { bot, loads, errors } = await joined()
    assert.deepStrictEqual(errors, [])
    assert.ok(loads.length >= 20, `${loads.length} columns loaded`)
    for (const corner of loads) {
      assert.strictEqual(corner.y, 0)
      assert.ok(corner.x % 16 === 0 && corner.z % 16 === 0, `corner ${corner}`)
    }
    const layers = { '-64': 'bedrock', '-63': 'dirt', '-62': 'dirt', '-61': 'grass_block', '-60': 'air', 0: 'air', 319: 'air' }
    for (const corner of loads) {
      for (const [y, name] of Object.entries(layers)) {
        const pos = corner.offset(7, Number(y), 9)
        const block = bot.blockAt(pos)
        assert.strictEqual(block.name, name, `${pos}`)
        assert.ok(block.position.equals(pos))
        assert.strictEqual(block.superimposed, undefined, 'no layer-1 block on a plain flat world')
      }
    }
    assert.strictEqual(bot.blockAt(new Vec3(100000, -61, 100000)), null, 'unloaded column → null')
    assert.strictEqual(bot.world.getBlock(new Vec3(0, -61, 0)).name, 'grass_block')
  })

  it('requests every sub-chunk (-4..19) of each level_chunk with one subchunk_request', async () => {
    const created = await createFakeBot()
    await replayJoin(created.bot, created.client)
    const levelChunks = fixtures.load('join_flat').packets('level_chunk').length
    const requests = created.client.sent('subchunk_request')
    assert.ok(requests.length > 0 && requests.length <= levelChunks)
    for (const r of requests) {
      assert.strictEqual(r.dimension, 0)
      assert.strictEqual(r.origin.y, 0)
      assert.deepStrictEqual(r.requests.map(q => q.y), Array.from({ length: 24 }, (_, i) => i - 4))
      assert.ok(r.requests.every(q => q.x === 0 && q.z === 0))
    }
    const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
    assert.ok(createSerializer('1.26.51').createPacketBuffer({ name: 'subchunk_request', params: requests[0] }).length > 0)
  })

  it('update_block (layer 0) → blockUpdate and blockUpdate:(x, y, z); _updateBlockState', async () => {
    const { bot, client } = await joined()
    const seen = []
    bot.on('blockUpdate', (oldBlock, newBlock) => seen.push([oldBlock.name, newBlock.name, newBlock.position.toString()]))
    const at = []
    bot.on('blockUpdate:(2, -60, 0)', (oldBlock, newBlock) => at.push(newBlock.name))
    const update = afterSpawnRecords().find(r => r.name === 'update_block' && r.params.position.x === 2)
    client.receive('update_block', update.params) // the capture's /setblock 2 -60 0 stone
    assert.deepStrictEqual(seen, [['air', 'stone', '(2, -60, 0)']])
    assert.deepStrictEqual(at, ['stone'])
    assert.strictEqual(bot.blockAt(new Vec3(2, -60, 0)).name, 'stone')
    bot._updateBlockState(new Vec3(2, -60, 0), bot.registry.blocksByName.air.defaultState)
    assert.strictEqual(bot.blockAt(new Vec3(2, -60, 0)).name, 'air')
    // an unknown runtime id becomes the documented placeholder
    client.receive('update_block', { position: { x: 3, y: -60, z: 0 }, block_runtime_id: 123456789, flags: { _value: 3 }, layer: 0 })
    assert.strictEqual(bot.blockAt(new Vec3(3, -60, 0)).name, 'unknown')
  })

  it('layer 1 = liquid layer: waterlogged blocks carry superimposed water (isWaterlogged), update_subchunk_blocks', async () => {
    const { bot, client } = await joined()
    const reg = bot.registry
    const rid = (name) => reg.runtimeIdByStateId[reg.blocksByName[name].defaultState]
    client.receive('update_block', { position: { x: 4, y: -60, z: 4 }, block_runtime_id: rid('oak_fence'), flags: { _value: 3 }, layer: 0 })
    let updates = 0
    bot.on('blockUpdate:(4, -60, 4)', () => updates++)
    client.receive('update_block', { position: { x: 4, y: -60, z: 4 }, block_runtime_id: rid('water'), flags: { _value: 3 }, layer: 1 })
    assert.strictEqual(updates, 1)
    const fence = bot.blockAt(new Vec3(4, -60, 4))
    assert.strictEqual(fence.name, 'oak_fence')
    assert.strictEqual(fence.superimposed.name, 'water')
    assert.strictEqual(fence.computedStates.waterlogged, true)
    assert.strictEqual(fence.isWaterlogged, true)
    // drain it
    client.receive('update_block', { position: { x: 4, y: -60, z: 4 }, block_runtime_id: rid('air'), flags: { _value: 3 }, layer: 1 })
    const dry = bot.blockAt(new Vec3(4, -60, 4))
    assert.strictEqual(dry.superimposed, undefined)
    assert.ok(!dry.isWaterlogged)

    client.receive('update_subchunk_blocks', {
      x: 0,
      y: -4,
      z: 0,
      blocks: [{ position: { x: 5, y: -61, z: 5 }, runtime_id: rid('stone'), flags: 3, entity_unique_id: 0n, transition_type: 'entity' }],
      extra: [{ position: { x: 4, y: -60, z: 4 }, runtime_id: rid('water'), flags: 3, entity_unique_id: 0n, transition_type: 'entity' }]
    })
    assert.strictEqual(bot.blockAt(new Vec3(5, -61, 5)).name, 'stone')
    assert.strictEqual(bot.blockAt(new Vec3(4, -60, 4)).superimposed.name, 'water')
  })

  it('layer-0 updates apply Bedrock\'s liquid-layer rule (BDS sends layer 0 only), confirmed by re-requesting the sub-chunk', async () => {
    const { bot, client } = await joined()
    const reg = bot.registry
    const Chunk = require('prismarine-chunk')(reg)
    const Block = require('prismarine-block')(reg)
    const rid = (name, props) => {
      const state = props ? Block.fromProperties(name, props, 0).stateId : reg.blocksByName[name].defaultState
      return reg.runtimeIdByStateId[state]
    }
    const layer0 = (x, z, name, props) => client.receive('update_block', { position: { x, y: -60, z }, block_runtime_id: rid(name, props), flags: { _value: 3 }, layer: 0 })
    const view = (x, z) => {
      const b = bot.blockAt(new Vec3(x, -60, z))
      return `${b.name}${b.superimposed ? '+' + b.superimposed.name : ''}${b.isWaterlogged ? ' (wl)' : ''}`
    }
    const updates = []
    bot.on('blockUpdate', (o, n) => updates.push(`${n.position}: ${o.name}${o.superimposed ? '+' + o.superimposed.name : ''} → ${n.name}${n.superimposed ? '+' + n.superimposed.name : ''}`))
    /** the server's answer to a re-request: the sub-chunk with the given blocks (layer 0 [+ layer 1]) */
    function answer (blocks) {
      const column = new Chunk({ x: 0, z: 0, minY: -64, worldHeight: 384 })
      for (const [x, z, name0, name1] of blocks) {
        column.setBlockStateId(new Vec3(x, -60, z), reg.blocksByName[name0].defaultState)
        if (name1) {
          const pos = new Vec3(x, -60, z)
          pos.l = 1
          column.setBlockStateId(pos, reg.blocksByName[name1].defaultState)
        }
      }
      const section = column.getSectionAtIndex(-4)
      section.y = -4 & 0xff // prismarine-chunk writes the index as an unsigned byte (BDS sends -4 as 0xfc)
      return column.networkEncodeSubChunkNoCache(-4).then(payload => client.receive('subchunk', { cache_enabled: false, dimension: 0, origin: { x: 0, y: 0, z: 0 }, entries: [{ dx: 0, dy: -4, dz: 0, result: 'success', payload, heightmap_type: 'no_data', render_heightmap_type: 'no_data' }] }))
    }
    const refreshes = () => client.sent('subchunk_request').filter(r => r.requests.length === 1)

    // a water source replaced by a fence (live: update_subchunk_blocks, two layer-0 fence entries, `extra` empty):
    // predicted waterlogged, then confirmed by the server
    layer0(4, 4, 'water')
    client.clearSent()
    client.receive('update_subchunk_blocks', { x: 0, y: -4, z: 0, blocks: [0, 1].map(() => ({ position: { x: 4, y: -60, z: 4 }, runtime_id: rid('oak_fence'), flags: 3, entity_unique_id: 0n, transition_type: 'entity' })), extra: [] })
    assert.strictEqual(view(4, 4), 'oak_fence+water (wl)')
    assert.deepStrictEqual(refreshes(), [{ dimension: 0, requests: [{ x: 0, y: -4, z: 0 }], origin: { x: 0, y: 0, z: 0 } }], 'one request for the sub-chunk')
    // the waterlogged fence replaced by stone: dry at once (a full cube: certain, nothing asked), one blockUpdate with
    // both layers
    updates.length = 0
    layer0(4, 4, 'stone')
    assert.strictEqual(view(4, 4), 'stone')
    assert.deepStrictEqual(updates, ['(4, -60, 4): oak_fence+water → stone'])
    assert.strictEqual(refreshes().length, 1)
    // a water source replaced by a torch: predicted wet, the server says dry → corrected
    layer0(6, 6, 'water')
    layer0(6, 6, 'torch')
    assert.strictEqual(view(6, 6), 'torch+water (wl)')
    updates.length = 0
    await answer([[4, 4, 'stone'], [6, 6, 'torch', 'water']]) // the answer to the first request (may predate the torch)
    assert.deepStrictEqual(updates, [], 'the fence is now stone in both; the torch is asked for again')
    assert.strictEqual(refreshes().length, 2)
    await answer([[4, 4, 'stone'], [6, 6, 'torch']])
    assert.deepStrictEqual(updates, ['(6, -60, 6): torch+water → torch'], 'only the changed block')
    assert.deepStrictEqual([view(6, 6), view(4, 4)], ['torch', 'stone'])
    // a waterlogged ladder replaced by a slab keeps the water; by air or water: the liquid layer empties (no request)
    client.clearSent()
    layer0(8, 8, 'water')
    layer0(8, 8, 'ladder')
    await answer([[8, 8, 'ladder', 'water']])
    layer0(8, 8, 'oak_slab')
    await answer([[8, 8, 'oak_slab', 'water']])
    assert.strictEqual(view(8, 8), 'oak_slab+water (wl)')
    assert.strictEqual(refreshes().length, 2)
    // the same block in another state (a slab turned into a top slab, a trapdoor toggling): certain, no request
    layer0(8, 8, 'oak_slab', { 'minecraft:vertical_half': 'top' })
    assert.strictEqual(view(8, 8), 'oak_slab+water (wl)')
    assert.strictEqual(refreshes().length, 2)
    layer0(8, 8, 'air')
    assert.strictEqual(view(8, 8), 'air')
    layer0(9, 9, 'water')
    layer0(9, 9, 'oak_fence')
    layer0(9, 9, 'water')
    assert.strictEqual(view(9, 9), 'water')
    // flowing water (not a source) does not waterlog; neither does lava
    layer0(10, 10, 'water', { liquid_depth: 1 })
    layer0(10, 10, 'oak_fence')
    layer0(11, 11, 'lava')
    layer0(11, 11, 'oak_fence')
    assert.deepStrictEqual([view(10, 10), view(11, 11)], ['oak_fence', 'oak_fence'])
    assert.strictEqual(refreshes().length, 3, 'only the uncertain cases ask the server (the 9,9 fence)')
    // an answer whose layer 0 is already outdated does not touch the block
    updates.length = 0
    await answer([[9, 9, 'oak_fence', 'water']])
    assert.strictEqual(view(9, 9), 'water')
    assert.deepStrictEqual(updates, [])
  })

  it('network_chunk_publisher_update unloads columns outside the radius (chunkColumnUnload)', async () => {
    const { bot, client, loads } = await joined()
    const unloaded = []
    bot.on('chunkColumnUnload', (p) => unloaded.push(p))
    client.receive('network_chunk_publisher_update', { coordinates: { x: 0, y: -59, z: 0 }, radius: 16, saved_chunks: [] })
    assert.ok(unloaded.length > 0)
    for (const corner of unloaded) assert.ok(Math.hypot(corner.x + 8, corner.z + 8) > 32)
    assert.ok(bot.world.getColumnAt(new Vec3(0, 0, 0)), 'the own column stays')
    assert.strictEqual(Object.keys(bot.world.async.columns).length, loads.length - unloaded.length)
  })

  it('findBlocks / findBlock: Bedrock palette shortcut, same result as a brute-force search, fast', async () => {
    const { bot } = await joined()
    const dirt = bot.registry.blocksByName.dirt.id
    const t0 = performance.now()
    const found = bot.findBlocks({ matching: [dirt], maxDistance: 128, count: 10 })
    const ms = performance.now() - t0
    assert.ok(ms < 500, `find dirt took ${ms.toFixed(1)} ms`)
    assert.strictEqual(found.length, 10)
    const feet = bot.entity.position.floored()
    for (const p of found) {
      assert.strictEqual(bot.blockAt(p).name, 'dirt')
      assert.ok(p.distanceTo(feet) <= 3.5, `${p} is among the closest`)
    }
    // the function matcher path agrees with the id fast path
    const byFn = bot.findBlocks({ matching: (b) => b.type === dirt, maxDistance: 16, count: 50 })
    const byId = bot.findBlocks({ matching: dirt, maxDistance: 16, count: 50 })
    assert.deepStrictEqual(byFn.map(String), byId.map(String))
    // useExtraInfo function filter
    const filtered = bot.findBlocks({ matching: dirt, maxDistance: 16, count: 5, useExtraInfo: (b) => b.position.y === -62 })
    assert.ok(filtered.length === 5 && filtered.every(p => p.y === -62))
    assert.deepStrictEqual(bot.findBlocks({ matching: bot.registry.blocksByName.diamond_block.id, maxDistance: 32 }), [])
    assert.strictEqual(bot.findBlock({ matching: bot.registry.blocksByName.bedrock.id }).name, 'bedrock')
    assert.strictEqual(bot.findBlock({ matching: bot.registry.blocksByName.diamond_block.id }), null)
  })

  it('canSeeBlock, waitForChunksToLoad, _getDimensionName', async () => {
    const { bot } = await joined()
    const below = bot.blockAt(bot.entity.position.offset(0, -1, 0))
    assert.strictEqual(below.name, 'grass_block')
    assert.strictEqual(bot.canSeeBlock(below), true)
    assert.strictEqual(bot.canSeeBlock(bot.blockAt(bot.entity.position.offset(0, -3, 0))), false, 'hidden under the grass')
    await bot.waitForChunksToLoad()
    assert.strictEqual(bot._getDimensionName(), 'minecraft:overworld')
  })
})

describe('prismarine-chunk patch (U4, wave 2)', () => {
  const registry = createRegistry()
  const cap = fixtures.load('join_flat')
  registry.handleStartGame(cap.first('start_game'))
  const ChunkColumn = require('prismarine-chunk')(registry)
  const Stream = require('prismarine-chunk/src/bedrock/common/Stream')

  it('columns honour minY/worldHeight: an 8-section nether biome payload stays aligned', () => {
    const w = new Stream()
    for (let i = 0; i < 8; i++) {
      w.writeUInt8(1) // zero bits per value, runtime ids
      w.writeVarInt((i + 1) << 1) // biome id i + 1
    }
    w.writeUInt8(0) // no border blocks
    const nether = new ChunkColumn({ x: 0, z: 0, minY: 0, worldHeight: 128 })
    assert.strictEqual(nether.minY, 0)
    assert.strictEqual(nether.worldHeight, 128)
    nether.networkDecodeNoCache(w.getBuffer(), 0)
    for (let i = 0; i < 8; i++) assert.strictEqual(nether.getBiomeId(new Vec3(3, i * 16 + 5, 3)), i + 1, `section ${i}`)
    const end = new ChunkColumn({ x: 0, z: 0, minY: 0, worldHeight: 256 })
    assert.strictEqual(end.maxY, 256)
    const overworld = new ChunkColumn({ x: 0, z: 0 })
    assert.strictEqual(overworld.minY, -64, 'default: the overworld')
    assert.strictEqual(overworld.worldHeight, 384)
    const copy = ChunkColumn.fromJson(nether.toJson())
    assert.strictEqual(copy.minY, 0)
    assert.strictEqual(copy.worldHeight, 128)
  })

  it('getBlock superimposes only a non-air layer 1 (no air shadow block, re-encodes unchanged after setBlock)', async () => {
    const column = new ChunkColumn({ x: 0, z: 0 })
    const stone = registry.blocksByName.stone.defaultState
    const pos = new Vec3(1, 2, 3)
    column.setBlockStateId(pos, stone)
    const plain = column.getBlock(pos)
    assert.strictEqual(plain.superimposed, undefined)
    column.setBlock(pos, plain)
    const section = column.getSectionAtIndex(0)
    assert.strictEqual(section.blocks.length, 1, 'setBlock of a plain block does not create a layer 1')
    const water = registry.blocksByName.water.defaultState
    const l1 = new Vec3(1, 2, 3)
    l1.l = 1
    column.setBlockStateId(l1, water)
    const wet = column.getBlock(pos)
    assert.strictEqual(wet.superimposed.name, 'water')
    assert.strictEqual(wet.isWaterlogged, true)
    const other = column.getBlock(new Vec3(5, 2, 5))
    assert.strictEqual(other.superimposed, undefined, 'air in layer 1 is not superimposed')
  })
})
