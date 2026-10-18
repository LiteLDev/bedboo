// owner: U4 (core runtime)
'use strict'
const { VERSION } = require('./bedrock/constants')

/**
 * Registry setup.
 *
 * ORDER MATTERS: the @bedboo/bedrock-data overlay (U2) patches minecraft-data's `bedrock_1.26.51`
 * datasets. minecraft-data caches a version object the first time `require('minecraft-data')(v)`
 * is called, and bedrock-protocol calls it while creating its (de)serializer, so the overlay must be
 * installed BEFORE bedrock-protocol / prismarine-* resolve any Bedrock data. `index.js` calls
 * `installDataOverlay()` as its very first statement; everything else calls it again (idempotent).
 *
 * Runtime wiring (`attachRegistry(bot)`, called by the loader right after the client is created, before any
 * plugin listener): `start_game` → `registry.handleStartGame(packet)` (block runtime ids: FNV-1a hashes,
 * `registry.blocksByRuntimeId` / `runtimeIdByStateId`) and `item_registry` → `registry.handleItemRegistry`
 * (items keyed by the server's network ids) + `bot._bedrock.ids.loadItemRegistry`. Chunks can only be
 * decoded after start_game (prismarine-chunk throws otherwise), which always precedes level_chunk.
 *
 * `registry.language` is the Bedrock en_US language with its printf formats (`%1$d`, `%d`, `%.2f`, `%1`)
 * normalized to the `%s` / `%1$s` forms prismarine-chat substitutes, so `ChatMessage.toString()` renders Bedrock
 * translation keys (docs/differences/U4.md#language-formats).
 */

let overlayInstalled = false

/** Install the bedrock-data overlay into minecraft-data (idempotent). */
function installDataOverlay () {
  if (overlayInstalled) return
  overlayInstalled = true
  require('@bedboo/bedrock-data').install()
  aliasBotVersion()
}

/**
 * mineflayer API: "`require('minecraft-data')(bot.version)` gives you access to it" (docs/upstream/api.md). bot.version
 * is the bare Bedrock version '1.26.51', which minecraft-data resolves as a Java version (none exists: there is no Java
 * 1.26.51) and answers `null` — breaking upstream code that relies on it, e.g. prismarine-physics' `PlayerState`
 * (built by mineflayer-pathfinder), mineflayer-pvp. Alias it to the `bedrock_1.26.51` data (U5; type 'bedrock').
 */
function aliasBotVersion () {
  const data = require('minecraft-data/data.js')
  if (!data.pc || data.pc[VERSION] || !data.bedrock?.[VERSION]) return
  data.pc[VERSION] = data.bedrock[VERSION]
  const mcData = require('minecraft-data')
  const aliased = mcData(VERSION)
  const bedrock = mcData('bedrock_' + VERSION)
  if (!aliased || !bedrock || aliased === bedrock) return
  aliased.type = bedrock.type
  aliased.version = bedrock.version
  aliased.supportFeature = bedrock.supportFeature
  aliased.isNewerOrEqualTo = bedrock.isNewerOrEqualTo
  aliased.isOlderThan = bedrock.isOlderThan
}

/** Bedrock printf format → prismarine-chat format (`%s`, `%N$s`, `%%`). */
function normalizeFormat (format) {
  if (typeof format !== 'string' || !format.includes('%')) return format
  return format.replace(/%(%|(\d+)\$(?:\.\d+)?[sdfi]|(?:\.\d+)?[sdfi]|(\d+))/g, (match, whole, positional, bare) => {
    if (whole === '%') return '%%'
    if (positional) return `%${positional}$s`
    if (bare) return `%${bare}$s`
    return '%s'
  })
}

const normalizedLanguages = new WeakMap()
function normalizeLanguage (language) {
  if (!language || typeof language !== 'object') return language
  let normalized = normalizedLanguages.get(language)
  if (!normalized) {
    normalized = {}
    for (const [key, value] of Object.entries(language)) normalized[key] = normalizeFormat(value)
    normalizedLanguages.set(language, normalized)
  }
  return normalized
}

/**
 * @param {string} [version] Bedrock version, default '1.26.51'
 * @returns {object} prismarine-registry instance for `bedrock_<version>` (a fresh one per call: start_game /
 *   item_registry mutate it per connection)
 */
function createRegistry (version = VERSION) {
  installDataOverlay()
  const registry = require('prismarine-registry')('bedrock_' + version)
  registry.language = normalizeLanguage(registry.language)
  return registry
}

/**
 * Feed start_game / item_registry into the bot's registry. Must run before the plugins' own listeners
 * (the loader calls it right after creating the client).
 */
function attachRegistry (bot) {
  bot._client.on('start_game', (packet) => {
    bot.registry.handleStartGame(packet)
    if (packet.itemstates?.length) bot._bedrock?.ids?.loadItemRegistry(packet)
  })
  bot._client.on('item_registry', (packet) => {
    bot.registry.handleItemRegistry(packet)
    bot._bedrock?.ids?.loadItemRegistry(packet)
  })
}

module.exports = { installDataOverlay, createRegistry, attachRegistry, normalizeFormat, normalizeLanguage }
