'use strict'
// owner: U2 (Bedrock data layer) — lib/bedrock/features.js covers every feature name used upstream
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')
const { FEATURES, createSupportFeature } = require('../../../lib/bedrock/features')
const { createRegistry } = require('../../../lib/registry')

const pkgDir = path.join(__dirname, '..', '..', '..')
const repoRoot = path.join(pkgDir, '..', '..')
const requireLib = createRequire(path.join(pkgDir, 'package.json'))
const requireAgent = createRequire(path.join(repoRoot, 'packages', 'agent', 'package.json'))
const dirOf = (req, name) => path.dirname(req.resolve(name + '/package.json'))

/** Every place whose `supportFeature('…')` calls reach bot.supportFeature / registry.supportFeature on Bedrock. */
const SCANNED = {
  'mineflayer lib/': path.join(dirOf(requireLib, 'mineflayer'), 'lib'),
  'mineflayer external tests (docs/upstream)': path.join(repoRoot, 'docs', 'upstream'),
  ...Object.fromEntries(['mineflayer-pathfinder', 'mineflayer-pvp', 'mineflayer-collectblock', 'mineflayer-tool', 'mineflayer-armor-manager', 'mineflayer-auto-eat']
    .map(name => [name, dirOf(requireAgent, name)])),
  // registry.supportFeature callers (prismarine-physics is forked in-repo by U5 and has its own feature list)
  ...Object.fromEntries(['prismarine-item', 'prismarine-block', 'prismarine-chunk', 'prismarine-registry', 'prismarine-entity', 'prismarine-windows', 'prismarine-chat', 'prismarine-recipe', 'prismarine-world']
    .map(name => [name, dirOf(requireLib, name)]))
}

function * jsFiles (dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) yield * jsFiles(file)
    else if (/\.(c|m)?js$/.test(entry.name)) yield file
  }
}

function usedFeatureNames () {
  const used = new Map() // name → first place
  for (const [label, dir] of Object.entries(SCANNED)) {
    for (const file of jsFiles(dir)) {
      if (/(^|[\\/])test[\\/]/.test(path.relative(dir, file)) && !label.startsWith('mineflayer external')) continue
      const src = fs.readFileSync(file, 'utf8')
      for (const m of src.matchAll(/supportFeature\(\s*['"`]([A-Za-z0-9_]+)['"`]/g)) {
        if (!used.has(m[1])) used.set(m[1], `${label}: ${path.relative(dir, file)}`)
      }
    }
  }
  return used
}

describe('lib/bedrock/features.js', () => {
  it('has an explicit Bedrock value for every feature name used upstream', () => {
    const used = usedFeatureNames()
    assert.ok(used.size > 100, `scanned ${used.size} names`)
    const missing = [...used].filter(([name]) => !Object.prototype.hasOwnProperty.call(FEATURES, name))
    assert.deepStrictEqual(missing, [], 'add these to packages/bedrock-data/features.js')
  })

  it('agrees with minecraft-data on every Bedrock feature (so prismarine-* behave the same)', () => {
    const registry = createRegistry()
    const supportFeature = createSupportFeature(registry)
    for (const { name } of require('minecraft-data/minecraft-data/data/bedrock/common/features.json')) {
      assert.deepStrictEqual(supportFeature(name), registry.supportFeature(name), name)
    }
  })

  it('takes the deliberate Bedrock branches', () => {
    const supportFeature = createSupportFeature(createRegistry())
    const expected = {
      itemsAreNotBlocks: true,
      itemsAreAlsoBlocks: false,
      blockSchemeIsFlat: true,
      tallWorld: true,
      hasElytraFlying: true,
      effectAreNotPrefixed: true,
      hasExecuteCommand: true,
      doesntHaveOffHandSlot: false,
      itemsWithComponents: false,
      nbtNameForEnchant: 'ench',
      fishingBiteDelayMaxTicks: 600
    }
    for (const [name, value] of Object.entries(expected)) assert.strictEqual(supportFeature(name), value, name)
    for (const value of Object.values(FEATURES)) assert.ok(['boolean', 'string', 'number'].includes(typeof value))
  })

  it('unknown names: strict mode throws, default mode warns once and returns false', async () => {
    const strict = createSupportFeature(createRegistry(), { strict: true })
    assert.throws(() => strict('someFutureJavaFeature'), /unknown feature 'someFutureJavaFeature'/)
    const lenient = createSupportFeature(createRegistry(), { strict: false })
    const warnings = []
    const onWarning = w => { if (w.code === 'BEDBOO_UNKNOWN_FEATURE') warnings.push(w.message) }
    process.on('warning', onWarning)
    try {
      assert.strictEqual(lenient('anotherFutureFeature'), false)
      assert.strictEqual(lenient('anotherFutureFeature'), false)
      await new Promise(resolve => setImmediate(resolve))
    } finally {
      process.removeListener('warning', onWarning)
    }
    assert.strictEqual(warnings.length, 1)
  })
})
