// owner: U4 (wave 2, local player only) → U7 (wave 3, all other entities & players)
// Upstream: mineflayer 4.39.0 lib/plugins/entities.js
// Surface: bot.entity (local player Entity, created on start_game by U4), bot.username,
//   bot.entities {id: Entity}, bot.players {username: Player}, bot.player, bot.uuidToUsername,
//   bot.vehicle, bot.fireworkRocketDuration, bot.findPlayer(s)(filter), bot.nearestEntity(match),
//   bot._playerFromUUID(uuid), bot.swingArm(hand, showHand), bot.attack(entity, swing = true),
//   bot.mount(entity), bot.dismount(), bot.useOn(entity), bot.moveVehicle(left, forward)
// Events: entitySpawn/Gone/Moved/Update/Hurt/Dead/SwingArm/Equip/Sleep/Wake/Eat/Crouch/Uncrouch/
//   Attributes/Effect/EffectEnd/Attach/Detach/ElytraFlew/Taming/Tamed/ShakingOffWater/EatingGrass/
//   HandSwap/CriticalEffect/MagicCriticalEffect, playerJoined/Updated/Left, itemDrop, playerCollect,
//   mount, dismount, usedFirework
// Bedrock: add_player/add_entity/add_item_entity/add_painting, remove_entity (unique id),
//   move_entity(_delta), set_entity_data, update_attributes, mob_effect, mob_equipment,
//   mob_armor_equipment, animate, entity_event, player_list, set_entity_link, take_item_entity.
//   Self data (update_attributes/set_health/mob_effect/set_entity_data/motion) is U4's
//   lib/bedrock/entity_data.js; this plugin skips the local runtime id.
'use strict'
const { stubSync } = require('../bedrock/errors')

module.exports = inject

function inject (bot) {
  bot.players = {}
  bot.uuidToUsername = {}
  bot.entities = {}
  bot.vehicle = null
  bot.fireworkRocketDuration = 0

  bot.findPlayers = stubSync('U7', 'bot.findPlayers', 1)
  bot.findPlayer = bot.findPlayers
  bot._playerFromUUID = stubSync('U7', 'bot._playerFromUUID', 1)
  bot.nearestEntity = stubSync('U7', 'bot.nearestEntity', 0)
  bot.swingArm = stubSync('U7', 'bot.swingArm', 0)
  bot.attack = stubSync('U7', 'bot.attack', 1)
  bot.mount = stubSync('U7', 'bot.mount', 1)
  bot.dismount = stubSync('U7', 'bot.dismount', 0)
  bot.useOn = stubSync('U7', 'bot.useOn', 1)
  bot.moveVehicle = stubSync('U7', 'bot.moveVehicle', 2)
}
