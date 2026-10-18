// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Bedrock extra (mineflayer has only the internal tablist test): Bedrock has no tab-list header/footer, so
 * bot.tablist.header / footer stay empty ChatMessages while players join and leave (docs/differences/U6.md#no-tablist-header).
 */
const assert = require('assert')
const { useBot, createRawBot, inject } = require('./common')

describe('tablist', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  it('tablist header and footer stay empty ChatMessages (no header/footer on Bedrock)', async () => {
    const { bot, server } = env
    assert.deepStrictEqual([bot.tablist.header.toString(), bot.tablist.footer.toString()], ['', ''])
    const packets = new Set()
    const onPacket = ({ data }) => packets.add(data.name)
    bot._client.on('packet', onPacket)
    const other = createRawBot({ host: server.host, port: server.port, username: 'tabmate' })
    try {
      const ctx = inject(other, server)
      await ctx.waitForSpawn()
      await bot.test.wait(1000)
    } finally {
      other.end('test done')
    }
    await bot.test.wait(1000)
    bot._client.off('packet', onPacket)
    assert.ok(packets.has('player_list'), 'the player list changed')
    assert.deepStrictEqual([bot.tablist.header.toString(), bot.tablist.footer.toString()], ['', ''])
    assert.strictEqual(bot.tablist.header.constructor.name, 'ChatMessage')
  })
})
