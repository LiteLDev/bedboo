// owner: U9 (player state, world extras & dimensions)
// Vendored from mineflayer 4.39.0 lib/plugins/explosion.js (MIT, Copyright (c) 2013 Andrew Kelley,
//   https://github.com/PrismarineJS/mineflayer) — never `pnpm patch mineflayer`. Same exposure sampling, damage
//   formula and armor absorption; one Bedrock change: the armor attribute lookup (docs/differences/U9.md#explosion).
// Surface: bot.getExplosionDamages(targetEntity, sourcePos, power, rawDamages = false) → number | null
// Bedrock: there is no armor attribute on the wire. U7 synthesizes `generic.armor` / `generic.armorToughness` (Java
//   names) on entities from their equipment; Java resource names (`minecraft:armor`, `minecraft:generic.armor`, …) are
//   accepted too. A living entity (player or mob: it has `minecraft:max_health` or a health) without any armor
//   attribute counts as unarmored (0 armor, 0 toughness) instead of upstream's `null`, which upstream returns for
//   non-living targets — and here too.
'use strict'
const { Vec3 } = require('vec3')

module.exports = inject

// https://minecraft.wiki/w/Explosion
function calcExposure (playerPos, explosionPos, world) {
  const dx = 1 / (0.6 * 2 + 1)
  const dy = 1 / (1.8 * 2 + 1)
  const dz = 1 / (0.6 * 2 + 1)

  const d3 = (1 - Math.floor(1 / dx) * dx) / 2
  const d4 = (1 - Math.floor(1 / dz) * dz) / 2

  let sampled = 0
  let exposed = 0
  const pos = new Vec3(0, 0, 0)
  for (pos.y = playerPos.y; pos.y <= playerPos.y + 1.8; pos.y += 1.8 * dy) {
    for (pos.x = playerPos.x - 0.3 + d3; pos.x <= playerPos.x + 0.3; pos.x += 0.6 * dx) {
      for (pos.z = playerPos.z - 0.3 + d4; pos.z <= playerPos.z + 0.3; pos.z += 0.6 * dz) {
        const dir = pos.minus(explosionPos)
        const range = dir.norm()
        if (world.raycast(explosionPos, dir.normalize(), range) === null) {
          exposed++
        }
        sampled++
      }
    }
  }
  return exposed / sampled
}

// https://minecraft.wiki/w/Armor#Damage_protection
function getDamageAfterAbsorb (damages, armorValue, toughness) {
  const var3 = 2 + toughness / 4
  const var4 = Math.min(Math.max(armorValue - damages / var3, armorValue * 0.2), 20)
  return damages * (1 - var4 / 25)
}

// https://minecraft.wiki/w/Attribute#Operations
function getAttributeValue (prop) {
  let X = prop.value
  for (const mod of prop.modifiers) {
    if (mod.operation !== 0) continue
    X += mod.amount
  }
  let Y = X
  for (const mod of prop.modifiers) {
    if (mod.operation !== 1) continue
    Y += X * mod.amount
  }
  for (const mod of prop.modifiers) {
    if (mod.operation !== 2) continue
    Y += Y * mod.amount
  }
  return Y
}

const ARMOR_KEYS = ['generic.armor', 'minecraft:generic.armor', 'minecraft:armor']
const TOUGHNESS_KEYS = ['generic.armorToughness', 'minecraft:generic.armor_toughness', 'minecraft:armor_toughness']
const NO_ARMOR = { value: 0, modifiers: [] }

function findAttribute (attributes, keys) {
  for (const key of keys) {
    if (attributes?.[key]) return attributes[key]
  }
  return undefined
}

function isLiving (entity) {
  return entity.type === 'player' || entity.type === 'mob' || entity.type === 'hostile' || entity.type === 'animal' ||
    entity.health !== undefined || !!entity.attributes?.['minecraft:max_health']
}

function inject (bot) {
  const damageMultiplier = 7 // for 1.12+ 8 for 1.8 TODO check when the change occur (likely 1.9)

  const difficultyValues = {
    peaceful: 0,
    easy: 1,
    normal: 2,
    hard: 3
  }

  bot.getExplosionDamages = (targetEntity, sourcePos, power, rawDamages = false) => {
    const distance = targetEntity.position.distanceTo(sourcePos)
    const radius = 2 * power
    if (distance >= radius) return 0
    const exposure = calcExposure(targetEntity.position, sourcePos, bot.world)
    const impact = (1 - distance / radius) * exposure
    let damages = Math.floor((impact * impact + impact) * damageMultiplier * power + 1)

    // The following modifiers are constant for the input targetEntity and doesnt depend
    // on the source position, so if the goal is to compare between positions they can be
    // ignored to save computations
    let armorAttribute = findAttribute(targetEntity.attributes, ARMOR_KEYS)
    if (!armorAttribute && isLiving(targetEntity)) armorAttribute = NO_ARMOR
    if (!rawDamages && armorAttribute) {
      const armor = getAttributeValue(armorAttribute)
      const armorToughness = getAttributeValue(findAttribute(targetEntity.attributes, TOUGHNESS_KEYS) ?? NO_ARMOR)
      damages = getDamageAfterAbsorb(damages, armor, armorToughness)

      // TODO: protection enchantment and resistance effects

      if (targetEntity.type === 'player') damages *= difficultyValues[bot.game.difficulty] * 0.5
    } else if (!rawDamages && !armorAttribute) {
      return null
    }
    return Math.floor(damages)
  }
}
