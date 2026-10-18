// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * @bedboo/bedrock-data — vendored + generated Bedrock 1.26.51 data overlay for minecraft-data.
 *
 *   require('@bedboo/bedrock-data').install()   // see install.js for the injection contract
 *
 * Datasets (data/1.26.51/, one file per dataset, auto-discovered by install()): blocks, blockStates,
 * blockCollisionShapes, items, materials (minecraft-data PR #1335, MIT, b34f7dfed829098a34f16046c9e3f2bd8632bcd6,
 * with CloudburstMC/Data 659ce1e2eee3a67045693f4fd5515c6ccf571953 (Apache-2.0) friction, collision and
 * runtime-id fixes), foods, effects, enchantments, attributes, entities, particles, sounds, biomes (vanilla
 * numeric ids from pmmp/BedrockData, CC0) (generated).
 * Regenerate with `corepack pnpm --filter @bedboo/bedrock-data generate` (scripts/generate.js). Sources and
 * attribution: NOTICE.md.
 */
const { install, VERSION } = require('./install')
const { FEATURES, BEDROCK_FEATURES } = require('./features')

module.exports = {
  install,
  VERSION,
  /** Java feature name → Bedrock value (see features.js; used by mineflayer-bedrock lib/bedrock/features.js) */
  features: FEATURES,
  /** minecraft-data's own Bedrock feature names with their 1.26.51 values */
  bedrockFeatures: BEDROCK_FEATURES
}
