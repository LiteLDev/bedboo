// owner: U4 (core runtime)
'use strict'
const { stubSync } = require('./errors')

/**
 * Self entity data. U4 applies the LOCAL player's packets to `bot.entity`; U7 (entities.js)
 * handles every other entity and must skip the local runtime id.
 *
 * Packets: update_attributes, set_health, mob_effect, set_entity_data, set_entity_motion.
 *
 * - Attributes are stored on `bot.entity.attributes` keyed by Java resource names
 *   (`minecraft:movement_speed`, `minecraft:generic.max_health`-style names as in mineflayer/
 *   prismarine-entity for the bot's registry), value `{ value, modifiers: [] }`.
 *   {@link ATTRIBUTE_NAMES} maps Bedrock attribute names to those keys.
 * - Effects are stored on `bot.entity.effects` keyed by Bedrock effect id
 *   `{ id, amplifier, duration }`; names come from `bot.registry.effects` (bedrock-data overlay, U2).
 * - `set_entity_data` (metadata) flags: sneaking, sprinting, swimming, gliding, on fire, air supply
 *   (→ `bot.oxygenLevel` + `breath` event), …
 *
 * Contract (each takes `(bot, packet)`, returns nothing, emits the mineflayer events of the change):
 * - `applyAttributes`, `applyHealth`, `applyEffect`, `applyMetadata`, `applyMotion`
 */

/** Bedrock attribute name → mineflayer (Java) attribute key. Completed by U4. */
const ATTRIBUTE_NAMES = {
  'minecraft:movement': 'minecraft:movement_speed',
  'minecraft:health': 'minecraft:max_health',
  'minecraft:attack_damage': 'minecraft:attack_damage',
  'minecraft:follow_range': 'minecraft:follow_range',
  'minecraft:knockback_resistance': 'minecraft:knockback_resistance',
  'minecraft:absorption': 'minecraft:max_absorption'
}

module.exports = {
  ATTRIBUTE_NAMES,
  applyAttributes: stubSync('U4', 'entity_data.applyAttributes', 2),
  applyHealth: stubSync('U4', 'entity_data.applyHealth', 2),
  applyEffect: stubSync('U4', 'entity_data.applyEffect', 2),
  applyMetadata: stubSync('U4', 'entity_data.applyMetadata', 2),
  applyMotion: stubSync('U4', 'entity_data.applyMotion', 2)
}
