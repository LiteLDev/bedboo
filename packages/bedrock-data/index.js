'use strict'

/**
 * @bedboo/bedrock-data — vendored + generated Bedrock data overlays for minecraft-data, one per data version
 * (`data/<version>/`, a minecraft-data Bedrock version key such as 1.26.51).
 *
 *   require('@bedboo/bedrock-data').install()   // overlays every data/<version>/; see install.js for the contract
 *   require('@bedboo/bedrock-data').versions    // ['1.26.51', …]: the data versions shipped
 *   require('@bedboo/bedrock-data').featuresFor('1.26.51')
 *
 * Datasets (data/<version>/, one file per dataset, auto-discovered by install()): blocks, blockStates,
 * blockCollisionShapes, items, materials (minecraft-data PR #1335, MIT, b34f7dfed829098a34f16046c9e3f2bd8632bcd6,
 * with CloudburstMC/Data 659ce1e2eee3a67045693f4fd5515c6ccf571953 (Apache-2.0) friction, collision and
 * runtime-id fixes), foods, effects, enchantments, attributes, entities, particles, sounds, biomes (vanilla
 * numeric ids from pmmp/BedrockData, CC0) (generated; the pins of each version are in scripts/sources.js).
 * Regenerate with `corepack pnpm --filter @bedboo/bedrock-data generate [--version <v>]` (scripts/generate.js).
 * Sources and attribution: NOTICE.md.
 *
 * VERSION, features and bedrockFeatures describe the default version, 1.26.51.
 */
const { install, VERSION, versions } = require('./install')
const { FEATURES, BEDROCK_FEATURES, featuresFor, bedrockFeaturesFor } = require('./features')

module.exports = {
  install,
  VERSION,
  /** data versions shipped in data/ (minecraft-data Bedrock version keys), sorted oldest first */
  versions,
  /** Java feature name → Bedrock value for one data version (throws for a version without data) */
  featuresFor,
  /** minecraft-data's own Bedrock feature names with their values for one data version */
  bedrockFeaturesFor,
  /** Java feature name → Bedrock value for 1.26.51 (see features.js; used by bedboo lib/bedrock/features.js) */
  features: FEATURES,
  /** same table as `features` (the name the multi-version contract C1 uses) */
  FEATURES,
  /** minecraft-data's own Bedrock feature names with their 1.26.51 values */
  bedrockFeatures: BEDROCK_FEATURES
}
