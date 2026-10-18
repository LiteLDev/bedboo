// owner: U4 (core runtime)
'use strict'

/**
 * Self entity data. U4 applies the LOCAL player's packets to `bot.entity` (lib/plugins/entities.js
 * routes them here); U7 (entities.js, wave 3) handles every other entity and must skip the local
 * runtime id. The functions are pure enough to be reused by U7 for other entities (they only touch the
 * entity passed in / `bot.entity` and emit mineflayer entity events).
 *
 * Packets: update_attributes, set_health, mob_effect, set_entity_data, set_entity_motion.
 *
 * - Attributes are stored on `entity.attributes` keyed by Java resource names
 *   (`minecraft:movement_speed`, `minecraft:max_health`, … — the `resource` of the U2 attributes dataset,
 *   `registry.attributesArray[i].bedrockName` is the update_attributes name), value
 *   `{ value, modifiers: [{ uuid, amount, operation, name }], current, min, max, default }` where `value` is the
 *   BASE value like Java (Bedrock's `current` already includes the modifiers; the base is recovered by
 *   inverting the Java modifier formula) and for `minecraft:health` → `minecraft:max_health` the max health.
 *   Bedrock-only attributes (player.hunger, player.saturation, underwater_movement, …) keep their Bedrock
 *   name as key. Emits `entityAttributes(entity)`.
 * - Effects are stored on `entity.effects` keyed by Bedrock effect id `{ id, amplifier, duration }`; names come
 *   from `bot.registry.effects` (bedrock-data overlay, U2). Emits `entityEffect` / `entityEffectEnd`.
 * - `set_entity_data` (metadata): `entity.metadata[<bedrock key name>] = value` (Bedrock metadata keys are
 *   names such as `flags`, `flags_extended`, `air`, `nametag`, not Java indexes; stored as named properties of
 *   prismarine-entity's metadata array). Flags: `sneaking` →
 *   `entity.crouching` (+ `entityCrouch` / `entityUncrouch`), `gliding` → `entity.elytraFlying`
 *   (+ `entityElytraFlew`), `sleeping` (flags_extended) → `entitySleep` / `entityWake`, `sprinting` →
 *   `entity.sprinting`, `swimming` → `entity.swimming`, `onfire` → `entity.onFire`. Emits `entityUpdate(entity)`.
 * - `set_health`: `entity.health` (the bot's own `bot.health` / `health` event belong to health.js, U9).
 * - `set_entity_motion`: `entity.velocity` (blocks per tick, as mineflayer).
 *
 * Contract (each takes `(bot, packet, entity = bot.entity)`, returns nothing, emits the mineflayer events of the change):
 * - `applyAttributes`, `applyHealth`, `applyEffect`, `applyMetadata`, `applyMotion`
 */

/** Bedrock attribute name → mineflayer (Java) attribute key, for the attributes Java also has. */
const ATTRIBUTE_NAMES = {
  'minecraft:movement': 'minecraft:movement_speed',
  'minecraft:health': 'minecraft:max_health',
  'minecraft:attack_damage': 'minecraft:attack_damage',
  'minecraft:follow_range': 'minecraft:follow_range',
  'minecraft:knockback_resistance': 'minecraft:knockback_resistance',
  'minecraft:absorption': 'minecraft:max_absorption',
  'minecraft:luck': 'minecraft:luck',
  'minecraft:horse.jump_strength': 'minecraft:jump_strength',
  'minecraft:zombie.spawn_reinforcements': 'minecraft:spawn_reinforcements'
}

const attributeMaps = new WeakMap()
/** Bedrock attribute name → resource key, from the registry (U2 dataset) with ATTRIBUTE_NAMES as fallback. */
function attributeKeys (registry) {
  let map = registry ? attributeMaps.get(registry) : null
  if (map) return map
  map = new Map(Object.entries(ATTRIBUTE_NAMES))
  for (const attr of registry?.attributesArray ?? []) {
    if (attr.bedrockName && attr.resource) map.set(attr.bedrockName, attr.resource)
  }
  if (registry) attributeMaps.set(registry, map)
  return map
}

