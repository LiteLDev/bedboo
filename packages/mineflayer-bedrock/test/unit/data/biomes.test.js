'use strict'
// owner: U2 (Bedrock data layer) — biome ids on the U0 BDS 1.26.51.1 capture
const assert = require('assert')
const { Vec3 } = require('vec3')
const fixtures = require('../../fixtures')
const { createRegistry } = require('../../../lib/registry')

const cap = fixtures.load('join_flat')
const registry = createRegistry()
registry.handleStartGame(cap.first('start_game'))
registry.handleItemRegistry(cap.first('item_registry'))
const ChunkColumn = require('prismarine-chunk')(registry)

/**
 * every level_chunk of the capture, decoded (request mode: the payload is the biomes + border blocks), with
 * the blocks of its `subchunk` replies
 */
async function decodeColumns () {
  const columns = new Map()
  for (const { params } of cap.packets('level_chunk')) {
    const column = new ChunkColumn({ x: params.x, z: params.z })
    column.networkDecodeNoCache(params.payload, params.sub_chunk_count)
    columns.set(`${params.x},${params.z}`, column)
  }
  for (const { params } of cap.packets('subchunk')) {
    for (const entry of params.entries) {
      const column = columns.get(`${params.origin.x + entry.dx},${params.origin.z + entry.dz}`)
      if (column && entry.result === 'success') await column.networkDecodeSubChunkNoCache(params.origin.y + entry.dy, entry.payload)
    }
  }
  return [...columns.values()]
}

/** biome ids in the palettes of a column's biome sections (proxy sections repeat the one below) */
function paletteIds (column) {
  const ids = new Set()
  for (const section of column.biomes) for (const id of section.palette ?? []) ids.add(id)
  return ids
}

describe('biomes (vanilla Bedrock ids) on BDS 1.26.51 chunks', () => {
  let columns
  before(async () => { columns = await decodeColumns() })

  it('registry.biomes is keyed by the vanilla ids: plains 1, hell 8, the_end 9', () => {
    assert.strictEqual(registry.biomes[1].name, 'plains')
    assert.strictEqual(registry.biomes[8].name, 'hell')
    assert.strictEqual(registry.biomes[9].name, 'the_end')
    assert.strictEqual(registry.biomes[0].name, 'ocean')
    assert.strictEqual(registry.biomesByName.plains.id, 1)
  })

  it('the flat world palette [1] resolves to plains in every column, at every height', () => {
    assert.ok(columns.length >= 10)
    for (const column of columns) {
      assert.deepStrictEqual([...paletteIds(column)], [1], `${column.x},${column.z}`)
      for (const y of [-64, -61, -60, 0, 100, 319]) {
        const biome = column.getBiome(new Vec3(7, y, 7))
        assert.deepStrictEqual([biome.id, biome.name, biome.displayName], [1, 'plains', 'Plains'], `${column.x},${y},${column.z}`)
      }
      // bot.blockAt(pos).biome: prismarine-block 1.23.0 builds it with prismarine-biome(registry.version), which
      // only fills in the id (name '' on Java too); the id is the vanilla one
      const block = column.getBlock(new Vec3(0, -61, 0))
      assert.strictEqual(block.name, 'grass_block')
      const { biome } = block
      assert.strictEqual(biome.id, 1)
      assert.strictEqual(registry.biomes[biome.id].name, 'plains')
    }
  })

  it('every biome id in the capture resolves to a registry biome', () => {
    const seen = new Set()
    for (const column of columns) for (const id of paletteIds(column)) seen.add(id)
    assert.ok(seen.size > 0)
    for (const id of seen) assert.ok(registry.biomes[id], `biome id ${id}`)
  })

  it('biome_definition_list: vanilla biomes come in id order with biome_id 65535 and the dataset climate', () => {
    const packet = cap.first('biome_definition_list')
    const defs = packet.biome_definitions.map(def => ({ ...def, name: packet.string_list[def.name_index].replace(/^minecraft:/, '') }))
    // BDS sends no numeric ids for vanilla biomes: the client must use the vanilla numbering
    for (const def of defs) assert.strictEqual(def.biome_id, 65535, def.name)
    assert.deepStrictEqual(defs.map(d => d.name), [...registry.biomesArray].sort((a, b) => a.id - b.id).map(b => b.name))
    const f = Math.fround
    for (const def of defs) {
      const biome = registry.biomesByName[def.name]
      assert.strictEqual(f(biome.temperature), f(def.temperature), `${def.name} temperature`)
      assert.strictEqual(f(biome.rainfall), f(def.downfall), `${def.name} downfall`)
      assert.strictEqual(f(biome.depth), f(def.depth), `${def.name} depth`)
      assert.strictEqual(biome.has_precipitation, def.rain, `${def.name} rain`)
      assert.strictEqual(biome.color, def.map_water_colour & 0xffffff, `${def.name} map water colour`)
    }
  })
})
