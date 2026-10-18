// owner: U4 (core runtime)
'use strict'
/**
 * Chat core against a real BDS 1.26.51.1 (Bedrock extra, U4): bot.chat round trip, another player's chat and
 * join message, the console `say`, '/' commands as command_request → command_output messages (translate keys the
 * upstream tests wait on: commands.time.set, commands.clear.success; commands.op.success needs a permission
 * level BDS players do not have — see docs/differences/U4.md#op-command — and is covered by test/unit/chat.test.js).
 */
const assert = require('assert')
const { useBot, createRawBot, inject } = require('./common')

function waitFor (emitter, event, predicate = () => true, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { emitter.removeListener(event, fn); reject(new Error(`timed out waiting for ${event}`)) }, timeout)
    function fn (...args) {
      if (!predicate(...args)) return
      clearTimeout(timer)
      emitter.removeListener(event, fn)
      resolve(args)
    }
    emitter.on(event, fn)
  })
}

describe('core: chat and command output (U4)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })

  it('bot.chat round trip: message + messagestr "<name> text" at position chat', async () => {
    const { bot } = env
    const message = waitFor(bot, 'message', (msg) => msg.toString().includes('hello from the core'))
    const messagestr = waitFor(bot, 'messagestr', (str) => str.includes('hello from the core'))
    bot.chat('hello from the core')
    const [msg, position, sender] = await message
    assert.strictEqual(msg.toString(), `<${bot.username}> hello from the core`)
    assert.strictEqual(msg.translate, 'chat.type.text')
    assert.strictEqual(position, 'chat')
    assert.strictEqual(sender, bot.player.uuid)
    const [str, strPosition, jsonMsg] = await messagestr
    assert.strictEqual(str, `<${bot.username}> hello from the core`)
    assert.strictEqual(strPosition, 'chat')
    assert.strictEqual(jsonMsg.toString(), str)
  })

  it('another player chatting and the console say', async () => {
    const { bot, server } = env
    const joined = waitFor(bot, 'message', (msg) => msg.translate === 'multiplayer.player.joined', 20000)
    const other = createRawBot({ host: server.host, port: server.port, username: 'talker' })
    try {
      const ctx = inject(other, server)
      await ctx.waitForSpawn()
      const [joinMsg, joinPosition] = await joined
      assert.strictEqual(joinMsg.toString(), 'talker joined the game')
      assert.strictEqual(joinMsg.with[0].toString(), 'talker')
      assert.strictEqual(joinPosition, 'system')
      const heard = waitFor(bot, 'messagestr', (str) => str === '<talker> hi core')
      ctx.chat('hi core')
      const [, position] = await heard
      assert.strictEqual(position, 'chat')
      const said = waitFor(bot, 'messagestr', (str) => str.includes('console here'))
      await server.command('say console here')
      const [str, pos] = await said
      assert.strictEqual(str, '[Server] console here')
      assert.strictEqual(pos, 'chat')
      // a failing command is a message too (BDS: players with the operator level may not run /op)
      const denied = waitFor(bot, 'message', (msg) => msg.translate === 'commands.generic.error.permissions')
      bot.chat('/op talker')
      const [msg] = await denied
      assert.strictEqual(msg.toString(), 'Incorrect permission level for command: op.')
    } finally {
      other.end('test done')
    }
  })

  it('"/" commands: command_request (no chat packet) → command_output message (commands.time.set, commands.clear.success)', async () => {
    const { bot } = env
    const sent = []
    const queue = bot._client.queue.bind(bot._client)
    bot._client.queue = (name, params) => { sent.push(name); return queue(name, params) }
    try {
      const timeSet = waitFor(bot, 'message', (msg) => msg.translate === 'commands.time.set')
      const timeStr = waitFor(bot, 'messagestr', (str) => /^Set the time to 1000$/.test(str))
      bot.chat('/time set 1000')
      const [msg, position] = await timeSet
      assert.strictEqual(position, 'system')
      assert.strictEqual(msg.with[0].toString(), '1000')
      await timeStr
      assert.ok(sent.includes('command_request') && !sent.includes('text'))

      await bot.test.give('dirt', 3)
      const cleared = waitFor(bot, 'message', (m) => m.translate === 'commands.clear.success')
      bot.chat('/clear')
      const [clear] = await cleared
      assert.match(clear.toString(), new RegExp(`^Cleared the inventory of ${bot.username}, removing 3 items$`))
      // correlated output for internal callers (U6, helpers)
      const out = await bot._bedrock.commands.request('/time set 2000')
      assert.strictEqual(out.success_count, 1)
      assert.strictEqual(out.output[0].message_id, 'commands.time.set')
    } finally {
      bot._client.queue = queue
    }
  })
})
