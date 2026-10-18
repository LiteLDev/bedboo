// owner: U6 (chat, commands & HUD)
'use strict'
/**
 * Client-side command completion for `bot.tabComplete` (Bedrock has no tab-complete packet; the vanilla client
 * completes from the `available_commands` tree it received, and so do we).
 *
 *   const tree = createCommandTree()
 *   bot._client.on('available_commands', p => tree.update(p))
 *   bot._client.on('update_soft_enum', p => tree.updateSoftEnum(p))
 *   tree.complete('/weather ', { players: ['Steve'] })   // → ['clear', 'query', 'rain', 'thunder']
 *
 * Semantics follow Java's brigadier answer to a tab_complete request (what mineflayer returns): the suggestions
 * for the last (partial, possibly empty) word, without the leading '/', de-duplicated and sorted
 * case-insensitively:
 *   - '/wea'          → command names and aliases starting with 'wea' (commands hidden from players excluded);
 *   - '/cmd args… x'  → for every overload whose earlier parameters accept the earlier words: enum values
 *     (`enums`, soft enums `dynamic_enums` kept current by update_soft_enum), player names + selectors for target
 *     parameters, '~' forms for coordinates; `/execute … run <command>` and chained subcommands recurse;
 *   - plain chat (no '/', `assumeCommand` false) → online player names matching the last word.
 *
 * Parameter encoding (bedrock-protocol 3.60.1): `enum_type` is the high half of the Bedrock parameter type
 * ('valid' 0x10, 'enum' 0x30, 'suffixed' 0x100, 'soft_enum' 0x410, chained subcommand 0x810 = 2064) and
 * `value_type` the low half — a type id for 'valid', an index into `enums` / `dynamic_enums` /
 * `chained_subcommands` otherwise. bedrock-protocol's mapper turns a few numbers into names even when they are
 * indices; those are mapped back with the protocol's own table.
 */

const SELECTORS = ['@a', '@e', '@initiator', '@p', '@r', '@s']
/**
 * How a 'valid' parameter of BDS 1.26.51 completes, by numeric type id (observed in its available_commands).
 * bedrock-protocol 3.60.1's `value_type` mapper still carries older ids for some names (position 53, message 55,
 * json 62, command 75, …), so names are mapped back to their numbers first and only the number is trusted.
 * Anything else is a single word without suggestions (int, float, value, string, operators, ranges, block states…).
 */
const VALUE_TYPE_KINDS = {
  8: 'target', // target
  10: 'target', // wildcard target
  64: 'position', // block position (x y z)
  65: 'position', // position (x y z)
  68: 'rest', // message
  70: 'rest', // raw text
  74: 'rest', // json
  90: 'command' // command (execute … run <command>)
}

let valueTypeIds = null
/** name → number of bedrock-protocol's `value_type` mapper (to recover enum indices it renamed) */
function valueTypeIdTable () {
  if (valueTypeIds) return valueTypeIds
  valueTypeIds = {}
  try {
    const { VERSION } = require('./constants')
    const types = require('minecraft-data')(`bedrock_${VERSION}`).protocol.types
    const found = findMapper(types.packet_available_commands, 'value_type')
    if (found) for (const [num, name] of Object.entries(found)) valueTypeIds[name] = Number(num)
  } catch {}
  if (!Object.keys(valueTypeIds).length) {
    valueTypeIds = { int: 1, float: 3, value: 4, wildcard_int: 5, operator: 6, command_operator: 7, target: 8, wildcard_target: 10, file_path: 17, integer_range: 23, equipment_slots: 43, string: 44, block_position: 52, position: 53, message: 55, raw_text: 58, json: 62, block_states: 71, command: 75 }
  }
  return valueTypeIds
}
function findMapper (node, field) {
  if (!node || typeof node !== 'object') return null
  if (!Array.isArray(node) && node.name === field && Array.isArray(node.type) && node.type[0] === 'mapper') return node.type[1].mappings
  for (const child of Array.isArray(node) ? node : Object.values(node)) {
    const found = findMapper(child, field)
    if (found) return found
  }
  return null
}

/** the number carried by `value_type` (a number, or a name bedrock-protocol's mapper produced from it) */
function indexOf (valueType) {
  if (typeof valueType === 'number') return valueType
  return valueTypeIdTable()[valueType]
}

function enumKind (enumType) {
  if (enumType === 'enum') return 'enum'
  if (enumType === 'soft_enum') return 'soft_enum'
  if (enumType === 'suffixed') return 'token'
  if (enumType === 'valid') return 'valid'
  if (typeof enumType === 'number') {
    if (enumType & 0x800) return 'chained'
    if (enumType & 0x400) return 'soft_enum'
    if (enumType & 0x20) return 'enum'
  }
  return 'token'
}

