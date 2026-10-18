'use strict'
// owner: U2 (Bedrock data layer) — one (patched) copy of every data package, whoever requires it
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { createRequire } = require('module')

const pkgDir = path.join(__dirname, '..', '..', '..')
const repoRoot = path.join(pkgDir, '..', '..')
const requireLib = createRequire(path.join(pkgDir, 'package.json'))
const requireAgent = createRequire(path.join(repoRoot, 'packages', 'agent', 'package.json'))

/** package → a source file the bedboo patch changed (it must contain the marker) */
const PATCHED = {
  'prismarine-registry': 'lib/bedrock/index.js',
  'prismarine-chunk': 'src/bedrock/1.18/SubChunk.js',
  'prismarine-block': 'index.js',
  'prismarine-item': 'index.js'
}

const CONSUMERS = {
  'mineflayer-bedrock': path.join(pkgDir, 'package.json'),
  '@bedboo/bedrock-data': requireLib.resolve('@bedboo/bedrock-data/package.json'),
  mineflayer: requireLib.resolve('mineflayer/package.json'),
  'bedrock-protocol': requireLib.resolve('bedrock-protocol/package.json'),
  'mineflayer-pathfinder': requireAgent.resolve('mineflayer-pathfinder/package.json'),
  'mineflayer-collectblock': requireAgent.resolve('mineflayer-collectblock/package.json'),
  'mineflayer-pvp': requireAgent.resolve('mineflayer-pvp/package.json'),
  'mineflayer-tool': requireAgent.resolve('mineflayer-tool/package.json')
}

describe('single copy of the patched data packages', () => {
  for (const pkg of ['minecraft-data', ...Object.keys(PATCHED)]) {
    it(`${pkg} resolves to the same file from every consumer`, () => {
      const resolved = new Map()
      for (const [consumer, manifest] of Object.entries(CONSUMERS)) {
        let file
        try { file = createRequire(manifest).resolve(pkg) } catch { continue } // not visible from there
        resolved.set(consumer, fs.realpathSync(file))
      }
      for (const required of ['mineflayer-bedrock', 'mineflayer', 'mineflayer-pathfinder', 'mineflayer-collectblock']) {
        assert.ok(resolved.has(required), `${pkg} not resolvable from ${required}`)
      }
      assert.strictEqual(new Set(resolved.values()).size, 1, JSON.stringify(Object.fromEntries(resolved), null, 2))
      if (PATCHED[pkg]) {
        const root = path.dirname(fs.realpathSync(requireLib.resolve(pkg + '/package.json')))
        assert.match(fs.readFileSync(path.join(root, PATCHED[pkg]), 'utf8'), /bedboo patch/, `${pkg} is patched`)
      }
    })
  }
})
