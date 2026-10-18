'use strict'
// owner: U6 (chat, commands & HUD) — lib/bedrock/text.js: Bedrock text → prismarine-chat ChatMessage
// (recorded BDS 1.26.51.1 `text` / `command_output` packets of the U0 capture + /tellraw rawtext seen on BDS)
const assert = require('assert')
const { createRegistry } = require('../../lib/registry')
const text = require('../../lib/bedrock/text')
const { afterSpawnRecords } = require('./helpers/fake')

const registry = createRegistry()
const ChatMessage = require('prismarine-chat')(registry)
const packet = (fields) => ({ needs_translation: false, category: 'message_only', xuid: '', platform_chat_id: '', has_filtered_message: false, ...fields })

describe('text.js: Bedrock text → ChatMessage (U6)', function () {
  it('contract: toChatMessage / fromRawText / fromFormattedString', () => {
    const chat = text.toChatMessage(registry, packet({ category: 'authored', type: 'chat', source_name: 'gary§r', message: 'hello' }))
    assert.strictEqual(chat.message.constructor.name, 'ChatMessage')
    assert.deepStrictEqual([chat.message.toString(), chat.position, chat.sender], ['<gary> hello', 'chat', 'gary'])
    assert.deepStrictEqual(chat.source, { kind: 'chat', username: 'gary', message: 'hello' })
    const raw = text.fromRawText(registry, '{"rawtext":[{"translate":"commands.give.successRecipient","with":{"rawtext":[{"text":"Diamond Pickaxe"},{"text":"1"}]}}]}\n')
    assert.deepStrictEqual([raw.toString(), raw.translate], ['You have been given Diamond Pickaxe * 1', 'commands.give.successRecipient'])
    const formatted = text.fromFormattedString(registry, '§eHello §lWorld')
    assert.deepStrictEqual([formatted.toString(), formatted.color, formatted.extra[0].bold], ['Hello World', 'yellow', true])
    // the parser is cached per registry
    assert.strictEqual(text.toChatMessage(registry, packet({ type: 'raw', message: 'x' })).message.toString(), 'x')
  })

  it('every recorded text packet → the string a Bedrock client shows, nothing untranslated', () => {
    const strs = afterSpawnRecords().filter(r => r.name === 'text').map(r => text.toChatMessage(registry, r.params))
    const all = strs.map(s => s.message.toString())
    assert.ok(all.includes('You have been given Oak Log * 16'), all.join(' | '))
    assert.ok(all.includes('[Server] hello from console'))
    assert.ok(all.includes('SmokeT3969 left the game'))
    assert.ok(all.includes('Your game mode has been updated to Creative'))
    assert.ok(all.includes('<U0Bot> hello from U0Bot'))
    assert.ok(all.every(s => !/[%§]/.test(s)), all.join(' | '))
  })

  it('positions: chat/whisper/announcement → chat, tellraw (json_whisper) / json / raw / system / translation → system, tip/popup → game_info', () => {
    const positions = {}
    for (const type of ['chat', 'whisper', 'announcement', 'json_whisper', 'json_announcement', 'json', 'raw', 'system', 'translation', 'tip', 'popup', 'jukebox_popup']) {
      positions[type] = text.toChatMessage(registry, packet({ type, source_name: 'a', message: type.startsWith('json') ? '{"rawtext":[{"text":"x"}]}' : 'x', parameters: [] })).position
    }
    assert.deepStrictEqual(positions, {
      chat: 'chat',
      whisper: 'chat',
      announcement: 'chat',
      json_whisper: 'system',
      json_announcement: 'system',
      json: 'system',
      raw: 'system',
      system: 'system',
      translation: 'system',
      tip: 'game_info',
      popup: 'game_info',
      jukebox_popup: 'game_info'
    })
  })

  it('player chat, whisper, /me (no sender), /say (announcement) as BDS 1.26.51.1 sends them', () => {
    const t = (fields) => text.toChatMessage(registry, packet({ category: 'authored', ...fields }))
    const whisper = t({ type: 'whisper', source_name: 'u6probe', message: 'hi me' })
    assert.deepStrictEqual([whisper.message.toString(), whisper.message.translate, whisper.sender], ['u6probe whispers to you: hi me', 'commands.message.display.incoming', 'u6probe'])
    assert.deepStrictEqual(whisper.source, { kind: 'whisper', username: 'u6probe', message: 'hi me' })
    const me = t({ type: 'chat', source_name: '', message: '* u6probe waves' })
    assert.deepStrictEqual([me.message.toString(), me.sender, me.source], ['* u6probe waves', null, null])
    const say = t({ type: 'announcement', source_name: 'u6probe', message: '[u6probe] hi all' })
    assert.deepStrictEqual([say.message.toString(), say.sender, say.source], ['[u6probe] hi all', 'u6probe', null])
    const spaced = t({ type: 'chat', source_name: 'Steve Builder§r', message: '§ahi §lthere' })
    assert.deepStrictEqual([spaced.message.toString(), spaced.source.username, spaced.source.message], ['<Steve Builder> hi there', 'Steve Builder', 'hi there'])
  })

  it('/tellraw rawtext: translate + with (array or rawtext), text with %key, selector, score, nested rawtext, literal %%s formats', () => {
    const r = (json) => text.fromRawText(registry, JSON.stringify(json))
    const chatType = r({ rawtext: [{ translate: 'chat.type.text', with: ['U9G', 'Hello World!'] }] })
    assert.deepStrictEqual([chatType.toString(), chatType.translate], ['<U9G> Hello World!', 'chat.type.text'])
    // what BDS forwards for that /tellraw (json_whisper, `with` re-encoded as rawtext)
    const forwarded = text.toChatMessage(registry, packet({ type: 'json_whisper', message: '{"rawtext":[{"translate":"chat.type.text","with":{"rawtext":[{"text":"U9G"},{"text":"Hello World!"}]}}]}\n' }))
    assert.deepStrictEqual([forwarded.message.toString(), forwarded.message.translate, forwarded.position], ['<U9G> Hello World!', 'chat.type.text', 'system'])
    assert.strictEqual(r({ rawtext: [{ text: 'a ' }, { text: '%entity.wither.name' }, { text: ' §cb' }] }).toString(), 'a Wither b')
    assert.strictEqual(r({ rawtext: [{ translate: 'Hello %%s and %%s', with: ['A', 'B'] }] }).toString(), 'Hello A and B')
    assert.strictEqual(r({ rawtext: [{ translate: '%%2 then %%1', with: ['A', 'B'] }] }).toString(), 'B then A')
    assert.strictEqual(r({ rawtext: [{ rawtext: [{ text: 'x' }, { text: 'y' }] }] }).toString(), 'xy')
    assert.strictEqual(r({ rawtext: [{ selector: '@p' }] }).toString(), '@p')
    assert.strictEqual(r({ rawtext: [{ score: { name: '@p', objective: 'kills' } }] }).toString(), '<score:@p:kills>')
    assert.strictEqual(text.fromRawText(registry, 'not json §aat all').toString(), 'not json at all')
  })

  it('§ codes with Bedrock semantics: material colours (§g…§v, §m/§n are colours), formats persist over colours, §r resets', () => {
    const json = text.formattedJson('§lBold §cred §mredstone§r plain §gcoin')
    assert.deepStrictEqual(json, {
      text: 'Bold ',
      bold: true,
      extra: [
        { text: 'red ', color: 'red' },
        { text: 'redstone', color: '#971607' },
        { text: ' plain ', bold: false }, // §r: back to the root's (default) colour
        { text: 'coin', color: '#DDD605', bold: false }
      ]
    })
    const msg = new ChatMessage(json)
    assert.strictEqual(msg.toString(), 'Bold red redstone plain coin')
    assert.strictEqual(msg.extra[1].strikethrough, undefined, '§m is not strikethrough on Bedrock')
    assert.deepStrictEqual(text.formattedJson('§eA§r B'), { text: 'A', color: 'yellow', extra: [{ text: ' B', color: 'reset' }] })
    assert.deepStrictEqual(text.formattedJson('no codes'), { text: 'no codes' })
    assert.deepStrictEqual(text.formattedJson('§a'), { text: '', color: 'green' })
    assert.deepStrictEqual(text.formattedJson('dangling §'), { text: 'dangling ' })
    assert.strictEqual(text.stripCodes('§aA§r§lB'), 'AB')
  })

  it('translation packets: leading style covers the whole message, %key parameters, keys without %', () => {
    const t = (message, parameters) => text.toChatMessage(registry, packet({ needs_translation: true, category: 'parameters', type: 'translation', message, parameters })).message
    const joined = t('§e%multiplayer.player.joined', ['Bob'])
    assert.deepStrictEqual([joined.toString(), joined.translate, joined.color], ['Bob joined the game', 'multiplayer.player.joined', 'yellow'])
    assert.strictEqual(t('%death.attack.generic', ['%entity.wither.name']).toString(), 'Wither died')
    assert.strictEqual(t('commands.weather.clear', []).toString(), 'Changing to clear weather')
    const popup = text.toChatMessage(registry, packet({ type: 'popup', message: '%entity.wither.name §7(boss)', parameters: [] }))
    assert.deepStrictEqual([popup.message.toString(), popup.position], ['Wither (boss)', 'game_info'])
  })

  it('command_output lines → one ChatMessage each, translate = message_id', () => {
    const parser = text.createTextParser(registry, ChatMessage)
    const lines = parser.parseCommandOutput({ output: [{ message_id: 'commands.message.display.outgoing', success: true, parameters: ['u6probe', 'hi me'] }, { message_id: 'commands.tellraw.error.notArray', success: false, parameters: [] }] })
    assert.deepStrictEqual(lines.map(l => [l.translate, l.toString()]), [
      ['commands.message.display.outgoing', 'You whisper to u6probe: hi me'],
      ['commands.tellraw.error.notArray', 'Rawtext object must contain an array. Example: "rawtext":[{..}]']
    ])
  })
})