/**
 * Split a command line into words: spaces separate words except inside quotes, [] and {} (selectors with
 * arguments, block states, JSON).
 * @returns {{ words: string[], partial: string }} the completed words and the last, partial word
 */
function tokenize (line) {
  const words = []
  let current = ''
  let depth = 0
  let quote = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quote) {
      current += ch
      if (ch === '\\' && i + 1 < line.length) current += line[++i]
      else if (ch === '"') quote = false
      continue
    }
    if (ch === '"') quote = true
    else if (ch === '[' || ch === '{') depth++
    else if ((ch === ']' || ch === '}') && depth > 0) depth--
    else if (ch === ' ' && depth === 0) {
      words.push(current)
      current = ''
      continue
    }
    current += ch
  }
  return { words: words.filter((w, i) => w !== '' || i === 0), partial: current }
}

const lower = (s) => String(s).toLowerCase()
const unquote = (s) => (/^".*"$/s.test(s) ? s.slice(1, -1) : s)
const sortSuggestions = (list) => [...new Set(list)].sort((a, b) => {
  const la = lower(a)
  const lb = lower(b)
  return la < lb ? -1 : la > lb ? 1 : (a < b ? -1 : a > b ? 1 : 0)
})

function createCommandTree () {
  /** name (lower case, aliases included) → { name, overloads: [{ chaining, parameters: [param] }] } */
  const commands = new Map()
  let enums = []
  let softEnums = new Map() // name → string[]
  let softEnumNames = [] // index → name
  let ready = false

  function update (packet) {
    const values = packet.enum_values ?? []
    enums = (packet.enums ?? []).map(e => ({ name: e.name, values: (e.values ?? []).map(i => values[i]).filter(v => v !== undefined) }))
    softEnums = new Map((packet.dynamic_enums ?? []).map(e => [e.name, [...(e.values ?? [])]]))
    softEnumNames = (packet.dynamic_enums ?? []).map(e => e.name)
    commands.clear()
    for (const data of packet.command_data ?? []) {
      if (data.flags & 0x04) continue // hidden from players
      const command = {
        name: data.name,
        overloads: (data.overloads ?? []).map(o => ({ chaining: Boolean(o.chaining), parameters: (o.parameters ?? []).map(compileParam) }))
      }
      commands.set(lower(data.name), command)
      const alias = data.alias >= 0 ? enums[data.alias] : null
      for (const name of alias?.values ?? []) if (!commands.has(lower(name))) commands.set(lower(name), command)
    }
    ready = true
  }

  function compileParam (p) {
    const kind = enumKind(p.enum_type)
    const param = { name: p.parameter_name, optional: Boolean(p.optional), kind: 'token' }
    if (kind === 'enum') {
      param.kind = 'enum'
      param.enum = enums[indexOf(p.value_type)] ?? { name: '?', values: [] }
    } else if (kind === 'soft_enum') {
      param.kind = 'soft_enum'
      param.softEnum = softEnumNames[indexOf(p.value_type)]
    } else if (kind === 'chained') {
      param.kind = 'chained'
    } else if (kind === 'valid') {
      param.kind = VALUE_TYPE_KINDS[indexOf(p.value_type)] ?? 'token'
    }
    return param
  }

  function updateSoftEnum (packet) {
    const name = packet.enum_type
    const list = softEnums.get(name) ?? []
    const options = packet.options ?? []
    if (packet.action_type === 'add') {
      for (const o of options) if (!list.includes(o)) list.push(o)
    } else if (packet.action_type === 'remove') {
      for (const o of options) {
        const i = list.indexOf(o)
        if (i >= 0) list.splice(i, 1)
      }
    } else if (packet.action_type === 'update') {
      list.length = 0
      list.push(...options)
    }
    softEnums.set(name, list)
  }

  /** suggestions for the word at `param`, `offset` words into it (coordinates take three words) */
  function paramSuggestions (param, offset, ctx) {
    switch (param.kind) {
      case 'enum': return param.enum.values
      case 'soft_enum': return softEnums.get(param.softEnum) ?? []
      case 'target': return [...ctx.players.map(quoteName), ...SELECTORS]
      case 'position': return ['~', '~ ~', '~ ~ ~'].slice(0, 3 - offset)
      default: return []
    }
  }

  /** words a parameter consumes (null = all remaining words) */
  function width (param) {
    if (param.kind === 'position') return 3
    if (param.kind === 'rest' || param.kind === 'command' || param.kind === 'chained') return null
    return 1
  }

  function accepts (param, word) {
    if (param.kind === 'enum') return param.enum.values.some(v => lower(v) === lower(unquote(word)))
    return true
  }

  /**
   * Collect the suggestions for `partial` after `words` (relative to `command`'s parameters).
   * @param {object} command
   * @param {string[]} words completed argument words (without the command name)
   * @param {string} partial
   * @param {boolean} chainingOnly only the overloads of a chained subcommand
   */
  function argumentSuggestions (command, words, partial, ctx, chainingOnly = false, depth = 0) {
    const out = []
    if (depth > 16) return out
    for (const overload of command.overloads) {
      if (chainingOnly && !overload.chaining) continue
      let w = 0 // index of the next word to match
      for (const param of overload.parameters) {
        const n = width(param)
        if (n === null) {
          // consumes every remaining word: a nested command / chained subcommand is completed recursively
          const rest = words.slice(w)
          if (param.kind === 'command') out.push(...lineSuggestions([...rest, partial].join(' '), ctx, depth + 1))
          else if (param.kind === 'chained') out.push(...argumentSuggestions(command, rest, partial, ctx, true, depth + 1))
          break
        }
        if (w + n > words.length) {
          // the partial word belongs to this parameter
          out.push(...paramSuggestions(param, words.length - w, ctx))
          break
        }
        const taken = words.slice(w, w + n)
        if (!taken.every(word => accepts(param, word))) break // an earlier word rules this overload out
        w += n
        // all parameters matched and the partial word comes after the last one: nothing to suggest
      }
    }
    return out
  }

  function lineSuggestions (line, ctx, depth = 0) {
    const { words, partial } = tokenize(line)
    if (words.length === 0) {
      const names = []
      for (const [name] of commands) if (name.startsWith(lower(partial))) names.push(name)
      return names
    }
    const command = commands.get(lower(words[0]))
    if (!command) return []
    return argumentSuggestions(command, words.slice(1), partial, ctx, false, depth)
  }

  /**
   * @param {string} text what the player typed
   * @param {{ assumeCommand?: boolean, players?: string[] }} [opts]
   * @returns {string[]} suggestions for the last word, sorted
   */
  function complete (text, { assumeCommand = false, players = [] } = {}) {
    text = String(text ?? '')
    const ctx = { players }
    const isCommand = text.startsWith('/') || assumeCommand
    if (!isCommand) {
      const partial = text.slice(text.lastIndexOf(' ') + 1)
      return sortSuggestions(players.filter(p => lower(p).startsWith(lower(partial))))
    }
    const line = text.startsWith('/') ? text.slice(1) : text
    const { partial } = tokenize(line)
    const filter = lower(unquote(partial))
    const suggestions = lineSuggestions(line, ctx).filter(s => lower(unquote(s)).startsWith(filter))
    return sortSuggestions(suggestions)
  }

  /** the command's own name for a name or alias ('tp' → 'teleport'; unknown names unchanged, lower case) */
  function canonicalName (name) {
    return lower(commands.get(lower(name))?.name ?? name)
  }

  return {
    update,
    updateSoftEnum,
    complete,
    canonicalName,
    get ready () { return ready },
    commands,
    softEnums: () => softEnums,
    enums: () => enums
  }
}

