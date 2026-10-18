// owner: W3-FIX-B (wave-3 fix-ups: inventory, entities, chat, world)
'use strict'
/**
 * Bedrock extra (W3-FIX-B), against a real BDS 1.26.51.1:
 * - /say (text type announcement) → the 'chat' event with the sender from the packet (a name with a space too) and
 *   translate 'chat.type.announcement', like Java's say_command chat type;
 * - bot.whisper('@p', …) sends the selector verbatim (a quoted "@p" matches no target);
 * - bot._bedrock.commands.request resolves for successful commands without any output (say, tellraw, and every
 *   command while the sendcommandfeedback gamerule is off) right after BDS's command_executed event.
 */
const assert = require('assert')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createRawBot, inject } = require('./common')

describe('chat › /say chat event, whisper selectors, commands without output (W3-FIX-B)', function () {
  this.timeout(120000)
  const env = useBot({ server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  it('/say → chat (sender from the packet, also with a space; translate chat.type.announcement)', async () => {
    const { bot, server } = env
    const own = onceWithCleanup(bot, 'chat', { timeout: 10000, checkCondition: (username, message) => message === 'hello from say' })
    bot.chat('/say hello from say')
    const [username, message, translate, jsonMsg] = await own
    assert.deepStrictEqual([username, message, translate, jsonMsg.toString()], [bot.username, 'hello from say', 'chat.type.announcement', `[${bot.username}] hello from say`])
    const other = createRawBot({ host: server.host, port: server.port, username: 'Say Sayer' })
    try {
      const ctx = inject(other, server)
      await ctx.waitForSpawn()
      const heard = onceWithCleanup(bot, 'chat', { timeout: 10000, checkCondition: (username) => username === 'Say Sayer' })
      // a raw command_request (/say has no command_output for the harness' botCommand to wait for)
      other._client.queue('command_request', { command: '/say hi all', origin: { type: 'player', uuid: require('crypto').randomUUID(), request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' })
      const [from, text, tr] = await heard
      assert.deepStrictEqual([from, text, tr], ['Say Sayer', 'hi all', 'chat.type.announcement'])
    } finally {
      other.end('test done')
    }
  })

  it('bot.whisper(\'@p\', …): the selector is sent verbatim and reaches the nearest player', async () => {
    const { bot } = env
    const sent = onceWithCleanup(bot, 'message', { timeout: 10000, checkCondition: (msg) => msg.translate === 'commands.message.display.outgoing' || msg.translate === 'commands.generic.noTargetMatch' })
    const whisper = onceWithCleanup(bot, 'whisper', { timeout: 10000 })
    bot.whisper('@p', 'to the nearest')
    const [msg] = await sent
    assert.strictEqual(msg.translate, 'commands.message.display.outgoing', msg.toString())
    const [from, text] = await whisper // @p from the bot is the bot itself
    assert.deepStrictEqual([from, text], [bot.username, 'to the nearest'])
  })

  it('commands.request: say / tellraw / feedback-off commands resolve with an empty output right away, failures with theirs', async () => {
    const { bot, server } = env
    const request = (command) => {
      const started = Date.now()
      return bot._bedrock.commands.request(command, { timeout: 8000 }).then(out => ({ out, ms: Date.now() - started }))
    }
    const say = await request('/say quiet please')
    assert.deepStrictEqual([say.out.output_type, say.out.success_count, say.out.output], ['none', 1, []])
    assert.ok(say.ms < 2000, `${say.ms} ms`)
    const tellraw = await request('/tellraw @a {"rawtext":[{"text":"raw"}]}')
    assert.deepStrictEqual(tellraw.out.output, [])
    const time = await request('/time set 1000')
    assert.strictEqual(time.out.output[0].message_id, 'commands.time.set', 'a command with output still gets it')
    const bad = await request('/nosuchcommand')
    assert.strictEqual(bad.out.success_count, 0)
    assert.strictEqual(bad.out.output[0].message_id, 'commands.generic.unknown')
    await server.commandOutput('gamerule sendcommandfeedback false')
    try {
      const silent = await request('/time set 2000')
      assert.deepStrictEqual([silent.out.output_type, silent.out.output], ['none', []])
      assert.ok(silent.ms < 2000, `${silent.ms} ms`)
      const many = await Promise.all(['/time set 3000', '/say a', '/time set 4000', '/me waves'].map(request))
      assert.ok(many.every(r => r.out.success_count === 1 && r.ms < 2000), JSON.stringify(many.map(r => r.ms)))
    } finally {
      await server.commandOutput('gamerule sendcommandfeedback true')
    }
  })
})
