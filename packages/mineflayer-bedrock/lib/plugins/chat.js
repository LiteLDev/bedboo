// owner: U4 (wave 2, core: bot.chat, message/messagestr) → U6 (wave 3, everything else)
// Upstream: mineflayer 4.39.0 lib/plugins/chat.js (MIT, Copyright (c) 2013 Andrew Kelley) — chatWithHeader
//   splitting kept verbatim.
// Surface: bot.chat(message), bot.whisper(username, message), bot.chatAddPattern(pattern, type),
//   bot.addChatPattern(name, pattern, opts), bot.addChatPatternSet(name, patterns, opts),
//   bot.removeChatPattern(name), bot.awaitMessage(...args) → Promise<string>,
//   bot.tabComplete(text, assumeCommand, sendBlockInSight, timeout) → Promise<string[]>
//   options: chatLengthLimit, defaultChatPatterns
// Events: 'message' (jsonMsg, position, sender, verified), 'messagestr' (str, position, jsonMsg, sender, verified),
//   'chat' / 'whisper' (username, message, translate, jsonMsg, matches), 'actionBar' (jsonMsg),
//   'chat:<name>' (matches), 'unmatchedMessage'
//
// U4 core (this file, wave 2):
// - bot.chat(msg): '/'-prefixed → command_request { command, origin: { type: 'player', uuid: <fresh uuid>,
//   request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' }; BDS echoes the origin uuid in
//   command_output, which correlates the answer (`bot._bedrock.commands`). Anything else → a `text` chat packet
//   { type: 'chat', category: 'authored', source_name: <username>, … }, split at chatLengthLimit like upstream.
// - incoming `text` packets → prismarine-chat ChatMessage (parseText below) → 'message' + 'messagestr' with
//   mineflayer positions: chat / whisper / announcement / json_whisper / json_announcement → 'chat';
//   raw / system / translation / json → 'system'; tip / popup / jukebox_popup → 'game_info'.
//   Player chat is rendered like Java's vanilla chat ({ translate: 'chat.type.text', with: [name, message] } →
//   "<name> message"); translation keys (`%key` in Bedrock strings, rawtext `translate`) are resolved through
//   registry.language (formats normalized by lib/registry.js).
// - command_output → one 'message'/'messagestr' (position 'system') per output line: { translate: message_id,
//   with: parameters } (e.g. commands.time.set, commands.clear.success, commands.op.success).
//
// For U6 (wave 3): the text → ChatMessage conversion lives in `createTextParser()` below; move it to
//   lib/bedrock/text.js (toChatMessage / fromRawText / fromFormattedString) and keep `emitMessage()` as the single
//   place that emits 'message'/'messagestr' (add patterns, actionBar, whisper, unmatchedMessage around it).
//   Internal hooks: `bot._bedrock.chat = { emitMessage, chatWithHeader, send, parser }`,
//   `bot._bedrock.commands = { request(command, { timeout }) → Promise<command_output params>, pending }`.
'use strict'
const crypto = require('crypto')
const { stubSync, stubAsync } = require('../bedrock/errors')

module.exports = inject

const POSITIONS = {
  chat: 'chat',
  whisper: 'chat',
  announcement: 'chat',
  json_whisper: 'chat',
  json_announcement: 'chat',
  raw: 'system',
  system: 'system',
  translation: 'system',
  json: 'system',
  tip: 'game_info',
  popup: 'game_info',
  jukebox_popup: 'game_info'
}

const COMMAND_TIMEOUT_MS = 10000

/**
 * Bedrock text → prismarine-chat ChatMessage (U4 core; U6 moves this to lib/bedrock/text.js).
 * @param {object} registry the bot registry (language normalized by lib/registry.js)
 * @param {Function} ChatMessage prismarine-chat class for the registry
 */