function quoteName (name) {
  return /^[A-Za-z0-9_]+$/.test(name) ? name : `"${String(name).replace(/"/g, '\\"')}"`
}

/**
 * A command target as typed: a selector (`@p`, `@a[r=5]`, …; no gamertag starts with '@') verbatim, like upstream's
 * `/tell ${username}`, a player name quoted when it needs it (gamertags may contain spaces).
 */
function quoteTarget (name) {
  name = String(name)
  return name.startsWith('@') ? name : quoteName(name)
}

/** the command name ('/time set 1' → 'time', '/minecraft:say x' → 'say') */
function commandName (command) {
  const m = /^\/?\s*(?:minecraft:)?([^\s]+)/.exec(String(command ?? ''))
  return m ? m[1].toLowerCase() : null
}

/**
 * The command name of an `event { event_type: 'command_executed' }` packet's `event_data` (bedrock-protocol leaves
 * it raw). BDS 1.26.51 sends three varints, then the name as a varint-length string (e.g. 08 02 00 03 'say' 00).
 * @returns {string|null} null when the data has another shape
 */
function executedCommandName (data) {
  try {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data ?? [])
    let i = 0
    const varint = () => {
      let value = 0
      for (let shift = 0; shift < 35; shift += 7) {
        if (i >= buf.length) throw new RangeError('truncated')
        const byte = buf[i++]
        value |= (byte & 0x7f) << shift
        if (!(byte & 0x80)) return value >>> 0
      }
      throw new RangeError('varint too long')
    }
    varint()
    varint()
    varint()
    const length = varint()
    if (length < 1 || i + length > buf.length) return null
    const name = buf.subarray(i, i + length).toString('utf8').toLowerCase().replace(/^minecraft:/, '')
    return /^[a-z0-9_.:-]+$/.test(name) ? name : null
  } catch {
    return null
  }
}

module.exports = { createCommandTree, tokenize, quoteName, quoteTarget, commandName, executedCommandName, SELECTORS }
