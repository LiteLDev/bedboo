// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/exampleBee.js — ADAPTED (one step): runs
 * packages/mineflayer-bedrock/examples/bee.js (creative flight in a circle, bot.creative.flyTo) as a child process.
 * Upstream ops the child with the bot's `/op bee` and waits for the "Opped bee" chat message; BDS refuses `/op` from
 * a player and never tells players about a console op, so the op goes through the server console and its answer is
 * asserted there (docs/differences/U15.md#example-op). Everything else is verbatim.
 */
const assert = require('assert')
const { useBot } = require('./common')

/** the example's 11 flyTo legs (≈2 blocks each) with creative flight physics */
const FLIGHT_TIMEOUT = 30000

const upstream = () => async (bot) => {
  await bot.test.runExample('examples/bee.js', async (name) => {
    assert.strictEqual(name, 'bee')
    // Bedrock: op through the console (the upstream test waits for the bot's `/op` chat answer). Like upstream, wait
    // until the op reached the players: BDS announces the new permissions with an update_abilities for the child to
    // everyone; the child's own copy (flying: false) must not land after it started flying.
    const opped = waitForOtherAbilities(bot, 3000)
    await bot.test.ctx.consoleExpect(`op ${name}`, /^Opped|already/i) // to counteract spawn protection
    await opped
    await bot.test.wait(500)
    // Bedrock: creative.flyTo really flies (server-authoritative movement: no teleport steps of 0.5 block per tick), the
    // 11 legs take longer than tellAndListen's 5 s — same exchange with a longer wait
    const started = Date.now()
    const answer = bot.test.awaitChat((username, message) => {
      if (username !== name) return false
      if (message !== 'My flight was amazing !') {
        assert.fail(`Unexpected message: ${message}`) // error
      }
      return true // stop listening
    }, FLIGHT_TIMEOUT)
    bot.chat('fly')
    await answer
    console.log(`      bee flight: ${Date.now() - started} ms`)
  })
}

/** resolves on the next update_abilities about another player (or after `timeout` ms) */
function waitForOtherAbilities (bot, timeout) {
  return new Promise((resolve) => {
    const onAbilities = (packet) => {
      if (bot._bedrock.ids.isSelfUnique(packet.entity_unique_id)) return
      done()
    }
    const timer = setTimeout(done, timeout)
    function done () {
      clearTimeout(timer)
      bot._client.removeListener('update_abilities', onAbilities)
      resolve()
    }
    bot._client.on('update_abilities', onAbilities)
  })
}

describe('exampleBee', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('exampleBee', () => upstream()(ctx.bot))
})
