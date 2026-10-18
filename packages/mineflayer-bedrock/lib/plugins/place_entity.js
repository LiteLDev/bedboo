// owner: U11 (placing & placement-based parity)
// Adapted from mineflayer 4.39.0 lib/plugins/place_entity.js (MIT, Copyright (c) 2013 Andrew Kelley,
// https://github.com/PrismarineJS/mineflayer): held-item checks, the 'Unimplemented' assertion, the spawn-egg /
// end-crystal / armor-stand / boat entity names (through the same features), the swing defaults, the 5 s
// 'Failed to place entity' timeout and the distance check are kept.
// Surface: bot.placeEntity(referenceBlock, faceVector) → Promise<Entity>,
//   bot._placeEntityWithOptions(referenceBlock, faceVector, options) options {forceLook, offhand, swingArm, showHand}
// Events: 'entityPlaced' (entity)
// Bedrock (measured on BDS 1.26.51.1, docs/differences/U11.md#place-entity):
// - armor stands, spawn eggs, end crystals and minecarts are a click on the reference block (bot._genericPlace) and
//   the server spawns the entity (add_entity → U7's entitySpawn);
// - Java places a boat with use_item (a server-side raycast along the look); BDS ignores a boat's click_air and the
//   vanilla client clicks the water it aims at: a boat whose reference block is a liquid is a click on that liquid's
//   top face (the boat spawns centred on it, whatever face was given; the look of the bot does not matter), on any
//   other block a click on the given face like the other entities (Bedrock places boats on land). Chest boats spawn
//   a `chest_boat`, rafts a `boat`;
// - minecarts (on rails) are accepted too (upstream asserts 'Unimplemented'), Bedrock spawn-egg mob names
//   (villager → villager_v2, evoker → evocation_illager, …) are matched;
// - upstream stops listening after the first entitySpawn even when it is another entity (then always times out);
//   here the listener stays until the placed entity spawned or the timeout.
'use strict'
const assert = require('assert')
const { Vec3 } = require('vec3')
const { isLiquid, isBoatItem } = require('../bedrock/placement')

module.exports = inject

/** Bedrock entity names of the mob a `<name>_spawn_egg` spawns, when they differ from `<name>` */
const SPAWN_EGG_ENTITIES = {
  villager: ['villager_v2', 'villager'],
  zombie_villager: ['zombie_villager_v2', 'zombie_villager'],
  evoker: ['evocation_illager'],
  tropical_fish: ['tropicalfish']
}

const isMinecartItem = (name) => /(^|_)minecart$/.test(name)

function inject (bot) {
  /**
   *
   * @param {import('prismarine-block').Block} referenceBlock
   * @param {import('vec3').Vec3} faceVector
   * @param {{forceLook?: boolean | 'ignore', offhand?: boolean, swingArm?: 'right' | 'left', showHand?: boolean}} options
   */
  async function placeEntityWithOptions (referenceBlock, faceVector, options) {
    if (!bot.heldItem) throw new Error('must be holding an item to place an entity')

    const heldName = bot.heldItem.name
    let type = heldName // used for assert
      .replace(/.+_spawn_egg/, 'spawn_egg')
    if (isBoatItem(heldName)) type = 'boat'
    if (isMinecartItem(heldName)) type = 'minecart' // Bedrock extra
    assert(['end_crystal', 'boat', 'spawn_egg', 'armor_stand', 'minecart'].includes(type), 'Unimplemented')

    let name = heldName // used for finding entity after spawn
    if (type === 'boat') {
      name = /chest_(boat|raft)$/.test(heldName) ? 'chest_boat' : 'boat'
    }

    if (name.endsWith('spawn_egg')) {
      name = bot.heldItem.spawnEggMobName
    }

    if (type === 'spawn_egg') {
      options.showHand = false
    }

    if (!options.swingArm) options.swingArm = options.offhand ? 'left' : 'right'

    // Bedrock: a boat on a liquid is a click on the liquid's surface (see the header)
    const surface = type === 'boat' && isLiquid(referenceBlock)
    const pos = await bot._genericPlace(referenceBlock, surface ? new Vec3(0, 1, 0) : faceVector, options)

    const dest = pos.plus(faceVector)
    const entity = await waitForEntitySpawn(name, dest)
    bot.emit('entityPlaced', entity)
    return entity
  }

  async function placeEntity (referenceBlock, faceVector) {
    return await placeEntityWithOptions(referenceBlock, faceVector, {})
  }

  /** entity names the placed entity may have */
  function entityNames (name) {
    if (name === 'end_crystal') {
      if (bot.supportFeature('enderCrystalNameEndsInErNoCaps')) {
        return ['ender_crystal']
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        return ['endercrystal']
      } else if (bot.supportFeature('enderCrystalNameNoCapsWithUnderscore')) {
        return ['end_crystal']
      } else {
        return ['EnderCrystal']
      }
    } else if (name === 'boat') {
      return [bot.supportFeature('entityNameUpperCaseNoUnderscore') ? 'Boat' : 'boat']
    } else if (name === 'armor_stand') {
      if (bot.supportFeature('entityNameUpperCaseNoUnderscore')) {
        return ['ArmorStand']
      } else if (bot.supportFeature('entityNameLowerCaseNoUnderscore')) {
        return ['armorstand']
      } else {
        return ['armor_stand']
      }
    }
    return SPAWN_EGG_ENTITIES[name] ?? [name]
  }

  function waitForEntitySpawn (name, placePosition) {
    const maxDistance = name === 'bat' ? 4 : /boat$/.test(name) ? 3 : 2
    const mobNames = entityNames(name)

    return new Promise((resolve, reject) => {
      function listener (entity) {
        const dist = entity.position.distanceTo(placePosition)
        if (mobNames.includes(entity.name) && dist < maxDistance) {
          clearTimeout(timer)
          bot.off('entitySpawn', listener)
          resolve(entity)
        }
      }

      const timer = setTimeout(() => {
        bot.off('entitySpawn', listener)
        reject(new Error('Failed to place entity'))
      }, 5000) // reject after 5s

      bot.on('entitySpawn', listener)
    })
  }

  bot.placeEntity = placeEntity
  bot._placeEntityWithOptions = placeEntityWithOptions
}

module.exports.SPAWN_EGG_ENTITIES = SPAWN_EGG_ENTITIES
