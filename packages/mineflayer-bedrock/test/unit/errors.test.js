'use strict'
const { describe, it } = require('node:test')
const assert = require('assert')
const { NotImplementedError, stub, stubSync, stubAsync, isStub } = require('../../lib/bedrock/errors')

describe('lib/bedrock/errors', () => {
  it('NotImplementedError carries notImplemented, feature and code', () => {
    const err = new NotImplementedError('bot.equip')
    assert.ok(err instanceof Error)
    assert.strictEqual(err.notImplemented, true)
    assert.strictEqual(err.feature, 'bot.equip')
    assert.strictEqual(err.code, 'ERR_NOT_IMPLEMENTED')
    assert.match(err.message, /^bot\.equip is not implemented yet/)
  })

  it('stubSync throws synchronously and keeps name/arity', () => {
    const fn = stubSync('bot.blockAt', 1)
    assert.strictEqual(fn.name, 'blockAt')
    assert.strictEqual(fn.length, 1)
    assert.ok(isStub(fn))
    assert.throws(() => fn(), (err) => err.notImplemented && err.feature === 'bot.blockAt')
  })

  it('stubAsync returns a rejected promise (never throws synchronously)', async () => {
    const fn = stubAsync('bot.dig', 3)
    assert.strictEqual(fn.length, 3)
    let p
    assert.doesNotThrow(() => { p = fn() })
    await assert.rejects(p, (err) => err.notImplemented && err.feature === 'bot.dig')
  })

  it('noop stubs do nothing but are still flagged', () => {
    const fn = stub('bot.stopDigging', { noop: true, length: 1 })
    assert.strictEqual(fn(), undefined)
    assert.ok(isStub(fn))
    assert.strictEqual(fn.length, 1)
  })
})
