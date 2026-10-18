'use strict'
const assert = require('assert')
const data = require('..')

describe('@bedboo/bedrock-data (U0 stub)', () => {
  it('install() is idempotent and reports the overlay version', () => {
    const first = data.install()
    const second = data.install()
    assert.strictEqual(first, second)
    assert.strictEqual(first.installed, true)
    assert.strictEqual(first.version, '1.26.51')
    assert.ok(Array.isArray(first.datasets))
  })

  it('minecraft-data still serves bedrock_1.26.51 after install()', () => {
    data.install()
    const mcData = require('minecraft-data')('bedrock_1.26.51')
    assert.strictEqual(mcData.version.minecraftVersion, '1.26.51')
    assert.ok(mcData.blocksByName.stone)
  })
})
