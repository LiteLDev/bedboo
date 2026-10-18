'use strict'
// owner: U4 (core runtime) — chat core (lib/plugins/chat.js): bot.chat, message / messagestr from `text` and
// `command_output` packets (recorded BDS 1.26.51.1 packets + synthesized ones)
const assert = require('assert')
const { createFakeBot, replayJoin, afterSpawnRecords } = require('./helpers/fake')

function serialize (name, params) {
  const { createSerializer } = require('bedrock-protocol/src/transforms/serializer')
  return createSerializer('1.26.51').createPacketBuffer({ name, params })
}

async function joined () {
  const created = await createFakeBot()
  await replayJoin(created.bot, created.client)
  created.client.clearSent()
  created.messages = []
  created.bot.on('message', (msg, position, sender, verified) => created.messages.push({ msg, position, sender, verified }))
  created.strs = []
  created.bot.on('messagestr', (str, position, msg, sender) => created.strs.push({ str, position, msg, sender }))
  return created
}

const text = (fields) => ({ needs_translation: false, category: 'message_only', xuid: '', platform_chat_id: '', has_filtered_message: false, ...fields })

describe('chat core (U4 → U6)', function () {
  this.timeout(30000)

  it('internalTest › chat', async () => {
    // upstream: a player chat → 'chat' ('gary', 'hello') (U6: default chat patterns over messagestr) and the reply
    // bot.chat('hi') is a chat packet. Here: the message / messagestr part (U4) and the reply packet.
    const { bot, client, messages, strs } = await joined()
    client.receive('text', text({ category: 'authored', type: 'chat', source_name: 'gary', message: 'hello' }))
    assert.strictEqual(messages.length, 1)
    assert.strictEqual(messages[0].position, 'chat')
    assert.strictEqual(messages[0].msg.translate, 'chat.type.text')
    assert.strictEqual(messages[0].msg.toString(), '<gary> hello')
    assert.strictEqual(messages[0].verified, null)
    assert.deepStrictEqual([strs[0].str, strs[0].position], ['<gary> hello', 'chat'])
    assert.strictEqual(strs[0].msg, messages[0].msg)
    bot.chat('hi')
    const [packet] = client.sent('text')
    assert.deepStrictEqual(packet, {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: 'U0Bot',
      message: 'hi',
      xuid: '',
      platform_chat_id: '',
      has_filtered_message: false
    })
    assert.ok(serialize('text', packet).length > 0)
  })

  it('own chat echo from BDS (source_name with §r) and sender uuid of a known player', async () => {
    const { bot, client, messages } = await joined()
    client.receive('text', text({ category: 'authored', type: 'chat', source_name: 'U0Bot§r', message: 'hello from U0Bot' }))
    assert.strictEqual(messages[0].msg.toString(), '<U0Bot> hello from U0Bot')
    assert.strictEqual(messages[0].sender, bot.player.uuid)
  })

  it('every recorded text packet of the capture → message/messagestr with mineflayer positions and translations', async () => {
    const { client, strs } = await joined()
    for (const { name, params } of afterSpawnRecords()) if (name === 'text') client.receive('text', params)
    const by = (re) => strs.find(s => re.test(s.str))
    assert.ok(by(/^You have been given Diamond Pickaxe \* 1$/), 'json rawtext with translate + with.rawtext')
    assert.strictEqual(by(/^You have been given Diamond Pickaxe/).position, 'system')
    assert.strictEqual(by(/^You have been given Diamond Pickaxe/).msg.translate, 'commands.give.successRecipient')
    const left = by(/left the game$/)
    assert.strictEqual(left.str, 'SmokeT3969 left the game')
    assert.strictEqual(left.msg.translate, 'multiplayer.player.left')
    assert.strictEqual(left.msg.color, 'yellow')
    assert.strictEqual(left.position, 'system')
    const announcement = by(/^\[Server\] hello from console$/)
    assert.strictEqual(announcement.position, 'chat')
    assert.ok(by(/^Your game mode has been updated to Creative$/), 'a %key parameter is translated')
    assert.ok(by(/^You have been teleported to 0\.50, -57\.00, 0\.50$/))
    assert.ok(!strs.some(s => /%/.test(s.str)), 'no untranslated format left: ' + strs.map(s => s.str).join(' | '))
  })

  it('translation strings: leading style covers the whole message, parameters go to the first key', async () => {
    const { client, messages } = await joined()
    client.receive('text', text({ needs_translation: true, category: 'parameters', type: 'translation', message: '§e%multiplayer.player.joined (welcome)', parameters: ['Bob'] }))
    client.receive('text', text({ needs_translation: true, category: 'parameters', type: 'translation', message: '%multiplayer.player.joined / %multiplayer.player.left', parameters: ['Ann'] }))
    assert.strictEqual(messages[0].msg.toString(), 'Bob joined the game (welcome)')
    assert.strictEqual(messages[0].msg.color, 'yellow')
    assert.strictEqual(messages[1].msg.toString(), 'Ann joined the game /  left the game')
  })

  it('tip / popup → game_info, raw / system → system, whisper → chat', async () => {
    const { client, strs } = await joined()
    client.receive('text', text({ type: 'tip', message: '§aHello tip' }))
    client.receive('text', text({ type: 'popup', message: 'popup', parameters: [] }))
    client.receive('text', text({ type: 'raw', message: 'raw §lbold' }))
    client.receive('text', text({ type: 'system', message: 'system msg' }))
    client.receive('text', text({ category: 'authored', type: 'whisper', source_name: 'bob', message: 'psst' }))
    assert.deepStrictEqual(strs.map(s => [s.str, s.position]), [
      ['Hello tip', 'game_info'], ['popup', 'game_info'], ['raw bold', 'system'], ['system msg', 'system'], ['bob whispers to you: psst', 'chat']
    ])
  })

  it('command_output → message with the translate key (commands.time.set, commands.clear.success, commands.op.success)', async () => {
    const { client, messages, strs } = await joined()
    const recorded = afterSpawnRecords().find(r => r.name === 'command_output').params
    client.receive('command_output', recorded)
    client.receive('command_output', { ...recorded, output: [{ message_id: 'commands.clear.success', success: true, parameters: ['U0Bot', '3'] }] })
    client.receive('command_output', { ...recorded, output: [{ message_id: 'commands.op.success', success: true, parameters: ['bee'] }] })
    assert.deepStrictEqual(messages.map(m => [m.msg.translate, m.position]), [['commands.time.set', 'system'], ['commands.clear.success', 'system'], ['commands.op.success', 'system']])
    assert.deepStrictEqual(strs.map(s => s.str), ['Set the time to 1000', 'Cleared the inventory of U0Bot, removing 3 items', 'Opped: bee'])
  })

  it('bot.chat("/cmd") → command_request (version latest, player origin) correlated with its command_output', async () => {
    const { bot, client } = await joined()
    bot.chat('/time set 1000')
    const [request] = client.sent('command_request')
    assert.strictEqual(request.command, '/time set 1000')
    assert.strictEqual(request.version, 'latest')
    assert.strictEqual(request.internal, false)
    assert.strictEqual(request.origin.type, 'player')
    assert.strictEqual(request.origin.request_id, '')
    assert.strictEqual(request.origin.player_entity_id, 0n)
    assert.match(request.origin.uuid, /^[0-9a-f-]{36}$/)
    assert.ok(serialize('command_request', request).length > 0)
    assert.strictEqual(client.sent('text').length, 0, 'commands are never sent as chat')

    const pending = bot._bedrock.commands.request('/time set 2000')
    const second = client.sent('command_request')[1]
    client.receive('command_output', { origin: second.origin, output_type: 'alloutput', success_count: 1, output: [{ message_id: 'commands.time.set', success: true, parameters: ['2000'] }], has_data: false })
    const out = await pending
    assert.strictEqual(out.output[0].parameters[0], '2000')
    await assert.rejects(bot._bedrock.commands.request('/nothing', { timeout: 10 }), /timed out/)
  })

  it('commands.request: a successful command without output (say, tellraw, feedback off) resolves after its command_executed event', async () => {
    const { bot, client } = await joined()
    // BDS 1.26.51.1: event { command_executed, event_data: 08 02 00 <len> <name> 00 } for every successful command,
    // right before its command_output (same batch) when it has one; failed commands only get a command_output
    const executed = (name) => client.receive('event', { runtime_id: 8589934589n, event_type: 'command_executed', use_player_id: 1, event_data: Buffer.concat([Buffer.from([8, 2, 0, name.length]), Buffer.from(name), Buffer.from([0])]) })
    const output = (request, fields) => client.receive('command_output', { origin: request.origin, output_type: 'alloutput', success_count: 1, output: [], has_data: false, ...fields })
    const sent = () => client.sent('command_request')
    const t0 = Date.now()
    const say = bot._bedrock.commands.request('/say hi', { timeout: 5000 })
    const time = bot._bedrock.commands.request('/time set 5', { timeout: 5000 })
    const bad = bot._bedrock.commands.request('/nosuchcmd', { timeout: 5000 })
    const [sayReq, timeReq, badReq] = sent()
    executed('say') // /say: the event only
    executed('time') // /time: event, then its output
    output(timeReq, { output: [{ message_id: 'commands.time.set', success: true, parameters: ['5'] }] })
    output(badReq, { success_count: 0, output: [{ message_id: 'commands.generic.unknown', success: false, parameters: ['nosuchcmd'] }] })
    const [sayOut, timeOut, badOut] = await Promise.all([say, time, bad])
    assert.ok(Date.now() - t0 < 1000, 'well before the timeout')
    assert.deepStrictEqual([sayOut.output_type, sayOut.success_count, sayOut.output, sayOut.origin.uuid], ['none', 1, [], sayReq.origin.uuid])
    assert.strictEqual(timeOut.output[0].message_id, 'commands.time.set')
    assert.strictEqual(badOut.success_count, 0)
    // events are matched by command name, oldest request first
    const a = bot._bedrock.commands.request('/tellraw @a {"rawtext":[{"text":"x"}]}', { timeout: 5000 })
    const b = bot._bedrock.commands.request('/me waves', { timeout: 5000 })
    executed('me')
    executed('tellraw')
    assert.strictEqual((await b).output_type, 'none')
    assert.strictEqual((await a).output_type, 'none')
    // an output that arrives before its event (not seen on BDS) does not make the next request of that name resolve
    const c1 = bot._bedrock.commands.request('/time set 1', { timeout: 5000 })
    const c2 = bot._bedrock.commands.request('/time set 2', { timeout: 5000 })
    const [, , , , , c1Req, c2Req] = sent()
    output(c1Req, { output: [{ message_id: 'commands.time.set', success: true, parameters: ['1'] }] })
    executed('time') // c1's late event
    await new Promise(resolve => setTimeout(resolve, 250))
    executed('time')
    output(c2Req, { output: [{ message_id: 'commands.time.set', success: true, parameters: ['2'] }] })
    assert.deepStrictEqual([(await c1).output[0].parameters, (await c2).output[0].parameters], [['1'], ['2']])
  })

  it('bot.whisper: selectors verbatim (/tell @p …), player names quoted when needed', async () => {
    const { bot, client } = await joined()
    bot.whisper('@p', 'hi')
    bot.whisper('@a[r=5]', 'all')
    bot.whisper('Steve Builder', 'yo')
    bot.whisper('gary', 'hey')
    assert.deepStrictEqual(client.sent('command_request').map(r => r.command), ['/tell @p hi', '/tell @a[r=5] all', '/tell "Steve Builder" yo', '/tell gary hey'])
  })

  it('bot.chat splits like upstream (chatLengthLimit, newlines), accepts numbers, rejects other types', async () => {
    const { bot, client } = await joined()
    bot.chat('a'.repeat(300))
    bot.chat('line1\nline2\n\nline3')
    bot.chat(42)
    assert.deepStrictEqual(client.sent('text').map(p => p.message.length === 256 || p.message.length === 44 ? p.message.length : p.message), [256, 44, 'line1', 'line2', 'line3', '42'])
    assert.throws(() => bot.chat({}), /Chat message type must be a string or number/)
    const { bot: small, client: smallClient } = await createFakeBot({ chatLengthLimit: 10 })
    small.chat('x'.repeat(25))
    assert.deepStrictEqual(smallClient.sent('text').map(p => p.message.length), [10, 10, 5])
  })
})
