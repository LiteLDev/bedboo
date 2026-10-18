// owner: U4 (wave 2, core: bot.chat, message/messagestr) → U6 (wave 3, everything else)
// Adapted from mineflayer 4.39.0 lib/plugins/chat.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): chat patterns (addChatPattern / addChatPatternSet /
// removeChatPattern / chatAddPattern, the messagestr matcher and the default patterns), chatWithHeader splitting,
// whisper and awaitMessage are kept verbatim; the transport is Bedrock.
// Surface: bot.chat(message), bot.whisper(username, message), bot.chatAddPattern(pattern, type),
//   bot.addChatPattern(name, pattern, opts), bot.addChatPatternSet(name, patterns, opts),
//   bot.removeChatPattern(name), bot.awaitMessage(...args) → Promise<string>,
//   bot.tabComplete(text, assumeCommand, sendBlockInSight, timeout) → Promise<{ match, tooltip }[]>
//   options: chatLengthLimit, defaultChatPatterns
// Events: 'message' (jsonMsg, position, sender, verified), 'messagestr' (str, position, jsonMsg, sender, verified),
//   'chat' / 'whisper' (username, message, translate, jsonMsg), 'actionBar' (jsonMsg, verified),
//   'chat:<name>' (matches), 'unmatchedMessage' (str, jsonMsg)
//
// Bedrock (docs/differences/U6.md):
// - bot.chat(msg): '/'-prefixed → command_request { command, origin: { type: 'player', uuid: <fresh uuid>,
//   request_id: '', player_entity_id: 0n }, internal: false, version: 'latest' }; BDS echoes the origin uuid in
//   command_output, which correlates the answer (`bot._bedrock.commands`). Anything else → a `text` chat packet
//   { type: 'chat', category: 'authored', source_name: <username>, … }, split at chatLengthLimit like upstream.
// - incoming `text` packets → ChatMessage (lib/bedrock/text.js) → 'message' + 'messagestr' (positions: chat /
//   whisper / announcement → 'chat', raw / system / translation / json* (tellraw) → 'system', tip / popup /
//   jukebox_popup → 'game_info' + 'actionBar'); set_title action bar messages → 'game_info' + 'actionBar'.
// - command_output → one 'message'/'messagestr' (position 'system') per output line: { translate: message_id,
//   with: parameters }.
// - default chat patterns: Bedrock chat / whisper packets name their sender (`source_name`), so for those the
//   default 'chat' / 'whisper' patterns take username and message from the packet (names with spaces work);
//   every other message goes through upstream's regexes (e.g. /tellraw "<name> text", /say "[name] text").
// - unmatchedMessage (declared in mineflayer's index.d.ts, never emitted by 4.39.0): emitted for every message no
//   chat pattern matched.
// - bot.tabComplete: client-side from available_commands (lib/bedrock/commands.js); same promise shape as
//   upstream ([{ match, tooltip: undefined }], tabCompleteHasAToolTip).
//
// Internal hooks: `bot._bedrock.chat = { emitMessage, chatWithHeader, send, parser }` (emitMessage is the single
//   emitter of 'message'/'messagestr'), `bot._bedrock.commands = { request(command, { timeout }) →
//   Promise<command_output params>, pending, tree }`.
'use strict'
const crypto = require('crypto')
const { onceWithCleanup } = require('mineflayer/lib/promise_utils')
const { createTextParser, parserFor } = require('../bedrock/text')
const { createCommandTree, quoteName } = require('../bedrock/commands')
const { createPlayerNames } = require('../bedrock/player_list')

module.exports = inject

const USERNAME_REGEX = '(?:\\(.{1,15}\\)|\\[.{1,15}\\]|.){0,5}?(\\w+)'
const LEGACY_VANILLA_CHAT_REGEX = new RegExp(`^${USERNAME_REGEX}\\s?[>:\\-»\\]\\)~]+\\s(.*)$`)

const COMMAND_TIMEOUT_MS = 10000

