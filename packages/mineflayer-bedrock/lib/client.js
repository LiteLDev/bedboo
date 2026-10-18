// owner: U4 (core runtime)
'use strict'
const { VERSION } = require('./bedrock/constants')

/**
 * bedrock-protocol client wrapper used by createBot when `options.client` is not given.
 *
 * Defaults (verified by the U0 spike against BDS 1.26.51.1, see docs/testing.md):
 * - `auth: 'offline'`            → bedrock-protocol `offline: true` (BDS runs with online-mode=false in tests)
 * - `transport: 'raknet'`        RakNet works on 1.26.51.1 with `transport=raknet` in server.properties
 * - `raknetBackend: 'raknet-native'` (patched to load its bundled prebuild); jsp-raknet is rejected by
 *                                BDS (RakNet protocol 11 vs 10)
 * - `version: '1.26.51'`         mineflayer's `version: false` means "auto" → 1.26.51
 * - `skipPing: true`             BDS with enable-lan-visibility=false does not answer unconnected
 *                                pings, discovery would only add a 1 s timeout
 * - `host: '127.0.0.1'`, `port: 19132`
 * - `conLog: null`               bedrock-protocol logs connection events to the console by default;
 *                                mineflayer prints nothing (pass `conLog: console.log` to get them)
 *
 * Authentication follows mineflayer's options:
 * - `auth: 'offline'` (default) — no Xbox Live; `username` is the player name
 * - `auth: 'microsoft'` — Xbox Live through bedrock-protocol / prismarine-auth; `profilesFolder`,
 *   `onMsaCode`, `authTitle`, `flow`, `deviceType` are passed through unchanged (prismarine-auth options,
 *   identical to mineflayer's microsoft auth)
 * - `auth: 'mojang'` does not exist on Bedrock and throws
 * An explicit bedrock-protocol `offline` option wins over `auth`.
 */

const DEFAULTS = {
  host: '127.0.0.1',
  port: 19132,
  offline: true,
  transport: 'raknet',
  raknetBackend: 'raknet-native',
  skipPing: true,
  conLog: null
}

/** mineflayer-only options that must not reach bedrock-protocol (they mean something else there or nothing). */
const MINEFLAYER_ONLY = new Set(['client', 'plugins', 'auth', 'viewDistance', 'brand', 'respawn', 'chat', 'physicsEnabled', 'maxCatchupTicks'])

/**
 * @param {string|undefined} auth mineflayer `auth` option
 * @returns {boolean} bedrock-protocol `offline`
 */
function offlineFromAuth (auth) {
  if (auth === undefined || auth === null || auth === 'offline') return true
  if (auth === 'microsoft') return false
  if (auth === 'mojang') throw new Error("auth 'mojang' does not exist on Bedrock: use 'microsoft' (Xbox Live) or 'offline'")
  throw new Error(`unsupported auth '${typeof auth === 'function' ? 'function' : auth}': use 'microsoft' or 'offline'`)
}

/**
 * @param {object} options mineflayer createBot options (bedrock-protocol ClientOptions + mineflayer options)
 * @returns {import('bedrock-protocol').Client}
 */
function createClient (options) {
  const bedrock = require('bedrock-protocol')
  const clientOptions = { ...DEFAULTS }
  for (const [key, value] of Object.entries(options)) {
    if (MINEFLAYER_ONLY.has(key)) continue
    // keep explicit nulls (e.g. `conLog: null` disables bedrock-protocol's console logging)
    if (value !== undefined) clientOptions[key] = value
  }
  clientOptions.offline = options.offline ?? offlineFromAuth(options.auth)
  clientOptions.version = options.version || VERSION
  if (typeof clientOptions.port === 'string') clientOptions.port = parseInt(clientOptions.port, 10)
  return bedrock.createClient(clientOptions)
}

module.exports = { createClient, offlineFromAuth, DEFAULTS }
