'use strict'
// owner: U2 (Bedrock data layer)
const assert = require('assert')
const path = require('path')
const { execFileSync } = require('child_process')
const data = require('..')

const DATASETS = [
  'attributes', 'blockCollisionShapes', 'blockStates', 'blocks', 'effects', 'enchantments', 'entities', 'foods',
  'items', 'materials', 'particles', 'sounds'
]

describe('@bedboo/bedrock-data install()', () => {
  it('is idempotent and reports every auto-discovered dataset', () => {
    const first = data.install()
    const second = data.install()
    assert.strictEqual(first, second)
    assert.strictEqual(first.installed, true)
    assert.strictEqual(first.version, '1.26.51')
    assert.deepStrictEqual([...first.datasets].sort(), DATASETS)
  })

  it('redefines the bedrock 1.26.51 getters of minecraft-data (and nothing else)', () => {
    data.install()
    const entry = require('minecraft-data/data.js').bedrock['1.26.51']
    for (const name of DATASETS) {
      const desc = Object.getOwnPropertyDescriptor(entry, name)
      assert.strictEqual(typeof desc.get, 'function', name)
      assert.strictEqual(entry[name], entry[name], `${name} is parsed once and cached`)
    }
    // untouched datasets keep minecraft-data's own files
    assert.ok(entry.protocol.types, 'protocol')
    assert.ok(Array.isArray(entry.biomes), 'biomes')
    // other versions keep their data
    const older = require('minecraft-data')('bedrock_1.26.30')
    assert.notStrictEqual(older.blocksArray.length, 0)
    assert.strictEqual(older.effectsByName.Levitation.id, 25, 'bedrock_1.26.30 keeps minecraft-data (Java 1.17) effect ids')
  })

  it('serves the overlay through require("minecraft-data")("bedrock_1.26.51")', () => {
    data.install()
    const mcData = require('minecraft-data')('bedrock_1.26.51')
    assert.strictEqual(mcData.version.minecraftVersion, '1.26.51')
    assert.strictEqual(mcData.blocksArray.length, 1477)
    assert.strictEqual(mcData.blockStates.length, 22091)
    assert.strictEqual(mcData.itemsArray.length, 2076)
    assert.strictEqual(mcData.blocksByName.stone.harvestTools[mcData.itemsByName.wooden_pickaxe.id], true)
    assert.strictEqual(mcData.effectsByName.Levitation.id, 24)
    assert.strictEqual(mcData.foodsByName.bread.foodPoints, 5)
    assert.strictEqual(mcData.attributesByName.movementSpeed.resource, 'minecraft:movement_speed')
    assert.ok(mcData.entitiesByName.happy_ghast)
    assert.strictEqual(mcData.supportFeature('blockHashes'), true)
  })

  it('refreshes a bedrock_1.26.51 object minecraft-data built before install()', () => {
    // fresh process: load the version first, then install
    const script = `
      const mcData = require('minecraft-data')
      const early = mcData('bedrock_1.26.51')
      const before = early.blockStates.length
      require(${JSON.stringify(path.join(__dirname, '..'))}).install()
      const after = mcData('bedrock_1.26.51')
      process.stdout.write(JSON.stringify({ same: early === after, before, after: early.blockStates.length, effect: early.effectsByName.SlowFalling.id }))
    `
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') }).toString())
    assert.strictEqual(out.same, true)
    assert.notStrictEqual(out.before, 22091, 'minecraft-data 3.117.0 inherits 1.26.30 block states')
    assert.strictEqual(out.after, 22091)
    assert.strictEqual(out.effect, 27)
  })
})
