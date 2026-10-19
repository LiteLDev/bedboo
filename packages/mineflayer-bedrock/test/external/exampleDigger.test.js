// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/exampleDigger.js — ADAPTED (one step): runs
 * packages/mineflayer-bedrock/examples/digger.js as a child process (dig the block below, equip dirt, jump-place a
 * block). Upstream ops the child with the bot's `/op digger`, which BDS refuses from a player: the op goes through the
 * server console (docs/differences/U15.md#example-op). Everything else is verbatim (`/give` is sent by the bot).
 */
const assert = require('assert')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  await bot.test.runExample('examples/digger.js', async (name) => {
    assert.strictEqual(name, 'digger')
    await bot.test.ctx.consoleExpect('op digger', /^Opped|already/i) // to counteract spawn protection (Bedrock: console)
    bot.chat('/give digger dirt 64')
    await bot.test.wait(2000)
    await bot.test.tellAndListen(name, 'dig', (message) => {
      if (message.startsWith('starting')) {
        return false // continue to listen
      } else if (message.startsWith('finished')) {
        return true // stop listening
      }
      assert.fail(`Unexpected message: ${message}`) // error
    })
    await bot.test.tellAndListen(name, 'equip dirt', (message) => {
      if (!message.startsWith('equipped dirt')) {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
    await bot.test.tellAndListen(name, 'build', (message) => {
      if (message !== 'Placing a block was successful') {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
  })
}

describe('exampleDigger', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())
  // the digger dug and rebuilt the block under it at (50, groundY - 1, 0): restore the floor for later tests
  afterEach(() => ctx.bot.test.ctx.consoleOutput(`fill 49 ${ctx.bot.test.groundY - 1} -1 51 ${ctx.bot.test.groundY - 1} 1 grass_block`))

  it('exampleDigger', () => upstream()(ctx.bot))
})
