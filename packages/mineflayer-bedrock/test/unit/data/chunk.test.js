'use strict'
// owner: U2 (Bedrock data layer) — patched prismarine-chunk on the U0 BDS 1.26.51.1 capture
const assert = require('assert')
const { Vec3 } = require('vec3')
const fixtures = require('../../fixtures')
const { createRegistry } = require('../../../lib/registry')

const cap = fixtures.load('join_flat')
const registry = createRegistry()
registry.handleStartGame(cap.first('start_game'))
registry.handleItemRegistry(cap.first('item_registry'))
const ChunkColumn = require('prismarine-chunk')(registry)
const SubChunk = require('prismarine-chunk/src/bedrock/1.18/SubChunk')
const Stream = require('prismarine-chunk/src/bedrock/common/Stream')
const { StorageType } = require('prismarine-chunk/src/bedrock/common/constants')
const Block = require('prismarine-block')(registry)

/** level_chunk (request mode) + every subchunk reply of the capture → { columns, subchunks } */
async function decodeCapture () {
  const columns = new Map()
  for (const { params } of cap.packets('level_chunk')) {
    // Request mode on 1.26.40+: sub_chunk_count 0 and highest_subchunk_count present; the payload holds the
    // biomes (+ border blocks + block entities) only, the blocks come in `subchunk` packets.
    assert.strictEqual(params.sub_chunk_count, 0)
    assert.ok(params.highest_subchunk_count != null)
    const column = new ChunkColumn({ x: params.x, z: params.z })
    column.networkDecodeNoCache(params.payload, params.sub_chunk_count)
    columns.set(`${params.x},${params.z}`, column)
  }
  const subchunks = []
  for (const { params } of cap.packets('subchunk')) {
    for (const entry of params.entries) {
      const x = params.origin.x + entry.dx
      const y = params.origin.y + entry.dy
      const z = params.origin.z + entry.dz
      const column = columns.get(`${x},${z}`)
      if (!column || entry.result !== 'success') continue
      await column.networkDecodeSubChunkNoCache(y, entry.payload)
      subchunks.push({ column, y, payload: entry.payload })
    }
  }
  return { columns, subchunks }
}

describe('prismarine-chunk (bedboo patch) on BDS 1.26.51 chunks', () => {
  let decoded
  before(async () => { decoded = await decodeCapture() })

  it('has a bedrock 1.26 implementation', () => {
    assert.strictEqual(typeof ChunkColumn, 'function')
    assert.strictEqual(new ChunkColumn({ x: 0, z: 0 }).subChunkVersion, 9)
  })

  it('decodes every level_chunk and subchunk of the capture without placeholders', () => {
    assert.ok(decoded.columns.size >= 10)
    assert.ok(decoded.subchunks.length >= 10)
    for (const { column, y } of decoded.subchunks) {
      for (const layer of column.getSectionAtIndex(y).palette) {
        for (const entry of layer) assert.strictEqual(entry.runtimeId, undefined, `unknown runtime id in ${column.x},${y},${column.z}`)
      }
    }
  })

  it('the flat world is bedrock, dirt, dirt, grass_block at y -64..-61 with air above', () => {
    const expected = { '-64': 'bedrock', '-63': 'dirt', '-62': 'dirt', '-61': 'grass_block', '-60': 'air', '-50': 'air', 100: 'air' }
    for (const column of decoded.columns.values()) {
      for (const [y, name] of Object.entries(expected)) {
        for (const [x, z] of [[0, 0], [7, 9], [15, 15]]) {
          // the capture's /setblock stone/chest at y=-60 is the only exception
          const block = column.getBlock(new Vec3(x, Number(y), z))
          assert.strictEqual(block.name, name, `${column.x * 16 + x},${y},${column.z * 16 + z}`)
        }
      }
    }
  })

  it('re-encodes every sub-chunk byte for byte (runtime ids are the hashes BDS sent)', async () => {
    for (const { column, y, payload } of decoded.subchunks) {
      const encoded = await column.networkEncodeSubChunkNoCache(y)
      assert.ok(encoded.equals(payload), `sub-chunk ${column.x},${y},${column.z}`)
    }
  })

  it('setBlockStateId/getBlock work with the decoded columns (update_block from the capture)', () => {
    const column = decoded.columns.get('0,0')
    for (const { params } of cap.packets('update_block')) {
      const { x, y, z } = params.position
      if ((x >> 4) !== 0 || (z >> 4) !== 0) continue
      const { stateId, name } = registry.blocksByRuntimeId[params.block_runtime_id]
      column.setBlockStateId(new Vec3(x & 15, y, z & 15), stateId)
      assert.strictEqual(column.getBlock(new Vec3(x & 15, y, z & 15)).name, name)
    }
  })

  it('zero-bit sections decode negative state hashes (zigzag) and round-trip', async () => {
    const stone = registry.blocksByName.stone.defaultState
    const runtimeId = registry.runtimeIdByStateId[stone]
    assert.ok(runtimeId < 0, 'stone hashes to a negative int32')
    const w = new Stream()
    w.writeUInt8(9) // version
    w.writeUInt8(1) // one layer
    w.writeUInt8(0) // y index
    w.writeUInt8(1) // zero bits per block, runtime palette
    w.writeZigZagVarInt(runtimeId)
    const payload = w.getBuffer()
    const section = new SubChunk(registry, Block, { y: 0 })
    section.decode(StorageType.Runtime, new Stream(payload))
    assert.strictEqual(section.getBlock(0, 3, 4, 5).name, 'stone')
    assert.strictEqual(section.getPalette(0).length, 1, 'the single entry counts its 4096 blocks')
    assert.ok((await section.encode(StorageType.Runtime, false, false)).equals(payload))
  })

  it('unknown runtime ids decode to the documented placeholder (minecraft:unknown) and keep their id', async () => {
    const UNKNOWN = 987654321
    const w = new Stream()
    w.writeUInt8(9)
    w.writeUInt8(1)
    w.writeUInt8(0)
    w.writeUInt8((1 << 1) | 1) // 1 bit per block, runtime palette
    for (let i = 0; i < 128; i++) w.writeUInt32LE(0)
    w.writeZigZagVarInt(2) // palette size
    w.writeZigZagVarInt(registry.runtimeIdByStateId[registry.blocksByName.air.defaultState])
    w.writeZigZagVarInt(UNKNOWN)
    const payload = w.getBuffer()
    const section = new SubChunk(registry, Block, { y: 0 })
    assert.doesNotThrow(() => section.decode(StorageType.Runtime, new Stream(payload)))
    const entry = section.palette[0][1]
    assert.strictEqual(entry.name, 'unknown')
    assert.strictEqual(entry.runtimeId, UNKNOWN)
    assert.strictEqual(Block.fromStateId(entry.stateId, 0).name, 'unknown')
    assert.ok((await section.encode(StorageType.Runtime, false, false)).equals(payload), 'the unknown id is written back')
  })

  it('an unknown state id in setBlockStateId does not crash', () => {
    const column = new ChunkColumn({ x: 0, z: 0 })
    assert.doesNotThrow(() => column.setBlockStateId(new Vec3(1, 1, 1), 99999999))
  })
})