function createTextParser (registry, ChatMessage) {
  const language = registry.language ?? {}
  const KEY_RE = /%([A-Za-z][\w.-]*[\w])/g

  /** `§`-formatted string → chat component JSON */
  function formatted (str) {
    str = String(str ?? '')
    if (str === '') return { text: '' }
    return new ChatMessage(str).json
  }

  /** a string that is exactly one translation key reference ('%key') → { translate } component, else formatted text */
  function parameter (str) {
    str = String(str ?? '')
    const m = /^%([A-Za-z][\w.-]*)$/.exec(str)
    if (m && Object.hasOwn(language, m[1])) return { translate: m[1] }
    return formatted(str)
  }

  /** the style (color, bold, …) of leading § codes, as component fields */
  function leadingStyle (codes) {
    if (!codes) return {}
    const style = { ...formatted(codes + 'x') }
    delete style.text
    delete style.extra
    return style
  }

  /**
   * Bedrock string with embedded `%key` references (+ § codes) → component. A message that is a single key
   * (after leading § codes) becomes { translate, with, ...style } so `msg.translate` is the key, like Java.
   * Otherwise the leading § style applies to the whole message, text between keys keeps its own codes, and the
   * parameters go to the first key (Bedrock messages carry one parameter list).
   */
  function translated (message, parameters = []) {
    message = String(message ?? '')
    const withArgs = parameters.map(parameter)
    const lead = /^((?:§.)*)(.*)$/s.exec(message)
    const style = leadingStyle(lead[1])
    const body = lead[2]
    const single = /^%([A-Za-z][\w.-]*[\w])$/.exec(body)
    if (single && Object.hasOwn(language, single[1])) return { ...style, translate: single[1], with: withArgs }
    if (Object.hasOwn(language, message)) return { translate: message, with: withArgs }
    const extra = []
    let last = 0
    let first = true
    for (const m of body.matchAll(KEY_RE)) {
      if (!Object.hasOwn(language, m[1])) continue
      if (m.index > last) extra.push(formatted(body.slice(last, m.index)))
      extra.push({ translate: m[1], with: first ? withArgs : [] })
      first = false
      last = m.index + m[0].length
    }
    if (!extra.length) return formatted(message)
    if (last < body.length) extra.push(formatted(body.slice(last)))
    return { ...style, text: '', extra }
  }

  /** Bedrock rawtext ({ rawtext: [...] }) → component */
  function rawText (json) {
    if (typeof json === 'string') {
      try {
        json = JSON.parse(json)
      } catch {
        return formatted(json)
      }
    }
    const parts = (json?.rawtext ?? []).map(rawPart)
    if (parts.length === 1) return parts[0]
    return { text: '', extra: parts }
  }
  function rawPart (part) {
    if (part === null || typeof part !== 'object') return formatted(part)
    if (part.rawtext) return rawText(part)
    if (part.translate !== undefined) {
      let withArgs = []
      if (Array.isArray(part.with)) withArgs = part.with.map(parameter)
      else if (part.with?.rawtext) withArgs = part.with.rawtext.map(rawPart)
      return { translate: part.translate, with: withArgs }
    }
    if (part.selector !== undefined) return { selector: part.selector }
    if (part.score !== undefined) return { score: { name: part.score.name, objective: part.score.objective } }
    if (part.text !== undefined) return parameter(part.text)
    return { text: '' }
  }

  /**
   * @param {object} packet bedrock-protocol `text` params
   * @returns {{ message: ChatMessage, position: string, sender: string|null, username: string|null }}
   */
  function parseText (packet) {
    const type = packet.type
    let json
    let username = null
    switch (type) {
      case 'chat':
        username = stripCodes(packet.source_name)
        json = { translate: 'chat.type.text', with: [formatted(packet.source_name), messageComponent(packet)] }
        break
      case 'whisper':
        username = stripCodes(packet.source_name)
        json = { translate: 'commands.message.display.incoming', with: [formatted(packet.source_name), messageComponent(packet)] }
        break
      case 'json':
      case 'json_whisper':
      case 'json_announcement':
        json = rawText(packet.message)
        break
      case 'translation':
      case 'popup':
      case 'jukebox_popup':
        json = translated(packet.message, packet.parameters ?? [])
        break
      default: // raw, system, tip, announcement
        json = messageComponent(packet)
    }
    return { message: new ChatMessage(json), position: POSITIONS[type] ?? 'system', username }
  }

  function messageComponent (packet) {
    return packet.needs_translation ? translated(packet.message, packet.parameters ?? []) : formatted(packet.message)
  }

  /** command_output → one ChatMessage per output line */
  function parseCommandOutput (packet) {
    return (packet.output ?? []).map(line => new ChatMessage({ translate: line.message_id, with: (line.parameters ?? []).map(parameter) }))
  }

  return { parseText, parseCommandOutput, rawText, translated, formatted }
}

