'use strict'
// owner: U6 (chat, commands & HUD) — tablist: Bedrock has no tab-list header/footer (docs/differences/U6.md)
const assert = require('assert')
const { createFakeBot, replayJoin } = require('./helpers/fake')

describe('tablist (U6)', function () {
  this.timeout(30000)

  it('internalTest › tablist', async () => {
    // upstream: playerlist_header with newlines → bot.tablist.header/footer. Bedrock (protocol 2193) has no such
    // packet: header and footer are empty ChatMessages before and after the whole recorded join (player_list included).
    const { bot, client } = await createFakeBot()
    assert.deepStrictEqual([bot.tablist.header.toString(), bot.tablist.footer.toString()], ['', ''])
    assert.strictEqual(bot.tablist.header.constructor.name, 'ChatMessage')
    await replayJoin(bot, client)
    assert.deepStrictEqual([bot.tablist.header.toString(), bot.tablist.footer.toString()], ['', ''])
    const protocol = require('minecraft-data')('bedrock_1.26.51').protocol.types
    assert.ok(!Object.keys(protocol).some(name => /playerlist_header|tab_list|player_list_header/.test(name)), 'no header/footer packet on Bedrock')
  })
})
