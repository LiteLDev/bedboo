'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { execFileSync } = require('child_process')
const data = require('..')
const { createInstaller, listVersions } = require('../install')

const DATASETS = [
  'attributes', 'biomes', 'blockCollisionShapes', 'blockStates', 'blocks', 'effects', 'enchantments', 'entities', 'foods',
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
    assert.deepStrictEqual(first.versions, data.versions)
    assert.deepStrictEqual(first.datasetsByVersion['1.26.51'], first.datasets)
  })

  it('lists every data/<version>/ directory, sorted, 1.26.51 included', () => {
    const dirs = fs.readdirSync(path.join(__dirname, '..', 'data')).filter(d => /^\d+(\.\d+)+$/.test(d))
    assert.deepStrictEqual([...data.versions].sort(), dirs.sort())
    assert.ok(data.versions.includes('1.26.51'))
    assert.ok(Object.isFrozen(data.versions))
  })

  it('overlays every data version and relaxes its Java version comparisons', () => {
    const { datasetsByVersion } = data.install()
    const entries = require('minecraft-data/data.js').bedrock
    for (const version of data.versions) {
      assert.ok(datasetsByVersion[version].length > 0, version)
      for (const name of datasetsByVersion[version]) {
        assert.strictEqual(typeof Object.getOwnPropertyDescriptor(entries[version], name).get, 'function', `${version} ${name}`)
      }
      const mcData = require('minecraft-data')('bedrock_' + version)
      assert.strictEqual(mcData.version.minecraftVersion, version)
      assert.strictEqual(mcData.isNewerOrEqualTo('1.9'), true, `${version} >= Java 1.9`)
      assert.strictEqual(mcData.isOlderThan('26.1'), true, `${version} < Java 26.1`)
    }
  })

  it('sorts version directories numerically and ignores other entries', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-data-'))
    try {
      for (const d of ['1.26.10', '1.26.9', '1.26.51', 'notes']) fs.mkdirSync(path.join(root, d))
      fs.writeFileSync(path.join(root, '1.26.60'), 'a file, not a version directory')
      assert.deepStrictEqual(listVersions(root), ['1.26.9', '1.26.10', '1.26.51'])
      assert.deepStrictEqual(listVersions(path.join(root, 'missing')), [])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws for a data version minecraft-data has no entry for (before patching anything)', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-data-'))
    try {
      fs.mkdirSync(path.join(root, '9.99.0'))
      fs.writeFileSync(path.join(root, '9.99.0', 'effects.json'), '[]')
      assert.throws(() => createInstaller(root)(), /no bedrock 9\.99\.0 entry/)
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
  })

  it('overlays two data directories onto their own versions (and refreshes one built before install)', () => {
    // fresh process: the getters install() defines are global to minecraft-data
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'bedrock-data-'))
    try {
      const effect = (id, name) => [{ id, name, displayName: name, type: 'good' }]
      for (const version of ['1.26.40', '1.26.45']) fs.mkdirSync(path.join(root, version))
      fs.writeFileSync(path.join(root, '1.26.40', 'effects.json'), JSON.stringify(effect(90, 'Fake40')))
      fs.writeFileSync(path.join(root, '1.26.45', 'effects.json.gz'), require('zlib').gzipSync(JSON.stringify(effect(91, 'Fake45'))))
      fs.writeFileSync(path.join(root, '1.26.45', 'features.js'), 'module.exports = {}\n') // not a dataset
      const script = `
        const mcData = require('minecraft-data')
        const early = mcData('bedrock_1.26.45')
        const { createInstaller } = require(${JSON.stringify(path.join(__dirname, '..', 'install'))})
        const install = createInstaller(${JSON.stringify(root)})
        const result = install()
        const v40 = mcData('bedrock_1.26.40')
        const v45 = mcData('bedrock_1.26.45')
        const v51 = mcData('bedrock_1.26.51')
        process.stdout.write(JSON.stringify({
          result,
          again: install() === result,
          same: early === v45,
          fake40: v40.effectsByName.Fake40?.id,
          fake45: early.effectsByName.Fake45?.id,
          crossed: [v40.effectsByName.Fake45, v45.effectsByName.Fake40].some(Boolean),
          untouched: v51.effectsByName.Levitation?.id,
          relaxed: [v40.isNewerOrEqualTo('1.9'), v45.version['<']('26.1')]
        }))
      `
      const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') }).toString())
      assert.deepStrictEqual(out.result.versions, ['1.26.40', '1.26.45'])
      assert.deepStrictEqual(out.result.datasetsByVersion, { '1.26.40': ['effects'], '1.26.45': ['effects'] })
      assert.strictEqual(out.result.version, '1.26.51')
      assert.deepStrictEqual(out.result.datasets, [], 'no data for the default version under this root')
      assert.strictEqual(out.again, true)
      assert.strictEqual(out.same, true)
      assert.strictEqual(out.fake40, 90)
      assert.strictEqual(out.fake45, 91, 'the cached bedrock_1.26.45 object built before install() was refreshed')
      assert.strictEqual(out.crossed, false)
      assert.strictEqual(out.untouched, 25, 'bedrock_1.26.51 (no directory under this root) keeps minecraft-data')
      assert.deepStrictEqual(out.relaxed, [true, true])
    } finally {
      fs.rmSync(root, { recursive: true, force: true })
    }
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
    assert.ok(Array.isArray(entry.instruments), 'instruments')
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
    // the overlay wins over minecraft-data's own bedrock/1.26.51 blocks (3.119.0+), which lack these fields
    assert.strictEqual(mcData.blocksByName.stone.friction, 0.6)
    assert.strictEqual(typeof mcData.blockStates[0].hash, 'number')
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
      const before = { friction: early.blocksByName.stone.friction ?? null, hash: 'hash' in early.blockStates[0] }
      require(${JSON.stringify(path.join(__dirname, '..'))}).install()
      const after = mcData('bedrock_1.26.51')
      process.stdout.write(JSON.stringify({ same: early === after, before, after: { friction: early.blocksByName.stone.friction, hash: 'hash' in early.blockStates[0], states: early.blockStates.length }, effect: early.effectsByName.SlowFalling.id }))
    `
    const out = JSON.parse(execFileSync(process.execPath, ['-e', script], { cwd: path.join(__dirname, '..') }).toString())
    assert.strictEqual(out.same, true)
    // minecraft-data >= 3.119.0 ships its own bedrock/1.26.51 blocks (same 22091 states), but without the overlay's
    // Cloudburst friction and block-state hashes
    assert.deepStrictEqual(out.before, { friction: null, hash: false }, 'minecraft-data serves its own 1.26.51 blocks before install()')
    assert.deepStrictEqual(out.after, { friction: 0.6, hash: true, states: 22091 })
    assert.strictEqual(out.effect, 27)
  })
})
