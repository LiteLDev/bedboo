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
 * U4 completes `createRegistry` with start_game + item_registry wiring:
 *   - item palette (`item_registry.itemstates`) → registry items by network id (prismarine-registry patch, U2)
 *   - `block_network_ids_are_hashes` → hashed block runtime ids
 */

let overlayInstalled = false

/** Install the bedrock-data overlay into minecraft-data (idempotent). */
function installDataOverlay () {
  if (overlayInstalled) return
  overlayInstalled = true
  require('@bedboo/bedrock-data').install()
}

/**
 * @param {string} [version] Bedrock version, default '1.26.51'
 * @returns {object} prismarine-registry instance for `bedrock_<version>`
 */
function createRegistry (version = VERSION) {
  installDataOverlay()
  return require('prismarine-registry')('bedrock_' + version)
}

module.exports = { installDataOverlay, createRegistry }
