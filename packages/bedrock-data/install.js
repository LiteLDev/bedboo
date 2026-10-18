// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * Injects the Bedrock 1.26.51 data overlay into minecraft-data.
 *
 * INJECTION CONTRACT
 * - Must run before anything calls `require('minecraft-data')('bedrock_1.26.51')`: minecraft-data
 *   caches the version object on first use, and bedrock-protocol / prismarine-registry /
 *   prismarine-chunk / prismarine-block call it while loading. mineflayer-bedrock's `index.js` calls
 *   `install()` as its very first statement; tests and tools that use bedrock-protocol or prismarine-*
 *   directly must call it first too.
 * - Idempotent: a second call is a no-op and returns the same result.
 * - Mechanism (U2): redefine the lazy getters of minecraft-data's `bedrock_1.26.51` entry (one overlay
 *   file per dataset under `data/1.26.51/`, auto-discovered — blocks, blockStates, blockCollisionShapes,
 *   items, materials, effects, foods, attributes, enchantments, entities, particles, sounds, features,
 *   …) so every consumer — including copies required from other packages' directories — sees the
 *   overlay, because pnpm `overrides` guarantee a single minecraft-data@3.117.0 instance.
 * - Must never touch Java (`pc`) data.
 *
 * @returns {{ installed: boolean, version: string, datasets: string[] }}
 */

const VERSION = '1.26.51'
let result = null

function install () {
  if (result) return result
  // U0 stub: no datasets yet — minecraft-data 3.117.0's own bedrock_1.26.51 data is used as-is.
  result = { installed: true, version: VERSION, datasets: [] }
  return result
}

module.exports = { install, VERSION }
