// owner: U4 (core runtime)
'use strict'
const { VERSION } = require('./bedrock/constants')

/**
 * bedrock-protocol client wrapper used by createBot when `options.client` is not given.
 *
 * Defaults (verified by the U0 spike against BDS 1.26.51.1, see docs/testing.md):
 * - `offline: true`              BDS runs with online-mode=false in tests; pass `offline: false`
 *                                (+ `profilesFolder`/`authTitle`/`flow`) for Xbox auth
 * - `transport: 'raknet'`        RakNet works on 1.26.51.1 with `transport=raknet` in server.properties
 * - `raknetBackend: 'raknet-native'` (patched to load its bundled prebuild); jsp-raknet is rejected by
 *                                BDS (RakNet protocol 11 vs 10)
 * - `version: '1.26.51'`         mineflayer's `version: false` means "auto" → 1.26.51
 * - `skipPing: true`             BDS with enable-lan-visibility=false does not answer unconnected
 *                                pings, discovery would only add a 1 s timeout
 * - `host: '127.0.0.1'`, `port: 19132`
 *
 * U4 completes this (auth options, conLog routing, `end()` alias, …).
 */

const DEFAULTS = {
  host: '127.0.0.1',
  port: 19132,
  offline: true,
  transport: 'raknet',
  raknetBackend: 'raknet-native',
  skipPing: true
}

/**
 * @param {object} options mineflayer createBot options (bedrock-protocol ClientOptions + mineflayer options)
 * @returns {import('bedrock-protocol').Client}
 */
function createClient (options) {
  const bedrock = require('bedrock-protocol')
  const clientOptions = { ...DEFAULTS }
  for (const [key, value] of Object.entries(options)) {
    // keep explicit nulls (e.g. `conLog: null` disables bedrock-protocol's console logging)
    if (value !== undefined) clientOptions[key] = value
  }
  clientOptions.version = options.version || VERSION
  return bedrock.createClient(clientOptions)
}

module.exports = { createClient, DEFAULTS }
