// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Port of mineflayer 4.39.0 test/externalTests/chat.js (MIT, Copyright (c) 2013 Andrew Kelley) against BDS 1.26.51.1.
 * Each test runs like upstream's runner: resetState, the bot says "### Starting chat <name>", then the test body.
 *
 * Adapted (docs/differences/U6.md#chat-tests): Bedrock's /tellraw takes rawtext (`{"rawtext":[…]}`; a Java
 * component is refused with commands.tellraw.error.notArray), and the Bedrock language has no `language.name`
 * ("test message event" translates `options.language` → "Language"). Everything else is verbatim, including the
 * "<flatbot> …" strings (the bot is named flatbot like upstream).
 * Bedrock extras: the default chat / whisper patterns on real player chat and /tell from a second player
 * (names come from the packet), actionBar, unmatchedMessage.
 */
const assert = require('assert')
const { once, onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { useBot, createRawBot, inject } = require('./common')

const tellraw = (json) => `/tellraw @p {"rawtext":[${JSON.stringify(json)}]}`

describe('chat', function () {
  this.timeout(120000)
  const env = useBot({ username: 'flatbot', server: { gamemode: 'creative' } })
  beforeEach(() => env.bot.test.resetState())

  /** upstream runner: `### Starting <test name>` then the test function */
  function addTest (name, f) {
    it(`chat ${name}`, async () => {
      const { bot } = env
      bot.test.sayEverywhere(`### Starting chat ${name}`)
      await f(bot)
    })
  }

  addTest('start tests', async (bot) => {
    await once(bot, 'message') // => <flatbot> starting chat test message event
  })

  addTest('test message event', async (bot) => {
    await bot.test.wait(500)
    // upstream: /tellraw @p {"translate":"language.name"} → 'English'
    bot.chat(tellraw({ translate: 'options.language' }))
    const [json] = await once(bot, 'message')
    const str = json.toString()
    assert.strictEqual(str, 'Language')
  })

  addTest('test chatAddPattern', async (bot) => {
    await once(bot, 'message') // => starting chat test chatAddPattern
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello World!'] }))
    const [username, message, translate, chatMessage] = await onceWithCleanup(bot, 'chat', {
      timeout: 20000,
      checkCondition: (username) => username === 'U9G'
    })
    assert.strictEqual(username, 'U9G')
    assert.strictEqual(message, 'Hello World!')
    assert.strictEqual(translate, 'chat.type.text')
    assert.strictEqual(chatMessage.constructor.name, 'ChatMessage')
  })

  addTest('test addChatPattern', async (bot) => {
    await once(bot, 'message') // => starting chat test chatAddPattern
    bot.addChatPattern('theTest', /<.+> Hello World!!!!/, { repeat: false })
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello World!!!!'] }))
    const [[match]] = await once(bot, 'chat:theTest')
    assert.strictEqual(match, '<U9G> Hello World!!!!')
  })

  addTest('test parse', async (bot) => {
    await once(bot, 'message') // => starting chat test chatAddPattern
    bot.addChatPattern('theTest', /<.+> Hello World(!!!!)/, { repeat: false, parse: true })
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello World!!!!'] }))
    const [[matches]] = await once(bot, 'chat:theTest')
    assert.strictEqual(matches[0], '!!!!')
  })

  addTest('test addChatPatterns', async (bot) => {
    await once(bot, 'message') // => starting chat test chatAddPattern
    bot.addChatPatternSet('theTest', [/<.+> Hello/, /<.+> World/], { repeat: false })
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello'] }))
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'World'] }))
    const [[partOne, partTwo]] = await once(bot, 'chat:theTest')
    assert.strictEqual(partOne, '<U9G> Hello')
    assert.strictEqual(partTwo, '<U9G> World')
  })

  addTest('test removeChatPattern', async (bot) => {
    await once(bot, 'message') // => starting chat test removeChatPattern
    bot.addChatPattern('test', /<.+> Hello/)
    bot.removeChatPattern('test')
    let triggered = false
    const listener = () => { triggered = true }
    bot.once('chat:test', listener)
    bot.chat(tellraw({ translate: 'chat.type.text', with: ['U9G', 'Hello'] }))
    await once(bot, 'message')
    assert.ok(triggered === false)
    bot.off('chat:test', listener)
  })

  addTest('test awaitMessage', async (bot) => {
    const p1 = bot.awaitMessage('<flatbot> hello')
    bot.chat('hello')
    await p1
    const p2 = bot.awaitMessage(['<flatbot> hello', '<flatbot> world'])
    bot.chat('world')
    await p2
    const p3 = bot.awaitMessage(/<.+> hello/)
    bot.chat('hello')
    await p3
    const p4 = bot.awaitMessage([/<.+> hello/, /<.+> world/])
    bot.chat('world')
    await p4
  })

  addTest('test removechatpattern with a number input', async (bot) => {
    const patternIndex = bot.addChatPattern('hello', /hello/)
    bot.chat('hello')
    await once(bot, 'chat:hello')
    bot.removeChatPattern(patternIndex)
    let listener
    await new Promise((resolve, reject) => {
      listener = (msg) => {
        console.log('reacting to msg: ')
        console.log(msg)
        reject(new Error("Hello event shouldn't work after removing it"))
      }
      bot.on('chat:hello', listener)
      bot.once('message', () => {
        // wait half a second to make sure we aren't going to react to the msg
        setTimeout(() => resolve(), 500)
      })
      bot.chat('hello')
    })
    bot.off('chat:hello', listener)
  })

  // ---- Bedrock extras ------------------------------------------------------------------------------------------

  it('chat / whisper events from a second player (default patterns read the sender from the packet); bot.whisper', async () => {
    const { bot, server } = env
    const other = createRawBot({ host: server.host, port: server.port, username: 'Steve Builder' })
    try {
      const ctx = inject(other, server)
      await ctx.waitForSpawn()
      const chat = onceWithCleanup(bot, 'chat', { timeout: 10000, checkCondition: (username) => username === 'Steve Builder' })
      ctx.chat('hi from a name with a space')
      const [username, message, translate, jsonMsg] = await chat
      assert.deepStrictEqual([username, message, translate, jsonMsg.toString()], ['Steve Builder', 'hi from a name with a space', 'chat.type.text', '<Steve Builder> hi from a name with a space'])

      const whisper = onceWithCleanup(bot, 'whisper', { timeout: 10000 })
      await ctx.botCommand(`/tell ${bot.username} psst`)
      const [from, secret, whisperTranslate] = await whisper
      assert.deepStrictEqual([from, secret, whisperTranslate], ['Steve Builder', 'psst', 'commands.message.display.incoming'])

      // bot.whisper → /tell "<name>" …: the other player receives a whisper packet
      const received = ctx.packet('text', (p) => p.type === 'whisper' && p.message === 'back at you', 10000)
      const confirmation = bot.awaitMessage('You whisper to Steve Builder: back at you', 10000)
      bot.whisper('Steve Builder', 'back at you')
      const packet = await received.promise
      assert.strictEqual(ctx.stripFormatting(packet.source_name), bot.username)
      await confirmation

      // the test helper uses the chat event like upstream
      other._client.on('text', (p) => {
        if (p.type === 'chat' && ctx.stripFormatting(p.source_name) === bot.username && p.message === 'ping') ctx.chat('pong')
      })
      const [helperFrom, helperMessage] = await bot.test.tellAndListen('Steve Builder', 'ping', (m) => m === 'pong')
      assert.deepStrictEqual([helperFrom, helperMessage], ['Steve Builder', 'pong'])
    } finally {
      other.end('test done')
    }
  })

  it('actionBar from /title actionbar and /titleraw actionbar; unmatchedMessage for a system message', async () => {
    const { bot } = env
    const bar = once(bot, 'actionBar', 10000)
    bot.chat('/title @s actionbar hello bar')
    const [msg, verified] = await bar
    assert.deepStrictEqual([msg.toString(), verified], ['hello bar', null])
    const raw = once(bot, 'actionBar', 10000)
    bot.chat('/titleraw @s actionbar {"rawtext":[{"translate":"entity.wither.name"}]}')
    assert.strictEqual((await raw)[0].toString(), 'Wither')
    const unmatched = onceWithCleanup(bot, 'unmatchedMessage', { timeout: 10000, checkCondition: (str) => str === 'Language' })
    bot.chat(tellraw({ translate: 'options.language' }))
    const [str, jsonMsg] = await unmatched
    assert.strictEqual(jsonMsg.translate, 'options.language')
    assert.strictEqual(str, 'Language')
  })
})