function stripCodes (str) {
  return String(str ?? '').replace(/§./g, '')
}

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  const ChatMessage = require('prismarine-chat')(bot.registry)
  const text = createTextParser(bot.registry, ChatMessage)

  /** the single emitter of 'message' / 'messagestr' (U6 adds patterns, actionBar, … around it) */
  function emitMessage (message, position, sender = null, verified = null) {
    bot.emit('message', message, position, sender, verified)
    bot.emit('messagestr', message.toString(), position, message, sender, verified)
  }

  function senderUuid (username) {
    if (!username) return null
    return bot.players?.[username]?.uuid ?? null
  }

  bot._client.on('text', (packet) => {
    let parsed
    try {
      parsed = text.parseText(packet)
    } catch (err) {
      bot.emit('error', err)
      return
    }
    emitMessage(parsed.message, parsed.position, senderUuid(parsed.username))
  })

  // command_request / command_output correlation (origin uuid echoed by BDS)
  const pendingCommands = new Map()
  bot._client.on('command_output', (packet) => {
    for (const message of text.parseCommandOutput(packet)) emitMessage(message, 'system')
    const uuid = packet.origin?.uuid
    const pending = uuid && pendingCommands.get(uuid)
    if (pending) {
      pendingCommands.delete(uuid)
      clearTimeout(pending.timer)
      pending.resolve(packet)
    }
  })
  bot.on('end', () => {
    for (const { reject, timer } of pendingCommands.values()) {
      clearTimeout(timer)
      reject(new Error('bot ended before the command output arrived'))
    }
    pendingCommands.clear()
  })

  /**
   * Run a command as the player (command_request) and resolve with its command_output params.
   * `bot._bedrock.commands.request('/time set 1000')`
   */
  function requestCommand (command, { timeout = COMMAND_TIMEOUT_MS } = {}) {
    const uuid = crypto.randomUUID()
    const promise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingCommands.delete(uuid)
        reject(new Error(`timed out after ${timeout} ms waiting for the output of ${command}`))
      }, timeout)
      timer.unref?.()
      pendingCommands.set(uuid, { resolve, reject, timer })
    })
    bot._client.queue('command_request', {
      command: command.startsWith('/') ? command : `/${command}`,
      origin: { type: 'player', uuid, request_id: '', player_entity_id: 0n },
      internal: false,
      version: 'latest'
    })
    return promise
  }
  if (bot._bedrock) bot._bedrock.commands = { request: requestCommand, pending: pendingCommands }

  function send (message) {
    if (message.startsWith('/')) {
      requestCommand(message).catch(() => {}) // fire and forget, like upstream; output arrives as 'message'
      return
    }
    bot._client.queue('text', {
      needs_translation: false,
      category: 'authored',
      type: 'chat',
      source_name: bot.username ?? bot._client.username ?? '',
      message,
      xuid: bot._client.profile?.xuid ? String(bot._client.profile.xuid) : '',
      platform_chat_id: '',
      has_filtered_message: false
    })
  }

  function chatWithHeader (header, message) {
    if (typeof message === 'number') message = message.toString()
    if (typeof message !== 'string') {
      throw new Error('Chat message type must be a string or number: ' + typeof message)
    }

    if (!header && message.startsWith('/')) {
      // Do not try and split a command without a header
      send(message)
      return
    }

    const lengthLimit = CHAT_LENGTH_LIMIT - header.length
    message.split('\n').forEach((subMessage) => {
      if (!subMessage) return
      let i
      let smallMsg
      for (i = 0; i < subMessage.length; i += lengthLimit) {
        smallMsg = header + subMessage.substring(i, i + lengthLimit)
        send(smallMsg)
      }
    })
  }

  bot.chat = (message) => {
    chatWithHeader('', message)
  }

  // internal hooks for U6 (wave 3)
  if (bot._bedrock) bot._bedrock.chat = { emitMessage, chatWithHeader, send, parser: text }

  bot.whisper = stubSync('U6', 'bot.whisper', 2)
  bot.chatAddPattern = stubSync('U6', 'bot.chatAddPattern', 2)
  bot.addChatPattern = stubSync('U6', 'bot.addChatPattern', 2)
  bot.addChatPatternSet = stubSync('U6', 'bot.addChatPatternSet', 2)
  bot.removeChatPattern = stubSync('U6', 'bot.removeChatPattern', 1)
  bot.awaitMessage = stubAsync('U6', 'bot.awaitMessage', 0)
  bot.tabComplete = stubAsync('U6', 'bot.tabComplete', 1)
}

module.exports.createTextParser = createTextParser
