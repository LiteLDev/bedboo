'use strict'
// owner: U6 (chat, commands & HUD) — lib/plugins/chat.js beyond U4's core: chat patterns (upstream semantics),
// the default chat / whisper patterns on Bedrock packets, awaitMessage, actionBar, whisper, unmatchedMessage.
const assert = require('assert')
const { once } = require('mineflayer/lib/promise_utils')
const { createFakeBot, replayJoin } = require('./helpers/fake')

const text = (fields) => ({ needs_translation: false, category: 'message_only', xuid: '', platform_chat_id: '', has_filtered_message: false, ...fields })
const chat = (source, message) => text({ category: 'authored', type: 'chat', source_name: source, message })
const tellraw = (json) => text({ type: 'json_whisper', message: JSON.stringify({ rawtext: [json] }) + '\n' })

async function joined (options) {
  const created = await createFakeBot(options)
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  return created
}

/** collect every emission of `event` */
function record (bot, event) {
  const calls = []
  bot.on(event, (...args) => calls.push(args))
  return calls
}

describe('chat plugin: patterns, chat/whisper events, awaitMessage, actionBar (U6)', function () {
  this.timeout(30000)

  it('internalTest › chat', async () => {
    // upstream: a player chat → 'chat' ('gary', 'hello'); the reply bot.chat('hi') is a chat packet
    const { bot, client } = await joined()
    const heard = once(bot, 'chat')
    client.receive('text', chat('gary', 'hello'))
    const [username, message, translate, jsonMsg] = await heard
    assert.deepStrictEqual([username, message, translate], ['gary', 'hello', 'chat.type.text'])
    assert.strictEqual(jsonMsg.toString(), '<gary> hello')
    bot.chat('hi')
    assert.strictEqual(client.sent('text')[0].message, 'hi')
  })

  it('default patterns: chat / whisper take username and message from the packet (spaces, formatting); others go through the regexes', async () => {
    const { bot, client } = await joined()
    const chats = record(bot, 'chat')
    const whispers = record(bot, 'whisper')
    client.receive('text', chat('Steve Builder§r', '§ahello there'))
    client.receive('text', text({ category: 'authored', type: 'whisper', source_name: 'bob', message: 'psst' }))
    client.receive('text', tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello World!'] })) // regex
    client.receive('text', text({ category: 'authored', type: 'announcement', source_name: 'Server', message: '[Server] hi all' })) // regex, like Java /say
    client.receive('text', chat('', '* bob waves')) // /me: no sender, no match
    assert.deepStrictEqual(chats.map(c => c.slice(0, 3)), [
      ['Steve Builder', 'hello there', 'chat.type.text'],
      ['U9G', 'Hello World!', 'chat.type.text'],
      ['Server', 'hi all', undefined]
    ])
    assert.strictEqual(chats[0][3].toString(), '<Steve Builder> hello there')
    assert.strictEqual(chats[0].length, 4, 'deprecated patterns emit (username, message, translate, jsonMsg)')
    assert.deepStrictEqual(whispers.map(w => w.slice(0, 3)), [['bob', 'psst', 'commands.message.display.incoming']], 'only one whisper event per whisper packet')
  })

  it('defaultChatPatterns: false → no chat / whisper events; removeChatPattern(\'chat\') removes the default one', async () => {
    const { bot, client } = await joined({ defaultChatPatterns: false })
    const chats = record(bot, 'chat')
    client.receive('text', chat('gary', 'hello'))
    assert.strictEqual(chats.length, 0)
    const other = await joined()
    const chats2 = record(other.bot, 'chat')
    const whispers2 = record(other.bot, 'whisper')
    other.bot.removeChatPattern('chat')
    other.client.receive('text', chat('gary', 'hello'))
    other.client.receive('text', text({ category: 'authored', type: 'whisper', source_name: 'bob', message: 'psst' }))
    assert.deepStrictEqual([chats2.length, whispers2.length], [0, 1])
  })

  it('addChatPattern (repeat, parse), addChatPatternSet, chatAddPattern (deprecated) — upstream semantics and return values', async () => {
    const { bot, client } = await joined()
    const say = (str) => client.receive('text', tellraw({ translate: 'chat.type.text', with: ['U9G', str] }))
    assert.throws(() => bot.addChatPattern('x', 'not a regexp'), /Pattern parameter should be of type RegExp/)
    assert.throws(() => bot.addChatPatternSet('x', [/a/, 'b']), /Pattern parameter should be of type RegExp/)

    const once1 = bot.addChatPattern('theTest', /<.+> Hello World!!!!/, { repeat: false })
    assert.strictEqual(once1, 3, 'after the three default patterns')
    const theTest = record(bot, 'chat:theTest')
    say('Hello World!!!!')
    say('Hello World!!!!')
    assert.deepStrictEqual(theTest, [[['<U9G> Hello World!!!!']]], 'repeat: false → removed after the first match')

    bot.addChatPattern('parsed', /<.+> Hello World(!!!!)/, { repeat: false, parse: true })
    const parsed = record(bot, 'chat:parsed')
    say('Hello World!!!!')
    assert.deepStrictEqual(parsed, [[[['!!!!']]]])

    const setIndex = bot.addChatPatternSet('set', [/<.+> Hello/, /<.+> World/], { repeat: false })
    assert.strictEqual(setIndex, 6, 'addChatPatternSet returns the length (upstream)')
    const set = record(bot, 'chat:set')
    say('Hello')
    say('World')
    assert.deepStrictEqual(set, [[['<U9G> Hello', '<U9G> World']]])

    bot.chatAddPattern(/^\[(\w+)\] (.*)$/, 'announce')
    const announce = record(bot, 'announce')
    client.receive('text', text({ category: 'authored', type: 'announcement', source_name: 'Server', message: '[Server] boot' }))
    assert.deepStrictEqual(announce.map(a => a.slice(0, 3)), [['Server', 'boot', undefined]])
  })

  it('removeChatPattern by name and by number', async () => {
    const { bot, client } = await joined()
    const say = (str) => client.receive('text', chat('U9G', str))
    bot.addChatPattern('test', /<.+> Hello/)
    bot.addChatPattern('test', /<.+> Hello again/)
    bot.removeChatPattern('test')
    const byName = record(bot, 'chat:test')
    say('Hello')
    assert.strictEqual(byName.length, 0)
    const index = bot.addChatPattern('hello', /hello/)
    const byNumber = record(bot, 'chat:hello')
    say('hello')
    bot.removeChatPattern(index)
    say('hello')
    assert.strictEqual(byNumber.length, 1)
  })

  it('unmatchedMessage (str, jsonMsg) for messages no pattern matched', async () => {
    const { bot, client } = await joined()
    const unmatched = record(bot, 'unmatchedMessage')
    client.receive('text', chat('gary', 'hello')) // matched by the default chat pattern
    client.receive('text', text({ type: 'raw', message: 'just a system line' }))
    assert.deepStrictEqual(unmatched.map(u => u[0]), ['just a system line'])
    assert.strictEqual(unmatched[0][1].toString(), 'just a system line')
  })

  it('awaitMessage: string, array, RegExp, mixed; rejects after the timeout', async () => {
    const { bot, client } = await joined()
    const say = (str) => setImmediate(() => client.receive('text', chat('flatbot', str)))
    let p = bot.awaitMessage('<flatbot> hello')
    say('hello')
    assert.strictEqual(await p, '<flatbot> hello')
    p = bot.awaitMessage(['<flatbot> hello', '<flatbot> world'])
    say('world')
    assert.strictEqual(await p, '<flatbot> world')
    p = bot.awaitMessage(/<.+> hello/)
    say('hello')
    await p
    p = bot.awaitMessage([/<.+> hello/, /<.+> world/])
    say('world')
    await p
    await assert.rejects(bot.awaitMessage('never', 20), /Timeout waiting for message after 20ms/)
    assert.strictEqual(bot.listenerCount('messagestr') > 0, true)
  })

  it('actionBar (jsonMsg, null): tip / popup text and set_title action bar messages, also as message at game_info', async () => {
    const { bot, client } = await joined()
    const bars = record(bot, 'actionBar')
    const messages = record(bot, 'message')
    client.receive('text', text({ type: 'tip', message: '§aHello tip' }))
    client.receive('text', text({ type: 'popup', message: '%entity.wither.name', parameters: [] }))
    client.receive('set_title', { type: 'action_bar_message', text: 'hello bar', fade_in_time: -1, stay_time: -1, fade_out_time: -1, xuid: '', platform_online_id: '', filtered_message: '' })
    client.receive('set_title', { type: 'action_bar_message_json', text: '{"rawtext":[{"translate":"entity.wither.name"}]}\n', fade_in_time: -1, stay_time: -1, fade_out_time: -1, xuid: '', platform_online_id: '', filtered_message: '' })
    client.receive('set_title', { type: 'set_title', text: 'not an action bar', fade_in_time: -1, stay_time: -1, fade_out_time: -1, xuid: '', platform_online_id: '', filtered_message: '' })
    assert.deepStrictEqual(bars.map(([msg, verified]) => [msg.toString(), verified]), [['Hello tip', null], ['Wither', null], ['hello bar', null], ['Wither', null]])
    assert.deepStrictEqual(messages.map(([msg, position]) => [msg.toString(), position]), [['Hello tip', 'game_info'], ['Wither', 'game_info'], ['hello bar', 'game_info'], ['Wither', 'game_info']])
  })

  it('whisper(username, message) → /tell command requests, split like upstream; names with spaces are quoted', async () => {
    const { bot, client } = await joined({ chatLengthLimit: 30 })
    bot.whisper('bob', 'hi')
    bot.whisper('Steve Builder', 'hello')
    bot.whisper('bob', 'x'.repeat(40)) // header '/tell bob ' (10) → 20-character chunks
    assert.deepStrictEqual(client.sent('command_request').map(r => r.command), [
      '/tell bob hi',
      '/tell "Steve Builder" hello',
      '/tell bob ' + 'x'.repeat(20),
      '/tell bob ' + 'x'.repeat(20)
    ])
    assert.strictEqual(client.sent('text').length, 0)
    assert.throws(() => bot.whisper('a'.repeat(30), 'hi'), /longer than chatLengthLimit/, 'no endless loop')
  })
})
