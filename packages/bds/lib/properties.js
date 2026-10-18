// owner: U1 (BDS harness & e2e infra)
'use strict'

/**
 * server.properties writer.
 *
 * The harness writes the whole file itself (itzg's `set-property` only touches keys whose env var
 * is set, and the harness sets none). Precedence, lowest first:
 *   BDS template (the golden server.properties) < {@link DEFAULTS} < startServer options
 *   (gamemode, difficulty, world, seed, levelName) < `properties` overrides < {@link ENFORCED} + ports.
 * Overriding an enforced key with a different value throws: these keep parallel host-network
 * servers isolated (no LAN discovery on 19132/19133), RakNet-reachable and offline.
 */

/** Non-overridable keys (plus `server-port` / `server-portv6`, which come from the slot). */
const ENFORCED = Object.freeze({
  'enable-lan-visibility': 'false',
  transport: 'raknet',
  'online-mode': 'false',
  'allow-list': 'false',
  'player-idle-timeout': '0'
})

/** Harness defaults (overridable). Upstream mineflayer's external tests use a creative flat world. */
const DEFAULTS = Object.freeze({
  'server-name': 'bedboo',
  gamemode: 'creative',
  'force-gamemode': 'false',
  difficulty: 'peaceful',
  'level-type': 'FLAT',
  'level-name': 'bedboo',
  'level-seed': '',
  'allow-cheats': 'true',
  'default-player-permission-level': 'operator',
  'max-players': '10',
  'view-distance': '32',
  'tick-distance': '4',
  'max-threads': '4',
  'texturepack-required': 'false',
  'content-log-file-enabled': 'false'
})

const PORT_KEYS = ['server-port', 'server-portv6']

const GAMEMODES = ['survival', 'creative', 'adventure']
const DIFFICULTIES = ['peaceful', 'easy', 'normal', 'hard']
const LEVEL_TYPES = { flat: 'FLAT', default: 'DEFAULT', seeded: 'DEFAULT', legacy: 'LEGACY' }

/** @returns {Array<{ key?: string, value?: string, raw: string }>} lines of a properties file */
function parse (text) {
  return String(text).split(/\r?\n/).map((raw) => {
    const trimmed = raw.trim()
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('!')) return { raw }
    const i = trimmed.search(/[=:]/)
    if (i < 0) return { key: trimmed, value: '', raw }
    return { key: trimmed.slice(0, i).trim(), value: trimmed.slice(i + 1).trim(), raw }
  })
}

/** @returns {Record<string,string>} */
function toObject (text) {
  const out = {}
  for (const line of parse(text)) if (line.key !== undefined) out[line.key] = line.value
  return out
}

function stringify (key, value) {
  if (value === undefined || value === null) return undefined
  const str = typeof value === 'boolean' || typeof value === 'number' ? String(value) : value
  if (typeof str !== 'string') throw new TypeError(`server.properties "${key}" must be a string, number or boolean`)
  if (/[\r\n]/.test(str)) throw new Error(`server.properties "${key}" must be a single line`)
  return str
}

/**
 * Compute the property values for an instance.
 * @param {object} opts
 * @param {{ v4: number, v6: number }} opts.ports
 * @param {'survival'|'creative'|'adventure'} [opts.gamemode]
 * @param {'peaceful'|'easy'|'normal'|'hard'} [opts.difficulty]
 * @param {'flat'|'default'|'seeded'|'legacy'} [opts.world]
 * @param {string|number} [opts.seed]
 * @param {string} [opts.levelName]
 * @param {string} [opts.serverName]
 * @param {Record<string, string|number|boolean>} [opts.properties] raw overrides
 * @returns {Record<string,string>}
 */
function resolve (opts) {
  const values = { ...DEFAULTS }
  if (opts.serverName) values['server-name'] = opts.serverName
  if (opts.gamemode !== undefined) {
    if (!GAMEMODES.includes(opts.gamemode)) throw new Error(`Invalid gamemode ${opts.gamemode} (expected ${GAMEMODES.join('|')})`)
    values.gamemode = opts.gamemode
  }
  if (opts.difficulty !== undefined) {
    if (!DIFFICULTIES.includes(opts.difficulty)) throw new Error(`Invalid difficulty ${opts.difficulty} (expected ${DIFFICULTIES.join('|')})`)
    values.difficulty = opts.difficulty
  }
  const world = opts.world ?? (opts.seed !== undefined ? 'seeded' : 'flat')
  if (!LEVEL_TYPES[world]) throw new Error(`Invalid world ${world} (expected ${Object.keys(LEVEL_TYPES).join('|')})`)
  values['level-type'] = LEVEL_TYPES[world]
  if (opts.seed !== undefined) values['level-seed'] = stringify('level-seed', opts.seed)
  if (opts.levelName !== undefined) values['level-name'] = stringify('level-name', opts.levelName)

  for (const [key, raw] of Object.entries(opts.properties ?? {})) {
    const value = stringify(key, raw)
    if (value === undefined) continue
    if (PORT_KEYS.includes(key)) throw new Error(`server.properties "${key}" is assigned from the slot and cannot be overridden`)
    if (key in ENFORCED && ENFORCED[key] !== value) {
      throw new Error(`server.properties "${key}" is enforced by the harness (${ENFORCED[key]}), cannot set ${value}`)
    }
    values[key] = value
  }
  Object.assign(values, ENFORCED)
  if (!opts.ports) throw new Error('ports are required')
  values['server-port'] = String(opts.ports.v4)
  values['server-portv6'] = String(opts.ports.v6)
  if (!values['level-name'] || /[/\\]|^\.\.?$/.test(values['level-name'])) throw new Error(`Invalid level-name ${values['level-name']}`)
  return values
}

/**
 * Render a full server.properties: the template's lines (comments kept) with values replaced, then
 * any keys the template lacks.
 * @param {string} template BDS default server.properties
 * @param {Record<string,string>} values from {@link resolve}
 */
function render (template, values) {
  const pending = new Map(Object.entries(values))
  const out = []
  for (const line of parse(template)) {
    if (line.key !== undefined && pending.has(line.key)) {
      out.push(`${line.key}=${pending.get(line.key)}`)
      pending.delete(line.key)
    } else {
      out.push(line.raw)
    }
  }
  while (out.length && out[out.length - 1] === '') out.pop()
  if (pending.size) {
    out.push('', '# bedboo harness')
    for (const [key, value] of pending) out.push(`${key}=${value}`)
  }
  return out.join('\n') + '\n'
}

module.exports = { ENFORCED, DEFAULTS, PORT_KEYS, GAMEMODES, DIFFICULTIES, LEVEL_TYPES, parse, toObject, resolve, render }
