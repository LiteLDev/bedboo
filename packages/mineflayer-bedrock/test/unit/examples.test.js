'use strict'
// owner: U15 (ecosystem plugins & examples) — every example ported from mineflayer 4.39.0 (packages/mineflayer-bedrock/
// examples, the @bedboo/examples workspace package) parses and resolves each module it loads (require / import) from
// its own directory: `mineflayer-bedrock` itself, vec3 and the ecosystem plugins. The examples that need a server are
// run against BDS by test/external/example*.test.js.
const assert = require('assert')
const fs = require('fs')
const path = require('path')
const { execFileSync } = require('child_process')

const EXAMPLES = path.join(__dirname, '../../examples')

function exampleFiles (dir = EXAMPLES) {
  const files = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) files.push(...exampleFiles(full))
    else if (entry.name.endsWith('.js')) files.push(full)
  }
  return files.sort()
}

/** module names an example loads: require('x') / import('x') with a string literal */
function loadedModules (source) {
  const names = new Set()
  for (const m of source.matchAll(/\b(?:require|import)\(\s*'([^']+)'\s*\)/g)) names.add(m[1])
  return [...names]
}

describe('examples (mineflayer 4.39.0 examples ported to mineflayer-bedrock)', function () {
  this.timeout(60000)
  const files = exampleFiles()

  it('the upstream examples are ported (Java-only ones excepted, docs/differences/U15.md#examples)', () => {
    const names = files.map(f => path.relative(EXAMPLES, f))
    for (const name of ['bee.js', 'blockfinder.js', 'digger.js', 'inventory.js', 'chatterbox.js', 'guard.js', 'jumper.js',
      'trader.js', 'collectblock.js', 'auto-eat.js', 'pathfinder/gps.js', 'place_end_crystal/index.js', 'plugins/afk.js',
      'cli/readline.js', 'modular_mineflayer/index.js']) {
      assert.ok(names.includes(name), name)
    }
    assert.ok(files.length >= 51, `${files.length} examples`)
  })

  it('every example uses mineflayer-bedrock (not mineflayer)', () => {
    for (const file of files) {
      const source = fs.readFileSync(file, 'utf8')
      assert.ok(!/require\('mineflayer'\)/.test(source), `${file} requires mineflayer`)
    }
  })

  it('every example parses and resolves the modules it loads from its own directory', () => {
    for (const file of files) {
      execFileSync(process.execPath, ['--check', file])
      for (const name of loadedModules(fs.readFileSync(file, 'utf8'))) {
        if (name.startsWith('node:') || name.startsWith('.')) continue
        assert.doesNotThrow(() => require.resolve(name, { paths: [path.dirname(file)] }), `${path.relative(EXAMPLES, file)}: ${name}`)
      }
    }
    // mineflayer-bedrock resolves to this package (the workspace link), with the patched ecosystem plugins
    assert.strictEqual(fs.realpathSync(require.resolve('mineflayer-bedrock', { paths: [EXAMPLES] })), fs.realpathSync(require.resolve('../..')))
    for (const name of ['mineflayer-pathfinder', 'mineflayer-pvp', 'mineflayer-collectblock', 'mineflayer-tool', 'mineflayer-armor-manager']) {
      assert.strictEqual(fs.realpathSync(require.resolve(name, { paths: [EXAMPLES] })), fs.realpathSync(require.resolve(name)), name)
    }
  })
})
