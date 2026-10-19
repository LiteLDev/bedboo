// owner: U4 (core runtime) → U16b (wave 5: transport options); U17 minimal fix: offline SelfSignedId
'use strict'
const crypto = require('crypto')
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
 * Transports (U16b):
 * - `transport: 'raknet'` (default) — BDS must run with `transport=raknet` (BDS 1.26.51 still ships it;
 *   Mojang announced its removal, possibly in 26.60).
 * - `transport: 'nethernet'` — BDS's default transport (WebRTC data channels). Signalling defaults to
 *   **HTTP on the server port** (`POST http://host:port/v1/join/<id>`, works with enable-lan-visibility=false;
 *   PrismarineJS/bedrock-protocol#831 + node-nethernet#32, backported as pnpm patches). Options under
 *   `nethernet`: `signalling` ('http' default, 'lan' = UDP 7551 discovery, 'services' = Xbox signalling),
 *   `url` (signalling origin, default `http://host:port`), `serverKey` ('sha256:<hex>' pin of the server's
 *   identity key), `onServerKey(fingerprint, url) → boolean` (approve an unpinned key), `networkId`,
 *   `webrtcBackend`, `signallingConnectTimeout`. Without `serverKey`/`onServerKey` an unpinned plain-HTTP key
 *   is accepted (the server is no more authenticated than over RakNet); pin it to reject anything else.
 *
 * Authentication follows mineflayer's options:
 * - `auth: 'offline'` (default) — no Xbox Live; `username` is the player name
 * - `auth: 'microsoft'` — Xbox Live through bedrock-protocol / prismarine-auth; `profilesFolder`,
 *   `onMsaCode`, `authTitle`, `flow`, `deviceType` are passed through unchanged (prismarine-auth options,
 *   identical to mineflayer's microsoft auth)
 * - `auth: 'mojang'` does not exist on Bedrock and throws
 * An explicit bedrock-protocol `offline` option wins over `auth`.
 *
 * Offline players keep their saved data (U17): BDS keys an offline (xuid 0) player's data — inventory, position,
 * spawn point, … — by the client's `SelfSignedId`, which bedrock-protocol randomizes for every connection, so each
 * rejoin was a brand-new player. Like Java's offline-mode UUIDs it is derived from the username here
 * (`offlineSelfSignedId`); `skinData.SelfSignedId` overrides it.
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

const TRANSPORTS = ['raknet', 'nethernet']
const SIGNALLING = ['http', 'lan', 'services']

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
 * bedrock-protocol `nethernet` options for `transport: 'nethernet'` (HTTP signalling unless told otherwise).
 * @param {object} clientOptions resolved client options (mutated: `skipPing` for LAN discovery)
 * @param {object} options the caller's options
 */
function nethernetOptions (clientOptions, options) {
  const given = options.nethernet ?? {}
  if (typeof given !== 'object') throw new TypeError('nethernet options must be an object')
  const nethernet = { signalling: 'http' }
  // like the top-level options: an explicit undefined / null keeps the default
  for (const [key, value] of Object.entries(given)) if (value !== undefined && value !== null) nethernet[key] = value
  if (!SIGNALLING.includes(nethernet.signalling)) {
    throw new Error(`unsupported nethernet.signalling '${nethernet.signalling}' (${SIGNALLING.join(', ')})`)
  }
  if (nethernet.signalling === 'http' && nethernet.serverKey === undefined && nethernet.onServerKey === undefined) {
    // Plain-HTTP signalling cannot authenticate the server by itself (bedrock-protocol#831 rejects an unpinned key
    // unless the application approves it). Accept it, as RakNet does (its handshake key is not pinned either);
    // `serverKey` pins it, `onServerKey` decides.
    nethernet.onServerKey = () => true
  }
  // LAN signalling needs the server's network id: discover it (UDP 7551) unless one was given.
  if (nethernet.signalling === 'lan' && nethernet.networkId == null && options.skipPing === undefined) clientOptions.skipPing = false
  return nethernet
}

/**
 * Java's offline-mode player UUID (`UUID.nameUUIDFromBytes("OfflinePlayer:" + name)`, version 3) — stable per username.
 * @param {string} username
 */
function offlineSelfSignedId (username) {
  const b = crypto.createHash('md5').update(`OfflinePlayer:${username}`, 'utf8').digest()
  b[6] = (b[6] & 0x0f) | 0x30
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
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
  if (!TRANSPORTS.includes(clientOptions.transport)) {
    throw new Error(`unsupported transport '${clientOptions.transport}': use 'raknet' (default) or 'nethernet'`)
  }
  if (clientOptions.transport === 'nethernet') clientOptions.nethernet = nethernetOptions(clientOptions, options)
  if (clientOptions.offline && typeof clientOptions.username === 'string') {
    clientOptions.skinData = { SelfSignedId: offlineSelfSignedId(clientOptions.username), ...clientOptions.skinData }
  }
  return bedrock.createClient(clientOptions)
}

module.exports = { createClient, offlineFromAuth, offlineSelfSignedId, DEFAULTS, TRANSPORTS }
