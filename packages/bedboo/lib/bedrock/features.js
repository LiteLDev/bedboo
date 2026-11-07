'use strict'

/**
 * `bot.supportFeature(name)` for Bedrock.
 *
 * mineflayer, its plugins and its tests branch on Java feature names (`supportFeature('tallWorld')`,
 * `'doesntHaveOffHandSlot'`, `'useItemWithOwnPacket'`, …). minecraft-data's Bedrock feature list does not
 * know those names, so @bedboo/bedrock-data ships an explicit Bedrock value for EVERY Java feature name used
 * in mineflayer 4.39.0 `lib/` + `examples/` + `test/`, the reused ecosystem plugins and the prismarine-* modules, plus
 * every minecraft-data Bedrock feature (packages/bedrock-data/features.js, which documents the choices).
 * A unit test fails on any name used upstream but missing here.
 *
 * Contract: `createSupportFeature(registry, { strict, version }) → supportFeature(name)`
 *   - the table is the one of `version`, else of `registry.version.minecraftVersion` (bedrock-data
 *     `featuresFor(version)`); without either, or for a version bedrock-data has no table for, the default
 *     version's {@link FEATURES};
 *   - a name in the table → its value (same value types as minecraft-data: boolean, string, number);
 *   - any other name → `false`, after a one-time warning per name (an upstream name we have not decided on);
 *     with `strict` (default: env `BEDBOO_STRICT_FEATURES=1`) it throws instead, so tests catch new names.
 *   `registry` is optional (symmetry with minecraft-data's `supportFeature`). Test runners should set
 *   `BEDBOO_STRICT_FEATURES=1` so a name missed by the static scan fails loudly.
 * The loader assigns it to `bot.supportFeature` (and may assign it to `bot.registry.supportFeature`: the table
 * agrees with minecraft-data on every Bedrock name, so prismarine-* keep working).
 */
const bedrockData = require('@bedboo/bedrock-data')
const { features: FEATURES } = bedrockData
const { findFamily } = require('./versions')

const warned = new Set()

/**
 * @param {string} [version] Bedrock version: a family or BDS build (lib/bedrock/versions.js), optionally 'bedrock_'-prefixed
 * @returns {object} the feature table of its family (bedrock-data `featuresFor`); the default {@link FEATURES} when
 *   bedrock-data has no table for it (no version, an unknown one, or a family without data)
 */
function featureTable (version) {
  if (typeof version !== 'string' || typeof bedrockData.featuresFor !== 'function') return FEATURES
  const family = findFamily(version)?.version ?? version.replace(/^bedrock_/, '')
  try {
    return bedrockData.featuresFor(family)
  } catch {
    return FEATURES
  }
}

function createSupportFeature (registry, { strict = process.env.BEDBOO_STRICT_FEATURES === '1', version } = {}) {
  const table = featureTable(version ?? registry?.version?.minecraftVersion)
  return function supportFeature (name) {
    if (Object.prototype.hasOwnProperty.call(table, name)) return table[name]
    if (strict) throw new Error(`bedboo: unknown feature '${name}' (add it to packages/bedrock-data/features.js)`)
    if (!warned.has(name)) {
      warned.add(name)
      process.emitWarning(`unknown feature '${name}' treated as unsupported on Bedrock`, { code: 'BEDBOO_UNKNOWN_FEATURE' })
    }
    return false
  }
}

module.exports = { FEATURES, createSupportFeature, featureTable }
