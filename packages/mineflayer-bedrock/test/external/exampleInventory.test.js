// owner: U15 (ecosystem plugins & examples)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/exampleInventory.js — ADAPTED: runs
 * packages/mineflayer-bedrock/examples/inventory.js (list, equip off-hand / hand / feet, toss, craft a ladder at a
 * crafting table, unequip) as a child process.
 * - Bedrock's off-hand only takes off-hand items (shield, totem, arrows, rockets, …; BDS rejects dirt): the child also
 *   gets 16 arrows and the off-hand step equips them; the arrows stay in slot 45, which the example lists last
 *   (docs/differences/U8.md#offhand, docs/differences/U15.md#example-inventory).
 * - `/op` goes through the server console (BDS refuses it from a player, docs/differences/U15.md#example-op).
 * The rest — the commands, the `/give`s and `/clear` sent by the bot, the crafting table at (52, groundY, 0), the
 * `bot.registry.isOlderThan('1.9')` check — is verbatim.
 */
const assert = require('assert')
const { useBot } = require('./common')

const tests = [
  {
    command: 'list',
    wantedMessage: 'dirt x 64, stick x 7, iron_ore x 64, diamond_boots x 1, arrow x 16'
  },
  {
    command: 'equip off-hand arrow', // Bedrock: off-hand items only (upstream: dirt)
    wantedMessage: 'equipped arrow'
  },
  {
    command: 'list',
    wantedMessage: 'dirt x 64, stick x 7, iron_ore x 64, diamond_boots x 1, arrow x 16'
  },
  {
    command: 'equip hand dirt',
    wantedMessage: 'equipped dirt'
  },
  {
    command: 'toss 64 dirt',
    wantedMessage: 'tossed 64 x dirt'
  },
  {
    command: 'craft 1 ladder',
    wantedMessage: 'I can make ladder'
  },
  {
    command: '',
    wantedMessage: 'did the recipe for ladder 1 times'
  },
  {
    command: 'equip feet diamond_boots',
    wantedMessage: 'equipped diamond_boots'
  },
  {
    command: 'toss iron_ore',
    wantedMessage: 'tossed iron_ore'
  },
  {
    command: 'unequip feet',
    wantedMessage: 'unequipped'
  },
  { // after tests layout (Bedrock: the arrows in the off-hand are listed last)
    command: 'list',
    wantedMessage: 'ladder x 3, diamond_boots x 1, arrow x 16'
  }
]
const upstream = () => async (bot) => {
  await bot.test.runExample('examples/inventory.js', async (name) => {
    assert.strictEqual(name, 'inventory')
    await bot.test.ctx.consoleExpect('op inventory', /^Opped|already/i) // to counteract spawn protection (Bedrock: console)
    bot.chat('/clear inventory')
    await bot.test.setBlock({ x: 52, y: bot.test.groundY, z: 0, blockName: 'crafting_table' })
    bot.chat('/give inventory dirt 64')
    bot.chat('/give inventory stick 7')
    bot.chat('/give inventory iron_ore 64')
    bot.chat('/give inventory diamond_boots 1')
    bot.chat('/give inventory arrow 16') // Bedrock: the off-hand step's item
    if (bot.registry.isOlderThan('1.9')) {
      tests.splice(tests.indexOf(tests.find(t => t.command.includes('off-hand'))), 2) // Delete off-hand command and the command after it as they don't work in 1.9
    }
    for (const test of tests) {
      await makeTest(test.command, test.wantedMessage)()
    }
    // cleanup
    bot.chat(`/setblock 52 ${bot.test.groundY} 0 air`)

    function makeTest (inStr, outStr) {
      return () => bot.test.tellAndListen(name, inStr, makeListener(outStr))
    }
  })
}

function makeListener (wantedMessage) {
  return (message) => {
    if (!message.startsWith(wantedMessage)) {
      assert.fail(`Unexpected message: ${message}, wanted ${wantedMessage}`) // error
    }
    return true // stop listening
  }
}

describe('exampleInventory', function () {
  this.timeout(120000)
  const ctx = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => ctx.bot.test.resetState())

  it('exampleInventory', () => upstream()(ctx.bot))
})
