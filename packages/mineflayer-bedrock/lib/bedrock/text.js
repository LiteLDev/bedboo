// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Bedrock text → prismarine-chat `ChatMessage` (moved here from U4's chat core and completed by U6).
 *
 * Bedrock `text` packets carry plain strings with `§` formatting codes (`raw`, `chat`, `whisper`, `announcement`,
 * `system`, `tip`), strings with `%key` translation references + parameters (`translation`, `popup`,
 * `jukebox_popup`, or any type with `needs_translation`), or JSON rawtext (`json`, `json_whisper`,
 * `json_announcement`; also `set_title` `*_json` and `/tellraw`). Everything becomes Java-style chat component
 * JSON so mineflayer code (and `ChatMessage.toString()`) works unchanged:
 *   - player chat → `{ translate: 'chat.type.text', with: [name, message] }` ("<name> message", like Java's vanilla
 *     chat), whisper → `commands.message.display.incoming` ("name whispers to you: message");
 *   - `%key` / rawtext `translate` → `{ translate, with }` resolved through `registry.language` (formats normalized
 *     by lib/registry.js);
 *   - `§` codes → component styles with Bedrock semantics: `§g`, `§h`, `§i`, `§j`, `§m`, `§n`, `§p`, `§q`, `§s`,
 *     `§t`, `§u`, `§v` are colours (hex), `§k`/`§l`/`§o` formats, `§r` reset; colour codes do not reset the formats.
 *
 * Contract (CONTRIBUTING):
 * - `toChatMessage(registry, textPacket) → { message: ChatMessage, position: 'chat'|'system'|'game_info',
 *    sender: string|null, source: { kind, username, message }|null }` (`sender` = the sending player's name)
 * - `fromRawText(registry, rawtextJson) → ChatMessage`
 * - `fromFormattedString(registry, str) → ChatMessage`
 * - `createTextParser(registry, ChatMessage?)` → a parser `{ ChatMessage, parseText, parseCommandOutput, rawText,
 *   translated, formatted, parameter }`; `parserFor(registry)` → the one cached per registry (used by the plugins
 *   and the module-level functions above).
 */
const { normalizeFormat } = require('../registry')

/** mineflayer message positions of each Bedrock text type */
const POSITIONS = {
  chat: 'chat',
  whisper: 'chat',
  announcement: 'chat',
  json_whisper: 'system', // /tellraw (Java: system chat)
  json_announcement: 'system',
  raw: 'system',
  system: 'system',
  translation: 'system',
  json: 'system',
  tip: 'game_info',
  popup: 'game_info',
  jukebox_popup: 'game_info'
}

/** Bedrock `§` colour codes (https://minecraft.wiki/w/Formatting_codes, Bedrock Edition) */
const COLORS = {
  0: 'black',
  1: 'dark_blue',
  2: 'dark_green',
  3: 'dark_aqua',
  4: 'dark_red',
  5: 'dark_purple',
  6: 'gold',
  7: 'gray',
  8: 'dark_gray',
  9: 'blue',
  a: 'green',
  b: 'aqua',
  c: 'red',
  d: 'light_purple',
  e: 'yellow',
  f: 'white',
  g: '#DDD605', // minecoin_gold
  h: '#E3D4D1', // material_quartz
  i: '#CECACA', // material_iron
  j: '#443A3B', // material_netherite
  m: '#971607', // material_redstone (not strikethrough on Bedrock)
  n: '#B4684D', // material_copper (not underline on Bedrock)
  p: '#DEB12D', // material_gold
  q: '#47A036', // material_emerald
  s: '#2CBAA8', // material_diamond
  t: '#21497B', // material_lapis
  u: '#9A5CC6', // material_amethyst
  v: '#EB7114' // material_resin
}
const FORMATS = { k: 'obfuscated', l: 'bold', o: 'italic' }
const FLAGS = ['bold', 'italic', 'obfuscated']

/**
 * Split a `§`-formatted string into styled segments (Bedrock semantics).
 * @returns {{ text: string, style: object }[]}
 */
function segments (str) {
  const out = []
  let style = {}
  let text = ''
  for (let i = 0; i < str.length; i++) {
    const ch = str[i]
    if (ch !== '§') {
      text += ch
      continue
    }
    const code = str[i + 1]?.toLowerCase()
    i++
    if (code === undefined) break // dangling '§'
    if (text) {
      out.push({ text, style })
      text = ''
    }
    if (code === 'r') style = {}
    else if (Object.hasOwn(COLORS, code)) style = { ...style, color: COLORS[code] }
    else if (Object.hasOwn(FORMATS, code)) style = { ...style, [FORMATS[code]]: true }
    // unknown codes are dropped like the client does
  }
  if (text || out.length === 0) out.push({ text, style })
  return out
}

/** the style of a run of `§` codes (e.g. the leading codes of a message) */
function styleOf (codes) {
  return segments(String(codes ?? '') + 'x')[0].style
}

/** `§`-formatted string → chat component JSON (first segment at the root, the rest in `extra`) */
function formattedJson (str) {
  str = String(str ?? '')
  if (!str.includes('§')) return { text: str }
  const [first, ...rest] = segments(str)
  const root = { text: first.text, ...first.style }
  if (rest.length) {
    root.extra = rest.map(({ text, style }) => {
      // children inherit the root style: only write what differs
      const part = { text }
      if (style.color !== root.color) part.color = style.color ?? 'reset'
      for (const flag of FLAGS) if (Boolean(style[flag]) !== Boolean(root[flag])) part[flag] = Boolean(style[flag])
      return part
    })
  }
  return root
}

function stripCodes (str) {
  return String(str ?? '').replace(/§./g, '')
}

/**
 * @param {object} registry the bot registry (language normalized by lib/registry.js)
 * @param {Function} [ChatMessage] prismarine-chat class for the registry
 */
function createTextParser (registry, ChatMessage = require('prismarine-chat')(registry)) {
  const language = registry.language ?? {}
  const KEY_RE = /%([A-Za-z][\w.-]*[\w])/g

  /** `§`-formatted string → chat component JSON */
  function formatted (str) {
    return formattedJson(str)
  }

  /** a string that is exactly one translation key reference ('%key') → { translate } component, else formatted text */
  function parameter (str) {
    str = String(str ?? '')
    const m = /^%([A-Za-z][\w.-]*)$/.exec(str)
    if (m && Object.hasOwn(language, m[1])) return { translate: m[1] }
    return formatted(str)
  }

  /**
   * Bedrock string with embedded `%key` references (+ § codes) → component. A message that is a single key
   * (after leading § codes) becomes { translate, with, ...style } so `msg.translate` is the key, like Java; so does a
   * message that is exactly a language key without '%' (boss bar titles: 'entity.wither.name').
   * Otherwise the leading § style applies to the whole message, text between keys keeps its own codes, and the
   * parameters go to the first key (Bedrock messages carry one parameter list).
   */
  function translated (message, parameters = []) {
    message = String(message ?? '')
    const withArgs = parameters.map(parameter)
    const lead = /^((?:§.)*)(.*)$/s.exec(message)
    const style = lead[1] ? styleOf(lead[1]) : {}
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

  /** Bedrock rawtext ({ rawtext: [...] }, as JSON text or object) → component */
  function rawText (json) {
    if (typeof json === 'string') {
      try {
        json = JSON.parse(json)
      } catch {
        return formatted(json)
      }
    }
    if (json === null || typeof json !== 'object') return formatted(json)
    const parts = (Array.isArray(json.rawtext) ? json.rawtext : [json]).map(rawPart)
    if (parts.length === 1) return parts[0]
    return { text: '', extra: parts }
  }
  function rawPart (part) {
    if (part === null || typeof part !== 'object') return formatted(part)
    // only an array is a rawtext list; BDS refuses anything else, other senders get it read as a single part (the
    // part itself again would recurse forever)
    if (Array.isArray(part.rawtext)) return rawText(part)
    if (part.rawtext !== undefined && part.rawtext !== null) return rawPart(part.rawtext)
    if (part.translate !== undefined) {
      let withArgs = []
      if (Array.isArray(part.with)) withArgs = part.with.map(parameter)
      else if (Array.isArray(part.with?.rawtext)) withArgs = part.with.rawtext.map(rawPart)
      const key = String(part.translate)
      if (Object.hasOwn(language, key)) return { translate: key, with: withArgs }
      const lead = /^((?:§.)*)(.*)$/s.exec(key)
      if (lead[1] && Object.hasOwn(language, lead[2])) return { ...styleOf(lead[1]), translate: lead[2], with: withArgs }
      // a literal format ("Hello %%s", "%1 and %2"): Bedrock placeholders → prismarine-chat's %s / %N$s
      return { translate: normalizeFormat(key.replace(/%%(?=s|\d)/g, '%')), with: withArgs }
    }
    if (part.selector !== undefined) return { selector: String(part.selector) }
    if (part.score !== undefined) {
      if (!part.score || typeof part.score !== 'object') return { text: '' }
      return { score: { name: String(part.score.name ?? ''), objective: String(part.score.objective ?? '') } }
    }
    if (part.text !== undefined) return parameter(part.text)
    return { text: '' }
  }

  function messageComponent (packet) {
    return packet.needs_translation ? translated(packet.message, packet.parameters ?? []) : formatted(packet.message)
  }

  /**
   * @param {object} packet bedrock-protocol `text` params
   * @returns {{ message: ChatMessage, position: string, username: string|null,
   *   source: { kind: 'chat'|'whisper', username: string, message: string }|null }}
   *   `username`: the sender's name (§ stripped) when the packet names one; `source`: set for player chat /
   *   whispers / announcements (/say, kind 'chat') with a sender — the chat plugin's default patterns use it
   *   instead of a regex.
   */
  function parseText (packet) {
    const type = packet.type
    let json
    let username = null
    let source = null
    const sender = stripCodes(packet.source_name)
    switch (type) {
      case 'chat':
      case 'whisper': {
        const body = messageComponent(packet)
        if (sender) {
          username = sender
          json = {
            translate: type === 'chat' ? 'chat.type.text' : 'commands.message.display.incoming',
            with: [formatted(packet.source_name), body]
          }
          source = { kind: type, username: sender, message: new ChatMessage(body).toString() }
        } else {
          json = body // e.g. /me: { type: 'chat', source_name: '', message: '* name action' }
        }
        break
      }
      case 'announcement': { // /say: { source_name: name, message: '[name] text' }
        if (!sender) {
          json = messageComponent(packet)
          break
        }
        // like Java's say_command chat type: { translate: 'chat.type.announcement', with: [name, text] } ("[name]
        // text"); the default 'chat' pattern takes the sender from the packet (names with spaces work)
        username = sender
        const message = String(packet.message ?? '')
        // the leading "[name] " (the name possibly formatted differently than source_name, maybe containing "] ")
        let cut = 0
        for (let i = message.indexOf('] '); message.startsWith('[') && i !== -1; i = message.indexOf('] ', i + 1)) {
          if (stripCodes(message.slice(1, i)) === sender) {
            cut = i + 2
            break
          }
        }
        const body = messageComponent({ ...packet, message: message.slice(cut) })
        json = { translate: 'chat.type.announcement', with: [formatted(packet.source_name), body] }
        source = { kind: 'chat', username: sender, message: new ChatMessage(body).toString() }
        break
      }
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
      default: // raw, system, tip
        json = messageComponent(packet)
    }
    return { message: new ChatMessage(json), position: POSITIONS[type] ?? 'system', username, source }
  }

  /** command_output → one ChatMessage per output line */
  function parseCommandOutput (packet) {
    return (packet.output ?? []).map(line => new ChatMessage({ translate: line.message_id, with: (line.parameters ?? []).map(parameter) }))
  }

  return { ChatMessage, parseText, parseCommandOutput, rawText, translated, formatted, parameter }
}

const parsers = new WeakMap()
function parserFor (registry) {
  let parser = parsers.get(registry)
  if (!parser) {
    parser = createTextParser(registry)
    parsers.set(registry, parser)
  }
  return parser
}

/** `text` packet → { message, position, sender, source } (see the contract above) */
function toChatMessage (registry, textPacket) {
  const { message, position, username, source } = parserFor(registry).parseText(textPacket)
  return { message, position, sender: username, source }
}

/** rawtext JSON (string or object) → ChatMessage */
function fromRawText (registry, json) {
  const parser = parserFor(registry)
  return new parser.ChatMessage(parser.rawText(json))
}

/** `§`-formatted string (with `%key` references) → ChatMessage */
function fromFormattedString (registry, str) {
  const parser = parserFor(registry)
  return new parser.ChatMessage(parser.translated(str))
}

module.exports = {
  POSITIONS,
  COLORS,
  createTextParser,
  parserFor,
  toChatMessage,
  fromRawText,
  fromFormattedString,
  formattedJson,
  stripCodes
}
