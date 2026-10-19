// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/exampleBlockFinder.js — VERBATIM test body. Runs
 * packages/mineflayer-bedrock/examples/blockfinder.js (the upstream example with require('mineflayer-bedrock')) as a
 * child process: `find dirt` must find dirt blocks (the flat world's dirt layers) in < 500 ms.
 */
const assert = require('assert')
const { useBot } = require('./common')

const upstream = () => async (bot) => {
  await bot.test.runExample('examples/blockfinder.js', async (name) => {
    assert.strictEqual(name, 'finder')
    await bot.test.wait(2000)
    await bot.test.tellAndListen(name, 'find dirt', (message) => {
      const matches = message.match(/I found ([0-9]+) (.+?) blocks in (.+?) ms/)
      if (matches.length !== 4 || matches[1] === '0' || matches[2] !== 'dirt' || parseFloat(matches[3]) > 500) {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    })
  })
}

describe('exampleBlockFinder', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('exampleBlockFinder', () => upstream()(ctx.bot))
})
