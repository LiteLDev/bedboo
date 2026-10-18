// owner: U2 (Bedrock data layer)
'use strict'

/**
 * `bot.supportFeature(name)` for Bedrock.
 *
 * mineflayer, its plugins and its tests branch on Java feature names (`supportFeature('tallWorld')`,
 * `'doesntHaveOffHandSlot'`, `'useItemWithOwnPacket'`, …). minecraft-data's Bedrock feature list
 * does not know those names, so U2 provides an explicit Bedrock value for EVERY Java feature name
 * used in mineflayer 4.39.0 `lib/` + `test/` and in the reused ecosystem plugins (table shipped by
 * @bedboo/bedrock-data). A unit test fails on any name used upstream but missing from the table.
 *
 * Contract: `createSupportFeature(registry) → (name: string) => boolean | any`
 *   1. explicit Bedrock table (U2), else
 *   2. `registry.supportFeature(name)` (minecraft-data bedrock features), else false.
 * U0 version: only step 2.
 */

/** Java feature name → Bedrock value. Filled by U2 (or loaded from @bedboo/bedrock-data). */
const FEATURES = {}

function createSupportFeature (registry) {
  return function supportFeature (name) {
    if (Object.prototype.hasOwnProperty.call(FEATURES, name)) return FEATURES[name]
    return registry.supportFeature(name)
  }
}

module.exports = { FEATURES, createSupportFeature }
