// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * @bedboo/bedrock-data — vendored + generated Bedrock 1.26.51 data overlay for minecraft-data.
 *
 *   require('@bedboo/bedrock-data').install()   // see install.js for the injection contract
 *
 * Sources (U2): minecraft-data PR #1335 (MIT, head b34f7dfed829098a34f16046c9e3f2bd8632bcd6)
 * 1.26.51 blocks/blockStates/blockCollisionShapes/items/materials; CloudburstMC/Data (Apache-2.0,
 * 659ce1e2eee3a67045693f4fd5515c6ccf571953) blocks.json for per-state collision/friction; generated
 * effects/foods/attributes/enchantments/entities/particles/sounds; the Java feature-name table used by
 * mineflayer-bedrock's lib/bedrock/features.js. Attribution goes into this package's NOTICE/README.
 */
const { install, VERSION } = require('./install')

module.exports = {
  install,
  VERSION,
  /** Java feature name → Bedrock value (U2). Empty in U0. */
  features: {}
}