/** Java attribute base value from Bedrock's current value (inverse of base → modifiers). */
function baseValue (current, modifiers) {
  let add = 0
  let multiplyBase = 0
  let multiplyTotal = 1
  for (const m of modifiers) {
    if (m.operation === 0) add += m.amount
    else if (m.operation === 1) multiplyBase += m.amount
    else if (m.operation === 2) multiplyTotal *= 1 + m.amount
  }
  const factor = (1 + multiplyBase) * multiplyTotal
  if (!modifiers.length || factor === 0) return current
  return current / factor - add
}

function applyAttributes (bot, packet, entity = bot.entity) {
  if (!entity) return
  if (!entity.attributes) entity.attributes = {}
  const keys = attributeKeys(bot.registry)
  for (const attr of packet.attributes ?? []) {
    const key = keys.get(attr.name) ?? attr.name
    const modifiers = (attr.modifiers ?? []).map(m => ({ uuid: m.id, amount: m.amount, operation: m.operation, name: m.name }))
    const value = attr.name === 'minecraft:health' ? attr.max : baseValue(attr.current, modifiers)
    entity.attributes[key] = { value, modifiers, current: attr.current, min: attr.min, max: attr.max, default: attr.default }
  }
  bot.emit('entityAttributes', entity)
}

function applyHealth (bot, packet, entity = bot.entity) {
  if (!entity) return
  entity.health = packet.health
}

function applyEffect (bot, packet, entity = bot.entity) {
  if (!entity) return
  if (!entity.effects) entity.effects = {}
  const id = packet.effect_id
  if (packet.event_id === 'remove') {
    let effect = entity.effects[id]
    if (effect) delete entity.effects[id]
    else effect = { id, amplifier: -1, duration: -1 }
    bot.emit('entityEffectEnd', entity, effect)
    return
  }
  // 'add' / 'modify'
  const effect = { id, amplifier: packet.amplifier, duration: packet.duration }
  entity.effects[id] = effect
  bot.emit('entityEffect', entity, effect)
}

function setElytraFlying (bot, entity, flying) {
  const started = flying && !entity.elytraFlying
  entity.elytraFlying = flying
  if (!flying && entity === bot.entity && bot.fireworkRocketDuration) bot.fireworkRocketDuration = 0
  if (started) bot.emit('entityElytraFlew', entity)
}

function applyMetadata (bot, packet, entity = bot.entity) {
  if (!entity) return
  // prismarine-entity's metadata is an array (Java indexes); Bedrock keys are names, kept as named properties
  if (!entity.metadata) entity.metadata = []
  for (const { key, value } of packet.metadata ?? []) entity.metadata[key] = value
  bot.emit('entityUpdate', entity)

  const entry = (name) => packet.metadata?.find(m => m.key === name)?.value
  const flags = entry('flags')
  if (flags && typeof flags === 'object') {
    if (flags.sneaking) {
      entity.crouching = true
      bot.emit('entityCrouch', entity)
    } else if (entity.crouching) { // like upstream: no uncrouch for the initial metadata
      entity.crouching = false
      bot.emit('entityUncrouch', entity)
    }
    entity.sprinting = !!flags.sprinting
    entity.swimming = !!flags.swimming
    entity.onFire = !!flags.onfire
    setElytraFlying(bot, entity, !!flags.gliding)
  }
  const extended = entry('flags_extended')
  // players: BDS 1.26.51 reports sleep in player_flags (bit 1), not in flags_extended (U7 fix, observed live); once
  // player_flags were seen, flags_extended no longer decides (a flags_extended-only update must not wake the player)
  const playerFlags = entry('player_flags')
  if (playerFlags !== undefined) playerFlagEntities.add(entity)
  let sleeping
  if (playerFlags !== undefined) sleeping = (Number(playerFlags) & 2) !== 0
  else if (extended && typeof extended === 'object' && !playerFlagEntities.has(entity)) sleeping = !!extended.sleeping
  if (sleeping !== undefined) {
    if (sleeping && !entity.sleeping) bot.emit('entitySleep', entity)
    else if (!sleeping && entity.sleeping) bot.emit('entityWake', entity)
    entity.sleeping = sleeping
  }
}
const playerFlagEntities = new WeakSet()

function applyMotion (bot, packet, entity = bot.entity) {
  if (!entity) return
  const v = packet.velocity
  if (v) entity.velocity.set(v.x, v.y, v.z)
}

module.exports = {
  ATTRIBUTE_NAMES,
  attributeKeys,
  baseValue,
  applyAttributes,
  applyHealth,
  applyEffect,
  applyMetadata,
  applyMotion
}
