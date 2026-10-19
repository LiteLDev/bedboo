// owner: U10 (digging)
'use strict'

/**
 * Bedrock block breaking speed (BDS 1.26.51.1), exposed for `bot.digTime` (lib/plugins/digging.js).
 *
 * Same structure as prismarine-block's `Block#digTime` (Java's AbstractBlock#calcBlockBreakingDelta), with the
 * Bedrock status-effect factors. Every factor was measured on BDS through `level_event block_start_break`, whose
 * `data` is the server's progress per tick × 65535 (floored) — see docs/differences/U10.md#dig-speed:
 *
 *   speed  = tool multiplier (registry.materials[block.material][heldItemType]) or 1
 *   speed += efficiency² + 1                       when efficiency > 0 and speed > 1           (= Java)
 *   speed *= (1 + 0.2·h) · 1.2^h                   h = max(Haste, Conduit Power) level         (Java: 1 + 0.2·h)
 *   speed *= 0.21^f                                f = Mining Fatigue level                    (Java: 0.3, 0.09, 0.0027, 8.1e-4)
 *   speed /= 5                                     eye in water without Aqua Affinity          (= Java)
 *   speed /= 5                                     not on ground                               (= Java)
 *   delta  = speed / hardness / (canHarvest ? 30 : 100)    progress per tick                   (= Java)
 *
 * The server completes a held break in the tick its summed progress reaches 1 — the start tick counts — so a
 * break takes `ceil(1 / delta)` ticks: `digTime = ticks × 50 ms` exactly like prismarine-block (0 when
 * delta ≥ 1, Infinity when delta is 0, e.g. hardness -1). Without Haste / Conduit Power / Mining Fatigue the result
 * equals prismarine-block's `digTime` for every block and tool (unit-tested).
 *
 * Contract:
 * - `breakDelta(registry, block, { heldItemType, inWater, notOnGround, enchantments, effects }) → number`
 * - `digTime(registry, block, { heldItemType, creative, inWater, notOnGround, enchantments, effects }) → ms`
 *   (creative: 0, or Infinity with a sword / the trident / the mace — `breaksInCreative(registry, itemType)`)
 * - `ticksFor(delta) → number` ticks of a break (0 for an instant break, Infinity when it never ends)
 * - `speedData(delta) → number` the `level_event` data BDS sends for that speed (floor(delta × 65535); 65535 for
 *   hardness 0, whose delta is Infinity)
 */

const TICK_MS = 50
/** level_event block_start_break / block_break_speed data scale */
const SPEED_SCALE = 65535

function enchantmentLevel (registry, name, enchantments) {
  if (!registry.enchantmentsByName?.[name]) return 0
  for (const ench of enchantments ?? []) {
    if (typeof ench?.name === 'string' && ench.name.includes(name)) return ench.lvl
  }
  return 0
}

function effectLevel (registry, name, effects) {
  const descriptor = registry.effectsByName?.[name]
  if (!descriptor || !effects) return 0
  const effect = effects[descriptor.id]
  if (!effect) return 0
  return effect.amplifier + 1
}

function canHarvest (block, heldItemType) {
  if (typeof block.canHarvest === 'function') return !!block.canHarvest(heldItemType)
  if (!block.harvestTools) return true
  return !!(heldItemType && block.harvestTools[heldItemType])
}

/**
 * Progress per tick of breaking `block` (1 = broken in one tick).
 * @param {object} registry
 * @param {object} block prismarine-block Block (hardness, material, harvestTools)
 * @param {{ heldItemType?: number|null, inWater?: boolean, notOnGround?: boolean, enchantments?: object[], effects?: object }} [opts]
 */
function breakDelta (registry, block, { heldItemType = null, inWater = false, notOnGround = false, enchantments = [], effects = {} } = {}) {
  const hardness = block.hardness
  if (hardness === -1 || hardness === null || hardness === undefined) return 0
  const multipliers = registry.materials?.[block.material]
  let speed = 1
  if (heldItemType && multipliers && multipliers[heldItemType]) speed = multipliers[heldItemType]

  const efficiency = enchantmentLevel(registry, 'efficiency', enchantments)
  if (efficiency > 0 && speed > 1) speed += efficiency * efficiency + 1

  const haste = Math.max(effectLevel(registry, 'Haste', effects), effectLevel(registry, 'ConduitPower', effects))
  if (haste > 0) speed *= (1 + 0.2 * haste) * Math.pow(1.2, haste)

  const fatigue = effectLevel(registry, 'MiningFatigue', effects)
  if (fatigue > 0) speed *= Math.pow(0.21, fatigue)

  if (inWater && enchantmentLevel(registry, 'aqua_affinity', enchantments) === 0) speed /= 5
  if (notOnGround) speed /= 5

  return speed / hardness / (canHarvest(block, heldItemType) ? 30 : 100)
}

/** ticks a break with this per-tick progress takes (the start tick included) */
function ticksFor (delta) {
  if (!(delta > 0)) return Infinity
  if (delta >= 1) return 0
  return Math.ceil(1 / delta)
}

/**
 * Whether a creative player can break blocks holding this item: not with a sword, the trident or the mace
 * (BDS 1.26.51.1 restores the block; spears and everything else break instantly).
 */
function breaksInCreative (registry, heldItemType) {
  const name = heldItemType ? registry.items?.[heldItemType]?.name : null
  return !(name && (name.endsWith('_sword') || name === 'trident' || name === 'mace'))
}

/**
 * Milliseconds to break `block` (prismarine-block `digTime` semantics: 0 = instant, Infinity = never).
 * @param {object} registry
 * @param {object} block
 * @param {{ heldItemType?: number|null, creative?: boolean, inWater?: boolean, notOnGround?: boolean, enchantments?: object[], effects?: object }} [opts]
 */
function digTime (registry, block, opts = {}) {
  if (opts.creative) return breaksInCreative(registry, opts.heldItemType) ? 0 : Infinity
  const ticks = ticksFor(breakDelta(registry, block, opts))
  return ticks === Infinity ? Infinity : ticks * TICK_MS
}

/** the `level_event` speed data BDS reports for a per-tick progress (hardness 0: BDS reports 1.0) */
function speedData (delta) {
  if (!Number.isFinite(delta)) return SPEED_SCALE
  return Math.floor(delta * SPEED_SCALE)
}

module.exports = { breakDelta, digTime, ticksFor, speedData, breaksInCreative, effectLevel, enchantmentLevel, SPEED_SCALE, TICK_MS }
