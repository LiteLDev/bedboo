// owner: U2 (wave 1) → U9 (wave 3) → U10 (wave 4)
'use strict'

/**
 * `bot.supportFeature(name)` for Bedrock.
 *
 * mineflayer, its plugins and its tests branch on Java feature names (`supportFeature('tallWorld')`,
 * `'doesntHaveOffHandSlot'`, `'useItemWithOwnPacket'`, …). minecraft-data's Bedrock feature list does not
 * know those names, so @bedboo/bedrock-data ships an explicit Bedrock value for EVERY Java feature name used
 * in mineflayer 4.39.0 `lib/` + `test/`, the reused ecosystem plugins and the prismarine-* modules, plus
 * every minecraft-data Bedrock feature (packages/bedrock-data/features.js; choices documented in
 * docs/differences/U2.md#feature-table). A unit test fails on any name used upstream but missing here.
 *
 * Contract: `createSupportFeature(registry, { strict }) → supportFeature(name)`
 *   - a name in {@link FEATURES} → its value (same value types as minecraft-data: boolean, string, number);
 *   - any other name → `false`, after a one-time warning per name (an upstream name we have not decided on);
 *     with `strict` (default: env `BEDBOO_STRICT_FEATURES=1`) it throws instead, so tests catch new names.
 *   `registry` is accepted for symmetry with minecraft-data's `supportFeature` (the table is for
 *   bedrock_1.26.51, the only supported version).
 * U4 assigns it to `bot.supportFeature` (and may assign it to `bot.registry.supportFeature`: the table
 * agrees with minecraft-data on every Bedrock name, so prismarine-* keep working).
 */
const { features: FEATURES } = require('@bedboo/bedrock-data')

const warned = new Set()

function createSupportFeature (registry, { strict = process.env.BEDBOO_STRICT_FEATURES === '1' } = {}) {
  return function supportFeature (name) {
    if (Object.prototype.hasOwnProperty.call(FEATURES, name)) return FEATURES[name]
    if (strict) throw new Error(`mineflayer-bedrock: unknown feature '${name}' (add it to packages/bedrock-data/features.js)`)
    if (!warned.has(name)) {
      warned.add(name)
      process.emitWarning(`unknown feature '${name}' treated as unsupported on Bedrock`, { code: 'BEDBOO_UNKNOWN_FEATURE' })
    }
    return false
  }
}

module.exports = { FEATURES, createSupportFeature }