function inject (bot, options) {
  const CHAT_LENGTH_LIMIT = options.chatLengthLimit ?? (bot.supportFeature('lessCharsInChat') ? 100 : 256)
  const defaultChatPatterns = options.defaultChatPatterns ?? true

  const text = parserFor(bot.registry)
  const ChatMessage = text.ChatMessage
  /** ChatMessage → { kind: 'chat'|'whisper', username, message } of a Bedrock chat/whisper packet with a sender */
  const sources = new WeakMap()

  /** the single emitter of 'message' / 'messagestr' */
  function emitMessage (message, position, sender = null, verified = null) {
    bot.emit('message', message, position, sender, verified)
    bot.emit('messagestr', message.toString(), position, message, sender, verified)
  }

  // chat.pattern.type will emit an event for bot.on() of the same type, eg chatType = whisper will trigger bot.on('whisper')
  const _patterns = {}
  let _length = 0
  // deprecated
  bot.chatAddPattern = (patternValue, typeValue) => {
    return bot.addChatPattern(typeValue, patternValue, { deprecated: true })
  }

  bot.addChatPatternSet = (name, patterns, opts = {}) => {
    if (!patterns.every(p => p instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, parse = false } = opts
    _patterns[_length++] = {
      name,
      patterns,
      position: 0,
      matches: [],
      messages: [],
      repeat,
      parse
    }
    return _length
  }

  bot.addChatPattern = (name, pattern, opts = {}) => {
    if (!(pattern instanceof RegExp)) throw new Error('Pattern parameter should be of type RegExp')
    const { repeat = true, deprecated = false, parse = false } = opts
    _patterns[_length] = {
      name,
      patterns: [pattern],
      position: 0,
      matches: [],
      messages: [],
      deprecated,
      repeat,
      parse
    }
    return _length++ // increment length after we give it back to the user
  }

  bot.removeChatPattern = name => {
    if (typeof name === 'number') {
      _patterns[name] = undefined
    } else {
      const matchingPatterns = Object.entries(_patterns).filter(pattern => pattern[1]?.name === name)
      matchingPatterns.forEach(([indexString]) => {
        _patterns[+indexString] = undefined
      })
    }
  }

  /**
   * Bedrock: a default pattern (marked `bedrock: 'chat'|'whisper'`) matches a chat/whisper packet with a sender
   * through the packet itself (the first default pattern of that kind only), and never through its regex.
   */
  function findMatchingPatterns (msg, source) {
    const found = []
    const claimed = new Set()
    for (const [indexString, pattern] of Object.entries(_patterns)) {
      if (!pattern) continue
      const { position, patterns } = pattern
      if (pattern.bedrock && source) {
        if (pattern.bedrock === source.kind && !claimed.has(source.kind)) {
          claimed.add(source.kind)
          found.push(+indexString)
        }
        continue
      }
      if (patterns[position].test(msg)) {
        found.push(+indexString)
      }
    }
    return found
  }

  bot.on('messagestr', (msg, _, originalMsg) => {
    const source = sources.get(originalMsg) ?? null
    const foundPatterns = findMatchingPatterns(msg, source)
    if (foundPatterns.length === 0) bot.emit('unmatchedMessage', msg, originalMsg)

    for (const ix of foundPatterns) {
      _patterns[ix].matches.push(msg)
      _patterns[ix].messages.push(originalMsg)
      _patterns[ix].position++

      if (_patterns[ix].deprecated) {
        const [, ...matches] = _patterns[ix].bedrock && source
          ? [msg, source.username, source.message]
          : _patterns[ix].matches[0].match(_patterns[ix].patterns[0])
        bot.emit(_patterns[ix].name, ...matches, _patterns[ix].messages[0].translate, ..._patterns[ix].messages)
        _patterns[ix].messages = [] // clear out old messages
      } else { // regular parsing
        // upstream returns from the whole listener here (later patterns are skipped for this message): kept as is
        if (_patterns[ix].patterns.length > _patterns[ix].matches.length) return // we have all the matches, so we can emit the done event
        if (_patterns[ix].parse) {
          const matches = _patterns[ix].patterns.map((pattern, i) => {
            const [, ...matches] = _patterns[ix].matches[i].match(pattern) // delete full message match
            return matches
          })
          bot.emit(`chat:${_patterns[ix].name}`, matches)
        } else {
          bot.emit(`chat:${_patterns[ix].name}`, _patterns[ix].matches)
        }
        // these are possibly null-ish if the user deletes them as soon as the event for the match is emitted
      }
      if (_patterns[ix]?.repeat) {
        _patterns[ix].position = 0
        _patterns[ix].matches = []
      } else {
        _patterns[ix] = undefined
      }
    }
  })

  addDefaultPatterns()

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
    if (parsed.source) sources.set(parsed.message, parsed.source)
    emitMessage(parsed.message, parsed.position, senderUuid(parsed.username))
    if (parsed.position === 'game_info') bot.emit('actionBar', parsed.message, null)
  })

  // `/title <player> actionbar …` / `/titleraw … actionbar …`
  bot._client.on('set_title', (packet) => {
    if (packet.type !== 'action_bar_message' && packet.type !== 'action_bar_message_json') return
    let message
    try {
      message = new ChatMessage(packet.type === 'action_bar_message_json' ? text.rawText(packet.text) : text.translated(packet.text))
    } catch (err) {
      bot.emit('error', err)
      return
    }
    emitMessage(message, 'game_info')
    bot.emit('actionBar', message, null)
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

  // the command tree for tabComplete (available_commands is re-sent when the permission level changes)
  const commandTree = createCommandTree()
  bot._client.on('available_commands', (packet) => {
    try {
      commandTree.update(packet)
    } catch (err) {
      bot.emit('error', err)
    }
  })
  bot._client.on('update_soft_enum', (packet) => commandTree.updateSoftEnum(packet))
  if (bot._bedrock) bot._bedrock.commands = { request: requestCommand, pending: pendingCommands, tree: commandTree }

  // online player names for tab completion (player_list; bot.players is the entities plugin's)
  const onlinePlayers = createPlayerNames(bot._client)
  function playerNames () {
    const names = new Set(onlinePlayers.names())
    for (const name of Object.keys(bot.players ?? {})) names.add(name)
    if (bot.username) names.add(bot.username)
    return [...names]
  }

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
    // upstream loops forever when the header fills the whole limit (e.g. a long whisper target name)
    if (lengthLimit <= 0) throw new Error(`Chat header is longer than chatLengthLimit (${CHAT_LENGTH_LIMIT}): ${header}`)
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

  /**
   * Bedrock has no tab-complete packet: complete from the available_commands tree (like the vanilla client).
   * `sendBlockInSight` is accepted for compatibility; Java only uses the looked-at block for block-position
   * suggestions, Bedrock's coordinate suggestions are relative ('~').
   */
  async function tabComplete (text, assumeCommand = false, sendBlockInSight = true, timeout = 5000) {
    if (!commandTree.ready) await onceWithCleanup(bot._client, 'available_commands', { timeout })
    const matches = commandTree.complete(text, { assumeCommand, players: playerNames() })
    return matches.map(match => ({ match, tooltip: undefined }))
  }

  bot.whisper = (username, message) => {
    chatWithHeader(`/tell ${quoteName(username)} `, message)
  }
  bot.chat = (message) => {
    chatWithHeader('', message)
  }

  bot.tabComplete = tabComplete

  function addDefaultPatterns () {
    // 1.19 changes the chat format to move <sender> prefix from message contents to a separate field.
    // TODO: new chat lister to handle this
    if (!defaultChatPatterns) return
    // Bedrock: `bedrock` marks the packet kind these default patterns take from the packet (see findMatchingPatterns)
    _patterns[bot.addChatPattern('whisper', new RegExp(`^${USERNAME_REGEX} whispers(?: to you)?:? (.*)$`), { deprecated: true })].bedrock = 'whisper'
    _patterns[bot.addChatPattern('whisper', new RegExp(`^\\[${USERNAME_REGEX} -> \\w+\\s?\\] (.*)$`), { deprecated: true })].bedrock = 'whisper'
    _patterns[bot.addChatPattern('chat', LEGACY_VANILLA_CHAT_REGEX, { deprecated: true })].bedrock = 'chat'
  }

  function awaitMessage (...args) {
    const timeout = typeof args[args.length - 1] === 'number' ? args.pop() : 20000
    return new Promise((resolve, reject) => {
      const resolveMessages = args.flatMap(x => x)
      const timeoutHandle = setTimeout(() => {
        bot.off('messagestr', messageListener)
        reject(new Error(`Timeout waiting for message after ${timeout}ms`))
      }, timeout)

      function messageListener (msg) {
        if (resolveMessages.some(x => x instanceof RegExp ? x.test(msg) : msg === x)) {
          clearTimeout(timeoutHandle)
          resolve(msg)
          bot.off('messagestr', messageListener)
        }
      }
      bot.on('messagestr', messageListener)
    })
  }
  bot.awaitMessage = awaitMessage

  // internal hooks
  if (bot._bedrock) bot._bedrock.chat = { emitMessage, chatWithHeader, send, parser: text }
}

module.exports.createTextParser = createTextParser
